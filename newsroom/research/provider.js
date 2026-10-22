// Research Provider Interface (used by research/router.js). Lets the core newsroom ask
// "run this research request" without knowing which external provider handled it -- the
// same provider-neutral pattern as ../providers/base.js, at research-layer scope.
//
// Adapter contract, implemented by every concrete provider (see providers/mock.js):
//   id                  -> string, stable identifier
//   isConfigured()      -> boolean; false means "skip me", never throws
//   async run(request)  -> ResearchRequest (see request.js) in, one of:
//       { ok: true,  results: RawResult[] }
//       { ok: false, error: { category, message, retryable } }
//   RawResult is whatever shape the provider naturally returns (a subset/superset of the
//   Research Result Contract fields). The ROUTER normalizes it via createResearchResult
//   and dedupes it -- adapters must NOT normalize or dedupe themselves, so every provider
//   is held to the same rules in one place.
"use strict";
const { RESEARCH_ERROR_CATEGORIES: C, CATEGORY_TRAITS } = require("./constants");

const MAX_MESSAGE_CHARS = 300;

class ResearchProviderAdapter {
  constructor({ id }) {
    if (!id) throw new Error("research provider adapter needs an id");
    this.id = id;
  }

  // Credential/setup check only -- must never throw. A provider with no credential
  // configured is simply skipped by the router, same as the AI router's adapters.
  isConfigured() { return true; }

  // To be implemented by concrete adapters.
  async run() { throw new Error("not implemented"); }

  _fail(category, message, extra = {}) {
    const traits = CATEGORY_TRAITS[category] || CATEGORY_TRAITS[C.UNKNOWN];
    return {
      ok: false,
      error: {
        category: CATEGORY_TRAITS[category] ? category : C.UNKNOWN,
        message: String(message).slice(0, MAX_MESSAGE_CHARS),
        retryable: traits.retryable
      },
      ...extra
    };
  }

  _ok(results) { return { ok: true, results: Array.isArray(results) ? results : [] }; }
}

module.exports = { ResearchProviderAdapter };
