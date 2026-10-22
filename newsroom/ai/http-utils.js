// Tolerant parsing of rate-limit headers / durations. Pure functions.
"use strict";

// "34s", "2m59.56s", "500ms", "1h", "120" (seconds), HTTP-date -> milliseconds (relative) or null.
function parseDurationMs(value, now = Date.now()) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str) * 1000);
  let total = 0, matched = false;
  const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    total += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60000 : m[2] === "h" ? n * 3600000 : n * 86400000;
  }
  if (matched) return Math.round(total);
  const date = Date.parse(str);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

// A reset value may be a duration ("30s") or an epoch (seconds or ms). Returns absolute ms epoch or null.
function parseResetToEpochMs(value, now = Date.now()) {
  if (value == null) return null;
  const str = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = parseFloat(str);
    if (n > 1e12) return Math.round(n);          // epoch ms
    if (n > 1e9) return Math.round(n * 1000);    // epoch seconds
    return now + Math.round(n * 1000);           // seconds from now
  }
  const d = parseDurationMs(str, now);
  return d == null ? null : now + d;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Reads ONLY whitelisted rate-limit headers (never auth headers). `headers` is a fetch Headers or plain object.
function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
  return null;
}

function parseRateLimitHeaders(headers, now = Date.now()) {
  if (!headers) return null;
  const retryAfterMs = parseDurationMs(readHeader(headers, "retry-after"), now);
  const remainingRequests = num(readHeader(headers, "x-ratelimit-remaining-requests"));
  const remainingTokens = num(readHeader(headers, "x-ratelimit-remaining-tokens"));
  const resetReq = parseResetToEpochMs(readHeader(headers, "x-ratelimit-reset-requests"), now);
  const resetTok = parseResetToEpochMs(readHeader(headers, "x-ratelimit-reset-tokens"), now);
  const resetGeneric = parseResetToEpochMs(readHeader(headers, "x-ratelimit-reset"), now);
  const info = { retryAfterMs, remainingRequests, remainingTokens, resetRequestsAt: resetReq, resetTokensAt: resetTok, resetAt: resetGeneric };
  const any = Object.values(info).some((v) => v !== null);
  return any ? info : null;
}

module.exports = { parseDurationMs, parseResetToEpochMs, parseRateLimitHeaders, readHeader };
