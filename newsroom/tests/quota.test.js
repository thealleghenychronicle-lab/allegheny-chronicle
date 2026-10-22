"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const q = require("../ai/quota");
const { makeRegistry, GEMINI, GROQ } = require("./helpers/router-fixtures");

const T0 = Date.parse("2026-01-01T00:00:00Z");
const entry = (limits) => makeRegistry({ [GEMINI]: { limits } }, [GEMINI]).get(GEMINI);

test("no limits configured means no local pacing (nothing invented)", () => {
  const ps = q.emptyProviderState("gemini");
  const e = entry({});
  for (let i = 0; i < 50; i++) q.beginAttempt(ps, e, T0 + i, 100);
  assert.equal(q.checkCapacity(ps, e, { now: T0 + 100, estimatedTokens: 100 }).ok, true);
});

test("rpm / tpm / rpd / tpd pacing with correct retryAt", () => {
  const e = entry({ rpm: 2, tpm: 1000, rpd: 5, tpd: 10000 });
  let ps = q.emptyProviderState("gemini");
  q.beginAttempt(ps, e, T0, 100); q.beginAttempt(ps, e, T0 + 1000, 100);
  let c = q.checkCapacity(ps, e, { now: T0 + 2000, estimatedTokens: 100 });
  assert.equal(c.code, "PACING_RPM");
  assert.equal(c.retryAt, T0 + q.MINUTE + 1);
  assert.equal(q.checkCapacity(ps, e, { now: T0 + q.MINUTE + 2, estimatedTokens: 100 }).ok, true);

  ps = q.emptyProviderState("gemini");
  q.beginAttempt(ps, e, T0, 900);
  c = q.checkCapacity(ps, e, { now: T0 + 5, estimatedTokens: 200 });
  assert.equal(c.code, "PACING_TPM");
  assert.equal(c.state, "TOKEN_LIMIT_REACHED");

  ps = q.emptyProviderState("gemini");
  for (let i = 0; i < 5; i++) q.beginAttempt(ps, e, T0 + i * 2 * q.MINUTE, 10);
  c = q.checkCapacity(ps, e, { now: T0 + 10 * q.MINUTE + 1, estimatedTokens: 10 });
  assert.equal(c.code, "PACING_RPD");
  assert.equal(c.state, "DAILY_LIMIT_REACHED");
  assert.equal(c.retryAt, T0 + q.DAY + 1);
  assert.equal(q.checkCapacity(ps, e, { now: T0 + q.DAY + 2, estimatedTokens: 10 }).ok, true);

  assert.equal(q.checkCapacity(q.emptyProviderState("gemini"), e, { now: T0, estimatedTokens: 5000 }).permanent, true); // can never fit in tpm
});

test("actual token usage corrects the reservation", () => {
  const e = entry({ tpm: 1000 });
  const ps = q.emptyProviderState("gemini");
  const token = q.beginAttempt(ps, e, T0, 800);
  q.completeSuccess(ps, e, T0 + 10, { token, usage: { totalTokens: 100 }, rateLimit: null });
  assert.equal(q.usageTotals(ps.models[e.model], T0 + 20).tpm, 100);
});

test("failure blocks only the affected model; backoff grows exponentially and is capped; success resets", () => {
  const e = entry({});
  const ps = q.emptyProviderState("gemini");
  const err = { category: "PROVIDER_UNAVAILABLE" };
  const cfg = { baseMs: 1000, maxMs: 5000, dailyFallbackMs: 9000 };
  const untils = [];
  for (let i = 0; i < 5; i++) untils.push(q.recordFailure(ps, e, T0, err, { backoff: cfg }).until - T0);
  assert.deepEqual(untils, [1000, 2000, 4000, 5000, 5000]);
  q.completeSuccess(ps, e, T0, { token: null, usage: null, rateLimit: null });
  assert.equal(q.recordFailure(ps, e, T0, err, { backoff: cfg }).until - T0, 1000);
  assert.equal(q.recordFailure(ps, e, T0, { category: "QUOTA_DAILY" }, { backoff: cfg }).until - T0, 9000);
  assert.equal(q.checkCapacity(ps, e, { now: T0 + 8999, estimatedTokens: 1 }).ok, false);
  assert.equal(q.checkCapacity(ps, e, { now: T0 + 9000, estimatedTokens: 1 }).ok, true);      // blocks expire on their own
});

test("provider-scoped failure (auth) blocks every model of that provider; provider-reported zero-remaining blocks until reset", () => {
  const reg = makeRegistry({}, ["groq:a", "groq:b", GEMINI]);
  const ps = q.emptyProviderState("groq");
  q.recordFailure(ps, reg.get("groq:a"), T0, { category: "AUTHENTICATION" });
  assert.equal(q.checkCapacity(ps, reg.get("groq:b"), { now: T0 + 1e9, estimatedTokens: 1 }).code, "PROVIDER_DISABLED");
  q.clearBlocks(ps);
  assert.equal(q.checkCapacity(ps, reg.get("groq:b"), { now: T0, estimatedTokens: 1 }).ok, true);

  q.observeRateLimit(ps, reg.get("groq:a"), { remainingRequests: 0, resetRequestsAt: T0 + 3 * 3600000 }, T0);
  const c = q.checkCapacity(ps, reg.get("groq:a"), { now: T0 + 1, estimatedTokens: 1 });
  assert.equal(c.state, "DAILY_LIMIT_REACHED");
  assert.equal(c.retryAt, T0 + 3 * 3600000);
  assert.equal(q.checkCapacity(ps, reg.get("groq:b"), { now: T0 + 1, estimatedTokens: 1 }).ok, true);   // sibling model unaffected
});
