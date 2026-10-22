// Phase 3 / Step 1 — free-model evidence registry + free-only safeguards.
// No network, no real keys: scripted fetch + fake credentials (from helpers). Production allowlist/overrides are used here
// (unlike router.test.js, which uses fixture ids) to prove the REAL allowlist is safe.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../config");
const ev = require("../ai/free-models");
const { createModelRegistry, ModelNotApprovedError } = require("../ai/registry");
const { createRequest } = require("../ai/request");
const F = require("./helpers/router-fixtures");

const EXPECTED_ENABLED = [
  "gemini:gemini-3.8-flash",
  "gemini:gemini-3.5-flash-lite",
  "openrouter:apodex/apodex-1.1-mini:free",
  "openrouter:inclusionai/ling-3.0-flash-sante:free",
  "cloudflare:@cf/zai-org/glm-4.7-flash"      // Step 3: third free provider (Groq was disabled in Step 3)
];
// With the default test env no Cloudflare credentials exist, so the router skips it (MISSING_CREDENTIALS) and never calls it.
const NO_CF_CREDS = EXPECTED_ENABLED.filter((k) => !k.startsWith("cloudflare:"));

// Things that must NEVER be callable. Each is either paid, router-based, unverified, retired, or a placeholder.
const MUST_BE_REJECTED = [
  "gemini:gemini-3.1-pro-preview",            // NOT_FREE (pricing page: Free Tier "Not available")
  "gemini:gemini-1.5-flash",                  // old Chunk 1 entry, absent from current docs
  "gemini:gemini-2.0-flash",                  // shut down
  "gemini:gemini-2.5-pro",                    // access limited to prior users: UNVERIFIED
  "groq:llama-3.1-8b-instant",                // old Chunk 1 entry; free tier UNVERIFIED
  "groq:llama-3.3-70b-versatile",
  "groq:openai/gpt-oss-120b",                 // only Developer-plan limits published: UNVERIFIED
  "groq:openai/gpt-oss-20b",                  // Step 3: Groq disabled (eligibility without payment not established)
  "cloudflare:@cf/zai-org/glm-5.2",           // documented as requiring Workers Paid
  "cloudflare:@cf/zai-org/glm-5.3-flash",
  "cloudflare:@cf/moonshotai/kimi-k2.6",
  "cloudflare:@cf/meta/llama-3.1-8b-instruct", // not an approved model
  "openrouter:openrouter/free",               // router: random model, no free-only guarantee
  "openrouter:inclusionai/ling-3.1-flash",    // zero price but no :free suffix
  "openrouter:openai/gpt-4o",
  "openrouter:openrouter/auto",
  "openrouter:free-tier-model-placeholder",
  "openai:gpt-4o",
  "anthropic:claude-opus-5-5"
];

const ok429 = (provider) => provider === "gemini"
  ? F.json(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } })
  : F.json(429, { error: { code: 429, message: "Rate limit exceeded" } });

// provider:model keys that were actually sent over the (fake) wire
function calledKeys(fetchImpl) {
  return fetchImpl.calls.map((c) => {
    if (c.provider === "gemini") return `gemini:${decodeURIComponent(new URL(c.url).pathname.split("/models/")[1].split(":generateContent")[0])}`;
    if (c.provider === "cloudflare") return `cloudflare:${decodeURIComponent(new URL(c.url).pathname.split("/ai/run/")[1])}`;
    return `${c.provider}:${c.body.model}`;
  });
}
const prodRegistry = () => createModelRegistry({ allowedFreeModels: config.ALLOWED_FREE_MODELS, overrides: config.MODEL_OVERRIDES });
const prodRouter = (opts = {}) => F.makeRouter({ registry: prodRegistry(), ...opts });

// ---------------------------------------------------------------- evidence data
test("evidence registry is structurally valid and every record has sources, a date and uncertainty notes", () => {
  assert.deepEqual(ev.validateEvidence(), []);
  assert.match(ev.VERIFIED_ON, /^\d{4}-\d{2}-\d{2}$/);
  for (const r of ev.FREE_MODEL_EVIDENCE) {
    assert.ok(r.sources.length >= 1 && r.sources.every((s) => s.startsWith("https://")), r.key);
    assert.ok(ev.STATUSES.includes(r.status), r.key);
  }
});

test("evidence validator catches records that would unsafely enable a model", () => {
  const base = ev.FREE_MODEL_EVIDENCE.find((r) => r.key === EXPECTED_ENABLED[0]);
  const bad = (patch) => ev.validateEvidence([{ ...base, ...patch }]);
  assert.ok(bad({ sources: [] }).length);
  assert.ok(bad({ freeEvidence: [] }).length);
  assert.ok(bad({ priority: null }).length);
  assert.ok(bad({ maxOutputTokens: null }).length);
  assert.ok(bad({ verifiedAt: "yesterday" }).length);
  assert.ok(bad({ status: "FREE_PROBABLY" }).length);
  assert.ok(ev.validateEvidence([{ ...base, provider: "openrouter", model: "vendor/paid", key: "openrouter:vendor/paid" }]).length);
  assert.ok(ev.validateEvidence([base, base]).some((p) => /duplicate/.test(p)));
});

test("enabled allowlist is exactly the five VERIFIED_FREE models, in deterministic priority order", () => {
  assert.deepEqual([...config.ALLOWED_FREE_MODELS], EXPECTED_ENABLED);
  assert.deepEqual([...ev.ALLOWED_FREE_MODELS], EXPECTED_ENABLED);
  const priorities = EXPECTED_ENABLED.map((k) => ev.MODEL_OVERRIDES[k].priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b));
  assert.equal(new Set(priorities).size, priorities.length);
});

test("only VERIFIED_FREE evidence is enabled; every UNVERIFIED / NOT_FREE / UNAVAILABLE record is excluded", () => {
  const byKey = new Map(ev.FREE_MODEL_EVIDENCE.map((r) => [r.key, r]));
  for (const key of config.ALLOWED_FREE_MODELS) assert.equal(byKey.get(key).status, "VERIFIED_FREE", key);
  for (const r of ev.FREE_MODEL_EVIDENCE) if (r.status !== "VERIFIED_FREE") assert.ok(!config.ALLOWED_FREE_MODELS.includes(r.key), `${r.key} must not be enabled`);
  assert.equal(ev.EXCLUDED_MODELS.length + EXPECTED_ENABLED.length, ev.FREE_MODEL_EVIDENCE.length);
  // statuses we rely on being recorded accurately
  assert.equal(byKey.get("gemini:gemini-3.1-pro-preview").status, "NOT_FREE");
  assert.equal(byKey.get("gemini:gemini-2.0-flash").status, "UNAVAILABLE");
  for (const k of ["groq:llama-3.1-8b-instant", "groq:openai/gpt-oss-120b", "groq:openai/gpt-oss-20b", "openrouter:openrouter/free", "gemini:gemini-1.5-flash"]) assert.equal(byKey.get(k).status, "UNVERIFIED", k);
});

test("no model is enabled from the old Chunk 1 list (gemini-1.5-flash, llama-3.1-8b-instant, placeholder)", () => {
  for (const k of ["gemini:gemini-1.5-flash", "groq:llama-3.1-8b-instant", "openrouter:free-tier-model-placeholder"]) assert.ok(!config.ALLOWED_FREE_MODELS.includes(k), k);
});

test("published limits: only documented numbers are enforced; unpublished stay null (nothing invented)", () => {
  const reg = prodRegistry();
  assert.deepEqual(reg.issues, []);
  for (const key of ["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite"]) {
    assert.deepEqual({ ...reg.get(key).limits }, { rpm: null, rpd: null, tpm: null, tpd: null }, key);   // Gemini free numbers not published
  }
  for (const key of EXPECTED_ENABLED.filter((k) => k.startsWith("openrouter:"))) {
    assert.deepEqual({ ...reg.get(key).limits }, { rpm: 20, rpd: 50, tpm: null, tpd: null }, key);       // OpenRouter limits doc
  }
  // Cloudflare publishes no per-minute/day request limits we rely on; its protection is the local Neuron budget (see cloudflare.test.js).
  assert.deepEqual({ ...reg.get("cloudflare:@cf/zai-org/glm-4.7-flash").limits }, { rpm: null, rpd: null, tpm: null, tpd: null });
  assert.equal(reg.get("groq:openai/gpt-oss-20b"), null, "Groq is disabled");
});

test("documented capabilities and output limits are applied to registry entries", () => {
  const reg = prodRegistry();
  assert.equal(reg.get("gemini:gemini-3.8-flash").maxOutputTokens, 65536);
  assert.equal(reg.get("openrouter:inclusionai/ling-3.0-flash-sante:free").maxOutputTokens, 32768);
  assert.ok(reg.get("gemini:gemini-3.8-flash").capabilities.includes("json_output"));
  assert.ok(!reg.get("openrouter:inclusionai/ling-3.0-flash-sante:free").capabilities.includes("json_output"), "no response_format in its parameter list");
  assert.ok(reg.list().every((e) => e.tier === "free" && e.approved === true));
});

test("largest accepted prompt (400k chars ~ 100k tokens) fits the smallest enabled context window", () => {
  const r = createRequest({ taskType: "writing", prompt: "a".repeat(400000) });
  const minCtx = Math.min(...ev.FREE_MODEL_EVIDENCE.filter((e) => e.status === "VERIFIED_FREE").map((e) => e.contextWindow));
  assert.ok(r.estimatedInputTokens < minCtx);
  assert.throws(() => createRequest({ taskType: "writing", prompt: "a".repeat(400001) }));
});

test("evidenceAgeDays reports staleness (used for manual re-verification reminders)", () => {
  assert.equal(ev.evidenceAgeDays(Date.parse("2026-10-08T12:00:00Z")), 0);
  assert.equal(ev.evidenceAgeDays(Date.parse("2026-11-07T00:00:00Z")), 30);
});

// ---------------------------------------------------------------- registry identity rules
test("registry rejects every paid / unverified / retired / router / placeholder model", () => {
  const reg = prodRegistry();
  for (const key of MUST_BE_REJECTED) {
    const i = key.indexOf(":");
    assert.equal(reg.isApproved(key), false, key);
    assert.throws(() => reg.assertApproved(key.slice(0, i), key.slice(i + 1)), ModelNotApprovedError, key);
  }
});

test("even if a human mistakenly adds them to the list, the registry's identity rules still exclude routers, non-:free ids, variant suffixes and unsafe ids", () => {
  const bad = [
    "openrouter:openrouter/free", "openrouter:openrouter/free:free", "openrouter:openrouter/auto:free",
    "openrouter:openai/gpt-4o", "openrouter:vendor/model:nitro", "openrouter:vendor/model:online:free", "openrouter:vendor/model:floor:free",
    "gemini:gemini-3.8-flash/../../v1/other", "gemini:gemini 3.8 flash", "gemini:gemini-3.8-flash?key=x", "gemini:x\nHost:evil",
    "unknownprovider:model", "nocolon", "gemini:"
  ];
  const reg = createModelRegistry({ allowedFreeModels: bad });
  assert.equal(reg.list().length, 0);
  assert.equal(reg.issues.length, bad.length);
  const codes = Object.fromEntries(reg.issues.map((i) => [i.key, i.code]));
  assert.equal(codes["openrouter:openrouter/free"], "OPENROUTER_ROUTER_NOT_ALLOWED");
  assert.equal(codes["openrouter:openrouter/free:free"], "OPENROUTER_ROUTER_NOT_ALLOWED");
  assert.equal(codes["openrouter:openai/gpt-4o"], "OPENROUTER_MODEL_NOT_FREE_VARIANT");
  assert.equal(codes["openrouter:vendor/model:online:free"], "OPENROUTER_VARIANT_NOT_ALLOWED");
  assert.equal(codes["gemini:gemini-3.8-flash?key=x"], "UNSAFE_MODEL_ID");
  // a plain, well-formed :free id and plain gemini id are still accepted
  const good = createModelRegistry({ allowedFreeModels: ["openrouter:vendor/model:free", "gemini:gemini-3.8-flash"] });
  assert.equal(good.list().length, 2);
});

test("overrides can only be attached to allowlisted models (cannot smuggle in a paid model via config)", () => {
  assert.throws(() => createModelRegistry({ allowedFreeModels: EXPECTED_ENABLED, overrides: { "gemini:gemini-3.1-pro-preview": { priority: 1 } } }), ModelNotApprovedError);
  assert.deepEqual(Object.keys(config.MODEL_OVERRIDES).sort(), [...EXPECTED_ENABLED].sort());
});

// ---------------------------------------------------------------- router safeguards with the REAL allowlist
test("router never sends untrusted preferences to a non-approved model (prefer / strict / unknown providers)", async () => {
  const { router, fetchImpl } = prodRouter({ handlers: { gemini: F.geminiOk(), openrouter: F.openrouterOk(), groq: F.groqOk() } });
  const r = await router.route(F.req({ modelPreference: { prefer: MUST_BE_REJECTED } }));
  assert.equal(r.status, "SUCCESS");
  assert.equal(r.provider + ":" + r.model, EXPECTED_ENABLED[0], "preference list full of unapproved ids must not change the approved choice");
  for (const k of MUST_BE_REJECTED) {
    const rej = r.routing.rejected.find((x) => x.key === k);
    // keys that parse as provider:model and are not registry issues are recorded as NOT_APPROVED_FREE
    if (rej) assert.ok(["NOT_APPROVED_FREE", "OPENROUTER_MODEL_NOT_FREE_VARIANT", "OPENROUTER_ROUTER_NOT_ALLOWED", "PLACEHOLDER_MODEL"].includes(rej.code), `${k}: ${rej.code}`);
  }
  assert.deepEqual(calledKeys(fetchImpl), [EXPECTED_ENABLED[0]]);

  const strict = await prodRouter({ handlers: { gemini: F.geminiOk(), openrouter: F.openrouterOk(), groq: F.groqOk() } })
    .router.route(F.req({ modelPreference: { prefer: ["groq:openai/gpt-oss-120b", "gemini:gemini-3.1-pro-preview"], strict: true } }));
  assert.equal(strict.status, "FAILED");
  assert.equal(strict.error.category, "NO_ELIGIBLE_MODEL");
});

test("Groq is disabled: a configured Groq key never results in a Groq call, even when Groq is explicitly preferred", async () => {
  const { router, fetchImpl } = prodRouter({ env: { GROQ_API_KEY: F.FAKE_KEYS.GROQ_API_KEY }, handlers: { groq: F.groqOk() } });
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
  const pref = await router.route(F.req({ modelPreference: { prefer: ["groq", "groq:openai/gpt-oss-20b", "groq:openai/gpt-oss-120b"], strict: true } }));
  assert.equal(pref.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
  assert.ok(pref.routing.rejected.some((x) => x.key === "groq:openai/gpt-oss-20b" && x.code === "NOT_APPROVED_FREE"));
});

test("quota exhaustion on EVERY approved free model -> WAITING with a retry time; no paid/unapproved call is ever made", async () => {
  const handlers = { gemini: ok429("gemini"), openrouter: ok429("openrouter"), groq: ok429("groq") };
  const { router, fetchImpl, now } = prodRouter({ handlers });
  const r = await router.route(F.req());
  assert.equal(r.status, "WAITING");
  assert.equal(r.ok, false);
  assert.equal(r.error.category, "ALL_OPTIONS_TEMPORARILY_UNAVAILABLE");
  assert.ok(r.retry && r.retry.retryable === true && typeof r.retry.retryAt === "string" && r.retry.retryAfterMs > 0, "a retry time / waiting state is recorded");
  assert.deepEqual(calledKeys(fetchImpl).sort(), [...NO_CF_CREDS].sort(), "each approved, credentialed model tried once, nothing else");
  assert.ok(fetchImpl.calls.every((c) => c.provider !== "other"));

  // while everything is blocked, asking again makes ZERO further calls and still waits
  const before = fetchImpl.calls.length;
  const again = await router.route(F.req());
  assert.equal(again.status, "WAITING");
  assert.equal(fetchImpl.calls.length, before);

  // after the retry time passes, only approved models are probed again
  now.advance(3 * 3600 * 1000);
  await router.route(F.req());
  assert.ok(fetchImpl.calls.length > before);
  for (const k of calledKeys(fetchImpl)) assert.ok(EXPECTED_ENABLED.includes(k), k);
});

test("daily-quota 429s keep the job waiting (no escalation) and never mention billing/upgrade paths", async () => {
  const daily = {
    gemini: F.json(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_free_tier_requests, limit per day" } }),
    openrouter: F.json(429, { error: { code: 429, message: "Rate limit exceeded: free-models-per-day" } }),
    groq: F.json(429, { error: { message: "Rate limit reached for model on requests per day (RPD): Limit 1000, Used 1000. Please try again in 2h", code: "rate_limit_exceeded" } })
  };
  const { router, fetchImpl } = prodRouter({ handlers: daily });
  const r = await router.route(F.req());
  assert.equal(r.status, "WAITING");
  assert.ok(r.quota.evaluated.some((q) => q.state === "DAILY_LIMIT_REACHED"));
  assert.ok(r.retry.retryAfterMs >= 60 * 60 * 1000 - 1000, "daily exhaustion waits (>= ~1h fallback), it does not retry immediately");
  for (const k of calledKeys(fetchImpl)) assert.ok(EXPECTED_ENABLED.includes(k), k);
});

test("HTTP 402 (billing/credits problem) disables the free model and does not trigger any paid or other-provider escalation", async () => {
  const handlers = { openrouter: F.json(402, { error: { code: 402, message: "Insufficient credits" } }), gemini: F.geminiOk() };
  const { router, fetchImpl } = prodRouter({ env: { OPENROUTER_API_KEY: F.FAKE_KEYS.OPENROUTER_API_KEY }, handlers });
  const r = await router.route(F.req());
  assert.equal(r.ok, false);
  const orCalls = calledKeys(fetchImpl);
  assert.deepEqual(orCalls.sort(), ["openrouter:apodex/apodex-1.1-mini:free", "openrouter:inclusionai/ling-3.0-flash-sante:free"].sort());
  assert.ok(r.routing.attempts.every((a) => a.category === "PAYMENT_REQUIRED" && a.retryable === false));
  const n = fetchImpl.calls.length;
  await router.route(F.req());
  assert.equal(fetchImpl.calls.length, n, "permanently disabled models are not retried");
});

test("local pacing enforces OpenRouter's published 20 requests/minute per model, then waits instead of calling more", async () => {
  const handlers = { openrouter: (call) => F.json(200, { model: call.body.model, choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) };
  const { router, fetchImpl } = prodRouter({ env: { OPENROUTER_API_KEY: F.FAKE_KEYS.OPENROUTER_API_KEY }, handlers });
  for (let i = 0; i < 40; i++) assert.equal((await router.route(F.req())).status, "SUCCESS", `call ${i}`);
  assert.equal(fetchImpl.calls.length, 40);
  const over = await router.route(F.req());
  assert.equal(over.status, "WAITING");
  assert.equal(fetchImpl.calls.length, 40, "no 41st call is made");
  assert.ok(over.retry.retryAt);
});

test("requests larger than every approved model's output limit fail with zero calls (never routed elsewhere)", async () => {
  const { router, fetchImpl } = prodRouter({ handlers: { gemini: F.geminiOk(), openrouter: F.openrouterOk() } });
  const r = await router.route(F.req({ output: { maxTokens: 300000 } }));
  assert.equal(r.status, "FAILED");
  assert.equal(fetchImpl.calls.length, 0);
  // Even with Cloudflare credentials (it publishes no output cap) the local Neuron budget refuses such a request.
  const cf = prodRouter({ env: { ...F.CF_ENV }, handlers: { cloudflare: F.cloudflareOk() } });
  const r2 = await cf.router.route(F.req({ output: { maxTokens: 300000 } }));
  assert.equal(r2.status, "FAILED");
  assert.equal(cf.fetchImpl.calls.length, 0);
  assert.ok(r2.routing.rejected.some((x) => x.key === "cloudflare:@cf/zai-org/glm-4.7-flash" && x.code === "REQUEST_EXCEEDS_NEURON_BUDGET"));
});

test("OpenRouter requests carry no fallback/routing parameters and always name an approved :free model", () => {
  const { router } = prodRouter();
  const adapter = router.adapters.openrouter;
  const request = createRequest({ taskType: "writing", prompt: "x", system: "y" });
  for (const key of EXPECTED_ENABLED.filter((k) => k.startsWith("openrouter:"))) {
    const model = key.slice("openrouter:".length);
    const built = adapter.buildRequest(request, model);
    assert.equal(built.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(built.body.model, model);
    assert.match(built.body.model, /:free$/);
    for (const forbidden of ["models", "route", "provider", "plugins", "transforms", "preset"]) assert.ok(!(forbidden in built.body), forbidden);
  }
});

test("adapters re-check the allowlist at call time: a paid or unverified model is refused before any network call", async () => {
  const { router, fetchImpl } = prodRouter();
  const request = createRequest({ taskType: "writing", prompt: "x" });
  for (const key of MUST_BE_REJECTED) {
    const i = key.indexOf(":"); const provider = key.slice(0, i); const model = key.slice(i + 1);
    const adapter = router.adapters[provider];
    if (!adapter) continue;                                   // unknown provider has no adapter at all
    await assert.rejects(() => adapter.call(request, model), ModelNotApprovedError, key);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test("credentials never leak into evidence/config data", () => {
  const blob = JSON.stringify({ e: ev.FREE_MODEL_EVIDENCE, c: config.MODEL_OVERRIDES });
  assert.ok(!/AIza[0-9A-Za-z_-]{10,}|gsk_[0-9A-Za-z]{10,}|sk-or-[0-9A-Za-z-]{10,}/.test(blob));
  for (const v of [...Object.values(F.FAKE_KEYS), F.CF_TOKEN]) assert.ok(!blob.includes(v));
});
