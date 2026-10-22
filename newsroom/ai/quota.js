// Provider/model-specific quota + rate-limit state. PURE functions over plain JSON state
// objects (one state object per provider, persisted as quota-<provider>.json), so the same
// logic works against any state store and can be re-applied after an optimistic-write conflict.
//
// Sources of truth, in priority order (Phase 1 architecture, Section 9):
//   1. what the provider actually said (429 / headers / error body)  -> recordFailure / observeRateLimit
//   2. optional documented limits (rpm/rpd/tpm/tpd) supplied via the registry -> checkCapacity pacing
//   3. anything ambiguous -> UNKNOWN, treated conservatively
// No limit numbers are hardcoded here. A null limit means "not enforced locally".
"use strict";
const { QUOTA_STATES: S, ERROR_CATEGORIES: C, CATEGORY_TRAITS } = require("./constants");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const HOUR = 60 * MINUTE;

const DEFAULT_BACKOFF = Object.freeze({
  baseMs: 30 * 1000,          // first transient failure -> 30s
  maxMs: 15 * MINUTE,         // exponential, capped
  dailyFallbackMs: HOUR       // daily-quota exhaustion with no reset info: re-probe hourly
});

function emptyProviderState(provider) {
  return { provider, schemaVersion: 1, updatedAt: null, block: null, models: {} };
}
function emptyModelState() {
  return {
    state: S.AVAILABLE, blockedUntil: null, category: null, reason: null,
    consecutiveFailures: 0, lastAttemptAt: null, lastSuccessAt: null, lastError: null,
    usage: { recent: [], buckets: {} },   // recent: [[t, tokens]] last 60s; buckets: {minuteStart: {r, t}} last 24h
    observed: null                        // last provider-reported rate-limit info
  };
}
function getModel(ps, model) {
  if (!ps.models[model]) ps.models[model] = emptyModelState();
  return ps.models[model];
}
function minuteStart(t) { return Math.floor(t / MINUTE) * MINUTE; }

function prune(m, now) {
  m.usage.recent = m.usage.recent.filter((e) => now - e[0] < MINUTE);
  for (const k of Object.keys(m.usage.buckets)) if (Number(k) <= now - DAY) delete m.usage.buckets[k];
}

function usageTotals(m, now) {
  let rpm = 0, tpm = 0, rpd = 0, tpd = 0;
  for (const [t, tok] of m.usage.recent) if (now - t < MINUTE) { rpm += 1; tpm += tok; }
  for (const [k, b] of Object.entries(m.usage.buckets)) if (Number(k) > now - DAY) { rpd += b.r; tpd += b.t; }
  return { rpm, tpm, rpd, tpd };
}

function backoffMs(failuresBefore, cfg = DEFAULT_BACKOFF) {
  return Math.min(cfg.maxMs, cfg.baseMs * Math.pow(2, Math.min(failuresBefore, 10)));
}

// Active block for provider or model at `now`, or null (blocks expire lazily).
function activeBlock(ps, model, now) {
  const b = ps.block;
  if (b && (b.until == null || now < b.until)) {
    return { scope: "provider", state: b.state, until: b.until, category: b.category, reason: b.reason };
  }
  const m = ps.models[model];
  if (m && m.state !== S.AVAILABLE && (m.blockedUntil == null || now < m.blockedUntil)) {
    return { scope: "model", state: m.state, until: m.blockedUntil, category: m.category, reason: m.reason };
  }
  return null;
}

// Earliest time at which `needed` units are freed from a rolling window.
function freeAt(items, windowMs, needed) {
  // items: [[t, amount]] ascending by t
  let freed = 0;
  for (const [t, amt] of items) { freed += amt; if (freed >= needed) return t + windowMs + 1; }
  return items.length ? items[items.length - 1][0] + windowMs + 1 : null;
}

// ---- Local Neuron safety budget (Cloudflare Workers AI) ----
// An ESTIMATE kept in our own state, derived only from Cloudflare's DOCUMENTED per-token Neuron rates and the
// request's own token counts. It is NOT Cloudflare's account usage: other usage on the account is invisible to it
// and a state reset forgets it. It exists to stop us well before the documented free allowance. UTC-day window.
function utcDayStart(t) { return Math.floor(t / DAY) * DAY; }
function neuronCost(budget, inputTokens, outputTokens) {
  const raw = (inputTokens * budget.inputNeuronsPerMillionTokens + outputTokens * budget.outputNeuronsPerMillionTokens) / 1e6;
  return Math.max(1, Math.ceil(raw));
}
function neuronsUsed(m, now) {
  const n = m && m.neurons;
  return n && n.dayStart === utcDayStart(now) ? n.used : 0;
}
function estimateCost(entry, estimatedTokens, estimate) {
  // Without a split, price every token at the (higher) output rate: never under-count.
  const inTok = estimate ? estimate.inputTokens : 0;
  const outTok = estimate ? estimate.outputTokens : estimatedTokens;
  return neuronCost(entry.budget, inTok, outTok);
}
function checkBudget(m, entry, now, estimatedTokens, estimate) {
  const b = entry.budget;
  if (!b) return null;
  const cost = estimateCost(entry, estimatedTokens, estimate);
  if (cost > b.dailyNeurons) {
    return { ok: false, code: "REQUEST_EXCEEDS_NEURON_BUDGET", state: S.DAILY_LIMIT_REACHED, permanent: true, retryAt: null, detail: `estimated ${cost} Neurons exceeds the local daily budget of ${b.dailyNeurons}` };
  }
  const used = neuronsUsed(m, now);
  if (used + cost > b.dailyNeurons) {
    return { ok: false, code: "NEURON_BUDGET_EXHAUSTED", state: S.DAILY_LIMIT_REACHED, permanent: false, retryAt: utcDayStart(now) + DAY,
      detail: `local Neuron estimate ${used} + ${cost} would exceed the safety budget ${b.dailyNeurons} (resets 00:00 UTC)` };
  }
  return null;
}

// Can this provider:model take one more request of ~estTokens right now?
function checkCapacity(ps, entry, { now, estimatedTokens = 0, estimate = null }) {
  const blk = activeBlock(ps, entry.model, now);
  if (blk) {
    if (blk.state === S.DISABLED) {
      return { ok: false, code: blk.scope === "provider" ? "PROVIDER_DISABLED" : "MODEL_DISABLED",
        state: S.DISABLED, permanent: true, retryAt: null, detail: blk.reason || blk.category };
    }
    return { ok: false, code: blk.state, state: blk.state, permanent: false, retryAt: blk.until, detail: blk.reason || blk.category };
  }
  const lim = entry.limits || {};
  const m = ps.models[entry.model];
  const over = checkBudget(m, entry, now, estimatedTokens, estimate);
  if (over) return over;
  if (!m) {
    // Nothing recorded yet; only an impossible-size request can fail.
    if (lim.tpm != null && estimatedTokens > lim.tpm) return { ok: false, code: "REQUEST_EXCEEDS_TOKEN_LIMIT", state: S.TOKEN_LIMIT_REACHED, permanent: true, retryAt: null, detail: "tpm" };
    if (lim.tpd != null && estimatedTokens > lim.tpd) return { ok: false, code: "REQUEST_EXCEEDS_TOKEN_LIMIT", state: S.TOKEN_LIMIT_REACHED, permanent: true, retryAt: null, detail: "tpd" };
    return { ok: true };
  }
  const tot = usageTotals(m, now);
  const recent = m.usage.recent.filter((e) => now - e[0] < MINUTE).map((e) => [e[0], 1]);
  const recentTok = m.usage.recent.filter((e) => now - e[0] < MINUTE);
  const buckets = Object.entries(m.usage.buckets).filter(([k]) => Number(k) > now - DAY).sort((a, b) => a[0] - b[0]);

  if (lim.tpm != null && estimatedTokens > lim.tpm) return { ok: false, code: "REQUEST_EXCEEDS_TOKEN_LIMIT", state: S.TOKEN_LIMIT_REACHED, permanent: true, retryAt: null, detail: "tpm" };
  if (lim.tpd != null && estimatedTokens > lim.tpd) return { ok: false, code: "REQUEST_EXCEEDS_TOKEN_LIMIT", state: S.TOKEN_LIMIT_REACHED, permanent: true, retryAt: null, detail: "tpd" };

  if (lim.rpm != null && tot.rpm + 1 > lim.rpm) {
    return { ok: false, code: "PACING_RPM", state: S.RATE_LIMITED, permanent: false, retryAt: freeAt(recent, MINUTE, tot.rpm + 1 - lim.rpm), detail: "rpm" };
  }
  if (lim.tpm != null && tot.tpm + estimatedTokens > lim.tpm) {
    return { ok: false, code: "PACING_TPM", state: S.TOKEN_LIMIT_REACHED, permanent: false, retryAt: freeAt(recentTok, MINUTE, tot.tpm + estimatedTokens - lim.tpm), detail: "tpm" };
  }
  if (lim.rpd != null && tot.rpd + 1 > lim.rpd) {
    return { ok: false, code: "PACING_RPD", state: S.DAILY_LIMIT_REACHED, permanent: false,
      retryAt: freeAt(buckets.map(([k, b]) => [Number(k), b.r]), DAY, tot.rpd + 1 - lim.rpd), detail: "rpd" };
  }
  if (lim.tpd != null && tot.tpd + estimatedTokens > lim.tpd) {
    return { ok: false, code: "PACING_TPD", state: S.DAILY_LIMIT_REACHED, permanent: false,
      retryAt: freeAt(buckets.map(([k, b]) => [Number(k), b.t]), DAY, tot.tpd + estimatedTokens - lim.tpd), detail: "tpd" };
  }
  return { ok: true };
}

// Reserve usage BEFORE calling the provider (so concurrent workers see it).
function beginAttempt(ps, entry, now, estimatedTokens, estimate = null) {
  const m = getModel(ps, entry.model);
  prune(m, now);
  let neurons = null;
  if (entry.budget) {
    // Reserved up front (worst case = full max output) and NEVER refunded on failure: a timed-out or errored call may
    // still have consumed allocation, so the estimate only ever errs on the safe side.
    neurons = estimateCost(entry, estimatedTokens, estimate);
    const day = utcDayStart(now);
    if (!m.neurons || m.neurons.dayStart !== day) m.neurons = { dayStart: day, used: 0 };
    m.neurons.used += neurons;
  }
  m.usage.recent.push([now, estimatedTokens]);
  const ms = minuteStart(now);
  const b = m.usage.buckets[ms] || (m.usage.buckets[ms] = { r: 0, t: 0 });
  b.r += 1; b.t += estimatedTokens;
  m.lastAttemptAt = now;
  ps.updatedAt = now;
  return { attemptAt: now, minute: ms, estimatedTokens, neurons, neuronDay: neurons == null ? null : utcDayStart(now) };
}

function fixTokens(m, token, actualTokens) {
  if (!Number.isFinite(actualTokens)) return;
  const delta = actualTokens - token.estimatedTokens;
  const b = m.usage.buckets[token.minute];
  if (b) b.t = Math.max(0, b.t + delta);
  const r = m.usage.recent.find((e) => e[0] === token.attemptAt);
  if (r) r[1] = Math.max(0, r[1] + delta);
}

function observeRateLimit(ps, entry, info, now) {
  if (!info) return;
  const m = getModel(ps, entry.model);
  m.observed = {
    remainingRequests: info.remainingRequests, remainingTokens: info.remainingTokens,
    resetAt: info.resetRequestsAt || info.resetTokensAt || info.resetAt || null, observedAt: now
  };
  // Provider says we are at zero: stop calling until it says we can resume.
  const zeroReq = info.remainingRequests === 0;
  const zeroTok = info.remainingTokens === 0;
  const resetAt = zeroReq ? (info.resetRequestsAt || info.resetAt) : zeroTok ? (info.resetTokensAt || info.resetAt) : null;
  if ((zeroReq || zeroTok) && resetAt && resetAt > now) {
    const state = zeroTok ? S.TOKEN_LIMIT_REACHED : (resetAt - now >= HOUR ? S.DAILY_LIMIT_REACHED : S.RATE_LIMITED);
    if (m.state === S.AVAILABLE || (m.blockedUntil != null && m.blockedUntil < resetAt)) {
      m.state = state; m.blockedUntil = resetAt; m.category = null; m.reason = "PROVIDER_REPORTED_ZERO_REMAINING";
    }
  }
}

// True-up the Neuron reservation with the response's reported token usage (only when both counts are reported).
function fixNeurons(m, entry, token, usage) {
  if (!entry.budget || !token || token.neurons == null || !usage) return;
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return;   // unknown -> keep the worst-case reservation
  if (!m.neurons || m.neurons.dayStart !== token.neuronDay) return;
  const actual = neuronCost(entry.budget, usage.inputTokens, usage.outputTokens);
  m.neurons.used = Math.max(0, m.neurons.used + actual - token.neurons);
}

function completeSuccess(ps, entry, now, { token, usage, rateLimit }) {
  const m = getModel(ps, entry.model);
  if (token && usage && Number.isFinite(usage.totalTokens)) fixTokens(m, token, usage.totalTokens);
  fixNeurons(m, entry, token, usage);
  m.state = S.AVAILABLE; m.blockedUntil = null; m.category = null; m.reason = null;
  m.consecutiveFailures = 0; m.lastSuccessAt = now;
  observeRateLimit(ps, entry, rateLimit, now);
  ps.updatedAt = now;
}

// Applies an adapter error (already categorised) to state. Returns { scope, state, until, retryable }.
function recordFailure(ps, entry, now, error, { backoff = DEFAULT_BACKOFF } = {}) {
  const traits = CATEGORY_TRAITS[error.category] || CATEGORY_TRAITS[C.UNKNOWN];
  const m = getModel(ps, entry.model);
  m.lastError = { category: error.category, at: now, httpStatus: error.httpStatus == null ? null : error.httpStatus };
  ps.updatedAt = now;
  if (traits.scope === "request") return { scope: "request", state: null, until: null, retryable: false };

  let until = null;
  if (traits.state !== S.DISABLED) {
    if (error.retryAfterMs != null) until = now + Math.max(1000, error.retryAfterMs);
    else if (error.resetAt != null && error.resetAt > now) until = error.resetAt;
    else if (error.category === C.QUOTA_DAILY) until = now + backoff.dailyFallbackMs;
    else until = now + backoffMs(m.consecutiveFailures, backoff);
    m.consecutiveFailures += 1;
  }
  if (traits.scope === "provider") {
    ps.block = { state: traits.state, until, category: error.category, reason: error.category, since: now };
  } else {
    m.state = traits.state; m.blockedUntil = until; m.category = error.category; m.reason = error.category;
  }
  observeRateLimit(ps, entry, error.rateLimit, now);
  return { scope: traits.scope, state: traits.state, until, retryable: traits.retryable };
}

// Manual recovery after a human fixes a key / config: lifts DISABLED (and any block) for a
// provider or a single model.
function clearBlocks(ps, model = null) {
  if (model == null) {
    ps.block = null;
    for (const m of Object.values(ps.models)) { m.state = S.AVAILABLE; m.blockedUntil = null; m.category = null; m.reason = null; m.consecutiveFailures = 0; }
  } else if (ps.models[model]) {
    const m = ps.models[model];
    m.state = S.AVAILABLE; m.blockedUntil = null; m.category = null; m.reason = null; m.consecutiveFailures = 0;
  }
}

// JSON-safe view of one provider:model for responses/diagnostics. Contains no secrets.
function snapshotModel(ps, entry, now) {
  const m = ps.models[entry.model];
  const blk = activeBlock(ps, entry.model, now);
  const tot = m ? usageTotals(m, now) : { rpm: 0, tpm: 0, rpd: 0, tpd: 0 };
  return {
    key: entry.key, provider: entry.provider, model: entry.model,
    state: blk ? blk.state : S.AVAILABLE,
    blockedUntil: blk && blk.until != null ? new Date(blk.until).toISOString() : null,
    blockScope: blk ? blk.scope : null,
    usage: tot,
    limits: { ...entry.limits },
    remaining: m && m.observed ? { requests: m.observed.remainingRequests, tokens: m.observed.remainingTokens,
      resetAt: m.observed.resetAt ? new Date(m.observed.resetAt).toISOString() : null } : null,
    consecutiveFailures: m ? m.consecutiveFailures : 0,
    // Present only for budgeted models. `usedEstimate` is OUR local estimate, not the provider's account usage.
    budget: entry.budget ? {
      kind: "LOCAL_ESTIMATE", unit: "neurons", dailyBudget: entry.budget.dailyNeurons,
      usedEstimate: neuronsUsed(m, now), resetsAt: new Date(utcDayStart(now) + DAY).toISOString(),
      authoritative: false
    } : null
  };
}

module.exports = {
  MINUTE, DAY, DEFAULT_BACKOFF, emptyProviderState, getModel, checkCapacity, beginAttempt,
  completeSuccess, recordFailure, neuronCost, utcDayStart, observeRateLimit, clearBlocks, snapshotModel, backoffMs, usageTotals, activeBlock
};
