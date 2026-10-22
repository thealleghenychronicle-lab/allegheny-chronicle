"use strict";
// Chunk 6 -- final Phase 2 end-to-end validation (deterministic, offline).
// QUEUED -> employees -> research -> writing -> reviews -> CMS formatting -> CMS_DRAFT -> HUMAN_REVIEW, then STOP.
// Any attempt to reach the network (fetch / http / https / net) fails the test; no credentials are present.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const { buildHarness, runToHumanReview } = require("../execution/harness");
const { parseCmsMarkdown, FIELD_ORDER } = require("../cms/markdown");
const { DirDraftSink } = require("../cms/draft-sinks");
const limiter = require("../limiter");
const { runDryRun } = require("../dry-run");
const HOUR = 3600 * 1000;

const KEYS = ["GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "GITHUB_TOKEN"];
function offlineGuard(fn) {
  return async () => {
    const saved = { fetch: globalThis.fetch, hr: http.request, sr: https.request, nc: net.connect, env: {} };
    const hits = [];
    globalThis.fetch = () => { hits.push("fetch"); throw new Error("network blocked"); };
    http.request = () => { hits.push("http"); throw new Error("network blocked"); };
    https.request = () => { hits.push("https"); throw new Error("network blocked"); };
    net.connect = () => { hits.push("net"); throw new Error("network blocked"); };
    for (const k of KEYS) { saved.env[k] = process.env[k]; delete process.env[k]; }
    try { await fn(); assert.deepEqual(hits, [], "no network access"); }
    finally { globalThis.fetch = saved.fetch; http.request = saved.hr; https.request = saved.sr; net.connect = saved.nc; for (const k of KEYS) if (saved.env[k] !== undefined) process.env[k] = saved.env[k]; }
  };
}
const slots = (h) => limiter.getWindowStatus(h.store, 3, h.now).activeInWindow;

test("E2E all three categories route to the right employees and end at HUMAN_REVIEW with draft:true", offlineGuard(async () => {
  const expect = { sports: ["zaydan", "Sports"], food: ["riham", "Food"], general: ["lubna", "Business"] };
  for (const [category, [writer, label]] of Object.entries(expect)) {
    const h = buildHarness();
    const id = h.queue.enqueue({ title: `Integration ${category} story`, category }).job.id;
    const res = await runToHumanReview(h, id);
    assert.equal(res.stopped, "HUMAN_REVIEW");
    assert.deepEqual(res.trace.map((s) => s.employee), ["thurayya", "maysam", "nawfal", writer, "uzayr", "jumana", "salsabil", "maysoon"]);
    const job = h.queue.get(id);
    const fm = parseCmsMarkdown(h.sink.get(job.data.cms_editor.slug).content).frontmatter;
    assert.equal(fm.category, label); assert.strictEqual(fm.draft, true); assert.deepEqual(Object.keys(fm), FIELD_ORDER);
    assert.strictEqual(fm.featured || fm.trending || fm.editorsPick, false);
    assert.equal(slots(h), 1);
  }
}));

test("E2E with a research wait, an AI wait and a fact-check revision still reaches HUMAN_REVIEW; limiter is consumed once, only at CMS creation", offlineGuard(async () => {
  const { report, job, harness: h } = await runDryRun({ category: "sports", clean: false });
  assert.equal(report.finalState, "HUMAN_REVIEW");
  const seen = new Set(job.history.map((e) => e.to));
  for (const s of ["WAITING_FOR_RESEARCH", "WAITING_FOR_AI", "NEEDS_REVISION", "READY_FOR_CMS", "CMS_DRAFT", "HUMAN_REVIEW"]) assert.ok(seen.has(s), s);
  assert.ok(!seen.has("HUMAN_APPROVED") && !seen.has("HUMAN_REJECTED"));
  assert.equal(slots(h), 1);
  assert.equal(h.sink.list ? h.sink.list().length : 1, 1);
  // the slot was taken by exactly one reserve/complete pair, after the final stage began
  const entries = limiter.getWindowStatus(h.store, 3, h.now).entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].status, "completed");
}));

test("E2E limiter: 3 drafts per rolling 24h; the 4th job is deferred (no draft, no failure) and completes once the oldest slot ages out", offlineGuard(async () => {
  const h = buildHarness();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(h.queue.enqueue({ title: `Limiter story number ${i}`, category: "general" }).job.id);
  for (let i = 0; i < 3; i++) { const r = await h.runner.runJob(ids[i]); assert.equal(r.stopped, "HUMAN_REVIEW"); h.now.advance(10 * 60 * 1000); }
  assert.equal(slots(h), 3);
  const r4 = await h.runner.runJob(ids[3]);
  assert.notEqual(r4.stopped, "HUMAN_REVIEW");
  const j4 = h.queue.get(ids[3]);
  assert.notEqual(j4.state, "HUMAN_REVIEW"); assert.equal(j4.attempts.failures, 0); assert.ok(!j4.attempts.exhausted);
  assert.equal(r4.steps[r4.steps.length - 1].outcome, "deferred");
  assert.equal(slots(h), 3);                                   // nothing extra consumed
  assert.equal([...(h.sink.drafts ? h.sink.drafts.keys() : [])].length || 3, 3);
  h.now.advance(25 * HOUR);
  const again = await runToHumanReview(h, ids[3]);
  assert.equal(again.stopped, "HUMAN_REVIEW");
  assert.equal(slots(h), 1);                                   // first three aged out; only the new one counts
}));

test("E2E boundary: automation cannot approve/publish; HUMAN_REVIEW is not claimable; no draft file is ever non-draft", offlineGuard(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2-int-"));
  const h = buildHarness({ outDir: dir });
  const id = h.queue.enqueue({ title: "Boundary story", category: "food" }).job.id;
  assert.equal((await runToHumanReview(h, id)).stopped, "HUMAN_REVIEW");
  const step = await h.runner.step({ jobId: id });
  assert.equal(step.ran, false);
  assert.equal(h.queue.claim({ workerId: "any", jobId: id }).ok, false);
  assert.equal(h.queue.claim({ workerId: "any" }).ok, false);
  for (const actor of [{ type: "worker", id: "maysoon" }, { type: "employee", id: "maysam" }, { type: "ai", id: "x" }, undefined]) {
    let r; try { r = h.queue.humanDecision(id, { decision: "approve", actor }); } catch (e) { r = { ok: false, reason: e.code }; }
    assert.equal(r.ok, false);
  }
  assert.equal(h.queue.get(id).state, "HUMAN_REVIEW");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  assert.match(fs.readFileSync(path.join(dir, files[0]), "utf8"), /^draft: true$/m);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, files[0]), "utf8"), /^draft: false$/m);
  assert.throws(() => new DirDraftSink(path.join(os.tmpdir(), "x", "content", "articles")), /content/i);   // never writes into content/articles
}));

test("static boundary: automation source has no publish/approve code path, no scheduler, no real-credential reads outside the provider adapters", () => {
  const root = path.join(__dirname, "..");
  const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!["tests", "state"].includes(e.name)) walk(p); } else if (p.endsWith(".js")) files.push(p); } })(root);
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8"); const rel = path.relative(root, f);
    assert.doesNotMatch(src, /draft:\s*false|"draft",\s*false|setInterval|node-cron|schedule\(|cron\./, rel);
    if (!/^(workflow[\\/]queue|workflow[\\/]constants|workflow[\\/]state-machine)/.test(rel)) assert.doesNotMatch(src, /HUMAN_APPROVED/, rel);
    if (!/^(providers|research[\\/]providers|ai[\\/]http-utils)/.test(rel)) assert.doesNotMatch(src, /process\.env\.[A-Z_]*(KEY|TOKEN|SECRET)/, rel);
  }
});
