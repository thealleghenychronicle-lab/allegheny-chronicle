// Smallest article model needed to carry a workflow result into a CMS draft.
// Field set mirrors the existing Chronicle `content/articles/*.md` frontmatter (see AI_NEWSROOM_PROJECT_HANDOFF.md).
// There is NO way to set `draft` here: an article is always a draft (draft:true is enforced again in markdown.js and the sinks).
"use strict";

class ArticleError extends Error {
  constructor(code, message) { super(message); this.name = "ArticleError"; this.code = code; }
}

// Job category -> CMS `category` label. UNVERIFIED against the live Decap config.yml; confirm at install time.
const CATEGORY_LABELS = Object.freeze({ sports: "Sports", food: "Food", general: "Business" });
const DEFAULT_LOCATION = "Pittsburgh, PA";
const MAX_SLUG = 80;
const MAX_EXCERPT = 240;

function slugify(text) {
  const s = String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, MAX_SLUG).replace(/-+$/g, "");
}

const reqStr = (v, name) => {
  if (typeof v !== "string" || !v.trim()) throw new ArticleError("INVALID_ARTICLE", `${name} must be a non-empty string`);
  return v.trim();
};
const optStr = (v, name, dflt = "") => {
  if (v == null) return dflt;
  if (typeof v !== "string") throw new ArticleError("INVALID_ARTICLE", `${name} must be a string`);
  return v.trim();
};

// Chunk 6: the real site's build (scripts/lib/markdown.js, build.js templating) does NOT escape HTML in titles/bodies, so AI-written
// text may not carry raw HTML. Plain "<" in prose ("a < b", "<$1M") is fine; only tag-like "<x", "</", "<!" is refused.
const RAW_HTML = /<[A-Za-z\/!?]/;
function noHtml(v, name) {
  const items = Array.isArray(v) ? v : [v];
  if (items.some((x) => typeof x === "string" && RAW_HTML.test(x))) throw new ArticleError("RAW_HTML_NOT_ALLOWED", `${name} contains raw HTML, which the site build does not escape`);
}

function createArticle(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ArticleError("INVALID_ARTICLE", "article input must be an object");
  // Callers may not carry a draft flag in at all, except an explicit `true`.
  if (Object.prototype.hasOwnProperty.call(input, "draft") && input.draft !== true) {
    throw new ArticleError("DRAFT_MUST_BE_TRUE", "AI-created articles are always drafts; only draft = true can be represented");
  }
  const title = reqStr(input.title, "title");
  const slug = input.slug ? reqStr(input.slug, "slug") : slugify(title);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new ArticleError("INVALID_ARTICLE", `slug is not URL-safe: "${slug}"`);
  const category = reqStr(input.category, "category");
  const body = reqStr(input.body, "body");
  const author = reqStr(input.author, "author");
  const businessName = reqStr(input.businessName, "businessName");
  let tags = input.tags == null ? [] : input.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !t.trim())) throw new ArticleError("INVALID_ARTICLE", "tags must be a list of non-empty strings");
  tags = [...new Set(tags.map((t) => t.trim()))];
  let excerpt = optStr(input.excerpt, "excerpt");
  if (!excerpt) excerpt = body.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_>`]/g, "").replace(/\s+/g, " ").trim();
  if (excerpt.length > MAX_EXCERPT) excerpt = excerpt.slice(0, MAX_EXCERPT - 1).replace(/\s+\S*$/, "") + "…";
  const date = new Date(input.date == null ? now : input.date);
  if (Number.isNaN(date.getTime())) throw new ArticleError("INVALID_ARTICLE", "date is invalid");
  noHtml([title, businessName, author, category, excerpt, body, input.location, input.imageAlt, ...tags], "article text");
  const sources = (input.sources || []).map((s) => ({ title: String(s.title || ""), url: String(s.url || ""), publisher: s.publisher == null ? null : String(s.publisher) }));
  return Object.freeze({
    title, slug, businessName,
    location: optStr(input.location, "location", DEFAULT_LOCATION) || DEFAULT_LOCATION,
    category, tags: Object.freeze(tags),
    image: optStr(input.image, "image"),          // left blank: a human adds the image in the CMS
    imageAlt: optStr(input.imageAlt, "imageAlt"),
    author, date: date.toISOString(), excerpt,
    featured: false, trending: false, editorsPick: false,   // AI never promotes an article
    draft: true,
    body,
    jobId: input.jobId == null ? null : String(input.jobId),
    writerId: input.writerId == null ? null : String(input.writerId),
    sources: Object.freeze(sources)
  });
}

module.exports = { createArticle, ArticleError, slugify, CATEGORY_LABELS, DEFAULT_LOCATION };
