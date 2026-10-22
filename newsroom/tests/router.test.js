"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("./helpers/router-fixtures");
const { LocalStateStore } = require("../local-state-store");
const { ModelNotApprovedError } = require("../ai/registry");

const rateLimitBody = (msg = "Rate limit reached") => ({ error: { message: msg, type: "requests", code: "rate_limit_exceeded" } });

// ---- Test 1 ----
test("1. successful routing selects an approved free model and returns a normalized result", async () => {
  const { router, fetchImpl } = F.makeRouter({ handlers: { gemini: F.geminiOk("hello world") } });
  const r = await router.route(F.req());
  assert.equal(r.ok, true);
  assert.equal(r.status, "SUCCESS");
  assert.equal(r.provider, "gemini");
  assert.equal(r.model, "fixture-gemini-model");
  assert.equal(r.content, "hello world");
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(r.error, null);
  assert.equal(r.request.employeeId, "lubna");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(r.quota.selected.key, F.GEMINI);
});

// ---- Test 2 ----
test("2a. fallback: provider answers 429 live, next approved free option is used", async () => {
  const { router, fetchImpl } = F.makeRouter({ handlers: {
    gemini: F.json(429, { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }),
    groq: F.groqOk("from groq") } });
  const r = await router.route(F.req());
  assert.equal(r.ok, true);
  assert.equal(r.provider, "groq");
  assert.equal(r.routing.attempts[0].key, F.GEMINI);
  assert.equal(r.routing.attempts[0].category, "RATE_LIMIT_TEMPORARY");
  assert.equal(fetchImpl.callsTo("gemini").length, 1);
  // second request: gemini is now known-limited, so it is skipped WITHOUT another call
  const r2 = await router.route(F.req());
  assert.equal(r2.provider, "groq");
  assert.equal(fetchImpl.callsTo("gemini").length, 1);
  assert.ok(r2.routing.rejected.some((x) => x.key === F.GEMINI && x.code === "RATE_LIMITED"));
});

test("2b. fallback: pre-blocked model is skipped and another is chosen", async () => {
  const { router, fetchImpl } = F.makeRouter({ handlers: { groq: F.groqOk(), gemini: F.geminiOk() } });
  router.state.mutate("gemini", (ps) => { require("../ai/quota").recordFailure(ps, F.makeRegistry().get(F.GEMINI), router.now(), { category: "RATE_LIMIT_TEMPORARY", retryAfterMs: 60000 }); return { commit: true, result: null }; });
  const r = await router.route(F.req());
  assert.equal(r.provider, "groq");
  assert.equal(fetchImpl.callsTo("gemini").length, 0);
});

// ---- Test 3 ----
test("3. all unavailable -> controlled WAITING with retry time, no paid fallback", async () => {
  const { router, fetchImpl, now } = F.makeRouter({ handlers: {
    gemini: F.json(429, { error: { message: "x", status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "120" }),
    groq: F.json(429, rateLimitBody(), { "retry-after": "30" }),
    openrouter: F.json(429, { error: { code: 429, message: "slow down" } }) } });
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  assert.equal(r.status, "WAITING");
  assert.equal(r.error.category, "ALL_OPTIONS_TEMPORARILY_UNAVAILABLE");
  assert.equal(r.retry.retryable, true);
  assert.equal(r.retry.retryAfterMs, 30000);          // earliest of the retry hints (groq)
  assert.equal(r.retry.retryAt, new Date(now() + 30000).toISOString());
  assert.equal(r.content, null);
  assert.equal(fetchImpl.calls.length, 3);
  // While waiting, the router does not hammer providers.
  const again = await router.route(F.req());
  assert.equal(again.status, "WAITING");
  assert.equal(fetchImpl.calls.length, 3);
  // After the reset window passes, the provider is tried again.
  now.advance(31000);
  const later = await router.route(F.req());
  assert.equal(fetchImpl.callsTo("gemini").length, 1);   // gemini said 120s: still blocked
  assert.equal(fetchImpl.callsTo("groq").length, 2);     // groq said 30s: probed again
  assert.equal(fetchImpl.callsTo("openrouter").length, 2); // no hint -> 30s default backoff elapsed
  assert.equal(later.status, "WAITING");
});

// ---- Test 4 ----
test("4. temporary rate limit is classified retryable with reset info", async () => {
  const { router } = F.makeRouter({ registry: F.makeRegistry({}, [F.GROQ]), handlers: {
    groq: F.json(429, rateLimitBody("Rate limit reached for model on requests per minute (RPM): Limit 30. Please try again in 1m30.5s."), { "retry-after": "91" }) } });
  const r = await router.route(F.req());
  assert.equal(r.status, "WAITING");
  const a = r.routing.attempts[0];
  assert.equal(a.category, "RATE_LIMIT_TEMPORARY");
  assert.equal(a.retryable, true);
  assert.equal(r.retry.retryable, true);
  assert.equal(r.retry.retryAfterMs, 90500);          // the precise "try again in 1m30.5s" beats the rounded header
  assert.equal(r.quota.evaluated[0].state, "RATE_LIMITED");
});

// ---- Test 5 ----
test("5a. permanent auth failure is not retried and does not block other providers", async () => {
  const { router, fetchImpl } = F.makeRouter({ handlers: {
    gemini: F.json(401, { error: { code: 401, message: "bad key", status: "UNAUTHENTICATED" } }),
    groq: F.groqOk("groq ok") } });
  const r1 = await router.route(F.req());
  assert.equal(r1.provider, "groq");                                   // fell through to a healthy provider
  const r2 = await router.route(F.req());
  assert.equal(fetchImpl.callsTo("gemini").length, 1);                 // never retried
  assert.ok(r2.routing.rejected.some((x) => x.key === F.GEMINI && x.code === "PROVIDER_DISABLED" && x.permanent));
});

test("5b. when every option fails permanently the result is FAILED and non-retryable", async () => {
  const bad = (code) => F.json(code, { error: { code, message: "nope" } });
  const { router, fetchImpl } = F.makeRouter({ handlers: { gemini: bad(401), groq: bad(401), openrouter: bad(402) } });
  const r = await router.route(F.req());
  assert.equal(r.status, "FAILED");
  assert.equal(r.error.category, "ALL_OPTIONS_PERMANENTLY_UNAVAILABLE");
  assert.equal(r.error.retryable, false);
  assert.equal(r.retry.retryable, false);
  const n = fetchImpl.calls.length;
  const r2 = await router.route(F.req());
  assert.equal(r2.status, "FAILED");
  assert.equal(fetchImpl.calls.length, n);                             // zero further calls
});

test("5c. missing credentials are a permanent configuration failure with no network call", async () => {
  const { router, fetchImpl } = F.makeRouter({ env: {}, handlers: {} });
  const r = await router.route(F.req());
  assert.equal(r.status, "FAILED");
  assert.equal(r.error.retryable, false);
  assert.equal(fetchImpl.calls.length, 0);
  assert.ok(r.routing.rejected.every((x) => x.code === "MISSING_CREDENTIALS"));
});

test("5d. OpenRouter 402 (credits required) permanently disables that model — never retried", async () => {
  const { router, fetchImpl } = F.makeRouter({ registry: F.makeRegistry({}, [F.OPENROUTER]), handlers: { openrouter: F.json(402, { error: { code: 402, message: "insufficient credits" } }) } });
  const r = await router.route(F.req());
  assert.equal(r.status, "FAILED");
  assert.equal(r.routing.attempts[0].category, "PAYMENT_REQUIRED");
  await router.route(F.req());
  assert.equal(fetchImpl.calls.length, 1);
});

test("5e. request-level errors (invalid request / blocked content) stop routing and are not shopped around", async () => {
  const { router, fetchImpl } = F.makeRouter({ handlers: { gemini: F.json(400, { error: { code: 400, message: "bad input", status: "INVALID_ARGUMENT" } }), groq: F.groqOk() } });
  const r = await router.route(F.req());
  assert.equal(r.status, "FAILED");
  assert.equal(r.error.category, "INVALID_REQUEST");
  assert.equal(r.error.retryable, false);
  assert.equal(fetchImpl.callsTo("groq").length, 0);
  // and the model is NOT marked as broken
  const snap = router.getQuotaSnapshot().find((s) => s.key === F.GEMINI);
  assert.equal(snap.state, "AVAILABLE");
});

// ---- Test 6 ----
test("6a. paid / unapproved models can never be selected, even when explicitly requested", async () => {
  const { router, fetchImpl } = F.makeRouter({ handlers: { gemini: F.geminiOk(), groq: F.groqOk(), openrouter: F.openrouterOk() } });
  const r = await router.route(F.req({ modelPreference: { prefer: ["openai:gpt-4o", "openrouter:paid/model"] } }));
  assert.equal(r.ok, true);
  assert.ok(["gemini", "groq", "openrouter"].includes(r.provider));
  const models = fetchImpl.calls.map((c) => c.body.model).filter(Boolean);
  assert.ok(!models.includes("gpt-4o") && !models.includes("paid/model"));
  assert.ok(r.routing.rejected.some((x) => x.key === "openai:gpt-4o" && x.code === "NOT_APPROVED_FREE"));
});

test("6b. strict preference for a paid model yields no eligible model (no silent substitution)", async () => {
  const { router, fetchImpl } = F.makeRouter({ handlers: { gemini: F.geminiOk() } });
  const r = await router.route(F.req({ modelPreference: { prefer: ["openai:gpt-4o"], strict: true } }));
  assert.equal(r.status, "FAILED");
  assert.equal(r.error.category, "NO_ELIGIBLE_MODEL");
  assert.equal(fetchImpl.calls.length, 0);
});

test("6c. registry and adapters hard-block non-allowlisted models", async () => {
  const reg = F.makeRegistry();
  assert.throws(() => reg.assertApproved("openai", "gpt-4o"), ModelNotApprovedError);
  assert.throws(() => reg.assertApproved("gemini", "some-paid-model"), ModelNotApprovedError);
  assert.throws(() => F.makeRegistry({ "openai:gpt-4o": {} }), ModelNotApprovedError);           // cannot be added via overrides
  // OpenRouter ids without :free are excluded by identity rule, and placeholders never usable
  const r2 = F.makeRegistry({}, ["openrouter:vendor/paid-model", "openrouter:free-tier-model-placeholder", F.GEMINI]);
  assert.deepEqual(r2.list().map((e) => e.key), [F.GEMINI]);
  assert.deepEqual(r2.issues.map((i) => i.code).sort(), ["OPENROUTER_MODEL_NOT_FREE_VARIANT", "PLACEHOLDER_MODEL"]);
  // adapter-level guard: calling an adapter directly with an unapproved model throws before any network I/O
  const { router, fetchImpl } = F.makeRouter();
  const { createRequest } = require("../ai/request");
  await assert.rejects(() => router.adapters.groq.call(createRequest(F.req()), "some-paid-model"), ModelNotApprovedError);
  assert.equal(fetchImpl.calls.length, 0);
});

test("6d. provider quota exhaustion never falls back to anything outside the allowlist", async () => {
  const { router, fetchImpl } = F.makeRouter({ registry: F.makeRegistry({}, [F.GROQ]), handlers: { groq: F.json(429, rateLimitBody()) } });
  const r = await router.route(F.req());
  assert.equal(r.status, "WAITING");
  assert.ok(fetchImpl.calls.every((c) => c.provider === "groq" && c.body.model === "fixture-groq-model"));
});

// ---- Test 7 ----
test("7. API credentials never appear in responses or logs (success, failure, and hostile error bodies)", async () => {
  const keys = Object.values(F.FAKE_KEYS);
  const leaky = (k) => F.json(500, { error: { message: `upstream echoed credential ${k} and Bearer ${k}` } });
  const { router, logger, logLines } = F.makeRouter({ handlers: {
    gemini: leaky(F.FAKE_KEYS.GEMINI_API_KEY),
    groq: leaky(F.FAKE_KEYS.GROQ_API_KEY),
    openrouter: F.openrouterOk("all good") } });
  const responses = [await router.route(F.req()), await router.route(F.req({ employee: "zaydan" }))];
  const blob = JSON.stringify(responses) + logger.dump() + logLines.join("\n") + JSON.stringify(router.getQuotaSnapshot()) + JSON.stringify(router.state.store.backing.files.size ? [...router.state.store.backing.files.values()] : []);
  for (const k of keys) assert.ok(!blob.includes(k), `credential leaked: ${k.slice(0, 6)}...`);
  assert.ok(logLines.length > 0);
  // credentials are sent in headers only — never in URL or body
  const { fetchImpl } = F.makeRouter({ handlers: { gemini: F.geminiOk() } });
  const r2 = F.makeRouter({ handlers: { gemini: F.geminiOk() } });
  await r2.router.route(F.req());
  const call = r2.fetchImpl.calls[0];
  assert.ok(!call.url.includes(F.FAKE_KEYS.GEMINI_API_KEY));
  assert.ok(!JSON.stringify(call.body).includes(F.FAKE_KEYS.GEMINI_API_KEY));
  assert.equal(call.headers["x-goog-api-key"], F.FAKE_KEYS.GEMINI_API_KEY);
});

// ---- Test 8 ----
test("8. different provider responses normalize to the same shape", async () => {
  const shapes = [];
  for (const [prov, key, handler] of [["gemini", F.GEMINI, F.geminiOk("A")], ["groq", F.GROQ, F.groqOk("B")], ["openrouter", F.OPENROUTER, F.openrouterOk("C")]]) {
    const { router } = F.makeRouter({ registry: F.makeRegistry({}, [key]), handlers: { [prov]: handler } });
    const r = await router.route(F.req());
    assert.equal(r.ok, true);
    assert.equal(r.provider, prov);
    assert.equal(typeof r.content, "string");
    assert.ok(Number.isInteger(r.usage.inputTokens) && Number.isInteger(r.usage.outputTokens) && Number.isInteger(r.usage.totalTokens));
    shapes.push(Object.keys(r).sort().join(","));
    assert.deepEqual(Object.keys(r.request).sort(), ["attempt", "capability", "completedAt", "employeeId", "estimatedInputTokens", "latencyMs", "maxOutputTokens", "requestId", "startedAt", "taskType"]);
  }
  assert.equal(new Set(shapes).size, 1);
});

// ---- Test 9 ----
test("9. quota state is per provider AND per model, not one global bucket", async () => {
  const reg = F.makeRegistry({}, ["groq:model-a", "groq:model-b", F.GEMINI]);
  const { router, fetchImpl } = F.makeRouter({ registry: reg, handlers: {
    groq: (call) => call.body.model === "model-a" ? F.json(429, rateLimitBody("(RPM)"), { "retry-after": "60" }) : F.groqOk("b works"),
    gemini: F.geminiOk() } });
  const r = await router.route(F.req({ modelPreference: { prefer: ["groq:model-a", "groq:model-b"] } }));
  assert.equal(r.model, "model-b");                                        // same provider, different model, still usable
  const snaps = Object.fromEntries(router.getQuotaSnapshot().map((s) => [s.key, s]));
  assert.equal(snaps["groq:model-a"].state, "RATE_LIMITED");
  assert.equal(snaps["groq:model-b"].state, "AVAILABLE");
  assert.equal(snaps["gemini:fixture-gemini-model"].state, "AVAILABLE");
  assert.equal(snaps["groq:model-a"].usage.rpd, 1);
  assert.equal(snaps["groq:model-b"].usage.rpd, 1);
  assert.equal(snaps["gemini:fixture-gemini-model"].usage.rpd, 0);
  // persisted per provider file, as in the Phase 1 newsroom-state layout
  assert.deepEqual(router.state.store.listFiles().sort(), ["quota-groq.json"]);
});

// ---- extras ----
test("locally configured limits pace requests (RPM) without inventing numbers by default", async () => {
  const reg = F.makeRegistry({ [F.GEMINI]: { limits: { rpm: 1 } } }, [F.GEMINI, F.GROQ]);
  const { router, fetchImpl, now } = F.makeRouter({ registry: reg, handlers: { gemini: F.geminiOk(), groq: F.groqOk() } });
  assert.equal((await router.route(F.req())).provider, "gemini");
  assert.equal((await router.route(F.req())).provider, "groq");            // gemini paced out locally
  now.advance(61000);
  assert.equal((await router.route(F.req())).provider, "gemini");
  const unlimited = F.makeRegistry();
  assert.ok(unlimited.list().every((e) => Object.values(e.limits).every((v) => v === null)));
});

test("deterministic selection: same inputs, same order, every time", async () => {
  const picks = [];
  for (let i = 0; i < 3; i++) {
    const { router } = F.makeRouter({ handlers: { gemini: F.geminiOk(), groq: F.groqOk(), openrouter: F.openrouterOk() } });
    picks.push(router.plan(F.req()).eligible.map((e) => e.key).join(">"));
  }
  assert.equal(new Set(picks).size, 1);
  const { router } = F.makeRouter({});
  assert.equal(router.plan(F.req({ modelPreference: { prefer: ["openrouter"] } })).eligible[0].key, F.OPENROUTER);
  assert.equal(router.plan(F.req({ modelPreference: { exclude: ["gemini"] } })).eligible[0].key, F.GROQ);
});

test("invalid router requests return a FAILED result (no throw, no provider call)", async () => {
  const { router, fetchImpl } = F.makeRouter();
  for (const bad of [null, { taskType: "nope", prompt: "x" }, { taskType: "writing", prompt: "" }, F.req({ employee: "ghost" }),
    F.req({ generation: { model: "gpt-4o" } }), F.req({ output: { maxTokens: 0 } })]) {
    const r = await router.route(bad);
    assert.equal(r.status, "FAILED");
    assert.equal(r.error.category, "INVALID_ROUTER_REQUEST");
    assert.equal(r.error.retryable, false);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test("retryContext.notBefore defers without calling any provider", async () => {
  const { router, fetchImpl, now } = F.makeRouter({ handlers: { gemini: F.geminiOk() } });
  const r = await router.route(F.req({ retryContext: { attempt: 2, notBefore: now() + 5000 } }));
  assert.equal(r.status, "WAITING");
  assert.equal(r.retry.retryAfterMs, 5000);
  assert.equal(fetchImpl.calls.length, 0);
});

test("router never touches the article limiter state", async () => {
  const store = new LocalStateStore();
  const { router } = F.makeRouter({ stateStore: store, handlers: { gemini: F.geminiOk() } });
  await router.route(F.req());
  assert.ok(!store.listFiles().includes("article-timestamps.json"));
  assert.ok(!/require\(["'][^"']*limiter["']\)/.test(require("fs").readFileSync(require("path").join(__dirname, "../router.js"), "utf8")));
});

test("two workers sharing state: usage reservation survives write conflicts", async () => {
  const a = new LocalStateStore();
  const b = a.sibling();
  const reg = F.makeRegistry({ [F.GEMINI]: { limits: { rpm: 2 } } }, [F.GEMINI]);
  const clock = F.makeClock();
  const w1 = F.makeRouter({ registry: reg, stateStore: a, now: clock, handlers: { gemini: F.geminiOk() } });
  const w2 = F.makeRouter({ registry: reg, stateStore: b, now: clock, handlers: { gemini: F.geminiOk() } });
  const results = await Promise.all([w1.router.route(F.req()), w2.router.route(F.req()), w1.router.route(F.req()), w2.router.route(F.req())]);
  assert.equal(results.filter((r) => r.ok).length, 2);                     // limit of 2/min honoured across workers
  assert.equal(results.filter((r) => r.status === "WAITING").length, 2);
});

test("state-store failure degrades to in-process state instead of failing the request", async () => {
  const broken = { refresh() { throw new Error("git unavailable"); }, read() { throw new Error("git unavailable"); }, writeAtomic() { throw new Error("git unavailable"); } };
  const { router } = F.makeRouter({ stateStore: broken, handlers: { gemini: F.geminiOk() } });
  const r = await router.route(F.req());
  assert.equal(r.ok, true);
  assert.equal(router.state.degraded, true);
});

test("clearDisabled lifts a permanent block after a human fixes the credential", async () => {
  const { router, fetchImpl } = F.makeRouter({ registry: F.makeRegistry({}, [F.GROQ]), handlers: { groq: [F.json(401, { error: { message: "bad" } }), F.groqOk("fixed")] } });
  assert.equal((await router.route(F.req())).status, "FAILED");
  assert.equal((await router.route(F.req())).status, "FAILED");
  assert.equal(fetchImpl.calls.length, 1);
  router.clearDisabled("groq");
  const r = await router.route(F.req());
  assert.equal(r.content, "fixed");
});
