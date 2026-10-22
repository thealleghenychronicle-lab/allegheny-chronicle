# Free-Model Verification — Phase 3 / Step 1 (+ Step 2 Groq re-check, Step 3 Cloudflare + Groq disabled)

Verification date: **2026-10-08** (Gemini, OpenRouter), **2026-10-09** (Groq re-check, Step 2) and **2026-10-10** (Cloudflare Workers AI, Step 3). Data lives in `newsroom/ai/free-models.js` (the evidence registry); this file is the
human-readable report. If they ever disagree, the code is the source of truth and this file must be corrected.

Nothing here was tested with an API key. No inference call was made to any provider (Step 2 also made none: the Groq re-check read documentation pages only). Model IDs and limits come from the
providers' official documentation and public model-list pages only.

## Phase 3 / Step 3 status (2026-10-10) — READ THIS FIRST
**Active chain:** 1. Gemini (`gemini-3.8-flash`, `gemini-3.5-flash-lite`) → 2. OpenRouter explicit `:free` ids (`apodex/apodex-1.1-mini:free`, `inclusionai/ling-3.0-flash-sante:free`) → 3. Cloudflare Workers AI (`@cf/zai-org/glm-4.7-flash`).
**Groq is DISABLED** (owner decision: no eligible Groq model has been established as available without payment; not investigated further). Its records are `UNVERIFIED`, the adapter code is kept but no Groq id is on the allowlist, so it can never be selected automatically or by preference. The Step 2 "Groq evidence" section below is historical.
**Gemini/OpenRouter review:** the Step 1 records were re-read against their own evidence (pricing-page "Free of charge" rows; OpenRouter `:free` + zero pricing in the public list). Nothing in that evidence is unsupported or contradicted, so **no Gemini/OpenRouter model was changed**. No new provider research was done.
**No live call was made** to any provider in this step, and no account-specific access was verified.

### Cloudflare Workers AI — `@cf/zai-org/glm-4.7-flash` (documentation read 2026-10-10)
Pages read (through a web-fetch extractor, not raw HTML): [models catalog](https://developers.cloudflare.com/workers-ai/models/), [model page](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/), [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [changelog 2026-07-28](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/), [limits](https://developers.cloudflare.com/workers-ai/platform/limits/), [OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).
| Question | Evidence |
|---|---|
| Available on Workers Free? | Pricing page lists the models that require Workers Paid / AI Gateway credits: `kimi-k2.6`, `kimi-k2.7-code`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`. **glm-4.7-flash is not on that list.** The 2026-07-28 changelog says it "remain[s] available on the Workers Free plan" (the three models it moved to Paid return 403 / code 5035 on Free). Neither page states "glm-4.7-flash is free" in one sentence: it is established by exclusion from the Paid-only list plus the changelog. |
| Free allocation | **10,000 Neurons/day**, "at no charge"; resets **daily at 00:00 UTC**; "Workers Free has no paid usage option" (going beyond means upgrading to Workers Paid); when exceeded "further operations will fail with an error". |
| Price row | 5,500 Neurons per M input tokens; 36,400 Neurons per M output tokens ($0.060 / $0.400 per M; model page shows $0.0605 input — rounding). |
| Model | Text Generation, Cloudflare-hosted, function calling + reasoning, 131,072-token context. Max output tokens **not published** in the pages read → left unset (`null`). |
| API method | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/zai-org/glm-4.7-flash`, `Authorization: Bearer {API token}`, JSON body with `messages`. An OpenAI-compatible `POST …/ai/v1/chat/completions` also exists (same bearer auth). |
| Response | Output section lists `id, object, created, model, choices[], usage, system_fingerprint` (sub-fields collapsed on the page). The REST envelope is `{result, success, errors, messages}`. The adapter reads `choices[0].message.content` from `result` or the top level, and tolerates the legacy `result.response`. |
| Rate limit | Default 300 requests/minute for models that do not require Workers Paid (limits page; Free plan not mentioned there). |
| Authoritative usage API | **None found** in the pages read. Actual Neuron usage is visible only in the Cloudflare dashboard (Workers AI → Usage). |
**NOT verified:** that *your* account is on the Workers Free plan, that your API token has Workers AI permission, that the model answers for your account, which request parameters beyond `messages` this model accepts (`max_tokens`, `temperature`, `top_p`, `seed`, `stop` are sent only when set), and Cloudflare's exact "allocation used up" error text/code (recognised by pattern: "daily free allocation", "neurons", 4006, or HTTP 429).

### How free-only is enforced for Cloudflare (and what it cannot do)
1. **Allowlist/registry:** only the exact id `@cf/zai-org/glm-4.7-flash`; strict `@cf/vendor/name` id pattern; the seven documented Paid-only ids are rejected by the registry even if someone adds them to the allowlist.
2. **Owner confirmation gate:** the adapter is "not configured" (never selected) unless `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (32 hex) **and** `CLOUDFLARE_FREE_PLAN_CONFIRMED=true` are present. The last one is the owner's statement that the account is on Workers *Free* (on Workers Paid, usage above 10,000/day is billed).
3. **Local Neuron safety budget** (`ai/quota.js`, registry `budget`): default **5,000 Neurons per UTC day** (half the documented allowance), configurable only *downward* via `NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET`. Cost is computed only from the **documented per-token rates** and the request's own token counts: reserved up front at the worst case (estimated input + full `maxTokens` output at the output rate), trued-up to the usage the response reports, **never refunded on failure/timeout**, kept at the worst case when usage is missing. A request that cannot fit is not sent: `NEURON_BUDGET_EXHAUSTED` → WAITING until 00:00 UTC (or the existing waiting state if no other free provider is available); a request larger than the whole budget is refused permanently.
4. **Cloudflare's own signal:** an "allocation used up"-style error blocks the model until the next 00:00 UTC; 403/5035 (paid-only) disables the model permanently; auth errors disable the provider until `clearDisabled`.
5. **Responses never expose more than an estimate:** snapshots carry `budget: { kind: "LOCAL_ESTIMATE", authoritative: false, usedEstimate, dailyBudget, resetsAt }`.
**Limitations (remaining, honest):** the counter is an *estimate*, not Cloudflare's account usage. It cannot see other Workers AI usage on the account and it is only as durable as the router's state store: with the in-memory `LocalStateStore` a process restart forgets it (production needs the persistent store, a later step; nothing is deployed). Token counts for the input are estimated (chars/4) until the response reports real usage. The 50% margin and the Free plan's "no paid usage option" are the backstops; if the account were on Workers Paid and the counter were lost, billing would be possible — hence confirmation item 6 below.

## How this was verified (and the limits of the method)
* The sandbox shell cannot reach the provider sites (network allowlist), so pages were read through a web-fetch tool that
  returns a model-written extract of each page, not raw bytes. Facts below were cross-checked across pages where possible,
  but treat anything marked UNVERIFIED as exactly that. A 30-second re-check on your own machine is listed at the end.
* `https://openrouter.ai/api/v1/models` is ~93K characters; only the first part (up to `meta/muse-spark-1.3`) was readable,
  so the API catalog could NOT be read in full. Free IDs seen on the collection page but not confirmed in the readable part
  of the API are therefore UNVERIFIED, not enabled.
* Gemini's per-model free-tier numbers and Groq's Free-plan numbers are not in the public docs at all (see below).

## Enabled models (status VERIFIED_FREE) — Step 3 state (Groq removed, Cloudflare added)
| Order | Model key | Context / max output | Capabilities (documented) | Published limits | Free evidence |
|---|---|---|---|---|---|
| 1 | `gemini:gemini-3.8-flash` | 1,048,576 / 65,536 | structured outputs, thinking, function calling, search grounding | **none published** (null, UNVERIFIED) | Pricing page: Free Tier input+output "Free of charge"; models page: Stable |
| 2 | `gemini:gemini-3.5-flash-lite` | 1,048,576 / 65,536 | same | **none published** | Pricing page: "Free of charge"; Stable |
| 3 | `openrouter:apodex/apodex-1.1-mini:free` | 262,144 / 235,929 | tools, response_format, structured_outputs, reasoning | 20 req/min; 50 req/day (<10 credits) | Public list: `:free` suffix, prompt=completion="0", no expiration |
| 4 | `openrouter:inclusionai/ling-3.0-flash-sante:free` | 262,144 / 32,768 | tools, reasoning (no response_format) | 20 req/min; 50 req/day (<10 credits) | same |
| 5 | `cloudflare:@cf/zai-org/glm-4.7-flash` | 131,072 / not published | text, reasoning (json_output NOT claimed) | none published; **local Neuron budget 5,000/UTC day** (see Step 3 section) | Pricing page: Free 10,000 Neurons/day, model not on the Paid-only list; changelog 2026-07-28 |

Sources: Gemini [models](https://ai.google.dev/gemini-api/docs/models), [3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
[3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [pricing](https://ai.google.dev/gemini-api/docs/pricing),
[rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) · OpenRouter [models API](https://openrouter.ai/api/v1/models),
[free collection](https://openrouter.ai/collections/free-models/), [limits](https://openrouter.ai/docs/api-reference/limits).

## Recommended order (conservative)
1. `gemini-3.8-flash` — newest Stable Flash, 1M context, structured output; best available evidence for long-form writing, research synthesis and fact-check reasoning.
2. `gemini-3.5-flash-lite` — Stable, same API shape, separate per-model quota; expected to be weaker on long reasoning (**no quality testing was done**).
3. `apodex-1.1-mini:free` — OpenRouter. Unknown vendor; no quality evidence; data policy UNVERIFIED.
4. `ling-3.0-flash-sante:free` — OpenRouter. "Sante" suggests a domain-tuned variant; suitability for news writing UNVERIFIED.
5. `cloudflare:@cf/zai-org/glm-4.7-flash` — last resort; separate provider and separate (finite, locally budgeted) allowance. Quality untested.
(Groq: disabled.)

The order is by *provider status and documentation quality*, not measured article quality. No paid fallback exists in any position.
If every enabled model is unavailable, over quota, or blocked, the router returns `WAITING` with a retry time (or `FAILED`
if every block is permanent); it never widens the candidate set.

## Excluded (UNVERIFIED / NOT_FREE / UNAVAILABLE) — and why
* **Gemini**: `gemini-3.1-pro-preview` NOT_FREE (Free Tier "Not available"). `gemini-2.0-flash`, `-lite` UNAVAILABLE (shut down 2026-06-01).
  `gemini-1.5-flash` (old Chunk 1 entry) absent from current docs → UNVERIFIED, removed. `gemini-2.5-*`: free per pricing page but "access limited to users who
  have actively used" them → cannot verify for our project. `gemini-3.7-flash`, `3.6-flash`, `3.5-flash`, `3.1-flash-lite` are listed Stable and free-of-charge but
  their detail pages were not read → UNVERIFIED candidates (not needed; easy to promote). `gemini-3-flash-preview`: preview, pricing row unreadable.
* **Groq** — DISABLED in Step 3 (owner decision; `openai/gpt-oss-20b` was enabled in Step 2 on circumstantial evidence only); `openai/gpt-oss-120b` has identical evidence but is left UNVERIFIED (one Groq model is enough; promote the same way).
  `llama-3.1-8b-instant` (old Chunk 1 entry), `llama-3.3-70b-versatile` and `minimaxai/minimax-m2.7` are labelled Enterprise / Contact Sales and absent from the limits table → UNVERIFIED, excluded.
  `qwen/qwen3.8-27b` (Preview, priced), `openai/gpt-oss-safeguard-20b`, whisper/orpheus/prompt-guard models: not text-generation candidates or not read → not enabled.
* **OpenRouter**: `openrouter/free` is a **router** that picks a random free model; docs do not state it can never route to a paid model, it cannot be pinned, and its ID has no `:free` suffix → UNVERIFIED and rejected by the registry rule.
  `inclusionai/ling-3.1-flash` has zero price but no `:free` suffix → excluded. Eleven IDs from the collection page (nvidia nemotron ×4, poolside laguna ×2, thinkingmachines inkling ×2, cohere north-mini-code, dots-3-note-preview, liquid lfm-2.5)
  are UNVERIFIED because they were not confirmable in the readable part of the API list. Poolside and Liquid pages state prompts/outputs may be used for training.

## Groq evidence (retrieved 2026-10-09, Step 2) — HISTORICAL: Groq is DISABLED since Step 3; kept only to explain why it was once enabled
Pages read: [rate-limits](https://console.groq.com/docs/rate-limits), [models](https://console.groq.com/docs/models), [billing FAQ](https://console.groq.com/docs/billing-faqs), [spend limits](https://console.groq.com/docs/spend-limits), [quickstart](https://console.groq.com/docs/quickstart); groq.com/pricing had no plan details (marketing page). Pages were read through a web-fetch extractor, not raw HTML.
* Rate-limits page: two plans exist, **Free** and **Developer**; its table is headed "Free Plan Limits / Developer Plan Limits" yet the text says "the limits shown below are the base limits for the Developer plan"; "Upgrade to Developer plan to access higher limits, Batch and Flex processing." Table row (values NOT enforced): `openai/gpt-oss-20b` 30 RPM / 1K RPD / 8K TPM / 200K TPD (same for `-120b`; `qwen/qwen3.8-27b` also 30/1K/8K/200K; `gpt-oss-safeguard-20b` 3/1K/2K/200K).
* Billing FAQ: upgrade to Developer needs "a valid payment method"; downgrade "returns to Free tier rate limits and restrictions". Spend-limits page: "Spending limits are only available on paid plans, not free tier accounts." ⇒ a Free-tier org has no payment method and cannot be invoiced.
* Models page: `openai/gpt-oss-20b` Production, 131,072 context, 65,536 max completion; paid per-token price listed ($0.075 / $0.30 per 1M) — that is the Developer price; the page has no free/paid column.
* Headers confirmed: `retry-after` (seconds, only on 429), `x-ratelimit-*-requests` = RPD, `x-ratelimit-*-tokens` = TPM, `x-ratelimit-reset-*`. The adapter already parses these.
* **Uncertainty (important):** no page says "this model is included in the Free plan" or "no credit card needed to create a key". Eligibility is an *inference* (Free plan exists + cannot be billed + model is Production, in the limits table, not Enterprise-labelled). That is weaker than the Gemini pricing-page evidence. Free-plan numbers may be lower than the table. Limits are therefore left `null`; provider 429s and reset headers drive waiting.
* Safety net: if the org were on Developer, calls would be billed. Confirm in the console that the plan is **Free** (checklist item 3). To undo: set the record's `status` to `UNVERIFIED` in `ai/free-models.js` and update `EXPECTED_ENABLED` in tests.

## Provider-published limits vs. account-specific limits
| | Provider-published (documented) | Account-specific — CANNOT be verified without your dashboard |
|---|---|---|
| Gemini | Limits are per **project** (not key); RPD resets midnight Pacific; any one limit exceeded → 429; "not guaranteed". No free-tier numbers. | Your RPM/TPM/RPD per model (AI Studio → rate limits); whether billing is linked to the project |
| Groq | Ambiguous Developer/Free table (not enforced); headers on every response | Your org's real Free-plan limits (console limits page); which plan the org is on |
| OpenRouter | `:free`: 20 req/min; 50/day if <10 credits purchased, 1000/day if ≥10; capacity governed globally (extra keys do not help); negative balance can 402 even free models | Your credit balance/sign; whether the daily cap is shared across free models (docs silent — treated as shared) |

## API compatibility (docs vs. existing adapters; adapters unchanged)
* **Groq** — chat completions: `max_completion_tokens` confirmed (`max_tokens` deprecated), `temperature`, `top_p`, `stop` (≤4), `seed` confirmed. Errors: 413, 429, 498 (flex capacity), 503. 429 carries `retry-after` (seconds); rate-limit headers: `x-ratelimit-*-requests` always refer to **RPD**, `*-tokens` to **TPM**. Adapter matches.
* **OpenRouter** — `model`, `messages`, `max_tokens`, `temperature`, `top_p`, `stop`, `seed` confirmed; `finish_reason` normalized (`stop|length|tool_calls|content_filter|error`); `choices[].message.content` may be `null` (adapter → MALFORMED_RESPONSE, retried). Errors mid-generation return **HTTP 200 with an `error` body** (adapter handles). 429/503/some 402 may include `Retry-After`. Adapter sends no `models`/`route`/`provider` fallback fields (tested). 402 = insufficient credits (adapter disables that model permanently).
* **Gemini** — endpoint `v1beta/models/{model}:generateContent` and `contents`/`systemInstruction`/`generationConfig` (`maxOutputTokens`, `temperature`, `topP`, `stopSequences`) confirmed. **Not confirmed in the pages read**: `x-goog-api-key` header auth (reference examples show `?key=`; the adapter's header form is kept deliberately so keys never appear in URLs), `generationConfig.seed`, the `usageMetadata`/`modelVersion`/`promptFeedback` field names, and whether thinking tokens count against `maxOutputTokens`. Retry guidance confirmed: retry 429/408/5xx with backoff+jitter; do not retry 400/402/403. A live dry-run with a real key (owner-controlled, later step) is the only way to close these.

## Safeguards in force (tested in `tests/free-models.test.js` and `tests/real-adapters.test.js`)
1. Allowlist is **derived** from evidence; only `VERIFIED_FREE` records can be enabled; evidence is validated at load (bad data throws instead of enabling a model).
2. Registry identity rules: OpenRouter ids must end in a single `:free` and may not be routers (`openrouter/*`) or carry other variants (`:nitro`, `:online`…); ids with unsafe characters / `..` are rejected.
3. `modelPreference`, user input, provider responses and fallback suggestions can only reorder/filter approved models.
4. Router and every adapter re-assert approval immediately before each call; overrides for non-allowlisted keys throw.
5. Quota exhaustion, 429, 402, outages: move to another *approved* free model, otherwise `WAITING` with `retryAt`/`retryAfterMs` (or permanent `FAILED`). Verified with the real allowlist: zero calls outside it, zero calls while blocked.
6. Local pacing uses only documented numbers (OpenRouter 20/min, 50/day). Nothing else is invented.
7. (Step 2) Credential guard: prompts containing real secrets (configured key values, `NEWSROOM_API_TOKEN`, key shapes, Authorization headers, password/api_key assignments, private keys) are refused before any call. Ordinary news content is never filtered or rewritten.

## Known limitations / follow-ups (not done — out of Step 1 scope)
* Quota state is per model; OpenRouter's 50/day appears account-wide, so local pacing can over-allow (provider 429 is the backstop). A provider-wide cap is a later quota change.
* Free-tier **data use**: Google's pricing page says Free Tier content may be used to improve its products. Decide whether unpublished source material may be sent to free tiers (editorial/policy decision for you).
* Capacity: ~8 AI stages × 3 drafts/day ≈ 24+ calls/day before retries/revisions. OpenRouter's 50/day cap is shared and Gemini's real free RPD is unknown; check before relying on the fallbacks.
* Default `output.maxTokens` is 1024; article-length requests and thinking models need an explicit, larger value.
* Free-model availability changes frequently (OpenRouter's own warning). Re-verify before real use and periodically (`evidenceAgeDays()` helps).

## Manual verification checklist (your dashboards)
1. **Google AI Studio** → your project: confirm it is on the **Free tier with no billing account linked**; read the actual RPM/TPM/RPD for `gemini-3.8-flash` and `gemini-3.5-flash-lite`; confirm both models appear for your key.
2. **OpenRouter** → Credits: balance must be ≥ 0 (negative → 402 even on free models); note whether you have bought ≥10 credits (50 vs 1000 free requests/day); review Settings → Privacy for free-model data/training options; make sure no auto top-up is enabled.
3. ~~Groq console~~ — not needed: Groq is disabled. (`GROQ_API_KEY` may stay as an unused Cloudflare secret.)
4. **Re-check the OpenRouter public catalog locally (no key needed)**, e.g.
   `curl -s https://openrouter.ai/api/v1/models | jq -r '.data[] | select((.id|endswith(":free")) and .pricing.prompt=="0" and .pricing.completion=="0") | [.id,.context_length,.top_provider.max_completion_tokens] | @tsv'`
   and confirm the two enabled IDs still appear (and read the full list for better candidates).
5. Existing Cloudflare secrets (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `NEWSROOM_API_TOKEN`) are untouched in Step 3. The adapters read them only from environment variables (`process.env`), and nothing has been run with them.

6. **Cloudflare dashboard (Step 3, before enabling Cloudflare):** (a) Account → Billing: the account is on **Workers Free** (no Workers Paid subscription); (b) create an API token with **Workers AI** permission only (no other scopes) — never paste it in chat; (c) Workers AI → Usage: note the real Neurons used today (this is the only authoritative figure); (d) only then provide `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_FREE_PLAN_CONFIRMED=true` as server-side secrets for whichever runtime runs the router. Optional: `NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET` (integer, lowers the 5,000 default).

## Promoting a model later
Edit its record in `newsroom/ai/free-models.js`: set `status: "VERIFIED_FREE"`, a numeric `priority`, `capabilities`, documented `contextWindow`/`maxOutputTokens`,
`freeEvidence`, `sources`, and today's evidence date; keep unpublished limits `null`. `validateEvidence()` and the tests then enforce the rules; update `EXPECTED_ENABLED` in `tests/free-models.test.js` deliberately.
