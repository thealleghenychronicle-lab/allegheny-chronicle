#!/usr/bin/env node
// Production runtime support (Phase 3 / Step 4): GitHub Actions + Node.js + the existing GitStateStore.
// Offline and read-only by construction: `check` inspects Node, git and environment-variable NAMES (never values) and makes
// no network request. `createStateStoreFromEnv` is the single place the real state store is wired from the environment;
// nothing in this step calls it against a real repository. See newsroom/RUNTIME.md.
//   node newsroom/runtime.js check [--require state,ai] [--json]
"use strict";
const { execFileSync } = require("child_process");
const config = require("./config");
const { GitStateStore } = require("./state-store");

const MIN_NODE_MAJOR = 20;          // global fetch + stable node:test
const MIN_GIT = [2, 31];            // GIT_CONFIG_COUNT/KEY_n/VALUE_n environment config

// name -> { secret, group, note }. Values are never read into any report.
const VARIABLES = Object.freeze({
  GITHUB_REPOSITORY:                  { secret: false, group: "state", note: "owner/repo; provided automatically by Actions" },
  NEWSROOM_STATE_REMOTE_URL:          { secret: false, group: "state", note: "optional override of the https state remote (must not contain credentials)" },
  GITHUB_TOKEN:                       { secret: true,  group: "state", note: "provided automatically by Actions; needs `contents: write` once state writes are enabled" },
  NEWSROOM_STATE_TOKEN:               { secret: true,  group: "state", note: "optional fine-grained PAT (Contents: read/write on this repo only) that overrides GITHUB_TOKEN" },
  GEMINI_API_KEY:                     { secret: true,  group: "ai",    note: "Gemini free tier" },
  OPENROUTER_API_KEY:                 { secret: true,  group: "ai",    note: "OpenRouter, `:free` models only" },
  CLOUDFLARE_API_TOKEN:               { secret: true,  group: "ai",    note: "Workers AI-scoped token" },
  CLOUDFLARE_ACCOUNT_ID:              { secret: false, group: "ai",    note: "32-hex account id (treated as sensitive in logs anyway)" },
  CLOUDFLARE_FREE_PLAN_CONFIRMED:     { secret: false, group: "ai",    note: "must be exactly `true` (owner confirms Workers Free plan)" },
  NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET: { secret: false, group: "optional", note: "optional; positive integer, can only lower the built-in budget" },
  NEWSROOM_SAFE_MODE:                 { secret: false, group: "optional", note: "leave unset; `false` is not for use before a later, authorised step" }
});

const has = (env, k) => typeof env[k] === "string" && env[k].trim() !== "";
const parseSemver = (v) => String(v || "").split(".").map((n) => parseInt(n, 10));

function gitVersion() {
  try { return /(\d+\.\d+(?:\.\d+)?)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }))[1]; } catch (e) { return null; }
}

function providerStatus(env) {
  return {
    gemini: has(env, "GEMINI_API_KEY"),
    openrouter: has(env, "OPENROUTER_API_KEY"),
    cloudflare: has(env, "CLOUDFLARE_API_TOKEN") && /^[0-9a-f]{32}$/i.test(String(env.CLOUDFLARE_ACCOUNT_ID || "").trim()) && String(env.CLOUDFLARE_FREE_PLAN_CONFIRMED || "").trim() === "true"
  };
}

// Pure and offline. `require` = groups whose absence is an error ("state", "ai"); otherwise absence is only reported.
function checkRuntime(env = process.env, { require: req = [], nodeVersion = process.versions.node, git = gitVersion() } = {}) {
  const errors = []; const warnings = [];
  const [nMajor] = parseSemver(nodeVersion);
  if (!(nMajor >= MIN_NODE_MAJOR)) errors.push(`Node ${nodeVersion} is too old; need >= ${MIN_NODE_MAJOR}`);
  const [gMaj, gMin] = parseSemver(git);
  if (git === null) errors.push("git is not available");
  else if (gMaj < MIN_GIT[0] || (gMaj === MIN_GIT[0] && gMin < MIN_GIT[1])) errors.push(`git ${git} is too old; need >= ${MIN_GIT.join(".")}`);

  const variables = {};
  for (const [name, spec] of Object.entries(VARIABLES)) variables[name] = { group: spec.group, secret: spec.secret, status: has(env, name) ? "set" : "missing" };

  const repoOk = has(env, "NEWSROOM_STATE_REMOTE_URL") || /^[\w.-]+\/[\w.-]+$/.test(String(env.GITHUB_REPOSITORY || "").trim());
  const tokenOk = has(env, "NEWSROOM_STATE_TOKEN") || has(env, "GITHUB_TOKEN");
  if (has(env, "GITHUB_REPOSITORY") && !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY.trim())) errors.push("GITHUB_REPOSITORY is malformed (expected owner/repo)");
  if (has(env, "NEWSROOM_STATE_REMOTE_URL") && stateRemoteProblem(env.NEWSROOM_STATE_REMOTE_URL)) errors.push(`NEWSROOM_STATE_REMOTE_URL: ${stateRemoteProblem(env.NEWSROOM_STATE_REMOTE_URL)}`);
  const state = { ready: repoOk && tokenOk, repository: repoOk, token: tokenOk, branch: config.STATE_BRANCH };
  if (req.includes("state") && !state.ready) errors.push("state store not configured: need GITHUB_REPOSITORY (or NEWSROOM_STATE_REMOTE_URL) and GITHUB_TOKEN (or NEWSROOM_STATE_TOKEN)");

  const providers = providerStatus(env);
  const cfPartial = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_FREE_PLAN_CONFIRMED"].some((k) => has(env, k)) && !providers.cloudflare;
  if (cfPartial) warnings.push("Cloudflare variables are set but incomplete/invalid (token + 32-hex account id + CLOUDFLARE_FREE_PLAN_CONFIRMED=true are all required); the adapter will not be selected");
  if (req.includes("ai") && !Object.values(providers).some(Boolean)) errors.push("no free AI provider is fully configured");
  if (has(env, "NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET") && !/^\d+$/.test(env.NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET.trim())) warnings.push("NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET is not a positive integer and will be ignored");
  if (String(env.NEWSROOM_SAFE_MODE || "").trim() === "false") warnings.push("NEWSROOM_SAFE_MODE=false is set; it must stay unset until an authorised later step");

  return { ok: errors.length === 0, node: nodeVersion, git, stateBranch: config.STATE_BRANCH, state, providers, variables, errors, warnings };
}

function stateRemoteProblem(url) {
  const u = String(url).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i.test(u)) return "must not contain credentials";
  return null;
}

// Wires the real GitStateStore from the environment. Credentials travel ONLY in git's environment (http.<origin>/.extraheader),
// never in the URL, argv, .git/config or error text. createIfMissing is false: creating `newsroom-state` is an explicit,
// separate, owner-authorised step. Constructing the store performs a network fetch, so this is not called by `check`.
function resolveStateRemote(env = process.env) {
  const override = has(env, "NEWSROOM_STATE_REMOTE_URL") ? env.NEWSROOM_STATE_REMOTE_URL.trim() : null;
  if (override && stateRemoteProblem(override)) throw new Error(`NEWSROOM_STATE_REMOTE_URL: ${stateRemoteProblem(override)}`);
  const repo = has(env, "GITHUB_REPOSITORY") ? env.GITHUB_REPOSITORY.trim() : null;
  if (!override && !(repo && /^[\w.-]+\/[\w.-]+$/.test(repo))) throw new Error("state store: GITHUB_REPOSITORY (owner/repo) or NEWSROOM_STATE_REMOTE_URL is required");
  const remote = override || `https://github.com/${repo}.git`;
  const token = has(env, "NEWSROOM_STATE_TOKEN") ? env.NEWSROOM_STATE_TOKEN.trim() : has(env, "GITHUB_TOKEN") ? env.GITHUB_TOKEN.trim() : null;
  const gitEnv = {};
  if (/^https:\/\//i.test(remote)) {
    if (!token) throw new Error("state store: GITHUB_TOKEN (or NEWSROOM_STATE_TOKEN) is required for an https remote");
    const origin = new URL(remote).origin;
    gitEnv.GIT_CONFIG_COUNT = "1";
    gitEnv.GIT_CONFIG_KEY_0 = `http.${origin}/.extraheader`;
    gitEnv.GIT_CONFIG_VALUE_0 = `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return { remote, gitEnv, token };
}

// Wires the real GitStateStore from the environment. Credentials travel ONLY in git's environment (http.<origin>/.extraheader),
// never in the URL, argv, .git/config or error text. createIfMissing defaults to false: creating `newsroom-state` is an explicit,
// separate, owner-authorised step (newsroom/state-connect.js, mode `initialize`). Constructing the store performs a network fetch,
// so this is not called by `check`.
function createStateStoreFromEnv(env = process.env, { StoreClass = GitStateStore, createIfMissing = false } = {}) {
  const { remote, gitEnv } = resolveStateRemote(env);
  return new StoreClass(remote, config.STATE_BRANCH, { env: gitEnv, createIfMissing });
}

function main(argv) {
  if (argv[0] !== "check") { console.error("usage: node newsroom/runtime.js check [--require state,ai] [--json]"); return 2; }
  const i = argv.indexOf("--require");
  const req = i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const r = checkRuntime(process.env, { require: req });
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`Node ${r.node} | git ${r.git} | state branch: ${r.stateBranch} | safe mode: ${config.SAFE_MODE}`);
    console.log(`state store configured: ${r.state.ready} | providers: ${Object.entries(r.providers).map(([k, v]) => `${k}=${v ? "configured" : "not configured"}`).join(", ")}`);
    for (const [k, v] of Object.entries(r.variables)) console.log(`  ${v.status === "set" ? "set    " : "missing"} ${k}${v.secret ? " (secret)" : ""}`);
    r.warnings.forEach((w) => console.log(`WARNING: ${w}`));
    r.errors.forEach((e) => console.log(`ERROR: ${e}`));
    console.log(r.ok ? "runtime check: OK" : "runtime check: FAILED");
  }
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { checkRuntime, createStateStoreFromEnv, resolveStateRemote, VARIABLES, MIN_NODE_MAJOR, MIN_GIT };
