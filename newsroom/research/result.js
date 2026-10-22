// Research Result Contract. Normalizes ONE raw provider result into the shape the rest
// of the newsroom can rely on regardless of which provider produced it. Never invents
// missing information -- fields the provider didn't supply stay null (or [] for lists).
"use strict";
const { normalizeUrl } = require("./normalize");

const TOP_LEVEL_KEYS = ["title", "url", "publisher", "publishedAt", "excerpt", "sourceId", "providerId", "topics", "location"];

class ResearchResultError extends Error {
  constructor(message) { super(message); this.name = "ResearchResultError"; }
}
function reject(msg) { throw new ResearchResultError(msg); }
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function checkKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) reject(`${label}: unknown field "${k}"`);
}

// title        - required, non-empty string
// url          - required, non-empty string (the article/page URL)
// publisher    - optional string: outlet/source name, when available
// publishedAt  - optional epoch-ms number or ISO date string, when available
// excerpt      - optional string: description/summary snippet, when available
// sourceId     - optional string: provider's own stable article/story id, when available
// providerId   - which provider produced this result; usually supplied by the router,
//                but a provider may also stamp it directly
// topics       - optional list of strings: category/topic metadata, when available
// location     - optional string: location metadata, when available
function createResearchResult(input, { providerId = null } = {}) {
  if (!isObj(input)) reject("result must be an object");
  checkKeys(input, TOP_LEVEL_KEYS, "result");

  if (typeof input.title !== "string" || !input.title.trim()) reject("title must be a non-empty string");
  if (typeof input.url !== "string" || !input.url.trim()) reject("url must be a non-empty string");

  let publishedAt = null;
  if (input.publishedAt != null) {
    const n = typeof input.publishedAt === "number" ? input.publishedAt : Date.parse(input.publishedAt);
    if (!Number.isFinite(n)) reject("publishedAt must be an epoch-ms number or ISO date string");
    publishedAt = n;
  }

  let topics = [];
  if (input.topics != null) {
    if (!Array.isArray(input.topics) || input.topics.some((t) => typeof t !== "string")) reject("topics must be a list of strings");
    topics = [...input.topics];
  }

  const url = input.url.trim();
  return Object.freeze({
    title: input.title.trim(),
    url,
    normalizedUrl: normalizeUrl(url),
    publisher: input.publisher == null ? null : String(input.publisher),
    publishedAt,
    excerpt: input.excerpt == null ? null : String(input.excerpt),
    sourceId: input.sourceId == null ? null : String(input.sourceId),
    providerId: input.providerId || providerId || null,
    topics: Object.freeze(topics),
    location: input.location == null ? null : String(input.location)
  });
}

module.exports = { createResearchResult, ResearchResultError };
