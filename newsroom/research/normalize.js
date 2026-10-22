// Deterministic normalization/dedup utilities for the Research Layer Foundation.
// Scope is intentionally narrow (Chunk 3): structural URL normalization and OBVIOUS
// duplicate detection only. No semantic/AI similarity matching -- that is later work.
"use strict";

// Fixed list of known tracking params to drop when comparing URLs. Not exhaustive by
// design; add to this list deliberately, don't try to guess every tracker.
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "mc_cid", "mc_eid", "ref", "ref_src"
]);

// Returns a lowercase, structurally-normalized string form of a URL suitable for
// equality comparison (NOT for display or for re-fetching). Falls back to a trimmed
// lowercase string if the input isn't a parseable absolute URL.
function normalizeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  let u;
  try { u = new URL(trimmed); } catch (_) { return trimmed.toLowerCase(); }

  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }

  // Decide whether to keep a trailing slash on the PATH before query params are
  // reattached (reattaching search can make the serialized URL end in a param value
  // that itself ends in "/", which would corrupt a check done after the fact).
  let pathname = u.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  u.pathname = pathname;

  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);

  return u.toString().toLowerCase();
}

// Drops obvious duplicates from a list of normalized ResearchResult objects (see
// result.js), keeping the first occurrence of each. Two results are considered the
// same story only when either is true:
//   - their normalizedUrl values are identical, or
//   - they share the same providerId AND the same provider-supplied sourceId
// Anything less certain than that is left for a later, smarter pass.
function dedupeResults(results) {
  const seenUrls = new Set();
  const seenSourceIds = new Set();
  const out = [];
  for (const r of results) {
    const urlKey = r.normalizedUrl || normalizeUrl(r.url);
    const sourceKey = r.providerId && r.sourceId ? `${r.providerId}::${r.sourceId}` : null;
    const isDup = (urlKey && seenUrls.has(urlKey)) || (sourceKey && seenSourceIds.has(sourceKey));
    if (isDup) continue;
    if (urlKey) seenUrls.add(urlKey);
    if (sourceKey) seenSourceIds.add(sourceKey);
    out.push(r);
  }
  return out;
}

module.exports = { normalizeUrl, dedupeResults };
