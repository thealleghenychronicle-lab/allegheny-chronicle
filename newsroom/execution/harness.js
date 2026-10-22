// Wires the full offline stack (queue + mocks + draft service + runner) with an injectable clock.
// Used by the dry run and the tests. Offline by construction: mock AI, mock research, LocalStateStore, memory/dir sink.
"use strict";
const { LocalStateStore } = require("../local-state-store");
const { JobQueue } = require("../workflow/queue");
const { MemoryDraftSink, DirDraftSink } = require("../cms/draft-sinks");
const { createDraftService } = require("../cms/draft-service");
const { MockAIRouter, makeMockResearchRouter } = require("./mocks");
const { WorkflowRunner } = require("./runner");
const { loadEmployees } = require("../workflow/handoff");

const DEFAULT_START = Date.parse("2026-10-04T16:00:00.000Z");

function makeClock(start = DEFAULT_START) {
  const c = { t: start };
  const now = () => c.t;
  now.advance = (ms) => { c.t += ms; return c.t; };
  now.set = (t) => { c.t = t; return c.t; };
  return now;
}

function buildHarness({ scenario = {}, research = {}, outDir = null, now = makeClock(), store = new LocalStateStore(), sink = null, ai = null, researchRouter = null, runnerOpts = {} } = {}) {
  const employees = loadEmployees();
  const queue = new JobQueue({ store, now, employees });
  const theSink = sink || (outDir ? new DirDraftSink(outDir) : new MemoryDraftSink());
  const drafts = createDraftService({ store, sink: theSink, now });
  const theAi = ai || new MockAIRouter({ now, scenario, knownEmployees: [...employees.keys()] });
  const theResearch = researchRouter || makeMockResearchRouter(research);
  const runner = new WorkflowRunner({ queue, ai: theAi, research: theResearch, drafts, store, now, ...runnerOpts });
  return { now, store, queue, sink: theSink, drafts, ai: theAi, research: theResearch, runner, employees };
}

// Run a job to HUMAN_REVIEW, advancing the fake clock past waits/backoff/deferrals. Returns the final job + a flat trace.
async function runToHumanReview(h, jobId, { maxRounds = 40 } = {}) {
  const trace = [];
  for (let r = 0; r < maxRounds; r++) {
    const res = await h.runner.runJob(jobId);
    trace.push(...res.steps);
    if (res.stopped === "HUMAN_REVIEW" || res.stopped === "EXHAUSTED" || res.stopped === "NOT_FOUND") return { ...res, trace };
    if (res.stopped === "NOT_ELIGIBLE_YET" && res.resumeAt) { h.now.set(Math.max(h.now(), Date.parse(res.resumeAt)) + 1000); continue; }
    return { ...res, trace };
  }
  return { jobId, stopped: "MAX_ROUNDS", trace, job: h.queue.get(jobId) };
}

module.exports = { buildHarness, runToHumanReview, makeClock, DEFAULT_START };
