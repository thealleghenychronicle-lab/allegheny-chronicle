#!/usr/bin/env node
// Deterministic OFFLINE dry run: one representative job QUEUED -> ... -> HUMAN_REVIEW with mock AI/research.
// No network, no credentials, no GitHub/Cloudflare/Decap. Writes the CMS draft + a report to a local scratch directory only.
//   node newsroom/dry-run.js [--category sports|food|general] [--clean] [--writer <id>] [--out <dir>]
// Default scenario also demonstrates a research wait, an AI wait and a fact-check revision (use --clean for a straight run).
"use strict";
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { buildHarness, runToHumanReview } = require("./execution/harness");
const { FIELD_ORDER, parseCmsMarkdown } = require("./cms/markdown");

async function runDryRun({ category = "sports", title = null, clean = false, writer = null, outDir = null } = {}) {
  const titles = { sports: "Steelers Stadium Sponsorship Deal Announced", food: "Strip District Bakery Opens Second Location", general: "Allegheny County Retailer Expands Hiring" };
  const scenario = { directorWriter: writer || undefined };
  const research = {};
  if (!clean) {
    scenario.badFirstDraft = true;                                                   // Uzayr catches a URL outside the research packet -> revision
    scenario.inject = [{ taskType: "writing", times: 1, mode: "waiting", retryAfterMs: 20 * 60 * 1000 }];   // AI router says WAITING once
    research.failTimes = 1;                                                          // research provider fails once -> WAITING_FOR_RESEARCH
  }
  const h = buildHarness({ scenario, research, outDir });
  const enq = h.queue.enqueue({ title: title || titles[category] || titles.general, category, source: "dry-run" });
  const run = await runToHumanReview(h, enq.job.id);
  const job = h.queue.get(enq.job.id);
  const draftFile = job.data.cms_editor ? job.data.cms_editor.filename : null;
  const draft = draftFile ? h.sink.get(draftFile.replace(/\.md$/, "")) : null;
  const parsed = draft ? parseCmsMarkdown(draft.content) : null;
  const report = {
    dryRun: true, offline: true, network: false, credentials: false,
    finalState: job.state, stoppedAt: run.stopped, writer: job.data.writer ? job.data.writer.writerId : null, writerOverride: job.writerId, category,
    trace: run.trace.map((s) => ({ stage: s.stage, employee: s.employee, outcome: s.outcome, state: s.state, ...(s.kind ? { waitKind: s.kind } : {}), ...(s.target ? { revisionTarget: s.target } : {}) })),
    history: job.history.map((e) => `${e.from} -> ${e.to}${e.stage ? ` [${e.stage}/${e.assignedTo}]` : ""}${e.note ? ` (${e.note})` : ""}`),
    cmsDraft: draft ? { filename: draft.filename, draft: parsed.frontmatter.draft, frontmatterFields: FIELD_ORDER.filter((k) => k in parsed.frontmatter) } : null,
    limiter: h.drafts.status().activeInWindow + " of " + config.MAX_ARTICLES_PER_ROLLING_24H + " slots used",
    aiCalls: h.ai.calls.map((c) => `${c.employee}:${c.taskType}`), researchCalls: h.research.provider.calls.length
  };
  return { report, job, draft, harness: h };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const outDir = path.resolve(opt("out", config.DRY_RUN_OUTPUT_DIR));
  fs.rmSync(outDir, { recursive: true, force: true });
  runDryRun({ category: opt("category", "sports"), clean: args.includes("--clean"), writer: opt("writer"), outDir }).then(({ report }) => {
    fs.writeFileSync(path.join(outDir, "dry-run-report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nDry-run output written to ${outDir}`);
    if (report.finalState !== "HUMAN_REVIEW") process.exitCode = 1;
  });
}

module.exports = { runDryRun };
