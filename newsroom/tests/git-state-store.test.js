"use strict";
// Chunk 6 -- offline validation of the git-backed `newsroom-state` store design.
// The "remote" is a throwaway LOCAL bare repository in the OS temp dir (never GitHub, never a network URL).
// Verifies behaviours the production design relies on: orphan state branch, push-rejection == conflict signal,
// refresh-and-retry, limiter + job queue + full workflow running together on the git store, and branch isolation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { GitStateStore } = require("../state-store");
const { JobQueue } = require("../workflow/queue");
const { loadEmployees } = require("../workflow/handoff");
const limiter = require("../limiter");
const { buildHarness, runToHumanReview, makeClock } = require("../execution/harness");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
function bareRemote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newsroom-remote-"));
  git(dir, ["init", "--bare", "-q"]);
  assert.ok(path.isAbsolute(dir) && !/^[a-z]+:\/\//i.test(dir), "remote must be a local path");
  return dir;
}
const cleanup = (...xs) => xs.forEach((x) => (typeof x === "string" ? fs.rmSync(x, { recursive: true, force: true }) : x.cleanup()));
const branches = (remote) => git(remote, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).trim().split("\n").filter(Boolean);

test("git store: first use creates the orphan `newsroom-state` branch on an empty remote; later stores attach to it", () => {
  const remote = bareRemote(); const a = new GitStateStore(remote); const b = new GitStateStore(remote);
  try {
    assert.deepEqual(branches(remote), ["newsroom-state"]);
    assert.equal(git(remote, ["rev-list", "--count", "newsroom-state"]).trim(), "1");   // single init commit, b did not re-init
    assert.equal(a.read("missing.json", "fb"), "fb");
  } finally { cleanup(a, b, remote); }
});

test("git store: write/read/refresh round trip across two workers; JSON files only", () => {
  const remote = bareRemote(); const a = new GitStateStore(remote); const b = new GitStateStore(remote);
  try {
    assert.deepEqual(a.writeAtomic({ "workflow/jobs.json": { jobs: { x: 1 } }, "nested/dir/other.json": { ok: true } }, "two files, one commit"), { ok: true });
    assert.equal(b.read("workflow/jobs.json"), null);                 // not visible until refresh
    b.refresh();
    assert.deepEqual(b.read("workflow/jobs.json"), { jobs: { x: 1 } });
    assert.deepEqual(b.read("nested/dir/other.json"), { ok: true });
    assert.equal(git(remote, ["rev-list", "--count", "newsroom-state"]).trim(), "2");   // the two-file write was ONE commit (atomic)
  } finally { cleanup(a, b, remote); }
});

test("git store: a stale writer is rejected (non-fast-forward = conflict), loses nothing, and succeeds after refresh", () => {
  const remote = bareRemote(); const a = new GitStateStore(remote); const b = new GitStateStore(remote);
  try {
    assert.equal(a.writeAtomic({ "n.json": { v: 1 } }, "a1").ok, true);
    const r = b.writeAtomic({ "n.json": { v: "b-stale" } }, "b stale");   // b never refreshed
    assert.deepEqual(r, { ok: false, conflict: true });
    b.refresh();
    assert.deepEqual(b.read("n.json"), { v: 1 });                         // a's data intact, b's rejected write gone locally
    assert.equal(b.writeAtomic({ "n.json": { v: 2 } }, "b2").ok, true);
    a.refresh(); assert.deepEqual(a.read("n.json"), { v: 2 });
    assert.equal(git(remote, ["log", "--format=%s", "newsroom-state"]).includes("b stale"), false);
  } finally { cleanup(a, b, remote); }
});

test("limiter over git store: two workers never exceed 3 slots; release frees one; complete is visible to the other worker", () => {
  const remote = bareRemote(); const a = new GitStateStore(remote); const b = new GitStateStore(remote);
  const T = Date.parse("2026-10-04T16:00:00.000Z"); const now = () => T;
  try {
    const got = [];
    for (let i = 0; i < 6; i++) got.push(limiter.reserveSlot(i % 2 ? a : b, 3, now));
    assert.equal(got.filter((g) => g.reserved).length, 3);
    assert.ok(got.filter((g) => !g.reserved).every((g) => g.reason === "LIMIT_REACHED"));
    const ids = got.filter((g) => g.reserved).map((g) => g.reservationId);
    assert.equal(limiter.completeSlot(a, ids[0]).ok, true);
    assert.equal(limiter.releaseSlot(b, ids[1]).ok, true);
    const st = limiter.getWindowStatus(a, 3, now);
    assert.equal(st.activeInWindow, 2); assert.equal(st.remaining, 1);
    assert.equal(limiter.reserveSlot(b, 3, now).reserved, true);
    assert.equal(limiter.reserveSlot(a, 3, now).reserved, false);
    assert.equal(limiter.getWindowStatus(b, 3, () => T + 25 * 3600 * 1000).activeInWindow, 0);
  } finally { cleanup(a, b, remote); }
});

test("job queue over git store: duplicate-claim safe across workers, state persists in the remote", () => {
  const remote = bareRemote(); const a = new GitStateStore(remote); const b = new GitStateStore(remote);
  const employees = loadEmployees(); const clock = makeClock();
  try {
    const qa = new JobQueue({ store: a, now: clock, employees }); const qb = new JobQueue({ store: b, now: clock, employees });
    const id = qa.enqueue({ title: "Git store job", category: "general" }).job.id;
    const c1 = qa.claim({ workerId: "w-a", jobId: id }); const c2 = qb.claim({ workerId: "w-b", jobId: id });
    assert.equal(c1.ok, true); assert.equal(c2.ok, false); assert.equal(c2.reason, "ALREADY_CLAIMED");
    assert.equal(qa.complete(id, c1.token, {}).ok, true);
    const fresh = new GitStateStore(remote);
    try { assert.ok(fresh.read("workflow/jobs.json").jobs[id]); } finally { fresh.cleanup(); }
  } finally { cleanup(a, b, remote); }
});

test("FULL workflow QUEUED -> HUMAN_REVIEW runs on the git store with queue + limiter together; remote holds only state JSON on newsroom-state", async () => {
  const remote = bareRemote(); const store = new GitStateStore(remote);
  try {
    const h = buildHarness({ store, scenario: { badFirstDraft: true }, research: { failTimes: 1 } });
    const id = h.queue.enqueue({ title: "Git store full run", category: "sports" }).job.id;
    const res = await runToHumanReview(h, id);
    assert.equal(res.stopped, "HUMAN_REVIEW");
    assert.equal(h.queue.get(id).state, "HUMAN_REVIEW");
    assert.equal(limiter.getWindowStatus(store, 3, h.now).activeInWindow, 1);
    // a brand-new reader sees the same durable state
    const other = new GitStateStore(remote);
    try {
      assert.equal(other.read("workflow/jobs.json").jobs[id].state, "HUMAN_REVIEW");
      assert.equal(other.read("article-timestamps.json").entries.filter((e) => e.status === "completed").length, 1);
    } finally { other.cleanup(); }
    // isolation: only the state branch exists; only .json/.gitkeep files; no article content ever lands there
    assert.deepEqual(branches(remote), ["newsroom-state"]);
    const files = git(remote, ["ls-tree", "-r", "--name-only", "newsroom-state"]).trim().split("\n");
    assert.ok(files.every((f) => f === ".gitkeep" || f.endsWith(".json")), files.join(","));
    assert.ok(!files.some((f) => /content\/articles|\.md$/.test(f)));
  } finally { cleanup(store, remote); }
});
