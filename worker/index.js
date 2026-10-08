/**
 * The Allegheny Chronicle — Cloudflare Worker entry point.
 *
 * - /api/*  -> handled here, server-side, so provider API keys never reach the browser.
 * - all else -> served from the static assets in ./public via the ASSETS binding.
 *
 * Secrets are configured in Cloudflare (Workers & Pages -> this Worker ->
 * Settings -> Variables and Secrets) and are read only from `env` at request
 * time. They are never stored in this repository, logged, or returned.
 */

// Names only. The values live in Cloudflare's encrypted secrets.
export const PROVIDER_SECRET_NAMES = Object.freeze([
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
]);

/**
 * Server-side accessor for a provider secret. Returns the value or null.
 * Callers must never log it or include it in a response.
 */
export function getProviderSecret(env, name) {
  if (!PROVIDER_SECRET_NAMES.includes(name)) return null;
  const value = env && env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleApi(request, env, url) {
  // No API endpoints exist yet. Add routes here; use getProviderSecret(env, "...")
  // for credentials and keep responses/errors free of secret values.
  return json({ error: "not_found" }, 404);
}

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
