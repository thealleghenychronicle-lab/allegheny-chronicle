// Workflow runner: claims a job from the existing JobQueue, runs the current employee's stage, and applies the outcome
// through the queue's existing operations (complete / wait / requestRevision / release). Deterministic given injected
// ai/research/clock. The runner can never move a job past HUMAN_REVIEW: there is no approve/publish code here, and
// jobs in HUMAN_REVIEW are not claimable.
"use strict";
const fs = require("fs");
const path = require("path");
const { HANDLERS } = require("./stages");
const { STATES, WAITING_STATES } = require("../workflow/constants");

const STANDARDS_PATH = path.join(__dirname, "..", "shared", "editorial-standards.json");
const DEFAULT_MAX_REVISIONS = 3;

class WorkflowRunner {
  constructor({ queue, ai, research, drafts, store, now = Date.now, workerId = "runner-1", maxRevisions = DEFAULT_MAX_REVISIONS, maxPerWindow = 3, log = null } = {}) {
    for (const [k, v] of Object.entries({ queue, ai, research, drafts, store })) if (!v) throw new Error(`${k} is required`);
    Object.assign(this, { queue, ai, research, drafts, store, now, workerId, maxRevisions, maxPerWindow, log });
    this.standards = JSON.parse(fs.readFileSync(STANDARDS_PATH, "utf8"));
    this.employees = queue.employees;
  }

  // Run ONE stage of one job. Returns a summary; never throws for expected conditions.
  async step({ jobId = null } = {}) {
    const claimed = this.queue.claim({ workerId: this.workerId, jobId });
    if (!claimed.ok) return { ran: false, reason: claimed.reason };
    const { token } = claimed; const job = claimed.job;
    const profile = this.employees.get(job.assignedTo);
    const handler = HANDLERS[job.stage];
    const base = { ran: true, jobId: job.id, stage: job.stage, employee: job.assignedTo };
    if (!profile || !handler) {
      this.queue.release(job.id, token, { error: { code: "NO_HANDLER", message: `no handler/employee for stage ${job.stage}` }, permanent: true });
      return { ...base, outcome: "failed", code: "NO_HANDLER" };
    }
    let outcome;
    try {
      outcome = await handler({ job, profile, employees: this.employees, standards: this.standards, ai: this.ai, research: this.research, drafts: this.drafts, store: this.store, now: this.now, maxPerWindow: this.maxPerWindow });
    } catch (e) {
      outcome = { type: "fail", error: { code: "HANDLER_EXCEPTION", message: e && e.message ? e.message : String(e) } };
    }
    const applied = this._apply(job, token, outcome);
    if (this.log) this.log({ ...base, outcome: applied.outcome, state: applied.state, code: applied.code || null });
    return { ...base, ...applied };
  }

  _apply(job, token, o) {
    const id = job.id; const q = this.queue;
    const done = (kind, r, extra = {}) => (r.ok ? { outcome: kind, state: r.job.state, nextStage: r.job.stage, ...extra } : { outcome: "queue_error", reason: r.reason, state: job.state });
    switch (o.type) {
      case "complete": return done("completed", q.complete(id, token, { output: o.output, writerId: o.writerId }));
      case "wait": return done("waiting", q.wait(id, token, { kind: o.kind, reason: o.reason, resumeAt: o.resumeAt }), { kind: o.kind });
      case "defer": return done("deferred", q.release(id, token, { retryAt: o.retryAt }), { reason: o.reason });
      case "revision":
        if (job.revision.count >= this.maxRevisions) {
          return done("failed", q.release(id, token, { error: { code: "REVISION_LIMIT_EXCEEDED", message: `revision limit (${this.maxRevisions}) reached; last request: ${o.reason}` }, permanent: true }), { code: "REVISION_LIMIT_EXCEEDED" });
        }
        return done("revision", q.requestRevision(id, token, { targetStage: o.targetStage, reason: o.reason, notes: o.notes }), { target: o.targetStage });
      default: // "fail"
        return done("failed", q.release(id, token, { error: o.error, permanent: o.permanent === true }), { code: o.error.code });
    }
  }

  // Drive one job until it can't progress right now: reaches HUMAN_REVIEW, parks (wait/backoff/deferred), or is exhausted.
  async runJob(jobId, { maxSteps = 60 } = {}) {
    const steps = [];
    for (let i = 0; i < maxSteps; i++) {
      const job = this.queue.get(jobId);
      if (!job) return { jobId, steps, stopped: "NOT_FOUND" };
      if (job.state === STATES.HUMAN_REVIEW) return { jobId, steps, stopped: "HUMAN_REVIEW", job };
      if (!this.queue.isEligible(job, this.now()) && !this.queue._leaseExpired(job, this.now())) {
        const wake = WAITING_STATES.includes(job.state) && job.wait ? job.wait.resumeAt : job.attempts.nextEligibleAt;
        return { jobId, steps, stopped: job.attempts.exhausted ? "EXHAUSTED" : "NOT_ELIGIBLE_YET", resumeAt: job.attempts.exhausted ? null : wake, job };
      }
      const s = await this.step({ jobId });
      steps.push(s);
      if (!s.ran) return { jobId, steps, stopped: s.reason, job: this.queue.get(jobId) };
    }
    return { jobId, steps, stopped: "MAX_STEPS", job: this.queue.get(jobId) };
  }
}

module.exports = { WorkflowRunner, DEFAULT_MAX_REVISIONS };
