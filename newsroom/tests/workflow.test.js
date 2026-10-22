"use strict";
// Chunk 4 -- workflow/orchestrator foundation. Fully offline: LocalStateStore only, injected clock,
// no AI/research providers called, no network, no credentials.
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../workflow");
const { LocalStateStore } = require("../local-state-store");
const { getWindowStatus } = require("../limiter");
const { createResearchRouter } = require("../research/router");

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
function setup({ leaseMs, maxFailures } = {}) {
  const clock = { t: T0 };
  const store = new LocalStateStore();
  const q = new W.JobQueue({ store, now: () => clock.t, leaseMs, maxFailures });
  return { clock, store, q };
}
const REQ = { title: "Pittsburgh bakery expands", category: "food" };
const human = { type: "human", id: "owner" };

// claim + complete helper: runs the job through one stage.
function step(q, jobId, worker = "w1", opts = {}) {
  const c = q.claim({ workerId: worker, jobId });
  assert.equal(c.ok, true, JSON.stringify(c));
  const r = q.complete(jobId, c.token, opts);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.job;
}

// ---------- job creation ----------
test("createJob: required fields, defaults, unique ids", () => {
  const a = W.createJob({ request: REQ, now: T0 });
  const b = W.createJob({ request: REQ, now: T0 });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^job-/);
  assert.equal(a.state, "QUEUED");
  assert.equal(a.stage, "news_scout");
  assert.equal(a.createdAt, new Date(T0).toISOString());
  assert.deepEqual(a.attempts, { claims: 0, failures: 0, maxFailures: 5, waits: 0, lastAttemptAt: null, nextEligibleAt: null, exhausted: false });
  assert.equal(a.error, null);
  assert.deepEqual(a.request, { title: "Pittsburgh bakery expands", category: "food", leadUrl: null, notes: null, source: null });
});

test("createJob: rejects bad request data", () => {
  for (const bad of [null, [], {}, { title: "  " }, { title: "x", category: "weather" }, { title: "x", leadUrl: 5 }]) {
    assert.throws(() => W.createJob({ request: bad }), (e) => e.code === "INVALID_REQUEST", JSON.stringify(bad));
  }
});

test("enqueue: persists job assigned to the News Scout; duplicate id and bad request refused", () => {
  const { q } = setup();
  const r = q.enqueue(REQ, { id: "job-1" });
  assert.equal(r.ok, true);
  assert.equal(r.job.assignedTo, "thurayya");
  assert.equal(q.get("job-1").state, "QUEUED");
  assert.deepEqual(q.enqueue(REQ, { id: "job-1" }).reason, "DUPLICATE_ID");
  assert.equal(q.enqueue({}).reason, "INVALID_REQUEST");
  assert.equal(q.list().length, 1);
});

// ---------- state machine ----------
test("exactly the ten approved states exist", () => {
  assert.deepEqual(Object.keys(W.STATES).sort(), ["CMS_DRAFT", "HUMAN_APPROVED", "HUMAN_REJECTED", "HUMAN_REVIEW", "IN_PROGRESS", "NEEDS_REVISION", "QUEUED", "READY_FOR_CMS", "WAITING_FOR_AI", "WAITING_FOR_RESEARCH"]);
});

test("transition table: every state pair is allowed iff listed", () => {
  const legal = [
    ["QUEUED", "IN_PROGRESS"], ["IN_PROGRESS", "QUEUED"], ["IN_PROGRESS", "WAITING_FOR_RESEARCH"], ["IN_PROGRESS", "WAITING_FOR_AI"],
    ["IN_PROGRESS", "NEEDS_REVISION"], ["IN_PROGRESS", "READY_FOR_CMS"], ["IN_PROGRESS", "CMS_DRAFT"],
    ["WAITING_FOR_RESEARCH", "IN_PROGRESS"], ["WAITING_FOR_RESEARCH", "QUEUED"], ["WAITING_FOR_AI", "IN_PROGRESS"], ["WAITING_FOR_AI", "QUEUED"],
    ["NEEDS_REVISION", "IN_PROGRESS"], ["NEEDS_REVISION", "QUEUED"], ["READY_FOR_CMS", "IN_PROGRESS"],
    ["CMS_DRAFT", "HUMAN_REVIEW"], ["HUMAN_REVIEW", "HUMAN_APPROVED"], ["HUMAN_REVIEW", "HUMAN_REJECTED"]
  ].map((p) => p.join(">"));
  for (const from of Object.keys(W.STATES)) for (const to of Object.keys(W.STATES)) {
    assert.equal(W.canTransition(from, to), legal.includes(`${from}>${to}`), `${from} -> ${to}`);
  }
});

test("invalid transitions throw and never mutate the job", () => {
  const job = W.createJob({ request: REQ, now: T0 });
  const snapshot = JSON.stringify(job);
  for (const to of ["HUMAN_REVIEW", "HUMAN_APPROVED", "CMS_DRAFT", "READY_FOR_CMS", "NEEDS_REVISION", "WAITING_FOR_AI", "QUEUED"]) {
    assert.throws(() => W.applyTransition(job, to, { now: T0, actor: human }), (e) => e.code === "INVALID_TRANSITION", to);
  }
  assert.throws(() => W.applyTransition(job, "BOGUS", { now: T0 }), (e) => e.code === "UNKNOWN_STATE");
  assert.throws(() => W.assertTransition("NOPE", "QUEUED"), (e) => e.code === "UNKNOWN_STATE");
  assert.equal(JSON.stringify(job), snapshot);
  for (const t of ["HUMAN_APPROVED", "HUMAN_REJECTED"]) for (const to of Object.keys(W.STATES)) assert.equal(W.canTransition(t, to), false);
});

test("valid transition returns a new job with history; original untouched", () => {
  const job = W.createJob({ request: REQ, now: T0 });
  const next = W.applyTransition(job, "IN_PROGRESS", { now: T0 + 1000, actor: { type: "worker", id: "w" } });
  assert.equal(job.state, "QUEUED");
  assert.equal(next.state, "IN_PROGRESS");
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].from, "QUEUED");
  assert.equal(next.updatedAt, new Date(T0 + 1000).toISOString());
});

test("HUMAN_APPROVED/REJECTED require a human actor", () => {
  let job = W.createJob({ request: REQ, now: T0 });
  job = { ...job, state: "HUMAN_REVIEW" };
  for (const actor of [null, { type: "worker", id: "w" }, { type: "system", id: "workflow" }, { type: "human" }]) {
    assert.throws(() => W.applyTransition(job, "HUMAN_APPROVED", { now: T0, actor }), (e) => e.code === "HUMAN_ACTOR_REQUIRED");
  }
  assert.equal(W.applyTransition(job, "HUMAN_APPROVED", { now: T0, actor: human }).state, "HUMAN_APPROVED");
});

// ---------- queue operations ----------
test("queue: eligible retrieval is FIFO and read-only", () => {
  const { q, clock } = setup();
  q.enqueue({ title: "A" }, { id: "a" });
  clock.t += 1000;
  q.enqueue({ title: "B" }, { id: "b" });
  assert.deepEqual(q.getEligible({ limit: 5 }).map((j) => j.id), ["a", "b"]);
  assert.deepEqual(q.getEligible({ assignedTo: "nobody" }), []);
  assert.equal(q.get("a").state, "QUEUED"); // retrieval did not claim
});

test("queue: claim next / by id; update requires the claim token", () => {
  const { q } = setup();
  q.enqueue({ title: "A" }, { id: "a" });
  q.enqueue({ title: "B" }, { id: "b" });
  const c = q.claim({ workerId: "w1" });
  assert.equal(c.ok, true);
  assert.equal(c.job.id, "a");
  assert.equal(c.job.state, "IN_PROGRESS");
  assert.equal(c.job.attempts.claims, 1);
  assert.equal(c.job.claim.workerId, "w1");
  assert.equal(q.claim({ workerId: "w2", jobId: "b" }).job.id, "b");
  assert.equal(q.claim({ workerId: "w3" }).reason, "NO_ELIGIBLE_JOB");
  assert.equal(q.claim({ workerId: "w3", jobId: "zzz" }).reason, "NOT_FOUND");
  assert.equal(q.claim({}).reason, "INVALID_ARGUMENT");

  assert.equal(q.update("a", "wrong-token", { data: { x: 1 } }).reason, "CLAIM_MISMATCH");
  const u = q.update("a", c.token, { data: { note: "hello" } });
  assert.equal(u.ok, true);
  assert.equal(q.get("a").data.note, "hello");
  assert.equal(q.update("a", c.token, { data: [] }).reason, "INVALID_ARGUMENT");
});

test("queue: operations on an unclaimed job are refused and write nothing", () => {
  const { q, store } = setup();
  q.enqueue(REQ, { id: "a" });
  const v = store.backing.version;
  assert.equal(q.complete("a", "tok").reason, "NOT_CLAIMED");
  assert.equal(q.wait("a", "tok", { kind: "ai" }).reason, "NOT_CLAIMED");
  assert.equal(q.release("a", "tok").reason, "NOT_CLAIMED");
  assert.equal(q.complete("nope", "tok").reason, "NOT_FOUND");
  assert.equal(store.backing.version, v);
});

// ---------- duplicate claim prevention ----------
test("duplicate claim: second claimer of the same job is refused", () => {
  const { q } = setup();
  q.enqueue(REQ, { id: "a" });
  assert.equal(q.claim({ workerId: "w1", jobId: "a" }).ok, true);
  assert.equal(q.claim({ workerId: "w2", jobId: "a" }).reason, "ALREADY_CLAIMED");
  assert.equal(q.claim({ workerId: "w2" }).reason, "NO_ELIGIBLE_JOB");
});

test("duplicate claim: two workers on separate store views never get the same job", () => {
  const { q, store, clock } = setup();
  const q2 = new W.JobQueue({ store: store.sibling(), now: () => clock.t });
  q.enqueue({ title: "A" }, { id: "a" });
  q.enqueue({ title: "B" }, { id: "b" });
  const c1 = q.claim({ workerId: "w1" });
  const c2 = q2.claim({ workerId: "w2" });
  assert.equal(c1.ok && c2.ok, true);
  assert.notEqual(c1.job.id, c2.job.id);
});

test("duplicate claim: a true race (write conflict) lets exactly one worker win", () => {
  const { q, store, clock } = setup();
  const storeB = store.sibling();
  const qB = new W.JobQueue({ store: storeB, now: () => clock.t });
  q.enqueue(REQ, { id: "a" });
  // B reads the job as QUEUED, then A claims before B's write lands -> B's first write conflicts.
  const realWrite = storeB.writeAtomic.bind(storeB);
  let raced = false;
  storeB.writeAtomic = (files, msg) => {
    if (!raced) { raced = true; assert.equal(q.claim({ workerId: "A", jobId: "a" }).ok, true); }
    return realWrite(files, msg);
  };
  const b = qB.claim({ workerId: "B", jobId: "a" });
  assert.equal(raced, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, "ALREADY_CLAIMED");
  assert.equal(q.get("a").claim.workerId, "A");
  assert.equal(q.get("a").attempts.claims, 1);
});

test("expired lease: crashed worker's job is reclaimable, counted as a failure, old token dead", () => {
  const { q, clock } = setup({ leaseMs: 60000 });
  q.enqueue(REQ, { id: "a" });
  const c1 = q.claim({ workerId: "w1" });
  clock.t += 59000;
  assert.equal(q.claim({ workerId: "w2" }).reason, "NO_ELIGIBLE_JOB");
  clock.t += 2000;
  assert.equal(q.getEligible().length, 1);
  const c2 = q.claim({ workerId: "w2" });
  assert.equal(c2.ok, true);
  assert.equal(c2.job.attempts.failures, 1);
  assert.equal(c2.job.error.code, "LEASE_EXPIRED");
  assert.equal(q.complete("a", c1.token).reason, "CLAIM_MISMATCH");
  assert.equal(q.complete("a", c2.token).ok, true);
});

// ---------- retry / release ----------
test("release without error: back to QUEUED, no failure counted, immediately eligible", () => {
  const { q } = setup();
  q.enqueue(REQ, { id: "a" });
  const c = q.claim({ workerId: "w1" });
  const r = q.release("a", c.token);
  assert.equal(r.job.state, "QUEUED");
  assert.equal(r.job.attempts.failures, 0);
  assert.equal(r.job.claim, null);
  assert.equal(q.claim({ workerId: "w2" }).ok, true);
});

test("release with error: failure recorded, exponential backoff, redacted+truncated error, exhausts at max", () => {
  const { q, clock } = setup({ maxFailures: 3 });
  q.enqueue(REQ, { id: "a" });
  const secret = "AIza" + "x".repeat(30);
  let c = q.claim({ workerId: "w1" });
  let r = q.release("a", c.token, { error: { code: "BOOM", message: `failed with key ${secret} ${"y".repeat(900)}` } });
  assert.equal(r.job.attempts.failures, 1);
  assert.equal(r.job.error.code, "BOOM");
  assert.equal(r.job.error.stage, "news_scout");
  assert.equal(r.job.error.failure, 1);
  assert.ok(!r.job.error.message.includes(secret));
  assert.ok(r.job.error.message.length <= 504);
  assert.equal(r.job.attempts.nextEligibleAt, new Date(clock.t + 30000).toISOString());
  assert.equal(q.claim({ workerId: "w2" }).reason, "NO_ELIGIBLE_JOB"); // backing off
  assert.equal(q.claim({ workerId: "w2", jobId: "a" }).reason, "NOT_ELIGIBLE");
  clock.t += 30000;
  c = q.claim({ workerId: "w2" });
  assert.equal(c.ok, true);
  r = q.release("a", c.token, { error: { code: "BOOM", message: "again" } });
  assert.equal(r.job.attempts.nextEligibleAt, new Date(clock.t + 60000).toISOString());
  clock.t += 60000;
  c = q.claim({ workerId: "w3" });
  r = q.release("a", c.token, { error: { code: "BOOM", message: "third" } });
  assert.equal(r.job.attempts.exhausted, true);
  assert.equal(r.job.state, "QUEUED");
  clock.t += 10 * 60 * 60 * 1000;
  assert.equal(q.claim({ workerId: "w4" }).reason, "NO_ELIGIBLE_JOB");
  assert.equal(q.resetRetries("a").ok, true);
  assert.equal(q.claim({ workerId: "w4" }).ok, true);
});

test("successful stage completion resets the consecutive-failure counter", () => {
  const { q, clock } = setup();
  q.enqueue(REQ, { id: "a" });
  let c = q.claim({ workerId: "w1" });
  q.release("a", c.token, { error: { code: "E", message: "m" } });
  clock.t += 60000;
  const j = step(q, "a");
  assert.equal(j.attempts.failures, 0);
  assert.equal(j.error, null);
  assert.equal(j.stage, "news_director");
});

// ---------- waiting states ----------
test("WAITING_FOR_RESEARCH: parked until resumeAt, then resumes at the same stage and employee", () => {
  const { q, clock } = setup();
  q.enqueue(REQ, { id: "a" });
  step(q, "a"); step(q, "a"); // scout, director -> research_editor
  let c = q.claim({ workerId: "w1" });
  assert.equal(c.job.assignedTo, "nawfal");
  const resumeAt = new Date(clock.t + 5 * 60000).toISOString();
  const w = q.wait("a", c.token, { kind: "research", reason: "providers down", resumeAt, context: { query: "bakery" } });
  assert.equal(w.job.state, "WAITING_FOR_RESEARCH");
  assert.equal(w.job.stage, "research_editor");
  assert.equal(w.job.assignedTo, "nawfal");
  assert.equal(w.job.claim, null);
  assert.deepEqual(w.job.wait, { kind: "research", reason: "providers down", since: new Date(clock.t).toISOString(), resumeAt, stage: "research_editor", context: { query: "bakery" } });
  assert.equal(w.job.attempts.waits, 1);
  assert.equal(q.getEligible().length, 0);
  assert.equal(q.claim({ workerId: "w2" }).reason, "NO_ELIGIBLE_JOB");
  clock.t += 5 * 60000;
  c = q.claim({ workerId: "w2" });
  assert.equal(c.ok, true);
  assert.equal(c.job.state, "IN_PROGRESS");
  assert.equal(c.job.stage, "research_editor");
  assert.equal(c.job.wait, null);
  assert.equal(c.job.attempts.failures, 0); // waiting is not a failure
});

test("WAITING_FOR_AI: default park time applies when no resumeAt is given", () => {
  const { q, clock } = setup();
  q.enqueue(REQ, { id: "a" });
  const c = q.claim({ workerId: "w1" });
  const w = q.wait("a", c.token, { kind: "ai", reason: "quota" });
  assert.equal(w.job.state, "WAITING_FOR_AI");
  assert.equal(w.job.wait.resumeAt, new Date(clock.t + W.DEFAULTS.WAIT_MS).toISOString());
  clock.t += W.DEFAULTS.WAIT_MS - 1;
  assert.equal(q.getEligible().length, 0);
  clock.t += 1;
  assert.equal(q.getEligible().length, 1);
  assert.equal(q.wait("a", "x", { kind: "ai" }).reason, "NOT_CLAIMED"); // already parked
});

test("wait: invalid kind / resumeAt refused with no state change", () => {
  const { q } = setup();
  q.enqueue(REQ, { id: "a" });
  const c = q.claim({ workerId: "w1" });
  assert.equal(q.wait("a", c.token, { kind: "weather" }).reason, "INVALID_WAIT_KIND");
  assert.equal(q.wait("a", c.token, { kind: "ai", resumeAt: "not a date" }).reason, "INVALID_ARGUMENT");
  assert.equal(q.get("a").state, "IN_PROGRESS");
});

test("bridge: existing AI router and Research router results map onto waits", async () => {
  const aiWaiting = { ok: false, status: "WAITING", error: { category: "ALL_OPTIONS_TEMPORARILY_UNAVAILABLE", retryable: true }, retry: { retryable: true, retryAt: "2026-10-02T12:30:00.000Z", reason: "X" } };
  assert.deepEqual(W.aiResultToWait(aiWaiting), { kind: "ai", reason: "ALL_OPTIONS_TEMPORARILY_UNAVAILABLE", resumeAt: "2026-10-02T12:30:00.000Z" });
  assert.equal(W.aiResultToWait({ ok: true, status: "SUCCESS" }), null);
  assert.equal(W.aiResultToWait({ ok: false, status: "FAILED", error: { category: "NO_ELIGIBLE_MODEL", retryable: false }, retry: { retryable: false, retryAt: null } }), null);

  const failing = { isConfigured: () => true, run: async () => ({ ok: false, error: { category: "TEMPORARY_FAILURE", message: "down" } }) };
  const res = await createResearchRouter({ providers: { failing } }).research({ query: "pittsburgh business" });
  assert.equal(res.error.category, "ALL_PROVIDERS_FAILED");
  assert.deepEqual(W.researchResultToWait(res), { kind: "research", reason: "ALL_PROVIDERS_FAILED", resumeAt: null });
  const none = await createResearchRouter({ providers: {} }).research({ query: "x" });
  assert.equal(W.researchResultToWait(none), null);

  const { q } = setup();
  q.enqueue(REQ, { id: "a" });
  const c = q.claim({ workerId: "w1" });
  const w = W.researchResultToWait(res);
  assert.equal(q.wait("a", c.token, w).job.state, "WAITING_FOR_RESEARCH");
});

// ---------- revision ----------
test("NEEDS_REVISION: reviewer sends job back to the writer; metadata stored; pipeline resumes", () => {
  const { q } = setup();
  q.enqueue({ title: "Steelers sponsor deal", category: "sports" }, { id: "a" });
  for (let i = 0; i < 4; i++) step(q, "a"); // scout, director, research, writer
  assert.equal(q.get("a").stage, "fact_checker");
  const c = q.claim({ workerId: "w1" });
  assert.equal(c.job.assignedTo, "uzayr");
  assert.equal(q.requestRevision("a", c.token, { targetStage: "fact_checker", reason: "x" }).reason, "INVALID_REVISION_TARGET");
  assert.equal(q.requestRevision("a", c.token, { targetStage: "cms_editor", reason: "x" }).reason, "INVALID_REVISION_TARGET");
  assert.equal(q.requestRevision("a", c.token, { targetStage: "writer", reason: " " }).reason, "INVALID_ARGUMENT");
  assert.equal(q.get("a").state, "IN_PROGRESS");

  const r = q.requestRevision("a", c.token, { targetStage: "writer", reason: "unsupported claim in paragraph 2", notes: "check the $4M figure" });
  assert.equal(r.job.state, "NEEDS_REVISION");
  assert.equal(r.job.stage, "writer");
  assert.equal(r.job.assignedTo, "zaydan");
  assert.equal(r.job.revision.count, 1);
  assert.equal(r.job.revision.current.fromStage, "fact_checker");
  assert.equal(r.job.revision.current.requestedBy, "uzayr");
  assert.equal(r.job.revision.current.reason, "unsupported claim in paragraph 2");
  assert.equal(q.getEligible()[0].id, "a");

  assert.equal(step(q, "a").stage, "fact_checker"); // writer redoes it, goes back through review
  const j = q.get("a");
  assert.equal(j.state, "QUEUED");
  assert.equal(j.revision.current, null);
  assert.equal(j.revision.count, 1);
});

test("revision can target the Research Editor", () => {
  const { q } = setup();
  q.enqueue(REQ, { id: "a" });
  for (let i = 0; i < 4; i++) step(q, "a");
  const c = q.claim({ workerId: "w1" });
  const r = q.requestRevision("a", c.token, { targetStage: "research_editor", reason: "need a second source" });
  assert.equal(r.job.assignedTo, "nawfal");
});

// ---------- employee handoff ----------
test("every pipeline stage resolves to exactly one existing employee profile", () => {
  const employees = W.loadEmployees();
  const job = W.createJob({ request: REQ, now: T0 });
  const ids = W.STAGES.map((s) => W.resolveAssignee(job, s.id, employees));
  assert.deepEqual(ids, ["thurayya", "maysam", "nawfal", "riham", "uzayr", "jumana", "salsabil", "maysoon"]);
  for (const id of ids) assert.ok(employees.has(id));
});

test("writer routing by category, and director override", () => {
  for (const [category, writer] of [["sports", "zaydan"], ["food", "riham"], ["general", "lubna"], [undefined, "lubna"]]) {
    const { q } = setup();
    q.enqueue({ title: "T", category }, { id: "a" });
    step(q, "a"); step(q, "a"); step(q, "a");
    assert.equal(q.get("a").assignedTo, writer, String(category));
  }
  const { q } = setup();
  q.enqueue({ title: "T", category: "sports" }, { id: "a" });
  step(q, "a");
  step(q, "a", "w1", { writerId: "lubna" });
  step(q, "a");
  assert.equal(q.get("a").assignedTo, "lubna");

  const { q: q2 } = setup();
  q2.enqueue(REQ, { id: "b" });
  step(q2, "b");
  const c = q2.claim({ workerId: "w", jobId: "b" });
  assert.equal(q2.complete("b", c.token, { writerId: "nawfal" }).reason, "INVALID_WRITER"); // director stage, but not a writer
  q2.release("b", c.token);
  const c0 = q2.claim({ workerId: "w", jobId: "b" });
  q2.release("b", c0.token);
  // writer can only be assigned at the director stage
  const { q: q3 } = setup();
  q3.enqueue(REQ, { id: "c" });
  const s = q3.claim({ workerId: "w" });
  assert.equal(q3.complete("c", s.token, { writerId: "zaydan" }).reason, "WRITER_ASSIGNMENT_NOT_ALLOWED");
});

test("full handoff: scout -> director -> research -> writer -> fact checker -> standards -> source -> CMS -> HUMAN_REVIEW", () => {
  const { q } = setup();
  q.enqueue({ title: "Local food hall opens", category: "food" }, { id: "a" });
  const seen = [];
  const states = [];
  for (let i = 0; i < 8; i++) {
    const c = q.claim({ workerId: "w1" });
    assert.equal(c.ok, true);
    seen.push(c.job.assignedTo);
    const r = q.complete("a", c.token, { output: { stage: c.job.stage, placeholder: true } });
    states.push(r.job.state);
  }
  assert.deepEqual(seen, ["thurayya", "maysam", "nawfal", "riham", "uzayr", "jumana", "salsabil", "maysoon"]);
  assert.deepEqual(states, ["QUEUED", "QUEUED", "QUEUED", "QUEUED", "QUEUED", "QUEUED", "READY_FOR_CMS", "HUMAN_REVIEW"]);
  const j = q.get("a");
  assert.equal(j.state, "HUMAN_REVIEW");
  assert.equal(j.stage, null);
  assert.equal(j.assignedTo, null);
  assert.equal(j.claim, null);
  assert.deepEqual(Object.keys(j.data), ["news_scout", "news_director", "research_editor", "writer", "fact_checker", "standards_editor", "source_editor", "cms_editor"]);
  const path = j.history.map((h) => h.to);
  assert.ok(path.includes("READY_FOR_CMS") && path.includes("CMS_DRAFT"));
  assert.equal(path[path.length - 1], "HUMAN_REVIEW");
  assert.ok(!path.includes("HUMAN_APPROVED") && !path.includes("HUMAN_REJECTED"));
});

// ---------- stopping at HUMAN_REVIEW ----------
function toHumanReview(q, id = "a", req = REQ) {
  q.enqueue(req, { id });
  for (let i = 0; i < 8; i++) step(q, id);
  return q.get(id);
}

test("automation stops at HUMAN_REVIEW: nothing is claimable and no worker op can move the job", () => {
  const { q, clock } = setup();
  assert.equal(toHumanReview(q).state, "HUMAN_REVIEW");
  clock.t += 30 * 24 * 3600 * 1000;
  assert.deepEqual(q.getEligible({ limit: 10 }), []);
  assert.equal(q.claim({ workerId: "w" }).reason, "NO_ELIGIBLE_JOB");
  assert.equal(q.claim({ workerId: "w", jobId: "a" }).reason, "NOT_ELIGIBLE");
  assert.equal(q.complete("a", "t").reason, "NOT_CLAIMED");
  assert.equal(q.release("a", "t").reason, "NOT_CLAIMED");
  assert.equal(q.get("a").state, "HUMAN_REVIEW");
});

test("only an explicit human decision leaves HUMAN_REVIEW; automation actors are refused", () => {
  const { q } = setup();
  toHumanReview(q);
  for (const actor of [undefined, { type: "worker", id: "w" }, { type: "system", id: "workflow" }]) {
    assert.equal(q.humanDecision("a", { decision: "approve", actor }).reason, "HUMAN_ACTOR_REQUIRED");
  }
  assert.equal(q.humanDecision("a", { decision: "maybe", actor: human }).reason, "INVALID_ARGUMENT");
  assert.equal(q.get("a").state, "HUMAN_REVIEW");
  const r = q.humanDecision("a", { decision: "reject", actor: human });
  assert.equal(r.job.state, "HUMAN_REJECTED");
  assert.equal(q.humanDecision("a", { decision: "approve", actor: human }).reason, "INVALID_TRANSITION"); // terminal
  const { q: q2 } = setup();
  toHumanReview(q2);
  assert.equal(q2.humanDecision("a", { decision: "approve", actor: human }).job.state, "HUMAN_APPROVED");
  assert.equal(q2.humanDecision("nope", { decision: "approve", actor: human }).reason, "NOT_FOUND");
});

test("running the workflow does not touch the 3-article/24h limiter or write any other state", () => {
  const { q, store } = setup();
  toHumanReview(q, "a");
  toHumanReview(q, "b");
  toHumanReview(q, "c");
  toHumanReview(q, "d");
  assert.deepEqual(store.listFiles(), ["workflow/jobs.json"]);
  const status = getWindowStatus(store);
  assert.equal(status.activeInWindow, 0);
  assert.equal(status.remaining, 3);
  assert.equal(q.list({ state: "HUMAN_REVIEW" }).length, 4); // a 4th job is fine: the limiter is not consumed here
});
