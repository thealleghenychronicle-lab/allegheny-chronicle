// Test helper (run as a CHILD process): one independent "workflow run" acting on a shared git remote.
// usage: node state-worker.js <remote> <action> <startAtMs> [arg]
//   reserve <startAt>            -> limiter.reserveSlot (3/24h) at a fixed clock
//   claim   <startAt> <jobId>    -> JobQueue.claim of one job
"use strict";
const path = require("path");
const root = path.join(__dirname, "..", "..");
const { GitStateStore } = require(path.join(root, "state-store"));
const limiter = require(path.join(root, "limiter"));
const { JobQueue } = require(path.join(root, "workflow", "queue"));
const { loadEmployees } = require(path.join(root, "workflow", "handoff"));
const [remote, action, startAt, arg] = process.argv.slice(2);
const store = new GitStateStore(remote, "newsroom-state", { createIfMissing: false });
while (Date.now() < Number(startAt)) { /* start barrier: all workers fire together */ }
let out;
try {
  if (action === "reserve") out = limiter.reserveSlot(store, 3, () => Date.parse("2026-10-12T12:00:00Z"));
  else if (action === "claim") out = new JobQueue({ store, employees: loadEmployees() }).claim({ workerId: `w-${process.pid}`, jobId: arg });
  else out = { error: "bad action" };
} catch (e) { out = { threw: String(e.message).slice(0, 200), code: e.gitCode }; }
store.cleanup();
console.log(JSON.stringify(out));
