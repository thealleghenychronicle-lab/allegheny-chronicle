// Cloudflare Workers AI adapter (REST API, server-side only). Third and last provider in the free fallback chain.
//
//   POST https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/zai-org/glm-4.7-flash
//   Authorization: Bearer {CLOUDFLARE_API_TOKEN}      body: { messages: [...], max_tokens, ... }
//
// Credentials (env only, never in code/prompts/logs):
//   CLOUDFLARE_API_TOKEN               secret; a token scoped to Workers AI only
//   CLOUDFLARE_ACCOUNT_ID              identifier (32 hex chars), redacted anyway
//   CLOUDFLARE_FREE_PLAN_CONFIRMED     must be exactly "true": the owner's statement that the account is on the Workers FREE plan.
//                                      Without it the adapter is "not configured" and is never selected.
//
// Free-only safety lives in three places, all outside this file's control flow: the allowlist/registry (only the
// verified model id), the local Neuron budget in ai/quota.js (a conservative ESTIMATE, not Cloudflare's own usage),
// and the Free plan itself (documented: no paid usage option -> requests fail instead of billing). Any
// quota-looking failure here blocks the model until 00:00 UTC, the documented daily reset.
"use strict";
const { ProviderAdapter } = require("./base");
const { ERROR_CATEGORIES: C } = require("../ai/constants");

const ENV_VAR = "CLOUDFLARE_API_TOKEN";
const ACCOUNT_ENV_VAR = "CLOUDFLARE_ACCOUNT_ID";
const FREE_PLAN_ENV_VAR = "CLOUDFLARE_FREE_PLAN_CONFIRMED";
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

// Cloudflare wraps errors as { success:false, errors:[{code,message}], messages:[] } but the OpenAI-compatible
// surface uses { error:{...} }; accept both.
function cfErrors(json) {
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json.errors) && json.errors.length) return json.errors.filter((e) => e && typeof e === "object");
  if (json.error && Array.isArray(json.error.errors)) return json.error.errors.filter((e) => e && typeof e === "object");
  if (json.error && typeof json.error === "object") return [json.error];
  return [];
}
const errText = (errs) => errs.map((e) => `${e.message || ""} ${e.code || ""}`).join(" ");
const nextUtcMidnight = (now) => Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
const looksLikeAllocationExhausted = (t) => /daily free allocation|neurons?\b|\b4006\b/i.test(t);

class CloudflareAdapter extends ProviderAdapter {
  constructor(opts) { super({ ...opts, id: "cloudflare", envVar: ENV_VAR }); }

  _accountId() { const v = this._env[ACCOUNT_ENV_VAR]; return typeof v === "string" && ACCOUNT_ID_RE.test(v.trim()) ? v.trim() : null; }
  _freePlanConfirmed() { return String(this._env[FREE_PLAN_ENV_VAR] || "").trim() === "true"; }
  isConfigured() { return super.isConfigured() && this._accountId() !== null && this._freePlanConfirmed(); }
  secretValues() { const a = this._accountId(); return super.secretValues().concat(a ? [a] : []); }

  authHeaders(key) { return { Authorization: `Bearer ${key}` }; }

  buildRequest(req, model) {
    const account = this._accountId();
    const messages = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    const body = { messages, max_tokens: req.output.maxTokens, stream: false };
    if (req.generation.temperature != null) body.temperature = req.generation.temperature;
    if (req.generation.topP != null) body.top_p = req.generation.topP;
    if (req.generation.stopSequences) body.stop = req.generation.stopSequences;
    if (req.generation.seed != null) body.seed = req.generation.seed;
    // `model` is already validated by the registry guard (strict @cf/vendor/name pattern); never user-supplied.
    return { url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, method: "POST", headers: {}, body };
  }

  async call(req, model) {
    // Fail closed, with a clear message, before anything is sent. (Guard first: unapproved models never get this far.)
    this._guard(this.id, model);
    if (!this._freePlanConfirmed()) return this._fail(C.CONFIGURATION, `${FREE_PLAN_ENV_VAR} must be "true" (owner confirmation that the account is on the Workers Free plan)`);
    if (!super.isConfigured()) return this._fail(C.CONFIGURATION, `missing credential env var ${ENV_VAR}`);
    if (!this._accountId()) return this._fail(C.CONFIGURATION, `missing or malformed env var ${ACCOUNT_ENV_VAR} (expected 32 hex characters)`);
    return super.call(req, model);
  }

  parseSuccess(json) {
    const errs = cfErrors(json);
    if (json.success === false || (errs.length && !json.choices && !json.result)) {
      const t = errText(errs);
      const status = looksLikeAllocationExhausted(t) ? 429 : /authentication|unauthor/i.test(t) ? 401 : null;
      return { failure: { category: C.UNKNOWN, message: t.trim() || "error in response body", status, raw: { errors: errs } } };
    }
    // The /ai/run envelope puts the model output under `result`; the OpenAI-compatible endpoint returns it at top level.
    const out = json.result && typeof json.result === "object" ? json.result : json;
    const choice = Array.isArray(out.choices) ? out.choices[0] : null;
    if (choice && choice.finish_reason === "content_filter") return { failure: { category: C.CONTENT_BLOCKED, message: "output blocked by content filter" } };
    let text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
    if (!text && typeof out.response === "string") text = out.response;      // legacy Workers AI text shape
    if (!text.trim()) return { failure: { category: C.MALFORMED_RESPONSE, message: "no content in response" } };
    const u = out.usage && typeof out.usage === "object" ? out.usage : null;
    return {
      content: text,
      finishReason: choice ? choice.finish_reason || null : null,
      usage: u ? { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null, totalTokens: u.total_tokens ?? null } : null,
      servedModel: typeof out.model === "string" ? out.model : null
    };
  }

  refineError(status, json, headers, now) {
    const errs = cfErrors(json);
    const t = errText(errs);
    const out = {};
    if (errs.length) {
      out.message = errs.map((e) => e.message).filter(Boolean).join("; ") || undefined;
      out.providerCode = errs[0].code != null ? errs[0].code : undefined;
      if (out.message === undefined) delete out.message;
      if (out.providerCode === undefined) delete out.providerCode;
    }
    const n = now == null ? Date.now() : now;
    if (/\b5035\b/.test(t) || (status === 403 && /workers paid|upgrade/i.test(t) && !looksLikeAllocationExhausted(t))) {
      out.category = C.PAYMENT_REQUIRED;        // this model needs a paid plan: disable it, never retry
    } else if (looksLikeAllocationExhausted(t)) {
      // Free allocation used up. Wait for the documented daily reset (00:00 UTC) unless a sooner hint was given.
      out.category = C.QUOTA_DAILY; out.resetAt = nextUtcMidnight(n);
    } else if (status === 429) {
      out.category = C.RATE_LIMIT_TEMPORARY;
    } else if (status === 401 || status === 403 || /authentication error|\b10000\b/i.test(t)) {
      out.category = C.AUTHENTICATION;
    } else if (status === 404 || /no such model|model not found|\b5007\b/i.test(t)) {
      out.category = C.MODEL_NOT_FOUND;
    }
    return out;
  }
}

module.exports = { CloudflareAdapter, ENV_VAR, ACCOUNT_ENV_VAR, FREE_PLAN_ENV_VAR };
