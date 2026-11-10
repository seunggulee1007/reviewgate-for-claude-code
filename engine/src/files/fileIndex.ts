import type { FileItem } from "../protocol.js";

/** `list_files` never returns more than this many items (§23). */
export const LIST_FILES_MAX = 50;
/** Paths kept in the index (files + derived directories); a larger repository is cut (logged by the engine). */
export const FILE_INDEX_MAX_ENTRIES = 200_000;

type Entry = { path: string; lower: string; base: string; kind: "file" | "dir" };

/**
 * The repository's file list for @-mentions (§23): `git ls-files --cached --others --exclude-standard` plus every
 * directory above those files, read once and cached until `invalidate()` (turn end, refresh, rewind, branch switch).
 */
export class FileIndex {
  private entries: Entry[] | null = null;
  private loading: Promise<Entry[]> | null = null;
  private generation = 0;
  truncated = false;

  constructor(private readonly listFiles: () => Promise<string[]>) {}

  invalidate(): void {
    this.generation += 1;
    this.entries = null;
    this.loading = null;
  }

  private async load(): Promise<Entry[]> {
    if (this.entries) return this.entries;
    if (this.loading) return this.loading;
    const gen = this.generation;
    const run = this.listFiles().then((files) => {
      const built = buildEntries(files);
      this.truncated = built.truncated;
      if (gen === this.generation) {
        this.entries = built.entries;
        this.loading = null;
      }
      return built.entries;
    });
    this.loading = run;
    run.catch(() => {
      if (this.loading === run) this.loading = null;
    });
    return run;
  }

  /** The best `limit` (≤ 50) matches of `query`; files of the current review (`changed`) rank first. */
  async search(query: string, changed: ReadonlySet<string>, limit = LIST_FILES_MAX): Promise<FileItem[]> {
    return searchEntries(await this.load(), query, changed, limit);
  }
}

function buildEntries(files: string[]): { entries: Entry[]; truncated: boolean } {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  let truncated = false;
  const add = (path: string, kind: "file" | "dir") => {
    const key = `${kind}:${path}`;
    if (seen.has(key)) return;
    if (entries.length >= FILE_INDEX_MAX_ENTRIES) {
      truncated = true;
      return;
    }
    seen.add(key);
    const slash = path.lastIndexOf("/");
    entries.push({ path, lower: path.toLowerCase(), base: (slash >= 0 ? path.slice(slash + 1) : path).toLowerCase(), kind });
  };
  for (const raw of files) {
    const f = raw.replace(/\\/g, "/");
    if (!f) continue;
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) add(parts.slice(0, i).join("/"), "dir");
    add(f, "file");
  }
  return { entries, truncated };
}

/** Ranks every entry against `query`; exported for tests. */
export function searchEntries(entries: readonly Entry[], query: string, changed: ReadonlySet<string>, limit = LIST_FILES_MAX): FileItem[] {
  const cap = Math.max(1, Math.min(LIST_FILES_MAX, Number.isFinite(limit) ? Math.floor(limit) : LIST_FILES_MAX));
  const q = query.trim().toLowerCase().replace(/\\/g, "/").replace(/^@/, "").replace(/\s+/g, "");
  const scored: { e: Entry; score: number }[] = [];
  for (const e of entries) {
    const score = q ? fuzzyScore(q, e) : 0;
    if (score === null) continue;
    const isChanged = e.kind === "file" && changed.has(e.path);
    // Changed files of the current review first; without a query only they and the top-level entries are useful.
    const total = score + (isChanged ? 100_000 : 0) - (e.kind === "dir" ? 25 : 0) - (q ? 0 : e.path.split("/").length * 10);
    scored.push({ e, score: total });
  }
  scored.sort((a, b) => b.score - a.score || a.e.path.length - b.e.path.length || (a.e.path < b.e.path ? -1 : a.e.path > b.e.path ? 1 : 0));
  return scored.slice(0, cap).map(({ e }) => ({ path: e.path, kind: e.kind, ...(e.kind === "file" && changed.has(e.path) ? { changed: true as const } : {}) }));
}

/**
 * Subsequence match of `q` (lower case) in the entry, null when the characters do not all appear in order.
 * A match inside the basename beats one spread over the directories; contiguous runs, a prefix of the basename
 * and matches right after `/ . _ -` score higher; long, deep paths slightly lower.
 */
export function fuzzyScore(q: string, e: Pick<Entry, "lower" | "base">): number | null {
  const inBase = subsequence(q, e.base);
  const inPath = inBase ?? subsequence(q, e.lower);
  if (inPath === null) return null;
  const hay = inBase !== null ? e.base : e.lower;
  let score = inBase !== null ? 1000 : 100;
  if (inBase !== null) {
    const stem = e.base.replace(/\.[^.]*$/, "");
    if (e.base === q || stem === q) score += 800;
    else if (e.base.startsWith(q)) score += 400;
    else if (e.base.includes(q)) score += 250;
  } else if (e.lower.includes(q)) score += 200;
  let prev = -2;
  for (const i of inPath) {
    if (i === prev + 1) score += 6;
    const before = i > 0 ? hay[i - 1] : "/";
    if (before === "/" || before === "." || before === "_" || before === "-") score += 3;
    prev = i;
  }
  score -= e.lower.length * 0.2;
  return score;
}

/** Leftmost positions of `q`'s characters in order within `s`, or null. */
function subsequence(q: string, s: string): number[] | null {
  const pos: number[] = [];
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) {
      pos.push(i);
      j++;
    }
  }
  return j === q.length ? pos : null;
}

/** `@path` the way the CLI expands mentions natively (§23): quoted when the path holds whitespace or a quote. */
export function mentionToken(path: string, kind: "file" | "dir" = "file"): string {
  const p = kind === "dir" && !path.endsWith("/") ? `${path}/` : path;
  return /[\s"]/.test(p) ? `@"${p.replace(/"/g, '\\"')}"` : `@${p}`;
}
