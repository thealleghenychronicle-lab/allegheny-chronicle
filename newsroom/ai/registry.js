// Approved-model registry = the free-tier allowlist, as data. This is the ONLY place a
// provider:model pair can become callable. Identity-based (not quota-based) — Section 10/11.
"use strict";
const { KNOWN_PROVIDERS } = require("./constants");

class ModelNotApprovedError extends Error {
  constructor(key, reason) {
    super(`BLOCKED: "${key}" is not an approved free-tier model (${reason})`);
    this.name = "ModelNotApprovedError";
    this.key = key;
    this.reason = reason;
  }
}

function parseModelKey(key) {
  if (typeof key !== "string") return null;
  const i = key.indexOf(":");               // model ids may themselves contain ":" (e.g. "...:free")
  if (i <= 0 || i === key.length - 1) return null;
  return { provider: key.slice(0, i), model: key.slice(i + 1) };
}

// Model ids are interpolated into URLs / request bodies, so only a conservative character set is accepted.
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-\/:~]*$/;
// Cloudflare Workers AI ids look like "@cf/vendor/model" (leading "@"), so they get their own strict pattern.
const SAFE_CLOUDFLARE_ID = /^@cf\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
// Models Cloudflare documents as requiring the Workers Paid plan / AI Gateway credits (pricing page, read 2026-10-10).
// They must never be callable on the free-only path, even if someone adds one to the allowlist by mistake.
const CLOUDFLARE_PAID_ONLY = Object.freeze([
  "@cf/moonshotai/kimi-k2.6", "@cf/moonshotai/kimi-k2.7-code", "@cf/zai-org/glm-5.2", "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash", "@cf/deepseek-ai/deepseek-v4-flash-0731", "@cf/deepseek-ai/deepseek-v4-pro-0813"
]);

// Extra identity rules per provider, on top of the allowlist.
const PROVIDER_RULES = {
  openrouter: (model) => {
    // Routers (e.g. "openrouter/free", "openrouter/auto") choose the served model themselves, so the free-only
    // gate cannot check what will actually run. Never allowed.
    if (/^openrouter\//.test(model)) return "OPENROUTER_ROUTER_NOT_ALLOWED";
    // OpenRouter marks its free variants with a ":free" suffix; anything else may bill credits.
    if (!/:free$/.test(model)) return "OPENROUTER_MODEL_NOT_FREE_VARIANT";
    // Other variant suffixes (":nitro", ":floor", ":online", ...) change routing/cost; only a single trailing ":free" is allowed.
    if (model.slice(0, -":free".length).includes(":")) return "OPENROUTER_VARIANT_NOT_ALLOWED";
    return null;
  },
  cloudflare: (model) => {
    if (CLOUDFLARE_PAID_ONLY.includes(model)) return "CLOUDFLARE_MODEL_REQUIRES_PAID_PLAN";
    return null;
  }
};

const NULL_LIMITS = Object.freeze({ rpm: null, rpd: null, tpm: null, tpd: null });

function createModelRegistry({ allowedFreeModels, overrides = {} }) {
  if (!Array.isArray(allowedFreeModels)) throw new Error("allowedFreeModels must be an array");
  const allowed = new Set(allowedFreeModels);
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key)) throw new ModelNotApprovedError(key, "override for a model that is not on the free-tier allowlist");
  }

  const entries = new Map();
  const issues = [];
  allowedFreeModels.forEach((key, idx) => {
    const parsed = parseModelKey(key);
    if (!parsed) { issues.push({ key, code: "MALFORMED_MODEL_KEY" }); return; }
    if (!KNOWN_PROVIDERS.includes(parsed.provider)) { issues.push({ key, code: "UNKNOWN_PROVIDER" }); return; }
    if (/placeholder/i.test(parsed.model)) { issues.push({ key, code: "PLACEHOLDER_MODEL" }); return; }
    const idPattern = parsed.provider === "cloudflare" ? SAFE_CLOUDFLARE_ID : SAFE_MODEL_ID;
    if (!idPattern.test(parsed.model) || /\.\.|\/\/|\/$/.test(parsed.model)) { issues.push({ key, code: "UNSAFE_MODEL_ID" }); return; }
    const rule = PROVIDER_RULES[parsed.provider];
    const ruleIssue = rule ? rule(parsed.model) : null;
    if (ruleIssue) { issues.push({ key, code: ruleIssue }); return; }
    const o = overrides[key] || {};
    if (o.enabled === false) { issues.push({ key, code: "DISABLED_BY_OVERRIDE" }); return; }
    entries.set(key, Object.freeze({
      key,
      provider: parsed.provider,
      model: parsed.model,
      tier: "free",
      approved: true,
      priority: Number.isFinite(o.priority) ? o.priority : (idx + 1) * 10,
      capabilities: Object.freeze([...(o.capabilities || ["text"])]),
      maxOutputTokens: o.maxOutputTokens == null ? null : o.maxOutputTokens,
      // Real limits are supplied later (from provider docs / live headers). Never invented here.
      limits: Object.freeze({ ...NULL_LIMITS, ...(o.limits || {}) }),
      // Optional LOCAL daily Neuron safety budget (Cloudflare). An estimate, never Cloudflare's own account usage.
      budget: o.budget ? Object.freeze({ ...o.budget }) : null
    }));
  });

  const sorted = [...entries.values()].sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : 1));
  const issueByKey = new Map(issues.map((i) => [i.key, i]));

  return Object.freeze({
    issues: Object.freeze(issues),
    list: () => sorted.slice(),
    get: (key) => entries.get(key) || null,
    isApproved: (key) => entries.has(key),
    // Hard gate. Throws for anything not on the allowlist or not usable.
    assertApproved(provider, model) {
      const key = `${provider}:${model}`;
      if (entries.has(key)) return entries.get(key);
      const issue = issueByKey.get(key);
      throw new ModelNotApprovedError(key, issue ? issue.code : "not on allowlist");
    }
  });
}

module.exports = { createModelRegistry, ModelNotApprovedError, parseModelKey, CLOUDFLARE_PAID_ONLY };
