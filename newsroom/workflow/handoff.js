// Employee handoff / routing. Orchestration only: decides WHO holds a job next. It never does
// an employee's actual work (no AI calls, no research calls).
// Pipeline: News Scout -> News Director -> Research Editor -> Writer -> Fact Checker ->
//           Standards Editor -> Source Editor -> CMS Editor -> HUMAN_REVIEW
"use strict";
const fs = require("fs");
const path = require("path");
const { STATES, STAGES, STAGE_IDS, WRITER_STAGE, CMS_STAGE, REVISION_TARGET_STAGES, CATEGORY_WRITERS, DEFAULT_CATEGORY, DEFAULTS } = require("./constants");
const { WorkflowError, applyTransition, iso } = require("./state-machine");
const { makeError } = require("./job");

const DEFAULT_EMPLOYEES_DIR = path.join(__dirname, "..", "employees");
const _cache = new Map();

// Loads the existing employee profiles (newsroom/employees/*.json) into a Map(id -> profile).
function loadEmployees(dir = DEFAULT_EMPLOYEES_DIR) {
  if (_cache.has(dir)) return _cache.get(dir);
  const map = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (p && typeof p.id === "string") map.set(p.id, p);
  }
  _cache.set(dir, map);
  return map;
}

const stageIndex = (stageId) => STAGE_IDS.indexOf(stageId);
const isWriter = (p) => !!p && typeof p.position === "string" && /Writer$/.test(p.position);

function resolveWriter(job, employees = loadEmployees()) {
  const id = job.writerId || CATEGORY_WRITERS[job.request.category] || CATEGORY_WRITERS[DEFAULT_CATEGORY];
  const profile = employees.get(id);
  if (!isWriter(profile)) throw new WorkflowError("INVALID_WRITER", `${id} is not a writer employee`);
  return profile.id;
}

// Employee id responsible for `stageId` on this job.
function resolveAssignee(job, stageId, employees = loadEmployees()) {
  const idx = stageIndex(stageId);
  if (idx === -1) throw new WorkflowError("UNKNOWN_STAGE", `unknown stage: ${String(stageId)}`);
  if (stageId === WRITER_STAGE) return resolveWriter(job, employees);
  const position = STAGES[idx].position;
  const matches = [...employees.values()].filter((e) => e.position === position);
  if (matches.length !== 1) throw new WorkflowError("EMPLOYEE_RESOLUTION", `expected exactly one employee for ${position}, found ${matches.length}`);
  return matches[0].id;
}

function initialAssignment(job, employees = loadEmployees()) {
  return resolveAssignee(job, job.stage, employees);
}

const workerActor = (job) => ({ type: "worker", id: job.claim ? job.claim.workerId : "unknown" });
function requireInProgress(job) {
  if (job.state !== STATES.IN_PROGRESS) throw new WorkflowError("NOT_IN_PROGRESS", `job is ${job.state}, expected IN_PROGRESS`);
}
function clearedAttempts(job) {
  return { ...job.attempts, failures: 0, nextEligibleAt: null, exhausted: false };
}

// The current employee finished their stage. Hands the job to the next employee, or (after the
// Source Editor) to the CMS Editor, or (after the CMS Editor) to HUMAN_REVIEW -- and stops there.
function completeStage(job, { now, writerId = null, output, employees = loadEmployees() } = {}) {
  requireInProgress(job);
  const actor = workerActor(job);
  let working = job;
  if (writerId != null) {
    if (job.stage !== "news_director") throw new WorkflowError("WRITER_ASSIGNMENT_NOT_ALLOWED", "only the News Director stage assigns a writer");
    if (!isWriter(employees.get(writerId))) throw new WorkflowError("INVALID_WRITER", `${writerId} is not a writer employee`);
    working = { ...job, writerId };
  }
  const data = output === undefined ? working.data : { ...working.data, [job.stage]: output };
  const common = { claim: null, wait: null, error: null, revision: { ...working.revision, current: null }, attempts: clearedAttempts(working), writerId: working.writerId, data };

  if (job.stage === CMS_STAGE) {
    // CMS_DRAFT is recorded as a workflow state only. This chunk creates no CMS draft and does not touch the article limiter.
    const drafted = applyTransition(working, STATES.CMS_DRAFT, { now, actor, note: "cms_editor complete", patch: { ...common } });
    return applyTransition(drafted, STATES.HUMAN_REVIEW, { now, actor: { type: "system", id: "workflow" }, note: "automation stops at HUMAN_REVIEW", patch: { stage: null, assignedTo: null } });
  }
  const nextStage = STAGE_IDS[stageIndex(job.stage) + 1];
  if (!nextStage) throw new WorkflowError("UNKNOWN_STAGE", `no stage after ${job.stage}`);
  const assignedTo = resolveAssignee(working, nextStage, employees);
  const to = job.stage === "source_editor" ? STATES.READY_FOR_CMS : STATES.QUEUED;
  return applyTransition(working, to, { now, actor, note: `${job.stage} -> ${nextStage}`, patch: { ...common, stage: nextStage, assignedTo } });
}

// Park the job until research (or AI) capacity is available. Keeps stage/assignee so it resumes in place.
function enterWait(job, { kind, reason = null, resumeAt = null, context = null, now } = {}) {
  requireInProgress(job);
  const to = kind === "research" ? STATES.WAITING_FOR_RESEARCH : kind === "ai" ? STATES.WAITING_FOR_AI : null;
  if (!to) throw new WorkflowError("INVALID_WAIT_KIND", "wait kind must be 'research' or 'ai'");
  let resume = resumeAt == null ? now + DEFAULTS.WAIT_MS : (typeof resumeAt === "number" ? resumeAt : Date.parse(resumeAt));
  if (!Number.isFinite(resume)) throw new WorkflowError("INVALID_ARGUMENT", "resumeAt must be epoch ms or an ISO date");
  const wait = { kind, reason: reason == null ? null : String(reason).slice(0, DEFAULTS.MAX_ERROR_MESSAGE), since: iso(now), resumeAt: iso(resume), stage: job.stage, context: context == null ? null : JSON.parse(JSON.stringify(context)) };
  return applyTransition(job, to, { now, actor: workerActor(job), note: `waiting for ${kind}`, patch: { claim: null, wait, attempts: { ...job.attempts, waits: job.attempts.waits + 1 } } });
}

// A reviewer sends the job back to the Research Editor or the Writer. Stores why, and who asked.
function requestRevision(job, { targetStage, reason, notes = null, now, employees = loadEmployees() } = {}) {
  requireInProgress(job);
  if (!REVISION_TARGET_STAGES.includes(targetStage)) throw new WorkflowError("INVALID_REVISION_TARGET", `revision target must be one of: ${REVISION_TARGET_STAGES.join(", ")}`);
  if (stageIndex(targetStage) >= stageIndex(job.stage)) throw new WorkflowError("INVALID_REVISION_TARGET", "revision target must be an earlier stage than the current one");
  if (typeof reason !== "string" || !reason.trim()) throw new WorkflowError("INVALID_ARGUMENT", "revision reason is required");
  const assignedTo = resolveAssignee(job, targetStage, employees);
  const current = { fromStage: job.stage, requestedBy: job.assignedTo, targetStage, reason: reason.trim().slice(0, DEFAULTS.MAX_ERROR_MESSAGE), notes: notes == null ? null : String(notes).slice(0, DEFAULTS.MAX_ERROR_MESSAGE), requestedAt: iso(now) };
  return applyTransition(job, STATES.NEEDS_REVISION, { now, actor: workerActor(job), note: `revision ${job.stage} -> ${targetStage}`,
    patch: { claim: null, stage: targetStage, assignedTo, revision: { count: job.revision.count + 1, current } } });
}

module.exports = { loadEmployees, resolveAssignee, resolveWriter, initialAssignment, completeStage, enterWait, requestRevision, stageIndex, isWriter, makeError };
