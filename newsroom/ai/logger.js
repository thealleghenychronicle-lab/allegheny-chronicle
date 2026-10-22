// Structured, redacting logger. Buffers in memory; prints nothing unless a sink is given.
// Prompts and generated content are never logged — only metadata.
"use strict";
const { redactDeep } = require("./redact");

function createLogger({ sink = null, secrets = () => [], maxBuffer = 500, now = Date.now } = {}) {
  const buffer = [];
  function log(level, event, fields = {}) {
    const entry = { ts: new Date(now()).toISOString(), level, event, ...redactDeep(fields, secrets()) };
    buffer.push(entry);
    if (buffer.length > maxBuffer) buffer.shift();
    if (typeof sink === "function") {
      try { sink(JSON.stringify(entry)); } catch (_) { /* logging must never break routing */ }
    }
    return entry;
  }
  return {
    info: (e, f) => log("info", e, f),
    warn: (e, f) => log("warn", e, f),
    error: (e, f) => log("error", e, f),
    entries: () => buffer.slice(),
    dump: () => JSON.stringify(buffer)
  };
}

module.exports = { createLogger };
