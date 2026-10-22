"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { createResearchRequest, ResearchRequestError } = require("../research/request");
const { createResearchResult, ResearchResultError } = require("../research/result");
const { normalizeUrl, dedupeResults } = require("../research/normalize");
const { MockResearchProvider } = require("../research/providers/mock");
const { createResearchRouter } = require("../research/router");
const { RESEARCH_ERROR_CATEGORIES: C, ROUTER_ERROR_CATEGORIES: RC, STATUS } = require("../research/constants");

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test("request: minimal valid input gets defaults filled in", () => {
  const r = createResearchRequest({ query: "  Allegheny County budget  " });
  assert.equal(r.query, "Allegheny County budget");
  assert.equal(r.location, null);
  assert.deepEqual(r.topics, []);
  assert.deepEqual(r.dateWindow, { from: null, to: null });
  assert.equal(r.maxResults, 10);
  assert.equal(typeof r.requestId, "string");
  assert.ok(r.requestId.length > 0);
});

test("request: full valid input is preserved and trimmed", () => {
  const r = createResearchRequest({
    requestId: "req-1",
    query: "small business grants",
    location: "Pittsburgh, PA",
    topics: ["business", "local-government"],
    dateWindow: { from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
    maxResults: 5
  });
  assert.equal(r.requestId, "req-1");
  assert.equal(r.location, "Pittsburgh, PA");
  assert.deepEqual(r.topics, ["business", "local-government"]);
  assert.equal(r.dateWindow.from, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(r.dateWindow.to, Date.parse("2026-06-01T00:00:00Z"));
  assert.equal(r.maxResults, 5);
});

test("request: rejects missing/empty query", () => {
  assert.throws(() => createResearchRequest({}), ResearchRequestError);
  assert.throws(() => createResearchRequest({ query: "   " }), ResearchRequestError);
});

test("request: rejects unknown top-level fields", () => {
  assert.throws(() => createResearchRequest({ query: "x", extra: true }), ResearchRequestError);
});

test("request: rejects malformed dateWindow and out-of-order from/to", () => {
  assert.throws(() => createResearchRequest({ query: "x", dateWindow: { from: "not-a-date" } }), ResearchRequestError);
  assert.throws(() => createResearchRequest({
    query: "x",
    dateWindow: { from: "2026-06-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }
  }), ResearchRequestError);
});

test("request: rejects out-of-range maxResults and non-string topics", () => {
  assert.throws(() => createResearchRequest({ query: "x", maxResults: 0 }), ResearchRequestError);
  assert.throws(() => createResearchRequest({ query: "x", maxResults: 51 }), ResearchRequestError);
  assert.throws(() => createResearchRequest({ query: "x", topics: ["ok", 5] }), ResearchRequestError);
});

// ---------------------------------------------------------------------------
// Result normalization
// ---------------------------------------------------------------------------

test("result: normalizes a full raw result and computes normalizedUrl", () => {
  const r = createResearchResult({
    title: "  New bakery opens downtown  ",
    url: "https://Example.com/News/story?utm_source=x&b=2&a=1",
    publisher: "Example Times",
    publishedAt: "2026-05-01T12:00:00Z",
    excerpt: "A new bakery has opened.",
    sourceId: "abc123",
    topics: ["business"],
    location: "Downtown"
  }, { providerId: "mock" });

  assert.equal(r.title, "New bakery opens downtown");
  assert.equal(r.publisher, "Example Times");
  assert.equal(r.publishedAt, Date.parse("2026-05-01T12:00:00Z"));
  assert.equal(r.sourceId, "abc123");
  assert.equal(r.providerId, "mock");
  assert.deepEqual(r.topics, ["business"]);
  assert.equal(r.normalizedUrl, "https://example.com/news/story?a=1&b=2");
});

test("result: missing optional fields stay null/empty, never invented", () => {
  const r = createResearchResult({ title: "Headline only", url: "https://example.com/x" });
  assert.equal(r.publisher, null);
  assert.equal(r.publishedAt, null);
  assert.equal(r.excerpt, null);
  assert.equal(r.sourceId, null);
  assert.deepEqual(r.topics, []);
  assert.equal(r.location, null);
});

test("result: rejects missing title/url and unknown fields", () => {
  assert.throws(() => createResearchResult({ url: "https://example.com" }), ResearchResultError);
  assert.throws(() => createResearchResult({ title: "x" }), ResearchResultError);
  assert.throws(() => createResearchResult({ title: "x", url: "https://example.com", bogus: 1 }), ResearchResultError);
});

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

test("normalizeUrl: lowercases host, strips default port/fragment/tracking params, sorts params", () => {
  const a = normalizeUrl("HTTPS://Example.com:443/Path/?utm_source=news&b=2&a=1#section");
  assert.equal(a, "https://example.com/path?a=1&b=2");
});

test("normalizeUrl: strips a single trailing slash on non-root paths, keeps bare root slash", () => {
  assert.equal(normalizeUrl("https://example.com/story/"), "https://example.com/story");
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
});

test("normalizeUrl: two differently-decorated URLs for the same page normalize identically", () => {
  const a = normalizeUrl("https://example.com/story?utm_campaign=fall&id=9");
  const b = normalizeUrl("https://EXAMPLE.com:443/story/?id=9&utm_campaign=spring");
  assert.equal(a, b);
});

test("normalizeUrl: returns null for empty/non-string input", () => {
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl(null), null);
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

test("dedupeResults: drops results with an identical normalized URL", () => {
  const r1 = createResearchResult({ title: "A", url: "https://example.com/story?utm_source=a" }, { providerId: "mock" });
  const r2 = createResearchResult({ title: "A again", url: "https://example.com/story?utm_source=b" }, { providerId: "mock" });
  const out = dedupeResults([r1, r2]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "A");
});

test("dedupeResults: drops results sharing the same provider + sourceId even with different URLs", () => {
  const r1 = createResearchResult({ title: "A", url: "https://example.com/a", sourceId: "story-1" }, { providerId: "mock" });
  const r2 = createResearchResult({ title: "A mirrored", url: "https://mirror.example.com/a", sourceId: "story-1" }, { providerId: "mock" });
  const out = dedupeResults([r1, r2]);
  assert.equal(out.length, 1);
});

test("dedupeResults: keeps distinct results", () => {
  const r1 = createResearchResult({ title: "A", url: "https://example.com/a" }, { providerId: "mock" });
  const r2 = createResearchResult({ title: "B", url: "https://example.com/b" }, { providerId: "mock" });
  const out = dedupeResults([r1, r2]);
  assert.equal(out.length, 2);
});

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

test("mock provider: returns fixtures for a matching query, capped at maxResults", async () => {
  const provider = new MockResearchProvider({
    fixtures: { "bakery": [
      { title: "Bakery A", url: "https://example.com/a" },
      { title: "Bakery B", url: "https://example.com/b" },
      { title: "Bakery C", url: "https://example.com/c" }
    ] }
  });
  const request = createResearchRequest({ query: "bakery", maxResults: 2 });
  const outcome = await provider.run(request);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].providerId, "mock");
});

test("mock provider: falls back to '*' fixture, and isConfigured() reflects constructor option", async () => {
  const provider = new MockResearchProvider({ fixtures: { "*": [{ title: "General", url: "https://example.com/g" }] }, configured: false });
  assert.equal(provider.isConfigured(), false);
  const outcome = await provider.run(createResearchRequest({ query: "unmatched query" }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.category, C.AUTHENTICATION_FAILURE);
});

// ---------------------------------------------------------------------------
// Router: success, fallback, and error handling
// ---------------------------------------------------------------------------

test("router: successful research request returns normalized, deduped results from the selected provider", async () => {
  const providers = { mock: new MockResearchProvider({ fixtures: { "bakery": [
    { title: "Bakery A", url: "https://example.com/a?utm_source=x" },
    { title: "Bakery A dup", url: "https://example.com/a" }
  ] } }) };
  const router = createResearchRouter({ providers });
  const outcome = await router.research({ query: "bakery" });
  assert.equal(outcome.status, STATUS.SUCCESS);
  assert.equal(outcome.provider, "mock");
  assert.equal(outcome.results.length, 1);           // the utm-decorated duplicate was dropped
  assert.equal(outcome.error, null);
});

test("router: invalid request is rejected before any provider is called", async () => {
  const mock = new MockResearchProvider({ fixtures: {} });
  const router = createResearchRouter({ providers: { mock } });
  const outcome = await router.research({ query: "" });
  assert.equal(outcome.status, STATUS.FAILED);
  assert.equal(outcome.error.category, RC.INVALID_ROUTER_REQUEST);
  assert.equal(mock.callCount, 0);
});

test("router: no providers registered", async () => {
  const router = createResearchRouter({ providers: {} });
  const outcome = await router.research({ query: "bakery" });
  assert.equal(outcome.status, STATUS.FAILED);
  assert.equal(outcome.error.category, RC.NO_ELIGIBLE_PROVIDER);
});

test("router: falls back to the next provider on failure (rate limited, then unconfigured)", async () => {
  const primary = new MockResearchProvider({ id: "primary", failWith: C.RATE_LIMITED });
  const secondary = new MockResearchProvider({ id: "secondary", fixtures: { "bakery": [{ title: "Bakery A", url: "https://example.com/a" }] } });
  const router = createResearchRouter({ providers: { primary, secondary }, providerOrder: ["primary", "secondary"] });
  const outcome = await router.research({ query: "bakery" });
  assert.equal(outcome.status, STATUS.SUCCESS);
  assert.equal(outcome.provider, "secondary");
  assert.equal(outcome.attempts[0].provider, "primary");
  assert.equal(outcome.attempts[0].ok, false);
  assert.equal(outcome.attempts[0].error.category, C.RATE_LIMITED);
});

test("router: skips an unconfigured provider without calling it", async () => {
  const primary = new MockResearchProvider({ id: "primary", configured: false });
  const secondary = new MockResearchProvider({ id: "secondary", fixtures: { "bakery": [{ title: "Bakery A", url: "https://example.com/a" }] } });
  const router = createResearchRouter({ providers: { primary, secondary }, providerOrder: ["primary", "secondary"] });
  const outcome = await router.research({ query: "bakery" });
  assert.equal(outcome.status, STATUS.SUCCESS);
  assert.equal(outcome.provider, "secondary");
  assert.equal(primary.callCount, 0);
  assert.equal(outcome.attempts[0].error.category, "NOT_CONFIGURED");
});

test("router: all providers failing returns ALL_PROVIDERS_FAILED with per-provider attempt detail", async () => {
  const a = new MockResearchProvider({ id: "a", failWith: C.TEMPORARY_FAILURE });
  const b = new MockResearchProvider({ id: "b", failWith: C.AUTHENTICATION_FAILURE });
  const router = createResearchRouter({ providers: { a, b }, providerOrder: ["a", "b"] });
  const outcome = await router.research({ query: "bakery" });
  assert.equal(outcome.status, STATUS.FAILED);
  assert.equal(outcome.error.category, RC.ALL_PROVIDERS_FAILED);
  assert.equal(outcome.results.length, 0);
  assert.equal(outcome.attempts.length, 2);
  assert.equal(outcome.attempts[0].error.category, C.TEMPORARY_FAILURE);
  assert.equal(outcome.attempts[1].error.category, C.AUTHENTICATION_FAILURE);
});

test("router: a malformed raw result from a provider is treated as a provider failure and does not crash the router", async () => {
  const bad = new MockResearchProvider({ id: "bad", fixtures: { "bakery": [{ title: "no url" }] } });
  const good = new MockResearchProvider({ id: "good", fixtures: { "bakery": [{ title: "Bakery A", url: "https://example.com/a" }] } });
  const router = createResearchRouter({ providers: { bad, good }, providerOrder: ["bad", "good"] });
  const outcome = await router.research({ query: "bakery" });
  assert.equal(outcome.status, STATUS.SUCCESS);
  assert.equal(outcome.provider, "good");
  assert.equal(outcome.attempts[0].error.category, "MALFORMED_RESPONSE");
});

test("router: respects maxResults after dedup", async () => {
  const mock = new MockResearchProvider({ fixtures: { "bakery": [
    { title: "A", url: "https://example.com/a" },
    { title: "B", url: "https://example.com/b" },
    { title: "C", url: "https://example.com/c" }
  ] } });
  const router = createResearchRouter({ providers: { mock } });
  const outcome = await router.research({ query: "bakery", maxResults: 2 });
  assert.equal(outcome.status, STATUS.SUCCESS);
  assert.equal(outcome.results.length, 2);
});
