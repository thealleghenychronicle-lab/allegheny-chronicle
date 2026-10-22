// Phase 3 / Step 2 — real Gemini / OpenRouter adapters wired through the central router (Groq was DISABLED in Step 3;
// the Groq adapter code remains but no Groq model is on the allowlist, so it can never be selected. Cloudflare: cloudflare.test.js).
// Everything uses the PRODUCTION allowlist/registry, scripted (mocked) HTTP and FAKE credentials.
// No real network, no real keys.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../config");
const F = require("./helpers/router-fixtures");
const { createModelRegistry, ModelNotApprovedError } = require("../ai/registry");
const { createRouter } = require("../router");
const { createLogger } = require("../ai/logger");
const { createProviderAdapters } = require("../providers");
const { createRequest } = require("../ai/request");
const { LocalStateStore } = require("../local-state-store");
const limiter = require("../limiter");
const { findCredentials } = require("../ai/credential-guard");

const ALLOWED = [...config.ALLOWED_FREE_MODELS];
const TOKEN = "NR-FAKE-newsroom-token-DO-NOT-LEAK-0004";
const ENV = { ...F.FAKE_KEYS, NEWSROOM_API_TOKEN: TOKEN };
const ALL_SECRETS = Object.values(ENV);
const prodRegistry = () => createModelRegistry({ allowedFreeModels: config.ALLOWED_FREE_MODELS, overrides: config.MODEL_OVERRIDES });
const prod = (opts = {}) => F.makeRouter({ registry: prodRegistry(), env: ENV, ...opts });
const modelOf = (c) => c.provider === "gemini" ? `gemini:${decodeURIComponent(new URL(c.url).pathname.split("/models/")[1].split(":generateContent")[0])}` : `${c.provider}:${c.body.model}`;
const calledKeys = (f) => f.calls.map(modelOf);
const noSecrets = (label, value) => {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  for (const k of ALL_SECRETS) assert.ok(!s.includes(k), `${label} leaked a credential`);
};
const g429 = F.json(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } });
const o429 = F.json(429, { error: { code: 429, message: "Rate limit exceeded: free-models-per-min" } });
const q429 = (extra = {}) => F.json(429, { error: { message: "Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000. Please try again in 20s.", type: "tokens", code: "rate_limit_exceeded" } }, { "retry-after": "20", ...extra });

// ---------------------------------------------------------------- 1. authenticated requests + normalized responses
test("each provider sends a correctly authenticated request to its documented endpoint and normalizes the response", async () => {
  const cases = [
    ["gemini", "gemini:gemini-3.8-flash", { gemini: F.geminiOk("G text") }, "G text", "x-goog-api-key", F.FAKE_KEYS.GEMINI_API_KEY, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:generateContent$/],
    ["openrouter", "openrouter:apodex/apodex-1.1-mini:free", { openrouter: F.openrouterOk("O text") }, "O text", "Authorization", `Bearer ${F.FAKE_KEYS.OPENROUTER_API_KEY}`, /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/]
  ];
  for (const [provider, key, handlers, text, header, value, urlRe] of cases) {
    const { router, fetchImpl } = prod({ handlers });
    const r = await router.route(F.req({ system: "You are a reporter.", modelPreference: { prefer: [key], strict: true } }));
    assert.equal(r.ok, true, provider);
    assert.equal(`${r.provider}:${r.model}`, key);
    assert.equal(r.content, text);
    assert.ok(r.usage && r.usage.totalTokens > 0, "usage normalized");
    assert.equal(fetchImpl.calls.length, 1);
    const c = fetchImpl.calls[0];
    assert.match(c.url, urlRe);
    assert.equal(c.headers[header], value);
    assert.ok(!c.url.includes("FAKE"), "key never in URL");
    assert.ok(!JSON.stringify(c.body).includes("FAKE"), "key never in body");
    assert.equal(c.headers["Content-Type"], "application/json");
  }
});

// ---------------------------------------------------------------- 2. credentials never leak
test("credentials never appear in results, logs or error messages — even when a provider echoes them back", async () => {
  const echo = (status, key) => F.json(status, { error: { message: `bad credential ${key} (Authorization: Bearer ${key})`, code: "invalid_api_key" } });
  const { router, logLines } = prod({ handlers: {
    gemini: echo(401, F.FAKE_KEYS.GEMINI_API_KEY), openrouter: echo(401, F.FAKE_KEYS.OPENROUTER_API_KEY) } });
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  noSecrets("result", r);
  noSecrets("logs", logLines);
  assert.ok(logLines.length > 0);

  const ok = prod({ handlers: { gemini: F.geminiOk("An ordinary article body.") } });
  const good = await ok.router.route(F.req());
  noSecrets("success result", good);
  noSecrets("success logs", ok.logLines);
});

test("credential guard: real secrets in a prompt are refused before any provider is contacted", async () => {
  const bad = [
    `Please use my key ${F.FAKE_KEYS.GEMINI_API_KEY} to help.`,
    `Token for the API: ${TOKEN}`,
    "Authorization: Bearer abcdef1234567890abcdef1234567890",
    "login with password: Hunter2-Hunter2",
    "api_key=sk-or-v1-abcdefghijklmnop1234",
    "-----BEGIN PRIVATE KEY-----\nMIIE..."
  ];
  for (const p of bad) {
    const { router, fetchImpl, logLines } = prod({ handlers: { gemini: F.geminiOk(), groq: F.groqOk(), openrouter: F.openrouterOk() } });
    const r = await router.route(F.req({ prompt: `Summarize. ${p}` }));
    assert.equal(r.ok, false, p);
    assert.equal(r.status, "FAILED");
    assert.match(r.error.message, /credentials/);
    assert.equal(fetchImpl.calls.length, 0, "nothing sent");
    noSecrets("guard result", r);
    noSecrets("guard logs", logLines);
  }
  // also refused if a caller puts it in `system`
  const { router, fetchImpl } = prod({ handlers: { gemini: F.geminiOk() } });
  assert.equal((await router.route(F.req({ system: `key=${F.FAKE_KEYS.GROQ_API_KEY}` }))).ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test("credential guard does NOT block ordinary news content (names, URLs, excerpts, drafts, editorial instructions)", async () => {
  const news = [
    "Write a 600-word story for The Allegheny Chronicle about PNC Financial Services Group and its Downtown Pittsburgh office lease, citing https://www.post-gazette.com/business/2026/10/01/pnc-lease/stories/202610010088.",
    "Press release excerpt: \"UPMC Heart and Vascular Institute will open in Lawrenceville in 2027,\" said spokesperson Jane Roe. The Allegheny County Controller's report (case no. 2026-CV-004512) lists a $4,250,000 contract.",
    "Fact-check this draft: Duolingo is leaving its East Liberty building. Editorial note: do not call the secret sauce at Primanti Bros. a trade secret; password managers startup 1Password is unrelated. The bearer of bad news was the county treasurer.",
    "Authorization for the stadium sponsorship was granted by the Sports & Exhibition Authority on Sept. 4; the token gesture of $1 per seat was criticized."
  ];
  for (const p of news) {
    assert.deepEqual(findCredentials(p, ALL_SECRETS), [], p);
    const { router, fetchImpl } = prod({ handlers: { gemini: F.geminiOk("ok") } });
    const r = await router.route(F.req({ prompt: p }));
    assert.equal(r.ok, true, p);
    assert.equal(fetchImpl.calls[0].body.contents[0].parts[0].text, p, "prompt is sent byte-for-byte, nothing redacted or rewritten");
  }
});

// ---------------------------------------------------------------- 3. missing key
test("a missing API key yields a safe, actionable configuration error and no request", async () => {
  const { router, fetchImpl } = prod({ env: {}, handlers: {} });
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
  const codes = r.routing.rejected.filter((x) => x.code === "MISSING_CREDENTIALS");
  assert.equal(codes.length, ALLOWED.length);
  for (const v of ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN"]) assert.ok(codes.some((c) => c.message.includes(v)), v);
  assert.match(r.error.message, /MISSING_CREDENTIALS/);

  // adapter used directly
  const reg = prodRegistry();
  const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env: {}, fetchImpl: F.makeFetch({}) });
  const direct = await a.gemini.call(createRequest({ taskType: "writing", prompt: "hi" }), "gemini-3.8-flash");
  assert.equal(direct.error.category, "CONFIGURATION");
  assert.match(direct.error.message, /GEMINI_API_KEY/);
});

// ---------------------------------------------------------------- 4. authentication errors
test("authentication errors disable that provider (no retry loop) and only approved free models are ever contacted", async () => {
  const { router, fetchImpl } = prod({ handlers: {
    gemini: F.json(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "API key not valid" } }),
    openrouter: F.json(401, { error: { code: 401, message: "No auth credentials found" } }) } });
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  assert.equal(r.status, "FAILED", "permanent: needs a human, not a retry");
  assert.ok(r.routing.attempts.every((a) => a.category === "AUTHENTICATION" && a.retryable === false));
  for (const k of calledKeys(fetchImpl)) assert.ok(ALLOWED.includes(k), k);
  // one attempt per provider: auth failure blocks the whole provider
  assert.equal(fetchImpl.calls.length, 2);
  const n = fetchImpl.calls.length;
  await router.route(F.req());
  assert.equal(fetchImpl.calls.length, n, "no further calls until a human clears the block");
});

// ---------------------------------------------------------------- 5. 429 / quota -> waiting
test("HTTP 429 updates quota state, honours provider reset information and waits instead of burning retries", async () => {
  const { router, fetchImpl, now } = prod({ handlers: { gemini: g429, openrouter: o429 } });
  const r = await router.route(F.req());
  assert.equal(r.status, "WAITING");
  assert.equal(r.error.category, "ALL_OPTIONS_TEMPORARILY_UNAVAILABLE");
  assert.ok(r.retry.retryAt && r.retry.retryAfterMs > 0);
  assert.ok(r.quota.evaluated.some((q) => q.key === "gemini:gemini-3.8-flash" && q.state !== "AVAILABLE"), "gemini state updated from the 429");
  const n = fetchImpl.calls.length;
  for (let i = 0; i < 5; i++) assert.equal((await router.route(F.req())).status, "WAITING");
  assert.equal(fetchImpl.calls.length, n, "zero calls while every model is blocked");
  now.advance(3 * 3600 * 1000);
  await router.route(F.req());
  assert.ok(fetchImpl.calls.length > n, "probes again only after reset time");
});

test("a provider retry-after header sets the block exactly; the model is skipped until then and chosen again afterwards", async () => {
  const { router, fetchImpl, now } = prod({ env: { OPENROUTER_API_KEY: F.FAKE_KEYS.OPENROUTER_API_KEY },
    handlers: { openrouter: [F.json(429, { error: { code: 429, message: "Rate limit exceeded" } }, { "retry-after": "90" }), F.json(429, { error: { code: 429, message: "Rate limit exceeded" } }, { "retry-after": "90" }), F.openrouterOk("back")] } });
  const w = await router.route(F.req());
  assert.equal(w.status, "WAITING");
  assert.ok(Math.abs(w.retry.retryAfterMs - 90000) < 1500, `retryAfterMs=${w.retry.retryAfterMs}`);
  assert.equal((await router.route(F.req())).status, "WAITING");
  assert.equal(fetchImpl.calls.length, 2, "both OpenRouter models probed once, then nothing while blocked");
  now.advance(91000);
  const ok = await router.route(F.req());
  assert.equal(ok.ok, true);
  assert.equal(ok.provider, "openrouter");
});

test("Groq is out of the chain: when Gemini is rate-limited the next call is OpenRouter, never Groq", async () => {
  const { router, fetchImpl } = prod({ env: { ...ENV, GROQ_API_KEY: F.FAKE_KEYS.GROQ_API_KEY }, handlers: { gemini: g429, groq: F.groqOk("from groq"), openrouter: F.openrouterOk("from or") } });
  const r = await router.route(F.req());
  assert.equal(r.ok, true);
  assert.equal(r.provider, "openrouter");
  assert.deepEqual(calledKeys(fetchImpl), ["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite", "openrouter:apodex/apodex-1.1-mini:free"]);
  assert.equal(fetchImpl.callsTo("groq").length, 0);
});

// ---------------------------------------------------------------- 6. 402 / billing never escalates
test("402 / billing / payment-restricted responses never trigger a paid model", async () => {
  const { router, fetchImpl } = prod({ handlers: {
    gemini: F.json(400, { error: { code: 400, status: "FAILED_PRECONDITION", message: "Billing required: free tier is not available in your region" } }),
    openrouter: F.json(402, { error: { code: 402, message: "Insufficient credits" } }) } });
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  for (const k of calledKeys(fetchImpl)) assert.ok(ALLOWED.includes(k), `${k} must be approved`);
  assert.ok(fetchImpl.calls.every((c) => ["gemini", "openrouter"].includes(c.provider)));
  assert.ok(r.routing.attempts.every((a) => a.retryable === false), "billing problems are permanent, not retried");
  const n = fetchImpl.calls.length;
  await router.route(F.req());
  assert.equal(fetchImpl.calls.length, n);
  assert.doesNotMatch(JSON.stringify(r), /upgrade|purchase|add credits/i);
});

// ---------------------------------------------------------------- 7. model gating before any request
test("unknown, retired, unverified and paid models are rejected before any request is sent", async () => {
  const bad = ["gemini:gemini-3.1-pro-preview", "gemini:gemini-2.0-flash", "gemini:gemini-3.6-flash", "groq:openai/gpt-oss-120b", "groq:llama-3.3-70b-versatile",
    "groq:totally-unknown", "openrouter:openrouter/free", "openrouter:openai/gpt-4o", "openrouter:inclusionai/ling-3.1-flash", "openai:gpt-4o", "gemini:../../etc"];
  const reg = prodRegistry();
  const fetchImpl = F.makeFetch({ gemini: F.geminiOk(), groq: F.groqOk(), openrouter: F.openrouterOk() });
  const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env: ENV, fetchImpl });
  const req = createRequest({ taskType: "writing", prompt: "hello" });
  for (const key of bad) {
    const i = key.indexOf(":");
    const adapter = a[key.slice(0, i)];
    if (!adapter) continue;
    await assert.rejects(() => adapter.call(req, key.slice(i + 1)), ModelNotApprovedError, key);
  }
  assert.equal(fetchImpl.calls.length, 0);
  // caller-supplied preference cannot add models either
  const { router, fetchImpl: f2 } = prod({ handlers: { gemini: F.geminiOk() } });
  const r = await router.route(F.req({ modelPreference: { prefer: bad, strict: true } }));
  assert.equal(r.ok, false);
  assert.equal(f2.calls.length, 0);
});

// ---------------------------------------------------------------- 8. OpenRouter free-only
test("OpenRouter requests use only approved :free ids and carry no fallback / routing fields", async () => {
  const { router, fetchImpl } = prod({ env: { OPENROUTER_API_KEY: F.FAKE_KEYS.OPENROUTER_API_KEY }, handlers: { openrouter: o429 } });
  await router.route(F.req());
  assert.ok(fetchImpl.calls.length >= 2);
  const orModels = config.ALLOWED_FREE_MODELS.filter((k) => k.startsWith("openrouter:")).map((k) => k.slice(11));
  for (const c of fetchImpl.calls) {
    assert.ok(orModels.includes(c.body.model), c.body.model);
    assert.match(c.body.model, /:free$/);
    assert.notEqual(c.body.model, "openrouter/free");
    for (const forbidden of ["models", "route", "provider", "fallbacks", "transforms", "plugins", "preset"]) assert.ok(!(forbidden in c.body), `body must not contain "${forbidden}"`);
    assert.deepEqual(Object.keys(c.body).sort(), ["max_tokens", "messages", "model"].sort());
  }
  assert.ok(!config.ALLOWED_FREE_MODELS.some((k) => /openrouter\/(free|auto)/.test(k)));
});

// ---------------------------------------------------------------- 9. ordinary news with Gemini
test("Gemini free tier handles an ordinary public-news writing request with no content filtering or rewriting", async () => {
  const prompt = "Using these public sources (Allegheny County property records, the Steelers' press release of Oct. 2, and a Post-Gazette excerpt), draft a 500-word business story about the stadium sponsorship deal between Acrisure and the team. Quote the press release exactly.";
  const { router, fetchImpl } = prod({ handlers: { gemini: F.geminiOk("Draft story text.") } });
  const r = await router.route(F.req({ taskType: "writing", prompt, system: "You are Zaydan, sports-business writer for The Allegheny Chronicle.", output: { maxTokens: 4000 } }));
  assert.equal(r.ok, true);
  assert.equal(r.content, "Draft story text.", "response content is not altered");
  const c = fetchImpl.calls[0];
  assert.equal(c.body.contents[0].parts[0].text, prompt);
  assert.equal(c.body.systemInstruction.parts[0].text, "You are Zaydan, sports-business writer for The Allegheny Chronicle.");
  assert.equal(c.body.generationConfig.maxOutputTokens, 4000);
  assert.ok(!("safetySettings" in c.body), "no content-filter parameters added by us");
});

// ---------------------------------------------------------------- 10. outages / malformed / timeouts
test("outages, malformed bodies, network errors and timeouts are handled safely (retryable, no crash, no leak)", async () => {
  const scenarios = {
    "5xx outage": F.json(503, { error: { message: "overloaded" } }),
    "HTML 200": new Response("<html>gateway</html>", { status: 200 }),
    "empty candidates": F.json(200, { candidates: [] }),
    "network error": new Error(`socket hang up for ${F.FAKE_KEYS.GEMINI_API_KEY}`),
    "OpenRouter error inside 200": F.json(200, { error: { code: 502, message: "upstream failed" } })
  };
  for (const [name, res] of Object.entries(scenarios)) {
    const { router, logLines } = prod({ env: { GEMINI_API_KEY: F.FAKE_KEYS.GEMINI_API_KEY, OPENROUTER_API_KEY: F.FAKE_KEYS.OPENROUTER_API_KEY }, handlers: { gemini: res, openrouter: res } });
    const r = await router.route(F.req());
    assert.equal(r.ok, false, name);
    assert.equal(r.status, "WAITING", name);
    assert.ok(r.retry.retryAt, name);
    noSecrets(name, r); noSecrets(name + " logs", logLines);
  }
  // timeout: fetch that only settles when aborted
  const hang = async (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const reg = prodRegistry();
  const a = createProviderAdapters({ guard: (p, m) => reg.assertApproved(p, m), env: ENV, fetchImpl: hang, timeoutMs: 20 });
  const t = await a.gemini.call(createRequest({ taskType: "writing", prompt: "hi" }), "gemini-3.8-flash");
  assert.equal(t.ok, false);
  assert.equal(t.error.category, "PROVIDER_UNAVAILABLE");
  assert.match(t.error.message, /timed out/);
});

// ---------------------------------------------------------------- 11. limiter + human review intact
test("provider calls, retries and quota waits never consume article-draft slots; the 3-per-24h limit and HUMAN_REVIEW stop remain", async () => {
  const store = new LocalStateStore();
  const now = F.makeClock();
  const { router } = prod({ now, handlers: { gemini: [F.geminiOk(), g429], openrouter: o429 } });
  for (let i = 0; i < 6; i++) await router.route(F.req());
  assert.equal(limiter.getWindowStatus(store, 3, now).activeInWindow, 0, "AI routing consumed no slot");
  // the limiter itself still enforces 3 per rolling 24h
  const res = [1, 2, 3].map(() => limiter.reserveSlot(store, 3, now));
  assert.ok(res.every((x) => x.reserved === true), "three reservations succeed");
  const fourth = limiter.reserveSlot(store, 3, now);
  assert.equal(fourth.reserved, false);
  assert.equal(fourth.reason, "LIMIT_REACHED");
  // router response carries no publish/approve capability, and the workflow has no automated way past HUMAN_REVIEW
  const r = await router.route(F.req());
  for (const k of Object.keys(r)) assert.ok(!/publish|approve|commit/i.test(k), k);
  const { TRANSITIONS, HUMAN_ONLY_TARGETS } = require("../workflow/constants");
  assert.ok(TRANSITIONS.HUMAN_REVIEW.every((t) => HUMAN_ONLY_TARGETS.includes(t)), "every exit from HUMAN_REVIEW is human-only");
});

// ---------------------------------------------------------------- 12. offline
test("the suite needs no network and no real credentials: a fetch that is not scripted fails loudly", async () => {
  const { router } = prod({ handlers: {} });   // no handlers -> scripted fetch throws "unexpected call"
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  for (const k of ALL_SECRETS) assert.ok(/FAKE/.test(k), "only fake credentials exist in tests");
  assert.ok(!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY !== ENV.GEMINI_API_KEY);
});
