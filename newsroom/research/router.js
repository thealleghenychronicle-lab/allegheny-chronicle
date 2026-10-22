// Research Router. Accepts a normalized Research Request, selects an approved research
// provider, calls it through the Research Provider Interface, normalizes and dedupes
// results, and falls back to the next provider on failure -- all deterministically.
// Deliberately simple (Chunk 3 scope): fixed provider order, first-success-wins,
// no scoring, no quota tracking. That belongs to a later chunk if it's ever needed.
"use strict";
const { createResearchRequest, ResearchRequestError } = require("./request");
const { createResearchResult, ResearchResultError } = require("./result");
const { dedupeResults } = require("./normalize");
const { ROUTER_ERROR_CATEGORIES: RC, STATUS } = require("./constants");

class ResearchRouter {
  // providers      - map of providerId -> adapter implementing the Research Provider
  //                  Interface (see provider.js)
  // providerOrder  - optional list of providerIds giving the deterministic try order;
  //                  defaults to the providers map's own key order
  constructor({ providers, providerOrder = null }) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      throw new Error("providers map is required");
    }
    this._providers = providers;
    this._order = providerOrder || Object.keys(providers);
  }

  async research(input) {
    let request;
    try {
      request = createResearchRequest(input);
    } catch (e) {
      if (e instanceof ResearchRequestError) {
        return this._failed(RC.INVALID_ROUTER_REQUEST, e.message, []);
      }
      throw e;
    }

    const candidates = this._order.filter((id) => this._providers[id]);
    if (candidates.length === 0) {
      return this._failed(RC.NO_ELIGIBLE_PROVIDER, "no research providers registered", []);
    }

    const attempts = [];
    for (const id of candidates) {
      const provider = this._providers[id];

      if (!provider.isConfigured()) {
        attempts.push({ provider: id, ok: false, error: { category: "NOT_CONFIGURED", message: `${id} is not configured` } });
        continue;
      }

      let outcome;
      try {
        outcome = await provider.run(request);
      } catch (e) {
        attempts.push({ provider: id, ok: false, error: { category: "UNKNOWN", message: e && e.message ? e.message : String(e) } });
        continue;
      }

      if (!outcome || outcome.ok !== true) {
        attempts.push({ provider: id, ok: false, error: (outcome && outcome.error) || { category: "UNKNOWN", message: "provider returned no result" } });
        continue;
      }

      let results;
      try {
        results = (outcome.results || []).map((r) => createResearchResult(r, { providerId: id }));
      } catch (e) {
        const msg = e instanceof ResearchResultError ? e.message : (e && e.message ? e.message : String(e));
        attempts.push({ provider: id, ok: false, error: { category: "MALFORMED_RESPONSE", message: msg } });
        continue;
      }

      results = dedupeResults(results).slice(0, request.maxResults);
      attempts.push({ provider: id, ok: true, count: results.length });
      return { status: STATUS.SUCCESS, results, provider: id, attempts, error: null, request };
    }

    return this._failed(RC.ALL_PROVIDERS_FAILED, "every registered research provider failed or was unavailable", attempts, request);
  }

  _failed(category, message, attempts, request = null) {
    return { status: STATUS.FAILED, results: [], provider: null, attempts, request, error: { category, message } };
  }
}

function createResearchRouter(options = {}) {
  return new ResearchRouter(options);
}

module.exports = { ResearchRouter, createResearchRouter };
