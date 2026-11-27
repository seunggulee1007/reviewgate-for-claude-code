// MARK: ide-nav — docs/PROTOCOL.md §65: the open worktree's symbols in memory — built on first use (never at the session's
// start), refreshed file by file (mtime + size) after a turn's collection and on demand, searched fuzzily for ⌘T.
import { readFile, stat } from "node:fs/promises";
import { runGit } from "../git/exec.js";
import { repoRelativeInside } from "../platform/paths.js";
import type { DocumentSymbol, NavIndexState, WorkspaceSymbol } from "../protocol.js";
import { readProjectFile } from "./browse.js";
import { MINIFIED, TESTISH, VENDOR } from "./navigate.js";
import { extractSymbols, FILE_SYMBOLS_MAX, isTypeKind, languageOf, symbolLang, type FileSymbol } from "./symbols.js";

/** A larger file is not indexed (generated code, a bundle). */
export const INDEX_FILE_MAX_BYTES = 1024 * 1024;
/** The index holds at most this many symbols (then `truncated`). */
export const INDEX_SYMBOLS_MAX = 300_000;
/** A build reads files for at most this long (then `truncated`; what was read is the index). */
export const INDEX_BUILD_BUDGET_MS = 60_000;
/** `workspace_symbols` default and cap of `limit`. */
export const WORKSPACE_DEFAULT_LIMIT = 100;
export const WORKSPACE_MAX_LIMIT = 500;
/** While the first build runs, `workspace_symbols` waits this long for it before it answers from what is indexed so far. */
export const WORKSPACE_WAIT_MS = 2_000;
/** A query re-checks the files' mtimes in the background when the last check is older than this. */
export const INDEX_RECHECK_MS = 30_000;
/** Folders never indexed, at any depth. */
export const INDEX_EXCLUDED_DIRS = new Set(["node_modules", "bower_components", "build", "dist", "out", "target", ".gradle", "vendor", "third_party",
  "Pods", "DerivedData", "generated", ".next", ".nuxt", ".output", "coverage", ".git", ".idea", ".vscode", ".svn", "__pycache__", ".venv", "venv"]);
const PROGRESS_EVERY_MS = 300;
const READ_BATCH = 16;

type Entry = { mtimeMs: number; size: number; symbols: FileSymbol[] };

/** Whether the index reads `path` (a language of §62 other than `.tld`, outside the excluded folders, not minified). */
export function indexable(path: string): boolean {
  const lang = symbolLang(path);
  if (!lang || lang === "tld" || MINIFIED.test(path)) return false;
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (INDEX_EXCLUDED_DIRS.has(parts[i]!)) return false;
  return true;
}

export type SymbolIndexOptions = {
  root: string;
  /** The state changed (status, counts); throttled while building. */
  onChange: () => void;
  /** The worktree's files (tracked + untracked, not ignored); default `git ls-files` (§59's hidden repository too). */
  listFiles?: () => Promise<string[]>;
  budgetMs?: number;
  maxSymbols?: number;
  now?: () => number;
};

export class SymbolIndex {
  private files = new Map<string, Entry>();
  private symbolCount = 0;
  private status: NavIndexState["status"] = "idle";
  private truncated = false;
  private builtAt: string | null = null;
  private durationMs: number | undefined;
  private error: string | undefined;
  private filesTotal: number | undefined;
  private running: Promise<void> | null = null;
  private want = { sweep: false, full: false, paths: new Set<string>() };
  private generation = 0;
  private lastSweepAt = 0;
  private lastProgressAt = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly opts: SymbolIndexOptions) {
    this.now = opts.now ?? Date.now;
  }

  get state(): NavIndexState {
    return {
      status: this.status, files: this.files.size, symbols: this.symbolCount, truncated: this.truncated, builtAt: this.builtAt,
      ...(this.status === "building" && this.filesTotal !== undefined ? { filesTotal: this.filesTotal } : {}),
      ...(this.durationMs !== undefined ? { durationMs: this.durationMs } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Ends every build; the index answers nothing more (the project closed). */
  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** `nav_index_build`: `full` drops what is indexed and reads every file again; otherwise only files whose mtime / size changed. */
  build(full: boolean): Promise<void> {
    if (full) {
      this.want.full = true;
      this.generation++; // a build that runs stops at its next file
    }
    this.want.sweep = true;
    return this.kick();
  }

  /**
   * After a turn's collection, a refresh, a branch switch or a rewind: re-reads `paths` (repo-relative), or every file whose
   * mtime / size changed when none are given — 300 ms later, coalesced. Nothing before the first build.
   */
  refresh(paths?: readonly string[]): void {
    if (this.stopped || this.status === "idle") return;
    if (paths) for (const p of paths) this.want.paths.add(p);
    else this.want.sweep = true;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.kick().catch(() => undefined);
    }, 300);
    this.refreshTimer.unref?.();
  }

  /** The first build when none ran (or the last failed); a background re-check when the last is older than 30 s. */
  ensure(): Promise<void> {
    if (this.status === "idle" || this.status === "failed" || this.now() - this.lastSweepAt > INDEX_RECHECK_MS) this.want.sweep = true;
    return this.kick();
  }

  /** The symbols of one indexed file (fresh: re-read when its mtime / size changed), null for a file the index does not read. */
  async fileSymbols(path: string): Promise<FileSymbol[] | null> {
    if (!symbolLang(path)) return null;
    const rel = repoRelativeInside(this.opts.root, path);
    if (rel === null) return null;
    try {
      const st = await stat(`${this.opts.root}/${rel}`);
      if (!st.isFile() || st.size > INDEX_FILE_MAX_BYTES) return null;
      const had = this.files.get(rel);
      if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had.symbols;
      const symbols = extractSymbols(rel, await readFile(`${this.opts.root}/${rel}`, "utf8"));
      if (indexable(rel)) this.put(rel, { mtimeMs: st.mtimeMs, size: st.size, symbols });
      return symbols;
    } catch {
      return null;
    }
  }

  /** `document_symbols`: the outline of one file, read now (§47's checks; refusals as `project_file`'s). */
  async documentSymbols(path: unknown): Promise<{ path: string; language: string; symbols: DocumentSymbol[]; truncated: boolean }> {
    const file = readProjectFile(this.opts.root, path);
    if (file.isBinary) return { path: file.path, language: languageOf(file.path), symbols: [], truncated: false };
    const symbols = extractSymbols(file.path, file.lines.join("\n"));
    if (indexable(file.path) && !file.truncated && file.size <= INDEX_FILE_MAX_BYTES) {
      try {
        const st = await stat(`${this.opts.root}/${file.path}`);
        this.put(file.path, { mtimeMs: st.mtimeMs, size: st.size, symbols });
      } catch {
        // gone meanwhile: the outline still answers
      }
    }
    return {
      path: file.path, language: languageOf(file.path),
      symbols: symbols.map((s) => ({ ...s, path: file.path })),
      truncated: file.truncated || symbols.length >= FILE_SYMBOLS_MAX,
    };
  }

  /** `workspace_symbols`: the best `limit` matches of `query` (see `rankSymbols`); the first build is waited for ≤ 2 s. */
  async search(query: unknown, limit: unknown, waitMs = WORKSPACE_WAIT_MS): Promise<{ query: string; symbols: WorkspaceSymbol[]; truncated: boolean; index: NavIndexState }> {
    const q = typeof query === "string" ? query.trim().slice(0, 200) : "";
    const n = typeof limit === "number" && Number.isFinite(limit) && limit >= 1 ? Math.min(WORKSPACE_MAX_LIMIT, Math.floor(limit)) : WORKSPACE_DEFAULT_LIMIT;
    const run = this.ensure();
    if (this.status !== "ready") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run.catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
      clearTimeout(timer);
    }
    const { symbols, truncated } = rankSymbols(this.entries(), q, n);
    return { query: q, symbols, truncated, index: this.state };
  }

  private *entries(): Iterable<[string, FileSymbol[]]> {
    for (const [path, e] of this.files) yield [path, e.symbols];
  }

  private put(path: string, e: Entry): boolean {
    const had = this.files.get(path);
    const delta = e.symbols.length - (had?.symbols.length ?? 0);
    if (delta > 0 && this.symbolCount + delta > (this.opts.maxSymbols ?? INDEX_SYMBOLS_MAX)) {
      this.truncated = true;
      return false;
    }
    this.files.set(path, e);
    this.symbolCount += delta;
    return true;
  }

  private drop(path: string): void {
    const had = this.files.get(path);
    if (!had) return;
    this.files.delete(path);
    this.symbolCount -= had.symbols.length;
  }

  private kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) {
      this.running = this.loop().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped && (this.want.sweep || this.want.paths.size > 0)) {
      const { sweep, full, paths } = this.want;
      this.want = { sweep: false, full: false, paths: new Set() };
      if (sweep) await this.sweep(full);
      else await this.readPaths([...paths]);
    }
  }

  private progress(force = false): void {
    const t = this.now();
    if (!force && t - this.lastProgressAt < PROGRESS_EVERY_MS) return;
    this.lastProgressAt = t;
    this.opts.onChange();
  }

  /** Lists the worktree's files, drops what is gone, (re-)reads what is new or changed — the first build and every re-check. */
  private async sweep(full: boolean): Promise<void> {
    const gen = this.generation;
    const started = this.now();
    const loud = full || this.status !== "ready"; // a re-check of a ready index stays `ready`
    if (full) {
      this.files.clear();
      this.symbolCount = 0;
    }
    if (loud) {
      this.status = "building";
      this.truncated = false;
      this.error = undefined;
      this.filesTotal = undefined;
      this.progress(true);
    }
    let list: string[];
    try {
      list = (await (this.opts.listFiles ?? (() => gitFiles(this.opts.root)))()).filter(indexable);
    } catch (e) {
      if (gen !== this.generation) return;
      if (loud) {
        this.status = "failed";
        this.error = String((e as Error).message ?? e).split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "failed";
        this.progress(true);
      }
      return;
    }
    if (gen !== this.generation) return;
    this.filesTotal = list.length;
    const keep = new Set(list);
    for (const p of [...this.files.keys()]) if (!keep.has(p)) this.drop(p);
    let cut = false;
    const budget = this.opts.budgetMs ?? INDEX_BUILD_BUDGET_MS;
    for (let i = 0; i < list.length; i += READ_BATCH) {
      if (gen !== this.generation || this.stopped) return;
      if (this.now() - started > budget) {
        cut = true;
        break;
      }
      if (!(await this.readBatch(list.slice(i, i + READ_BATCH)))) {
        cut = true;
        break;
      }
      if (loud) this.progress();
    }
    if (gen !== this.generation) return;
    this.truncated = cut || (this.truncated && !loud);
    this.status = "ready";
    this.lastSweepAt = this.now();
    if (loud) {
      this.builtAt = new Date(this.now()).toISOString();
      this.durationMs = this.now() - started;
    }
    this.progress(true);
  }

  private async readPaths(paths: string[]): Promise<void> {
    const rels = paths.map((p) => repoRelativeInside(this.opts.root, p)).filter((p): p is string => p !== null && indexable(p));
    for (let i = 0; i < rels.length; i += READ_BATCH) await this.readBatch(rels.slice(i, i + READ_BATCH));
    this.progress(true);
  }

  /** Reads the files of one batch whose mtime / size changed (a missing or too large one leaves the index); false at the symbol cap. */
  private async readBatch(batch: string[]): Promise<boolean> {
    const read = await Promise.all(batch.map(async (rel) => {
      try {
        const st = await stat(`${this.opts.root}/${rel}`);
        if (!st.isFile() || st.size > INDEX_FILE_MAX_BYTES) return { rel, gone: true as const };
        const had = this.files.get(rel);
        if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return null;
        const buf = await readFile(`${this.opts.root}/${rel}`);
        if (buf.subarray(0, 8192).includes(0)) return { rel, gone: true as const };
        return { rel, st, text: buf.toString("utf8") };
      } catch {
        return { rel, gone: true as const };
      }
    }));
    for (const r of read) {
      if (!r) continue;
      if ("gone" in r) {
        this.drop(r.rel);
        continue;
      }
      if (!this.put(r.rel, { mtimeMs: r.st.mtimeMs, size: r.st.size, symbols: extractSymbols(r.rel, r.text) })) return false;
    }
    return true;
  }
}

export async function gitFiles(root: string): Promise<string[]> {
  const out = await runGit(root, ["-c", "submodule.recurse=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { timeoutMs: 30_000 });
  return [...new Set(out.text.split("\0").filter(Boolean))];
}

// ---------------------------------------------------------------- fuzzy matching and ranking

/** Offsets where the words of an identifier start: 0, a capital after a lower-case letter or digit, the last capital of a run before a lower-case one, after `_ $ - .`, a digit run. */
export function wordStarts(name: string): number[] {
  const starts: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    const p = i > 0 ? name[i - 1]! : "";
    const n = name[i + 1] ?? "";
    if (c === "_" || c === "$" || c === "-" || c === ".") continue;
    const isUp = c >= "A" && c <= "Z";
    const isDigit = c >= "0" && c <= "9";
    if (i === 0 || p === "_" || p === "$" || p === "-" || p === ".") starts.push(i);
    else if (isUp && !(p >= "A" && p <= "Z")) starts.push(i);
    else if (isUp && n >= "a" && n <= "z") starts.push(i);
    else if (isDigit && !(p >= "0" && p <= "9")) starts.push(i);
  }
  return starts;
}

/**
 * camelCase-hump match: the query split before each capital (and at `_`) — `UsrSvc` → `Usr` `Svc`, `uS` → `u` `S` — each
 * part's first character at the start of a word of `name` (in order, words may be skipped), its other characters in order
 * within that word. Case-insensitive. The matched offsets, or null.
 */
export function humpMatch(q: string, name: string): number[] | null {
  const parts = q.split(/(?=[A-Z])|_+/).filter(Boolean);
  if (parts.length === 0) return null;
  const starts = wordStarts(name);
  const lower = name.toLowerCase();
  const ends = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1]! : name.length));
  const go = (pi: number, wi: number): number[] | null => {
    if (pi === parts.length) return [];
    const part = parts[pi]!.toLowerCase();
    for (let w = wi; w < starts.length; w++) {
      const s = starts[w]!;
      if (lower[s] !== part[0]) continue;
      const pos = [s];
      let j = 1;
      for (let k = s + 1; k < ends[w]! && j < part.length; k++) if (lower[k] === part[j]) {
        pos.push(k);
        j++;
      }
      if (j < part.length) continue;
      const rest = go(pi + 1, w + 1);
      if (rest) return [...pos, ...rest];
    }
    return null;
  };
  return go(0, 0);
}

function subsequence(q: string, s: string): number[] | null {
  const pos: number[] = [];
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) {
    pos.push(i);
    j++;
  }
  return j === q.length ? pos : null;
}

const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

/**
 * How well `q` matches `name` — exact (1000) > a prefix (800) > exact ignoring case (780) > a prefix ignoring case (760) >
 * camel humps (600) > a substring (450 at a word start, else 400) > a subsequence (200; one-character queries stop at humps)
 * — prefixes and below minus the characters the name has beyond the query (≤ 80). Null: no match.
 */
export function matchName(q: string, name: string): { score: number; matches: number[] } | null {
  if (!q) return null;
  const ql = q.toLowerCase();
  const lower = name.toLowerCase();
  const extra = Math.min(80, Math.max(0, name.length - q.length));
  if (name === q) return { score: 1000, matches: range(0, q.length) };
  if (name.startsWith(q)) return { score: 800 - extra, matches: range(0, q.length) };
  if (lower === ql) return { score: 780, matches: range(0, q.length) };
  if (lower.startsWith(ql)) return { score: 760 - extra, matches: range(0, q.length) };
  const hump = humpMatch(q, name);
  if (hump) return { score: 600 + (hump[0] === 0 ? 20 : 0) - extra, matches: hump };
  if (q.length < 2) return null;
  const at = lower.indexOf(ql);
  if (at >= 0) return { score: (wordStarts(name).includes(at) ? 450 : 400) - extra, matches: range(at, q.length) };
  const sub = subsequence(ql, lower);
  if (!sub) return null;
  let runs = 0;
  for (let i = 1; i < sub.length; i++) if (sub[i] === sub[i - 1]! + 1) runs++;
  return { score: 200 + runs * 5 - extra, matches: sub };
}

/**
 * `workspace_symbols` ranking: `matchName` on the name; a query `A.b` also matches `A` against the container (its last part or
 * the whole). Types (class, interface, enum, record, annotation, object, type, module, component) +60, a constructor −15;
 * test files −80, vendored / generated / minified ones −150, a `.d.ts` −20. Ties: the shorter name, then path and line.
 */
export function rankSymbols(files: Iterable<[string, readonly FileSymbol[]]>, query: string, limit: number): { symbols: WorkspaceSymbol[]; truncated: boolean } {
  const q = query.trim();
  if (!q) return { symbols: [], truncated: false };
  const dot = q.lastIndexOf(".");
  const nameQ = dot > 0 && dot < q.length - 1 ? q.slice(dot + 1) : q.replace(/\.+$/, "");
  const containerQ = dot > 0 && dot < q.length - 1 ? q.slice(0, dot) : null;
  type Hit = { s: FileSymbol; path: string; score: number; matches: number[] };
  const hits: Hit[] = [];
  for (const [path, symbols] of files) {
    let pathScore = 0;
    if (TESTISH.test(path)) pathScore -= 80;
    if (VENDOR.test(path) || MINIFIED.test(path)) pathScore -= 150;
    if (path.endsWith(".d.ts")) pathScore -= 20;
    for (const s of symbols) {
      const m = matchName(nameQ, s.name);
      if (!m) continue;
      let score = m.score + pathScore;
      if (containerQ !== null) {
        if (!s.container) continue;
        const last = s.container.slice(s.container.lastIndexOf(".") + 1);
        const cm = matchName(containerQ, last) ?? matchName(containerQ, s.container);
        if (!cm) continue;
        score += Math.round(cm.score / 4);
      }
      if (isTypeKind(s.kind)) score += 60;
      if (s.kind === "constructor") score -= 15;
      hits.push({ s, path, score, matches: m.matches });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.s.line - b.s.line);
  const symbols = hits.slice(0, limit).map(({ s, path, matches }) => {
    const { depth: _depth, ...rest } = s;
    return { ...rest, path, matches };
  });
  return { symbols, truncated: hits.length > limit };
}
