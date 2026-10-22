// Shared enums/traits for the Central AI Router. No secrets, no provider logic.
"use strict";
const freeze = Object.freeze;

// Per provider/model state (Phase 1 architecture, Section 9).
const QUOTA_STATES = freeze({
  AVAILABLE: "AVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  DAILY_LIMIT_REACHED: "DAILY_LIMIT_REACHED",
  TOKEN_LIMIT_REACHED: "TOKEN_LIMIT_REACHED",
  TEMPORARILY_UNAVAILABLE: "TEMPORARILY_UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
  DISABLED: "DISABLED"
});

// Overall outcome of router.route().
const STATUS = freeze({ SUCCESS: "SUCCESS", WAITING: "WAITING", FAILED: "FAILED" });

const ERROR_CATEGORIES = freeze({
  // adapter-level (provider said no)
  RATE_LIMIT_TEMPORARY: "RATE_LIMIT_TEMPORARY",
  QUOTA_DAILY: "QUOTA_DAILY",
  QUOTA_TOKENS: "QUOTA_TOKENS",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  UNKNOWN: "UNKNOWN",
  AUTHENTICATION: "AUTHENTICATION",
  CONFIGURATION: "CONFIGURATION",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  INVALID_REQUEST: "INVALID_REQUEST",
  CONTENT_BLOCKED: "CONTENT_BLOCKED",
  // router-level
  INVALID_ROUTER_REQUEST: "INVALID_ROUTER_REQUEST",
  NO_ELIGIBLE_MODEL: "NO_ELIGIBLE_MODEL",
  ALL_OPTIONS_TEMPORARILY_UNAVAILABLE: "ALL_OPTIONS_TEMPORARILY_UNAVAILABLE",
  ALL_OPTIONS_PERMANENTLY_UNAVAILABLE: "ALL_OPTIONS_PERMANENTLY_UNAVAILABLE",
  NOT_APPROVED_FREE: "NOT_APPROVED_FREE"
});
const C = ERROR_CATEGORIES;
const S = QUOTA_STATES;

// How each ADAPTER error category is treated. scope = what gets blocked:
//   model    -> only that provider:model
//   provider -> every model of that provider (e.g. bad API key)
//   request  -> nothing is blocked; the request itself is the problem (never shop it around)
const CATEGORY_TRAITS = freeze({
  [C.RATE_LIMIT_TEMPORARY]: freeze({ retryable: true, scope: "model", state: S.RATE_LIMITED }),
  [C.QUOTA_DAILY]: freeze({ retryable: true, scope: "model", state: S.DAILY_LIMIT_REACHED }),
  [C.QUOTA_TOKENS]: freeze({ retryable: true, scope: "model", state: S.TOKEN_LIMIT_REACHED }),
  [C.PROVIDER_UNAVAILABLE]: freeze({ retryable: true, scope: "model", state: S.TEMPORARILY_UNAVAILABLE }),
  [C.MALFORMED_RESPONSE]: freeze({ retryable: true, scope: "model", state: S.UNKNOWN }),
  [C.UNKNOWN]: freeze({ retryable: true, scope: "model", state: S.UNKNOWN }),
  [C.AUTHENTICATION]: freeze({ retryable: false, scope: "provider", state: S.DISABLED }),
  [C.CONFIGURATION]: freeze({ retryable: false, scope: "provider", state: S.DISABLED }),
  [C.MODEL_NOT_FOUND]: freeze({ retryable: false, scope: "model", state: S.DISABLED }),
  [C.PAYMENT_REQUIRED]: freeze({ retryable: false, scope: "model", state: S.DISABLED }),
  [C.INVALID_REQUEST]: freeze({ retryable: false, scope: "request", state: null }),
  [C.CONTENT_BLOCKED]: freeze({ retryable: false, scope: "request", state: null })
});

const KNOWN_PROVIDERS = freeze(["gemini", "groq", "openrouter", "cloudflare"]);

// Newsroom reasoning/language tasks (Section 19). Router treats it as a label only.
const TASK_TYPES = freeze([
  "story_evaluation", "research_synthesis", "writing", "fact_check",
  "standards_review", "source_analysis", "general"
]);

const CAPABILITIES = freeze(["text", "long_context", "reasoning", "json_output"]);

module.exports = { QUOTA_STATES, STATUS, ERROR_CATEGORIES, CATEGORY_TRAITS, KNOWN_PROVIDERS, TASK_TYPES, CAPABILITIES };
