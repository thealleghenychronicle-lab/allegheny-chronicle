"use strict";
const { GeminiAdapter } = require("./gemini");
const { GroqAdapter } = require("./groq");
const { OpenRouterAdapter } = require("./openrouter");
const { CloudflareAdapter } = require("./cloudflare");

function createProviderAdapters(opts) {
  const list = [new GeminiAdapter(opts), new GroqAdapter(opts), new OpenRouterAdapter(opts), new CloudflareAdapter(opts)];
  return Object.fromEntries(list.map((a) => [a.id, a]));
}

module.exports = { createProviderAdapters, GeminiAdapter, GroqAdapter, OpenRouterAdapter, CloudflareAdapter };
