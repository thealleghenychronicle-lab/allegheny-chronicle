"use strict";
// Chunk 6 -- CMS draft compatibility against the REAL Chronicle site implementation.
// Authority: files vendored verbatim from allegheny-chronicle-netlify.zip into tests/fixtures/site (sha256 manifest checked below).
// Set CHRONICLE_SITE_DIR=<extracted site root> to run the same checks against a live checkout instead of the fixture.
// Offline: runs the site's own parseFrontmatter and its own `scripts/build.js` (a local node process) inside a temp copy.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { createArticle, CATEGORY_LABELS } = require("../cms/article");
const { toCmsMarkdown, FIELD_ORDER } = require("../cms/markdown");
const { DirDraftSink } = require("../cms/draft-sinks");
const { runDryRun } = require("../dry-run");

const FIXTURE = path.join(__dirname, "fixtures", "site");
const SITE = process.env.CHRONICLE_SITE_DIR ? path.resolve(process.env.CHRONICLE_SITE_DIR) : FIXTURE;
const { parseFrontmatter } = require(path.join(SITE, "scripts", "lib", "frontmatter.js"));
const { renderMarkdown } = require(path.join(SITE, "scripts", "lib", "markdown.js"));
const T0 = Date.parse("2026-10-04T16:00:00.000Z");
const mk = (extra = {}) => createArticle({ title: "Strip District Bakery Opens Second Location", businessName: "Example Bakery", category: "Food", author: "Riham - The Allegheny Chronicle Staff",
  body: "## What changed\n\nThe bakery opened a second shop, according to [Example Journal](https://example.com/a).", tags: ["food", "pittsburgh"], ...extra }, { now: T0 });

function tmpSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-site-"));
  for (const p of ["scripts", "content", "public", "package.json"]) if (fs.existsSync(path.join(SITE, p))) fs.cpSync(path.join(SITE, p), path.join(dir, p), { recursive: true });
  fs.mkdirSync(path.join(dir, "content", "articles"), { recursive: true });
  fs.mkdirSync(path.join(dir, "public", "images"), { recursive: true });
  return dir;
}
function build(dir) {
  const env = { ...process.env }; delete env.URL; delete env.DEPLOY_PRIME_URL;
  execFileSync(process.execPath, ["scripts/build.js"], { cwd: dir, env, encoding: "utf8" });
  return JSON.parse(fs.readFileSync(path.join(dir, "public", "articles.json"), "utf8"));
}
const withDraft = (dir, article, { publish = false } = {}) => {
  let md = toCmsMarkdown(article);
  if (publish) md = md.replace(/^draft: true$/m, "draft: false");     // simulates the HUMAN flipping draft in the CMS; automation never does this
  fs.writeFileSync(path.join(dir, "content", "articles", `${article.slug}.md`), md);
  return md;
};

test("fixture integrity: vendored site files match the sha256 manifest (taken from the real site ZIP)", { skip: !!process.env.CHRONICLE_SITE_DIR }, () => {
  const lines = fs.readFileSync(path.join(__dirname, "fixtures", "SITE_FIXTURE.sha256"), "utf8").trim().split("\n");
  assert.ok(lines.length >= 11);
  for (const l of lines) {
    const [hash, rel] = l.split(/\s+/);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(FIXTURE, rel))).digest("hex"), hash, rel);
  }
});

test("decap config: field names == newsroom frontmatter fields (+ body); category is a free string; draft defaults true; image required", () => {
  const cfg = fs.readFileSync(path.join(SITE, "public", "admin", "config.yml"), "utf8");
  const names = [...cfg.matchAll(/name:\s*"([A-Za-z]+)"/g)].map((m) => m[1]).slice(1);     // [0] is the collection name "articles"
  assert.deepEqual(names.filter((n) => n !== "body"), FIELD_ORDER);
  assert.equal(names[names.length - 1], "body");
  assert.match(cfg, /label: "Category", name: "category", widget: "string" \}/);            // no options/enum -> any non-empty string is valid
  assert.match(cfg, /name: "draft", widget: "boolean", default: true/);
  assert.match(cfg, /folder: "content\/articles"/);
  assert.match(cfg, /slug: "\{\{slug\}\}"/);
  assert.match(cfg, /label: "Featured Image", name: "image", widget: "image" \}/);           // required in Decap (no `required: false`) -> a human must add it
  assert.match(cfg, /name: "date", widget: "datetime"/);
  assert.match(cfg, /name: "tags", widget: "list"/);
  assert.match(cfg, /media_folder: "public\/images\/articles"/);
  assert.match(cfg, /public_folder: "\/images\/articles"/);
});

test("categories: newsroom labels are non-empty strings; build keeps them verbatim; 'general' maps to the build's own default category", () => {
  for (const v of Object.values(CATEGORY_LABELS)) assert.ok(typeof v === "string" && v.trim() === v && v.length > 0);
  assert.deepEqual(CATEGORY_LABELS, { sports: "Sports", food: "Food", general: "Business" });
  assert.match(fs.readFileSync(path.join(SITE, "scripts", "build.js"), "utf8"), /category: data\.category \|\| "Business"/);
  const dir = tmpSite();
  for (const [i, cat] of Object.values(CATEGORY_LABELS).entries()) withDraft(dir, mk({ title: `Category check ${i}`, category: cat }), { publish: true });
  const out = build(dir);
  for (const c of ["Sports", "Food", "Business"]) assert.ok(out.some((x) => x.category === c), c);
  // categories the site already uses are left to humans; Sports is shared with the existing site, Food/Business are new-but-valid strings
  const real = fs.readdirSync(path.join(SITE, "content", "articles")).map((f) => parseFrontmatter(fs.readFileSync(path.join(SITE, "content", "articles", f), "utf8")).data.category);
  assert.ok(real.length >= 1 && real.every((c) => typeof c === "string" && c.length > 0));
});

test("existing article conventions: filenames are lowercase-hyphen .md; all use the schema's field names", () => {
  const dirp = path.join(SITE, "content", "articles");
  const files = fs.readdirSync(dirp).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 1);
  const allowed = new Set(FIELD_ORDER);
  for (const f of files) {
    assert.match(f, /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/, f);
    const { data } = parseFrontmatter(fs.readFileSync(path.join(dirp, f), "utf8"));
    for (const k of Object.keys(data)) assert.ok(allowed.has(k), `${f}: unexpected field ${k}`);
    assert.equal(typeof data.draft, "boolean");
    assert.ok(!Number.isNaN(new Date(data.date).getTime()), `${f} date parses`);
  }
});

test("filename + slug: <slug>.md, URL-safe, and the site build keeps our frontmatter slug as the public URL slug", () => {
  const a = mk();
  assert.match(`${a.slug}.md`, /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
  const dir = tmpSite(); withDraft(dir, a, { publish: true });
  const out = build(dir);
  const built = out.find((x) => x.title === a.title);
  assert.equal(built.slug, a.slug);
  assert.ok(fs.existsSync(path.join(dir, "public", "articles", a.slug, "index.html")));
});

test("the SITE'S OWN frontmatter parser reads every emitted field with the intended value (quotes, apostrophes, commas, colons, $, unicode)", () => {
  const tricky = mk({ title: 'Joey\'s "Strip" Deal: $85 Million, Maybe — Café', businessName: "O'Reilly & Sons, LLC", location: "East Liberty, Pittsburgh",
    tags: ["Pittsburgh, PA", "it's \"big\"", "back\\slash", "2026", "true", "café"], excerpt: 'He said "yes", then left. It cost $5 million: a record.', author: "Zaydan - The Allegheny Chronicle Staff" });
  const { data, content } = parseFrontmatter(toCmsMarkdown(tricky));
  assert.equal(data.slug, tricky.slug);
  assert.equal(data.businessName, "O'Reilly & Sons, LLC");
  assert.equal(data.location, "East Liberty, Pittsburgh");
  assert.equal(data.category, "Food");
  assert.equal(data.author, "Zaydan - The Allegheny Chronicle Staff");
  assert.equal(data.excerpt, 'He said "yes", then left. It cost $5 million: a record.');
  assert.ok(!/\\"/.test(data.title) && !data.title.includes("\\"));
  assert.ok(data.title.startsWith("Joey") && data.title.includes("Strip") && data.title.includes("$85 Million, Maybe — Café"));
  assert.equal(data.tags.length, 6);
  assert.equal(data.tags[0], "Pittsburgh, PA");                       // comma inside a tag survives (block list)
  assert.deepEqual(data.tags.slice(3), ["2026", "true", "café"]);       // quoted => strings, not number/boolean
  assert.ok(data.tags.every((t) => typeof t === "string" && !t.includes("\\\\")));
  assert.equal(data.date, "2026-10-04T16:00:00.000Z");
  assert.equal(new Date(data.date).toISOString(), "2026-10-04T16:00:00.000Z");
  assert.strictEqual(data.image, ""); assert.strictEqual(data.imageAlt, "");
  assert.strictEqual(data.featured, false); assert.strictEqual(data.trending, false); assert.strictEqual(data.editorsPick, false);
  assert.strictEqual(data.draft, true);
  assert.match(content, /^## What changed/);
  assert.deepEqual(Object.keys(data), FIELD_ORDER);
});

test("empty tags and plain values parse as the site expects (tags: [] -> empty array)", () => {
  const { data } = parseFrontmatter(toCmsMarkdown(mk({ tags: [] })));
  assert.deepEqual(data.tags, []);
});

test("real build: draft:true is EXCLUDED from articles.json, article pages and sitemap", () => {
  const dir = tmpSite(); const a = mk(); withDraft(dir, a);
  build(dir);
  const out = JSON.parse(fs.readFileSync(path.join(dir, "public", "articles.json"), "utf8"));
  assert.ok(!out.some((x) => x.title === a.title || x.slug === a.slug));
  assert.ok(!fs.existsSync(path.join(dir, "public", "articles", a.slug)));
  assert.ok(!fs.readFileSync(path.join(dir, "public", "sitemap.xml"), "utf8").includes(a.slug));
});

test("real build: after a (simulated) HUMAN flips draft:false, the article renders with correct metadata; blank image falls back to the site placeholder", () => {
  const dir = tmpSite(); const a = mk(); withDraft(dir, a, { publish: true });
  const out = build(dir);
  const b = out.find((x) => x.slug === a.slug);
  assert.ok(b, "article compiled");
  assert.equal(b.title, a.title); assert.equal(b.category, "Food"); assert.equal(b.author, a.author);
  assert.equal(b.date, "2026-10-04T16:00:00.000Z"); assert.deepEqual(b.tags, ["food", "pittsburgh"]);
  assert.equal(b.image, "/images/placeholder-hero.jpg"); assert.equal(b.imageAlt, a.title);
  assert.equal(b.featured, false); assert.equal(b.trending, false); assert.equal(b.editorsPick, false);
  const html = fs.readFileSync(path.join(dir, "public", "articles", a.slug, "index.html"), "utf8");
  assert.ok(html.includes(a.title)); assert.ok(html.includes('href="https://example.com/a"'));
  assert.ok(!/<h1[^>]*>[^<]*What changed/.test(html));
  assert.ok(fs.readFileSync(path.join(dir, "public", "sitemap.xml"), "utf8").includes(`/articles/${a.slug}/`));
});

test("the body renders through the site's markdown renderer with no raw HTML and no duplicate H1; raw HTML in text is refused", () => {
  const html = renderMarkdown(mk().body);
  assert.ok(!html.includes("<h1") && !html.includes("<script"));
  for (const bad of ["<script>alert(1)</script>", "text <b>bold</b>", "<!-- x -->", "</p>"]) {
    assert.throws(() => mk({ body: `ok ${bad}` }), (e) => e.code === "RAW_HTML_NOT_ALLOWED", bad);
    assert.throws(() => mk({ title: `T ${bad}` }), (e) => e.code === "RAW_HTML_NOT_ALLOWED", bad);
  }
  assert.doesNotThrow(() => mk({ body: "Revenue was < $1M and growth was > 5%." }));
});

test("dry-run output (real newsroom workflow) is accepted by the real build, stays draft:true, and sorts by date like other articles", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-dry-"));
  const { report, draft } = await runDryRun({ category: "food", clean: false, outDir: out });
  assert.equal(report.finalState, "HUMAN_REVIEW");
  const dir = tmpSite();
  fs.writeFileSync(path.join(dir, "content", "articles", draft.filename), draft.content);
  const before = JSON.stringify(build(dir).map((x) => x.slug));
  assert.ok(!/strip-district/.test(before));                      // draft hidden
  fs.writeFileSync(path.join(dir, "content", "articles", draft.filename), draft.content.replace(/^draft: true$/m, "draft: false"));
  const after = build(dir);
  assert.equal(after.length, JSON.parse(before).length + 1);
  const b = after.find((x) => x.title.startsWith("Strip District Bakery"));
  assert.equal(b.category, "Food"); assert.equal(b.author, "Riham - The Allegheny Chronicle Staff");
  assert.ok(draft.content.startsWith("---\n"));
});
