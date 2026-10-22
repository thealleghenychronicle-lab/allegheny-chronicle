"use strict";
// Chunk 5 -- article model, CMS Markdown/frontmatter, draft:true enforcement, draft service + limiter. Fully offline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createArticle, ArticleError, slugify } = require("../cms/article");
const { toCmsMarkdown, parseCmsMarkdown, assertDraftTrue, FIELD_ORDER } = require("../cms/markdown");
const { MemoryDraftSink, DirDraftSink } = require("../cms/draft-sinks");
const { createDraftService } = require("../cms/draft-service");
const { LocalStateStore } = require("../local-state-store");
const limiter = require("../limiter");

const T0 = Date.parse("2026-10-04T16:00:00.000Z");
const HOUR = 3600 * 1000;
const base = (extra = {}) => ({ title: "Bakery Opens: Second \"Strip\" Location", businessName: "Example Bakery", category: "Food", author: "Riham - The Allegheny Chronicle Staff",
  body: "Opening day coverage via [Example](https://example.com/a).", tags: ["food", "food", "pittsburgh"], jobId: "job-1", ...extra });
const mk = (extra, now = T0) => createArticle(base(extra), { now });
function svc({ now = () => T0, store = new LocalStateStore(), sink = new MemoryDraftSink() } = {}) { return { store, sink, now, s: createDraftService({ store, sink, now }) }; }
const used = (store, now = T0) => limiter.getWindowStatus(store, 3, () => now).activeInWindow;

test("article: schema fields, slug, defaults, deduped tags, never promoted", () => {
  const a = mk();
  assert.equal(a.slug, "bakery-opens-second-strip-location");
  assert.equal(a.draft, true);
  assert.deepEqual([a.featured, a.trending, a.editorsPick], [false, false, false]);
  assert.deepEqual([...a.tags], ["food", "pittsburgh"]);
  assert.equal(a.location, "Pittsburgh, PA");
  assert.equal(a.date, "2026-10-04T16:00:00.000Z");
  assert.ok(a.excerpt.length > 0 && !a.excerpt.includes("]("));
  assert.equal(slugify("  Café & Bar!! "), "cafe-and-bar");
  assert.throws(() => createArticle(base({ title: "" })), ArticleError);
  assert.throws(() => createArticle(base({ slug: "Bad Slug" })), ArticleError);
});

test("article: draft:false is not representable; draft:true is accepted", () => {
  for (const bad of [false, "false", 0, null, undefined]) {
    assert.throws(() => createArticle(base({ draft: bad })), (e) => e.code === "DRAFT_MUST_BE_TRUE", String(bad));
  }
  assert.equal(createArticle(base({ draft: true })).draft, true);
});

test("markdown: all schema fields, in order, correct types; draft: true literal", () => {
  const md = toCmsMarkdown(mk());
  const { frontmatter: fm, body } = parseCmsMarkdown(md);
  assert.deepEqual(Object.keys(fm), FIELD_ORDER);
  assert.deepEqual(FIELD_ORDER, ["title", "slug", "businessName", "location", "category", "tags", "image", "imageAlt", "author", "date", "excerpt", "featured", "trending", "editorsPick", "draft"]);
  assert.equal(fm.title, 'Bakery Opens: Second "Strip" Location');   // quotes/colons survive escaping
  assert.equal(fm.author, "Riham - The Allegheny Chronicle Staff");
  assert.equal(fm.category, "Food");
  assert.deepEqual(fm.tags, ["food", "pittsburgh"]);
  assert.equal(fm.draft, true);
  assert.match(md, /^draft: true$/m);
  assert.match(md, /^date: 2026-10-04T16:00:00\.000Z$/m);
  assert.match(body, /\[Example\]\(https:\/\/example\.com\/a\)/);
  assert.ok(md.startsWith("---\n") && md.endsWith("\n"));
});

test("markdown: a newline/frontmatter-injection attempt in a string field cannot add keys or flip draft", () => {
  const md = toCmsMarkdown(mk({ title: 'Nice\ndraft: false', excerpt: "x\n---\ndraft: false" }));
  const { frontmatter } = parseCmsMarkdown(md);
  assert.equal(frontmatter.draft, true);
  assert.equal(Object.keys(frontmatter).length, FIELD_ORDER.length);
});

test("draft:true enforcement: guard, formatter, and BOTH sinks reject anything else", () => {
  const good = toCmsMarkdown(mk());
  const bad = good.replace("draft: true", "draft: false");
  assert.throws(() => assertDraftTrue(bad), (e) => e.code === "DRAFT_MUST_BE_TRUE");
  assert.throws(() => assertDraftTrue(good.replace("draft: true\n", "")), ArticleError);
  assert.throws(() => assertDraftTrue(good.replace("draft: true", 'draft: "true"')), (e) => e.code === "DRAFT_MUST_BE_TRUE");
  assert.throws(() => assertDraftTrue(good.replace("draft: true", "draft: true\ndraft: false")), ArticleError);   // duplicate key
  // a hostile article object with draft:false cannot change the output
  assert.match(toCmsMarkdown({ ...mk(), draft: false }), /^draft: true$/m);
  const mem = new MemoryDraftSink();
  assert.throws(() => mem.write("x.md", bad), (e) => e.code === "DRAFT_MUST_BE_TRUE");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-sink-"));
  const ds = new DirDraftSink(dir);
  assert.throws(() => ds.write("x.md", bad), (e) => e.code === "DRAFT_MUST_BE_TRUE");
  assert.deepEqual(ds.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no code in cms/ or execution/ can write draft:false or approve/publish", () => {
  const root = path.join(__dirname, "..");
  for (const d of ["cms", "execution"]) for (const f of fs.readdirSync(path.join(root, d))) {
    const src = fs.readFileSync(path.join(root, d, f), "utf8");
    assert.doesNotMatch(src, /draft:\s*false/, `${d}/${f}`);
    assert.doesNotMatch(src, /HUMAN_APPROVED|humanDecision|\.git\b|child_process|fetch\(|https?\.request/, `${d}/${f}`);
  }
});

test("DirDraftSink: writes file + index; refuses content/articles, traversal and overwrite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-sink-"));
  const ds = new DirDraftSink(dir);
  const md = toCmsMarkdown(mk());
  ds.write("a-slug.md", md, { jobId: "job-1" });
  assert.equal(fs.readFileSync(path.join(dir, "a-slug.md"), "utf8"), md);
  assert.equal(ds.get("a-slug").meta.jobId, "job-1");
  assert.throws(() => ds.write("a-slug.md", md), (e) => e.code === "DRAFT_EXISTS");
  assert.throws(() => ds.write("../evil.md", md), (e) => e.code === "INVALID_FILENAME");
  assert.throws(() => ds.write("sub/dir.md", md), (e) => e.code === "INVALID_FILENAME");
  assert.throws(() => new DirDraftSink(path.join(dir, "content", "articles")), (e) => e.code === "FORBIDDEN_DIRECTORY");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- limiter wiring ----------
test("limiter: a NEW successful draft consumes exactly one slot (completed), and only after the draft exists", () => {
  const { s, store, sink } = svc();
  assert.equal(used(store), 0);
  const r = s.createDraft(mk());
  assert.equal(r.ok, true); assert.equal(r.created, true); assert.equal(r.consumedSlot, true);
  assert.equal(sink.list().length, 1);
  assert.equal(used(store), 1);
  const entries = limiter.getWindowStatus(store, 3, () => T0).entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].status, "completed");
});

test("limiter: re-running the same job's draft is idempotent and consumes NO extra slot", () => {
  const { s, store, sink } = svc();
  s.createDraft(mk());
  const again = s.createDraft(mk());
  assert.equal(again.ok, true); assert.equal(again.created, false); assert.equal(again.consumedSlot, false);
  assert.equal(sink.list().length, 1); assert.equal(used(store), 1);
});

test("limiter: 4th new draft in the rolling window is refused, nothing written, retryAt = when the oldest slot frees", () => {
  const { s, store, sink } = svc();
  for (let i = 0; i < 3; i++) assert.equal(s.createDraft(mk({ title: `Story number ${i}`, jobId: `job-${i}` })).ok, true);
  const r = s.createDraft(mk({ title: "Story four", jobId: "job-4" }));
  assert.equal(r.ok, false); assert.equal(r.reason, "LIMIT_REACHED"); assert.equal(r.consumedSlot, false);
  assert.equal(r.retryAt, T0 + 24 * HOUR);
  assert.equal(sink.list().length, 3); assert.equal(used(store), 3);
  // after the window rolls, a slot is available again
  const later = svc({ store, sink, now: () => T0 + 24 * HOUR + 1 });
  assert.equal(later.s.createDraft(mk({ title: "Story four", jobId: "job-4" }, T0 + 24 * HOUR + 1)).ok, true);
});

test("reconciliation: draft write failure releases the reservation (no slot consumed); retry then succeeds", () => {
  const { s, store, sink } = svc();
  sink.failNext = 1;
  const r = s.createDraft(mk());
  assert.equal(r.ok, false); assert.equal(r.reason, "DRAFT_WRITE_FAILED"); assert.equal(r.reconciled, "RELEASED"); assert.equal(r.consumedSlot, false);
  const entries = limiter.getWindowStatus(store, 3, () => T0).entries;
  assert.deepEqual(entries.map((e) => e.status), ["released"]);
  assert.equal(used(store), 0); assert.equal(sink.list().length, 0);
  const ok = s.createDraft(mk());
  assert.equal(ok.ok, true); assert.equal(used(store), 1);
});

test("reconciliation: draft written but completeSlot fails -> pending, completed on the next call for the same job; still one slot", () => {
  const store = new LocalStateStore(); const sink = new MemoryDraftSink();
  const realWrite = store.writeAtomic.bind(store); let block = true;
  store.writeAtomic = (files, msg) => (block && /^completed slot/.test(msg) ? { ok: false, conflict: true } : realWrite(files, msg));
  const { s } = svc({ store, sink });
  const r = s.createDraft(mk());
  assert.equal(r.ok, true); assert.equal(r.created, true); assert.equal(r.consumedSlot, false); assert.equal(r.reconciled, "COMPLETE_FAILED");
  assert.equal(limiter.getWindowStatus(store, 3, () => T0).entries[0].status, "pending");   // still counted while pending
  assert.equal(used(store), 1);
  block = false;
  const again = s.createDraft(mk());
  assert.equal(again.ok, true); assert.equal(again.created, false); assert.equal(again.reconciled, "COMPLETED_PENDING");
  assert.equal(limiter.getWindowStatus(store, 3, () => T0).entries.length, 1);
  assert.equal(limiter.getWindowStatus(store, 3, () => T0).entries[0].status, "completed");
});

test("a different job with the same slug is refused (DUPLICATE_SLUG) and consumes nothing", () => {
  const { s, store, sink } = svc();
  s.createDraft(mk());
  const r = s.createDraft(mk({ jobId: "job-OTHER" }));
  assert.equal(r.ok, false); assert.equal(r.reason, "DUPLICATE_SLUG"); assert.equal(r.retryable, false);
  assert.equal(used(store), 1); assert.equal(sink.list().length, 1);
});
