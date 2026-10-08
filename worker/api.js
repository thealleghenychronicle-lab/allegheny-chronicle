/**
 * Server-side API for The Allegheny Chronicle (runs only inside the Worker).
 *
 * Route structure (all under /api):
 *   GET  /api/health                 public   liveness check, no secrets involved
 *   GET  /api/newsroom/status        protected  which provider secrets are configured (booleans only)
 *   POST /api/newsroom/ai/:provider  protected  provider = gemini | groq | openrouter
 *
 * "Protected" routes require:  Authorization: Bearer <NEWSROOM_API_TOKEN>
 * NEWSROOM_API_TOKEN is a Cloudflare secret. If it is not set, protected routes
 * are closed (503) so provider keys can never be used by the public internet.
 *
 * Provider keys (GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY) are read from
 * `env` only inside handlers. They are never logged, returned, or put in errors.
 */

export const PROVIDERS = Object.freeze({
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
});

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function secret(env, name) {
  const v = env && env[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Length-independent comparison so token checks don't leak timing information.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Returns null if authorized, otherwise an error Response. */
async function requireAuth(request, env) {
  const expected = secret(env, "NEWSROOM_API_TOKEN");
  if (!expected) return json({ error: "newsroom_api_not_configured" }, 503);
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !(await safeEqual(match[1], expected))) {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  return null;
}

// Route table. `auth: true` routes are checked before the handler runs.
const routes = [
  {
    method: "GET",
    path: /^\/api\/health$/,
    auth: false,
    handler: async () => json({ ok: true }),
  },
  {
    method: "GET",
    path: /^\/api\/newsroom\/status$/,
    auth: true,
    handler: async (_req, env) => {
      const providers = {};
      for (const [name, key] of Object.entries(PROVIDERS)) {
        providers[name] = { configured: secret(env, key) !== null };
      }
      return json({ ok: true, providers });
    },
  },
  {
    method: "POST",
    path: /^\/api\/newsroom\/ai\/([a-z]+)$/,
    auth: true,
    handler: async (_req, env, match) => {
      const provider = match[1];
      const keyName = PROVIDERS[provider];
      if (!keyName) return json({ error: "unknown_provider" }, 404);
      if (!secret(env, keyName)) return json({ error: "provider_not_configured" }, 503);
      // Provider adapters (Phase 2 router) plug in here. They must call
      // secret(env, keyName) server-side and return only the model output.
      return json({ error: "not_implemented", provider }, 501);
    },
  },
];

export async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  let pathMatched = false;
  for (const route of routes) {
    const match = route.path.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (route.method !== request.method) continue;
    if (route.auth) {
      const denied = await requireAuth(request, env);
      if (denied) return denied;
    }
    return route.handler(request, env, match);
  }
  return pathMatched ? json({ error: "method_not_allowed" }, 405) : json({ error: "not_found" }, 404);
}
