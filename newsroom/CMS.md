# CMS Draft Foundation + Employee Execution (Phase 2 / Chunk 5)

Offline/dry-run only. **No real API, credential, network call, GitHub, Cloudflare, Decap, or `content/articles` write.**
Code: `newsroom/cms/`, `newsroom/execution/`, `newsroom/dry-run.js`. Tests: `tests/cms.test.js` (13), `tests/execution.test.js` (24).

## Run it
`node newsroom/dry-run.js [--category sports|food|general] [--clean] [--writer <id>] [--out <dir>]`
Default scenario also exercises a research wait, an AI wait, and a fact-check revision; `--clean` is a straight run.
Output (default `newsroom/state/dry-run-output/`, a sample is included in the ZIP): the CMS draft `.md`, `.drafts-index.json`
(slug -> jobId/reservationId), and `dry-run-report.json` (stage trace, state history, limiter use).

## Execution (`execution/`)
`WorkflowRunner.step()` claims a job from the existing `JobQueue`, runs the current employee's handler, and applies the outcome
through the queue's existing ops. `runJob(id)` drives a job until it reaches HUMAN_REVIEW or parks.
| Stage | Employee | Work | Router used |
|---|---|---|---|
| news_scout | Thurayya | find leads | Research Router |
| news_director | Maysam | newsworthy? optional writer override; soft limiter check | AI Router (`story_evaluation`) |
| research_editor | Nawfal | source packet + brief (merge/dedupe by normalized URL) | Research Router + AI (`research_synthesis`) |
| writer | Zaydan (sports) / Riham (food) / Lubna (general), or Director override | draft JSON (title, businessName, tags, excerpt, body) | AI (`writing`) |
| fact_checker | Uzayr | code check: every link must be in the research packet; then AI | AI (`fact_check`) |
| standards_editor | Jumana | code check: no trailing "Sources" dump; then AI | AI (`standards_review`) |
| source_editor | Salsabil | code check: >=1 inline source link; then AI | AI (`source_analysis`) |
| cms_editor | Maysoon | **no AI.** build Article -> CMS Markdown -> create draft (limiter) | none |
Outcomes -> queue: `complete` (handoff), `wait` (research/AI via `bridge.js`), `revision` (to writer / research_editor, capped at 3 per job ->
`REVISION_LIMIT_EXCEEDED`), `defer` (limiter full: plain release with `nextEligibleAt`, **not a failure**), `fail` (backoff; `permanent` => exhausted).
Director rejecting a lead, a non-writer override, a duplicate slug and the revision cap are permanent (job stays QUEUED, `attempts.exhausted=true`; there is no FAILED state).
After the CMS draft exists, `queue.complete` runs the existing CMS_DRAFT -> HUMAN_REVIEW. Nothing else runs after that; HUMAN_REVIEW is not claimable and `humanDecision` still requires a human actor.
AI/research are injected (`ai.route(req)`, `research.research(req)`): production uses `createRouter(...)` / `createResearchRouter(...)`; tests/dry-run use
`MockAIRouter` (validates every request with the real `createRequest`) and `ScriptedResearchProvider` behind the real Research Router.
A test also drives a stage through the REAL AI Router with scripted fetch + fake keys (success and 429 -> WAITING_FOR_AI).

## Article + CMS Markdown (`cms/`)
`createArticle` (model) -> `toCmsMarkdown` (Maysoon's formatter) -> sink. Frontmatter, in order:
`title, slug, businessName, location, category, tags, image, imageAlt, author, date, excerpt, featured, trending, editorsPick, draft`.
- `draft: true` is a literal in the formatter; the article model cannot represent anything else (input `draft` other than `true` throws);
  `assertDraftTrue` is re-run by the formatter **and independently by both sinks**, which refuse anything else. featured/trending/editorsPick are always false.
- Strings are double-quoted JSON-escaped (newline/`---` injection cannot add keys or flip `draft`); `date` is unquoted ISO (as Decap writes it);
  `author` = writer's stored byline; sources are inline links in the body (never a trailing list); `image`/`imageAlt` are blank for a human to fill.
- Sinks: `MemoryDraftSink`, `DirDraftSink` (refuses `content/articles`, path traversal, overwrite; atomic write). File name `<slug>.md` (UNVERIFIED vs real repo naming).

## Limiter wiring (`cms/draft-service.js`) -- the only consumer of the 3/rolling-24h limiter
1. draft for this job already exists -> idempotent success, **no new slot** (a still-`pending` reservation is completed = reconciliation)
2. `reserveSlot` (pending). Full -> `LIMIT_REACHED` + `retryAt` (when the oldest slot frees); nothing written; job deferred.
3. write draft; on failure -> `releaseSlot` (slot NOT consumed; if release itself fails the entry expires with the limiter's own 5-min pending timeout).
4. `completeSlot` only after the draft exists (3 tries). If it still fails the draft exists with a `pending` slot; the next attempt for the same job completes it.
Research, AI calls, reviews, waits, revisions and retries never reach this module (tested stage-by-stage).

## Additive changes to earlier chunks (defaults/behaviour unchanged; all 105 earlier tests untouched)
`limiter.js`: optional injectable clock on `reserveSlot`/`getWindowStatus`; new read-only `nextSlotAt`. `workflow/queue.js` `release()`: options `retryAt`
(defer without a failure) and `permanent` (exhaust at once).

## Known limits
Mock content only (no real model/research output tested); category labels (`Sports/Food/Business`), file naming, quoting style and `date` format are unverified
against the live Decap `config.yml` and `scripts/lib/frontmatter.js`; the queue/limiter are only run on `LocalStateStore` (GitStateStore untested); no runner CLI loop/scheduler/workflow yml;
no GitHub commit of drafts; nothing places drafts under `content/articles/` (owner step); `image` left blank.


## Chunk 6 — validation against the real Chronicle site (authority: site ZIP)
Verified facts (from the site files, not assumed):
- **Category**: Decap `category` is `widget: string` — no enum. Existing values: Healthcare, Technology, Sports, Announcements; `build.js` defaults a missing category to "Business". Newsroom labels Sports / Food / Business are valid; "Food" is a new value (related-article grouping is by exact category). Owner may rename in `cms/article.js` `CATEGORY_LABELS`.
- **Filename/slug**: collection `folder: content/articles`, `slug: "{{slug}}"` → `<slug>.md`, lowercase-hyphen (matches existing). Frontmatter `slug` is used verbatim (re-slugified) as the public URL `/articles/<slug>/`; build de-dupes duplicates by suffix.
- **Fields**: exactly title, slug, businessName, location, category, tags, image, imageAlt, author, date, excerpt, featured, trending, editorsPick, draft (+ body). Matches `FIELD_ORDER`.
- **Date**: parsed with `new Date()`; Decap writes `2026-08-02T15:13:00.000-04:00`, older articles use `2026-07-15`. Newsroom emits unquoted UTC ISO (`...Z`) — accepted by build and Decap.
- **Image**: `image` is required in Decap but optional in the build (blank → `/images/placeholder-hero.jpg`, alt → title). Drafts keep `image: ""` deliberately: Decap will not save until a human picks an image (media folder `public/images/articles`, public path `/images/articles`).
- **draft**: `draft: true` → build skips it entirely (no `articles.json` entry, page, or sitemap URL).
- **Site parser limits** (`scripts/lib/frontmatter.js`): strips outer quotes but never unescapes; inline arrays split on commas; ignores indented continuation lines. Hence the formatter's quoting rules, block-list tags, and single-line values.
Observations for the owner (site is unchanged): (1) Decap folds long YAML strings over several lines; the site parser then keeps only the first line of a long `excerpt`/`title` after a human re-saves in Decap (already visible in existing articles). (2) `build.js` templating uses `String.replace` with raw text, so `$&`, `$'` or `$$` in a title/body would be mangled. (3) Build does not escape HTML (hence the raw-HTML refusal here).
Phase 3 note: with `publish_mode: editorial_workflow`, files committed straight to `content/articles` appear as published entries (hidden by `draft: true`), not on the Editorial Workflow board; showing them there needs a `cms/articles/<slug>` branch + PR, a Phase 3 decision.
State store: `GitStateStore` validated offline against a local bare remote (orphan `newsroom-state` branch, push-rejection = conflict, refresh+retry, multi-file atomic commit, limiter ≤3 across workers, duplicate-claim-safe queue, whole workflow on the git store, only `.json` on the state branch).
Run site-compat against a real checkout: `CHRONICLE_SITE_DIR=<site root> node --test newsroom/tests/site-compat.test.js`.
