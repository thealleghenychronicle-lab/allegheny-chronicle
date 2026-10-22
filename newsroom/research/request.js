// Research Request Contract. Validates strictly: unknown top-level keys are rejected so
// callers can't smuggle provider-specific parameters through the provider-neutral layer.
// Mirrors the validation style of ../ai/request.js on purpose, at far smaller scope.
"use strict";
const crypto = require("crypto");

const MAX_QUERY_CHARS = 500;
const MAX_TOPICS = 10;
const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 50;
const TOP_LEVEL_KEYS = ["requestId", "query", "location", "topics", "dateWindow", "maxResults"];

class ResearchRequestError extends Error {
  constructor(message) { super(message); this.name = "ResearchRequestError"; }
}

function reject(msg) { throw new ResearchRequestError(msg); }
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function checkKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) reject(`${label}: unknown field "${k}"`);
}
function toEpochMs(v, label) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(n)) reject(`${label} must be an epoch-ms number or ISO date string`);
  return n;
}

// query        - required, non-empty string: what to research
// location     - optional string: place name / municipality, free text ("Allegheny County")
// topics       - optional list of strings: category tags, e.g. ["business", "sports"]
// dateWindow   - optional { from, to }: epoch-ms or ISO date strings, either or both
// maxResults   - optional integer 1..50, default 10
function createResearchRequest(input) {
  if (!isObj(input)) reject("research request must be an object");
  checkKeys(input, TOP_LEVEL_KEYS, "request");

  if (typeof input.query !== "string" || !input.query.trim()) reject("query must be a non-empty string");
  if (input.query.length > MAX_QUERY_CHARS) reject(`query exceeds ${MAX_QUERY_CHARS} characters`);

  let location = null;
  if (input.location != null) {
    if (typeof input.location !== "string" || !input.location.trim()) reject("location must be a non-empty string");
    location = input.location.trim();
  }

  let topics = [];
  if (input.topics != null) {
    if (!Array.isArray(input.topics) || input.topics.some((t) => typeof t !== "string" || !t.trim())) {
      reject("topics must be a list of non-empty strings");
    }
    if (input.topics.length > MAX_TOPICS) reject(`topics exceeds ${MAX_TOPICS} entries`);
    topics = input.topics.map((t) => t.trim());
  }

  let dateWindow = { from: null, to: null };
  if (input.dateWindow != null) {
    if (!isObj(input.dateWindow)) reject("dateWindow must be an object");
    checkKeys(input.dateWindow, ["from", "to"], "dateWindow");
    const from = toEpochMs(input.dateWindow.from, "dateWindow.from");
    const to = toEpochMs(input.dateWindow.to, "dateWindow.to");
    if (from != null && to != null && from > to) reject("dateWindow.from must not be after dateWindow.to");
    dateWindow = { from, to };
  }

  const maxResults = input.maxResults == null ? DEFAULT_MAX_RESULTS : input.maxResults;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_MAX_RESULTS) {
    reject(`maxResults must be an integer 1..${MAX_MAX_RESULTS}`);
  }

  return Object.freeze({
    requestId: input.requestId || crypto.randomUUID(),
    query: input.query.trim(),
    location,
    topics: Object.freeze(topics),
    dateWindow: Object.freeze(dateWindow),
    maxResults
  });
}

module.exports = { createResearchRequest, ResearchRequestError };
