// Rolling 3-article/24-hour limiter with two-phase reservation.
// See project handoff doc for why this is two-phase (state on a separate
// branch from the production draft commit means no single atomic commit
// can span both) rather than a single-commit guarantee.
"use strict";
const crypto = require("crypto");
const WINDOW_MS = 24 * 60 * 60 * 1000;
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRIES = 5;
const TIMESTAMPS_FILE = "article-timestamps.json";

function activeCount(entries, now) {
  return entries.filter((e) => {
    if (e.status === "released") return false;
    if (e.status === "completed") return now - e.reservedAt < WINDOW_MS;
    if (e.status === "pending") return now - e.reservedAt < PENDING_TIMEOUT_MS;
    return false;
  }).length;
}

function reserveSlot(store, maxPerWindow = 3, nowFn = Date.now) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    store.refresh();
    const state = store.read(TIMESTAMPS_FILE, { entries: [] });
    const now = nowFn();
    const active = activeCount(state.entries, now);
    if (active >= maxPerWindow) {
      return { reserved: false, reason: "LIMIT_REACHED", remaining: 0, active };
    }
    const reservationId = crypto.randomUUID();
    const newEntry = { id: reservationId, status: "pending", reservedAt: now };
    const updated = { entries: [...state.entries, newEntry] };
    const result = store.writeAtomic({ [TIMESTAMPS_FILE]: updated }, `reserve slot (pending) ${reservationId}`);
    if (result.ok) {
      return { reserved: true, reservationId, remaining: maxPerWindow - (active + 1) };
    }
  }
  return { reserved: false, reason: "CONCURRENCY_RETRY_EXHAUSTED", remaining: 0 };
}

function _updateEntryStatus(store, reservationId, newStatus) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    store.refresh();
    const state = store.read(TIMESTAMPS_FILE, { entries: [] });
    const idx = state.entries.findIndex((e) => e.id === reservationId);
    if (idx === -1) return { ok: false, reason: "RESERVATION_NOT_FOUND" };
    const entries = [...state.entries];
    entries[idx] = { ...entries[idx], status: newStatus };
    const result = store.writeAtomic({ [TIMESTAMPS_FILE]: { entries } }, `${newStatus} slot ${reservationId}`);
    if (result.ok) return { ok: true };
  }
  return { ok: false, reason: "CONCURRENCY_RETRY_EXHAUSTED" };
}

function completeSlot(store, reservationId) { return _updateEntryStatus(store, reservationId, "completed"); }
function releaseSlot(store, reservationId) { return _updateEntryStatus(store, reservationId, "released"); }

function getWindowStatus(store, maxPerWindow = 3, nowFn = Date.now) {
  store.refresh();
  const state = store.read(TIMESTAMPS_FILE, { entries: [] });
  const now = nowFn();
  const active = activeCount(state.entries, now);
  return { activeInWindow: active, remaining: Math.max(0, maxPerWindow - active), maxPerWindow, entries: state.entries };
}

// Earliest epoch-ms at which an active entry stops counting (i.e. when a slot could free up), or null if none active.
// Chunk 5 addition: lets a blocked CMS-draft step schedule its retry. Read-only.
function nextSlotAt(store, nowFn = Date.now) {
  store.refresh();
  const state = store.read(TIMESTAMPS_FILE, { entries: [] });
  const now = nowFn();
  const ends = state.entries.filter((e) => (e.status === "completed" && now - e.reservedAt < WINDOW_MS) || (e.status === "pending" && now - e.reservedAt < PENDING_TIMEOUT_MS))
    .map((e) => e.reservedAt + (e.status === "completed" ? WINDOW_MS : PENDING_TIMEOUT_MS));
  return ends.length ? Math.min(...ends) : null;
}

module.exports = { nextSlotAt, reserveSlot, completeSlot, releaseSlot, getWindowStatus, WINDOW_MS, PENDING_TIMEOUT_MS };
