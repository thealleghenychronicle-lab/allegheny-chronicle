"use strict";
// Free-model allowlist is DERIVED from newsroom/ai/free-models.js (evidence registry, verified 2026-10-08).
// Only records with status VERIFIED_FREE are enabled. To change the allowlist, change the evidence record
// (with sources + date), never this file. See newsroom/FREE_MODELS.md.
const freeModels = require("./ai/free-models");

// Cloudflare local Neuron safety budget: configurable, but only DOWNWARD from the shipped default (which is already
// half of the documented 10,000/day Free allowance). A missing, malformed, zero, negative or larger value is ignored.
function resolveModelOverrides(env = process.env) {
  const base = freeModels.MODEL_OVERRIDES;
  const raw = env.NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET;
  const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    out[k] = v.budget && n != null && n > 0 && n < v.budget.dailyNeurons ? { ...v, budget: { ...v.budget, dailyNeurons: n } } : v;
  }
  return Object.freeze(out);
}

module.exports = {
  MAX_ARTICLES_PER_ROLLING_24H: 3,
  STATE_BRANCH: "newsroom-state",
  PRODUCTION_BRANCH: "main",
  ALLOWED_FREE_MODELS: freeModels.ALLOWED_FREE_MODELS,
  // Registry overrides (priority, capabilities, maxOutputTokens, PUBLISHED limits only; null = unverified/unenforced).
  MODEL_OVERRIDES: resolveModelOverrides(),
  resolveModelOverrides,
  // Kept for interface compatibility. Now only documented limits (derived); still not consumed outside the registry.
  DEFAULT_QUOTA_HINTS: Object.freeze(Object.fromEntries(
    Object.entries(freeModels.MODEL_OVERRIDES).map(([k, v]) => [k, v.limits])
  )),
  SAFE_MODE: process.env.NEWSROOM_SAFE_MODE !== "false",
  DRY_RUN_OUTPUT_DIR: "newsroom/state/dry-run-output",
  PRODUCTION_ARTICLES_DIR: "content/articles",
  EDITORIAL_STANDARDS_PATH: "newsroom/shared/editorial-standards.json",
  EMPLOYEES_DIR: "newsroom/employees"
};
