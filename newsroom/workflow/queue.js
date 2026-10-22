// Lightweight local job queue over the existing state-store interface (read / refresh / writeAtomic).
// Works with LocalStateStore (tests/dry-run) and GitStateStore alike. All jobs live in ONE file
// (workflow/jobs.json), so a claim is a single atomic compare-and-write: if two workers race, the
// store rejects the second write (conflict), that worker re-reads, and sees the job already claimed.
// No database, no scheduler, no distributed infrastructure.
"use strict";
const crypto = require("crypto");
const { STATES, CLAIMABLE_STATES, WAITING_STATES, DEFAULTS, JOBS_FILE } = require("./constants");
const { WorkflowError, applyTransition, iso, clone } = require("./state-machine");
const { createJob, makeError } = require("./job");
const handoff = require("./handoff");

const ts = (s) => (s == null ? null : Date.parse(s));

class JobQueue {
  constructor({ store, now = Date.now, employees = null, leaseMs = DEFAULTS.LEASE_MS, maxFailures = DEFAULTS.MAX_FAILURES, storeRetries = DEFAULTS.STORE_RETRIES } = {}) {
    if (!store || typeof store.read !== "function" || typeof store.writeAtomic !== "function" || typeof store.refresh !== "function") {
      throw new Error("store implementing read/refresh/writeAtomic is required");
    }
    this.store = store;
    this.now = now;
    this.employees = employees || handoff.loadEmployees();
    this.leaseMs = leaseMs;
    this.maxFailures = maxFailures;
    this.storeRetries = storeRetries;
  }

  // ---------- internals ----------
  // Read-modify-write with optimistic concurrency. fn(state, nowMs) -> { write, result }.
  // WorkflowErrors thrown by fn become { ok:false, reason } and nothing is written.
  _mutate(fn, message) {
    for (let i = 0; i < this.storeRetries; i++) {
      this.store.refresh();
      const state = this.store.read(JOBS_FILE, { jobs: {} });
      if (!state.jobs) state.jobs = {};
      let out;
      try {
        out = fn(state, this.now());
      } catch (e) {
        if (e instanceof WorkflowError) return { ok: false, reason: e.code, message: e.message };
        throw e;
      }
      if (!out.write) return out.result;
      const w = this.store.writeAtomic({ [JOBS_FILE]: state }, message);
      if (w.ok) return out.result;
      // conflict: another worker wrote first -> loop, re-read, re-evaluate
    }
    return { ok: false, reason: "CONCURRENCY_RETRY_EXHAUSTED" };
  }

  _read() {
    this.store.refresh();
    return this.store.read(JOBS_FILE, { jobs: {} }).jobs || {};
  }

  isEligible(job, nowMs = this.now()) {
    if (job.attempts.exhausted) return false;
    if (!CLAIMABLE_STATES.includes(job.state)) return false;
    if (job.attempts.nextEligibleAt && ts(job.attempts.nextEligibleAt) > nowMs) return false;
    if (WAITING_STATES.includes(job.state) && job.wait && ts(job.wait.resumeAt) > nowMs) return false;
    return true;
  }
  _leaseExpired(job, nowMs) { return job.state === STATES.IN_PROGRESS && job.claim && ts(job.claim.leaseExpiresAt) <= nowMs; }

  // Moves an IN_PROGRESS job back to QUEUED. With `error` it counts as a failed attempt (backoff,
  // possibly exhausted); without, it is a plain release.
  _release(job, { error = null, backoff = true, permanent = false, retryAt = null, now, actor, note }) {
    const patch = { claim: null };
    const attempts = { ...job.attempts };
    if (error) {
      attempts.failures += 1;
      patch.error = makeError({ ...error, now, stage: job.stage, failure: attempts.failures });
      if (permanent || attempts.failures >= attempts.maxFailures) attempts.exhausted = true;
      attempts.nextEligibleAt = backoff && !attempts.exhausted
        ? iso(now + Math.min(DEFAULTS.BACKOFF_MAX_MS, DEFAULTS.BACKOFF_BASE_MS * 2 ** (attempts.failures - 1))) : null;
    }
    // Chunk 5: a plain release may schedule when the job becomes eligible again (e.g. CMS draft limiter full). Not a failure.
    if (!error && retryAt != null) attempts.nextEligibleAt = iso(retryAt);
    patch.attempts = attempts;
    return applyTransition(job, STATES.QUEUED, { now, actor, note, patch });
  }
  _sweepExpired(state, now) {
    let changed = false;
    for (const [id, job] of Object.entries(state.jobs)) {
      if (this._leaseExpired(job, now)) {
        state.jobs[id] = this._release(job, { error: { code: "LEASE_EXPIRED", message: `lease held by ${job.claim.workerId} expired` }, backoff: false, now, actor: { type: "system", id: "queue" }, note: "lease expired" });
        changed = true;
      }
    }
    return changed;
  }
  _held(state, id, token) {
    const job = state.jobs[id];
    if (!job) throw new WorkflowError("NOT_FOUND", `no such job: ${id}`);
    if (job.state !== STATES.IN_PROGRESS || !job.claim) throw new WorkflowError("NOT_CLAIMED", `job is ${job.state}, not claimed`);
    if (typeof token !== "string" || job.claim.token !== token) throw new WorkflowError("CLAIM_MISMATCH", "claim token does not match the current claim");
    return job;
  }
  _sorted(jobs) { return jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)); }

  // ---------- public API ----------
  enqueue(request, { id = null, maxFailures = this.maxFailures } = {}) {
    return this._mutate((state, now) => {
      const job = createJob({ request, id, now, maxFailures });
      if (state.jobs[job.id]) throw new WorkflowError("DUPLICATE_ID", `job already exists: ${job.id}`);
      job.assignedTo = handoff.initialAssignment(job, this.employees);
      state.jobs[job.id] = job;
      return { write: true, result: { ok: true, job: clone(job) } };
    }, "enqueue job");
  }

  get(id) { const j = this._read()[id]; return j ? clone(j) : null; }
  list({ state = null } = {}) { return this._sorted(Object.values(this._read()).filter((j) => !state || j.state === state)).map(clone); }

  // Read-only: jobs a worker could claim right now (oldest first), optionally for one employee.
  getEligible({ assignedTo = null, limit = 1 } = {}) {
    const now = this.now();
    return this._sorted(Object.values(this._read()).filter((j) => (this.isEligible(j, now) || this._leaseExpired(j, now)) && (!assignedTo || j.assignedTo === assignedTo)))
      .slice(0, limit).map(clone);
  }

  // Claim one job (by id, or the oldest eligible). Exactly one concurrent claimer wins.
  claim({ workerId, jobId = null, assignedTo = null } = {}) {
    if (typeof workerId !== "string" || !workerId) return { ok: false, reason: "INVALID_ARGUMENT", message: "workerId is required" };
    return this._mutate((state, now) => {
      const swept = this._sweepExpired(state, now);
      const fail = (reason) => ({ write: swept, result: { ok: false, reason } });
      let job;
      if (jobId) {
        job = state.jobs[jobId];
        if (!job) return fail("NOT_FOUND");
        if (job.state === STATES.IN_PROGRESS) return fail("ALREADY_CLAIMED");
        if (!this.isEligible(job, now)) return fail("NOT_ELIGIBLE");
        if (assignedTo && job.assignedTo !== assignedTo) return fail("NOT_ELIGIBLE");
      } else {
        job = this._sorted(Object.values(state.jobs).filter((j) => this.isEligible(j, now) && (!assignedTo || j.assignedTo === assignedTo)))[0];
        if (!job) return fail("NO_ELIGIBLE_JOB");
      }
      const token = crypto.randomUUID();
      const claim = { workerId, token, claimedAt: iso(now), leaseExpiresAt: iso(now + this.leaseMs) };
      const claimed = applyTransition(job, STATES.IN_PROGRESS, { now, actor: { type: "worker", id: workerId }, note: `claimed from ${job.state}`,
        patch: { claim, wait: null, attempts: { ...job.attempts, claims: job.attempts.claims + 1, lastAttemptAt: iso(now), nextEligibleAt: null } } });
      state.jobs[job.id] = claimed;
      return { write: true, result: { ok: true, job: clone(claimed), token } };
    }, "claim job");
  }

  // Claim holder merges story-scratch data (and extends its lease).
  update(id, token, { data = {} } = {}) {
    return this._mutate((state, now) => {
      const job = this._held(state, id, token);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new WorkflowError("INVALID_ARGUMENT", "data must be an object");
      const next = clone(job);
      next.data = { ...next.data, ...clone(data) };
      next.claim.leaseExpiresAt = iso(now + this.leaseMs);
      next.updatedAt = iso(now);
      state.jobs[id] = next;
      return { write: true, result: { ok: true, job: clone(next) } };
    }, "update job");
  }

  _op(id, token, message, build) {
    return this._mutate((state, now) => {
      const job = this._held(state, id, token);
      const next = build(job, now);
      state.jobs[id] = next;
      return { write: true, result: { ok: true, job: clone(next) } };
    }, message);
  }
  complete(id, token, opts = {}) { return this._op(id, token, "complete stage", (job, now) => handoff.completeStage(job, { ...opts, now, employees: this.employees })); }
  wait(id, token, opts = {}) { return this._op(id, token, "job waiting", (job, now) => handoff.enterWait(job, { ...opts, now })); }
  requestRevision(id, token, opts = {}) { return this._op(id, token, "job needs revision", (job, now) => handoff.requestRevision(job, { ...opts, now, employees: this.employees })); }
  // Retry/release. With `error` -> counts as a failed attempt (backoff; exhausted at maxFailures). Without -> plain release.
  // Chunk 5 options: `permanent` (with error) exhausts at once; `retryAt` (no error) defers eligibility without a failure.
  release(id, token, { error = null, permanent = false, retryAt = null } = {}) {
    return this._op(id, token, "release job", (job, now) => this._release(job, { error, permanent, retryAt, now, actor: { type: "worker", id: job.claim.workerId }, note: error ? "released after failure" : "released" }));
  }

  // Operator action: clear an exhausted job's retry counters so it can be claimed again.
  resetRetries(id) {
    return this._mutate((state, now) => {
      const job = state.jobs[id];
      if (!job) throw new WorkflowError("NOT_FOUND", `no such job: ${id}`);
      if (job.state !== STATES.QUEUED) throw new WorkflowError("INVALID_STATE", "only QUEUED jobs can have retries reset");
      const next = clone(job);
      next.attempts = { ...next.attempts, failures: 0, exhausted: false, nextEligibleAt: null };
      next.updatedAt = iso(now);
      state.jobs[id] = next;
      return { write: true, result: { ok: true, job: clone(next) } };
    }, "reset retries");
  }

  // The ONLY way out of HUMAN_REVIEW. Requires an explicit human actor; automation cannot approve or reject.
  humanDecision(id, { decision, actor } = {}) {
    return this._mutate((state, now) => {
      const job = state.jobs[id];
      if (!job) throw new WorkflowError("NOT_FOUND", `no such job: ${id}`);
      const to = decision === "approve" ? STATES.HUMAN_APPROVED : decision === "reject" ? STATES.HUMAN_REJECTED : null;
      if (!to) throw new WorkflowError("INVALID_ARGUMENT", "decision must be 'approve' or 'reject'");
      const next = applyTransition(job, to, { now, actor, note: `human ${decision}` });
      state.jobs[id] = next;
      return { write: true, result: { ok: true, job: clone(next) } };
    }, "human decision");
  }
}

module.exports = { JobQueue };
