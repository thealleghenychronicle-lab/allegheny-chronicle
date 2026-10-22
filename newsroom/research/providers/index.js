"use strict";
const { MockResearchProvider } = require("./mock");

// Only the mock provider ships in Chunk 3. A real provider (a general search API, or one
// of the specific adapters the architecture doc describes under `newsroom/sources/` --
// local outlets, gov sources, company sites) is added in a later chunk by implementing
// the Research Provider Interface (../provider.js) and registering it here. Nothing else
// in the research layer needs to change when that happens.
function createResearchProviders(opts = {}) {
  const list = [new MockResearchProvider(opts.mock || {})];
  return Object.fromEntries(list.map((a) => [a.id, a]));
}

module.exports = { createResearchProviders, MockResearchProvider };
