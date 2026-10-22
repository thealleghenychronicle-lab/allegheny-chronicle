// Secret redaction. Applied to every error message, log entry, and response.
"use strict";
const PATTERNS = [
  /AIza[0-9A-Za-z_\-]{20,}/g,          // Google API key shape
  /gsk_[0-9A-Za-z]{20,}/g,             // Groq key shape
  /sk-or-[0-9A-Za-z_\-]{10,}/g,        // OpenRouter key shape
  /sk-[0-9A-Za-z_\-]{20,}/g,           // generic sk- keys
  /Bearer\s+[A-Za-z0-9._\-]{8,}/gi     // Authorization header values
];
const KV_PATTERN = /((?:api[_-]?key|api[_-]?token|access[_-]?token|secret)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi;
const SENSITIVE_KEYS = /^(authorization|x-goog-api-key|x-api-key|api-key|apikey|api_key|secret|password)$/i;
const MARK = "[REDACTED]";

function redactString(str, secrets = []) {
  if (typeof str !== "string" || str.length === 0) return str;
  let out = str;
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 4 && out.includes(s)) out = out.split(s).join(MARK);
  }
  for (const re of PATTERNS) out = out.replace(re, MARK);
  out = out.replace(KV_PATTERN, `$1${MARK}`);
  return out;
}

function redactDeep(value, secrets = [], depth = 0) {
  if (depth > 8) return MARK;
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? MARK : redactDeep(v, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { redactString, redactDeep, REDACTED: MARK };
