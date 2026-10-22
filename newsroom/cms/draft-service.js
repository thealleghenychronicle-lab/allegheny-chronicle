// CMS draft creation + limiter wiring. This is the ONLY place the 3-new-drafts/rolling-24h limiter is consumed.
//   already exists for this job?  -> idempotent success, NO new slot (reconciles a pending reservation if needed)
//   reserve slot (pending)        -> LIMIT_REACHED => nothing written, retryAt returned
//   write draft                   -> throws      => releaseSlot (slot not consumed)
//   completeSlot                  -> consumed only now, after the draft exists
// Research, AI calls, reviews, retries and revisions never reach this module.
"use strict";
const limiter = require("../limiter");
const config = require("../config");
const { toCmsMarkdown } = require("./markdown");
const { ArticleError } = require("./article");

const COMPLETE_RETRIES = 3;

function createDraftService({ store, sink, now = Date.now, maxPerWindow = config.MAX_ARTICLES_PER_ROLLING_24H } = {}) {
  if (!store || !sink) throw new Error("store and sink are required");

  function completeWithRetry(reservationId) {
    let r = { ok: false, reason: "NOT_ATTEMPTED" };
    for (let i = 0; i < COMPLETE_RETRIES; i++) { r = limiter.completeSlot(store, reservationId); if (r.ok) return r; }
    return r;
  }

  // Create (or find) the CMS draft for `article`. Never throws for expected conditions.
  function createDraft(article, { reservationId: priorReservation = null } = {}) {
    let markdown;
    try { markdown = toCmsMarkdown(article); }
    catch (e) { return { ok: false, reason: e.code || "INVALID_ARTICLE", message: e.message, retryable: false }; }
    const filename = `${article.slug}.md`;

    const existing = sink.get(article.slug);
    if (existing) {
      if (article.jobId && existing.meta && existing.meta.jobId === article.jobId) {
        // Our own earlier draft (e.g. the job step failed after the draft was written). No new slot.
        const rid = (existing.meta && existing.meta.reservationId) || priorReservation;
        let reconciled = "NOT_NEEDED";
        if (rid) {
          const entry = (limiter.getWindowStatus(store, maxPerWindow, now).entries || []).find((e) => e.id === rid);
          if (entry && entry.status === "pending") reconciled = completeWithRetry(rid).ok ? "COMPLETED_PENDING" : "COMPLETE_FAILED";
        }
        return { ok: true, created: false, consumedSlot: false, filename, slug: article.slug, reservationId: rid || null, reconciled };
      }
      return { ok: false, reason: "DUPLICATE_SLUG", message: `a different draft already uses slug "${article.slug}"`, retryable: false };
    }

    const res = limiter.reserveSlot(store, maxPerWindow, now);
    if (!res.reserved) {
      const retryAt = res.reason === "LIMIT_REACHED" ? limiter.nextSlotAt(store, now) : null;
      return { ok: false, reason: res.reason, message: "no CMS draft slot available", retryable: true, retryAt, consumedSlot: false };
    }

    try {
      sink.write(filename, markdown, { jobId: article.jobId, reservationId: res.reservationId, createdAt: new Date(now()).toISOString() });
    } catch (e) {
      const rel = limiter.releaseSlot(store, res.reservationId);
      return { ok: false, reason: "DRAFT_WRITE_FAILED", message: e && e.message ? e.message : String(e), retryable: !(e instanceof ArticleError),
        consumedSlot: false, released: rel.ok, reservationId: res.reservationId,
        // If release itself failed the entry stays `pending` and the limiter's own 5-minute pending timeout frees it.
        reconciled: rel.ok ? "RELEASED" : "RELEASE_FAILED_WILL_EXPIRE" };
    }

    const done = completeWithRetry(res.reservationId);
    return { ok: true, created: true, consumedSlot: done.ok, filename, slug: article.slug, reservationId: res.reservationId,
      // Draft exists but slot still `pending`: a later createDraft for the same job completes it (reconciliation) if within the pending window.
      reconciled: done.ok ? "COMPLETED" : "COMPLETE_FAILED", slotsRemaining: res.remaining };
  }

  return { createDraft, status: () => limiter.getWindowStatus(store, maxPerWindow, now) };
}

module.exports = { createDraftService };
