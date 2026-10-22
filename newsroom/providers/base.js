// Provider adapter base. Owns everything provider-neutral about making ONE HTTP call:
// approval guard, credential lookup, timeout, safe JSON parsing, generic HTTP->category
// classification, rate-limit header parsing, secret redaction. Concrete adapters
// (gemini/groq/openrouter) supply only the provider-specific pieces.
//
// Adapter contract (used by router.js):
//   id, envVar
//   isConfigured()            -> boolean (credential present; value never exposed)
//   secretValues()            -> string[] (for redaction only)
//   buildRequest(req, model)  -> { url, method, headers, body }   (NO secrets in it)
//   authHeaders(key)          -> headers with the credential (added at send time only)
//   parseSuccess(json, status)-> { content, finishReason, usage, servedModel } | { failure: {category,message} }
//   refineError(status, json, headers, now) -> partial override of the generic classification
//   async call(req, model)    -> { ok:true, ... } | { ok:false, error:{category,message,retryable,...}, rateLimit }
"use strict";
const { ERROR_CATEGORIES: C, CATEGORY_TRAITS } = require("../ai/constants");
const { redactString } = require("../ai/redact");
const { scanRequest } = require("../ai/credential-guard");
const { parseRateLimitHeaders, parseDurationMs } = require("../ai/http-utils");

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_MESSAGE_CHARS = 300;

function genericCategory(status) {
  if (status === 429) return C.RATE_LIMIT_TEMPORARY;
  if (status === 401 || status === 403) return C.AUTHENTICATION;
  if (status === 402) return C.PAYMENT_REQUIRED;
  if (status === 404) return C.MODEL_NOT_FOUND;
  if (status === 400 || status === 413 || status === 422) return C.INVALID_REQUEST;
  if (status === 408 || status === 409 || status === 425 || status >= 500) return C.PROVIDER_UNAVAILABLE;
  return C.UNKNOWN;
}

class ProviderAdapter {
  constructor({ id, envVar, guard, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now }) {
    if (!id || !envVar) throw new Error("adapter needs id and envVar");
    this.id = id;
    this.envVar = envVar;
    this._guard = guard;          // (provider, model) => throws if not an approved free model
    this._env = env;
    this._fetch = fetchImpl;
    this._timeoutMs = timeoutMs;
    this._now = now;
  }

  _key() { const v = this._env[this.envVar]; return typeof v === "string" && v.trim() ? v.trim() : null; }
  isConfigured() { return this._key() !== null; }
  secretValues() { const k = this._key(); return k ? [k] : []; }

  // ---- to be provided by concrete adapters ----
  buildRequest() { throw new Error("not implemented"); }
  authHeaders() { throw new Error("not implemented"); }
  parseSuccess() { throw new Error("not implemented"); }
  refineError() { return {}; }

  _fail(category, message, extra = {}) {
    return {
      ok: false,
      error: {
        category, message: redactString(String(message).slice(0, MAX_MESSAGE_CHARS), this.secretValues()),
        retryable: CATEGORY_TRAITS[category].retryable,
        httpStatus: extra.httpStatus == null ? null : extra.httpStatus,
        providerCode: extra.providerCode == null ? null : String(extra.providerCode).slice(0, 80),
        retryAfterMs: extra.retryAfterMs == null ? null : extra.retryAfterMs,
        resetAt: extra.resetAt == null ? null : extra.resetAt
      },
      rateLimit: extra.rateLimit || null,
      latencyMs: extra.latencyMs == null ? 0 : extra.latencyMs
    };
  }

  classifyHttpFailure(status, json, headers) {
    const now = this._now();
    const rl = parseRateLimitHeaders(headers, now);
    const base = {
      category: genericCategory(status),
      message: (json && json.error && (json.error.message || json.error.status)) || `HTTP ${status}`,
      retryAfterMs: rl ? rl.retryAfterMs : null,
      resetAt: rl ? (rl.resetRequestsAt || rl.resetTokensAt || rl.resetAt) : null,
      providerCode: json && json.error ? (json.error.code || json.error.status || json.error.type) : null
    };
    const refined = { ...base, ...(this.refineError(status, json, headers, now) || {}) };
    return { ...refined, httpStatus: status, rateLimit: rl };
  }

  async call(req, model) {
    this._guard(this.id, model);                // paid-model protection at the last possible moment
    const key = this._key();
    if (!key) return this._fail(C.CONFIGURATION, `missing credential env var ${this.envVar}`);

    // Last-line defence if an adapter is used without the router: never send credentials inside a prompt.
    const leaked = scanRequest(req, [key]);
    if (leaked.length) return this._fail(C.INVALID_REQUEST, `request refused: it appears to contain credentials (${leaked.join(", ")})`);

    const built = this.buildRequest(req, model);
    const started = this._now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    let res, text;
    try {
      res = await this._fetch(built.url, {
        method: built.method || "POST",
        headers: { "Content-Type": "application/json", ...built.headers, ...this.authHeaders(key) },
        body: JSON.stringify(built.body),
        signal: controller.signal
      });
      text = await res.text();
    } catch (e) {
      const aborted = e && e.name === "AbortError";
      return this._fail(C.PROVIDER_UNAVAILABLE, aborted ? "request timed out" : `network error: ${e && e.message}`, { latencyMs: this._now() - started });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = this._now() - started;

    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }

    if (res.status < 200 || res.status >= 300) {
      const f = this.classifyHttpFailure(res.status, json, res.headers);
      return this._fail(f.category, f.message, { ...f, latencyMs });
    }
    if (json === null) return this._fail(C.MALFORMED_RESPONSE, "response body was not valid JSON", { httpStatus: res.status, latencyMs });

    let parsed;
    try { parsed = this.parseSuccess(json, res.status); }
    catch (e) { return this._fail(C.MALFORMED_RESPONSE, `could not parse response: ${e.message}`, { httpStatus: res.status, latencyMs }); }
    const rateLimit = parseRateLimitHeaders(res.headers, this._now());
    if (parsed.failure) {
      const f = parsed.failure;
      // Errors delivered inside a 200 body may carry their own status-like code.
      const c = f.status != null ? this.classifyHttpFailure(f.status, { error: f.raw || { message: f.message } }, null) : null;
      return this._fail((c && c.category) || f.category, (c && c.message) || f.message, {
        httpStatus: res.status, latencyMs, rateLimit, retryAfterMs: c ? c.retryAfterMs : null, resetAt: c ? c.resetAt : null, providerCode: c ? c.providerCode : null
      });
    }
    return {
      ok: true,
      content: parsed.content,
      finishReason: parsed.finishReason || null,
      usage: parsed.usage || null,
      servedModel: parsed.servedModel || null,
      httpStatus: res.status,
      rateLimit,
      latencyMs
    };
  }
}

module.exports = { ProviderAdapter, genericCategory, parseDurationMs };
