# Central AI Router — Design Reference (Phase 2 / Chunk 2)

Sandbox-only. Nothing here talks to GitHub, Cloudflare, the live CMS, or a real
`newsroom-state` branch. No real API keys exist in this project.

## Call path
```
Newsroom component
  -> router.route(request)                       newsroom/router.js
  -> validate (ai/request.js)                    strict, provider-neutral
  -> plan: approved? capable? credentialed? capacity?   (registry + quota, deterministic)
  -> reserve quota atomically (ai/router-state.js -> state store)
  -> adapter.call()                              newsroom/providers/{gemini,groq,openrouter}.js
  -> success | record failure -> next approved free option | WAITING | FAILED
  -> normalized response
```
No AI model is used for any routing decision. Selection order is: request `modelPreference.prefer`
rank -> registry `priority` -> key (alphabetical). Same inputs + same state = same choice.

## Files
| File | Role |
|---|---|
| `router.js` | `createRouter()`, `Router.route()`, `Router.plan()`, `clearDisabled()`, `getQuotaSnapshot()` |
| `ai/request.js` | `createRequest()` — validated provider-neutral request. Unknown fields rejected. |
| `ai/registry.js` | Free-tier allowlist as data. `assertApproved()` hard gate. Built from `config.ALLOWED_FREE_MODELS` (+ `config.MODEL_OVERRIDES` by default). |
| `ai/free-models.js` | Free-model EVIDENCE registry (Phase 3 / Step 1). Source of the allowlist/overrides; only `VERIFIED_FREE` records are enabled. See `FREE_MODELS.md`. |
| `ai/quota.js` | Pure functions over per-provider state: capacity check, pacing, failure/backoff, header observation |
| `ai/router-state.js` | Persists `quota-<provider>.json` through the state-store interface; optimistic retry; degrade-to-memory |
| `ai/constants.js` | States, categories, retryability/scope traits |
| `ai/redact.js`, `ai/logger.js` | Secret redaction; structured logger (no prompts/content logged; no output unless a sink is given) |
| `ai/http-utils.js` | Retry-After / reset / duration / rate-limit header parsing (whitelisted headers only) |
| `providers/base.js` | Shared HTTP call, timeout, guard, generic HTTP->category mapping |
| `providers/*.js` | Provider-specific request build, response/usage extraction, error refinement |
| `local-state-store.js` | Sandbox-safe store with the SAME interface as `GitStateStore` (read/refresh/writeAtomic) |

## Request (input to `route()`)
`taskType` (story_evaluation, research_synthesis, writing, fact_check, standards_review, source_analysis, general),
`prompt`, `system?`, `employee?` (must be a known profile id), `capability?` (default `text`),
`output {maxTokens, minTokens?}`, `estimatedInputTokens?` (else ceil(chars/4), used only for pacing),
`modelPreference {prefer[], exclude[], strict}` (entries are `provider` or `provider:model`; can only
reorder/filter APPROVED models), `generation {temperature, topP, stopSequences, seed}`,
`retryContext {attempt, previousRequestId, notBefore, priorFailures}` (`notBefore` in the future => WAITING, no call).

## Response (output of `route()`)
`ok`, `status` (`SUCCESS` | `WAITING` | `FAILED`), `content`, `provider`, `model`, `servedModel`, `finishReason`,
`usage {inputTokens, outputTokens, totalTokens}|null`, `request {...metadata}`,
`error {category, message(redacted), retryable, httpStatus, providerCode}|null`,
`retry {retryable, retryAt(ISO), retryAfterMs, reason}|null`,
`quota {selected, evaluated[]}` (per provider:model snapshot: state, blockedUntil, usage, limits, provider-reported remaining),
`routing {attempts[], rejected[]}` (why each option was rejected, permanent vs temporary, retryAt).
`route()` never throws for bad input or provider failure — it returns a normalized result.

## States and categories
Per provider:model state: `AVAILABLE, RATE_LIMITED, DAILY_LIMIT_REACHED, TOKEN_LIMIT_REACHED, TEMPORARILY_UNAVAILABLE, UNKNOWN, DISABLED`.

| Adapter error category | Retryable | Blocks | State |
|---|---|---|---|
| RATE_LIMIT_TEMPORARY | yes | model | RATE_LIMITED |
| QUOTA_DAILY | yes | model | DAILY_LIMIT_REACHED |
| QUOTA_TOKENS | yes | model | TOKEN_LIMIT_REACHED |
| PROVIDER_UNAVAILABLE (5xx/timeout/network) | yes | model | TEMPORARILY_UNAVAILABLE |
| MALFORMED_RESPONSE, UNKNOWN | yes (conservative) | model | UNKNOWN |
| AUTHENTICATION, CONFIGURATION | **no** | whole provider | DISABLED (until `clearDisabled`) |
| MODEL_NOT_FOUND, PAYMENT_REQUIRED (402) | **no** | model | DISABLED |
| INVALID_REQUEST, CONTENT_BLOCKED | **no** | nothing; routing STOPS (request is not shopped to other providers) | — |

Router-level results: `ALL_OPTIONS_TEMPORARILY_UNAVAILABLE` (WAITING), `ALL_OPTIONS_PERMANENTLY_UNAVAILABLE`,
`NO_ELIGIBLE_MODEL`, `INVALID_ROUTER_REQUEST` (FAILED, non-retryable). Missing credentials = permanent
`MISSING_CREDENTIALS` rejection with zero network calls.

Retry timing precedence: provider-stated delay (`retryDelay` / "try again in" / `Retry-After` / reset header)
-> deterministic exponential backoff (30s base, 15 min cap; no jitter) -> daily-quota fallback of 1h.
Blocks expire lazily; the next `route()` after expiry probes again. A success resets the backoff.

## Quota architecture
* State is per provider AND per model; a 429 on `groq:a` never blocks `groq:b`. Provider-wide blocks exist only for
  credential/config failures.
* Usage counters (rolling 60s exact + per-minute buckets for 24h) feed optional local pacing: `rpm, rpd, tpm, tpd`
  per model, supplied through `createModelRegistry({overrides: {"provider:model": {limits: {...}}}})`.
  **All limits default to `null` (not enforced). No quota numbers are hardcoded.** Provider responses are the
  primary signal; supplied limits are only conservative pre-pacing (Phase 1 §9).
* Usage is reserved BEFORE the call (concurrency-safe: reservation re-checks capacity against fresh state and
  retries on write conflict, same optimistic pattern as the article limiter), then corrected with real token usage.
* Windows are rolling (24h / 60s), an approximation of provider-defined reset windows. Provider-reported
  reset info (headers / RetryInfo) overrides it.
* Persistence: one file per provider, `quota-gemini.json`, `quota-openrouter.json`, `quota-cloudflare.json` (+ `quota-groq.json` if Groq is ever re-enabled) (Phase 1 layout).
  If the store errors, the router degrades to in-process state and logs a warning; it does not fail the request.

## Free-tier safety (defence in depth)
1. Registry is built ONLY from `config.ALLOWED_FREE_MODELS`, which is derived from the evidence registry (`ai/free-models.js`, `VERIFIED_FREE` only). Overrides for non-allowlisted keys throw.
2. Registry identity rules: placeholder ids excluded; unsafe ids (odd characters, `..`) excluded; OpenRouter ids must end in a single `:free`, may not be routers (`openrouter/*`) or other variants (`:nitro`, `:online`, ...).
3. `modelPreference` can only reorder/filter approved models; a request for `openai:gpt-4o` is recorded as
   `NOT_APPROVED_FREE` and never called (`strict` + no approved match => `NO_ELIGIBLE_MODEL`).
4. Router re-asserts approval immediately before each call; every adapter re-asserts inside `call()`.
5. OpenRouter requests never include fallback/routing hints; HTTP 402 permanently disables that model.
6. Quota exhaustion never widens the candidate set: it moves to another APPROVED free option or returns WAITING.

## Security
* Keys come only from env vars `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` (read at call time; names only in code).
* Sent in headers only (Gemini: `x-goog-api-key`), never in URLs/bodies/state files.
* All error messages, log entries, and responses pass through `redactString/redactDeep` (exact key values + key shapes + Bearer tokens).
* Logger records metadata only (no prompt text, no generated content).
* Test fixture keys are obviously fake and appear only under `newsroom/tests/`.

## Extending
* New free model: add/promote a record in `ai/free-models.js` with `status: "VERIFIED_FREE"`, sources and date (human-reviewed change; see `FREE_MODELS.md` "Promoting a model"). `config.ALLOWED_FREE_MODELS` is derived — do not edit it directly.
* New provider: add an adapter extending `ProviderAdapter`, register it in `providers/index.js`, add to `KNOWN_PROVIDERS`.
* Production persistence: pass a `GitStateStore` (or any object with `read/refresh/writeAtomic`) as `stateStore` — no router change.
  (Not done in this chunk; the real `newsroom-state` branch does not exist.)

## Tests
`node --test newsroom/tests/*.test.js`  (no network, no credentials; Node >= 20; built-in runner only)

## Phase 3 / Step 2 — real provider adapters + credential guard
* `providers/{gemini,groq,openrouter}.js` are the real adapters (documented endpoints, `x-goog-api-key` / `Authorization: Bearer` headers, global `fetch`, injectable `fetchImpl`). Keys come ONLY from `env` (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`). Never run against a real key in this step.
* `ai/credential-guard.js`: targeted refusal of prompts that contain actual secrets (checked in `router.route()` and again in `ProviderAdapter.call`). It is NOT a content filter: ordinary news text passes byte-for-byte. Model output gets an exact-value scrub of configured secrets.
* Auth/billing/402 errors disable the model/provider (permanent, no fallback outside the allowlist); 429/quota → WAITING with provider reset info; unknown reset → backoff.
* Missing integration boundary: the Worker route `/api/newsroom/ai/:provider` is still the 501 stub. The adapters are CommonJS Node modules; the Worker cannot `require` them as-is. Smallest change (NOT done, needs owner approval): run the router in GitHub Actions/Node where the same env secrets are exposed as `process.env`, OR bundle `newsroom/` with wrangler's `nodejs_compat` and call `createRouter({ env })` from `worker/api.js` passing the Worker `env` bindings, with a Durable Object/KV-backed state store instead of `LocalStateStore`.

## Phase 3 / Step 3 — Cloudflare Workers AI (third free provider), Groq disabled
* Active chain (deterministic priority): Gemini (10, 20) → OpenRouter `:free` (30, 40) → Cloudflare `@cf/zai-org/glm-4.7-flash` (50). Groq has no allowlisted model, so it is never selected (also not by `modelPreference`). `ALLOWED_FREE_MODELS` is still derived from `ai/free-models.js`.
* `providers/cloudflare.js` extends `ProviderAdapter` (no new router, queue or quota system). REST: `POST https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{model}` with `Authorization: Bearer {CLOUDFLARE_API_TOKEN}`; the token is only ever in that header. It is "not configured" (router skips it, zero calls) unless `CLOUDFLARE_API_TOKEN`, a 32-hex `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_FREE_PLAN_CONFIRMED=true` are all present.
* Error mapping: allocation-used-up (message pattern / code 4006) → `QUOTA_DAILY` blocked until 00:00 UTC; 429 → `RATE_LIMIT_TEMPORARY` (+`retry-after`); 403/5035 (paid-only) → `PAYMENT_REQUIRED` (model disabled); 401/403/10000 → `AUTHENTICATION` (provider disabled until `clearDisabled`); timeouts/network → `PROVIDER_UNAVAILABLE`; empty/odd bodies → `MALFORMED_RESPONSE`.
* **Local Neuron budget** (`ai/quota.js`: `checkBudget`, `neuronCost`, `beginAttempt`, `fixNeurons`): registry `budget` = `{ dailyNeurons (5,000 default, downward-configurable via env `NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET`), documented per-M-token Neuron rates }`. UTC-day window, worst-case reservation, true-up from reported usage, never refunded on failure. It is an ESTIMATE (`snapshot.budget.authoritative === false`); see `FREE_MODELS.md` for limits. Exhaustion → `NEURON_BUDGET_EXHAUSTED` (temporary, retryAt = next 00:00 UTC) or `REQUEST_EXCEEDS_NEURON_BUDGET` (permanent) → existing WAITING/FAILED handling.
* Review prompts (`execution/prompts.js` `review`) now carry an EVIDENCE RULE: only supplied SOURCES count as evidence; unsupported claims are listed; the review is a flag for the human editor, not proof of accuracy.
* Credential guard/redaction also cover `*_API_TOKEN=` style assignments and env-style names (`CLOUDFLARE_API_TOKEN=…`); exact token + account-id values are redacted from errors, logs and model output.
* **Production boundary (NOT done, needs a separately authorised step):** the Worker route `/api/newsroom/ai/:provider` is still the 501 stub and `worker/api.js` `PROVIDERS` still lists only gemini/groq/openrouter. To go live: (1) pick the runtime (GitHub Actions/Node with `process.env`, or Worker with `nodejs_compat` + persistent state), (2) add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_FREE_PLAN_CONFIRMED` as secrets/vars there (inside a Worker the `AI` binding could replace the REST token — that would be a different adapter, not built), (3) add `cloudflare` to `PROVIDERS`/status in the Worker, (4) use a persistent state store so the local budget survives restarts. None of this was done; nothing was deployed.
