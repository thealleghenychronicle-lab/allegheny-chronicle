// Test fixtures: fake credentials, scripted fetch (no network), fixture registry.
// Model ids below are TEST FIXTURES ONLY — they are not the production allowlist.
"use strict";
const { createModelRegistry } = require("../../ai/registry");
const { createRouter } = require("../../router");
const { createLogger } = require("../../ai/logger");
const { LocalStateStore } = require("../../local-state-store");

const FAKE_KEYS = Object.freeze({
  GEMINI_API_KEY: "AIzaFAKE-gemini-key-DO-NOT-LEAK-0001",
  GROQ_API_KEY: "gsk_FAKE_groq_key_DO_NOT_LEAK_0002",
  OPENROUTER_API_KEY: "sk-or-FAKE-openrouter-key-DO-NOT-LEAK-0003"
});
// Cloudflare needs a token (secret) plus non-secret config; kept separate so FAKE_KEYS stays "secrets only".
const CF_TOKEN = "cf-FAKE-cloudflare-token-DO-NOT-LEAK-0005";
const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
const CF_ENV = Object.freeze({ CLOUDFLARE_API_TOKEN: CF_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, CLOUDFLARE_FREE_PLAN_CONFIRMED: "true" });
const GEMINI = "gemini:fixture-gemini-model";
const GROQ = "groq:fixture-groq-model";
const OPENROUTER = "openrouter:fixture/model:free";
const ALLOWED = [GEMINI, GROQ, OPENROUTER];

function makeRegistry(overrides = {}, allowed = ALLOWED) {
  return createModelRegistry({ allowedFreeModels: allowed, overrides });
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const geminiOk = (text = "gemini says hi", usage = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }) =>
  json(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: usage, modelVersion: "fixture-gemini-model" });
const groqOk = (text = "groq says hi", headers = {}) =>
  json(200, { model: "fixture-groq-model", choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 } }, headers);
const openrouterOk = (text = "openrouter says hi") =>
  json(200, { model: "fixture/model:free", choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });

const cloudflareOk = (text = "cloudflare says hi", usage = { prompt_tokens: 13, completion_tokens: 8, total_tokens: 21 }) =>
  json(200, { result: { id: "chatcmpl-fixture", object: "chat.completion", model: "@cf/zai-org/glm-4.7-flash", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }, success: true, errors: [], messages: [] });

// handlers: { gemini|groq|openrouter: (call) => Response | Response[] (consumed in order; last repeats) }
function makeFetch(handlers = {}) {
  const calls = [];
  const queues = {};
  const fn = async (url, init) => {
    const host = new URL(url).host;
    const provider = host.includes("googleapis") ? "gemini" : host.includes("groq") ? "groq" : host.includes("openrouter") ? "openrouter" : host.includes("cloudflare") ? "cloudflare" : "other";
    const call = { provider, url, headers: { ...(init.headers || {}) }, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    let h = handlers[provider];
    if (h === undefined) throw new Error(`unexpected call to ${provider}`);
    if (Array.isArray(h)) { queues[provider] = queues[provider] || h.slice(); h = queues[provider].length > 1 ? queues[provider].shift() : queues[provider][0]; }
    const res = typeof h === "function" ? await h(call) : h;
    if (res instanceof Error) throw res;
    return res.clone ? res.clone() : res;
  };
  fn.calls = calls;
  fn.callsTo = (p) => calls.filter((c) => c.provider === p);
  return fn;
}

function makeClock(start = Date.parse("2026-01-01T00:00:00Z")) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  return now;
}

// Build a router wired with fake creds, scripted fetch, in-memory state, capturing logger.
function makeRouter({ handlers = {}, env = FAKE_KEYS, registry = makeRegistry(), stateStore = new LocalStateStore(), now = makeClock(), backoff, overridesEnv } = {}) {
  const fetchImpl = makeFetch(handlers);
  const logLines = [];
  const logger = createLogger({ sink: (l) => logLines.push(l), secrets: () => Object.values(env), now });
  const router = createRouter({ registry, env: overridesEnv || env, fetchImpl, stateStore, now, logger, backoff, knownEmployees: ["lubna", "zaydan", "riham", "maysam", "nawfal"] });
  return { router, fetchImpl, logger, logLines, stateStore, now, registry };
}

const req = (extra = {}) => ({ taskType: "writing", prompt: "Summarize the news.", employee: "lubna", ...extra });

module.exports = { CF_TOKEN, CF_ACCOUNT, CF_ENV, cloudflareOk, FAKE_KEYS, GEMINI, GROQ, OPENROUTER, ALLOWED, makeRegistry, json, geminiOk, groqOk, openrouterOk, makeFetch, makeClock, makeRouter, req };
