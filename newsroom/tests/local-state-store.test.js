"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { LocalStateStore } = require("../local-state-store");
const { reserveSlot, completeSlot, getWindowStatus } = require("../limiter");
const { createModelRegistry } = require("../ai/registry");
const config = require("../config");

test("LocalStateStore mirrors GitStateStore semantics: stale writers are rejected until they refresh", () => {
  const a = new LocalStateStore();
  const b = a.sibling();
  assert.deepEqual(a.writeAtomic({ "x.json": { n: 1 } }, "a"), { ok: true });
  assert.deepEqual(b.writeAtomic({ "x.json": { n: 2 } }, "b"), { ok: false, conflict: true });
  b.refresh();
  assert.deepEqual(b.read("x.json"), { n: 1 });
  assert.equal(b.writeAtomic({ "x.json": { n: 2 } }, "b").ok, true);
  assert.equal(a.read("x.json").n, 1);      // a has not refreshed
  assert.equal(b.read("nope.json", "fb"), "fb");
});

test("the existing limiter runs unchanged on LocalStateStore (interface parity; private store, no shared slots)", () => {
  const store = new LocalStateStore();
  const ids = [reserveSlot(store, 3), reserveSlot(store, 3), reserveSlot(store, 3)];
  assert.ok(ids.every((r) => r.reserved));
  assert.equal(reserveSlot(store, 3).reason, "LIMIT_REACHED");
  assert.equal(completeSlot(store, ids[0].reservationId).ok, true);
  assert.equal(getWindowStatus(store, 3).activeInWindow, 3);
});

// Updated in Phase 3 / Step 1: the production allowlist is now the evidence-derived list (no placeholder entry any more).
// Intent preserved: no placeholder is ever usable, and with no overrides passed no local limits are invented.
// (Placeholder rejection itself is still covered in router.test.js; published limits are covered in free-models.test.js.)
test("production allowlist from config.js: has no placeholder/invalid entries; no local limits are invented without overrides", () => {
  const reg = createModelRegistry({ allowedFreeModels: config.ALLOWED_FREE_MODELS });
  assert.ok(reg.list().length >= 1);
  assert.deepEqual(reg.issues, []);
  assert.ok(!config.ALLOWED_FREE_MODELS.some((k) => /placeholder/i.test(k)));
  assert.ok(reg.list().every((e) => Object.values(e.limits).every((v) => v === null)));
});
