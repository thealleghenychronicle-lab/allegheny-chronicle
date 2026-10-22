// Job model: a story request moving through the newsroom. This is NOT the final article model.
"use strict";
const crypto = require("crypto");
const { STATES, FIRST_STAGE, DEFAULTS, CATEGORY_WRITERS, DEFAULT_CATEGORY } = require("./constants");
const { WorkflowError, iso, clone } = require("./state-machine");
const { redactString } = require("../ai/redact");

// Story/request data: small and validated. `title` is required; everything else optional.
function normalizeRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkflowError("INVALID_REQUEST", "request must be an object");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new WorkflowError("INVALID_REQUEST", "request.title is required");
  const category = input.category == null ? DEFAULT_CATEGORY : input.category;
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_WRITERS, category)) {
    throw new WorkflowError("INVALID_REQUEST", `request.category must be one of: ${Object.keys(CATEGORY_WRITERS).join(", ")}`);
  }
  const optStr = (k) => {
    if (input[k] == null) return null;
    if (typeof input[k] !== "string") throw new WorkflowError("INVALID_REQUEST", `request.${k} must be a string`);
    return input[k].trim() || null;
  };
  return { title, category, leadUrl: optStr("leadUrl"), notes: optStr("notes"), source: optStr("source") };
}

function createJob({ request, id = null, now = Date.now(), maxFailures = DEFAULTS.MAX_FAILURES, assignedTo = null } = {}) {
  const req = normalizeRequest(request);
  if (!Number.isInteger(maxFailures) || maxFailures < 1) throw new WorkflowError("INVALID_ARGUMENT", "maxFailures must be a positive integer");
  const at = iso(now);
  return {
    schema: 1,
    id: id || `job-${crypto.randomUUID()}`,
    state: STATES.QUEUED,
    stage: FIRST_STAGE,
    assignedTo,               // employee id; filled by handoff.initialAssignment on enqueue
    writerId: null,           // set by the director (or defaulted by category) before the writer stage
    request: req,
    createdAt: at,
    updatedAt: at,
    stateEnteredAt: at,
    attempts: { claims: 0, failures: 0, maxFailures, waits: 0, lastAttemptAt: null, nextEligibleAt: null, exhausted: false },
    claim: null,              // { workerId, token, claimedAt, leaseExpiresAt } while IN_PROGRESS
    error: null,              // { code, message, at, stage, failure } of the most recent failure
    wait: null,               // { kind, reason, since, resumeAt, stage, context } while WAITING_*
    revision: { count: 0, current: null },
    data: {},                 // scratch space for later chunks' stage outputs; not interpreted here
    history: []
  };
}

function makeError({ code = "UNKNOWN", message = "", now, stage, failure }) {
  const msg = redactString(String(message || ""));
  return { code: String(code), message: msg.length > DEFAULTS.MAX_ERROR_MESSAGE ? msg.slice(0, DEFAULTS.MAX_ERROR_MESSAGE) + "..." : msg, at: iso(now), stage, failure };
}

module.exports = { createJob, normalizeRequest, makeError, clone };
