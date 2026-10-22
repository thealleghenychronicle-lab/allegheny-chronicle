// Deterministic mock research provider. Ships as the ONLY provider in Chunk 3 -- it
// exists to prove the interface, exercise the router, and give tests something to run
// against with no network access and no real credentials.
"use strict";
const { ResearchProviderAdapter } = require("../provider");
const { RESEARCH_ERROR_CATEGORIES: C } = require("../constants");

class MockResearchProvider extends ResearchProviderAdapter {
  // fixtures   - map of lowercased/trimmed query -> raw result array. "*" is a catch-all
  //              used when no exact query match exists.
  // configured - simulate isConfigured(); false makes the router skip this provider.
  // failWith   - if set, every run() call fails with this RESEARCH_ERROR_CATEGORIES value
  //              (for testing router fallback/error handling).
  constructor({ id = "mock", fixtures = {}, configured = true, failWith = null } = {}) {
    super({ id });
    this._fixtures = fixtures;
    this._configured = configured;
    this._failWith = failWith;
    this.callCount = 0;
  }

  isConfigured() { return this._configured; }

  async run(request) {
    this.callCount += 1;
    if (!this._configured) return this._fail(C.AUTHENTICATION_FAILURE, `${this.id}: not configured`);
    if (this._failWith) return this._fail(this._failWith, `${this.id}: forced failure for testing`);

    const key = (request.query || "").trim().toLowerCase();
    const raw = this._fixtures[key] || this._fixtures["*"] || [];
    return this._ok(raw.slice(0, request.maxResults).map((r) => ({ ...r, providerId: this.id })));
  }
}

module.exports = { MockResearchProvider };
