"use strict";
// Chunk 5 -- employee execution, handoffs, router integration (mocks), dry run, waits/retries/revisions,
// limiter consumption, HUMAN_REVIEW stop. Fully offline: mock AI / mock research / LocalStateStore / injected clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildHarness, runToHumanReview } = require("../execution/harness");
const { HANDLERS } = require("../execution/stages");
const { MockAIRouter } = require("../execution/mocks");
const { runDryRun } = require("../dry-run");
const { parseCmsMarkdown } = require("../cms/markdown");
const limiter = require("../limiter");
const F = require("./helpers/router-fixtures");
const { createResearchRouter } = require("../research/router");
const { MockResearchProvider } = require("../research/providers/mock");

const HOUR = 3600 * 1000;
const slots = (h) => limiter.getWindowStatus(h.store, 3, h.now).activeInWindow;
const enqueue = (h, req = { title: "Pittsburgh Brewery Expands", category: "general" }) => h.queue.enqueue(req).job.id;
async function runAll(h, req, opts) { const id = enqueue(h, req); const res = await runToHumanReview(h, id, opts); return { id, res, job: h.queue.get(id) }; }
const employeesOf = (job) => job.history.filter((e) => e.from === "QUEUED" || e.from === "READY_FOR_CMS" || e.from === "NEEDS_REVISION" || e.from.startsWith("WAITING")).map((e) => e.assignedTo);

// ---------- employee execution + handoffs ----------
test("employee execution: full pipeline in order, Maysoon makes no AI call, ends at HUMAN_REVIEW", async () => {
  const h = buildHarness();
  const { res, job } = await runAll(h);
  assert.equal(res.stopped, "HUMAN_REVIEW");
  assert.equal(job.state, "HUMAN_REVIEW");
  assert.deepEqual(res.trace.map((s) => s.employee), ["thurayya", "maysam", "nawfal", "lubna", "uzayr", "jumana", "salsabil", "maysoon"]);
  assert.deepEqual(res.trace.map((s) => s.outcome), Array(8).fill("completed"));
  assert.deepEqual(h.ai.calls.map((c) => `${c.employee}:${c.taskType}`),
    ["maysam:story_evaluation", "nawfal:research_synthesis", "lubna:writing", "uzayr:fact_check", "jumana:standards_review", "salsabil:source_analysis"]);
  assert.ok(!h.ai.calls.some((c) => c.employee === "maysoon" || c.employee === "thurayya"));
  // each stage's output is carried in job.data
  for (const k of ["news_scout", "news_director", "research_editor", "writer", "fact_checker", "standards_editor", "source_editor", "cms_editor"]) assert.ok(job.data[k], k);
  const states = job.history.map((e) => `${e.from}>${e.to}`);
  assert.ok(states.includes("READY_FOR_CMS>IN_PROGRESS") && states.includes("IN_PROGRESS>CMS_DRAFT") && states.includes("CMS_DRAFT>HUMAN_REVIEW"));
  assert.equal(job.history[job.history.length - 1].to, "HUMAN_REVIEW");
});

test("writer routing: sports->Zaydan, food->Riham, general->Lubna (bylines carried into the draft)", async () => {
  for (const [category, writer, byline] of [["sports", "zaydan", "Zaydan"], ["food", "riham", "Riham"], ["general", "lubna", "Lubna"]]) {
    const h = buildHarness();
    const { job } = await runAll(h, { title: `A ${category} story`, category });
    assert.equal(job.data.writer.writerId, writer, category);
    assert.ok(h.ai.calls.some((c) => c.taskType === "writing" && c.employee === writer));
    const draft = h.sink.get(job.data.cms_editor.slug);
    assert.equal(parseCmsMarkdown(draft.content).frontmatter.author, `${byline} - The Allegheny Chronicle Staff`);
  }
});

test("News Director override is respected (sports story written by Riham); bad override fails cleanly", async () => {
  const h = buildHarness({ scenario: { directorWriter: "riham" } });
  const { job } = await runAll(h, { title: "Stadium food vendors", category: "sports" });
  assert.equal(job.writerId, "riham");
  assert.equal(job.data.news_director.writerOverride, "riham");
  assert.equal(job.data.writer.writerId, "riham");
  assert.ok(!h.ai.calls.some((c) => c.employee === "zaydan"));

  const h2 = buildHarness({ scenario: { directorWriter: "maysam" }, runnerOpts: {} });
  const id = enqueue(h2, { title: "x story", category: "sports" });
  const res = await runToHumanReview(h2, id);
  const j = h2.queue.get(id);
  assert.notEqual(j.state, "HUMAN_REVIEW");
  assert.equal(j.error.code, "INVALID_WRITER_OVERRIDE");
  assert.equal(h2.sink.list().length, 0); assert.equal(slots(h2), 0);
  assert.ok(res.trace.length >= 1);
});

// ---------- router integration (mocks) ----------
test("AI Router integration: requests satisfy the real request contract; research goes through the real Research Router", async () => {
  const h = buildHarness();
  await runAll(h);
  assert.ok(h.ai.calls.length >= 6);                       // MockAIRouter runs createRequest() on every call; a bad request would have thrown
  assert.ok(h.ai.calls.every((c) => c.system.includes("Editorial standards") && c.system.includes("never fabricate")));
  assert.ok(h.ai.calls.find((c) => c.taskType === "writing").prompt.includes("SOURCES:"));
  assert.deepEqual(h.research.provider.calls.map((c) => c.topics), [["general"], ["general"]]);   // scout + research editor via ResearchRouter
  assert.match(h.research.provider.calls[1].query, /background$/);
});

test("AI Router integration (REAL Router, scripted fetch + fake keys): success, and WAITING mapped to WAITING_FOR_AI", async () => {
  const h = buildHarness();
  const id = enqueue(h);
  // advance to the director stage with mocks, then swap in the real router for that stage only
  await h.runner.step({ jobId: id });
  const { router, fetchImpl } = F.makeRouter({ handlers: { gemini: F.geminiOk('{"newsworthy":true,"reason":"real router path"}') }, now: h.now });
  h.runner.ai = router;
  const s = await h.runner.step({ jobId: id });
  assert.equal(s.employee, "maysam"); assert.equal(s.outcome, "completed");
  assert.equal(h.queue.get(id).data.news_director.reason, "real router path");
  assert.equal(fetchImpl.calls.length, 1);

  // now all providers rate-limited -> router returns WAITING -> job parks in WAITING_FOR_AI with the router's retry time
  const limited = F.makeRouter({ handlers: { gemini: F.json(429, { error: { status: "RESOURCE_EXHAUSTED", message: "x" } }, { "retry-after": "120" }),
    groq: F.json(429, { error: { message: "x", code: "rate_limit_exceeded" } }, { "retry-after": "120" }), openrouter: F.json(429, { error: { code: 429, message: "x" } }) }, now: h.now });
  h.runner.ai = limited.router;
  const w = await h.runner.step({ jobId: id });
  assert.equal(w.employee, "nawfal"); assert.equal(w.outcome, "waiting"); assert.equal(w.kind, "ai");
  const j = h.queue.get(id);
  assert.equal(j.state, "WAITING_FOR_AI"); assert.equal(j.stage, "research_editor");
  assert.ok(Date.parse(j.wait.resumeAt) > h.now());
  assert.equal(j.attempts.failures, 0);
});

test("handlers reach AI/research only via ctx.ai / ctx.research (swappable interfaces)", async () => {
  const seen = [];
  const ai = { route: async (r) => { seen.push(r.taskType); return { ok: true, status: "SUCCESS", content: JSON.stringify({ newsworthy: true, reason: "stub" }) }; } };
  const job = { id: "j", request: { title: "t", category: "general" }, data: { news_scout: { leads: [{ title: "a", url: "https://example.com/a", publisher: "P" }] } }, attempts: { failures: 0 }, revision: { count: 0, current: null } };
  const profile = { id: "maysam", name: "Maysam", position: "News Director" };
  const out = await HANDLERS.news_director({ job, profile, employees: new Map(), standards: {}, ai, store: buildHarness().store, now: () => Date.now(), maxPerWindow: 3 });
  assert.equal(out.type, "complete"); assert.deepEqual(seen, ["story_evaluation"]);
});

// ---------- dry run ----------
test("dry run (default scenario): QUEUED -> HUMAN_REVIEW with a research wait, an AI wait and a revision; inspectable draft", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dry-"));
  const { report, job, draft } = await runDryRun({ category: "sports", outDir: dir });
  assert.equal(report.finalState, "HUMAN_REVIEW"); assert.equal(report.stoppedAt, "HUMAN_REVIEW");
  assert.equal(report.offline, true); assert.equal(report.credentials, false);
  assert.ok(report.trace.some((s) => s.outcome === "waiting" && s.waitKind === "research"));
  assert.ok(report.trace.some((s) => s.outcome === "waiting" && s.waitKind === "ai"));
  assert.ok(report.trace.some((s) => s.outcome === "revision" && s.revisionTarget === "writer"));
  assert.equal(report.limiter, "1 of 3 slots used");
  assert.equal(report.writer, "zaydan");
  const onDisk = fs.readFileSync(path.join(dir, report.cmsDraft.filename), "utf8");
  assert.equal(onDisk, draft.content);
  assert.equal(parseCmsMarkdown(onDisk).frontmatter.draft, true);
  assert.ok(!onDisk.includes("not-in-the-research-packet"));       // the bad first draft never reached the CMS draft
  assert.equal(job.revision.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dry run is deterministic and makes zero network calls", async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error("network is forbidden in tests"); };
  try {
    const a = await runDryRun({ category: "food" }); const b = await runDryRun({ category: "food" });
    assert.equal(a.draft.content, b.draft.content);
    assert.deepEqual(a.report.trace, b.report.trace);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = realFetch; }
});

// ---------- waits / retries / revisions ----------
test("research outage -> WAITING_FOR_RESEARCH (no failure counted), resumes only after resumeAt, same stage/employee", async () => {
  const h = buildHarness({ research: { failTimes: 1 } });
  const id = enqueue(h);
  const s1 = await h.runner.step({ jobId: id });
  assert.equal(s1.outcome, "waiting"); assert.equal(s1.kind, "research");
  let j = h.queue.get(id);
  assert.equal(j.state, "WAITING_FOR_RESEARCH"); assert.equal(j.stage, "news_scout"); assert.equal(j.assignedTo, "thurayya");
  assert.equal(j.attempts.failures, 0); assert.equal(j.attempts.waits, 1);
  assert.equal((await h.runner.step({ jobId: id })).ran, false);       // not yet eligible
  h.now.advance(16 * 60 * 1000);
  const s2 = await h.runner.step({ jobId: id });
  assert.equal(s2.outcome, "completed"); assert.equal(s2.employee, "thurayya");
  assert.equal(slots(h), 0);
});

test("AI WAITING -> WAITING_FOR_AI using the router's retryAt; resumes at the writer", async () => {
  const h = buildHarness({ scenario: { inject: [{ taskType: "writing", times: 1, mode: "waiting", retryAfterMs: 30 * 60 * 1000 }] } });
  const { res, job } = await runAll(h);
  const w = res.trace.find((s) => s.outcome === "waiting");
  assert.equal(w.kind, "ai"); assert.equal(w.employee, "lubna");
  assert.equal(job.state, "HUMAN_REVIEW"); assert.equal(job.attempts.waits >= 0, true);
  assert.equal(h.ai.calls.filter((c) => c.taskType === "writing").length, 2);
  assert.equal(slots(h), 1);
});

test("retry: AI failure releases with backoff (failure counted), then succeeds; no slot consumed meanwhile", async () => {
  const h = buildHarness({ scenario: { inject: [{ taskType: "story_evaluation", times: 2, mode: "failed" }] } });
  const id = enqueue(h);
  await h.runner.step({ jobId: id });                                   // scout
  const f1 = await h.runner.step({ jobId: id });
  assert.equal(f1.outcome, "failed");
  let j = h.queue.get(id);
  assert.equal(j.state, "QUEUED"); assert.equal(j.stage, "news_director"); assert.equal(j.attempts.failures, 1);
  assert.ok(Date.parse(j.attempts.nextEligibleAt) > h.now());
  assert.equal((await h.runner.step({ jobId: id })).ran, false);        // backoff not elapsed
  assert.equal(slots(h), 0);
  const done = await runToHumanReview(h, id);
  assert.equal(done.stopped, "HUMAN_REVIEW");
  assert.equal(h.queue.get(id).attempts.failures, 0);                   // cleared on successful stage completion
  assert.equal(slots(h), 1);
});

test("retry: malformed AI output is a retryable failure; permanent failures exhaust and never create a draft", async () => {
  const h = buildHarness({ scenario: { inject: [{ taskType: "writing", times: 1, mode: "malformed" }] } });
  const { res, job } = await runAll(h);
  assert.ok(res.trace.some((s) => s.outcome === "failed" && s.code === "MALFORMED_AI_OUTPUT"));
  assert.equal(job.state, "HUMAN_REVIEW");

  const h2 = buildHarness({ scenario: { inject: [{ taskType: "writing", times: 99, mode: "failed" }] } });
  const r2 = await runAll(h2);
  assert.equal(r2.res.stopped, "EXHAUSTED"); assert.equal(r2.job.attempts.exhausted, true);
  assert.equal(r2.job.attempts.failures, 5);
  assert.equal(h2.sink.list().length, 0); assert.equal(slots(h2), 0);
});

test("revision: Uzayr catches a URL outside the research packet -> NEEDS_REVISION -> writer redoes -> flows on", async () => {
  const h = buildHarness({ scenario: { badFirstDraft: true } });
  const { res, job } = await runAll(h, { title: "Condo project proposed", category: "general" });
  const rev = res.trace.find((s) => s.outcome === "revision");
  assert.equal(rev.employee, "uzayr"); assert.equal(rev.target, "writer");
  assert.equal(job.revision.count, 1); assert.equal(job.state, "HUMAN_REVIEW");
  assert.deepEqual(res.trace.map((s) => s.employee), ["thurayya", "maysam", "nawfal", "lubna", "uzayr", "lubna", "uzayr", "jumana", "salsabil", "maysoon"]);
  assert.ok(job.history.some((e) => e.to === "NEEDS_REVISION" && e.note.includes("fact_checker -> writer")));
  assert.ok(h.ai.calls.filter((c) => c.taskType === "writing")[1].prompt.includes("REVISION REQUESTED"));
  assert.ok(!h.sink.get(job.data.cms_editor.slug).content.includes("not-in-the-research-packet"));
  assert.equal(h.ai.calls.filter((c) => c.taskType === "fact_check").length, 1);   // deterministic URL check short-circuits the first AI fact-check
});

test("revision: a reviewer can send the job back to the Research Editor; it re-flows through every later stage", async () => {
  const h = buildHarness({ scenario: { verdicts: { standards_review: [{ target: "research_editor", reason: "needs a second primary source" }] } } });
  const { res, job } = await runAll(h);
  const rev = res.trace.find((s) => s.outcome === "revision");
  assert.equal(rev.employee, "jumana"); assert.equal(rev.target, "research_editor");
  const idx = res.trace.findIndex((s) => s.outcome === "revision");
  assert.deepEqual(res.trace.slice(idx + 1).map((s) => s.employee), ["nawfal", "lubna", "uzayr", "jumana", "salsabil", "maysoon"]);
  assert.equal(job.state, "HUMAN_REVIEW");
});

test("revision loop is capped: repeated revise verdicts end in REVISION_LIMIT_EXCEEDED, no draft, no slot", async () => {
  const always = Array(10).fill({ reason: "still wrong" });
  const h = buildHarness({ scenario: { verdicts: { fact_check: always } } });
  const { res, job } = await runAll(h);
  assert.equal(res.stopped, "EXHAUSTED");
  assert.equal(job.error.code, "REVISION_LIMIT_EXCEEDED");
  assert.equal(job.revision.count, 3);
  assert.equal(h.sink.list().length, 0); assert.equal(slots(h), 0);
});

test("Director can reject a lead: permanent, no draft, no slot", async () => {
  const h = buildHarness({ scenario: { directorNewsworthy: false } });
  const { res, job } = await runAll(h);
  assert.equal(res.stopped, "EXHAUSTED"); assert.equal(job.error.code, "LEAD_REJECTED_BY_DIRECTOR");
  assert.equal(h.sink.list().length, 0); assert.equal(slots(h), 0);
});

// ---------- limiter consumption ----------
test("limiter: research, AI calls, reviews, waits, revisions and retries consume NO slot; only the CMS draft does", async () => {
  const h = buildHarness({ scenario: { badFirstDraft: true, inject: [{ taskType: "writing", times: 1, mode: "waiting" }, { taskType: "source_analysis", times: 1, mode: "failed" }] }, research: { failTimes: 1 } });
  const id = enqueue(h);
  let seenCms = false;
  for (let round = 0; round < 40; round++) {
    const job = h.queue.get(id);
    if (job.state === "HUMAN_REVIEW") break;
    if (!h.queue.isEligible(job, h.now())) { h.now.set(Math.max(h.now(), Date.parse(job.wait ? job.wait.resumeAt : job.attempts.nextEligibleAt)) + 1000); continue; }
    const before = slots(h);
    const s = await h.runner.step({ jobId: id });
    if (s.stage === "cms_editor") { seenCms = true; assert.equal(before, 0); assert.equal(slots(h), 1); }
    else assert.equal(slots(h), 0, `stage ${s.stage} must not consume a slot`);
  }
  assert.ok(seenCms);
  assert.ok(h.ai.calls.length >= 7); assert.ok(h.research.provider.calls.length >= 3);
  assert.equal(slots(h), 1);
});

test("limiter full: draft creation is deferred (no failure, no draft, no HUMAN_REVIEW); proceeds when the window frees", async () => {
  const h = buildHarness();
  for (let i = 0; i < 3; i++) { const r = limiter.reserveSlot(h.store, 3, h.now); limiter.completeSlot(h.store, r.reservationId); }
  const t0 = h.now();
  const id = enqueue(h);
  const res = await h.runner.runJob(id);
  assert.equal(res.stopped, "NOT_ELIGIBLE_YET");
  const j = h.queue.get(id);
  assert.equal(j.stage, "cms_editor"); assert.equal(j.state, "QUEUED");
  assert.equal(j.attempts.failures, 0); assert.equal(j.attempts.exhausted, false);
  assert.equal(Date.parse(j.attempts.nextEligibleAt), t0 + 24 * HOUR);
  assert.equal(h.sink.list().length, 0); assert.equal(slots(h), 3);
  assert.equal(res.steps[res.steps.length - 1].outcome, "deferred");
  const done = await runToHumanReview(h, id);
  assert.equal(done.stopped, "HUMAN_REVIEW"); assert.equal(h.sink.list().length, 1);
  assert.equal(slots(h), 1);                                  // the three old slots rolled out; exactly the new one is active
  assert.equal(h.drafts.status().entries.filter((e) => e.status === "completed").length, 4);
});

test("limiter: draft write failure releases the reservation, job retries with backoff and then succeeds with ONE slot", async () => {
  const h = buildHarness();
  h.sink.failNext = 1;
  const { res, job } = await runAll(h);
  const failed = res.trace.find((s) => s.stage === "cms_editor" && s.outcome === "failed");
  assert.equal(failed.code, "DRAFT_WRITE_FAILED");
  assert.equal(job.state, "HUMAN_REVIEW");
  const statuses = h.drafts.status().entries.map((e) => e.status).sort();
  assert.deepEqual(statuses, ["completed", "released"]);
  assert.equal(slots(h), 1); assert.equal(h.sink.list().length, 1);
});

test("limiter: crash after the draft was written (stage completion lost) -> retry reuses the draft; still exactly one slot", async () => {
  const h = buildHarness();
  const id = enqueue(h);
  const realComplete = h.queue.complete.bind(h.queue); let dropped = false;
  h.queue.complete = (jid, token, opts) => { const j = h.queue.get(jid); if (!dropped && j.stage === "cms_editor") { dropped = true; return { ok: false, reason: "SIMULATED_CRASH" }; } return realComplete(jid, token, opts); };
  let r = await runToHumanReview(h, id);
  assert.equal(dropped, true); assert.equal(h.sink.list().length, 1); assert.equal(slots(h), 1);
  assert.equal(h.queue.get(id).state, "IN_PROGRESS");                  // claim held until the lease expires
  h.now.advance(11 * 60 * 1000);                                        // lease (10 min) lapses
  r = await runToHumanReview(h, id);
  assert.equal(r.stopped, "HUMAN_REVIEW");
  assert.equal(h.sink.list().length, 1); assert.equal(slots(h), 1);
  assert.equal(h.queue.get(id).data.cms_editor.created, false);
  assert.equal(h.drafts.status().entries.length, 1);
});

test("two different jobs with the same title do not overwrite each other; the second fails permanently (DUPLICATE_SLUG), no extra slot", async () => {
  const h = buildHarness();
  const a = await runAll(h, { title: "Same Headline Story", category: "general" });
  const b = await runAll(h, { title: "Same Headline Story", category: "general" });
  assert.equal(a.job.state, "HUMAN_REVIEW");
  assert.equal(b.res.stopped, "EXHAUSTED"); assert.equal(b.job.error.code, "DUPLICATE_SLUG");
  assert.equal(h.sink.list().length, 1); assert.equal(slots(h), 1);
});

// ---------- article / CMS output from a real run ----------
test("article creation: draft carries the workflow result (title, byline, sources inline, draft:true)", async () => {
  const h = buildHarness();
  const { job } = await runAll(h, { title: "Bakery Opens Second Shop", category: "food" });
  const out = job.data.cms_editor;
  const { frontmatter: fm, body } = parseCmsMarkdown(h.sink.get(out.slug).content);
  assert.equal(fm.draft, true); assert.equal(fm.slug, "bakery-opens-second-shop"); assert.equal(fm.category, "Food");
  assert.equal(fm.author, "Riham - The Allegheny Chronicle Staff");
  assert.equal(fm.featured, false); assert.equal(fm.editorsPick, false);
  const urls = [...body.matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 1);
  const sources = job.data.research_editor.sources.map((s) => s.url);
  assert.ok(urls.every((u) => sources.includes(u)));                    // only researched URLs appear
  assert.equal(h.sink.get(out.slug).meta.jobId, job.id);
});

// ---------- stop at HUMAN_REVIEW ----------
test("HUMAN_REVIEW is the stopping point: runner cannot claim/advance it; no approval or publish by automation", async () => {
  const h = buildHarness();
  const { id, job } = await runAll(h);
  assert.equal(job.state, "HUMAN_REVIEW");
  const again = await h.runner.step({ jobId: id });
  assert.equal(again.ran, false);
  assert.deepEqual(await h.runner.step(), { ran: false, reason: "NO_ELIGIBLE_JOB" });
  assert.equal(h.queue.getEligible({ limit: 5 }).length, 0);
  h.now.advance(48 * HOUR);
  assert.equal((await h.runner.step({ jobId: id })).ran, false);
  assert.equal(h.queue.get(id).state, "HUMAN_REVIEW");
  for (const actor of [{ type: "worker", id: "runner-1" }, { type: "system", id: "workflow" }, null]) {
    const r = h.queue.humanDecision(id, { decision: "approve", actor });
    assert.equal(r.ok, false); assert.equal(r.reason, "HUMAN_ACTOR_REQUIRED");
  }
  assert.ok(!h.queue.get(id).history.some((e) => e.to === "HUMAN_APPROVED" || e.to === "HUMAN_REJECTED"));
  assert.equal(parseCmsMarkdown(h.sink.get(job.data.cms_editor.slug).content).frontmatter.draft, true);
});

test("every produced CMS draft in every scenario is draft:true (all categories x clean/default)", async () => {
  for (const category of ["sports", "food", "general"]) for (const clean of [true, false]) {
    const { report, draft } = await runDryRun({ category, clean });
    assert.equal(report.finalState, "HUMAN_REVIEW", `${category}/${clean}`);
    assert.equal(parseCmsMarkdown(draft.content).frontmatter.draft, true);
  }
});
