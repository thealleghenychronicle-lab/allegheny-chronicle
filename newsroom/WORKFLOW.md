# Workflow / Orchestrator Foundation (Phase 2 / Chunk 4)

Smallest usable job engine. Orchestration and handoff only (employee work was added in Chunk 5, see `CMS.md`) -- **no scheduler, no real providers**. Code: `newsroom/workflow/`. Tests: `newsroom/tests/workflow.test.js`.

## States (exactly these ten) and legal transitions
QUEUED -> IN_PROGRESS
IN_PROGRESS -> QUEUED | WAITING_FOR_RESEARCH | WAITING_FOR_AI | NEEDS_REVISION | READY_FOR_CMS | CMS_DRAFT
WAITING_FOR_RESEARCH / WAITING_FOR_AI / NEEDS_REVISION -> IN_PROGRESS | QUEUED
READY_FOR_CMS -> IN_PROGRESS (CMS Editor claims) | CMS_DRAFT -> HUMAN_REVIEW
HUMAN_REVIEW -> HUMAN_APPROVED | HUMAN_REJECTED (**human actor required**; both terminal)
Anything else throws `WorkflowError` (`INVALID_TRANSITION`, `UNKNOWN_STATE`, `HUMAN_ACTOR_REQUIRED`). `applyTransition` is pure
(returns a new job, appends `history`).

## Handoff pipeline (`handoff.js`, `constants.STAGES`)
news_scout (Thurayya) -> news_director (Maysam) -> research_editor (Nawfal) -> writer -> fact_checker (Uzayr) ->
standards_editor (Jumana) -> source_editor (Salsabil) -> [READY_FOR_CMS] cms_editor (Maysoon) -> CMS_DRAFT -> **HUMAN_REVIEW** (stop).
Employees are resolved from the existing `newsroom/employees/*.json` by `position`. Writer: `request.category`
sports->Zaydan, food->Riham, general (default)->Lubna; the News Director stage may override with `complete(..., {writerId})`.
`CMS_DRAFT` is a recorded workflow state only -- nothing is written to the CMS.

## Job (`job.js`)
`id, state, stage, assignedTo, writerId, request{title,category,leadUrl,notes,source}, createdAt/updatedAt/stateEnteredAt (ISO),
attempts{claims,failures,maxFailures,waits,lastAttemptAt,nextEligibleAt,exhausted}, claim{workerId,token,claimedAt,leaseExpiresAt},
error{code,message(redacted,<=500),at,stage,failure}, wait{kind,reason,since,resumeAt,stage,context}, revision{count,current}, data, history`.
Not the final article model.

## Queue (`queue.js`: `new JobQueue({store, now})`)
Works over any existing state store (`LocalStateStore` for tests/dry-run; `GitStateStore` shape-compatible). All jobs live in one
file, `workflow/jobs.json`, so a claim is one atomic compare-and-write: a racing second claimer gets a write conflict, re-reads,
and receives `ALREADY_CLAIMED`.
`enqueue`, `get`, `list`, `getEligible` (read-only, FIFO), `claim({workerId, jobId?, assignedTo?})` -> `{job, token}`,
`update(id, token, {data})`, `complete`, `wait`, `requestRevision`, `release(id, token, {error?})`, `resetRetries`, `humanDecision`.
Every mutating call except `claim`/`enqueue`/`humanDecision` needs the claim token. Results are `{ok:true,...}` or `{ok:false, reason}`; failures write nothing.

## Retry / wait / revision
- Release with `error`: failure++, exponential backoff (30s x 2^(n-1), cap 30m) in `nextEligibleAt`; at `maxFailures` (default 5) the job stays
  QUEUED with `attempts.exhausted=true` and is NOT eligible until an operator calls `resetRetries`. (No extra FAILED state: only the ten approved states exist.)
- Lease: a claim lasts 10 min (`update` extends it). An expired lease is swept on the next `claim`: counted as a failure (`LEASE_EXPIRED`), job re-queued, no backoff.
- `wait({kind:'research'|'ai', resumeAt?, reason?, context?})` parks the job at the same stage/employee until `resumeAt` (default +15 min); not counted as a failure.
  `bridge.js` maps the existing AI Router (`WAITING` / retryable `retry.retryAt`) and Research Router (`ALL_PROVIDERS_FAILED`) results onto this. It only maps; it calls nothing.
- `requestRevision({targetStage:'research_editor'|'writer', reason, notes?})` from a later stage: NEEDS_REVISION, reassigned, `revision.current` records who/why, count++.
  After the fix the job flows through the later stages again.

## Chunk 5 update
Employee execution, the runner and CMS draft creation now exist -- see `CMS.md`. The workflow engine itself is unchanged except `release()` gained
`retryAt` / `permanent` options. The limiter is consumed only by `cms/draft-service.js` (CMS Editor stage); Chunk 4's test that bare workflow ops never write
`article-timestamps.json` still holds.

## Still not built
Scheduler/long-running runner loop, GitHub workflow yml, real AI/research providers wired in, committing drafts to the real repo.
