import { lstat, open } from "node:fs/promises";
import type { ChangedFile, GitCheckpoint } from "../git/checkpoint.js";
import { nulSplit } from "../git/exec.js";
import type { GeneratedKind } from "../protocol.js";

/**
 * §34.7 file detail (docs/PROTOCOL.md §34.7): which changed files are generated (folded by default in both clients) and
 * which changed whitespace only. Set at every rebuild of the review list (collection, refresh, restore) and on the
 * `live_changes` files; best effort — a failing git call leaves the files unannotated, it never fails the rebuild.
 */

/** Lockfiles by file name (any directory). */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "Gemfile.lock",
  "poetry.lock", "Pipfile.lock", "composer.lock", "go.sum", "Package.resolved", "Podfile.lock", "gradle.lockfile",
  "flake.lock", "pubspec.lock", "mix.lock",
]);

/** The content rules read this much of a file: the first 5 lines, of which a marker counts within the first 1 KB. */
const HEAD_BYTES = 8 * 1024;
const MARKER_BYTES = 1024;
const MARKER_LINES = 5;
/** A line longer than this among the first 5 of a `.js` / `.css` file: minified. */
const MINIFIED_LINE_CHARS = 1000;
const MARKER_RE = /@generated\b|\bDO NOT EDIT\b/;
/** Content rules are applied to at most this many files of one list (path / attribute rules to all). */
const CONTENT_CHECK_MAX_FILES = 3000;
const READ_CONCURRENCY = 32;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** `lockfile` / `minified` from the path alone (`*.min.js`, `*.min.css`, `*.map`); null otherwise. */
export function generatedByPath(path: string): GeneratedKind | null {
  const name = baseName(path);
  if (LOCKFILE_NAMES.has(name)) return "lockfile";
  if (/.\.min\.(js|css)$/i.test(name) || /.\.map$/i.test(name)) return "minified";
  return null;
}

/** From the first bytes of a file: `generated` (`@generated` / `DO NOT EDIT` within the first 5 lines, ≤ 1 KB) or `minified`. */
export function generatedByContent(path: string, head: Buffer): GeneratedKind | null {
  const text = head.subarray(0, HEAD_BYTES).toString("utf8");
  const lines = text.split("\n").slice(0, MARKER_LINES);
  let offset = 0;
  for (const line of lines) {
    if (offset >= MARKER_BYTES) break;
    const within = line.slice(0, Math.max(0, MARKER_BYTES - offset));
    if (MARKER_RE.test(within)) return "generated";
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  if (/\.(js|mjs|cjs|css)$/i.test(path) && lines.some((l) => l.length > MINIFIED_LINE_CHARS)) return "minified";
  return null;
}

/** `git check-attr linguist-generated diff binary` for `paths` → path → attribute → value (`set` / `unset` / `unspecified` / a value). */
async function attributes(cp: GitCheckpoint, paths: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (paths.length === 0) return out;
  const r = await cp.git(["check-attr", "-z", "--stdin", "linguist-generated", "diff", "binary"], { stdin: Buffer.from(paths.join("\0") + "\0"), allowFailure: true });
  if (r.status !== 0) return out;
  const f = nulSplit(r.stdout);
  for (let i = 0; i + 2 < f.length; i += 3) {
    const m = out.get(f[i]!) ?? new Map<string, string>();
    m.set(f[i + 1]!, f[i + 2]!);
    out.set(f[i]!, m);
  }
  return out;
}

/** The first bytes of the worktree file `rel` (a regular file only); null when unreadable. */
async function headOf(cp: GitCheckpoint, rel: string): Promise<Buffer | null> {
  const full = cp.fsPath(rel);
  try {
    const st = await lstat(full);
    if (!st.isFile()) return null;
    const fh = await open(full, "r");
    try {
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

type DetailFile = Pick<ChangedFile, "path" | "status" | "isBinary">;

/**
 * §34.7 `generated` of each file that is one: the user's `linguist-generated` (set → generated; `false` / unset → never,
 * whatever else says so), then the lockfile / minified names, then `-diff` (git is told not to diff it — numstat then
 * counts it binary; the `binary` macro of images and archives is not a generated file), then the content markers of the
 * file as the worktree holds it (B was just snapshotted from it; a deleted file has none).
 */
export async function classifyGenerated(cp: GitCheckpoint, files: readonly DetailFile[]): Promise<Map<string, GeneratedKind>> {
  const kinds = new Map<string, GeneratedKind>();
  const attrs = await attributes(cp, files.map((f) => f.path)).catch(() => new Map<string, Map<string, string>>());
  const content: DetailFile[] = [];
  for (const f of files) {
    const a = attrs.get(f.path);
    const lg = a?.get("linguist-generated");
    if (lg === "set" || lg === "true") {
      kinds.set(f.path, "generated");
      continue;
    }
    if (lg === "false" || lg === "unset") continue;
    const byPath = generatedByPath(f.path);
    if (byPath) {
      kinds.set(f.path, byPath);
      continue;
    }
    if (a?.get("diff") === "unset" && a.get("binary") !== "set") {
      kinds.set(f.path, "generated");
      continue;
    }
    if (f.status !== "D" && !f.isBinary && content.length < CONTENT_CHECK_MAX_FILES) content.push(f);
  }
  for (let i = 0; i < content.length; i += READ_CONCURRENCY) {
    const batch = content.slice(i, i + READ_CONCURRENCY);
    const heads = await Promise.all(batch.map((f) => headOf(cp, f.path)));
    batch.forEach((f, k) => {
      const head = heads[k];
      const kind = head ? generatedByContent(f.path, head) : null;
      if (kind) kinds.set(f.path, kind);
    });
  }
  return kinds;
}

/** At most this many files are diffed with pathspecs (§37.9: in calls of ≤ `WS_SPEC_CHARS_MAX` characters); more → the whole `-w` diff, once. */
const WS_PATHSPEC_MAX = 300;

/**
 * §34.7 `whitespaceOnly`: the modified / renamed text files with line changes whose `git diff-tree -w` shows none (a
 * whitespace-only modification drops out of `-w --numstat`, a renamed one shows `0 0`). A mode-only change or a pure
 * rename has no line change, so it is never whitespace-only.
 */
export async function whitespaceOnlyPaths(
  cp: GitCheckpoint,
  a: string,
  b: string,
  files: readonly Pick<ChangedFile, "path" | "oldPath" | "status" | "added" | "deleted" | "isBinary">[],
  maxSpecChars: number = WS_SPEC_CHARS_MAX,
): Promise<Set<string>> {
  const candidates = files.filter((f) => (f.status === "M" || f.status === "R") && !f.isBinary && f.added + f.deleted > 0);
  const out = new Set<string>();
  if (candidates.length === 0) return out;
  // MARK: wave3 check-engine — §37.9: the pathspecs go in calls of at most `maxSpecChars` characters (a Windows command
  // line holds 32 767), a rename's two names in the same call; more than WS_PATHSPEC_MAX candidates: the whole diff, once.
  const calls: { specs: string[]; files: typeof candidates }[] = [];
  if (candidates.length > WS_PATHSPEC_MAX) calls.push({ specs: [], files: candidates });
  else {
    let cur: { specs: string[]; files: typeof candidates } = { specs: [], files: [] };
    let size = 0;
    for (const f of candidates) {
      const specs = [...new Set(f.oldPath && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path])].map((p) => `:(literal)${p}`);
      const len = specs.reduce((n, s) => n + s.length + 1, 0);
      if (cur.files.length > 0 && size + len > maxSpecChars) {
        calls.push(cur);
        cur = { specs: [], files: [] };
        size = 0;
      }
      cur.specs.push(...specs);
      cur.files.push(f);
      size += len;
    }
    calls.push(cur);
  }
  for (const call of calls) {
    const r = await cp.git(["diff-tree", "-r", "-M", "-w", "-z", "--numstat", a, b, ...(call.specs.length > 0 ? ["--", ...call.specs] : [])], { allowFailure: true });
    // A failed call marks none of its files.
    if (r.status !== 0) continue;
    const counts = new Map<string, number>();
    const fields = nulSplit(r.stdout);
    for (let i = 0; i < fields.length; ) {
      const parts = fields[i]!.split("\t");
      if (parts.length < 3) {
        i += 1;
        continue;
      }
      const lines = (parseInt(parts[0]!, 10) || 0) + (parseInt(parts[1]!, 10) || 0) + (parts[0] === "-" ? 1 : 0);
      if (parts[2] !== "") {
        counts.set(parts[2]!, lines);
        i += 1;
      } else {
        // A rename: "a\td\t\0old\0new\0".
        if (i + 2 < fields.length) counts.set(fields[i + 2]!, lines);
        i += 3;
      }
    }
    for (const f of call.files) if ((counts.get(f.path) ?? 0) === 0) out.add(f.path);
  }
  return out;
}

/** MARK: wave3 check-engine — §37.9: pathspec characters per `-w` call, far inside Windows' 32 767-character command line. */
export const WS_SPEC_CHARS_MAX = 16_000;

/** A changed file with the §34.7 detail fields (they ride on the review list's objects into the state and the review file). */
export type DetailedFile = ChangedFile & { generated?: GeneratedKind; whitespaceOnly?: true };

// MARK: wave3 check-engine
/**
 * §37.5: `whitespaceOnly` of one file again after its A → B change shrank (`reject_hunks` kept part of it) — one `-w`
 * numstat of that file. A generated file is left alone (never diffed for it, §34.7). Never throws: a failing git call
 * keeps the flag as it was.
 */
export async function recheckWhitespaceOnly(cp: GitCheckpoint, file: DetailedFile, a: string, b: string): Promise<void> {
  if (file.generated) return;
  try {
    if ((await whitespaceOnlyPaths(cp, a, b, [file])).has(file.path)) file.whitespaceOnly = true;
    else delete file.whitespaceOnly;
  } catch {
    // best effort (§34.7)
  }
}

/**
 * Sets (or clears) `generated` / `whitespaceOnly` on `files` for the A → B change. Never throws. A generated file is
 * not diffed again for `whitespaceOnly` (a regenerated lockfile is folded anyway, and its `-w` diff is the costly one).
 */
export async function annotateDetail(cp: GitCheckpoint, files: DetailedFile[], a: string, b: string): Promise<void> {
  let kinds = new Map<string, GeneratedKind>();
  let ws = new Set<string>();
  try {
    kinds = await classifyGenerated(cp, files);
    ws = await whitespaceOnlyPaths(cp, a, b, files.filter((f) => !kinds.has(f.path)));
  } catch {
    // best effort (§34.7): an unreadable list stays unannotated
  }
  for (const f of files) {
    const kind = kinds.get(f.path);
    if (kind) f.generated = kind;
    else delete f.generated;
    if (ws.has(f.path)) f.whitespaceOnly = true;
    else delete f.whitespaceOnly;
  }
}
