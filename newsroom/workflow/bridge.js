// Maps results from the EXISTING AI Router / Research Router onto workflow waits. Pure; no calls are made here.
"use strict";

// AI Router result (see ../router.js): WAITING, or FAILED with retry.retryable.
function aiResultToWait(result) {
  if (!result || result.ok === true) return null;
  const retry = result.retry;
  if (result.status === "WAITING" || (retry && retry.retryable === true)) {
    return { kind: "ai", reason: (result.error && result.error.category) || (retry && retry.reason) || "AI_UNAVAILABLE", resumeAt: retry && retry.retryAt ? retry.retryAt : null };
  }
  return null; // permanent failure -> caller should release the job with an error instead
}

// Research Router result (see ../research/router.js): only ALL_PROVIDERS_FAILED is a "try again later".
function researchResultToWait(result) {
  if (!result || result.status !== "FAILED" || !result.error) return null;
  if (result.error.category === "ALL_PROVIDERS_FAILED") return { kind: "research", reason: "ALL_PROVIDERS_FAILED", resumeAt: null };
  return null; // INVALID_ROUTER_REQUEST / NO_ELIGIBLE_PROVIDER are not transient
}

module.exports = { aiResultToWait, researchResultToWait };
