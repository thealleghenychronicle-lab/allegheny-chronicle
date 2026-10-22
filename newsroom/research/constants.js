// Shared enums/traits for the Research Layer Foundation. No secrets, no provider logic.
// Deliberately small -- Chunk 3 only needs enough categories to route/fallback sanely,
// not the full adapter-error taxonomy the AI router uses (see ../ai/constants.js).
"use strict";
const freeze = Object.freeze;

// Errors a research PROVIDER can report about a single call.
const RESEARCH_ERROR_CATEGORIES = freeze({
  INVALID_REQUEST: "INVALID_REQUEST",             // provider rejected the request itself
  RATE_LIMITED: "RATE_LIMITED",                    // provider is temporarily throttling
  TEMPORARY_FAILURE: "TEMPORARY_FAILURE",          // transient/unavailable, safe to retry later
  AUTHENTICATION_FAILURE: "AUTHENTICATION_FAILURE",// missing/invalid credential
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",        // provider returned something the router can't use
  UNKNOWN: "UNKNOWN"
});
const C = RESEARCH_ERROR_CATEGORIES;

// scope: "request" -> the request itself is the problem; retrying anywhere won't help.
//        "provider" -> this provider is bad for now; router should try the next provider.
const CATEGORY_TRAITS = freeze({
  [C.INVALID_REQUEST]: freeze({ retryable: false, scope: "request" }),
  [C.RATE_LIMITED]: freeze({ retryable: true, scope: "provider" }),
  [C.TEMPORARY_FAILURE]: freeze({ retryable: true, scope: "provider" }),
  [C.AUTHENTICATION_FAILURE]: freeze({ retryable: false, scope: "provider" }),
  [C.MALFORMED_RESPONSE]: freeze({ retryable: true, scope: "provider" }),
  [C.UNKNOWN]: freeze({ retryable: true, scope: "provider" })
});

// Errors the ROUTER itself can report (not attributable to one provider call).
const ROUTER_ERROR_CATEGORIES = freeze({
  INVALID_ROUTER_REQUEST: "INVALID_ROUTER_REQUEST",   // request failed contract validation
  NO_ELIGIBLE_PROVIDER: "NO_ELIGIBLE_PROVIDER",        // no providers registered at all
  ALL_PROVIDERS_FAILED: "ALL_PROVIDERS_FAILED"         // every registered provider was tried and failed
});

const STATUS = freeze({ SUCCESS: "SUCCESS", FAILED: "FAILED" });

module.exports = { RESEARCH_ERROR_CATEGORIES, CATEGORY_TRAITS, ROUTER_ERROR_CATEGORIES, STATUS };
