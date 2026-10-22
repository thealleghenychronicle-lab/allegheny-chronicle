// Google Gemini adapter (Generative Language REST API). Credential env var: GEMINI_API_KEY.
// The key is sent in the x-goog-api-key header — never in the URL (URLs get logged).
"use strict";
const { ProviderAdapter } = require("./base");
const { ERROR_CATEGORIES: C } = require("../ai/constants");
const { parseDurationMs } = require("../ai/http-utils");

const ENV_VAR = "GEMINI_API_KEY";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

class GeminiAdapter extends ProviderAdapter {
  constructor(opts) { super({ ...opts, id: "gemini", envVar: ENV_VAR }); }

  authHeaders(key) { return { "x-goog-api-key": key }; }

  buildRequest(req, model) {
    const gen = {};
    gen.maxOutputTokens = req.output.maxTokens;
    if (req.generation.temperature != null) gen.temperature = req.generation.temperature;
    if (req.generation.topP != null) gen.topP = req.generation.topP;
    if (req.generation.stopSequences) gen.stopSequences = req.generation.stopSequences;
    if (req.generation.seed != null) gen.seed = req.generation.seed;
    const body = { contents: [{ role: "user", parts: [{ text: req.prompt }] }], generationConfig: gen };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    return { url: `${BASE}/${encodeURIComponent(model)}:generateContent`, method: "POST", headers: {}, body };
  }

  parseSuccess(json) {
    if (json.promptFeedback && json.promptFeedback.blockReason) {
      return { failure: { category: C.CONTENT_BLOCKED, message: `prompt blocked: ${json.promptFeedback.blockReason}` } };
    }
    const cand = json.candidates && json.candidates[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("") : "";
    const finishReason = cand && cand.finishReason ? cand.finishReason : null;
    if (!text) {
      if (finishReason === "SAFETY" || finishReason === "RECITATION" || finishReason === "PROHIBITED_CONTENT") {
        return { failure: { category: C.CONTENT_BLOCKED, message: `output blocked: ${finishReason}` } };
      }
      return { failure: { category: C.MALFORMED_RESPONSE, message: "no text in candidate" } };
    }
    const u = json.usageMetadata;
    return {
      content: text, finishReason,
      usage: u ? { inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null, totalTokens: u.totalTokenCount ?? null } : null,
      servedModel: json.modelVersion || null
    };
  }

  refineError(status, json, headers, now) {
    const err = json && json.error ? json.error : {};
    const details = Array.isArray(err.details) ? err.details : [];
    const out = {};
    const retryInfo = details.find((d) => d && /RetryInfo/.test(d["@type"] || ""));
    if (retryInfo && retryInfo.retryDelay) out.retryAfterMs = parseDurationMs(retryInfo.retryDelay, now);
    const errInfo = details.find((d) => d && /ErrorInfo/.test(d["@type"] || ""));
    const reason = errInfo && errInfo.reason ? String(errInfo.reason) : "";

    if (status === 429) {
      const qf = details.find((d) => d && /QuotaFailure/.test(d["@type"] || ""));
      const ids = qf && Array.isArray(qf.violations)
        ? qf.violations.map((v) => `${v.quotaId || ""} ${v.quotaMetric || ""}`).join(" ").toLowerCase() : "";
      const msg = String(err.message || "").toLowerCase();
      if (ids.includes("perday") || msg.includes("per day")) out.category = C.QUOTA_DAILY;
      else if (ids.includes("token")) out.category = C.QUOTA_TOKENS;
      else out.category = C.RATE_LIMIT_TEMPORARY;
    } else if (reason === "API_KEY_INVALID" || status === 401 || status === 403) {
      out.category = C.AUTHENTICATION;
    } else if (status === 400 && err.status === "FAILED_PRECONDITION") {
      out.category = C.CONFIGURATION;     // e.g. free tier not available for this project/region
    }
    return out;
  }
}

module.exports = { GeminiAdapter, ENV_VAR };
