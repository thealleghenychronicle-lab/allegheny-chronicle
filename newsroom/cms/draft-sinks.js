// Where CMS draft files go. Dry-run/offline only: memory or a local scratch directory.
// A sink NEVER writes to content/articles (guarded), never touches git, and refuses any file whose frontmatter is not draft:true.
"use strict";
const fs = require("fs");
const path = require("path");
const { assertDraftTrue } = require("./markdown");
const { ArticleError } = require("./article");

const FILE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
function checkName(filename) {
  if (!FILE_RE.test(filename)) throw new ArticleError("INVALID_FILENAME", `unsafe draft filename: ${filename}`);
}

class MemoryDraftSink {
  constructor() { this.files = new Map(); this.failNext = 0; }
  get(slug) { const f = this.files.get(`${slug}.md`); return f ? { filename: `${slug}.md`, content: f.content, meta: { ...f.meta } } : null; }
  write(filename, content, meta = {}) {
    checkName(filename); assertDraftTrue(content);
    if (this.failNext > 0) { this.failNext -= 1; throw new Error("simulated draft write failure"); }
    if (this.files.has(filename)) throw new ArticleError("DRAFT_EXISTS", `draft already exists: ${filename}`);
    this.files.set(filename, { content, meta: { ...meta } });
    return { filename };
  }
  list() { return [...this.files.keys()].sort(); }
}

class DirDraftSink {
  constructor(dir) {
    this.dir = path.resolve(dir);
    const norm = this.dir.split(path.sep).join("/");
    if (/(^|\/)content\/articles(\/|$)/.test(norm)) throw new ArticleError("FORBIDDEN_DIRECTORY", "refusing to write drafts into content/articles (dry-run only)");
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, ".drafts-index.json");
  }
  _index() { try { return JSON.parse(fs.readFileSync(this.indexPath, "utf8")); } catch (_) { return {}; } }
  get(slug) {
    const filename = `${slug}.md`; checkName(filename);
    const p = path.join(this.dir, filename);
    if (!fs.existsSync(p)) return null;
    return { filename, content: fs.readFileSync(p, "utf8"), meta: this._index()[filename] || {} };
  }
  write(filename, content, meta = {}) {
    checkName(filename); assertDraftTrue(content);
    const p = path.join(this.dir, filename);
    if (fs.existsSync(p)) throw new ArticleError("DRAFT_EXISTS", `draft already exists: ${filename}`);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, content, "utf8"); fs.renameSync(tmp, p);
    const idx = this._index(); idx[filename] = meta;
    fs.writeFileSync(this.indexPath, JSON.stringify(idx, null, 2) + "\n", "utf8");
    return { filename };
  }
  list() { return fs.readdirSync(this.dir).filter((f) => f.endsWith(".md")).sort(); }
}

module.exports = { MemoryDraftSink, DirDraftSink };
