// Prompt construction + AI-output parsing for employee stages. Pure functions, no I/O.
// Prompts use labeled sections (TITLE:, SOURCES:, DRAFT: ...) so offline mocks and real models see the same contract.
"use strict";

function systemFor(profile, standards) {
  const lines = [
    `You are ${profile.name}, ${profile.position} at ${standards.publisher || "The Allegheny Chronicle"}. ${profile.background || ""}`.trim(),
    profile.writingStyle ? `Writing style: ${profile.writingStyle}.` : null,
    "Editorial standards:", ...(standards.standards || []).map((s) => `- ${s}`),
    "Hard rules: never fabricate quotes, sources or URLs; use only the URLs listed under SOURCES; link sources inline at the point of use.",
    "Respond with the exact output format requested, nothing else."
  ];
  return lines.filter(Boolean).join("\n");
}

const sourceLines = (sources) => sources.map((s, i) => `[${i + 1}] ${s.title} | ${s.url} | ${s.publisher || "unknown publisher"}`).join("\n");
const revisionBlock = (job) => (job.revision && job.revision.current
  ? `\nREVISION REQUESTED (by ${job.revision.current.requestedBy}, from ${job.revision.current.fromStage}): ${job.revision.current.reason}${job.revision.current.notes ? ` | notes: ${job.revision.current.notes}` : ""}\n` : "");

const prompts = {
  director: ({ job, leads, limit }) => [
    "TASK: Evaluate this lead. Decide if it is genuinely newsworthy and recent, and (optionally) name a writer id (zaydan|riham|lubna) if the default writer for the category is wrong.",
    `TITLE: ${job.request.title}`, `CATEGORY: ${job.request.category}`, job.request.notes ? `NOTES: ${job.request.notes}` : null,
    `LIMIT_SOFT_CHECK: ${limit.remaining} of ${limit.maxPerWindow} draft slots remain in the rolling 24h window`,
    "LEADS:", sourceLines(leads),
    'Respond with JSON only: {"newsworthy":true|false,"writer":"<id or omit>","reason":"..."}'
  ].filter(Boolean).join("\n"),
  researchEditor: ({ job, sources }) => [
    "TASK: Synthesize a research brief for the writer. Say plainly what cannot be confidently reported.",
    `TITLE: ${job.request.title}`, "SOURCES:", sourceLines(sources), revisionBlock(job),
    'Respond with JSON only: {"brief":"...","gaps":["..."]}'
  ].filter(Boolean).join("\n"),
  writer: ({ job, sources, brief, byline }) => [
    "TASK: Write the article from the research packet only.",
    `TITLE: ${job.request.title}`, `CATEGORY: ${job.request.category}`, `BYLINE: ${byline}`,
    `BRIEF: ${brief}`, "SOURCES:", sourceLines(sources), revisionBlock(job),
    'Respond with JSON only: {"title":"...","businessName":"...","location":"...","tags":["..."],"excerpt":"...","body":"markdown with inline [text](url) links"}'
  ].filter(Boolean).join("\n"),
  review: ({ task, job, article, sources }) => [
    `TASK: ${task}`, `TITLE: ${article.title}`, "SOURCES:", sourceLines(sources), "DRAFT:", article.body,
    // Phase 3 / Step 3: keep supplied evidence and unsupported assertions apart. This is an editorial aid, not proof of accuracy.
    "EVIDENCE RULE: only the SOURCES listed above count as supplied evidence. Do not confirm any claim from outside knowledge. List each claim the supplied sources do not support as unsupported in \"reason\", and say which claims the supplied sources do support. Your review is a flag for the human editor, not proof that the article is accurate.",
    'Respond with JSON only: {"verdict":"pass"|"revise","target":"writer"|"research_editor","reason":"..."}'
  ].join("\n")
};

// Tolerant JSON extraction (models sometimes wrap JSON in code fences). Returns null if unusable.
function parseJson(content) {
  if (typeof content !== "string") return null;
  let t = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1];
  try { const v = JSON.parse(t); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (_) { return null; }
}

module.exports = { systemFor, prompts, parseJson, sourceLines };
