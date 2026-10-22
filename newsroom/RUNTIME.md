# Production runtime (Phase 3 / Step 4)

**Chosen runtime: GitHub Actions running the existing Node.js code, with the existing `GitStateStore` on the `newsroom-state` branch.**
The public website stays on Cloudflare (Worker + Static Assets); the Worker is not involved in running the newsroom.

## Why this works with no rebuild
- Pure Node.js, **zero npm dependencies**, CommonJS. Needs Node >= 20 (global `fetch`, `node:test`); verified on Node 22.22.0.
- `GitStateStore` shells out to `git` against a private temp clone, so it needs only `git` (>= 2.31) and network access to github.com. A rejected push is the concurrency signal, so correctness does not depend on the runner (Actions `concurrency` is only an extra).
- The AI adapters (Gemini, OpenRouter, Cloudflare Workers AI) use REST over `fetch`. They work from any Node host; Cloudflare uses the REST token path, so no Workers binding is needed.
- State that must outlive a runner VM is already in the state store: job queue, 3/24h limiter, router quota and the Cloudflare Neuron budget (`quota-<provider>.json`). Proven in `tests/runtime.test.js` (a second, brand-new store sees run 1's state).

## What Step 4 added
- `package.json` (engines, `npm test`, `npm run runtime:check`; no dependencies).
- `newsroom/runtime.js`: offline preflight (`check`) and `createStateStoreFromEnv()`, the one place the real store is wired. Not invoked against a real repo in this step.
- `GitStateStore` options (defaults unchanged): `env` (git-only environment, used for the auth header) and `createIfMissing` (default `true`; the runtime factory passes `false`). Only a "couldn't find remote ref" failure can lead to branch creation; auth/network failures now surface instead of being treated as "branch absent". A failed constructor cleans up its temp dir.
- `.github/workflows/newsroom-runtime-check.yml`: manual `workflow_dispatch` only; read-only; no secrets, no schedule; runs preflight, `npm test`, offline dry run.

## Configuration (names only; never commit values)
| Variable | Kind | Where it comes from | Needed |
|---|---|---|---|
| `GITHUB_REPOSITORY` | public | automatic in Actions | state store (Step 5+) |
| `GITHUB_TOKEN` | secret | automatic in Actions; the job needs `permissions: contents: write` | state store (Step 5+) |
| `NEWSROOM_STATE_TOKEN` | secret, optional | repo Actions secret; fine-grained PAT, Contents read/write on this repo only; overrides `GITHUB_TOKEN` | only if `GITHUB_TOKEN` cannot be used |
| `NEWSROOM_STATE_REMOTE_URL` | optional | override of the https remote; must not contain credentials | normally unset |
| `GEMINI_API_KEY` | secret | repo Actions secret | real AI step |
| `OPENROUTER_API_KEY` | secret | repo Actions secret | real AI step |
| `CLOUDFLARE_API_TOKEN` | secret | repo Actions secret (Workers AI-scoped token) | real AI step |
| `CLOUDFLARE_ACCOUNT_ID` | sensitive id | repo Actions secret | real AI step |
| `CLOUDFLARE_FREE_PLAN_CONFIRMED` | flag | repo Actions variable, exactly `true` | real AI step |
| `NEWSROOM_CLOUDFLARE_DAILY_NEURON_BUDGET` | optional | variable; can only lower the built-in 5,000 | optional |
| `NEWSROOM_SAFE_MODE` | optional | leave unset | -- |

Not needed by the runner: `GROQ_API_KEY` (Groq disabled), `NEWSROOM_API_TOKEN` (Worker-only secret). `NEWSROOM_SAFE_MODE` is exported by `config.js` but nothing in the code reads it yet, so it is not a safety control today.

Credentials reach git only through `GIT_CONFIG_COUNT/KEY_0/VALUE_0` (`http.<origin>/.extraheader`) in the git process environment: not in the URL, argv, `.git/config` or error text. Providers read keys from `process.env` and the existing redaction/credential guard applies. Map secrets to env in a workflow step's `env:` only for the steps that need them.

## Preflight
`npm run runtime:check` (or `node newsroom/runtime.js check [--require state,ai] [--json]`) reports Node/git versions and set/missing per variable name, never a value, makes no network call, and exits 1 on a problem (`--require` makes a missing group an error).

## Known limits / for later steps
- Live GitHub authentication and push from an Actions runner are **not** tested here (no repo access). Everything is verified against a local bare repo; the auth header is verified only up to "git sees it in its environment".
- Pushes made with `GITHUB_TOKEN` do not trigger other workflows (good). If Cloudflare Workers Builds is set to build non-production branches, a push to `newsroom-state` could trigger a build; confirm that setting before Step 5.
- The runner entry point (loop over jobs, real providers, committing drafts), the schedule and the real workflow with `concurrency: newsroom` are later steps. Scheduled workflows on a public repo are auto-disabled after 60 days without repo activity (GitHub behaviour; verify when scheduling).


## Step 5 addendum
The real `newsroom-state` branch is created/verified only by `newsroom/state-connect.js` (workflow `newsroom-state-connect.yml`, manual). See `newsroom/STATE_CONNECT.md`. `createStateStoreFromEnv` still defaults to `createIfMissing:false`.
