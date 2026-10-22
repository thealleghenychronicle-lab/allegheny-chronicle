// Phase 3 / Step 3 — Cloudflare Workers AI (@cf/zai-org/glm-4.7-flash) as the third free provider.
// Production allowlist/registry, scripted (mocked) HTTP, FAKE credentials. No real network, no real keys, no live calls.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../config");
const F = require("./helpers/router-fixtures");
const quota = require("../ai/quota");
const { createModelRegistry, ModelNotApprovedError } = require("../ai/registry");
const { createProviderAdapters } = require("../providers");
const { createRequest } = require("../ai/request");
const { prompts } = require("../execution/prompts");
const { buildHarness } = require("../execution/harness");
const limiter = require("../limiter");
const { LocalStateStore } = require("../local-state-store");
const { findCredentials } = require("../ai/credential-guard");

const CF_KEY = "cloudflare:@cf/zai-org/glm-4.7-flash";
const CF_MODEL = "@cf/zai-org/glm-4.7-flash";
const CF_URL = `https://api.cloudflare.com/client/v4/accounts/${F.CF_ACCOUNT}/ai/run/${CF_MODEL}`;
const NR_TOKEN = "NR-FAKE-newsroom-token-DO-NOT-LEAK-0004";
const ENV = { ...F.FAKE_KEYS, ...F.CF_ENV, NEWSROOM_API_TOKEN: NR_TOKEN };
const CF_ONLY_ENV = { ...F.CF_ENV, NEWSROOM_API_TOKEN: NR_TOKEN };
const SECRETS = [F.CF_TOKEN, F.CF_ACCOUNT, NR_TOKEN, ...Object.values(F.FAKE_KEYS)];
const HOUR = 3600 * 1000;

const registryWith = (overrides = config.MODEL_OVERRIDES) => createModelRegistry({ allowedFreeModels: config.ALLOWED_FREE_MODELS, overrides });
const prod = (opts = {}) => F.makeRouter({ registry: registryWith(), env: ENV, ...opts });
const cfOnly = (opts = {}) => F.makeRouter({ registry: registryWith(), env: CF_ONLY_ENV, ...opts });
const noSecrets = (label, value) => {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  for (const k of SECRETS) assert.ok(!s.includes(k), `${label} leaked a credential`);
};
const keyOf = (c) => c.provider === "gemini" ? `gemini:${decodeURIComponent(new URL(c.url).pathname.split("/models/")[1].split(":generateContent")[0])}`
  : c.provider === "cloudflare" ? `cloudflare:${decodeURIComponent(new URL(c.url).pathname.split("/ai/run/")[1])}` : `${c.provider}:${c.body.model}`;
const g429 = F.json(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } });
const o429 = F.json(429, { error: { code: 429, message: "Rate limit exceeded" } });
const cfErr = (status, code, message, headers = {}) => F.json(status, { result: null, success: false, errors: [{ code, message }], messages: [] }, headers);
const cfSnap = (r) => r.quota.evaluated.find((q) => q.key === CF_KEY);

// ---------------------------------------------------------------- 1. request, authentication, model id, response parsing
test("Cloudflare request: documented REST endpoint, Bearer auth in the header only, exact model id, messages + max_tokens; response parsed", async () => {
  const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: F.cloudflareOk("Cloudflare draft text.", { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }) } });
  const r = await router.route(F.req({ system: "You are a reporter.", prompt: "Summarize the lease.", output: { maxTokens: 800 }, generation: { temperature: 0.2 } }));
  assert.equal(r.ok, true);
  assert.equal(r.provider, "cloudflare");
  assert.equal(r.model, CF_MODEL);
  assert.equal(r.servedModel, CF_MODEL);
  assert.equal(r.content, "Cloudflare draft text.");
  assert.deepEqual(r.usage, { inputTokens: 50, outputTokens: 20, totalTokens: 70 });
  assert.equal(fetchImpl.calls.length, 1);
  const c = fetchImpl.calls[0];
  assert.equal(c.url, CF_URL);
  assert.equal(c.headers.Authorization, `Bearer ${F.CF_TOKEN}`);
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.deepEqual(c.body, { messages: [{ role: "system", content: "You are a reporter." }, { role: "user", content: "Summarize the lease." }], max_tokens: 800, stream: false, temperature: 0.2 });
  assert.ok(!c.url.includes(F.CF_TOKEN) && !JSON.stringify(c.body).includes(F.CF_TOKEN), "token only in the Authorization header");
  assert.ok(!("model" in c.body), "model id is in the path only");
});

test("Cloudflare response shapes: /ai/run envelope, top-level OpenAI shape and legacy result.response are all parsed; reasoning-only output is not a success", () => {
  const reg = registryWith();
  const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env: ENV, fetchImpl: F.makeFetch({}) }).cloudflare;
  const wrapped = a.parseSuccess({ success: true, result: { model: CF_MODEL, choices: [{ message: { content: "A" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } });
  assert.equal(wrapped.content, "A");
  assert.equal(wrapped.finishReason, "stop");
  assert.equal(a.parseSuccess({ choices: [{ message: { content: "B" }, finish_reason: "length" }] }).content, "B");
  assert.equal(a.parseSuccess({ success: true, result: { response: "C" } }).content, "C");
  assert.equal(a.parseSuccess({ success: true, result: { choices: [{ message: { content: null, reasoning_content: "thinking..." } }] } }).failure.category, "MALFORMED_RESPONSE");
});

// ---------------------------------------------------------------- 2. missing credentials / not confirmed free plan
test("missing or unconfirmed Cloudflare configuration: skipped by the router (no request) and refused with a safe CONFIGURATION error when called directly", async () => {
  const cases = {
    "no token": { CLOUDFLARE_ACCOUNT_ID: F.CF_ACCOUNT, CLOUDFLARE_FREE_PLAN_CONFIRMED: "true" },
    "no account id": { CLOUDFLARE_API_TOKEN: F.CF_TOKEN, CLOUDFLARE_FREE_PLAN_CONFIRMED: "true" },
    "malformed account id": { ...F.CF_ENV, CLOUDFLARE_ACCOUNT_ID: "../../evil?x=1" },
    "free plan not confirmed": { CLOUDFLARE_API_TOKEN: F.CF_TOKEN, CLOUDFLARE_ACCOUNT_ID: F.CF_ACCOUNT },
    "free plan flag not exactly true": { ...F.CF_ENV, CLOUDFLARE_FREE_PLAN_CONFIRMED: "yes" },
    "blank token": { ...F.CF_ENV, CLOUDFLARE_API_TOKEN: "   " }
  };
  for (const [name, env] of Object.entries(cases)) {
    const { router, fetchImpl } = F.makeRouter({ registry: registryWith(), env, handlers: { cloudflare: F.cloudflareOk() } });
    const r = await router.route(F.req());
    assert.equal(r.ok, false, name);
    assert.equal(fetchImpl.calls.length, 0, name);
    assert.ok(r.routing.rejected.some((x) => x.key === CF_KEY && x.code === "MISSING_CREDENTIALS"), name);

    const reg = registryWith();
    const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env, fetchImpl: F.makeFetch({}) }).cloudflare;
    const direct = await a.call(createRequest({ taskType: "writing", prompt: "hi" }), CF_MODEL);
    assert.equal(direct.ok, false, name);
    assert.equal(direct.error.category, "CONFIGURATION", name);
    assert.equal(direct.error.retryable, false);
    noSecrets(name, direct);
  }
});

// ---------------------------------------------------------------- 3. redaction
test("Cloudflare token, account id and NEWSROOM_API_TOKEN never appear in results, logs or errors, even if the provider echoes them", async () => {
  const echo = F.json(401, { success: false, errors: [{ code: 10000, message: `Authentication error: token ${F.CF_TOKEN} for account ${F.CF_ACCOUNT} (Authorization: Bearer ${F.CF_TOKEN}) ${NR_TOKEN}` }] });
  const { router, logLines, fetchImpl } = cfOnly({ handlers: { cloudflare: echo } });
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 1);
  noSecrets("result", r); noSecrets("logs", logLines);
  assert.ok(logLines.length > 0);

  // model output that echoes a secret is scrubbed
  const leaky = cfOnly({ handlers: { cloudflare: F.cloudflareOk(`Here you go: ${F.CF_TOKEN} and ${NR_TOKEN}`) } });
  const ok = await leaky.router.route(F.req());
  assert.equal(ok.ok, true);
  noSecrets("scrubbed output", ok);
  assert.match(ok.content, /\[REDACTED\]/);

  // network errors that mention the token / account are redacted too
  const net = cfOnly({ handlers: { cloudflare: new Error(`socket hang up ${F.CF_TOKEN} ${F.CF_ACCOUNT}`) } });
  noSecrets("network error", await net.router.route(F.req()));
  noSecrets("network error logs", net.logLines);
});

test("credential guard covers the Cloudflare token (exact value and CLOUDFLARE_API_TOKEN=... assignments) but never ordinary news text", async () => {
  for (const bad of [`use ${F.CF_TOKEN} please`, `CLOUDFLARE_API_TOKEN=abcdef123456`, `cloudflare_api_token: "Zx9-abcdef123456"`, `account ${F.CF_ACCOUNT}`, `NEWSROOM_API_TOKEN=${NR_TOKEN}`]) {
    const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: F.cloudflareOk() } });
    const r = await router.route(F.req({ prompt: `Summarize. ${bad}` }));
    assert.equal(r.ok, false, bad);
    assert.match(r.error.message, /credentials/);
    assert.equal(fetchImpl.calls.length, 0);
    noSecrets("guard", r);
  }
  const news = "Draft a 600-word Pittsburgh business story from this press release excerpt: \"Cloudflare will hire 40 engineers in the Strip District,\" said spokesperson Jane Roe. API token fees at the Port Authority rose 3%.";
  assert.deepEqual(findCredentials(news, SECRETS), []);
  const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: F.cloudflareOk("ok") } });
  assert.equal((await router.route(F.req({ prompt: news }))).ok, true);
  assert.equal(fetchImpl.calls[0].body.messages.at(-1).content, news, "ordinary content is sent byte-for-byte");
});

// ---------------------------------------------------------------- 4. failures: timeout, malformed, auth, rate limit, exhausted allocation
test("timeouts and network errors are retryable PROVIDER_UNAVAILABLE (no crash, no leak)", async () => {
  const hang = async (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const reg = registryWith();
  const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env: ENV, fetchImpl: hang, timeoutMs: 20 }).cloudflare;
  const t = await a.call(createRequest({ taskType: "writing", prompt: "hi" }), CF_MODEL);
  assert.equal(t.ok, false);
  assert.equal(t.error.category, "PROVIDER_UNAVAILABLE");
  assert.equal(t.error.retryable, true);
  assert.match(t.error.message, /timed out/);
});

test("malformed Cloudflare responses are MALFORMED_RESPONSE: HTML, empty choices, null content, success:false without a known reason", async () => {
  const bodies = {
    html: new Response("<html>gateway</html>", { status: 200 }),
    emptyChoices: F.json(200, { success: true, result: { choices: [] } }),
    nullContent: F.json(200, { success: true, result: { choices: [{ message: { content: null } }] } }),
    emptyObject: F.json(200, {})
  };
  for (const [name, res] of Object.entries(bodies)) {
    const { router, logLines } = cfOnly({ handlers: { cloudflare: res } });
    const r = await router.route(F.req());
    assert.equal(r.ok, false, name);
    assert.equal(r.status, "WAITING", name);
    assert.equal(r.routing.attempts[0].category, "MALFORMED_RESPONSE", name);
    noSecrets(name, r); noSecrets(name, logLines);
  }
  const unknown = cfOnly({ handlers: { cloudflare: F.json(200, { success: false, errors: [{ code: 7000, message: "something odd" }] }) } });
  const u = await unknown.router.route(F.req());
  assert.equal(u.ok, false);
  assert.equal(u.status, "WAITING");
});

test("authentication failures disable Cloudflare (no retry loop); the block lifts only through clearDisabled", async () => {
  for (const res of [cfErr(401, 10000, "Authentication error"), cfErr(403, 10000, "Authentication error")]) {
    const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: res } });
    const r = await router.route(F.req());
    assert.equal(r.status, "FAILED");
    assert.equal(r.routing.attempts[0].category, "AUTHENTICATION");
    assert.equal(r.routing.attempts[0].retryable, false);
    await router.route(F.req());
    assert.equal(fetchImpl.calls.length, 1, "no further calls until a human clears the block");
    router.clearDisabled("cloudflare");
    assert.equal((await router.route(F.req())).status, "FAILED");
    assert.equal(fetchImpl.calls.length, 2);
  }
});

test("a paid-plan-only response (403 / code 5035) is PAYMENT_REQUIRED: model disabled permanently, never retried", async () => {
  const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: cfErr(403, 5035, "This model requires the Workers Paid plan. Please upgrade.") } });
  const r = await router.route(F.req());
  assert.equal(r.status, "FAILED");
  assert.equal(r.routing.attempts[0].category, "PAYMENT_REQUIRED");
  await router.route(F.req());
  assert.equal(fetchImpl.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(r), /upgrade now|purchase|add credits/i);
});

test("HTTP 429 rate limit honours retry-after and then recovers", async () => {
  const { router, fetchImpl, now } = cfOnly({ handlers: { cloudflare: [cfErr(429, 3040, "Too many requests", { "retry-after": "45" }), F.cloudflareOk("back")] } });
  const w = await router.route(F.req());
  assert.equal(w.status, "WAITING");
  assert.ok(Math.abs(w.retry.retryAfterMs - 45000) < 1500, `retryAfterMs=${w.retry.retryAfterMs}`);
  assert.equal((await router.route(F.req())).status, "WAITING");
  assert.equal(fetchImpl.calls.length, 1);
  now.advance(46000);
  const ok = await router.route(F.req());
  assert.equal(ok.ok, true);
  assert.equal(ok.content, "back");
});

test("Cloudflare's own 'daily free allocation used' error (HTTP error or inside a 200) blocks the model until 00:00 UTC; no further calls, no upgrade attempt", async () => {
  const msg = "you have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.";
  for (const res of [cfErr(429, 4006, msg), cfErr(400, 4006, msg), F.json(200, { success: false, errors: [{ code: 4006, message: msg }] })]) {
    const { router, fetchImpl, now } = cfOnly({ handlers: { cloudflare: [res, F.cloudflareOk("after reset")] } });
    now.advance(5 * HOUR);                                     // 2026-01-01T05:00Z
    const w = await router.route(F.req());
    assert.equal(w.status, "WAITING");
    assert.equal(w.routing.attempts[0].category, "QUOTA_DAILY");
    assert.equal(w.retry.retryAt, "2026-01-02T00:00:00.000Z", "waits for the documented 00:00 UTC reset");
    assert.equal(cfSnap(w).state, "DAILY_LIMIT_REACHED");
    noSecrets("exhausted", w);
    for (let i = 0; i < 3; i++) assert.equal((await router.route(F.req())).status, "WAITING");
    assert.equal(fetchImpl.calls.length, 1, "zero calls while blocked");
    now.advance(19 * HOUR + 1000);                             // just past 00:00 UTC
    const ok = await router.route(F.req());
    assert.equal(ok.content, "after reset");
  }
});

// ---------------------------------------------------------------- 5. fallback order, no paid fallback
test("fallback order is Gemini -> OpenRouter :free -> Cloudflare; Groq and any paid/unapproved model are never called", async () => {
  const env = { ...ENV, GROQ_API_KEY: F.FAKE_KEYS.GROQ_API_KEY };
  const { router, fetchImpl } = prod({ env, handlers: { gemini: g429, openrouter: o429, groq: F.groqOk("no!"), cloudflare: F.cloudflareOk("from cloudflare") } });
  const r = await router.route(F.req());
  assert.equal(r.ok, true);
  assert.equal(r.provider, "cloudflare");
  assert.deepEqual(fetchImpl.calls.map(keyOf), [
    "gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite",
    "openrouter:apodex/apodex-1.1-mini:free", "openrouter:inclusionai/ling-3.0-flash-sante:free",
    CF_KEY
  ]);
  assert.equal(fetchImpl.callsTo("groq").length, 0);
  for (const k of fetchImpl.calls.map(keyOf)) assert.ok(config.ALLOWED_FREE_MODELS.includes(k), k);
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("openrouter.ai") && /(^openrouter\/)|:nitro|:online/.test(c.body.model)), "no router / variant model ids");
});

test("Cloudflare is only used when earlier approved providers are unavailable or skipped", async () => {
  const first = prod({ handlers: { gemini: F.geminiOk("gemini wins"), openrouter: F.openrouterOk(), cloudflare: F.cloudflareOk() } });
  assert.equal((await first.router.route(F.req())).provider, "gemini");
  assert.equal(first.fetchImpl.callsTo("cloudflare").length, 0);

  const second = prod({ handlers: { gemini: g429, openrouter: F.openrouterOk("or wins"), cloudflare: F.cloudflareOk() } });
  assert.equal((await second.router.route(F.req())).provider, "openrouter");
  assert.equal(second.fetchImpl.callsTo("cloudflare").length, 0);

  // Gemini and OpenRouter keys absent -> Cloudflare serves directly
  const third = cfOnly({ handlers: { cloudflare: F.cloudflareOk("cf alone") } });
  const r = await third.router.route(F.req());
  assert.equal(r.provider, "cloudflare");
  assert.deepEqual(third.fetchImpl.calls.map(keyOf), [CF_KEY]);
});

test("a caller preference cannot reach a paid Cloudflare model, Groq, or anything off the allowlist (strict or not)", async () => {
  const bad = ["cloudflare:@cf/zai-org/glm-5.2", "cloudflare:@cf/zai-org/glm-5.3-flash", "cloudflare:@cf/moonshotai/kimi-k2.6", "cloudflare:@cf/meta/llama-3.1-8b-instruct",
    "cloudflare:@cf/../etc/passwd", "groq:openai/gpt-oss-20b", "groq"];
  const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: F.cloudflareOk() } });
  const strict = await router.route(F.req({ modelPreference: { prefer: bad, strict: true } }));
  assert.equal(strict.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
  const loose = await router.route(F.req({ modelPreference: { prefer: bad } }));
  assert.equal(loose.ok, true);
  assert.deepEqual(fetchImpl.calls.map(keyOf), [CF_KEY], "only the approved model was used");
});

// ---------------------------------------------------------------- 6. waiting when every free provider is unavailable
test("when Gemini, OpenRouter and Cloudflare are all unavailable the router WAITS with a retry time (no paid fallback, no extra calls)", async () => {
  const { router, fetchImpl, now } = prod({ handlers: { gemini: g429, openrouter: o429, cloudflare: cfErr(429, 3040, "Too many requests", { "retry-after": "120" }) } });
  const r = await router.route(F.req());
  assert.equal(r.status, "WAITING");
  assert.equal(r.error.category, "ALL_OPTIONS_TEMPORARILY_UNAVAILABLE");
  assert.ok(r.retry.retryable && r.retry.retryAt && r.retry.retryAfterMs > 0);
  const n = fetchImpl.calls.length;
  assert.equal(n, 5);
  for (let i = 0; i < 4; i++) assert.equal((await router.route(F.req())).status, "WAITING");
  assert.equal(fetchImpl.calls.length, n);
  for (const k of fetchImpl.calls.map(keyOf)) assert.ok(config.ALLOWED_FREE_MODELS.includes(k), k);
  now.advance(3 * HOUR);
  await router.route(F.req());
  assert.ok(fetchImpl.calls.length > n);
});

test("workflow bridge: an exhausted Cloudflare budget parks the job in WAITING_FOR_AI with the router's retry time", async () => {
  const h = buildHarness();
  const id = h.queue.enqueue({ title: "Pittsburgh Brewery Expands", category: "general" }).job.id;
  await h.runner.step({ jobId: id });                                      // scout (mock)
  const big = F.cloudflareOk('{"newsworthy":true,"reason":"cf path"}', { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 });
  const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: big }, now: h.now,
    registry: registryWith(config.resolveModelOverrides({ NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET: "100" })) });
  h.runner.ai = router;
  const s = await h.runner.step({ jobId: id });                            // director via real router + Cloudflare
  assert.equal(s.employee, "maysam"); assert.equal(s.outcome, "completed");
  assert.equal(h.queue.get(id).data.news_director.reason, "cf path");
  const w = await h.runner.step({ jobId: id });                            // research editor: budget exhausted
  assert.equal(w.outcome, "waiting"); assert.equal(w.kind, "ai");
  const j = h.queue.get(id);
  assert.equal(j.state, "WAITING_FOR_AI");
  assert.ok(Date.parse(j.wait.resumeAt) > h.now());
  assert.equal(j.attempts.failures, 0, "waiting is not a failure");
  assert.equal(fetchImpl.calls.length, 1, "the exhausted budget stopped the second call");
});

// ---------------------------------------------------------------- 7. unknown / unapproved models
test("unknown, paid-only and malformed Cloudflare models are rejected before any request is sent", async () => {
  const fetchImpl = F.makeFetch({ cloudflare: F.cloudflareOk() });
  const reg = registryWith();
  const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env: ENV, fetchImpl }).cloudflare;
  const req = createRequest({ taskType: "writing", prompt: "hello" });
  for (const m of ["@cf/zai-org/glm-5.2", "@cf/zai-org/glm-5.3", "@cf/zai-org/glm-5.3-flash", "@cf/moonshotai/kimi-k2.6", "@cf/deepseek-ai/deepseek-v4-pro-0813",
    "@cf/meta/llama-3.1-8b-instruct", "@cf/zai-org/glm-4.7-flash-fp8", "glm-4.7-flash", "@cf/zai-org/glm-4.7-flash/../x", ""]) {
    await assert.rejects(() => a.call(req, m), ModelNotApprovedError, m);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test("registry rules: Cloudflare paid-only models and unsafe ids can never be registered, even if put on the allowlist by mistake", () => {
  const issues = (key) => createModelRegistry({ allowedFreeModels: [key] }).issues.map((i) => i.code);
  assert.deepEqual(issues("cloudflare:@cf/zai-org/glm-5.2"), ["CLOUDFLARE_MODEL_REQUIRES_PAID_PLAN"]);
  assert.deepEqual(issues("cloudflare:@cf/moonshotai/kimi-k2.7-code"), ["CLOUDFLARE_MODEL_REQUIRES_PAID_PLAN"]);
  assert.deepEqual(issues("cloudflare:@cf/zai-org/../glm"), ["UNSAFE_MODEL_ID"]);
  assert.deepEqual(issues("cloudflare:zai-org/glm-4.7-flash"), ["UNSAFE_MODEL_ID"]);
  assert.deepEqual(issues("cloudflare:@cf/a/b?x=1"), ["UNSAFE_MODEL_ID"]);
  assert.deepEqual(issues(CF_KEY), []);
  // other providers still reject a leading "@"
  assert.deepEqual(issues("gemini:@cf/zai-org/glm-4.7-flash"), ["UNSAFE_MODEL_ID"]);
});

// ---------------------------------------------------------------- 8. local free-usage safety budget
test("local Neuron budget: documented per-token rates, UTC-day window, worst-case reservation, true-up from reported usage, labelled as an estimate", async () => {
  const entry = registryWith().get(CF_KEY);
  assert.equal(entry.budget.dailyNeurons, 5000, "default is half of the documented 10,000/day Free allowance");
  assert.equal(entry.budget.documentedFreeDailyNeurons, 10000);
  assert.equal(entry.budget.inputNeuronsPerMillionTokens, 5500);
  assert.equal(entry.budget.outputNeuronsPerMillionTokens, 36400);
  assert.equal(quota.neuronCost(entry.budget, 1000000, 0), 5500);
  assert.equal(quota.neuronCost(entry.budget, 0, 1000000), 36400);

  const { router } = cfOnly({ handlers: { cloudflare: F.cloudflareOk("x", { prompt_tokens: 100000, completion_tokens: 10000, total_tokens: 110000 }) } });
  const r = await router.route(F.req({ output: { maxTokens: 4000 } }));
  assert.equal(r.ok, true);
  const b = cfSnap(r).budget;
  assert.equal(b.kind, "LOCAL_ESTIMATE");
  assert.equal(b.authoritative, false);
  assert.equal(b.unit, "neurons");
  assert.equal(b.dailyBudget, 5000);
  assert.equal(b.usedEstimate, quota.neuronCost(entry.budget, 100000, 10000), "reservation trued-up to the reported usage (550 + 364 = 914)");
  assert.equal(b.usedEstimate, 914);
  assert.equal(b.resetsAt, "2026-01-02T00:00:00.000Z");
});

test("the budget stops Cloudflare BEFORE the safety limit is crossed, waits until 00:00 UTC, and resets on the new UTC day", async () => {
  const ov = config.resolveModelOverrides({ NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET: "100" });
  const heavy = F.cloudflareOk("heavy", { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 });   // 5.5 + 72.8 -> 79 neurons
  const { router, fetchImpl, now } = cfOnly({ registry: registryWith(ov), handlers: { cloudflare: heavy } });
  now.advance(2 * HOUR);
  assert.equal((await router.route(F.req())).ok, true);                  // used 79
  const w = await router.route(F.req());                                  // 79 + 38 (worst case for a default request) > 100
  assert.equal(w.status, "WAITING");
  assert.ok(w.routing.rejected.some((x) => x.key === CF_KEY && x.code === "NEURON_BUDGET_EXHAUSTED" && !x.permanent));
  assert.equal(w.retry.retryAt, "2026-01-02T00:00:00.000Z");
  assert.equal(fetchImpl.calls.length, 1, "the second request was never sent");
  assert.equal(cfSnap(w).budget.usedEstimate, 79);
  now.advance(22 * HOUR + 1000);                                         // past 00:00 UTC
  const ok = await router.route(F.req());
  assert.equal(ok.ok, true, "budget resets with the UTC day");
  assert.equal(fetchImpl.calls.length, 2);
});

test("failed or timed-out calls keep their worst-case reservation (never refunded); missing usage keeps it too", async () => {
  const net = cfOnly({ handlers: { cloudflare: new Error("socket hang up") } });
  const r = await net.router.route(F.req());
  assert.ok(cfSnap(r).budget.usedEstimate >= 38, `usedEstimate=${cfSnap(r).budget.usedEstimate}`);
  const before = cfSnap(r).budget.usedEstimate;
  net.now.advance(10 * 60 * 1000);
  const r2 = await net.router.route(F.req());
  assert.ok(cfSnap(r2).budget.usedEstimate >= before, "never decreases within the UTC day");

  const noUsage = cfOnly({ handlers: { cloudflare: F.json(200, { success: true, result: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } }) } });
  const ok = await noUsage.router.route(F.req());
  assert.equal(ok.ok, true);
  assert.equal(cfSnap(ok).budget.usedEstimate, 38, "unknown usage -> worst-case reservation stays (ceil((5*5500 + 1024*36400)/1e6))");
});

test("a request that alone exceeds the local budget is refused permanently with zero calls; other providers are unaffected", async () => {
  const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: F.cloudflareOk() } });
  const r = await router.route(F.req({ output: { maxTokens: 200000 } }));      // 7,280 neurons > 5,000
  assert.equal(r.status, "FAILED");
  assert.ok(r.routing.rejected.some((x) => x.key === CF_KEY && x.code === "REQUEST_EXCEEDS_NEURON_BUDGET" && x.permanent));
  assert.equal(fetchImpl.calls.length, 0);
});

test("the budget is configurable only DOWNWARD from the shipped default and from a clean integer; the registry still enforces the documented ceiling", () => {
  const budgetOf = (env) => config.resolveModelOverrides(env)[CF_KEY].budget.dailyNeurons;
  assert.equal(budgetOf({}), 5000);
  assert.equal(budgetOf({ NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET: "1200" }), 1200);
  for (const bad of ["99999", "10000", "5000", "0", "-5", "abc", "1e9", "", " ", "12.5"]) assert.equal(budgetOf({ NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET: bad }), 5000, `"${bad}" must be ignored`);
  assert.equal(config.MODEL_OVERRIDES[CF_KEY].budget.dailyNeurons, 5000);
  const ev = require("../ai/free-models");
  const rec = ev.FREE_MODEL_EVIDENCE.find((r) => r.key === CF_KEY);
  assert.ok(ev.validateEvidence([{ ...rec, neuronBudget: { ...rec.neuronBudget, dailyNeurons: 10001 } }]).length, "budget above the documented allowance is invalid evidence");
  assert.ok(ev.validateEvidence([{ ...rec, neuronBudget: null }]).length, "a Cloudflare record without a budget is invalid evidence");
  assert.ok(ev.validateEvidence([{ ...rec, maxOutputTokensUnpublished: false }]).length, "null maxOutputTokens needs the explicit 'unpublished' flag");
});

test("evidence record: dated, sourced, honest about what was NOT verified; Groq is disabled", () => {
  const ev = require("../ai/free-models");
  const rec = ev.FREE_MODEL_EVIDENCE.find((r) => r.key === CF_KEY);
  assert.equal(rec.status, "VERIFIED_FREE");
  assert.equal(rec.verifiedAt, "2026-10-10");
  assert.equal(rec.priority, 50);
  assert.ok(rec.sources.some((s) => s.includes("workers-ai/platform/pricing")) && rec.sources.some((s) => s.includes("workers-ai/models")));
  assert.match(rec.accountPrecondition, /NOT been verified/);
  assert.match(rec.uncertainty.join(" "), /Account-specific access was NOT verified/);
  const groq = ev.FREE_MODEL_EVIDENCE.filter((r) => r.provider === "groq");
  assert.ok(groq.length >= 1 && groq.every((r) => r.status !== "VERIFIED_FREE"));
  assert.ok(!config.ALLOWED_FREE_MODELS.some((k) => k.startsWith("groq:")));
  const order = [...config.ALLOWED_FREE_MODELS].map((k) => k.split(":")[0]);
  assert.deepEqual(order, ["gemini", "gemini", "openrouter", "openrouter", "cloudflare"]);
});

// ---------------------------------------------------------------- 9. newsroom purpose: source review rule
test("source-review prompts require evidence vs unsupported separation and state that AI review is not proof of accuracy", () => {
  const sources = [{ title: "Press release", url: "https://example.com/pr", publisher: "Acme" }];
  const p = prompts.review({ task: "Fact-check every checkable claim against the SOURCES. Flag anything unsupported.", job: { revision: { current: null } }, article: { title: "T", body: "Acme will hire 40 people." }, sources });
  assert.match(p, /EVIDENCE RULE/);
  assert.match(p, /only the SOURCES listed above count as supplied evidence/);
  assert.match(p, /unsupported/);
  assert.match(p, /not proof that the article is accurate/);
  assert.match(p, /\[1\] Press release \| https:\/\/example\.com\/pr/);
});

test("Cloudflare serves the newsroom's text-generation tasks through the provider-neutral interface (writing, summary, fact check, edit)", async () => {
  const { router, fetchImpl } = cfOnly({ handlers: { cloudflare: F.cloudflareOk("ok") } });
  for (const taskType of ["writing", "research_synthesis", "fact_check", "standards_review", "source_analysis", "story_evaluation"]) {
    const r = await router.route(F.req({ taskType, system: "You are an editor.", prompt: "Edit this headline and paragraph for Lubna's style.", output: { maxTokens: 500 } }));
    assert.equal(r.ok, true, taskType);
    assert.equal(r.provider, "cloudflare");
  }
  assert.equal(fetchImpl.calls.length, 6);
});

// ---------------------------------------------------------------- 10. preserved safeguards
test("Cloudflare calls, retries and waits never consume draft slots; 3 new drafts per rolling 24h and the HUMAN_REVIEW stop are unchanged", async () => {
  const store = new LocalStateStore();
  const now = F.makeClock();
  const { router } = cfOnly({ now, handlers: { cloudflare: [F.cloudflareOk(), cfErr(429, 4006, "daily free allocation of 10,000 neurons used")] } });
  for (let i = 0; i < 5; i++) await router.route(F.req());
  assert.equal(limiter.getWindowStatus(store, 3, now).activeInWindow, 0, "AI routing consumed no slot");
  assert.equal(config.MAX_ARTICLES_PER_ROLLING_24H, 3);
  const res = [1, 2, 3].map(() => limiter.reserveSlot(store, 3, now));
  assert.ok(res.every((x) => x.reserved === true));
  const fourth = limiter.reserveSlot(store, 3, now);
  assert.equal(fourth.reserved, false);
  assert.equal(fourth.reason, "LIMIT_REACHED");
  const r = await router.route(F.req());
  for (const k of Object.keys(r)) assert.ok(!/publish|approve|commit/i.test(k), k);
  const { TRANSITIONS, HUMAN_ONLY_TARGETS } = require("../workflow/constants");
  assert.ok(TRANSITIONS.HUMAN_REVIEW.every((t) => HUMAN_ONLY_TARGETS.includes(t)), "every exit from HUMAN_REVIEW is human-only");
});

test("no test in this file used the network or a real credential", () => {
  for (const k of SECRETS) assert.ok(/FAKE|^0123456789abcdef/.test(k), "only fake credentials exist in tests");
  assert.ok(!process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN !== F.CF_TOKEN);
});
