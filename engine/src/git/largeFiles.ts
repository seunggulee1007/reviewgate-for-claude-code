import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isModsGroup } from "./mods.js";

/**
 * MARK: wave4b w4b-bigturn — §39.1 (robustness-11 ①): an untracked file at least `largeFileBytes` large (a 2 GB Spring
 * heap dump, a generated archive) is not hashed into the object store by a snapshot. The snapshot holds a small stub text
 * for it instead (size + mtime, like the §32 mods stubs): its appearance / change / removal still shows in the review —
 * the gate still asks about it — while its content is never stored, never written back and never committed by the app.
 * Files git already tracks are captured whatever their size.
 */

export const DEFAULT_LARGE_FILE_MB = 50;
export const MIN_LARGE_FILE_MB = 1;
export const MAX_LARGE_FILE_MB = 100_000;
export const LARGE_STUB_PREFIX = "[ReviewGate] large file not captured";
/** A stub is ~100 bytes: blobs above this are never read to check for one. */
export const STUB_MAX_BYTES = 512;

/**
 * The limit every `GitCheckpoint` of this process uses (the engine's, and the hooks' own instance for post-Bash
 * snapshots): one value, so A, B and the hooks' snapshots always agree on which files are stubs. Set from
 * `settings.largeFileMB` (0 turns stubs off — tests only).
 */
let processLimitBytes = DEFAULT_LARGE_FILE_MB * 1024 * 1024;
export function setLargeFileLimit(bytes: number): void {
  processLimitBytes = bytes;
}
export function largeFileLimit(): number {
  return processLimitBytes;
}

/** `settings.largeFileMB` → bytes (out-of-range / non-numbers: the default). */
export function largeFileBytes(mb: unknown): number {
  const n = typeof mb === "number" && Number.isFinite(mb) ? Math.round(mb) : DEFAULT_LARGE_FILE_MB;
  const clamped = n < MIN_LARGE_FILE_MB || n > MAX_LARGE_FILE_MB ? DEFAULT_LARGE_FILE_MB : n;
  return clamped * 1024 * 1024;
}

export type LargeFile = { path: string; size: number; mtimeMs: number };

/** The stub text that stands for a large file: changes whenever its size or mtime does. */
export function largeStubText(size: number, mtimeMs: number): string {
  return `${LARGE_STUB_PREFIX} (too large): ${size} bytes, modified ${new Date(Math.floor(mtimeMs)).toISOString()}\n`;
}

export function isLargeStubContent(content: Buffer | string): boolean {
  const s = typeof content === "string" ? content : content.subarray(0, LARGE_STUB_PREFIX.length).toString("utf8");
  return s.startsWith(LARGE_STUB_PREFIX);
}

/** The size a large-file stub records; null when `content` is no such stub. */
export function largeStubSize(content: Buffer | string): number | null {
  const s = typeof content === "string" ? content : content.subarray(0, STUB_MAX_BYTES).toString("utf8");
  if (!s.startsWith(LARGE_STUB_PREFIX)) return null;
  const m = /: (\d+) bytes/.exec(s);
  return m ? Number(m[1]) : 0;
}

/**
 * Of `untracked` (repo-relative, as `git ls-files --others` lists them), the regular files at least `minBytes` large.
 * Mods paths (§32) are left to their own stubs; a directory entry (`x/`, a nested repository) and anything that cannot
 * be stat'ed are skipped. Sorted by path.
 */
export async function findLargeFiles(root: string, untracked: readonly string[], minBytes: number): Promise<LargeFile[]> {
  if (minBytes <= 0) return [];
  const out: LargeFile[] = [];
  const candidates = untracked.filter((rel) => rel.length > 0 && !rel.endsWith("/") && !isModsGroup(rel));
  const CHUNK = 64;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const part = candidates.slice(i, i + CHUNK);
    const stats = await Promise.all(part.map((rel) => lstat(join(root, rel)).catch(() => null)));
    stats.forEach((st, k) => {
      if (st && st.isFile() && st.size >= minBytes) out.push({ path: part[k]!, size: st.size, mtimeMs: st.mtimeMs });
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
