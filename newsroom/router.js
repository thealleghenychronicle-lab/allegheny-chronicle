// Central AI Router. Newsroom components call router.route(request); they never touch a
// provider. Selection is 100% deterministic code — no AI model is ever consulted to pick
// another model (Section 13/19). Provider specifics live in newsroom/providers/*.
//
//   request -> validate -> plan (approved? capable? credentialed? capacity?)
//           -> for each eligible candidate in fixed order: reserve quota -> adapter.call
//           -> success: normalized response | failure: record state, try next approved option
//           -> nothing usable: WAITING (with retryAt) or FAILED (permanent) — never a paid model
//
// The article limiter is NOT used here. Routing never consumes a draft slot.
"use strict";
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { STATUS, ERROR_CATEGORIES: C } = require("./ai/constants");
const { createRequest, RouterRequestError } = require("./ai/request");
const { createModelRegistry, ModelNotApprovedError, parseModelKey } = require("./ai/registry");
const quota = require("./ai/quota");
const { RouterState } = require("./ai/router-state");
const { createLogger } = require("./ai/logger");
const { redactString } = require("./ai/redact");
const { scanRequest, scrubExact } = require("./ai/credential-guard");
const { LocalStateStore } = require("./local-state-store");
const { createProviderAdapters } = require("./providers");

function loadEmployeeIds() {
  const dir = path.join(__dirname, "employees");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).id).filter(Boolean);
  } catch (_) { return null; }   // if profiles can't be read, don't block routing on it
}

const iso = (t) => (t == null ? null : new Date(t).toISOString());

class Router {
  constructor({ registry, adapters, stateStore, env, now, logger, backoff, knownEmployees }) {
    this.registry = registry;
    this.adapters = adapters;
    this.env = env;
    this.now = now;
    this.backoff = backoff;
    this.knownEmployees = knownEmployees;
    this.logger = logger;
    this.state = new RouterState(stateStore, { logger });
  }

  _secrets() {
    const t = this.env && this.env.NEWSROOM_API_TOKEN;
    return Object.values(this.adapters).flatMap((a) => a.secretValues()).concat(typeof t === "string" && t.trim() ? [t.trim()] : []);
  }
  _safe(s) { return redactString(String(s), this._secrets()); }

  // ---------- planning (no provider calls, no state writes) ----------
  plan(rawRequest) {
    const request = rawRequest && rawRequest.taskType !== undefined && Object.isFrozen(rawRequest) ? rawRequest : createRequest(rawRequest, { knownEmployees: this.knownEmployees });
    this.state.refresh();
    return this._plan(request, this.now());
  }

  _plan(request, now) {
    const rejected = [];
    const pref = request.modelPreference;

    // Registry issues (placeholders, non-free variants) are permanent, visible rejections.
    for (const i of this.registry.issues) rejected.push({ key: i.key, code: i.code, permanent: true, retryAt: null, message: "excluded by registry rules" });

    // Preferences that name something outside the allowlist are refused, never honoured.
    for (const p of pref.prefer) {
      const parsed = parseModelKey(p);
      if (parsed && !this.registry.isApproved(p) && !this.registry.issues.some((i) => i.key === p)) {
        rejected.push({ key: p, code: C.NOT_APPROVED_FREE, permanent: true, retryAt: null, message: "requested model is not on the free-tier allowlist" });
      }
    }

    const matches = (entry, spec) => spec === entry.key || spec === entry.provider;
    const rankOf = (entry) => {
      const i = pref.prefer.findIndex((p) => matches(entry, p));
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };

    const eligible = [];
    let passedStatic = 0;
    for (const entry of this.registry.list()) {
      const rej = (code, message, extra = {}) => rejected.push({ key: entry.key, code, message, permanent: true, retryAt: null, ...extra });
      if (pref.exclude.some((x) => matches(entry, x))) { rej("EXCLUDED_BY_REQUEST", "excluded by request"); continue; }
      if (pref.strict && pref.prefer.length && rankOf(entry) === Number.MAX_SAFE_INTEGER) { rej("NOT_PREFERRED_STRICT", "strict preference excludes this model"); continue; }
      if (!entry.capabilities.includes(request.capability)) { rej("CAPABILITY_MISMATCH", `model lacks capability "${request.capability}"`); continue; }
      if (entry.maxOutputTokens != null && request.output.maxTokens > entry.maxOutputTokens) { rej("OUTPUT_TOKENS_EXCEED_MODEL_LIMIT", "requested output exceeds model limit"); continue; }
      const adapter = this.adapters[entry.provider];
      if (!adapter) { rej("PROVIDER_NOT_REGISTERED", "no adapter registered"); continue; }
      passedStatic += 1;
      if (!adapter.isConfigured()) { rej("MISSING_CREDENTIALS", `credential env var ${adapter.envVar} is not set`); continue; }
      const ps = this.state.read(entry.provider);
      const chk = quota.checkCapacity(ps, entry, { now, estimatedTokens: request.estimatedInputTokens + request.output.maxTokens, estimate: { inputTokens: request.estimatedInputTokens, outputTokens: request.output.maxTokens } });
      if (!chk.ok) { rejected.push({ key: entry.key, code: chk.code, message: chk.detail || chk.code, permanent: chk.permanent, retryAt: chk.retryAt }); continue; }
      eligible.push(entry);
    }
    // Deterministic order: preference rank, registry priority, key. No randomness anywhere.
    eligible.sort((a, b) => rankOf(a) - rankOf(b) || a.priority - b.priority || (a.key < b.key ? -1 : 1));
    return { eligible, rejected, passedStatic };
  }

  // ---------- main entry ----------
  async route(rawRequest) {
    const startedAt = this.now();
    let request;
    try {
      request = createRequest(rawRequest, { knownEmployees: this.knownEmployees });
    } catch (e) {
      if (!(e instanceof RouterRequestError)) throw e;
      this.logger.warn("route_invalid_request", { message: e.message });
      return this._response({ request: null, startedAt, status: STATUS.FAILED,
        error: { category: C.INVALID_ROUTER_REQUEST, message: e.message, retryable: false }, routing: { attempts: [], rejected: [] } });
    }
    // Credential guard: ordinary news content passes; real secrets never leave this process in a prompt.
    const leaked = scanRequest(request, this._secrets());
    if (leaked.length) {
      this.logger.warn("route_blocked_credentials", { requestId: request.requestId, kinds: leaked });
      return this._response({ request, startedAt, status: STATUS.FAILED,
        error: { category: C.INVALID_ROUTER_REQUEST, message: `request refused: it appears to contain credentials (${leaked.join(", ")}). Remove them; credentials are only ever sent in server-side auth headers.`, retryable: false },
        routing: { attempts: [], rejected: [] } });
    }
    this.logger.info("route_start", { requestId: request.requestId, taskType: request.taskType, employee: request.employeeId,
      capability: request.capability, attempt: request.retryContext.attempt, estInputTokens: request.estimatedInputTokens, maxOutputTokens: request.output.maxTokens });

    if (request.retryContext.notBefore != null && request.retryContext.notBefore > this.now()) {
      const retryAt = request.retryContext.notBefore;
      this.logger.info("route_deferred", { requestId: request.requestId, retryAt: iso(retryAt) });
      return this._response({ request, startedAt, status: STATUS.WAITING,
        error: { category: C.ALL_OPTIONS_TEMPORARILY_UNAVAILABLE, message: "retryContext.notBefore has not been reached", retryable: true },
        retry: { retryable: true, retryAt, reason: "NOT_BEFORE" }, routing: { attempts: [], rejected: [] } });
    }

    this.state.refresh();
    const plan = this._plan(request, this.now());
    const attempts = [];
    const rejected = plan.rejected.slice();
    const touched = new Map();   // key -> entry (for quota snapshots)
    for (const e of plan.eligible) touched.set(e.key, e);

    for (const entry of plan.eligible) {
      const adapter = this.adapters[entry.provider];
      const estTokens = request.estimatedInputTokens + request.output.maxTokens;

      // Free-tier gate again, immediately before any call (defence in depth).
      try { this.registry.assertApproved(entry.provider, entry.model); }
      catch (e) { rejected.push({ key: entry.key, code: C.NOT_APPROVED_FREE, message: e.message, permanent: true, retryAt: null }); continue; }

      // Reserve quota atomically (re-checks capacity against the freshest state).
      let token = null;
      const reserved = this.state.mutate(entry.provider, (ps) => {
        const chk = quota.checkCapacity(ps, entry, { now: this.now(), estimatedTokens: estTokens, estimate: { inputTokens: request.estimatedInputTokens, outputTokens: request.output.maxTokens } });
        if (!chk.ok) return { commit: false, result: { chk } };
        return { commit: true, result: { token: quota.beginAttempt(ps, entry, this.now(), estTokens, { inputTokens: request.estimatedInputTokens, outputTokens: request.output.maxTokens }) } };
      }, `reserve ${entry.key}`);
      if (reserved.result.chk) {
        const c = reserved.result.chk;
        rejected.push({ key: entry.key, code: c.code, message: c.detail || c.code, permanent: c.permanent, retryAt: c.retryAt });
        continue;
      }
      token = reserved.result.token;

      this.logger.info("provider_attempt", { requestId: request.requestId, key: entry.key });
      let result;
      try {
        result = await adapter.call(request, entry.model);
      } catch (e) {
        if (e instanceof ModelNotApprovedError) result = adapter._fail(C.CONFIGURATION, e.message);
        else result = adapter._fail(C.UNKNOWN, `adapter threw: ${e && e.message}`);
      }

      if (result.ok) {
        this.state.mutate(entry.provider, (ps) => { quota.completeSuccess(ps, entry, this.now(), { token, usage: result.usage, rateLimit: result.rateLimit }); return { commit: true, result: null }; }, `success ${entry.key}`);
        attempts.push({ key: entry.key, outcome: "SUCCESS", category: null, httpStatus: result.httpStatus, retryable: false, latencyMs: result.latencyMs });
        this.logger.info("provider_success", { requestId: request.requestId, key: entry.key, latencyMs: result.latencyMs, usage: result.usage });
        return this._response({ request, startedAt, status: STATUS.SUCCESS, entry, result, routing: { attempts, rejected }, touched });
      }

      const err = { ...result.error, rateLimit: result.rateLimit };
      const applied = this.state.mutate(entry.provider, (ps) => ({ commit: true, result: quota.recordFailure(ps, entry, this.now(), err, { backoff: this.backoff }) }), `failure ${entry.key} ${err.category}`);
      const eff = applied.result;
      attempts.push({ key: entry.key, outcome: "FAILED", category: err.category, httpStatus: err.httpStatus, retryable: err.retryable, retryAt: eff.until, latencyMs: result.latencyMs });
      this.logger.warn("provider_failure", { requestId: request.requestId, key: entry.key, category: err.category, httpStatus: err.httpStatus, retryable: err.retryable, retryAt: iso(eff.until), message: err.message });

      if (eff.scope === "request") {
        // The request itself is the problem (invalid / blocked content). Do not shop it around.
        return this._response({ request, startedAt, status: STATUS.FAILED, entry, error: { ...err, provider: entry.provider, model: entry.model },
          routing: { attempts, rejected }, touched });
      }
    }

    return this._finish({ request, startedAt, attempts, rejected, plan, touched });
  }

  _finish({ request, startedAt, attempts, rejected, plan, touched }) {
    const temp = [];
    for (const r of rejected) if (!r.permanent && r.retryAt != null) temp.push(r.retryAt);
    for (const a of attempts) if (a.outcome === "FAILED" && a.retryable && a.retryAt != null) temp.push(a.retryAt);
    if (temp.length) {
      const retryAt = Math.min(...temp);
      this.logger.info("route_waiting", { requestId: request.requestId, retryAt: iso(retryAt) });
      return this._response({ request, startedAt, status: STATUS.WAITING,
        error: { category: C.ALL_OPTIONS_TEMPORARILY_UNAVAILABLE, message: "every approved free option is temporarily unavailable", retryable: true },
        retry: { retryable: true, retryAt, reason: "ALL_APPROVED_OPTIONS_TEMPORARILY_UNAVAILABLE" },
        routing: { attempts, rejected }, touched });
    }
    const category = plan.passedStatic === 0 ? C.NO_ELIGIBLE_MODEL : C.ALL_OPTIONS_PERMANENTLY_UNAVAILABLE;
    const codes = [...new Set(rejected.map((r) => r.code).concat(attempts.filter((a) => a.category).map((a) => a.category)))];
    this.logger.warn("route_failed", { requestId: request.requestId, category, codes });
    return this._response({ request, startedAt, status: STATUS.FAILED,
      error: { category, message: `no approved free option can serve this request (${codes.join(", ") || "none configured"})`, retryable: false },
      routing: { attempts, rejected }, touched });
  }

  // ---------- response normalization ----------
  _response({ request, startedAt, status, entry = null, result = null, error = null, retry = null, routing, touched = null }) {
    const now = this.now();
    const ok = status === STATUS.SUCCESS;
    const snapshots = [];
    const keys = new Set();
    if (entry) keys.add(entry.key);
    for (const a of routing.attempts) keys.add(a.key);
    for (const r of routing.rejected) if (this.registry.isApproved(r.key)) keys.add(r.key);
    for (const k of keys) {
      const e = this.registry.get(k);
      if (e) snapshots.push(quota.snapshotModel(this.state.read(e.provider), e, now));
    }
    let retryOut = retry;
    if (!ok && !retryOut && error) retryOut = { retryable: !!error.retryable, retryAt: null, reason: error.category };
    if (retryOut) retryOut = { retryable: retryOut.retryable, retryAt: iso(retryOut.retryAt), retryAfterMs: retryOut.retryAt != null ? Math.max(0, retryOut.retryAt - now) : null, reason: retryOut.reason };
    const errorOut = error ? {
      category: error.category, message: this._safe(error.message), retryable: !!error.retryable,
      httpStatus: error.httpStatus == null ? null : error.httpStatus, providerCode: error.providerCode == null ? null : error.providerCode,
      provider: error.provider || null, model: error.model || null
    } : null;
    return {
      ok, status,
      content: ok ? scrubExact(result.content, this._secrets()) : null,
      provider: entry ? entry.provider : null,
      model: entry ? entry.model : null,
      servedModel: ok ? result.servedModel : null,
      finishReason: ok ? result.finishReason : null,
      usage: ok ? result.usage : null,
      request: {
        requestId: request ? request.requestId : null, taskType: request ? request.taskType : null,
        employeeId: request ? request.employeeId : null, capability: request ? request.capability : null,
        attempt: request ? request.retryContext.attempt : null, estimatedInputTokens: request ? request.estimatedInputTokens : null,
        maxOutputTokens: request ? request.output.maxTokens : null,
        startedAt: iso(startedAt), completedAt: iso(now), latencyMs: now - startedAt
      },
      error: errorOut,
      retry: retryOut,
      quota: { selected: ok && entry ? snapshots.find((s) => s.key === entry.key) || null : null, evaluated: snapshots },
      routing: {
        attempts: routing.attempts.map((a) => ({ ...a, retryAt: iso(a.retryAt) })),
        rejected: routing.rejected.map((r) => ({ key: r.key, code: r.code, message: this._safe(r.message || ""), permanent: r.permanent, retryAt: iso(r.retryAt) }))
      }
    };
  }

  // ---------- operations ----------
  // Manual recovery after a human fixes a credential/config problem.
  clearDisabled(provider, model = null) {
    this.state.mutate(provider, (ps) => { quota.clearBlocks(ps, model); return { commit: true, result: null }; }, `clear blocks ${provider}${model ? ":" + model : ""}`);
  }
  getQuotaSnapshot() {
    this.state.refresh();
    const now = this.now();
    return this.registry.list().map((e) => quota.snapshotModel(this.state.read(e.provider), e, now));
  }
}

function createRouter(options = {}) {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const registry = options.registry || createModelRegistry({ allowedFreeModels: config.ALLOWED_FREE_MODELS, overrides: config.MODEL_OVERRIDES });
  const adapters = options.adapters || null;
  let logger = options.logger;
  const secretsRef = { adapters: {} };
  if (!logger) logger = createLogger({ secrets: () => Object.values(secretsRef.adapters).flatMap((a) => a.secretValues()), now });
  const guard = (provider, model) => registry.assertApproved(provider, model);
  const builtAdapters = adapters || createProviderAdapters({ guard, env, fetchImpl: options.fetchImpl || globalThis.fetch, timeoutMs: options.timeoutMs, now });
  secretsRef.adapters = builtAdapters;
  return new Router({
    registry, adapters: builtAdapters, env, now, logger,
    stateStore: options.stateStore || new LocalStateStore(),
    backoff: { ...quota.DEFAULT_BACKOFF, ...(options.backoff || {}) },
    knownEmployees: options.knownEmployees === undefined ? loadEmployeeIds() : options.knownEmployees
  });
}

module.exports = { Router, createRouter, createModelRegistry, ModelNotApprovedError };
