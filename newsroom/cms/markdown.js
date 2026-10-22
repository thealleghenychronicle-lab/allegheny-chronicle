// Maysoon's deterministic CMS formatter: Article -> Markdown with YAML frontmatter.
// `draft: true` is a literal in this file. There is no code path here (or in the sinks) that can emit a false draft flag.
"use strict";
const { ArticleError } = require("./article");

const FIELD_ORDER = ["title", "slug", "businessName", "location", "category", "tags", "image", "imageAlt", "author", "date", "excerpt", "featured", "trending", "editorsPick", "draft"];
// Chunk 6: quoting is chosen so the REAL site parser (scripts/lib/frontmatter.js, which strips outer quotes but never unescapes)
// and Decap's YAML both read the same value. Rule: collapse whitespace/newlines; prefer "..." with no escapes; use '...' when the
// text holds " or \\ (and no '); only if it holds both ' and (" or \\) are straight quotes turned into typographic quotes.
function oneLine(s) { return String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(); }
function smartQuotes(s) { return s.replace(/(^|[\s(\[{])"/g, "$1\u201c").replace(/"/g, "\u201d"); }
function q(raw) {
  let s = oneLine(raw);
  if (!/["\\]/.test(s)) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  s = smartQuotes(s).replace(/\\/g, "/");
  return `"${s}"`;
}
const DRAFT_LINE = "draft: true";                         // hardcoded; never built from input

// Frontmatter + body. `draft` is deliberately NOT read from the article.
function toCmsMarkdown(article) {
  if (!article || typeof article !== "object") throw new ArticleError("INVALID_ARTICLE", "article required");
  const v = {
    title: `title: ${q(article.title)}`,
    slug: `slug: ${q(article.slug)}`,
    businessName: `businessName: ${q(article.businessName)}`,
    location: `location: ${q(article.location)}`,
    category: `category: ${q(article.category)}`,
    tags: article.tags.length ? `tags:\n${article.tags.map((t) => `  - ${q(t)}`).join("\n")}` : "tags: []",   // block list = Decap's own style; commas in a tag are safe
    image: `image: ${q(article.image)}`,
    imageAlt: `imageAlt: ${q(article.imageAlt)}`,
    author: `author: ${q(article.author)}`,
    date: `date: ${article.date}`,                         // unquoted ISO, as Decap writes datetimes
    excerpt: `excerpt: ${q(article.excerpt)}`,
    featured: "featured: false",
    trending: "trending: false",
    editorsPick: "editorsPick: false",
    draft: DRAFT_LINE
  };
  const md = `---\n${FIELD_ORDER.map((k) => v[k]).join("\n")}\n---\n\n${article.body.replace(/\s+$/, "")}\n`;
  assertDraftTrue(md);
  return md;
}

function parseScalarValue(raw, key = "list item") {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1).replace(/''/g, "'");
  if (raw.startsWith('"') || raw.startsWith("[")) { try { return JSON.parse(raw); } catch (_) { throw new ArticleError("INVALID_CMS_MARKDOWN", `unparseable value for ${key}`); } }
  return raw;
}

// Minimal parser for the frontmatter we emit (and for sinks' independent guard). Not a general YAML parser.
function parseCmsMarkdown(text) {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(String(text));
  if (!m) throw new ArticleError("INVALID_CMS_MARKDOWN", "missing frontmatter block");
  const fm = {};
  let listKey = null;
  for (const line of m[1].split("\n")) {
    const li = /^\s+-\s+(.*)$/.exec(line);
    if (li && listKey) { fm[listKey].push(parseScalarValue(li[1].trim())); continue; }
    listKey = null;
    const i = line.indexOf(":");
    if (i < 1) throw new ArticleError("INVALID_CMS_MARKDOWN", `bad frontmatter line: ${line}`);
    const key = line.slice(0, i).trim(); const raw = line.slice(i + 1).trim();
    if (Object.prototype.hasOwnProperty.call(fm, key)) throw new ArticleError("INVALID_CMS_MARKDOWN", `duplicate frontmatter key: ${key}`);
    if (raw === "" ) { fm[key] = []; listKey = key; }
    else if (raw === "true") fm[key] = true;
    else if (raw === "false") fm[key] = false;
    else fm[key] = parseScalarValue(raw, key);
  }
  return { frontmatter: fm, body: m[2] };
}

// Strict guard used by the formatter AND by every sink: exactly one `draft` key and it must be boolean true.
function assertDraftTrue(text) {
  const { frontmatter } = parseCmsMarkdown(text);
  if (frontmatter.draft !== true) throw new ArticleError("DRAFT_MUST_BE_TRUE", "CMS markdown must contain draft: true");
  for (const k of FIELD_ORDER) if (!(k in frontmatter)) throw new ArticleError("INVALID_CMS_MARKDOWN", `missing required field: ${k}`);
  return true;
}

module.exports = { toCmsMarkdown, parseCmsMarkdown, assertDraftTrue, FIELD_ORDER };
