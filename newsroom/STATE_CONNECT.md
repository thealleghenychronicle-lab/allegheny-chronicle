# Connecting the real `newsroom-state` branch (Phase 3 / Step 5)

Repository: `thealleghenychronicle-lab/allegheny-chronicle`. Branch: `newsroom-state` (orphan; holds JSON state only).
Code: `newsroom/state-connect.js` (reuses `GitStateStore`, `runtime.js`, `limiter.js`). Workflow: `.github/workflows/newsroom-state-connect.yml`.

> **Verification status: NOT verified against real GitHub.** Everything below was proven only against local bare repositories and a
> loopback fake HTTP server. The real branch is verified only once *you* run the workflow and it passes.

## Modes
| mode | writes? | what it does |
|---|---|---|
| `read-only` (default) | nothing | authenticate, ask GitHub whether the branch exists, clone, check it holds state files only, read. Fails if the branch is missing. |
| `verify` | `connection-check.json` only | branch must exist. Writes a record, reads it back through a **fresh clone**, runs a concurrent-writer probe. |
| `initialize` | creates branch, then as `verify` | creates the orphan branch **only if GitHub positively reports it absent**; needs `INITIALIZE` typed in the confirm box. On an existing branch it creates nothing. |

## Safety properties (all covered by `tests/state-connect.test.js`)
- Never force-pushes, resets, deletes or rewrites a branch. Creation is one plain push of a brand-new orphan commit containing only `.gitkeep`; if the branch appears in the meantime the push is rejected and the run fails.
- The branch is built in an empty temp directory: no website, `content/`, `public/` or article file can reach it. Before any use the branch tree is checked: anything that is not `.json`/`.gitkeep` makes the run refuse (`ISOLATION_VIOLATION`).
- The check writes **only** `connection-check.json` (last 20 run records). It proves, and tests assert, that `article-timestamps.json`, `quota-*.json` (incl. the Cloudflare Neuron estimate) and `workflow/*.json` are byte-identical before and after.
- Missing branch is decided by `git ls-remote --exit-code` (exit 2, empty stderr). Auth (401), permission (403, protection rules/rulesets), repo-not-found (404), network, 5xx and timeouts are classified and **fail the run**; none can be mistaken for a missing branch. Only a plain non-fast-forward rejection (or the server's ref-lock race, "cannot lock ref ... but expected") counts as a write conflict; any other failed push is thrown, not retried as a conflict.
- Pinned to `thealleghenychronicle-lab/allegheny-chronicle` (`NEWSROOM_EXPECTED_REPOSITORY`); a remote override is refused; the workflow runs only from the default branch.
- Token only in git's environment header; never in a URL, argv, `.git/config`, output or step summary (redacted as a second defence).

## Exact steps for you
1. **Install** the ZIP contents into the repo root on `main` (copy `package.json`, `newsroom/`, `.github/workflows/` — the workflow files only; nothing else of the site changes). Commit and push to `main` with GitHub Desktop.
   If `package.json` already exists in the repo root, do not overwrite it blindly; merge the `scripts`/`engines` fields.
2. **Check GitHub settings** (Repo → Settings):
   - *Actions → General → Actions permissions*: Actions must be enabled, and the policy must allow `actions/checkout` and `actions/setup-node` (the default "Allow all" does; "Allow select" needs GitHub-created actions allowed).
   - *Actions → General → Workflow permissions*: the workflow asks for `contents: write` itself for the write job. If a run fails with `PERMISSION` / HTTP 403, switch this to **Read and write permissions** (and check any organisation-level cap, Settings of the `thealleghenychronicle-lab` organisation → Actions → General).
   - *Rules / Branches*: there must be no ruleset or branch-protection rule that blocks creating or pushing `newsroom-state` (e.g. "restrict creations", or a `*` pattern). A rule limited to `main` is fine.
   - Cloudflare: make sure non-production branch builds are off for the Workers Build, so pushes to `newsroom-state` do not trigger a site build (unconfirmed since Phase 1). If they are on, a build is harmless but wasteful, and the site is not affected.
3. **Run 1 — read-only.** Actions → *Newsroom state connect* → Run workflow → branch `main`, mode `read-only`. Expected today: the run **fails** with `REF_MISSING` ("branch does not exist. Nothing was created"). That proves auth works and the branch is absent. If you see `AUTH`, `PERMISSION`, `REPO_NOT_FOUND` or `NETWORK` instead, fix that first (step 2); nothing was created.
4. **Run 2 — initialize.** Run workflow → mode `initialize`, confirm `INITIALIZE`. Expected: green; the summary shows "branch created (orphan, non-force push)", "write persisted", "concurrent writers…", "limiter, quota and job state left untouched".
5. **Run 3 — verify** (this is the "survives separate runs" proof). Mode `verify`. Expected: green and "`connection-check.json`: 1 earlier verification(s) found" — written by a different run on a different runner.
6. **Look at GitHub**: the repo now has a `newsroom-state` branch containing only `.gitkeep` and `connection-check.json`. `main` is unchanged.
7. Report the three run results (pass/fail and the summary text). Do not paste any token.

## Failure messages
`REF_MISSING` branch absent · `AUTH` token rejected · `PERMISSION` token lacks write / rule blocks it · `REPO_NOT_FOUND` wrong repo or no access · `NETWORK`/`TIMEOUT` transient, re-run · `WRONG_REPOSITORY` ran in a copy/fork · `ISOLATION_VIOLATION` branch has non-state files (nothing modified) · `STALE_WRITE_ACCEPTED` the remote accepted a stale write, so claims would not be safe — stop and report.

## Not done here
Nothing starts the real runner, schedule, AI/research calls or CMS drafts. `createStateStoreFromEnv` still defaults to `createIfMissing:false`.
