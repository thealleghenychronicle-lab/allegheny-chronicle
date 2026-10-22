"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { GitStateStore } = require("../state-store");
const { reserveSlot, completeSlot, releaseSlot, getWindowStatus } = require("../limiter");

function makeBareRemote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newsroom-remote-"));
  execFileSync("git", ["init", "--bare", "-q"], { cwd: dir });
  return dir;
}

test("reserves up to the max, then refuses the next", () => {
  const remote = makeBareRemote();
  const store = new GitStateStore(remote);
  const r1 = reserveSlot(store, 3);
  const r2 = reserveSlot(store, 3);
  const r3 = reserveSlot(store, 3);
  const r4 = reserveSlot(store, 3);
  assert.equal(r1.reserved, true);
  assert.equal(r2.reserved, true);
  assert.equal(r3.reserved, true);
  assert.equal(r4.reserved, false);
  assert.equal(r4.reason, "LIMIT_REACHED");
  store.cleanup();
});

test("completed entries older than the window no longer count", () => {
  const remote = makeBareRemote();
  const store = new GitStateStore(remote);
  const old = Date.now() - (25 * 60 * 60 * 1000);
  store.writeAtomic({
    "article-timestamps.json": { entries: [
      { id: "a", status: "completed", reservedAt: old },
      { id: "b", status: "completed", reservedAt: old },
      { id: "c", status: "completed", reservedAt: old }
    ]}
  }, "seed old entries");
  const status = getWindowStatus(store, 3);
  assert.equal(status.activeInWindow, 0);
  const r = reserveSlot(store, 3);
  assert.equal(r.reserved, true);
  store.cleanup();
});

test("a released slot is freed immediately for reuse", () => {
  const remote = makeBareRemote();
  const store = new GitStateStore(remote);
  reserveSlot(store, 3);
  reserveSlot(store, 3);
  const third = reserveSlot(store, 3);
  assert.equal(third.reserved, true);
  const fourth = reserveSlot(store, 3);
  assert.equal(fourth.reserved, false);
  releaseSlot(store, third.reservationId);
  const retry = reserveSlot(store, 3);
  assert.equal(retry.reserved, true);
  store.cleanup();
});

test("completeSlot marks a pending reservation as completed", () => {
  const remote = makeBareRemote();
  const store = new GitStateStore(remote);
  const r = reserveSlot(store, 3);
  const result = completeSlot(store, r.reservationId);
  assert.equal(result.ok, true);
  const status = getWindowStatus(store, 3);
  const entry = status.entries.find((e) => e.id === r.reservationId);
  assert.equal(entry.status, "completed");
  store.cleanup();
});

test("concurrent workers racing for the last slot: only one wins", () => {
  const remote = makeBareRemote();
  const workerA = new GitStateStore(remote);
  const workerB = new GitStateStore(remote);
  reserveSlot(workerA, 3);
  reserveSlot(workerA, 3);
  workerB.refresh();
  const resultA = reserveSlot(workerA, 3);
  assert.equal(resultA.reserved, true);
  const resultB = reserveSlot(workerB, 3);
  assert.equal(resultB.reserved, false);
  assert.equal(resultB.reason, "LIMIT_REACHED");
  workerA.cleanup();
  workerB.cleanup();
});
