"use strict";
// Phase 3 / Step 5 -- connecting the real `newsroom-state` branch. Everything here runs against throwaway LOCAL bare repositories
// and a loopback fake HTTP server. No GitHub, no credentials, no AI/research call, no website file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { GitStateStore } = require("../state-store");
const { runConnect, probeRemote, toMarkdown, CHECK_FILE } = require("../state-connect");
const { classifyGitError, redact, CODES } = require("../git-errors");
const { resolveStateRemote, createStateStoreFromEnv } = require("../runtime");
const limiter = require("../limiter");
const { JobQueue } = require("../workflow/queue");
const { loadEmployees } = require("../workflow/handoff");
const config = require("../config");
const { createModelRegistry } = require("../router");
const F = require("./helpers/router-fixtures");

process.env.NO_PROXY = "127.0.0.1,localhost"; process.env.no_proxy = "127.0.0.1,localhost";   // loopback tests must never touch a proxy
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (...xs) => xs.forEach((x) => (x && typeof x === "object" && x.cleanup ? x.cleanup() : fs.rmSync(x, { recursive: true, force: true })));
const bare = () => { const d = tmp("nr-s5-remote-"); git(d, ["init", "--bare", "-q", "-b", "main"]); return d; };
const heads = (r) => git(r, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]).trim().split("\n").filter(Boolean);
const branchNames = (r) => heads(r).map((l) => l.split(" ")[0]);
const tip = (r, b = "newsroom-state") => git(r, ["rev-parse", `refs/heads/${b}`]).trim();
const files = (r, b = "newsroom-state") => git(r, ["ls-tree", "-r", "--name-only", b]).trim().split("\n").filter(Boolean);
const env = (remote, extra = {}) => ({ NEWSROOM_STATE_REMOTE_URL: remote, ...extra });
const run = (remote, mode, extra = {}, now) => runConnect({ mode, env: env(remote, { NEWSROOM_CONFIRM_INITIALIZE: "INITIALIZE", ...extra }), runId: extra.runId || undefined, now });
const failed = (r, code) => { assert.equal(r.ok, false, JSON.stringify(r.failure)); assert.equal(r.failure.code, code, JSON.stringify(r.failure)); };

// A remote that already holds the "website" on main, like the real repository.
function remoteWithWebsite() {
  const remote = bare(); const w = tmp("nr-s5-work-");
  git(w, ["init", "-q", "-b", "main"]); git(w, ["config", "user.email", "t@t"]); git(w, ["config", "user.name", "t"]);
  fs.mkdirSync(path.join(w, "content/articles"), { recursive: true });
  fs.writeFileSync(path.join(w, "index.html"), "<h1>site</h1>"); fs.writeFileSync(path.join(w, "content/articles/a.md"), "# article");
  git(w, ["add", "-A"]); git(w, ["commit", "-q", "-m", "site"]); git(w, ["push", "-q", remote, "main"]); rm(w);
  return remote;
}

// ---------------------------------------------------------------- 1. error classification: auth/permission/network are never "missing"
test("git error classifier: realistic GitHub failures map to AUTH / PERMISSION / REPO_NOT_FOUND / NETWORK; only the exact messages mean missing-ref or conflict", () => {
  const c = (stderr) => classifyGitError({ stderr, message: "Command failed" });
  assert.equal(c("fatal: couldn't find remote ref newsroom-state"), CODES.REF_MISSING);
  assert.equal(c(" ! [rejected]        newsroom-state -> newsroom-state (fetch first)\nerror: failed to push some refs"), CODES.PUSH_REJECTED_NON_FF);
  assert.equal(c(" ! [rejected]        newsroom-state -> newsroom-state (non-fast-forward)"), CODES.PUSH_REJECTED_NON_FF);
  assert.equal(c("remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/r.git/'"), CODES.AUTH);
  assert.equal(c("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), CODES.AUTH);
  assert.equal(c("remote: Permission to o/r.git denied to github-actions[bot].\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"), CODES.PERMISSION);
  assert.equal(c(" ! [remote rejected] newsroom-state -> newsroom-state (protected branch hook declined)"), CODES.PERMISSION);
  assert.equal(c("remote: error: GH013: Repository rule violations found for refs/heads/newsroom-state."), CODES.PERMISSION);
  assert.equal(c(" ! [remote rejected] newsroom-state -> newsroom-state (failed to update ref)\nremote: error: cannot lock ref 'refs/heads/newsroom-state': is at d2e4f16e but expected 978f6cf9"), CODES.PUSH_REJECTED_NON_FF, "simultaneous-push ref-lock race is a conflict");
  assert.equal(c(" ! [remote rejected] newsroom-state -> newsroom-state (some other decline)"), CODES.PERMISSION);
  assert.equal(c("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found"), CODES.REPO_NOT_FOUND);
  assert.equal(c("fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"), CODES.NETWORK);
  assert.equal(c("fatal: unable to access 'x': Failed to connect to github.com port 443 after 5 ms: Connection refused"), CODES.NETWORK);
  assert.equal(c("error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502"), CODES.NETWORK);
  assert.equal(classifyGitError({ code: "ETIMEDOUT", message: "spawnSync git ETIMEDOUT" }), CODES.TIMEOUT);
  assert.equal(c("something odd"), CODES.UNKNOWN);
});

test("redact: tokens, Authorization headers and URL credentials never survive", () => {
  const s = redact("Authorization: basic QUJDREVGR0g= https://x-access-token:ghs_abcdefghij1234567890@github.com/o/r github_pat_ABCDEFGHIJ1234567890 mytoken-1234", ["mytoken-1234"]);
  for (const bad of ["QUJDREVGR0g=", "ghs_abcdefghij", "x-access-token", "github_pat_ABC", "mytoken-1234"]) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
});

// ---------------------------------------------------------------- 2. the store: a failed push is a conflict ONLY when it is a non-fast-forward rejection
test("store: a push the remote REFUSES (permission/protection hook) throws a classified error, is NOT reported as a conflict, and leaves no stray local commit", () => {
  const remote = bare(); const s = new GitStateStore(remote);
  try {
    assert.equal(s.writeAtomic({ "a.json": { v: 1 } }, "ok").ok, true);
    const hook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\necho 'GH006: Protected branch update failed' >&2\nexit 1\n"); fs.chmodSync(hook, 0o755);
    const before = git(s.workdir, ["rev-parse", "HEAD"]);
    let err; try { s.writeAtomic({ "a.json": { v: 2 } }, "refused"); } catch (e) { err = e; }
    assert.ok(err, "must throw, not return {ok:false, conflict:true}");
    assert.equal(err.gitCode, CODES.PERMISSION);
    assert.equal(git(s.workdir, ["rev-parse", "HEAD"]), before, "local HEAD restored");
    assert.deepEqual(s.read("a.json"), { v: 1 });
    fs.rmSync(hook);
    assert.equal(s.writeAtomic({ "a.json": { v: 3 } }, "after").ok, true);
  } finally { rm(s, remote); }
});

test("store: an unreachable remote surfaces as an error from refresh() and from the constructor (never as a missing branch)", () => {
  const remote = bare(); const s = new GitStateStore(remote);
  try {
    s.remoteUrl = path.join(remote, "gone"); s._git(["remote", "set-url", "origin", path.join(remote, "gone")]);
    let err; try { s.refresh(); } catch (e) { err = e; }
    assert.ok(err && err.gitCode && err.gitCode !== CODES.REF_MISSING, String(err));
  } finally { rm(s, remote); }
  let err2; try { new GitStateStore(path.join(os.tmpdir(), "definitely-not-a-repo-xyz"), "newsroom-state", { createIfMissing: true }); } catch (e) { err2 = e; }
  assert.ok(err2, "constructor must throw, not create a branch somewhere");
  assert.notEqual(err2.gitCode, CODES.REF_MISSING);
});

// ---------------------------------------------------------------- 3. probing: missing vs error
test("probe: empty remote and website-only remote report `missing`; after creation `exists`", () => {
  const empty = bare(); const site = remoteWithWebsite();
  try {
    for (const r of [empty, site]) assert.deepEqual(probeRemote({ remote: r, branch: "newsroom-state" }), { status: "missing" });
    const s = new GitStateStore(site, "newsroom-state", { createIfMissing: true }); s.cleanup();
    assert.equal(probeRemote({ remote: site, branch: "newsroom-state" }).status, "exists");
  } finally { rm(empty, site); }
});

test("probe: a nonexistent repository, an unreachable server, and a non-git path are ERRORS, never `missing`", () => {
  const gone = probeRemote({ remote: path.join(os.tmpdir(), "no-such-repo-xyz.git"), branch: "newsroom-state" });
  assert.equal(gone.status, "error");
  const refused = probeRemote({ remote: "http://127.0.0.1:1/o/r.git", branch: "newsroom-state" });
  assert.equal(refused.status, "error"); assert.equal(refused.code, CODES.NETWORK);
});

function fakeServer(status) {
  const log = path.join(tmp("nr-s5-log-"), "requests.log"); fs.writeFileSync(log, "");
  const child = spawn(process.execPath, [path.join(__dirname, "helpers", "fake-git-http.js"), String(status), log], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    child.stdout.once("data", (d) => resolve({ url: `http://127.0.0.1:${String(d).trim()}/o/r.git`, log, stop: () => { child.kill(); rm(path.dirname(log)); }, requests: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) }));
    child.once("error", reject);
  });
}

for (const [status, code] of [[401, CODES.AUTH], [403, CODES.PERMISSION], [404, CODES.REPO_NOT_FOUND], [500, CODES.NETWORK]]) {
  test(`FAIL-SAFE: HTTP ${status} from the remote -> ${code}; nothing is created, no write is ever attempted, and it is not reported as a missing branch`, async () => {
    const srv = await fakeServer(status);
    try {
      for (const mode of ["read-only", "verify", "initialize"]) {
        const r = run(srv.url, mode);
        failed(r, code);
        assert.equal(r.failure.stage, "probe");
        assert.equal(r.created, false);
        assert.notEqual(r.failure.code, CODES.REF_MISSING);
      }
      assert.ok(srv.requests().length > 0);
      assert.ok(srv.requests().every((l) => l.startsWith("GET ") && !/receive-pack/.test(l)), `only read requests expected: ${srv.requests().join(" ; ")}`);
    } finally { srv.stop(); }
  });
}

test("FAIL-SAFE: connection refused -> NETWORK for every mode, nothing created", () => {
  for (const mode of ["read-only", "verify", "initialize"]) { const r = run("http://127.0.0.1:1/o/r.git", mode); failed(r, CODES.NETWORK); assert.equal(r.created, false); }
});

// ---------------------------------------------------------------- 4. modes
test("read-only: missing branch fails with REF_MISSING and creates NOTHING; an existing branch is read without any write", () => {
  const remote = remoteWithWebsite();
  try {
    const before = heads(remote);
    failed(run(remote, "read-only"), CODES.REF_MISSING);
    failed(run(remote, "verify"), CODES.REF_MISSING);
    assert.deepEqual(heads(remote), before, "no branch created by read-only/verify");
    const s = new GitStateStore(remote, "newsroom-state", { createIfMissing: true }); s.writeAtomic({ "article-timestamps.json": { entries: [] } }, "seed"); s.cleanup();
    const t = tip(remote);
    const r = run(remote, "read-only");
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.equal(tip(remote), t, "read-only wrote nothing");
    assert.equal(r.limiter.max, 3);
  } finally { rm(remote); }
});

test("initialize: requires the exact confirmation; then creates ONLY an orphan newsroom-state with .gitkeep + connection-check.json; main and the website are untouched", () => {
  const remote = remoteWithWebsite();
  try {
    const mainBefore = tip(remote, "main");
    failed(runConnect({ mode: "initialize", env: env(remote) }), "CONFIRMATION_REQUIRED");
    failed(runConnect({ mode: "initialize", env: env(remote, { NEWSROOM_CONFIRM_INITIALIZE: "yes" }) }), "CONFIRMATION_REQUIRED");
    assert.deepEqual(branchNames(remote), ["main"]);
    const r = run(remote, "initialize", { runId: "run-1" });
    assert.equal(r.ok, true, JSON.stringify(r.failure)); assert.equal(r.created, true);
    assert.deepEqual(branchNames(remote).sort(), ["main", "newsroom-state"]);
    assert.equal(tip(remote, "main"), mainBefore, "main untouched");
    assert.deepEqual(files(remote).sort(), [".gitkeep", CHECK_FILE]);
    assert.ok(!files(remote).some((f) => /index\.html|content\/|\.md$/.test(f)), "no website/article file on the state branch");
    let shared = true; try { git(remote, ["merge-base", "main", "newsroom-state"]); } catch (e) { shared = false; }
    assert.equal(shared, false, "orphan: no shared history with main");
    assert.equal(r.checks.at(-1).ok, true);
  } finally { rm(remote); }
});

test("initialize on an EXISTING branch never overwrites, resets or rewrites it: old commits and files stay, history only grows (fast-forward)", () => {
  const remote = remoteWithWebsite();
  try {
    const s = new GitStateStore(remote, "newsroom-state", { createIfMissing: true });
    s.writeAtomic({ "workflow/jobs.json": { jobs: { x: { keep: true } } }, "quota-gemini.json": { v: 7 } }, "prior real state"); s.cleanup();
    const old = tip(remote);
    const r = run(remote, "initialize");
    assert.equal(r.ok, true, JSON.stringify(r.failure)); assert.equal(r.created, false);
    assert.equal(git(remote, ["merge-base", "--is-ancestor", old, "newsroom-state"]) === "", true, "old tip is an ancestor of the new tip");
    const v = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });
    try { assert.deepEqual(v.read("workflow/jobs.json"), { jobs: { x: { keep: true } } }); assert.deepEqual(v.read("quota-gemini.json"), { v: 7 }); } finally { v.cleanup(); }
    assert.equal(r.checks.some((c) => /left it untouched/.test(c.name)), true);
  } finally { rm(remote); }
});

test("a state branch that contains non-state files (e.g. website files) is refused and not modified", () => {
  const remote = remoteWithWebsite();
  try {
    git(remote, ["branch", "newsroom-state", "main"]);      // a (wrong) branch carrying the website
    const t = tip(remote);
    for (const mode of ["read-only", "verify", "initialize"]) failed(run(remote, mode), "ISOLATION_VIOLATION");
    assert.equal(tip(remote), t);
  } finally { rm(remote); }
});

test("guards: wrong repository, a remote override while a repository is pinned, a missing remote config, and a bad mode are all refused before any network use", () => {
  failed(runConnect({ mode: "verify", env: { GITHUB_REPOSITORY: "someone/else", GITHUB_TOKEN: "x", NEWSROOM_EXPECTED_REPOSITORY: "thealleghenychronicle-lab/allegheny-chronicle" } }), "WRONG_REPOSITORY");
  failed(runConnect({ mode: "verify", env: { NEWSROOM_STATE_REMOTE_URL: "/tmp/x", GITHUB_REPOSITORY: "thealleghenychronicle-lab/allegheny-chronicle", NEWSROOM_EXPECTED_REPOSITORY: "thealleghenychronicle-lab/allegheny-chronicle" } }), "REMOTE_OVERRIDE_REFUSED");
  failed(runConnect({ mode: "verify", env: {} }), "CONFIG");
  failed(runConnect({ mode: "verify", env: { GITHUB_REPOSITORY: "o/r" } }), "CONFIG");   // https remote needs a token
  failed(runConnect({ mode: "nuke", env: {} }), "BAD_MODE");
});

// ---------------------------------------------------------------- 5. real read/write persistence across separate runs
test("verify: state survives separate runs -- each run is a brand-new clone, sees earlier runs' records, and a fresh clone reads the write back", () => {
  const remote = remoteWithWebsite();
  try {
    const r1 = run(remote, "initialize", { runId: "run-1" });
    const r2 = run(remote, "verify", { runId: "run-2" });
    const r3 = run(remote, "verify", { runId: "run-3" });
    for (const r of [r1, r2, r3]) assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.equal(r1.previousRuns, 0); assert.equal(r2.previousRuns, 1); assert.equal(r3.previousRuns, 2);
    assert.equal(r3.lastVerifiedBefore.runId, "run-2");
    const s = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });
    try {
      const h = s.read(CHECK_FILE).history;
      assert.deepEqual(h.map((x) => x.runId), ["run-1", "run-2", "run-3"]);
      assert.ok(h.every((x) => x.probe && x.probe.first && x.probe.retried));
    } finally { s.cleanup(); }
    assert.deepEqual(files(remote).sort(), [".gitkeep", CHECK_FILE]);
    for (const c of ["write persisted", "concurrent writers", "left untouched"]) assert.ok(r3.checks.some((x) => x.name.includes(c)), c);
    assert.equal(r3.concurrency.staleWriterRejected, true); assert.equal(r3.concurrency.lostUpdates, 0);
  } finally { rm(remote); }
});

test("verify: history is capped so the record cannot grow without bound", () => {
  const remote = remoteWithWebsite();
  try {
    run(remote, "initialize", { runId: "r0" });
    for (let i = 1; i <= 22; i++) assert.equal(run(remote, "verify", { runId: `r${i}` }).ok, true);
    const s = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });
    try { const h = s.read(CHECK_FILE).history; assert.equal(h.length, 20); assert.equal(h.at(-1).runId, "r22"); } finally { s.cleanup(); }
  } finally { rm(remote); }
});

test("verify leaves the newsroom's own state (limiter, Neuron/quota files, jobs) byte-for-byte untouched", () => {
  const remote = remoteWithWebsite();
  try {
    const s = new GitStateStore(remote, "newsroom-state", { createIfMissing: true });
    const now = () => Date.parse("2026-10-12T12:00:00Z");
    limiter.reserveSlot(s, 3, now); limiter.reserveSlot(s, 3, now);
    s.writeAtomic({ "quota-cloudflare.json": { models: { m: { neurons: { dayStart: 1, used: 123 } } } }, "workflow/jobs.json": { jobs: {} } }, "seed"); s.cleanup();
    const blob = (f) => git(remote, ["rev-parse", `newsroom-state:${f}`]).trim();
    const before = ["article-timestamps.json", "quota-cloudflare.json", "workflow/jobs.json"].map(blob);
    const r = run(remote, "verify");
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    assert.deepEqual(["article-timestamps.json", "quota-cloudflare.json", "workflow/jobs.json"].map(blob), before);
    assert.equal(r.limiter.entries, 2); assert.deepEqual(r.quotaFiles, ["quota-cloudflare.json"]);
  } finally { rm(remote); }
});

test("CLI: exit 0 + markdown summary on success, exit 1 on failure, exit 2 on bad usage; no credential in the output; GITHUB_STEP_SUMMARY is written", () => {
  const remote = remoteWithWebsite(); const summary = path.join(tmp("nr-s5-sum-"), "summary.md");
  const cli = path.join(__dirname, "..", "state-connect.js");
  const spawnCli = (args, e) => require("child_process").spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: os.homedir(), NO_PROXY: "127.0.0.1", ...e } });
  try {
    const bad = spawnCli(["verify"], { NEWSROOM_STATE_REMOTE_URL: remote });
    assert.equal(bad.status, 1); assert.match(bad.stdout, /FAILED/); assert.match(bad.stdout, /REF_MISSING/);
    assert.equal(spawnCli(["explode"], {}).status, 2);
    const ok = spawnCli(["initialize"], { NEWSROOM_STATE_REMOTE_URL: remote, NEWSROOM_CONFIRM_INITIALIZE: "INITIALIZE", GITHUB_RUN_ID: "424242", GITHUB_STEP_SUMMARY: summary });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /PASSED/);
    assert.match(fs.readFileSync(summary, "utf8"), /Newsroom state connect: PASSED/);
    const j = spawnCli(["read-only", "--json"], { NEWSROOM_STATE_REMOTE_URL: remote });
    assert.equal(JSON.parse(j.stdout).previousRuns, 1);
  } finally { rm(remote, path.dirname(summary)); }
});

test("a token never appears in a failure report (header-only auth; redaction as a second line of defence)", () => {
  const TOKEN = "ghs_FAKEFAKEFAKEFAKE1234567890";
  const r = runConnect({ mode: "verify", env: { GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: TOKEN, NEWSROOM_STATE_REMOTE_URL: "http://127.0.0.1:1/o/r.git" } });
  assert.equal(r.ok, false);
  const dump = JSON.stringify(r) + toMarkdown(r);
  assert.ok(!dump.includes(TOKEN) && !dump.includes(Buffer.from(`x-access-token:${TOKEN}`).toString("base64")));
  const t = resolveStateRemote({ GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: TOKEN });
  assert.equal(t.remote, "https://github.com/o/r.git");                           // no credential in the URL
  assert.ok(!t.remote.includes(TOKEN));
  assert.match(t.gitEnv.GIT_CONFIG_KEY_0, /^http\.https:\/\/github\.com\/\.extraheader$/);
  let err; try { createStateStoreFromEnv({ GITHUB_REPOSITORY: "o/r" }); } catch (e) { err = e; }
  assert.match(err.message, /GITHUB_TOKEN/);                                       // https remote without a token is refused
});

// ---------------------------------------------------------------- 6. limits and claims on the git store, across separate runs and real parallel processes
const worker = (remote, action, startAt, arg = "") => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [path.join(__dirname, "helpers", "state-worker.js"), remote, action, String(startAt), arg], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
  c.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch (e) { reject(new Error(`worker output: ${out}`)); } });
});

test("concurrent claims are safe: 6 separate OS processes race to claim ONE job on the git remote -> exactly one wins", async () => {
  const remote = bare(); const s = new GitStateStore(remote); let id;
  try {
    const q = new JobQueue({ store: s, employees: loadEmployees() });
    id = q.enqueue({ title: "Race for the claim", category: "general" }).job.id;
    const startAt = Date.now() + 2500;
    const res = await Promise.all(Array.from({ length: 6 }, () => worker(remote, "claim", startAt, id)));
    assert.ok(res.every((r) => !r.threw), JSON.stringify(res));
    assert.equal(res.filter((r) => r.ok).length, 1, JSON.stringify(res));
    s.refresh();
    const job = s.read("workflow/jobs.json").jobs[id];
    assert.equal(job.state, "IN_PROGRESS");
    assert.equal(res.filter((r) => r.ok)[0].token !== undefined, true);
  } finally { rm(s, remote); }
});

test("concurrent draft reservations are safe: 6 parallel processes never exceed 3 slots; the limit is exactly 3 afterwards", async () => {
  const remote = bare(); const s = new GitStateStore(remote);
  try {
    const startAt = Date.now() + 2500;
    const res = await Promise.all(Array.from({ length: 6 }, () => worker(remote, "reserve", startAt)));
    assert.ok(res.every((r) => !r.threw), JSON.stringify(res));
    const won = res.filter((r) => r.reserved).length;
    assert.ok(won <= 3, `reserved ${won} > 3: ${JSON.stringify(res)}`);
    assert.ok(res.filter((r) => !r.reserved).every((r) => ["LIMIT_REACHED", "CONCURRENCY_RETRY_EXHAUSTED"].includes(r.reason)));
    const now = () => Date.parse("2026-10-12T12:00:00Z");
    const st = limiter.getWindowStatus(s, 3, now);
    assert.equal(st.activeInWindow, won, "durable state agrees with what the workers were told");
    for (let i = won; i < 3; i++) assert.equal(limiter.reserveSlot(s, 3, now).reserved, true);
    assert.equal(limiter.reserveSlot(s, 3, now).reserved, false);
    assert.equal(limiter.getWindowStatus(s, 3, now).activeInWindow, 3);
  } finally { rm(s, remote); }
});

test("the 3-drafts / rolling-24h limit persists across separate runs (fresh clones) and expires only after 24h", () => {
  const remote = bare(); const T = Date.parse("2026-10-12T12:00:00Z");
  try {
    const run1 = new GitStateStore(remote);
    const ids = [0, 1, 2].map((i) => limiter.reserveSlot(run1, 3, () => T + i * 2 * 3600e3));
    assert.ok(ids.every((x) => x.reserved)); ids.forEach((x) => assert.equal(limiter.completeSlot(run1, x.reservationId).ok, true)); run1.cleanup();
    const run2 = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });       // "next workflow run"
    try {
      assert.equal(limiter.getWindowStatus(run2, 3, () => T + 3600e3).activeInWindow, 3);
      const blocked = limiter.reserveSlot(run2, 3, () => T + 23 * 3600e3);
      assert.deepEqual([blocked.reserved, blocked.reason], [false, "LIMIT_REACHED"]);
      assert.equal(limiter.reserveSlot(run2, 3, () => T + 24 * 3600e3 + 5000).reserved, true, "first slot frees after 24h");
    } finally { run2.cleanup(); }
    const run3 = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });
    try { assert.equal(limiter.getWindowStatus(run3, 3, () => T + 24 * 3600e3 + 5000).activeInWindow, 3, "2 old + 1 new"); } finally { run3.cleanup(); }
  } finally { rm(remote); }
});

test("the Cloudflare Neuron budget persists across separate runs on the git store, blocks without any provider call, and resets on the next UTC day", async () => {
  const CF_ENV = { ...F.CF_ENV, NEWSROOM_API_TOKEN: "NR-FAKE" };
  const ov = config.resolveModelOverrides({ NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET: "100" });
  const registry = () => createModelRegistry({ allowedFreeModels: config.ALLOWED_FREE_MODELS, overrides: ov });
  const CF_KEY = "cloudflare:@cf/zai-org/glm-4.7-flash";
  const heavy = F.cloudflareOk("heavy", { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 });   // ~79 neurons
  const remote = bare(); const clock = F.makeClock(); clock.advance(2 * 3600e3);
  const runOnce = async (fn) => { const store = new GitStateStore(remote, "newsroom-state", { createIfMissing: remote && true }); try { return await fn(store); } finally { store.cleanup(); } };
  try {
    const r1 = await runOnce(async (store) => { const m = F.makeRouter({ registry: registry(), env: CF_ENV, stateStore: store, now: clock, handlers: { cloudflare: heavy } }); const r = await m.router.route(F.req()); return { r, calls: m.fetchImpl.calls.length }; });
    assert.equal(r1.r.ok, true); assert.equal(r1.calls, 1);
    assert.equal(r1.r.quota.evaluated.find((q) => q.key === CF_KEY).budget.usedEstimate, 79);
    // ---- a different run, brand-new clone + router: the 79 is remembered, the next request would cross 100 -> WAITING, zero calls
    const r2 = await runOnce(async (store) => { const m = F.makeRouter({ registry: registry(), env: CF_ENV, stateStore: store, now: clock, handlers: { cloudflare: heavy } }); const r = await m.router.route(F.req()); return { r, calls: m.fetchImpl.calls.length }; });
    assert.equal(r2.r.status, "WAITING"); assert.equal(r2.calls, 0, "the persisted budget stopped the call before it was sent");
    assert.ok(r2.r.routing.rejected.some((x) => x.key === CF_KEY && x.code === "NEURON_BUDGET_EXHAUSTED"));
    assert.equal(r2.r.retry.retryAt, "2026-01-02T00:00:00.000Z");
    const durable = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });
    try { assert.ok(files(remote).includes("quota-cloudflare.json")); assert.equal(durable.read("quota-cloudflare.json") !== null, true); } finally { durable.cleanup(); }
    // ---- next UTC day, yet another run: resets
    clock.advance(22 * 3600e3 + 1000);
    const r3 = await runOnce(async (store) => { const m = F.makeRouter({ registry: registry(), env: CF_ENV, stateStore: store, now: clock, handlers: { cloudflare: heavy } }); const r = await m.router.route(F.req()); return { r, calls: m.fetchImpl.calls.length }; });
    assert.equal(r3.r.ok, true); assert.equal(r3.calls, 1);
    // and none of that touched the draft limiter
    const s = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });
    try { assert.equal(limiter.getWindowStatus(s, 3, clock).activeInWindow, 0); } finally { s.cleanup(); }
  } finally { rm(remote); }
});

// ---------------------------------------------------------------- 7. static safety checks on the shipped code and workflow
const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
test("the new code contains no force-push, delete, reset-of-remote or branch-rewrite command", () => {
  for (const f of ["newsroom/state-connect.js", "newsroom/state-store.js", "newsroom/git-errors.js", "newsroom/runtime.js"]) {
    const src = read(f).replace(/\/\/.*$/gm, "");
    for (const bad of [/--force/, /push["',\s\]]+-f\b/, /--force-with-lease/, /"\+refs/, /\+HEAD:/, /--delete/, /"branch"[^)]*"-[dD]"/, /update-ref/, /filter-branch/, /--mirror/, /origin",\s*":/]) assert.ok(!bad.test(src), `${f} matches ${bad}`);
    assert.ok(!/reset["',\s]+--hard["',\s]+(origin|`origin)/.test(src.replace(/refresh\(\)[\s\S]*?\n  }/, "")) || f === "newsroom/state-store.js", `${f}: remote reset`);
  }
});

test("workflow newsroom-state-connect.yml: manual trigger only, least privilege per job, no secrets, no schedule, no provider access", () => {
  const y = read(".github/workflows/newsroom-state-connect.yml");
  const onBlock = y.match(/^on:\n((?:[ \t]+.*\n|\n)+)/m)[1];
  assert.match(onBlock, /workflow_dispatch:/);
  assert.ok(!/schedule|push:|pull_request|workflow_run|repository_dispatch|issue|release/i.test(onBlock));
  assert.ok(!/cron/.test(y));
  assert.match(y, /^permissions: \{\}$/m, "top-level permissions are empty");
  const perms = [...y.matchAll(/^\s+permissions:\n((?:\s{6,}\S.*\n)+)/gm)].map((m) => m[1].trim().split("\n").map((l) => l.trim()));
  assert.deepEqual(perms, [["contents: read"], ["contents: write"]], "exactly two jobs: read-only job + write job, each with one permission");
  assert.ok(!/secrets\.(?!GITHUB_TOKEN)/.test(y), "no secrets other than the built-in token");
  assert.ok(!/(GEMINI|OPENROUTER|CLOUDFLARE|GROQ)_/.test(y), "no provider credentials");
  assert.ok(!/\$\{\{\s*(github\.event\.inputs|inputs)\.[^}]*\}\}[^\n]*\brun:/.test(y));
  assert.ok(!/run:[^\n]*\$\{\{\s*(github\.event\.inputs|inputs)/.test(y), "inputs are passed through env, never interpolated into a shell command");
  assert.match(y, /persist-credentials:\s*false/);
  assert.match(y, /NEWSROOM_EXPECTED_REPOSITORY:\s*thealleghenychronicle-lab\/allegheny-chronicle/);
  assert.match(y, /cancel-in-progress:\s*false/);
  assert.ok(!/--force|push -f|git push|git branch|git checkout/.test(y), "the workflow itself runs no git write commands");
  assert.ok(!/content\/|public\/|wrangler|netlify/.test(y.replace(/#.*$/gm, "")));
});

test("unchanged safeguards: Groq stays out of the free allowlist, the 3/24h cap is 3, nothing here can publish", () => {
  assert.equal(config.MAX_ARTICLES_PER_ROLLING_24H, 3);
  assert.ok(!config.ALLOWED_FREE_MODELS.some((m) => /^groq/i.test(typeof m === "string" ? m : m.key || "")));
  assert.equal(config.STATE_BRANCH, "newsroom-state");
  const src = read("newsroom/state-connect.js");
  assert.ok(!/content\/articles|PRODUCTION_ARTICLES_DIR|fetch\(|require\(["']\.\/(providers|router|execution|cms|research)/.test(src), "no provider/CMS/draft/research code is reachable from state-connect");
});
