// OpenRouter adapter (OpenAI-compatible). Credential env var: OPENROUTER_API_KEY.
// Free-tier safety: only ":free" model ids can be registered (registry rule), the request
// never includes fallback model lists / routing hints, and HTTP 402 (credits required)
// permanently disables that model instead of ever being retried.
"use strict";
const { ProviderAdapter } = require("./base");
const { ERROR_CATEGORIES: C } = require("../ai/constants");

const ENV_VAR = "OPENROUTER_API_KEY";
const URL_ = "https://openrouter.ai/api/v1/chat/completions";

class OpenRouterAdapter extends ProviderAdapter {
  constructor(opts) { super({ ...opts, id: "openrouter", envVar: ENV_VAR }); }

  authHeaders(key) { return { Authorization: `Bearer ${key}` }; }

  buildRequest(req, model) {
    const messages = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    const body = { model, messages, max_tokens: req.output.maxTokens };
    if (req.generation.temperature != null) body.temperature = req.generation.temperature;
    if (req.generation.topP != null) body.top_p = req.generation.topP;
    if (req.generation.stopSequences) body.stop = req.generation.stopSequences;
    if (req.generation.seed != null) body.seed = req.generation.seed;
    return { url: URL_, method: "POST", headers: {}, body };
  }

  parseSuccess(json) {
    // OpenRouter can return an error object inside an HTTP 200.
    if (json.error) {
      return { failure: { category: C.UNKNOWN, message: json.error.message || "error in response body", status: Number(json.error.code) || null, raw: json.error } };
    }
    const choice = json.choices && json.choices[0];
    if (choice && choice.finish_reason === "content_filter") return { failure: { category: C.CONTENT_BLOCKED, message: "output blocked by content filter" } };
    if (choice && choice.finish_reason === "error") return { failure: { category: C.PROVIDER_UNAVAILABLE, message: "upstream provider error" } };
    const text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
    if (!text) return { failure: { category: C.MALFORMED_RESPONSE, message: "no content in choice" } };
    const u = json.usage;
    return {
      content: text, finishReason: choice.finish_reason || null,
      usage: u ? { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null, totalTokens: u.total_tokens ?? null } : null,
      servedModel: json.model || null
    };
  }

  refineError(status, json) {
    const err = json && json.error ? json.error : {};
    const msg = String(err.message || "").toLowerCase();
    const meta = err.metadata || {};
    const out = {};
    const hdrs = meta.headers || {};
    const reset = hdrs["X-RateLimit-Reset"] || hdrs["x-ratelimit-reset"];
    if (reset != null && Number(reset) > 1e12) out.resetAt = Number(reset);
    if (status === 429) {
      out.category = /per[- ]day|free-models-per-day/.test(msg) ? C.QUOTA_DAILY : C.RATE_LIMIT_TEMPORARY;
    } else if (status === 402) {
      out.category = C.PAYMENT_REQUIRED;
    } else if (status === 403 && (meta.reasons || meta.flagged_input)) {
      out.category = C.CONTENT_BLOCKED;     // moderation, not an auth problem
    }
    return out;
  }
}

module.exports = { OpenRouterAdapter, ENV_VAR };
