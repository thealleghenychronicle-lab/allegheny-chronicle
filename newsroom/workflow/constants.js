// Workflow constants: approved states, legal transitions, and the employee handoff pipeline.
// Pure data. No I/O, no AI calls, no secrets.
"use strict";
const freeze = Object.freeze;

const STATES = freeze({
  QUEUED: "QUEUED",
  IN_PROGRESS: "IN_PROGRESS",
  WAITING_FOR_RESEARCH: "WAITING_FOR_RESEARCH",
  WAITING_FOR_AI: "WAITING_FOR_AI",
  NEEDS_REVISION: "NEEDS_REVISION",
  READY_FOR_CMS: "READY_FOR_CMS",
  CMS_DRAFT: "CMS_DRAFT",
  HUMAN_REVIEW: "HUMAN_REVIEW",
  HUMAN_REJECTED: "HUMAN_REJECTED",
  HUMAN_APPROVED: "HUMAN_APPROVED"
});
const S = STATES;

// from -> allowed next states. Anything not listed is rejected.
const TRANSITIONS = freeze({
  [S.QUEUED]: freeze([S.IN_PROGRESS]),
  [S.IN_PROGRESS]: freeze([S.QUEUED, S.WAITING_FOR_RESEARCH, S.WAITING_FOR_AI, S.NEEDS_REVISION, S.READY_FOR_CMS, S.CMS_DRAFT]),
  [S.WAITING_FOR_RESEARCH]: freeze([S.IN_PROGRESS, S.QUEUED]),
  [S.WAITING_FOR_AI]: freeze([S.IN_PROGRESS, S.QUEUED]),
  [S.NEEDS_REVISION]: freeze([S.IN_PROGRESS, S.QUEUED]),
  [S.READY_FOR_CMS]: freeze([S.IN_PROGRESS]),
  [S.CMS_DRAFT]: freeze([S.HUMAN_REVIEW]),
  [S.HUMAN_REVIEW]: freeze([S.HUMAN_APPROVED, S.HUMAN_REJECTED]),
  [S.HUMAN_REJECTED]: freeze([]),
  [S.HUMAN_APPROVED]: freeze([])
});

// Only a human actor may enter these. Automation can never approve or reject.
const HUMAN_ONLY_TARGETS = freeze([S.HUMAN_APPROVED, S.HUMAN_REJECTED]);
const TERMINAL_STATES = freeze([S.HUMAN_REJECTED, S.HUMAN_APPROVED]);
// States where a job is parked until a time passes (resumeAt) or a worker picks it up.
const WAITING_STATES = freeze([S.WAITING_FOR_RESEARCH, S.WAITING_FOR_AI]);
// States from which a worker may claim a job (subject to eligibility timing).
const CLAIMABLE_STATES = freeze([S.QUEUED, S.WAITING_FOR_RESEARCH, S.WAITING_FOR_AI, S.NEEDS_REVISION, S.READY_FOR_CMS]);
// The automated workflow never moves a job beyond this state.
const AUTOMATION_STOP_STATE = S.HUMAN_REVIEW;

// Handoff pipeline, in order. `position` must match an employee profile's `position`.
// WRITER is resolved per story (see handoff.js) to Zaydan / Riham / Lubna.
const WRITER_STAGE = "writer";
const STAGES = freeze([
  freeze({ id: "news_scout", position: "News Scout" }),
  freeze({ id: "news_director", position: "News Director" }),
  freeze({ id: "research_editor", position: "Research Editor" }),
  freeze({ id: WRITER_STAGE, position: "WRITER" }),
  freeze({ id: "fact_checker", position: "Fact Checker" }),
  freeze({ id: "standards_editor", position: "Standards Editor" }),
  freeze({ id: "source_editor", position: "Source Editor" }),
  freeze({ id: "cms_editor", position: "CMS Editor" })
]);
const STAGE_IDS = freeze(STAGES.map((s) => s.id));
const FIRST_STAGE = STAGES[0].id;
const CMS_STAGE = "cms_editor";
// A reviewer may send a job back to these stages only.
const REVISION_TARGET_STAGES = freeze(["research_editor", WRITER_STAGE]);

// Story category -> writer employee id (validated against employee profiles at use).
const CATEGORY_WRITERS = freeze({ sports: "zaydan", food: "riham", general: "lubna" });
const DEFAULT_CATEGORY = "general";

const DEFAULTS = freeze({
  LEASE_MS: 10 * 60 * 1000,        // claim lease; a crashed worker's job becomes reclaimable after this
  MAX_FAILURES: 5,                 // failed attempts before a job stops being eligible
  BACKOFF_BASE_MS: 30 * 1000,      // retry delay = base * 2^(failures-1), capped
  BACKOFF_MAX_MS: 30 * 60 * 1000,
  WAIT_MS: 15 * 60 * 1000,         // default park time for WAITING_* when no resumeAt is supplied
  STORE_RETRIES: 8,                // optimistic-concurrency retries per queue operation
  MAX_HISTORY: 200,
  MAX_ERROR_MESSAGE: 500
});

const JOBS_FILE = "workflow/jobs.json";

module.exports = {
  STATES, TRANSITIONS, HUMAN_ONLY_TARGETS, TERMINAL_STATES, WAITING_STATES, CLAIMABLE_STATES, AUTOMATION_STOP_STATE,
  STAGES, STAGE_IDS, FIRST_STAGE, WRITER_STAGE, CMS_STAGE, REVISION_TARGET_STAGES,
  CATEGORY_WRITERS, DEFAULT_CATEGORY, DEFAULTS, JOBS_FILE
};
