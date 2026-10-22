"use strict";
// Phase 3 / Step 4 -- production runtime (GitHub Actions + Node + GitStateStore). Offline: the only "remote" is a throwaway LOCAL bare repo.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { GitStateStore } = require("../state-store");
const { checkRuntime, createStateStoreFromEnv } = require("../runtime");
const { createRouter } = require("../router");
const { JobQueue } = require("../workflow/queue");
const { loadEmployees } = require("../workflow/handoff");
const { buildHarness, runToHumanReview } = require("../execution/harness");
const limiter = require("../limiter");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const bare = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "newsroom-rt-remote-")); git(d, ["init", "--bare", "-q"]); return d; };
const branches = (r) => git(r, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).trim().split("\n").filter(Boolean);
const FAKE = { token: "FAKE-STATE-TOKEN-1111", gemini: "FAKE-GEMINI-KEY-2222", cf: "FAKE-CF-TOKEN-3333" };
const OK = { nodeVersion: "22.1.0", git: "2.43.0" };

test("preflight: Node/git minimums are enforced", () => {
  assert.equal(checkRuntime({}, OK).ok, true);
  assert.match(checkRuntime({}, { nodeVersion: "18.19.0", git: "2.43.0" }).errors[0], /Node 18/);
  assert.match(checkRuntime({}, { nodeVersion: "22.1.0", git: "2.25.0" }).errors[0], /git 2\.25/);
  assert.match(checkRuntime({}, { nodeVersion: "22.1.0", git: null }).errors[0], /git is not available/);
});

test("preflight: reports variable NAMES and set/missing only -- never a value", () => {
  const env = { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: FAKE.token, GEMINI_API_KEY: FAKE.gemini, CLOUDFLARE_API_TOKEN: FAKE.cf };
  const r = checkRuntime(env, OK);
  const dump = JSON.stringify(r);
  for (const v of Object.values(FAKE)) assert.ok(!dump.includes(v));
  assert.equal(r.variables.GITHUB_TOKEN.status, "set");
  assert.equal(r.variables.OPENROUTER_API_KEY.status, "missing");
  assert.equal(r.state.ready, true);
  assert.deepEqual(r.providers, { gemini: true, openrouter: false, cloudflare: false });
});

test("preflight: missing config is only reported unless that group is required", () => {
  assert.equal(checkRuntime({}, OK).ok, true);
  assert.equal(checkRuntime({}, { ...OK, require: ["state"] }).ok, false);
  assert.equal(checkRuntime({}, { ...OK, require: ["ai"] }).ok, false);
  assert.equal(checkRuntime({ GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "x", GEMINI_API_KEY: "y" }, { ...OK, require: ["state", "ai"] }).ok, true);
  assert.equal(checkRuntime({ GITHUB_REPOSITORY: "not a repo" }, OK).ok, false);
  assert.equal(checkRuntime({ NEWSROOM_STATE_REMOTE_URL: "https://user:pw@github.com/o/r.git" }, OK).ok, false);
});

test("preflight: Cloudflare needs token + account id + FREE_PLAN_CONFIRMED=true; partial config warns; Groq is not a provider", () => {
  const acct = "a".repeat(32);
  assert.equal(checkRuntime({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: acct, CLOUDFLARE_FREE_PLAN_CONFIRMED: "true" }, OK).providers.cloudflare, true);
  const partial = checkRuntime({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: acct }, OK);
  assert.equal(partial.providers.cloudflare, false);
  assert.ok(partial.warnings.some((w) => /incomplete/.test(w)));
  assert.ok(!("groq" in checkRuntime({ GROQ_API_KEY: "g" }, OK).providers));
  assert.ok(checkRuntime({ NEWSROOM_SAFE_MODE: "false" }, OK).warnings.some((w) => /SAFE_MODE/.test(w)));
});

test("CLI: `check` runs offline, exits 0 with no config, 1 when a required group is missing, and prints no secret", () => {
  const script = path.join(__dirname, "..", "runtime.js");
  const env = { PATH: process.env.PATH, GITHUB_TOKEN: FAKE.token };
  const a = spawnSync(process.execPath, [script, "check"], { env, encoding: "utf8" });
  assert.equal(a.status, 0); assert.match(a.stdout, /runtime check: OK/); assert.ok(!a.stdout.includes(FAKE.token));
  const b = spawnSync(process.execPath, [script, "check", "--require", "state"], { env, encoding: "utf8" });
  assert.equal(b.status, 1); assert.match(b.stdout, /FAILED/);
});

test("state store from env: token goes only into git's environment header -- not the URL, not argv, not .git/config", () => {
  const seen = [];
  class Spy { constructor(url, branch, opts) { seen.push({ url, branch, opts }); } }
  createStateStoreFromEnv({ GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: FAKE.token }, { StoreClass: Spy });
  const { url, branch, opts } = seen[0];
  assert.equal(url, "https://github.com/o/r.git"); assert.equal(branch, "newsroom-state"); assert.equal(opts.createIfMissing, false);
  assert.ok(!url.includes(FAKE.token));
  assert.equal(opts.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(Buffer.from(opts.env.GIT_CONFIG_VALUE_0.split(" ")[2], "base64").toString(), `x-access-token:${FAKE.token}`);
  // NEWSROOM_STATE_TOKEN overrides GITHUB_TOKEN
  seen.length = 0;
  createStateStoreFromEnv({ GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "a", NEWSROOM_STATE_TOKEN: FAKE.token }, { StoreClass: Spy });
  assert.ok(Buffer.from(seen[0].opts.env.GIT_CONFIG_VALUE_0.split(" ")[2], "base64").toString().endsWith(FAKE.token));
  assert.throws(() => createStateStoreFromEnv({ GITHUB_TOKEN: "t" }, { StoreClass: Spy }), /GITHUB_REPOSITORY/);
  assert.throws(() => createStateStoreFromEnv({ GITHUB_REPOSITORY: "o/r" }, { StoreClass: Spy }), /GITHUB_TOKEN/);
  assert.throws(() => createStateStoreFromEnv({ NEWSROOM_STATE_REMOTE_URL: "https://u:p@github.com/o/r.git", GITHUB_TOKEN: "t" }, { StoreClass: Spy }), /credentials/);
});

test("GitStateStore receives the auth header through git's environment only and never persists it", () => {
  const remote = bare();
  const store = new GitStateStore(remote, "newsroom-state", { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `Authorization: basic ${FAKE.token}` } });
  try {
    assert.equal(store._git(["config", "--get", "http.https://github.com/.extraheader"]).trim(), `Authorization: basic ${FAKE.token}`);   // visible to git via env
    assert.ok(!fs.readFileSync(path.join(store.workdir, ".git", "config"), "utf8").includes(FAKE.token));                                 // not on disk
  } finally { store.cleanup(); fs.rmSync(remote, { recursive: true, force: true }); }
});

test("createIfMissing:false never creates the state branch; default behaviour (create) is unchanged", () => {
  const remote = bare(); const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("newsroom-state-")).length;
  try {
    assert.throws(() => new GitStateStore(remote, "newsroom-state", { createIfMissing: false }), /creation is disabled/);
    assert.deepEqual(branches(remote), []);                                                                                             // nothing created on the remote
    assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("newsroom-state-")).length, before);                            // failed constructor cleaned its workdir
    const s = new GitStateStore(remote); s.cleanup();                                                                                    // default still creates
    assert.deepEqual(branches(remote), ["newsroom-state"]);
    const t = new GitStateStore(remote, "newsroom-state", { createIfMissing: false }); t.cleanup();                                      // existing branch attaches fine
  } finally { fs.rmSync(remote, { recursive: true, force: true }); }
});

test("an unreachable remote is surfaced as an error and is never mistaken for a missing branch", () => {
  const gone = path.join(os.tmpdir(), "newsroom-rt-does-not-exist.git");
  assert.throws(() => new GitStateStore(gone, "newsroom-state", { createIfMissing: true }), (e) => !/creation is disabled/.test(e.message) && /fetch/.test(e.message));
});

test("Actions-style run: each run is a fresh process/store; router quota state + limiter + queue persist on the state branch between runs", async () => {
  const remote = bare();
  try {
    // run 1
    const s1 = new GitStateStore(remote);
    const router = createRouter({ stateStore: s1, env: { GEMINI_API_KEY: FAKE.gemini } });
    router.clearDisabled("gemini");
    const h = buildHarness({ store: s1 });
    const id = h.queue.enqueue({ title: "Runtime persistence", category: "general" }).job.id;
    const res = await runToHumanReview(h, id);
    assert.equal(res.stopped, "HUMAN_REVIEW");
    s1.cleanup();                                                                                                                        // runner VM is gone
    // run 2: brand-new store from the remote only
    const s2 = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });
    try {
      assert.equal(new JobQueue({ store: s2, employees: loadEmployees() }).get(id).state, "HUMAN_REVIEW");
      assert.equal(limiter.getWindowStatus(s2, 3, h.now).activeInWindow, 1);
      assert.ok(s2.read("quota-gemini.json"));
      const files = git(remote, ["ls-tree", "-r", "--name-only", "newsroom-state"]).trim().split("\n");
      assert.ok(files.every((f) => f === ".gitkeep" || f.endsWith(".json")), files.join(","));
      assert.deepEqual(branches(remote), ["newsroom-state"]);
    } finally { s2.cleanup(); }
  } finally { fs.rmSync(remote, { recursive: true, force: true }); }
});
