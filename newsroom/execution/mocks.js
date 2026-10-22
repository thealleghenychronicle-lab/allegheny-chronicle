// Deterministic OFFLINE test doubles for the AI Router and Research Router interfaces.
// No network, no credentials. They implement the same call shapes the real routers expose:
//   ai.route(request)          -> router response ({ok,status,content,retry,error,...})  [see ../router.js]
//   research.research(request) -> { status, results, error, ... }                           [see ../research/router.js]
"use strict";
const { createRequest } = require("../ai/request");
const { STATUS, ERROR_CATEGORIES: C } = require("../ai/constants");
const { createResearchRouter } = require("../research/router");
const { ResearchProviderAdapter } = require("../research/provider");
const { RESEARCH_ERROR_CATEGORIES: RC } = require("../research/constants");
const { slugify } = require("../cms/article");

const iso = (t) => (t == null ? null : new Date(t).toISOString());

// ---------------- AI ----------------
// scenario:
//   directorWriter     - writer id the mock director returns (exercises the News Director override)
//   directorNewsworthy - false => director rejects the lead
//   verdicts           - { fact_check|standards_review|source_analysis: [ {verdict,target,reason} | "pass" ... ] } consumed in order, then "pass"
//   badFirstDraft      - first writer draft cites a URL that is not in the research packet (fact-check should catch it)
//   inject             - [{ taskType?, employee?, times, mode: "waiting"|"failed"|"permanent"|"malformed" }]
class MockAIRouter {
  constructor({ now = Date.now, scenario = {}, knownEmployees = null } = {}) {
    this.now = now; this.scenario = scenario; this.knownEmployees = knownEmployees;
    this.calls = []; this._verdictIdx = {}; this._inject = (scenario.inject || []).map((i) => ({ ...i }));
  }

  async route(raw) {
    const request = createRequest(raw, { knownEmployees: this.knownEmployees });   // same contract the real router enforces
    this.calls.push({ taskType: request.taskType, employee: request.employeeId, requestId: request.requestId, prompt: request.prompt, system: request.system });
    const inj = this._inject.find((i) => i.times > 0 && (!i.taskType || i.taskType === request.taskType) && (!i.employee || i.employee === request.employeeId));
    if (inj) {
      inj.times -= 1;
      if (inj.mode === "waiting") {
        const retryAt = this.now() + (inj.retryAfterMs || 20 * 60 * 1000);
        return this._resp(request, { ok: false, status: STATUS.WAITING, error: { category: C.ALL_OPTIONS_TEMPORARILY_UNAVAILABLE, message: "mock: all options temporarily unavailable", retryable: true },
          retry: { retryable: true, retryAt: iso(retryAt), retryAfterMs: retryAt - this.now(), reason: "ALL_APPROVED_OPTIONS_TEMPORARILY_UNAVAILABLE" } });
      }
      if (inj.mode === "failed") return this._resp(request, { ok: false, status: STATUS.FAILED, error: { category: C.UNKNOWN, message: "mock: provider error", retryable: false }, retry: { retryable: false, retryAt: null, reason: C.UNKNOWN } });
      if (inj.mode === "permanent") return this._resp(request, { ok: false, status: STATUS.FAILED, error: { category: C.NO_ELIGIBLE_MODEL, message: "mock: no eligible model", retryable: false }, retry: { retryable: false, retryAt: null, reason: C.NO_ELIGIBLE_MODEL } });
      if (inj.mode === "malformed") return this._resp(request, { ok: true, status: STATUS.SUCCESS, content: "this is not json" });
    }
    return this._resp(request, { ok: true, status: STATUS.SUCCESS, content: this._content(request) });
  }

  _verdict(taskType) {
    const list = (this.scenario.verdicts && this.scenario.verdicts[taskType]) || [];
    const i = this._verdictIdx[taskType] || 0; this._verdictIdx[taskType] = i + 1;
    const v = list[i];
    if (!v || v === "pass") return { verdict: "pass", reason: "mock: no issues found" };
    return { verdict: "revise", target: "writer", reason: "mock: reviewer requested a change", ...v };
  }

  _content(request) {
    const p = request.prompt;
    const title = (/^TITLE: (.*)$/m.exec(p) || [])[1] || "Untitled";
    const sources = [...p.matchAll(/^\[(\d+)\] (.*?) \| (\S+) \| (.*)$/gm)].map((m) => ({ title: m[2], url: m[3], publisher: m[4] }));
    switch (request.taskType) {
      case "story_evaluation": {
        const out = { newsworthy: this.scenario.directorNewsworthy !== false, reason: "mock: recent and locally relevant" };
        if (this.scenario.directorWriter) out.writer = this.scenario.directorWriter;
        return JSON.stringify(out);
      }
      case "research_synthesis":
        return JSON.stringify({ brief: `Mock brief for "${title}" drawing on ${sources.length} listed source(s).`, gaps: ["mock: no primary documents available offline"] });
      case "writing": {
        const revised = /REVISION REQUESTED/.test(p);
        const [a, b] = [sources[0], sources[1] || sources[0]];
        const bad = this.scenario.badFirstDraft && !revised ? " An unverified report ([see here](https://example.com/not-in-the-research-packet)) adds detail." : "";
        const body = `${title} is the subject of local business coverage this week, according to [${a ? a.publisher : "a source"}](${a ? a.url : "https://example.com"}).\n\n` +
          `Additional context appears in [${b ? b.publisher : "a second source"}](${b ? b.url : "https://example.com"}). Details that the research packet does not confirm are not reported here.${bad}\n`;
        const writer = request.employeeId;
        return JSON.stringify({ title, businessName: `${title.split(" ").slice(0, 2).join(" ")} (mock)`, location: "Pittsburgh, PA", tags: ["pittsburgh", "dry-run", writer], excerpt: `Dry-run article by ${writer} about ${title}.`, body });
      }
      case "fact_check": case "standards_review": case "source_analysis":
        return JSON.stringify(this._verdict(request.taskType));
      default: return "{}";
    }
  }

  _resp(request, r) {
    return { ok: r.ok, status: r.status, content: r.content || null, provider: "mock", model: "mock-model", servedModel: "mock-model", finishReason: r.ok ? "stop" : null,
      usage: r.ok ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : null, request: { requestId: request.requestId, taskType: request.taskType, employeeId: request.employeeId },
      error: r.error || null, retry: r.retry || null, quota: { selected: null, evaluated: [] }, routing: { attempts: [], rejected: [] } };
  }
}

// ---------------- Research ----------------
// Deterministic provider: results derive from the query text. failTimes => first N run() calls fail with a transient error.
class ScriptedResearchProvider extends ResearchProviderAdapter {
  constructor({ id = "mock-scripted", failTimes = 0, failCategory = RC.TEMPORARY_FAILURE, empty = false } = {}) {
    super({ id }); this.failTimes = failTimes; this.failCategory = failCategory; this.empty = empty; this.calls = [];
  }
  async run(request) {
    this.calls.push({ query: request.query, topics: [...request.topics] });
    if (this.failTimes > 0) { this.failTimes -= 1; return this._fail(this.failCategory, `${this.id}: scripted failure`); }
    if (this.empty) return this._ok([]);
    const slug = slugify(request.query).slice(0, 40) || "story";
    const n = Math.min(request.maxResults, 3);
    return this._ok(Array.from({ length: n }, (_, i) => ({
      title: `${request.query} — local coverage ${i + 1}`, url: `https://example.com/dry-run/${slug}/${i + 1}`,
      publisher: ["Example Business Journal", "Example Local News", "Example County Records"][i % 3],
      publishedAt: "2026-10-03T12:00:00.000Z", excerpt: `Mock excerpt ${i + 1} for ${request.query}.`, sourceId: `${slug}-${i + 1}`,
      topics: [...request.topics], location: request.location
    })));
  }
}

function makeMockResearchRouter(opts = {}) {
  const provider = new ScriptedResearchProvider(opts);
  return Object.assign(createResearchRouter({ providers: { [provider.id]: provider } }), { provider });
}

module.exports = { MockAIRouter, ScriptedResearchProvider, makeMockResearchRouter };
