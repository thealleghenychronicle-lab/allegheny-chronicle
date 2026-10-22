// Groq adapter (OpenAI-compatible chat completions). Credential env var: GROQ_API_KEY.
"use strict";
const { ProviderAdapter } = require("./base");
const { ERROR_CATEGORIES: C } = require("../ai/constants");
const { parseDurationMs } = require("../ai/http-utils");

const ENV_VAR = "GROQ_API_KEY";
const URL_ = "https://api.groq.com/openai/v1/chat/completions";

class GroqAdapter extends ProviderAdapter {
  constructor(opts) { super({ ...opts, id: "groq", envVar: ENV_VAR }); }

  authHeaders(key) { return { Authorization: `Bearer ${key}` }; }

  buildRequest(req, model) {
    const messages = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });
    const body = { model, messages, max_completion_tokens: req.output.maxTokens };
    if (req.generation.temperature != null) body.temperature = req.generation.temperature;
    if (req.generation.topP != null) body.top_p = req.generation.topP;
    if (req.generation.stopSequences) body.stop = req.generation.stopSequences;
    if (req.generation.seed != null) body.seed = req.generation.seed;
    return { url: URL_, method: "POST", headers: {}, body };
  }

  parseSuccess(json) {
    const choice = json.choices && json.choices[0];
    const text = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : "";
    if (!text) return { failure: { category: C.MALFORMED_RESPONSE, message: "no content in choice" } };
    const u = json.usage;
    return {
      content: text, finishReason: choice.finish_reason || null,
      usage: u ? { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null, totalTokens: u.total_tokens ?? null } : null,
      servedModel: json.model || null
    };
  }

  refineError(status, json, headers, now) {
    const err = json && json.error ? json.error : {};
    const msg = String(err.message || "");
    const code = String(err.code || "");
    const out = {};
    const again = /try again in ([0-9hmsd.]+)/i.exec(msg);
    if (again) out.retryAfterMs = parseDurationMs(again[1], now);
    if (status === 429) {
      if (/\((RPD|TPD)\)/.test(msg)) out.category = C.QUOTA_DAILY;
      else if (/\(TPM\)/.test(msg) || err.type === "tokens") out.category = C.QUOTA_TOKENS;
      else out.category = C.RATE_LIMIT_TEMPORARY;
    } else if (code === "invalid_api_key" || status === 401) {
      out.category = C.AUTHENTICATION;
    } else if (code === "model_not_found" || code === "model_decommissioned") {
      out.category = C.MODEL_NOT_FOUND;
    }
    return out;
  }
}

module.exports = { GroqAdapter, ENV_VAR };
