// Targeted credential guard for OUTGOING AI requests. Deliberately narrow:
// it looks only for actual secrets/credentials, never for ordinary reporting content
// (business names, public facts, source excerpts, drafts, editorial instructions all pass).
//
// Detected:
//   * exact values of configured secrets (provider keys, NEWSROOM_API_TOKEN, ...)
//   * provider key shapes (Google AIza..., Groq gsk_..., OpenRouter sk-or-...)
//   * Authorization header lines / bearer tokens that look like real tokens (long, mixed chars)
//   * "password: xxx", "api_key=xxx", "token=xxx" style assignments with a value
//   * PEM private key blocks
// A match means the request is refused BEFORE any provider is contacted. The matched text is
// never returned or logged — only a short label.
"use strict";

const SHAPES = [
  ["google_api_key", /AIza[0-9A-Za-z_\-]{30,}/],
  ["groq_api_key", /gsk_[0-9A-Za-z]{20,}/],
  ["openrouter_api_key", /sk-or-[0-9A-Za-z_\-]{16,}/],
  ["generic_secret_key", /\bsk-[0-9A-Za-z_\-]{24,}/],
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["authorization_header", /\bauthorization\s*:\s*(?:bearer|basic|token)?\s*[A-Za-z0-9._~+\/=\-]{12,}/i],
  // "Bearer <token>" only when the token looks like a credential (>=20 chars with a digit) — plain prose like
  // "bearer of bad news" must pass.
  ["bearer_token", /\bbearer\s+(?=[A-Za-z0-9._~+\/=\-]{20,})(?=[A-Za-z0-9._~+\/=\-]*\d)[A-Za-z0-9._~+\/=\-]+/i],
  // (?<![A-Za-z0-9]) instead of \b so env-style names such as CLOUDFLARE_API_TOKEN=... / GEMINI_API_KEY=... are caught too.
  ["credential_assignment", /(?<![A-Za-z0-9])(?:password|passwd|pwd|api[_-]?key|api[_-]?token|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|newsroom_api_token)\b["']?\s*[:=]\s*["']?(?!\s)[^\s"',;}{]{6,}/i]
];

const MIN_SECRET_LEN = 8;   // shorter "secrets" would cause false positives; real keys are far longer

// -> [] or [{ label }]  (never includes matched text)
function findCredentials(text, secrets = []) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= MIN_SECRET_LEN && text.includes(s)) { found.push({ label: "configured_secret_value" }); break; }
  }
  for (const [label, re] of SHAPES) if (re.test(text)) found.push({ label });
  return found;
}

function scanRequest(request, secrets = []) {
  const parts = [request.system, request.prompt];
  const labels = new Set();
  for (const p of parts) for (const f of findCredentials(p, secrets)) labels.add(f.label);
  return [...labels];
}

// Exact-value scrub for model OUTPUT (we never put secrets in prompts, so this is belt-and-braces).
function scrubExact(text, secrets = []) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const s of secrets) if (typeof s === "string" && s.length >= MIN_SECRET_LEN && out.includes(s)) out = out.split(s).join("[REDACTED]");
  return out;
}

module.exports = { findCredentials, scanRequest, scrubExact, MIN_SECRET_LEN };
