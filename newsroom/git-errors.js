// Phase 3 / Step 5 -- classify git failures so that authentication, permission and network problems are NEVER mistaken for
// "the branch is missing" or "another writer got there first". Pure functions; no I/O. Messages are redacted before use.
"use strict";

const CODES = Object.freeze({
  REF_MISSING: "REF_MISSING",              // the remote answered and the ref is genuinely absent
  PUSH_REJECTED_NON_FF: "PUSH_REJECTED_NON_FF", // another writer got there first (the ONLY push failure that is a conflict)
  AUTH: "AUTH",                            // bad / missing / expired credentials
  PERMISSION: "PERMISSION",                // authenticated but not allowed (token scope, protection rule, ruleset)
  REPO_NOT_FOUND: "REPO_NOT_FOUND",        // wrong repository name, or the token cannot see it (GitHub answers 404 for both)
  NETWORK: "NETWORK",                      // DNS, TLS, connection, 5xx
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "UNKNOWN"
});

const RULES = [
  [CODES.REF_MISSING, /couldn't find remote ref/i],
  [CODES.PUSH_REJECTED_NON_FF, /!\s*\[rejected\][^\n]*\((fetch first|non-fast-forward)\)/i],
  [CODES.AUTH, /authentication failed|invalid username or (password|token)|bad credentials|could not read (username|password)|terminal prompts disabled|returned error: 401|http(?: error)? 401/i],
  [CODES.PERMISSION, /returned error: 403|permission to .* denied|denied to |\bGH0\d\d\b|protected branch|rule violations|repository rule|forbidden|not allowed/i],
  // Two writers pushing at the same instant: the server's ref lock loses ("cannot lock ref ... is at X but expected Y"). That is a
  // genuine race, found by running real parallel processes -- it must be retried like any other conflict, not reported as a permission error.
  [CODES.PUSH_REJECTED_NON_FF, /cannot lock ref[^\n]*but expected|is at [0-9a-f]{7,} but expected|failed to update ref/i],
  [CODES.PERMISSION, /\[remote rejected\]/i],
  [CODES.REPO_NOT_FOUND, /repository .*not found|returned error: 404|remote: repository not found/i],
  [CODES.NETWORK, /could not resolve host|failed to connect|connection (timed out|refused|reset)|operation timed out|unable to access|ssl|tls|rpc failed|early eof|unexpected disconnect|hung up unexpectedly|returned error: 5\d\d|network is unreachable|temporary failure/i]
];

const textOf = (e) => `${e && e.stderr ? e.stderr : ""}\n${e && e.message ? e.message : ""}`;

function classifyGitError(e) {
  if (e && (e.code === "ETIMEDOUT" || (e.killed && e.signal))) return CODES.TIMEOUT;
  const t = textOf(e);
  for (const [code, re] of RULES) if (re.test(t)) return code;
  return CODES.UNKNOWN;
}

// Strips anything credential-shaped. `extra` = literal secret values to remove as well.
function redact(text, extra = []) {
  let s = String(text == null ? "" : text);
  for (const v of extra) if (typeof v === "string" && v.length >= 4) s = s.split(v).join("[REDACTED]");
  return s
    .replace(/(authorization:\s*(?:basic|bearer)\s+)\S+/gi, "$1[REDACTED]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
}

// Records the classification on the original error (message/stderr untouched) and returns it for `throw`.
function annotate(e, code = classifyGitError(e)) {
  if (e && typeof e === "object" && !e.gitCode) e.gitCode = code;
  return e;
}

module.exports = { CODES, classifyGitError, redact, annotate };
