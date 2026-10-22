// Free-model EVIDENCE REGISTRY (Phase 3 / Step 1). Pure data + derivation. No network, no secrets.
//
// This is the only place a model can become enabled. config.ALLOWED_FREE_MODELS and
// config.MODEL_OVERRIDES are DERIVED from it, and ONLY records with status "VERIFIED_FREE"
// are enabled. Everything else (UNVERIFIED / NOT_FREE / UNAVAILABLE) is recorded here so the
// reason is visible, but is excluded from the allowlist.
//
// Evidence was gathered on VERIFIED_ON from the providers' official documentation and public
// model-list pages (see sources). Nothing here was tested with an authorized API key.
// "published" limits are what the provider documents; account-specific limits (what YOUR key
// gets) cannot be known without dashboard/authenticated access and are NEVER invented here:
// a null limit means "not published / not verified -> not enforced locally".
//
// Statuses:
//   VERIFIED_FREE  free API inference is documented for this exact ID, the ID is currently listed,
//                  and our free-only rules can express it. ENABLED.
//   UNVERIFIED     free status, availability, or limits could not be confirmed. EXCLUDED.
//   NOT_FREE       provider documents the model as not available on the free tier. EXCLUDED.
//   UNAVAILABLE    provider documents it as shut down. EXCLUDED.
"use strict";

const VERIFIED_ON = "2026-10-08";
const STATUSES = Object.freeze(["VERIFIED_FREE", "UNVERIFIED", "NOT_FREE", "UNAVAILABLE"]);

const SRC = Object.freeze({
  geminiModels: "https://ai.google.dev/gemini-api/docs/models",
  geminiPricing: "https://ai.google.dev/gemini-api/docs/pricing",
  geminiLimits: "https://ai.google.dev/gemini-api/docs/rate-limits",
  geminiDeprecations: "https://ai.google.dev/gemini-api/docs/deprecations",
  gemini38: "https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash",
  gemini35Lite: "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite",
  groqModels: "https://console.groq.com/docs/models",
  groqLimits: "https://console.groq.com/docs/rate-limits",
  groqBilling: "https://console.groq.com/docs/billing-faqs",
  groqSpend: "https://console.groq.com/docs/spend-limits",
  orModels: "https://openrouter.ai/api/v1/models",
  orCollection: "https://openrouter.ai/collections/free-models/",
  orLimits: "https://openrouter.ai/docs/api-reference/limits",
  orFreeRouter: "https://openrouter.ai/docs/guides/routing/routers/free-router",
  cfModels: "https://developers.cloudflare.com/workers-ai/models/",
  cfModelPage: "https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/",
  cfPricing: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  cfPaidChangelog: "https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/",
  cfLimits: "https://developers.cloudflare.com/workers-ai/platform/limits/",
  cfOpenAi: "https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/"
});


const GROQ_VERIFIED_ON = "2026-10-09";
const GROQ_FREE_EVIDENCE = [
  "Rate-limits page: names two plans (Free and Developer); the limits table is headed \"Free Plan Limits / Developer Plan Limits\" and lists this model; the page says \"Upgrade to Developer plan to access higher limits, Batch and Flex processing\".",
  "Billing FAQ: upgrading to Developer requires \"a valid payment method\"; downgrading \"returns [the account] to Free tier rate limits and restrictions\". Spend-limits page: \"Spending limits are only available on paid plans, not free tier accounts.\" => a Free-tier org has no payment method and cannot be invoiced."
];
const GROQ_ACCOUNT =
  "Usable at no cost ONLY while the Groq organization stays on the FREE plan (no payment method, no upgrade to Developer). A Developer-plan org is billed per token (models page: $0.075 in / $0.30 out per 1M tokens for gpt-oss-20b).";
const GROQ_UNCERTAINTY = [
  "NO official page states in one sentence \"model X is included in the Free plan\". Eligibility is INFERRED from: Free plan exists + cannot be billed + model is Production, listed in the limits table, and not marked Enterprise/Contact Sales. This is the weakest evidence tier in the registry.",
  "The limits table is ambiguous: its header names both plans but the page also says \"the limits shown below are the base limits for the Developer plan\". Values seen (30 RPM / 1K RPD / 8K TPM / 200K TPD) are therefore NOT enforced locally (null); provider 429 + retry-after + x-ratelimit-* headers are authoritative. Free-plan numbers may be lower.",
  "The docs never say whether a payment method is needed to create an API key; the Developer-upgrade requirement implies not. The sandbox could not reach the Groq community FAQ (redirected). Confirm in your console: https://console.groq.com/settings/limits and billing page show plan = Free.",
  "If a Groq request ever returns a billing/payment/forbidden error the adapter disables the model permanently (no fallback to anything paid)."
];

const CF_VERIFIED_ON = "2026-10-10";
// Cloudflare free allowance (documented) and the LOCAL conservative budget derived from it.
const CF_DOCUMENTED_FREE_DAILY_NEURONS = 10000;
const CF_DEFAULT_SAFETY_FRACTION = 0.5;
const CF_NEURON_BUDGET = Object.freeze({
  kind: "LOCAL_ESTIMATE",                                            // never Cloudflare's authoritative account usage
  documentedFreeDailyNeurons: CF_DOCUMENTED_FREE_DAILY_NEURONS,
  dailyNeurons: CF_DOCUMENTED_FREE_DAILY_NEURONS * CF_DEFAULT_SAFETY_FRACTION,  // 5,000 by default; env-configurable DOWNWARD only (config.js)
  inputNeuronsPerMillionTokens: 5500,                               // pricing page, glm-4.7-flash row
  outputNeuronsPerMillionTokens: 36400,
  resetUtcHour: 0
});

const ALL_CAPS = ["text", "long_context", "reasoning", "json_output"];
const NO_LIMITS = Object.freeze({ rpm: null, rpd: null, tpm: null, tpd: null });

const GEMINI_FREE_EVIDENCE =
  "Pricing page: Free Tier input and output = \"Free of charge\" for this ID (Standard tier).";
const GEMINI_ACCOUNT =
  "Free only while the Google AI Studio project has NO billing account linked / is on the Free tier. " +
  "Free-tier content may be used by Google to improve its products (pricing page, \"Free Tier\" column).";
const GEMINI_LIMITS_UNCERTAINTY =
  "Per-model free-tier RPM/TPM/RPD numbers are NOT published in the docs (they are shown only in Google AI Studio for your project). " +
  "Limits are per project and RPD resets at midnight Pacific. Left null (not enforced locally); provider 429s are authoritative.";

const OR_FREE_EVIDENCE =
  "Public model list (api/v1/models): id ends in \":free\" and pricing.prompt = \"0\" and pricing.completion = \"0\"; expiration_date null.";
const OR_LIMITS = Object.freeze({ rpm: 20, rpd: 50, tpm: null, tpd: null });
const OR_LIMITS_NOTE =
  "Published for ALL \":free\" requests: 20 requests/minute; 50 requests/day if < 10 credits purchased (1000/day at >= 10 credits). " +
  "50/day is used (the lower bound). The docs do not say whether the daily cap is shared across free models; treat it as account-wide. " +
  "Local pacing is tracked per model, so it can over-allow; the provider 429 is the backstop.";
const OR_ACCOUNT =
  "Account must keep a NON-NEGATIVE credit balance: a negative balance can return 402 even for free models (limits page). " +
  "Data-retention / training policy for this model is NOT documented in the pages read -> UNVERIFIED.";

// Source-of-truth records. `priority` = deterministic routing order (lower first); only meaningful when enabled.
const RECORDS = [
  // ---------------- ENABLED ----------------
  {
    provider: "gemini", model: "gemini-3.8-flash", status: "VERIFIED_FREE", priority: 10,
    capabilities: ALL_CAPS, contextWindow: 1048576, maxOutputTokens: 65536,
    publishedLimits: NO_LIMITS,
    freeEvidence: [GEMINI_FREE_EVIDENCE, "Models page: listed Stable (marked New); model page: structured outputs, thinking (low/medium/high), function calling, search grounding, caching supported; latest update September 2026."],
    sources: [SRC.geminiModels, SRC.gemini38, SRC.geminiPricing, SRC.geminiLimits],
    accountPrecondition: GEMINI_ACCOUNT,
    uncertainty: [GEMINI_LIMITS_UNCERTAINTY, "Docs say thinking level \"minimal\" returns an error (our adapter sends no thinking config). Whether thinking tokens count against maxOutputTokens was not confirmed in the pages read: callers should leave generous output headroom."]
  },
  {
    provider: "gemini", model: "gemini-3.5-flash-lite", status: "VERIFIED_FREE", priority: 20,
    capabilities: ALL_CAPS, contextWindow: 1048576, maxOutputTokens: 65536,
    publishedLimits: NO_LIMITS,
    freeEvidence: [GEMINI_FREE_EVIDENCE, "Models page: listed Stable; model page: structured outputs, thinking, function calling, search grounding supported. Docs recommend it (with 3.8 Flash) for new projects."],
    sources: [SRC.geminiModels, SRC.gemini35Lite, SRC.geminiPricing, SRC.geminiLimits],
    accountPrecondition: GEMINI_ACCOUNT,
    uncertainty: [GEMINI_LIMITS_UNCERTAINTY, "Lite tier: expected to be weaker than 3.8 Flash for long-form writing / fact-check reasoning (no quality testing was done in this step)."]
  },
  {
    provider: "openrouter", model: "apodex/apodex-1.1-mini:free", status: "VERIFIED_FREE", priority: 30,
    capabilities: ALL_CAPS, contextWindow: 262144, maxOutputTokens: 235929,
    publishedLimits: OR_LIMITS,
    freeEvidence: [OR_FREE_EVIDENCE, "Also listed on the free-models collection page. Parameters listed: tools, tool_choice, response_format, structured_outputs, reasoning, max_tokens, seed, stop, temperature, top_p."],
    sources: [SRC.orModels, SRC.orCollection, SRC.orLimits],
    accountPrecondition: OR_ACCOUNT,
    uncertainty: [OR_LIMITS_NOTE, "Unknown vendor/model: NO quality or reliability evidence for article writing or fact-checking. Last-resort fallback only.", "Free-model availability changes frequently (OpenRouter's own warning)."]
  },
  {
    provider: "openrouter", model: "inclusionai/ling-3.0-flash-sante:free", status: "VERIFIED_FREE", priority: 40,
    // Parameter list has reasoning/include_reasoning but NO response_format/structured_outputs -> json_output not claimed.
    capabilities: ["text", "long_context", "reasoning"], contextWindow: 262144, maxOutputTokens: 32768,
    publishedLimits: OR_LIMITS,
    freeEvidence: [OR_FREE_EVIDENCE, "Also listed on the free-models collection page."],
    sources: [SRC.orModels, SRC.orCollection, SRC.orLimits],
    accountPrecondition: OR_ACCOUNT,
    uncertainty: [OR_LIMITS_NOTE, "Name suggests a domain-tuned (\"Sante\") variant; suitability for general news writing is UNVERIFIED. No response_format/structured_outputs in its parameter list.", "Last-resort fallback only."]
  },

  // ---------------- EXCLUDED: Gemini ----------------
  ...[
    ["gemini-3.7-flash", "Stable"], ["gemini-3.6-flash", "Stable"], ["gemini-3.5-flash", "Stable (described as legacy)"], ["gemini-3.1-flash-lite", "Stable"]
  ].map(([model, label]) => ({
    provider: "gemini", model, status: "UNVERIFIED", priority: null, capabilities: [], contextWindow: null, maxOutputTokens: null,
    publishedLimits: NO_LIMITS,
    freeEvidence: [`Models page: ${label}. Pricing page: Free Tier \"Free of charge\".`],
    sources: [SRC.geminiModels, SRC.geminiPricing],
    accountPrecondition: GEMINI_ACCOUNT,
    uncertainty: ["Not enabled: its model detail page (token limits, capabilities) was not read in this step. Promote by reading that page, then change status to VERIFIED_FREE with real values."]
  })),
  {
    provider: "gemini", model: "gemini-3-flash-preview", status: "UNVERIFIED", priority: null, capabilities: [], contextWindow: null, maxOutputTokens: null,
    publishedLimits: NO_LIMITS, freeEvidence: [], sources: [SRC.geminiModels, SRC.geminiDeprecations],
    accountPrecondition: GEMINI_ACCOUNT,
    uncertainty: ["Preview model (may change/retire); its pricing row could not be read; docs recommend gemini-3.6-flash as replacement."]
  },
  ...["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"].map((model) => ({
    provider: "gemini", model, status: "UNVERIFIED", priority: null, capabilities: [], contextWindow: null, maxOutputTokens: null,
    publishedLimits: NO_LIMITS,
    freeEvidence: ["Pricing page shows free-of-charge Standard tier."],
    sources: [SRC.geminiModels, SRC.geminiPricing, SRC.geminiDeprecations],
    accountPrecondition: GEMINI_ACCOUNT,
    uncertainty: ["Docs: access is limited to users who have actively used the 2.5 models; new projects are steered to 3.5 Flash-Lite / 3.8 Flash. Whether OUR project has access cannot be verified without authenticated access."]
  })),
  {
    provider: "gemini", model: "gemini-3.1-pro-preview", status: "NOT_FREE", priority: null, capabilities: [], contextWindow: null, maxOutputTokens: null,
    publishedLimits: NO_LIMITS,
    freeEvidence: ["Pricing page: Free Tier input/output = \"Not available\"."],
    sources: [SRC.geminiPricing], accountPrecondition: GEMINI_ACCOUNT,
    uncertainty: ["Paid-only. Must never be callable."]
  },
  {
    provider: "gemini", model: "gemini-1.5-flash", status: "UNVERIFIED", priority: null, capabilities: [], contextWindow: null, maxOutputTokens: null,
    publishedLimits: NO_LIMITS, freeEvidence: [], sources: [SRC.geminiModels, SRC.geminiDeprecations],
    accountPrecondition: GEMINI_ACCOUNT,
    uncertainty: ["This was the Chunk 1 allowlist entry. It is absent from the current models page and not mentioned on the deprecations page; treated as unavailable. REMOVED from the allowlist."]
  },
  ...["gemini-2.0-flash", "gemini-2.0-flash-lite"].map((model) => ({
    provider: "gemini", model, status: "UNAVAILABLE", priority: null, capabilities: [], contextWindow: null, maxOutputTokens: null,
    publishedLimits: NO_LIMITS, freeEvidence: [], sources: [SRC.geminiModels, SRC.geminiDeprecations], accountPrecondition: GEMINI_ACCOUNT,
    uncertainty: ["Deprecations page: shutdown June 1, 2026 (gemini-2.0-flash replacement: gemini-3.6-flash); models page lists it under Previous models (shut down)."]
  })),

  // ---------------- Groq (re-checked 2026-10-09, Phase 3 / Step 2) ----------------
  {
    provider: "groq", model: "openai/gpt-oss-20b", status: "UNVERIFIED", priority: null, verifiedAt: GROQ_VERIFIED_ON,
    capabilities: [], contextWindow: 131072, maxOutputTokens: 65536,
    publishedLimits: NO_LIMITS,
    freeEvidence: GROQ_FREE_EVIDENCE.concat(["Models page: Production model, no \"Enterprise\"/\"Contact Sales\" label; 131,072 context, 65,536 max completion tokens; it is one of the models in the rate-limits table."]),
    sources: [SRC.groqModels, SRC.groqLimits, SRC.groqBilling, SRC.groqSpend],
    accountPrecondition: GROQ_ACCOUNT,
    uncertainty: ["DISABLED in Phase 3 / Step 3 (2026-10-10) by owner decision: it has not been established that an eligible Groq model is available to this project without payment, so Groq is out of the active fallback chain. Not investigated further.", "Step 2 had enabled it on circumstantial evidence only (see below).", ...GROQ_UNCERTAINTY]
  },
  {
    provider: "groq", model: "openai/gpt-oss-120b", status: "UNVERIFIED", priority: null, verifiedAt: GROQ_VERIFIED_ON,
    capabilities: [], contextWindow: 131072, maxOutputTokens: 65536,
    publishedLimits: NO_LIMITS,
    freeEvidence: GROQ_FREE_EVIDENCE,
    sources: [SRC.groqModels, SRC.groqLimits, SRC.groqBilling, SRC.groqSpend],
    accountPrecondition: GROQ_ACCOUNT,
    uncertainty: GROQ_UNCERTAINTY.concat(["Same evidence as gpt-oss-20b. Groq is disabled as a provider (Step 3 owner decision); do not promote any Groq model without an owner-approved eligibility check."])
  },
  ...[
    ["llama-3.1-8b-instant", 131072, 131072], ["llama-3.3-70b-versatile", 131072, 32768]
  ].map(([model, ctx, out]) => ({
    provider: "groq", model, status: "UNVERIFIED", priority: null, capabilities: [], contextWindow: ctx, maxOutputTokens: out,
    publishedLimits: NO_LIMITS, freeEvidence: [],
    sources: [SRC.groqModels, SRC.groqLimits],
    accountPrecondition: "See openai/gpt-oss-120b entry.",
    uncertainty: [
      "Listed as a production model but priced \"Contact Sales\" (model page shows an \"Enterprise\" label) and ABSENT from the rate-limits table, so free-tier availability cannot be verified.",
      ...(model === "llama-3.1-8b-instant" ? ["This was the Chunk 1 allowlist entry. REMOVED from the allowlist."] : [])
    ]
  })),

  // ---------------- Cloudflare Workers AI (Phase 3 / Step 3, verified 2026-10-10) ----------------
  {
    provider: "cloudflare", model: "@cf/zai-org/glm-4.7-flash", status: "VERIFIED_FREE", priority: 50, verifiedAt: CF_VERIFIED_ON,
    capabilities: ["text", "long_context", "reasoning"], contextWindow: 131072,
    maxOutputTokens: null, maxOutputTokensUnpublished: true,
    publishedLimits: NO_LIMITS,
    // Local safety budget (an ESTIMATE; Cloudflare's own account usage cannot be read by this integration). See cloudflare-budget notes in FREE_MODELS.md.
    neuronBudget: CF_NEURON_BUDGET,
    freeEvidence: [
      "Pricing page: Workers Free includes 10,000 Neurons/day at no charge; \"Workers Free has no paid usage option\" (going beyond requires upgrading to Workers Paid); limits reset daily at 00:00 UTC; when exceeded \"further operations will fail with an error\".",
      "Pricing page: the models that require Workers Paid or AI Gateway credits are listed explicitly (kimi-k2.6, kimi-k2.7-code, glm-5.2, glm-5.3, glm-5.3-flash, deepseek-v4-flash-0731, deepseek-v4-pro-0813). @cf/zai-org/glm-4.7-flash is NOT on that list and has its own price row: 5,500 Neurons per M input tokens, 36,400 Neurons per M output tokens ($0.060 / $0.400 per M tokens).",
      "Changelog 2026-07-28 (\"Select models now require the Workers Paid plan\"): glm-4.7-flash is named among the models that \"remain available on the Workers Free plan\"; the three affected models return 403 (internal code 5035) on Free.",
      "Model page + catalog: Text Generation, Cloudflare-hosted, function calling + reasoning, 131,072-token context window."
    ],
    sources: [SRC.cfModels, SRC.cfModelPage, SRC.cfPricing, SRC.cfPaidChangelog, SRC.cfLimits, SRC.cfOpenAi],
    accountPrecondition: "Free ONLY while the Cloudflare account is on the Workers FREE plan (no Workers Paid subscription). On Workers Paid, usage above 10,000 Neurons/day is billed. The adapter therefore stays inert until the owner sets CLOUDFLARE_FREE_PLAN_CONFIRMED=true, and the local Neuron budget stops requests well below 10,000/day either way. Account-specific access to this model (token permission, plan) has NOT been verified.",
    uncertainty: [
      "Docs pages were read through a web-fetch extractor (not raw HTML). Account-specific access was NOT verified: no API call was made.",
      "maxOutputTokens is not published on the pages read -> left null (not enforced by the registry); callers choose output.maxTokens. Reasoning models may spend output tokens on reasoning: leave headroom.",
      "The Neuron price row is read from the pricing page; the model page shows $0.0605 vs the pricing page $0.060 per M input tokens (rounding). The Neuron figures are used.",
      "No documented API for reading actual Neuron usage/remaining allocation was found in the pages read (limits page is silent). Usage is therefore estimated LOCALLY; the dashboard (Workers AI -> Usage) is the only authoritative view.",
      "Documented response is OpenAI-style (choices[], usage) but the pages do not enumerate sub-fields; the adapter also tolerates the legacy result.response shape. Request parameters beyond `messages` (max_tokens, temperature, top_p, seed, stop) are NOT confirmed for this model's schema. Confirm in the owner-controlled live dry run.",
      "Cloudflare's exact daily-allocation error text/code was not in the pages read; the adapter recognises it by message pattern (\"daily free allocation\", \"neurons\", code 4006) or HTTP 429 and treats any such failure as 'blocked until 00:00 UTC'.",
      "Quality for long-form writing / fact-checking is untested (no live benchmark in this step). Last in the fallback chain."
    ]
  },

  // ---------------- EXCLUDED: OpenRouter ----------------
  {
    provider: "openrouter", model: "openrouter/free", status: "UNVERIFIED", priority: null, capabilities: [], contextWindow: 200000, maxOutputTokens: null,
    publishedLimits: NO_LIMITS,
    freeEvidence: ["Free Models Router docs: \"selects from all currently available free models\"; model page: \"free to use\", 200,000-token context."],
    sources: [SRC.orFreeRouter, "https://openrouter.ai/openrouter/free"],
    accountPrecondition: OR_ACCOUNT,
    uncertainty: [
      "Router, not a model: it picks a model at RANDOM and the caller cannot choose or pin it, so the served model cannot be checked against our registry beforehand.",
      "The docs do NOT explicitly state it can never route to a paid model. Not in the portion of /api/v1/models that could be read. Excluded until OpenRouter states a free-only guarantee.",
      "Its ID has no \":free\" suffix, so the registry's identity rule also rejects it."
    ]
  },
  {
    provider: "openrouter", model: "inclusionai/ling-3.1-flash", status: "UNVERIFIED", priority: null, capabilities: [], contextWindow: 262144, maxOutputTokens: 32768,
    publishedLimits: NO_LIMITS,
    freeEvidence: ["Public model list shows pricing prompt/completion \"0\" and it is shown under Top Free Models."],
    sources: [SRC.orModels, SRC.orCollection],
    accountPrecondition: OR_ACCOUNT,
    uncertainty: ["Zero price but NO \":free\" suffix: nothing guarantees it stays free, and the free-only rule requires \":free\". Excluded."]
  },
  ...[
    "nvidia/nemotron-3-super-120b-a12b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "poolside/laguna-s-2.1:free", "poolside/laguna-xs-2.1:free",
    "thinkingmachines/inkling:free", "thinkingmachines/inkling-small:free", "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free", "liquid/lfm-2.5-2.6b:free"
  ].map((model) => ({
    provider: "openrouter", model, status: "UNVERIFIED", priority: null, capabilities: [], contextWindow: null, maxOutputTokens: null,
    publishedLimits: NO_LIMITS,
    freeEvidence: ["Shown on the free-models collection page (HTML)."],
    sources: [SRC.orCollection],
    accountPrecondition: OR_ACCOUNT,
    uncertainty: [
      "Seen only on the collection page; its pricing/ID could not be confirmed in the readable portion of /api/v1/models. Promote only after confirming the ID and zero pricing in that API.",
      ...(/poolside|liquid/.test(model) ? ["Collection page states prompts/outputs may be used to train the vendor's models."] : [])
    ]
  }))
];

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

const FREE_MODEL_EVIDENCE = deepFreeze(RECORDS.map((r) => ({ key: `${r.provider}:${r.model}`, verifiedAt: VERIFIED_ON, ...r })));

// Structural checks. Run in tests; also applied at load so bad evidence data can never silently enable a model.
function validateEvidence(records = FREE_MODEL_EVIDENCE) {
  const problems = [];
  const seen = new Set();
  for (const r of records) {
    const p = (m) => problems.push(`${r.key}: ${m}`);
    if (seen.has(r.key)) p("duplicate key"); seen.add(r.key);
    if (!STATUSES.includes(r.status)) p(`unknown status ${r.status}`);
    if (!Array.isArray(r.sources) || r.sources.length === 0 || !r.sources.every((s) => /^https:\/\//.test(s))) p("needs https source URLs");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.verifiedAt || "")) p("needs verifiedAt YYYY-MM-DD");
    if (!Array.isArray(r.uncertainty)) p("needs uncertainty[]");
    if (r.status === "VERIFIED_FREE") {
      if (!Array.isArray(r.freeEvidence) || r.freeEvidence.length === 0) p("VERIFIED_FREE needs freeEvidence");
      if (!Number.isFinite(r.priority)) p("VERIFIED_FREE needs numeric priority");
      if (!Number.isInteger(r.contextWindow)) p("VERIFIED_FREE needs a documented contextWindow");
      // maxOutputTokens may only be null when the provider does not publish it AND the record says so explicitly (never guessed).
      if (!Number.isInteger(r.maxOutputTokens) && !(r.maxOutputTokens === null && r.maxOutputTokensUnpublished === true)) p("VERIFIED_FREE needs documented maxOutputTokens (or null + maxOutputTokensUnpublished:true)");
      if (r.provider === "cloudflare") {
        const b = r.neuronBudget;
        if (!b || !(b.dailyNeurons > 0) || b.dailyNeurons > b.documentedFreeDailyNeurons) p("Cloudflare VERIFIED_FREE needs a neuronBudget no larger than the documented free daily allowance");
        if (!b || !(b.inputNeuronsPerMillionTokens > 0) || !(b.outputNeuronsPerMillionTokens > 0)) p("Cloudflare neuronBudget needs documented per-token Neuron rates");
      }
      if (!r.capabilities.includes("text")) p("VERIFIED_FREE needs capabilities incl. text");
      if (r.provider === "openrouter" && !/:free$/.test(r.model)) p("OpenRouter VERIFIED_FREE id must end with :free");
    }
  }
  return problems;
}

const _problems = validateEvidence();
if (_problems.length) throw new Error(`free-model evidence is inconsistent: ${_problems.join("; ")}`);

const enabled = FREE_MODEL_EVIDENCE.filter((r) => r.status === "VERIFIED_FREE").sort((a, b) => a.priority - b.priority || (a.key < b.key ? -1 : 1));

const ALLOWED_FREE_MODELS = Object.freeze(enabled.map((r) => r.key));

// Registry overrides: only documented values; null limits stay null (never invented).
const MODEL_OVERRIDES = deepFreeze(Object.fromEntries(enabled.map((r) => [r.key, {
  priority: r.priority,
  capabilities: [...r.capabilities],
  maxOutputTokens: r.maxOutputTokens,
  limits: { ...r.publishedLimits },
  ...(r.neuronBudget ? { budget: { ...r.neuronBudget } } : {})
}])));

const EXCLUDED_MODELS = Object.freeze(FREE_MODEL_EVIDENCE.filter((r) => r.status !== "VERIFIED_FREE").map((r) => ({ key: r.key, status: r.status })));

// Days since the evidence was gathered (for staleness warnings; not enforced at runtime).
function evidenceAgeDays(now = Date.now(), verifiedOn = VERIFIED_ON) {
  return Math.floor((now - Date.parse(`${verifiedOn}T00:00:00Z`)) / 86400000);
}

module.exports = {
  VERIFIED_ON, CF_VERIFIED_ON, CF_NEURON_BUDGET, STATUSES, FREE_MODEL_EVIDENCE, ALLOWED_FREE_MODELS, MODEL_OVERRIDES, EXCLUDED_MODELS,
  validateEvidence, evidenceAgeDays
};
