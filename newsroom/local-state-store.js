// Sandbox-safe state store with the SAME interface as GitStateStore (read / refresh /
// writeAtomic / cleanup). Used for tests and dry-run. It never touches git, GitHub, or disk.
// Multiple "workers" can share one backing so optimistic-concurrency conflicts can be tested,
// mirroring the git push-rejection behaviour of the real store.
"use strict";

const clone = (v) => JSON.parse(JSON.stringify(v));

class LocalStateBacking {
  constructor() { this.version = 0; this.files = new Map(); this.commits = []; }
}

class LocalStateStore {
  constructor({ backing = new LocalStateBacking() } = {}) {
    this.backing = backing;
    this.snapshotVersion = -1;
    this.snapshot = new Map();
    this.refresh();
  }
  read(relPath, fallback = null) {
    return this.snapshot.has(relPath) ? clone(this.snapshot.get(relPath)) : fallback;
  }
  refresh() {
    this.snapshotVersion = this.backing.version;
    this.snapshot = new Map([...this.backing.files].map(([k, v]) => [k, clone(v)]));
  }
  writeAtomic(files, commitMessage) {
    if (this.snapshotVersion !== this.backing.version) return { ok: false, conflict: true };
    const staged = {};
    for (const [relPath, data] of Object.entries(files)) staged[relPath] = clone(data); // must be JSON-serializable
    for (const [relPath, data] of Object.entries(staged)) this.backing.files.set(relPath, data);
    this.backing.version += 1;
    this.backing.commits.push(commitMessage);
    this.refresh();
    return { ok: true };
  }
  // Another worker's view of the same backing (for concurrency tests).
  sibling() { return new LocalStateStore({ backing: this.backing }); }
  listFiles() { return [...this.backing.files.keys()]; }
  cleanup() {}
}

module.exports = { LocalStateStore, LocalStateBacking };
