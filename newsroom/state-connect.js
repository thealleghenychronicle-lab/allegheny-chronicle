#!/usr/bin/env node
// Phase 3 / Step 5 -- connect (and, only when explicitly asked, create) the real `newsroom-state` branch, and prove real
// read/write persistence, using the EXISTING GitStateStore. It does nothing else: no AI/research call, no draft, no schedule,
// no website file, no limiter/quota/job write.
//
//   node newsroom/state-connect.js <read-only|verify|initialize> [--json]
//     read-only   auth + branch probe + read. Writes NOTHING. Fails if the branch is missing.
//     verify      branch must already exist. Writes ONLY `connection-check.json` (write, re-clone read-back, concurrency probe).
//     initialize  like verify, but creates the orphan branch first IF (and only if) the remote positively reports it absent.
//                 Requires NEWSROOM_CONFIRM_INITIALIZE=INITIALIZE.
// Safety: never force-pushes, resets, deletes or rewrites a branch. Creation = one non-force push of a brand-new orphan commit
// containing only `.gitkeep`. Auth / permission / network failures are reported as such and are never treated as "missing".
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("./config");
const { GitStateStore } = require("./state-store");
const { resolveStateRemote } = require("./runtime");
const limiter = require("./limiter");
const { CODES, classifyGitError, redact } = require("./git-errors");

const MODES = Object.freeze(["read-only", "verify", "initialize"]);
const CHECK_FILE = "connection-check.json";
const HISTORY_CAP = 20;
const MAX_ATTEMPTS = 5;
// Files the newsroom itself owns on the state branch. The connection check must leave every one of them byte-for-byte alone.
const PROTECTED_STATE = /^(article-timestamps\.json|quota-[\w.-]+\.json|workflow\/.+\.json)$/;
const ALLOWED_FILE = /(^|\/)\.gitkeep$|\.json$/;

class ConnectError extends Error {
  constructor(stage, code, message) { super(message); this.name = "ConnectError"; this.stage = stage; this.code = code; }
}

// Asks the remote (no clone) whether refs/heads/<branch> exists. `ls-remote --exit-code` exits 2 with NO output only when the
// remote answered and nothing matched; every other failure is classified and reported as an error.
function probeRemote({ remote, branch, gitEnv = {}, timeoutMs = 60000 }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "newsroom-probe-"));
  try {
    const out = execFileSync("git", ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`], {
      cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...gitEnv, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
    });
    const hit = out.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === `refs/heads/${branch}`);
    if (hit) return { status: "exists", sha: hit[0] };
    return { status: "error", code: CODES.UNKNOWN, message: "ls-remote succeeded but returned no matching ref" };
  } catch (e) {
    const stderr = String(e.stderr || "").trim();
    if (e.status === 2 && stderr === "" && !e.killed) return { status: "missing" };
    return { status: "error", code: classifyGitError(e), message: stderr || String(e.message) };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

const attach = (remote, branch, gitEnv, createIfMissing) => new GitStateStore(remote, branch, { env: gitEnv, createIfMissing });
const snapshotProtected = (store) => Object.fromEntries(store.listFiles().filter((f) => PROTECTED_STATE.test(f)).sort().map((f) => [f, JSON.stringify(store.read(f))]));

function runConnect({ mode, env = process.env, now = () => new Date(), runId = null } = {}) {
  const checks = [];
  const report = { ok: false, mode, branch: config.STATE_BRANCH, repository: null, runId: null, created: false, checks, failure: null, startedAt: null };
  const stores = [];
  const secrets = [env.GITHUB_TOKEN, env.NEWSROOM_STATE_TOKEN].filter(Boolean);
  const pass = (name, detail = {}) => checks.push({ name, ok: true, ...detail });
  const fail = (stage, code, message) => { throw new ConnectError(stage, code, message); };
  try {
    report.startedAt = now().toISOString();
    if (!MODES.includes(mode)) fail("input", "BAD_MODE", `mode must be one of ${MODES.join(", ")}`);
    report.runId = String(runId || env.GITHUB_RUN_ID || `local-${report.startedAt}`);

    // ---- guards -------------------------------------------------------------------------------------------------------
    const branch = config.STATE_BRANCH;
    if (branch === config.PRODUCTION_BRANCH || /^(main|master|gh-pages)$/.test(branch)) fail("guard", "UNSAFE_BRANCH", "state branch must never be a production branch");
    const expected = (env.NEWSROOM_EXPECTED_REPOSITORY || "").trim();
    if (expected) {
      if ((env.NEWSROOM_STATE_REMOTE_URL || "").trim()) fail("guard", "REMOTE_OVERRIDE_REFUSED", "NEWSROOM_STATE_REMOTE_URL must not be set when NEWSROOM_EXPECTED_REPOSITORY is set");
      if ((env.GITHUB_REPOSITORY || "").trim().toLowerCase() !== expected.toLowerCase()) fail("guard", "WRONG_REPOSITORY", `running in "${env.GITHUB_REPOSITORY || "(unset)"}", expected "${expected}"`);
    }
    if (mode === "initialize" && env.NEWSROOM_CONFIRM_INITIALIZE !== "INITIALIZE") fail("guard", "CONFIRMATION_REQUIRED", "mode=initialize requires the confirmation input to be exactly INITIALIZE");
    let target;
    try { target = resolveStateRemote(env); } catch (e) { fail("config", "CONFIG", e.message); }
    report.repository = (env.GITHUB_REPOSITORY || "").trim() || "(custom remote)";
    pass("guards", { detail: `branch=${branch}; expected repository ${expected ? "matched" : "not enforced"}` });

    // ---- 1. probe: does the branch exist? (auth/permission/network can never look like "missing") ------------------------
    let probe = probeRemote({ remote: target.remote, branch, gitEnv: target.gitEnv });
    if (probe.status === "error") fail("probe", probe.code, `could not determine whether "${branch}" exists: ${probe.message}`);
    pass("remote reachable and authenticated", { detail: `branch ${probe.status}` });

    if (probe.status === "missing") {
      if (mode !== "initialize") fail("probe", CODES.REF_MISSING, `branch "${branch}" does not exist. Nothing was created. Re-run with mode=initialize to create it.`);
      // Create through the existing store. It only runs after a positive "absent" answer from the remote, and its own creation path
      // is a plain (non-force) push of one orphan commit holding only .gitkeep.
      stores.push(attach(target.remote, branch, target.gitEnv, true));
      probe = probeRemote({ remote: target.remote, branch, gitEnv: target.gitEnv });
      if (probe.status !== "exists") fail("create", probe.status === "error" ? probe.code : CODES.UNKNOWN, "branch creation was not confirmed by the remote");
      report.created = true;
      pass("branch created (orphan, non-force push)", { detail: `tip ${probe.sha.slice(0, 12)}` });
    } else if (mode === "initialize") {
      pass("branch already exists; initialize left it untouched", { detail: `tip ${probe.sha.slice(0, 12)}` });
    }
    report.tip = probe.sha;

    // ---- 2. attach with creation disabled; verify isolation ----------------------------------------------------------------
    const store = attach(target.remote, branch, target.gitEnv, false); stores.push(store);
    const files = store.listFiles();
    const stray = files.filter((f) => !ALLOWED_FILE.test(f));
    if (stray.length) fail("isolation", "ISOLATION_VIOLATION", `branch contains non-state files (first: ${stray.slice(0, 3).join(", ")}); refusing to use it. Nothing was modified.`);
    pass("branch holds state files only", { detail: `${files.length} tracked file(s); only .json/.gitkeep` });
    const before = snapshotProtected(store);
    const prev = store.read(CHECK_FILE);
    report.previousRuns = prev && Array.isArray(prev.history) ? prev.history.length : 0;
    report.lastVerifiedBefore = prev && prev.history && prev.history.length ? prev.history[prev.history.length - 1] : null;
    const w = limiter.getWindowStatus(store, config.MAX_ARTICLES_PER_ROLLING_24H);
    report.limiter = { activeInWindow: w.activeInWindow, remaining: w.remaining, max: w.maxPerWindow, entries: w.entries.length };
    report.quotaFiles = files.filter((f) => /^quota-[\w.-]+\.json$/.test(f));
    pass("read works", { detail: `${CHECK_FILE}: ${prev ? `${report.previousRuns} earlier verification(s) found` : "none yet"}; limiter read-only: ${report.limiter.activeInWindow}/${report.limiter.max} slots in use` });

    if (mode === "read-only") { report.ok = true; return finish(report, stores); }

    // ---- 3. write + independent read-back -----------------------------------------------------------------------------------
    const entry = { runId: report.runId, at: report.startedAt, mode, created: report.created };
    let written = false;
    for (let i = 0; i < MAX_ATTEMPTS && !written; i++) {
      store.refresh();
      const cur = store.read(CHECK_FILE, { schema: 1, history: [] });
      const history = [...(cur.history || []), entry].slice(-HISTORY_CAP);
      written = store.writeAtomic({ [CHECK_FILE]: { schema: 1, note: "Written only by newsroom/state-connect.js. Safe to ignore.", history } }, `state-connect: verify write (run ${report.runId})`).ok;
    }
    if (!written) fail("write", "CONCURRENCY_RETRY_EXHAUSTED", "could not write after retries (concurrent writers)");
    const reader = attach(target.remote, branch, target.gitEnv, false); stores.push(reader);
    const back = reader.read(CHECK_FILE);
    if (!back || !back.history || back.history[back.history.length - 1].runId !== report.runId) fail("readback", "READBACK_MISMATCH", "a fresh clone did not see the record just written");
    pass("write persisted; a fresh clone read it back", { detail: `${back.history.length} verification(s) on record` });

    // ---- 4. concurrency probe (real push-rejection semantics of the real remote) ---------------------------------------------
    const A = attach(target.remote, branch, target.gitEnv, false); stores.push(A);
    const B = attach(target.remote, branch, target.gitEnv, false); stores.push(B);
    const mark = (s, who) => {
      const cur = s.read(CHECK_FILE, { schema: 1, history: [] });
      const history = cur.history.map((h) => (h.runId === report.runId ? { ...h, probe: { ...(h.probe || {}), [who]: true } } : h));
      return s.writeAtomic({ [CHECK_FILE]: { ...cur, history } }, `state-connect: concurrency probe ${who} (run ${report.runId})`);
    };
    const first = mark(A, "first");
    const stale = mark(B, "stale");           // B still holds the pre-A tip, so a correct remote must reject it
    if (!first.ok) fail("concurrency", "PROBE_FIRST_WRITE_FAILED", "first concurrent writer was rejected unexpectedly");
    if (stale.ok) fail("concurrency", "STALE_WRITE_ACCEPTED", "the remote accepted a stale (non-fast-forward) write; claims would NOT be safe");
    B.refresh();
    const retried = mark(B, "retried");
    if (!retried.ok) fail("concurrency", "PROBE_RETRY_FAILED", "stale writer could not succeed after refresh");
    const verifier = attach(target.remote, branch, target.gitEnv, false); stores.push(verifier);
    const fin = verifier.read(CHECK_FILE).history.find((h) => h.runId === report.runId);
    if (!(fin && fin.probe && fin.probe.first && fin.probe.retried)) fail("concurrency", "PROBE_LOST_UPDATE", "a concurrent write was lost");
    report.concurrency = { firstWriterAccepted: true, staleWriterRejected: true, retryAfterRefreshAccepted: true, lostUpdates: 0 };
    pass("concurrent writers: stale push rejected, retry after refresh accepted, no lost update");

    // ---- 5. the newsroom's own state was not touched --------------------------------------------------------------------------
    const after = snapshotProtected(verifier);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("untouched", "PROTECTED_STATE_CHANGED", "limiter/quota/job state changed during the connection check");
    pass("limiter, quota (Neuron budget) and job state left untouched", { detail: `${Object.keys(after).length} protected file(s) identical before/after` });
    report.ok = true;
    return finish(report, stores);
  } catch (e) {
    report.ok = false;
    const code = e instanceof ConnectError ? e.code : (e && e.gitCode) || classifyGitError(e);
    const stage = e instanceof ConnectError ? e.stage : "unexpected";
    report.failure = { stage, code, message: redact(e && e.message, secrets).split("\n").slice(0, 6).join(" | ") };
    return finish(report, stores);
  }
}

function finish(report, stores) { for (const s of stores) { try { s.cleanup(); } catch (e) { /* temp dir only */ } } return report; }

function toMarkdown(r) {
  const L = [`## Newsroom state connect: ${r.ok ? "PASSED" : "FAILED"}`, "", `- mode: \`${r.mode}\` | branch: \`${r.branch}\` | repository: \`${r.repository}\` | run: \`${r.runId}\``,
    `- branch created by this run: **${r.created}**${r.tip ? ` | tip: \`${String(r.tip).slice(0, 12)}\`` : ""}`, ""];
  for (const c of r.checks) L.push(`- ✅ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  if (r.failure) L.push(`- ❌ **${r.failure.stage} / ${r.failure.code}**: ${r.failure.message}`);
  if (r.limiter) L.push("", `Limiter (read-only): ${r.limiter.activeInWindow}/${r.limiter.max} draft slots in use. Quota files present: ${r.quotaFiles.length ? r.quotaFiles.join(", ") : "none yet"}.`);
  return L.join("\n") + "\n";
}

function main(argv) {
  const mode = argv.find((a) => !a.startsWith("--"));
  if (!MODES.includes(mode)) { console.error(`usage: node newsroom/state-connect.js <${MODES.join("|")}> [--json]`); return 2; }
  const r = runConnect({ mode });
  console.log(argv.includes("--json") ? JSON.stringify(r, null, 2) : toMarkdown(r));
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, toMarkdown(r)); } catch (e) { /* summary is best-effort */ } }
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { runConnect, probeRemote, toMarkdown, MODES, CHECK_FILE, ConnectError };
