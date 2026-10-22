"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("./helpers/router-fixtures");
const { createRequest } = require("../ai/request");
const { createProviderAdapters } = require("../providers");
const { redactString, redactDeep } = require("../ai/redact");
const { parseDurationMs, parseRateLimitHeaders, parseResetToEpochMs } = require("../ai/http-utils");

function adapters(handlers = {}, env = F.FAKE_KEYS) {
  const fetchImpl = F.makeFetch(handlers);
  const reg = F.makeRegistry({}, ["gemini:m", "groq:m", "openrouter:v/m:free"]);   // adapters still enforce the allowlist
  const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env, fetchImpl });
  return { a, fetchImpl };
}
const request = (extra = {}) => createRequest({ taskType: "writing", system: "Be brief.", prompt: "Hello", employee: "lubna", generation: { temperature: 0.4, topP: 0.9, stopSequences: ["END"], seed: 7 }, output: { maxTokens: 300 }, ...extra }, { knownEmployees: ["lubna"] });

test("request construction is provider-specific but carries no credentials", () => {
  const { a } = adapters();
  const r = request();
  const g = a.gemini.buildRequest(r, "m1");
  assert.match(g.url, /models\/m1:generateContent$/);
  assert.deepEqual(g.body.systemInstruction, { parts: [{ text: "Be brief." }] });
  assert.equal(g.body.generationConfig.maxOutputTokens, 300);
  assert.equal(g.body.generationConfig.topP, 0.9);
  const q = a.groq.buildRequest(r, "m2");
  assert.equal(q.body.max_completion_tokens, 300);
  assert.deepEqual(q.body.messages.map((m) => m.role), ["system", "user"]);
  const o = a.openrouter.buildRequest(r, "vendor/m3:free");
  assert.equal(o.body.max_tokens, 300);
  assert.ok(!("models" in o.body) && !("route" in o.body));      // no fallback routing to other (possibly paid) models
  for (const b of [g, q, o]) assert.ok(!JSON.stringify(b).includes("FAKE"));
});

test("credential presence is reported without exposing values", () => {
  const { a } = adapters({}, { GROQ_API_KEY: "  " });
  assert.equal(a.groq.isConfigured(), false);
  assert.equal(a.gemini.isConfigured(), false);
  assert.equal(adapters().a.gemini.isConfigured(), true);
});

test("Gemini error classification: daily vs per-minute vs token quota, RetryInfo, auth", async () => {
  const body = (quotaId, delay) => ({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } });
  const cases = [
    ["GenerateRequestsPerDayPerProjectPerModel-FreeTier", "QUOTA_DAILY"],
    ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "RATE_LIMIT_TEMPORARY"],
    ["GenerateContentInputTokensPerModelPerMinute-FreeTier", "QUOTA_TOKENS"]];
  for (const [id, cat] of cases) {
    const { a } = adapters({ gemini: F.json(429, body(id, "34s")) });
    const r = await a.gemini.call(request(), "m");
    assert.equal(r.ok, false);
    assert.equal(r.error.category, cat);
    assert.equal(r.error.retryable, true);
    assert.equal(r.error.retryAfterMs, 34000);
  }
  const { a } = adapters({ gemini: F.json(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid", details: [{ "@type": "x/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } }) });
  const r = await a.gemini.call(request(), "m");
  assert.equal(r.error.category, "AUTHENTICATION");
  assert.equal(r.error.retryable, false);
});

test("Gemini blocked prompt/output is CONTENT_BLOCKED (not retryable); empty text is MALFORMED_RESPONSE", async () => {
  let { a } = adapters({ gemini: F.json(200, { promptFeedback: { blockReason: "SAFETY" } }) });
  assert.equal((await a.gemini.call(request(), "m")).error.category, "CONTENT_BLOCKED");
  ({ a } = adapters({ gemini: F.json(200, { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }) }));
  const r = await a.gemini.call(request(), "m");
  assert.equal(r.error.category, "MALFORMED_RESPONSE");
  assert.equal(r.error.retryable, true);
});

test("Groq error classification uses the limit named in the message", async () => {
  const mk = (msg, type = "requests") => F.json(429, { error: { message: msg, type, code: "rate_limit_exceeded" } });
  const cases = [
    ["Rate limit reached ... on requests per day (RPD): Limit 1. Please try again in 12m0s", "QUOTA_DAILY", 720000],
    ["Rate limit reached ... on tokens per day (TPD): Limit 1", "QUOTA_DAILY", null],
    ["Rate limit reached ... on tokens per minute (TPM): Limit 1. Please try again in 1.5s", "QUOTA_TOKENS", 1500],
    ["Rate limit reached ... on requests per minute (RPM): Limit 1", "RATE_LIMIT_TEMPORARY", null]];
  for (const [msg, cat, ms] of cases) {
    const { a } = adapters({ groq: mk(msg) });
    const r = await a.groq.call(request(), "m");
    assert.equal(r.error.category, cat);
    assert.equal(r.error.retryAfterMs, ms);
  }
  const { a } = adapters({ groq: F.json(404, { error: { message: "gone", code: "model_decommissioned" } }) });
  assert.equal((await a.groq.call(request(), "m")).error.category, "MODEL_NOT_FOUND");
});

test("Groq success extracts content/usage and parses rate-limit headers", async () => {
  const { a } = adapters({ groq: F.groqOk("hi", { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "2m59.5s", "x-ratelimit-remaining-tokens": "5000" }) });
  const r = await a.groq.call(request(), "m");
  assert.equal(r.ok, true);
  assert.equal(r.content, "hi");
  assert.equal(r.usage.totalTokens, 17);
  assert.equal(r.rateLimit.remainingRequests, 0);
  assert.equal(r.rateLimit.remainingTokens, 5000);
  assert.ok(r.rateLimit.resetRequestsAt > Date.now());
});

test("OpenRouter: 402 -> PAYMENT_REQUIRED, moderation 403 -> CONTENT_BLOCKED, error-in-200 handled", async () => {
  let { a } = adapters({ openrouter: F.json(402, { error: { code: 402, message: "credits" } }) });
  assert.equal((await a.openrouter.call(request(), "v/m:free")).error.category, "PAYMENT_REQUIRED");
  ({ a } = adapters({ openrouter: F.json(403, { error: { code: 403, message: "flagged", metadata: { reasons: ["x"] } } }) }));
  assert.equal((await a.openrouter.call(request(), "v/m:free")).error.category, "CONTENT_BLOCKED");
  ({ a } = adapters({ openrouter: F.json(200, { error: { code: 429, message: "Rate limit exceeded: free-models-per-day" } }) }));
  const r = await a.openrouter.call(request(), "v/m:free");
  assert.equal(r.error.category, "QUOTA_DAILY");
  assert.equal(r.error.retryable, true);
});

test("generic HTTP classification: 5xx and network failures are retryable; unknown statuses are UNKNOWN (conservative)", async () => {
  let { a } = adapters({ groq: F.json(503, { error: { message: "down" } }) });
  assert.equal((await a.groq.call(request(), "m")).error.category, "PROVIDER_UNAVAILABLE");
  ({ a } = adapters({ groq: new Error("ECONNRESET") }));
  const net = await a.groq.call(request(), "m");
  assert.equal(net.error.category, "PROVIDER_UNAVAILABLE");
  assert.equal(net.error.retryable, true);
  ({ a } = adapters({ groq: F.json(418, { error: { message: "teapot" } }) }));
  const u = await a.groq.call(request(), "m");
  assert.equal(u.error.category, "UNKNOWN");
  assert.equal(u.error.retryable, true);
  ({ a } = adapters({ groq: new Response("<html>oops</html>", { status: 200 }) }));
  assert.equal((await a.groq.call(request(), "m")).error.category, "MALFORMED_RESPONSE");
});

test("request timeout is enforced and reported as retryable", async () => {
  const reg = F.makeRegistry();
  const slow = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env: F.FAKE_KEYS, fetchImpl: slow, timeoutMs: 20 });
  const r = await a.groq.call(request(), "fixture-groq-model");
  assert.equal(r.error.category, "PROVIDER_UNAVAILABLE");
  assert.match(r.error.message, /timed out/);
});

test("redaction: exact secrets, key-shaped strings, bearer tokens, sensitive object keys", () => {
  const secret = "my-very-custom-secret-value";
  const s = `x ${secret} AIza${"a".repeat(30)} gsk_${"b".repeat(30)} sk-or-${"c".repeat(20)} Bearer abcdefgh12345678 api_key=zzzzzzzz`;
  const out = redactString(s, [secret]);
  for (const bad of [secret, "AIzaaaa", "gsk_bbb", "sk-or-ccc", "abcdefgh12345678", "zzzzzzzz"]) assert.ok(!out.includes(bad), bad);
  const obj = redactDeep({ headers: { Authorization: "Bearer q", "x-goog-api-key": "k" }, inputTokens: 5, note: secret }, [secret]);
  assert.equal(obj.headers.Authorization, "[REDACTED]");
  assert.equal(obj.inputTokens, 5);
  assert.equal(obj.note, "[REDACTED]");
});

test("header/duration parsing helpers", () => {
  assert.equal(parseDurationMs("2m59.56s"), 179560);
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(parseDurationMs("1h"), 3600000);
  assert.equal(parseDurationMs("30"), 30000);
  assert.equal(parseDurationMs("garbage"), null);
  const now = 1_700_000_000_000;
  assert.equal(parseResetToEpochMs("30", now), now + 30000);
  assert.equal(parseResetToEpochMs(String(now + 5000), now), now + 5000);
  assert.equal(parseResetToEpochMs(String(Math.floor((now + 5000) / 1000)), now), Math.floor((now + 5000) / 1000) * 1000);
  assert.equal(parseRateLimitHeaders({ "Retry-After": "7" }, now).retryAfterMs, 7000);
  assert.equal(parseRateLimitHeaders({ authorization: "x" }, now), null);
});
