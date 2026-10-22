// Router operational state on top of the Phase-2 state-store abstraction
// (read / refresh / writeAtomic). One file per provider: quota-<provider>.json — matching
// the Phase 1 layout for `newsroom-state`. Writes are optimistic: on conflict we refresh,
// re-read, and RE-APPLY the mutation (the mutator may veto, e.g. if capacity vanished),
// exactly like the article limiter does.
// If the store itself errors, the router degrades to an in-process cache (and logs it)
// rather than failing the request; a real 429 from a provider is still the primary signal.
"use strict";
const { emptyProviderState } = require("./quota");

const clone = (v) => JSON.parse(JSON.stringify(v));

class RouterState {
  constructor(store, { maxRetries = 5, logger = null } = {}) {
    this.store = store;
    this.maxRetries = maxRetries;
    this.logger = logger;
    this.cache = new Map();       // provider -> last known provider state
    this.degraded = false;
  }
  static fileFor(provider) { return `quota-${provider}.json`; }

  _warn(event, e) { this.degraded = true; if (this.logger) this.logger.warn(event, { message: String(e && e.message || e) }); }

  refresh() {
    try { this.store.refresh(); } catch (e) { this._warn("state_store_refresh_failed", e); }
  }
  read(provider) {
    try {
      const ps = this.store.read(RouterState.fileFor(provider), null);
      if (ps) { this.cache.set(provider, clone(ps)); return ps; }
    } catch (e) { this._warn("state_store_read_failed", e); }
    return this.cache.has(provider) ? clone(this.cache.get(provider)) : emptyProviderState(provider);
  }

  // fn(ps) -> { commit: boolean, result: any }. Returns { committed, result, state }.
  mutate(provider, fn, message) {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let ps;
      try { this.store.refresh(); ps = this.store.read(RouterState.fileFor(provider), null); }
      catch (e) { this._warn("state_store_read_failed", e); return this._mutateCache(provider, fn); }
      ps = ps || emptyProviderState(provider);
      const out = fn(ps);
      if (!out.commit) return { committed: false, result: out.result, state: ps };
      let res;
      try { res = this.store.writeAtomic({ [RouterState.fileFor(provider)]: ps }, message || `router state ${provider}`); }
      catch (e) { this._warn("state_store_write_failed", e); return this._mutateCache(provider, fn); }
      if (res.ok) { this.cache.set(provider, clone(ps)); return { committed: true, result: out.result, state: ps }; }
    }
    this._warn("state_store_conflict_retries_exhausted", new Error(provider));
    return this._mutateCache(provider, fn);
  }
  _mutateCache(provider, fn) {
    const ps = this.cache.has(provider) ? clone(this.cache.get(provider)) : emptyProviderState(provider);
    const out = fn(ps);
    if (out.commit) this.cache.set(provider, clone(ps));
    return { committed: false, degraded: true, result: out.result, state: ps };
  }
}

module.exports = { RouterState };
