/**
 * The Allegheny Chronicle — Cloudflare Worker entry point.
 *
 * - /api/*  -> handled in ./api.js, server-side, so provider API keys never reach the browser.
 * - all else -> served from the static assets in ./public via the ASSETS binding.
 *
 * Secrets are configured in Cloudflare (Workers & Pages -> this Worker ->
 * Settings -> Variables and Secrets) and are read only from `env` at request
 * time. They are never stored in this repository, logged, or returned.
 */
import { handleApi, json } from "./api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch {
        // Deliberately generic: never echo error details that could contain secrets.
        return json({ error: "internal_error" }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
