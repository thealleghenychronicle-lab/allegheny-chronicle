// Deterministic workflow state machine. Pure functions: no I/O, jobs are never mutated in place.
"use strict";
const { STATES, TRANSITIONS, HUMAN_ONLY_TARGETS, DEFAULTS } = require("./constants");

class WorkflowError extends Error {
  constructor(code, message) { super(message); this.name = "WorkflowError"; this.code = code; }
}

const iso = (ms) => new Date(ms).toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));
const isState = (s) => typeof s === "string" && Object.prototype.hasOwnProperty.call(STATES, s);

function canTransition(from, to) {
  return isState(from) && isState(to) && TRANSITIONS[from].includes(to);
}

// Throws WorkflowError (UNKNOWN_STATE | INVALID_TRANSITION | HUMAN_ACTOR_REQUIRED) unless legal.
function assertTransition(from, to, actor = null) {
  if (!isState(from)) throw new WorkflowError("UNKNOWN_STATE", `unknown state: ${String(from)}`);
  if (!isState(to)) throw new WorkflowError("UNKNOWN_STATE", `unknown state: ${String(to)}`);
  if (!TRANSITIONS[from].includes(to)) throw new WorkflowError("INVALID_TRANSITION", `illegal transition ${from} -> ${to}`);
  if (HUMAN_ONLY_TARGETS.includes(to) && !(actor && actor.type === "human" && typeof actor.id === "string" && actor.id)) {
    throw new WorkflowError("HUMAN_ACTOR_REQUIRED", `${to} can only be set by a human actor`);
  }
}

// Returns a NEW job in state `to`. `patch` fields are merged shallowly after the state change.
function applyTransition(job, to, { now, actor = null, note = null, patch = {} } = {}) {
  if (typeof now !== "number") throw new WorkflowError("INVALID_ARGUMENT", "applyTransition requires now (epoch ms)");
  assertTransition(job.state, to, actor);
  const next = clone(job);
  const at = iso(now);
  const entry = { at, from: job.state, to, stage: job.stage, assignedTo: job.assignedTo, actor: actor ? { type: actor.type, id: actor.id } : null, note };
  next.history.push(entry);
  if (next.history.length > DEFAULTS.MAX_HISTORY) next.history = next.history.slice(-DEFAULTS.MAX_HISTORY);
  next.state = to;
  next.stateEnteredAt = at;
  next.updatedAt = at;
  Object.assign(next, clone(patch));
  return next;
}

module.exports = { WorkflowError, canTransition, assertTransition, applyTransition, isState, iso, clone };
