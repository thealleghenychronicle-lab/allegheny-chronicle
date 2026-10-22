// Provider-neutral request interface. Validates strictly: unknown keys are rejected so
// nobody can smuggle provider-specific parameters (e.g. fallback model lists) through.
"use strict";
const crypto = require("crypto");
const { TASK_TYPES, CAPABILITIES } = require("./constants");

const MAX_PROMPT_CHARS = 400000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const TOP_LEVEL_KEYS = ["requestId", "taskType", "system", "prompt", "employee", "capability", "output",
  "estimatedInputTokens", "modelPreference", "generation", "retryContext"];

class RouterRequestError extends Error {
  constructor(message) { super(message); this.name = "RouterRequestError"; }
}

function reject(msg) { throw new RouterRequestError(msg); }
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function checkKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) reject(`${label}: unknown field "${k}"`);
}
function toEpochMs(v, label) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(n)) reject(`${label} must be an epoch-ms number or ISO date`);
  return n;
}
function strList(v, label) {
  if (v == null) return [];
  if (typeof v === "string") return [v];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) reject(`${label} must be a list of strings`);
  return [...v];
}

function createRequest(input, { knownEmployees = null, taskTypes = TASK_TYPES } = {}) {
  if (!isObj(input)) reject("request must be an object");
  checkKeys(input, TOP_LEVEL_KEYS, "request");

  if (typeof input.taskType !== "string" || !taskTypes.includes(input.taskType)) {
    reject(`taskType must be one of: ${taskTypes.join(", ")}`);
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim()) reject("prompt must be a non-empty string");
  const system = input.system == null ? "" : input.system;
  if (typeof system !== "string") reject("system must be a string");
  if (system.length + input.prompt.length > MAX_PROMPT_CHARS) reject(`system+prompt exceeds ${MAX_PROMPT_CHARS} characters`);

  let employeeId = null;
  if (input.employee != null) {
    employeeId = typeof input.employee === "string" ? input.employee : (isObj(input.employee) ? input.employee.id : null);
    if (typeof employeeId !== "string" || !employeeId) reject("employee must be an id string or {id}");
    if (knownEmployees && !knownEmployees.includes(employeeId)) reject(`unknown employee "${employeeId}"`);
  }

  const capability = input.capability == null ? "text" : input.capability;
  if (!CAPABILITIES.includes(capability)) reject(`capability must be one of: ${CAPABILITIES.join(", ")}`);

  const out = input.output == null ? {} : input.output;
  if (!isObj(out)) reject("output must be an object");
  checkKeys(out, ["maxTokens", "minTokens"], "output");
  const maxTokens = out.maxTokens == null ? DEFAULT_MAX_OUTPUT_TOKENS : out.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1000000) reject("output.maxTokens must be an integer 1..1000000");
  const minTokens = out.minTokens == null ? null : out.minTokens;
  if (minTokens != null && (!Number.isInteger(minTokens) || minTokens < 0 || minTokens > maxTokens)) reject("output.minTokens must be an integer 0..maxTokens");

  const est = input.estimatedInputTokens == null
    ? Math.ceil((system.length + input.prompt.length) / 4)   // deterministic heuristic, used only for pacing
    : input.estimatedInputTokens;
  if (!Number.isInteger(est) || est < 0) reject("estimatedInputTokens must be a non-negative integer");

  const pref = input.modelPreference == null ? {} : input.modelPreference;
  if (!isObj(pref)) reject("modelPreference must be an object");
  checkKeys(pref, ["prefer", "exclude", "strict"], "modelPreference");

  const gen = input.generation == null ? {} : input.generation;
  if (!isObj(gen)) reject("generation must be an object");
  checkKeys(gen, ["temperature", "topP", "stopSequences", "seed"], "generation");
  if (gen.temperature != null && !(typeof gen.temperature === "number" && gen.temperature >= 0 && gen.temperature <= 2)) reject("generation.temperature must be 0..2");
  if (gen.topP != null && !(typeof gen.topP === "number" && gen.topP >= 0 && gen.topP <= 1)) reject("generation.topP must be 0..1");
  if (gen.seed != null && !Number.isInteger(gen.seed)) reject("generation.seed must be an integer");
  const stop = gen.stopSequences == null ? null : strList(gen.stopSequences, "generation.stopSequences");
  if (stop && stop.length > 4) reject("generation.stopSequences allows at most 4 entries");

  const rc = input.retryContext == null ? {} : input.retryContext;
  if (!isObj(rc)) reject("retryContext must be an object");
  checkKeys(rc, ["attempt", "previousRequestId", "notBefore", "priorFailures"], "retryContext");
  const attempt = rc.attempt == null ? 0 : rc.attempt;
  if (!Number.isInteger(attempt) || attempt < 0) reject("retryContext.attempt must be a non-negative integer");

  return Object.freeze({
    requestId: input.requestId || crypto.randomUUID(),
    taskType: input.taskType,
    system,
    prompt: input.prompt,
    employeeId,
    capability,
    output: Object.freeze({ maxTokens, minTokens }),
    estimatedInputTokens: est,
    modelPreference: Object.freeze({
      prefer: strList(pref.prefer, "modelPreference.prefer"),
      exclude: strList(pref.exclude, "modelPreference.exclude"),
      strict: pref.strict === true
    }),
    generation: Object.freeze({
      temperature: gen.temperature == null ? null : gen.temperature,
      topP: gen.topP == null ? null : gen.topP,
      stopSequences: stop,
      seed: gen.seed == null ? null : gen.seed
    }),
    retryContext: Object.freeze({
      attempt,
      previousRequestId: rc.previousRequestId || null,
      notBefore: toEpochMs(rc.notBefore, "retryContext.notBefore"),
      priorFailures: Array.isArray(rc.priorFailures) ? rc.priorFailures.slice(0, 20) : []
    })
  });
}

module.exports = { createRequest, RouterRequestError, DEFAULT_MAX_OUTPUT_TOKENS };
