// Git-backed state store for the `newsroom-state` branch.
// A rejected (non-fast-forward) push IS the "another writer got there first"
// signal — no separate lock server. Callers refresh() and retry on conflict.
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { CODES, classifyGitError, annotate } = require("./git-errors");

class GitStateStore {
  // options (Phase 3 / Step 4, both backward compatible):
  //   env              extra environment for git only (e.g. GIT_CONFIG_* auth header) so no credential is ever put in the
  //                    remote URL, a command line, .git/config or an error message.
  //   createIfMissing  default true (unchanged). false = never create the state branch; a missing branch is an error.
  //   timeoutMs        (Phase 3 / Step 5) per-git-command timeout so a hung network call cannot stall a run (default 120000).
  constructor(remoteUrl, branch = "newsroom-state", { env = {}, createIfMissing = true, timeoutMs = 120000 } = {}) {
    this.remoteUrl = remoteUrl;
    this.timeoutMs = timeoutMs;
    this.branch = branch;
    this.createIfMissing = createIfMissing;
    this._env = { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    this.workdir = fs.mkdtempSync(path.join(os.tmpdir(), "newsroom-state-"));
    try {
      this._git(["init", "-q"]);
      this._git(["config", "user.email", "newsroom-bot@local"]);
      this._git(["config", "user.name", "Newsroom State Bot"]);
      this._git(["remote", "add", "origin", this.remoteUrl]);
      this._ensureBranchExists();
    } catch (e) { this.cleanup(); throw annotate(e); }
  }
  _git(args) { return execFileSync("git", args, { cwd: this.workdir, encoding: "utf8", env: this._env, timeout: this.timeoutMs, stdio: ["ignore", "pipe", "pipe"] }); }
  _ensureBranchExists() {
    try {
      this._git(["fetch", "origin", this.branch]);
      this._git(["checkout", "-B", this.branch, `origin/${this.branch}`]);
    } catch (e) {
      // Only "the branch does not exist" may fall through to creation. Auth, network or other failures must surface,
      // never be mistaken for an absent branch.
      if (!/couldn't find remote ref/i.test(String(e.stderr || e.message))) throw e;
      if (!this.createIfMissing) throw annotate(new Error(`state branch "${this.branch}" does not exist on the remote and creation is disabled`), CODES.REF_MISSING);
      this._git(["checkout", "--orphan", this.branch]);
      this._git(["rm", "-rf", "--ignore-unmatch", "."]);
      fs.writeFileSync(path.join(this.workdir, ".gitkeep"), "");
      this._git(["add", ".gitkeep"]);
      this._git(["commit", "-q", "-m", "init newsroom-state branch"]);
      this._git(["push", "-u", "origin", this.branch]);
    }
  }
  read(relPath, fallback = null) {
    const full = path.join(this.workdir, relPath);
    if (!fs.existsSync(full)) return fallback;
    return JSON.parse(fs.readFileSync(full, "utf8"));
  }
  refresh() {
    try {
      this._git(["fetch", "origin", this.branch]);
      this._git(["reset", "--hard", `origin/${this.branch}`]);
    } catch (e) { throw annotate(e); }
  }
  // Tracked file paths at the current HEAD (read-only; used to verify the branch holds state only).
  listFiles() { return this._git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean); }
  writeAtomic(files, commitMessage) {
    for (const [relPath, data] of Object.entries(files)) {
      const full = path.join(this.workdir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, JSON.stringify(data, null, 2));
      this._git(["add", relPath]);
    }
    this._git(["commit", "-q", "-m", commitMessage, "--allow-empty"]);
    try {
      this._git(["push", "origin", this.branch]);
      return { ok: true };
    } catch (e) {
      this._git(["reset", "--hard", "HEAD~1"]);
      // Only a non-fast-forward rejection means "another writer got there first". Authentication, permission, protection-rule,
      // network and timeout failures must surface as errors -- never be retried as if they were ordinary conflicts.
      if (classifyGitError(e) === CODES.PUSH_REJECTED_NON_FF) return { ok: false, conflict: true };
      throw annotate(e);
    }
  }
  cleanup() { fs.rmSync(this.workdir, { recursive: true, force: true }); }
}
module.exports = { GitStateStore };
