// Employee stage handlers. Each is `async (ctx) => outcome`, where outcome is one of:
//   { type:"complete", output, writerId? }              -> hand off to the next employee
//   { type:"wait", kind:"research"|"ai", reason, resumeAt }
//   { type:"revision", targetStage, reason, notes? }
//   { type:"defer", retryAt, reason }                   -> plain release, not a failure (CMS limiter full)
//   { type:"fail", error:{code,message}, permanent? }   -> counted failure with backoff (permanent => exhausted)
// Handlers never touch the queue; the runner applies outcomes. AI/research go ONLY through ctx.ai / ctx.research
// (the existing routers' interfaces). Only the CMS Editor stage can reach the draft service, hence the limiter.
"use strict";
const { aiResultToWait, researchResultToWait } = require("../workflow/bridge");
const { normalizeUrl } = require("../research/normalize");
const { prompts, systemFor, parseJson } = require("./prompts");
const { createArticle, CATEGORY_LABELS } = require("../cms/article");
const limiter = require("../limiter");

const fail = (code, message, permanent = false) => ({ type: "fail", error: { code, message }, permanent });
const LOCATION = "Allegheny County, PA";

async function askAI(ctx, taskType, prompt, maxTokens = 1500) {
  let res;
  try {
    res = await ctx.ai.route({ taskType, system: systemFor(ctx.profile, ctx.standards), prompt, employee: ctx.profile.id,
      output: { maxTokens }, retryContext: { attempt: ctx.job.attempts.failures } });
  } catch (e) { return { outcome: fail("AI_CALL_THREW", e && e.message ? e.message : String(e)) }; }
  if (res && res.ok === true) return { content: res.content };
  const w = aiResultToWait(res);
  if (w) return { outcome: { type: "wait", ...w } };
  const err = (res && res.error) || {};
  return { outcome: fail(err.category || "AI_FAILED", err.message || "AI router returned a permanent failure") };
}
async function askJson(ctx, taskType, prompt, maxTokens) {
  const r = await askAI(ctx, taskType, prompt, maxTokens);
  if (r.outcome) return r;
  const json = parseJson(r.content);
  if (!json) return { outcome: fail("MALFORMED_AI_OUTPUT", `${taskType}: response was not a JSON object`) };
  return { json };
}

async function askResearch(ctx, query, maxResults) {
  let res;
  try { res = await ctx.research.research({ query, location: LOCATION, topics: [ctx.job.request.category], maxResults }); }
  catch (e) { return { outcome: fail("RESEARCH_CALL_THREW", e && e.message ? e.message : String(e)) }; }
  if (res && res.status === "SUCCESS") return { results: res.results };
  const w = researchResultToWait(res);
  if (w) return { outcome: { type: "wait", ...w } };
  return { outcome: fail((res && res.error && res.error.category) || "RESEARCH_FAILED", (res && res.error && res.error.message) || "research failed", true) };
}

const toSource = (r) => ({ title: r.title, url: r.url, publisher: r.publisher || null, publishedAt: r.publishedAt == null ? null : new Date(r.publishedAt).toISOString() });
function mergeSources(...lists) {
  const seen = new Set(); const out = [];
  for (const s of lists.flat()) { const k = normalizeUrl(s.url); if (k && !seen.has(k)) { seen.add(k); out.push(s); } }
  return out;
}
const sourcesOf = (job) => (job.data.research_editor && job.data.research_editor.sources) || [];

// ---- 1. Thurayya: discover leads (Research Router) ----
async function newsScout(ctx) {
  const r = await askResearch(ctx, ctx.job.request.title, 5);
  if (r.outcome) return r.outcome;
  const leads = r.results.map(toSource);
  if (ctx.job.request.leadUrl) leads.unshift({ title: ctx.job.request.title, url: ctx.job.request.leadUrl, publisher: ctx.job.request.source, publishedAt: null });
  const merged = mergeSources(leads);
  if (!merged.length) return fail("NO_LEADS_FOUND", "research returned no leads for this story");
  return { type: "complete", output: { leads: merged } };
}

// ---- 2. Maysam: evaluate + (optionally) override the writer (AI Router) ----
async function newsDirector(ctx) {
  const leads = (ctx.job.data.news_scout && ctx.job.data.news_scout.leads) || [];
  const limit = limiter.getWindowStatus(ctx.store, ctx.maxPerWindow, ctx.now);   // soft check only; hard enforcement is at draft creation
  const r = await askJson(ctx, "story_evaluation", prompts.director({ job: ctx.job, leads, limit }));
  if (r.outcome) return r.outcome;
  if (r.json.newsworthy !== true) return fail("LEAD_REJECTED_BY_DIRECTOR", `director: ${String(r.json.reason || "not newsworthy").slice(0, 200)}`, true);
  const out = { newsworthy: true, reason: String(r.json.reason || ""), limitRemainingAtAssignment: limit.remaining };
  const w = typeof r.json.writer === "string" ? r.json.writer.trim() : "";
  if (w) {
    const prof = ctx.employees.get(w);
    if (!prof || !/Writer$/.test(prof.position)) return fail("INVALID_WRITER_OVERRIDE", `director named "${w}", which is not a writer`);
    out.writerOverride = w;
    return { type: "complete", output: out, writerId: w };
  }
  return { type: "complete", output: out };   // default writer comes from the category (handoff.resolveWriter)
}

// ---- 3. Nawfal: research packet (Research Router + AI Router) ----
async function researchEditor(ctx) {
  const r = await askResearch(ctx, `${ctx.job.request.title} background`, 5);
  if (r.outcome) return r.outcome;
  const leads = (ctx.job.data.news_scout && ctx.job.data.news_scout.leads) || [];
  const sources = mergeSources(leads, r.results.map(toSource));
  const a = await askJson(ctx, "research_synthesis", prompts.researchEditor({ job: ctx.job, sources }));
  if (a.outcome) return a.outcome;
  if (typeof a.json.brief !== "string" || !a.json.brief.trim()) return fail("MALFORMED_AI_OUTPUT", "research brief missing");
  return { type: "complete", output: { sources, brief: a.json.brief.trim(), gaps: Array.isArray(a.json.gaps) ? a.json.gaps.map(String) : [] } };
}

// ---- 4. Writer (Zaydan | Riham | Lubna): draft (AI Router) ----
async function writer(ctx) {
  const packet = ctx.job.data.research_editor || { sources: [], brief: "" };
  const a = await askJson(ctx, "writing", prompts.writer({ job: ctx.job, sources: packet.sources, brief: packet.brief, byline: ctx.profile.byline }), 3000);
  if (a.outcome) return a.outcome;
  const j = a.json;
  for (const k of ["title", "businessName", "excerpt", "body"]) if (typeof j[k] !== "string" || !j[k].trim()) return fail("MALFORMED_AI_OUTPUT", `writer output missing "${k}"`);
  return { type: "complete", output: {
    title: j.title.trim(), businessName: j.businessName.trim(), location: typeof j.location === "string" ? j.location.trim() : "",
    tags: Array.isArray(j.tags) ? j.tags.filter((t) => typeof t === "string" && t.trim()) : [], excerpt: j.excerpt.trim(), body: j.body, writerId: ctx.profile.id, byline: ctx.profile.byline } };
}

// shared by the three reviewers: AI verdict -> revision outcome (or null for "pass")
function reviewOutcome(json, fallbackTarget = "writer") {
  if (json.verdict === "pass") return null;
  const target = json.target === "research_editor" ? "research_editor" : fallbackTarget;
  return { type: "revision", targetStage: target, reason: String(json.reason || "reviewer requested changes").slice(0, 400) };
}
const linksIn = (body) => [...String(body).matchAll(/\]\((https?:\/\/[^)\s]+)\)|(?<![(\w])(https?:\/\/[^\s)\]]+)/g)].map((m) => m[1] || m[2]);

// ---- 5. Uzayr: fact check. Deterministic no-fabricated-URL check first, then AI (AI Router) ----
async function factChecker(ctx) {
  const article = ctx.job.data.writer; const sources = sourcesOf(ctx.job);
  const allowed = new Set(sources.map((s) => normalizeUrl(s.url)));
  const foreign = linksIn(article.body).filter((u) => !allowed.has(normalizeUrl(u)));
  if (foreign.length) return { type: "revision", targetStage: "writer", reason: `article links to URL(s) not in the research packet: ${foreign.join(", ")}`.slice(0, 400) };
  const a = await askJson(ctx, "fact_check", prompts.review({ task: "Fact-check every checkable claim against the SOURCES. Flag anything unsupported.", job: ctx.job, article, sources }));
  if (a.outcome) return a.outcome;
  return reviewOutcome(a.json) || { type: "complete", output: { verdict: "pass", reason: String(a.json.reason || "") } };
}

// ---- 6. Jumana: standards. Deterministic "no trailing source dump" check, then AI ----
async function standardsEditor(ctx) {
  const article = ctx.job.data.writer; const sources = sourcesOf(ctx.job);
  if (/^#{1,6}\s*(sources|references)\b/im.test(article.body) || /^\s*(sources|references):/im.test(article.body)) {
    return { type: "revision", targetStage: "writer", reason: "sources must be linked inline at the point of use, not dumped in a trailing list" };
  }
  const a = await askJson(ctx, "standards_review", prompts.review({ task: "Review for neutrality, fairness, attribution, labeled speculation and sensational language.", job: ctx.job, article, sources }));
  if (a.outcome) return a.outcome;
  return reviewOutcome(a.json) || { type: "complete", output: { verdict: "pass", reason: String(a.json.reason || "") } };
}

// ---- 7. Salsabil: sources. Deterministic "has inline source links" check, then AI ----
async function sourceEditor(ctx) {
  const article = ctx.job.data.writer; const sources = sourcesOf(ctx.job);
  if (!linksIn(article.body).length) return { type: "revision", targetStage: "writer", reason: "article has no inline source links" };
  const a = await askJson(ctx, "source_analysis", prompts.review({ task: "Verify each cited source supports the claim it is attached to, and that important claims are sourced.", job: ctx.job, article, sources }));
  if (a.outcome) return a.outcome;
  return reviewOutcome(a.json) || { type: "complete", output: { verdict: "pass", reason: String(a.json.reason || "") } };
}

// ---- 8. Maysoon: deterministic CMS formatting + draft creation. NO AI call. ----
async function cmsEditor(ctx) {
  const w = ctx.job.data.writer; const sources = sourcesOf(ctx.job);
  let article;
  try {
    article = createArticle({ title: w.title, businessName: w.businessName, location: w.location, category: CATEGORY_LABELS[ctx.job.request.category],
      tags: w.tags.length ? w.tags : [ctx.job.request.category], excerpt: w.excerpt, author: w.byline, body: w.body, jobId: ctx.job.id, writerId: w.writerId, sources }, { now: ctx.now() });
  } catch (e) { return fail(e.code || "INVALID_ARTICLE", e.message, true); }
  const r = ctx.drafts.createDraft(article);
  if (r.ok) return { type: "complete", output: { slug: r.slug, filename: r.filename, created: r.created, consumedSlot: r.consumedSlot, reservationId: r.reservationId, reconciled: r.reconciled } };
  if (r.reason === "LIMIT_REACHED") return { type: "defer", retryAt: r.retryAt, reason: "LIMIT_REACHED" };
  if (r.reason === "CONCURRENCY_RETRY_EXHAUSTED") return { type: "defer", retryAt: ctx.now() + 30000, reason: r.reason };
  return fail(r.reason, r.message, r.retryable === false);
}

const HANDLERS = Object.freeze({ news_scout: newsScout, news_director: newsDirector, research_editor: researchEditor, writer, fact_checker: factChecker, standards_editor: standardsEditor, source_editor: sourceEditor, cms_editor: cmsEditor });

module.exports = { HANDLERS, linksIn };
