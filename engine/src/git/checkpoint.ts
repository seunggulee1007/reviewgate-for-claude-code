import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { GitCommandError, NotARepositoryError, nulSplit, runGit, type GitOptions, type GitResult } from "./exec.js";
import { isModsPath, isStubContent, MODS_MAX_FILES, modsCandidates, stubText, uncapturedReason, type ModsRisk } from "./mods.js";
import { findLargeFiles, isLargeStubContent, largeFileLimit, largeStubSize, largeStubText, STUB_MAX_BYTES, type LargeFile } from "./largeFiles.js"; // MARK: wave4b w4b-bigturn
import { isInsidePath, samePath, toNativeAbs } from "../platform/paths.js";
import type { ChangedFileReview } from "../protocol.js";

export type ChangeStatus = "A" | "M" | "D" | "R" | "X";

/**
 * `changesRequested`: the user left notes and sent them back to Claude (docs/M8-API.md); the file is
 * not reverted and the gate stays closed until the follow-up turn ends and the list is rebuilt.
 */
export type ReviewState = "pending" | "accepted" | "rejected" | "changesRequested";

export type ChangedFile = {
  /** Set once `reject_hunks` reverted some hunks and the rest stays under review (docs/PROTOCOL.md §17). */
  partial?: true;
  /** Hunks reverted by `reject_hunks` so far. */
  rejectedHunks?: number;
  /** Repo-root-relative, `/`-separated (new path for renames). */
  path: string;
  /** Renames only. */
  oldPath: string | null;
  status: ChangeStatus;
  added: number;
  deleted: number;
  isBinary: boolean;
  /** From `turn_end.toolFiles`; empty means "via Bash" (no post-Bash snapshot attributed it). */
  tools: string[];
  /** The tool_use ids that touched the file (edit tools, and the Bash call whose post-Bash snapshot saw it). */
  toolUseIds: string[];
  state: ReviewState;
  /** §32 (mods files only): what the change makes run or lets through. */
  risk?: ModsRisk[];
  /** §32: one side is a stub — the content was not captured (too large / binary); the file cannot be reverted. */
  uncaptured?: true;
  /** §32: gitignored (a force-added mods file): reviewed, but `commit` cannot stage it. */
  ignored?: true;
  // MARK: wave2 engine-review — the §34 per-file review fields (`changedThisTurn`, `blob`, …) live on the file too.
  // MARK: wave4b w4b-files — §40.2 (comp-11): the file modes when they changed (`100644` → `100755`; a new file: `newMode`
  // when it is executable) and a rename's similarity in percent (100: moved without a content change).
  oldMode?: string;
  newMode?: string;
  similarity?: number;
} & ChangedFileReview;

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A path one snapshot left out (robustness-09, §32): git could not read it (permission denied, …). */
export type SkippedPath = { path: string; reason: "unreadable" };

/** At most this many files are left out of one snapshot before it fails after all. */
const MAX_SKIPPED = 500;

/** git's own words when an LFS filter cannot run: git-lfs is not installed / not on the app's PATH. */
const LFS_MISSING_RE = /lfs[^\n]*: (command )?not found|(clean|external) filter '[^']*lfs[^']*' failed/i;

/** The repository stores files with Git LFS but its filter cannot run (git-lfs missing). */
export class LfsMissingError extends Error {
  constructor(detail: string) {
    super(
      "git-lfs is not installed (or not on the PATH the app sees), but this repository keeps files in Git LFS " +
        `(.gitattributes filter=lfs): install it (brew install git-lfs && git lfs install) and retry. (${detail})`,
    );
    this.name = "LfsMissingError";
  }
}

/** The files `git add` reported it could not read: `error: open("x"): …` / `error: unable to index file 'x'`. */
function unreadablePaths(stderr: string): string[] {
  const out = new Set<string>();
  for (const m of stderr.matchAll(/error: open\("(.+?)"\):|error: unable to index file '(.+?)'/g)) out.add((m[1] ?? m[2])!);
  return [...out];
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300);
}

/** `git init -q` in `directory`. */
export async function initRepository(directory: string): Promise<void> {
  await runGit(directory, ["init", "-q"]);
}

/** Resolves the toplevel of the repository containing `directory`; throws `NotARepositoryError`. */
export async function openCheckpoint(directory: string): Promise<GitCheckpoint> {
  let out: GitResult;
  try {
    out = await runGit(directory, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  } catch {
    throw new NotARepositoryError(directory);
  }
  const top = out.text.trim();
  if (out.status !== 0 || !top) throw new NotARepositoryError(directory);
  return new GitCheckpoint(toNativeAbs(top));
}

type NameStatusEntry = {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  // MARK: wave4b w4b-files — §40.2: from the raw diff (`:<old mode> <new mode> <sha> <sha> <status>[score]`).
  oldMode?: string;
  newMode?: string;
  similarity?: number;
};

/**
 * Turn-level checkpoints: tree snapshots taken through a temporary index so the user's own index
 * and worktree are never modified; diff/patch/revert between two snapshot trees.
 */
/**
 * The real index copied to a temporary one with its timestamps: git trusts an entry's stat data unless the entry is as new
 * as the index file itself ("racy git"), so a copy stamped now hid a same-size edit made in the second the index was
 * written (an IDE's refresh, then Claude's edit). Best effort, like the copy itself.
 */
export async function copyIndex(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
    const st = await stat(from);
    await utimes(to, st.atime, st.mtime);
  } catch {
    // no index to start from: `add -A` builds it
  }
}

// MARK: wave4 w4-safety — robustness-07
/** Default cap of one checkpoint git call (snapshot, diff, revert). Generous: a first snapshot of a large monorepo is slow. */
export const CHECKPOINT_GIT_TIMEOUT_MS = 300_000;
let checkpointGitTimeoutMs = CHECKPOINT_GIT_TIMEOUT_MS;
/** Test seam. */
export function setCheckpointGitTimeout(ms: number): void {
  checkpointGitTimeoutMs = ms;
}

/** After the cap: exec's SIGTERM, its 2 s SIGKILL grace, and a little more for the pipes to close. */
const GIT_DEADLINE_GRACE_MS = 3000;

/** `p`, or `error()` once `ms` passed (`p` keeps running; its late failure is swallowed). */
function withDeadline<T>(p: Promise<T>, ms: number, error: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error()), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A checkpoint git call that did not answer within its cap (the process was killed). */
export class GitTimeoutError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly timeoutMs: number,
  ) {
    super(`${cmd} did not respond within ${Math.round(timeoutMs / 1000)} s — check the VPN / network (LFS), or a git process holding the repository lock`);
    this.name = "GitTimeoutError";
  }
}

export class GitCheckpoint {
  /** Git toplevel, native form (`toNativeAbs`: `C:\\x\\repo` on Windows, where git prints `C:/x/repo`). */
  constructor(public readonly root: string) {}

  // MARK: wave4b w4b-bigturn
  /** §39.1: untracked files at least this large are stubs in every snapshot (0 = off); null = the process limit. */
  largeFileBytes: number | null = null;

  /**
   * MARK: wave4 w4-safety — robustness-07: every snapshot / diff / revert call is capped (`CHECKPOINT_GIT_TIMEOUT_MS`
   * unless the caller says otherwise): a git that hangs (an LFS filter behind a dropped VPN, a lock) ends with
   * `GitTimeoutError` — the existing send / collect / revert error paths — instead of holding the main lane.
   */
  async git(args: string[], opts: GitOptions = {}): Promise<GitResult> {
    // The user's own commit / push (their hooks may run long) and an explicit `timeoutMs: 0` are never capped.
    const timeoutMs = opts.timeoutMs ?? (opts.userHooks ? 0 : checkpointGitTimeoutMs);
    const timeout = () => new GitTimeoutError(`git ${args[0] ?? ""}`.trim(), timeoutMs);
    const run = runGit(this.root, args, { ...opts, timeoutMs, allowFailure: true });
    // A child git left behind (an LFS filter, ssh) can hold the output pipes open after git itself was killed: the call
    // still ends — with the timeout — once the kill and its grace are over.
    const out = timeoutMs > 0 ? await withDeadline(run, timeoutMs + GIT_DEADLINE_GRACE_MS, timeout) : await run;
    if (out.timedOut) throw timeout();
    if (out.status !== 0 && !opts.allowFailure) throw new GitCommandError("git " + args.join(" "), out.stderr, out.status);
    return out;
  }

  /** Filesystem path of a repo-relative file. */
  fsPath(rel: string): string {
    return normalize(this.root + "/" + rel);
  }

  /** Current branch name; null on a detached HEAD or an unborn branch. */
  async branchName(): Promise<string | null> {
    const out = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true }).catch(() => null);
    if (!out || out.status !== 0) return null;
    const name = out.text.trim();
    return !name || name === "HEAD" ? null : name;
  }

  /** HEAD's commit (null when unborn) and branch (null when detached / unborn), for the §31 HEAD-moved check. */
  async head(): Promise<{ sha: string | null; branch: string | null }> {
    const [out, branch] = await Promise.all([this.git(["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true }).catch(() => null), this.branchName()]);
    const sha = out && out.status === 0 ? out.text.trim() || null : null;
    return { sha, branch };
  }

  /** §46: an unfinished merge — the commit it brings in (`MERGE_HEAD`) and where that forked from HEAD; null outside one. */
  async mergeInProgress(): Promise<{ head: string; base: string } | null> {
    const out = await this.git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { allowFailure: true });
    const head = out.status === 0 ? out.text.trim() : "";
    if (!head) return null;
    const mb = await this.git(["merge-base", "HEAD", head], { allowFailure: true });
    const base = mb.status === 0 ? mb.text.trim() : "";
    return base ? { head, base } : null;
  }

  /** §46: repo-relative paths with an unmerged index entry (`unmerged`), or whose index entry differs from HEAD (`staged`). */
  async indexPaths(kind: "unmerged" | "staged"): Promise<string[]> {
    const args = kind === "unmerged" ? ["diff", "--name-only", "--diff-filter=U", "-z"] : ["diff", "--cached", "--name-only", "--no-renames", "-z"];
    const out = await this.git(args, { allowFailure: true });
    return out.status === 0 ? nulSplit(out.stdout) : [];
  }

  /** The best common ancestor of two commits; null when they have none. */
  async mergeBase(a: string, b: string): Promise<string | null> {
    const out = await this.git(["merge-base", a, b], { allowFailure: true });
    return out.status === 0 ? out.text.trim() || null : null;
  }

  /**
   * §46: the commits from `from` (exclusive) to `to` along first parents, oldest first, each with its parents; null when
   * `to` does not get back to `from` that way (a checkout elsewhere, a rebase) or the chain is longer than `max`.
   */
  async firstParentChain(from: string, to: string, max = 200): Promise<{ sha: string; parents: string[] }[] | null> {
    const out = await this.git(["rev-list", "--first-parent", "--parents", "--reverse", `--max-count=${max + 1}`, `${from}..${to}`], { allowFailure: true });
    if (out.status !== 0) return null;
    const chain = out.text.split("\n").map((l) => l.trim().split(/\s+/)).filter((w) => w[0]).map(([sha, ...parents]) => ({ sha: sha!, parents }));
    if (chain.length === 0 || chain.length > max || chain[0]!.parents[0] !== from || chain[chain.length - 1]!.sha !== to) return null;
    return chain;
  }

  /** `origin` fetch URL; null when there is no such remote. */
  async remoteURL(): Promise<string | null> {
    const out = await this.git(["remote", "get-url", "origin"], { allowFailure: true }).catch(() => null);
    if (!out || out.status !== 0) return null;
    const url = out.text.trim();
    return url || null;
  }

  // MARK: - Snapshot

  /**
   * Writes the current worktree (tracked + untracked, honoring .gitignore) as a tree object via a
   * temporary index seeded from the real one, and returns its SHA. `ignorePatterns` (prefix or
   * `*`-glob, see `matchesIgnore`) are excluded from `git add -A` via a one-off `core.excludesFile`
   * (not pathspec magic: git refuses `:(exclude)` pathspecs that name an already-gitignored path),
   * so files a user hook is concurrently writing/deleting under them (e.g. `.omc/`) can never race
   * the add. Because the temp index is seeded from the real one, a prefix pattern may still have a
   * stale (already tracked or staged) entry there; those are stripped from the temp index after
   * `add -A` so excluded paths never reach the resulting tree.
   */
  async snapshot(ignorePatterns: string[] = []): Promise<string> {
    return (await this.snapshotDetailed(ignorePatterns)).tree;
  }

  /**
   * `snapshot()` plus the paths it had to leave out (robustness-09, §32): one file git cannot read (a root-owned log
   * a container wrote) no longer fails the whole snapshot — it is left out (untracked: excluded; tracked: its index
   * version kept, `assume-unchanged` in the temporary index) and reported, and a new file outside a sparse-checkout
   * definition is added with `--sparse`. A repository whose LFS filter cannot run (git-lfs missing) throws
   * `LfsMissingError` with a hint instead of git's message.
   */
  async snapshotDetailed(ignorePatterns: string[] = []): Promise<{ tree: string; skipped: SkippedPath[]; large: LargeFile[] }> {
    const tmpIndex = join(tmpdir(), `rg-index-${randomUUID()}`);
    const excludesFile = ignorePatterns.length > 0 ? join(tmpdir(), `rg-excludes-${randomUUID()}`) : null;
    try {
      const indexOut = await this.git(["rev-parse", "--git-path", "index"], { allowFailure: true });
      if (indexOut.status === 0) {
        let realIndex = indexOut.text.trim();
        if (!isAbsoluteGitPath(realIndex)) realIndex = this.root + "/" + realIndex;
        if (await exists(realIndex)) await copyIndex(realIndex, tmpIndex);
      }
      const env = { GIT_INDEX_FILE: tmpIndex };
      if (excludesFile) await writeFile(excludesFile, excludesFileLines(ignorePatterns));
      // MARK: wave4b w4b-bigturn — §39.1: large untracked files are kept out of `add -A` and stand in the tree as stubs.
      const large = await this.largeUntracked(env, excludesFile);
      const skipped = await this.addAll(env, excludesFile, large.map((l) => l.path));
      const stalePrefixes = prefixPatterns(ignorePatterns);
      if (stalePrefixes.length > 0) {
        await this.git(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ...stalePrefixes], { env });
      }
      await this.addMods(env);
      await this.addLargeStubs(env, large);
      const tree = await this.git(["write-tree"], { env });
      return { tree: tree.text.trim(), skipped, large };
    } finally {
      await rm(tmpIndex, { force: true }).catch(() => undefined);
      await rm(tmpIndex + ".lock", { force: true }).catch(() => undefined);
      if (excludesFile) await rm(excludesFile, { force: true }).catch(() => undefined);
    }
  }

  /** `git add -A` into the temporary index, working around single files that cannot be added (see `snapshotDetailed`). */
  private async addAll(env: Record<string, string>, excludesFile: string | null, alsoExclude: readonly string[] = []): Promise<SkippedPath[]> {
    const skipped: SkippedPath[] = [];
    const excluded: string[] = [...alsoExclude]; // MARK: wave4b w4b-bigturn — §39.1: the large files (stubs follow)
    let sparse = false;
    for (let attempt = 0; ; attempt++) {
      // MARK: wave4b w4b-bigturn: a long exclusion list goes through stdin (a Windows command line holds 32 767 characters).
      const specs = excluded.length > 0 ? [".", ...excluded.map((p) => `:(exclude,literal)${p}`)] : [];
      const viaStdin = specs.reduce((n, s) => n + s.length + 1, 0) > 8000;
      const args = [
        ...(excludesFile ? ["-c", `core.excludesFile=${excludesFile}`] : []),
        "add",
        "-A",
        ...(sparse ? ["--sparse"] : []),
        ...(specs.length === 0 ? [] : viaStdin ? ["--pathspec-from-file=-", "--pathspec-file-nul"] : ["--", ...specs]),
      ];
      try {
        await retryOnLock(() => this.git(args, viaStdin ? { env, stdin: Buffer.from(specs.join("\0") + "\0") } : { env }));
        return skipped;
      } catch (e) {
        const stderr = e instanceof GitCommandError ? e.stderr : "";
        if (LFS_MISSING_RE.test(stderr)) throw new LfsMissingError(firstLine(stderr));
        if (attempt >= 3) throw e;
        if (!sparse && /outside of your sparse-checkout definition/.test(stderr)) {
          sparse = true;
          continue;
        }
        const bad = unreadablePaths(stderr).filter((p) => !skipped.some((s) => s.path === p));
        if (bad.length === 0 || skipped.length + bad.length > MAX_SKIPPED) throw e;
        for (const p of bad) {
          const tracked = await this.git(["--literal-pathspecs", "ls-files", "--error-unmatch", "--", p], { env, allowFailure: true });
          if (tracked.status === 0) await this.git(["update-index", "--assume-unchanged", "--", p], { env });
          else excluded.push(p);
          skipped.push({ path: p, reason: "unreadable" });
        }
      }
    }
  }

  /**
   * §32: the mods paths (`.claude/**`, `.mcp.json`, `CLAUDE*.md`; git/mods.ts) go into the temporary index whatever
   * .gitignore or the ignore patterns say — `update-index --add --remove` (plumbing: no ignore rules, no pathspec
   * globbing, a file that vanished meanwhile simply drops out). Content that is not captured is a stub blob.
   */
  private async addMods(env: Record<string, string>): Promise<void> {
    const candidates = await modsCandidates(this.root);
    if (candidates.length === 0) return;
    const tooMany = candidates.length > MODS_MAX_FILES;
    const real: string[] = [];
    const stubs: { rel: string; text: string }[] = [];
    for (const c of candidates) {
      const reason = await uncapturedReason(c, tooMany);
      if (reason === null) real.push(c.rel);
      else stubs.push({ rel: c.rel, text: stubText(reason, c.size, c.mtimeMs) });
    }
    if (real.length > 0) await this.git(["update-index", "--add", "--remove", "-z", "--stdin"], { env, stdin: Buffer.from(real.join("\0") + "\0") });
    if (stubs.length === 0) return;
    const dir = join(tmpdir(), `rg-stubs-${randomUUID()}`);
    try {
      await mkdir(dir, { recursive: true });
      const files = stubs.map((_, i) => join(dir, String(i)));
      await Promise.all(stubs.map((s, i) => writeFile(files[i]!, s.text)));
      const out = await this.git(["hash-object", "-w", "--no-filters", "--stdin-paths"], { stdin: Buffer.from(files.join("\n") + "\n") });
      const shas = out.text.split("\n").map((l) => l.trim()).filter(Boolean);
      const info = stubs.map((s, i) => `100644 ${shas[i]}\t${s.rel}\0`).join("");
      await this.git(["update-index", "--add", "-z", "--index-info"], { env, stdin: Buffer.from(info) });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // MARK: wave4b w4b-bigturn — §39.1
  /** The untracked, not ignored files (the same rules as the snapshot's `add -A`) at least `largeFileBytes` large. */
  private async largeUntracked(env: Record<string, string>, excludesFile: string | null): Promise<LargeFile[]> {
    const limit = this.largeFileBytes ?? largeFileLimit();
    if (limit <= 0) return [];
    const args = [...(excludesFile ? ["-c", `core.excludesFile=${excludesFile}`] : []), "ls-files", "-z", "--others", "--exclude-standard"];
    const out = await this.git(args, { env, allowFailure: true });
    if (out.status !== 0) return [];
    return findLargeFiles(this.root, nulSplit(out.stdout), limit);
  }

  /** §39.1: a stub blob (size + mtime) for each large file, put into the temporary index in its place. */
  private async addLargeStubs(env: Record<string, string>, large: readonly LargeFile[]): Promise<void> {
    if (large.length === 0) return;
    const dir = join(tmpdir(), `rg-stubs-${randomUUID()}`);
    try {
      await mkdir(dir, { recursive: true });
      const files = large.map((_, i) => join(dir, String(i)));
      await Promise.all(large.map((l, i) => writeFile(files[i]!, largeStubText(l.size, l.mtimeMs))));
      const out = await this.git(["hash-object", "-w", "--no-filters", "--stdin-paths"], { stdin: Buffer.from(files.join("\n") + "\n") });
      const shas = out.text.split("\n").map((l) => l.trim()).filter(Boolean);
      const info = large.map((l, i) => `100644 ${shas[i]}\t${l.path}\0`).join("");
      await this.git(["update-index", "--add", "-z", "--index-info"], { env, stdin: Buffer.from(info) });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** §39.1: true when `tree:path` is a large-file stub (content never captured — never to be written to disk). */
  async isLargeStub(tree: string, path: string): Promise<boolean> {
    const size = await this.git(["cat-file", "-s", `${tree}:${path}`], { allowFailure: true });
    if (size.status !== 0 || Number(size.text.trim()) > STUB_MAX_BYTES) return false;
    const out = await this.git(["cat-file", "-p", `${tree}:${path}`], { allowFailure: true });
    return out.status === 0 && isLargeStubContent(out.stdout);
  }

  /**
   * §39.1: of the `tree:path` pairs, the ones whose blob is a large-file stub (`"<tree>:<path>"` → the size it records)
   * — two `cat-file` batch calls whatever the count (sizes first, then the content of the small blobs only). A path
   * holding a newline is never reported.
   */
  async largeStubs(specs: readonly { tree: string; path: string }[]): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    const asked = specs.filter((s) => !s.path.includes("\n"));
    if (asked.length === 0) return found;
    const input = asked.map((s) => `${s.tree}:${s.path}`);
    const sizes = await this.git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], { stdin: Buffer.from(input.join("\n") + "\n"), allowFailure: true });
    if (sizes.status !== 0) return found;
    const lines = sizes.text.split("\n");
    const small: { spec: string; sha: string }[] = [];
    input.forEach((spec, i) => {
      const m = /^([0-9a-f]{40,64}) (\d+)$/.exec(lines[i] ?? "");
      if (m && Number(m[2]) <= STUB_MAX_BYTES) small.push({ spec, sha: m[1]! });
    });
    if (small.length === 0) return found;
    const shas = [...new Set(small.map((s) => s.sha))];
    const blobs = await this.git(["cat-file", "--batch"], { stdin: Buffer.from(shas.join("\n") + "\n"), allowFailure: true });
    if (blobs.status !== 0) return found;
    const stubShas = new Map<string, number>();
    const buf = blobs.stdout;
    let at = 0;
    while (at < buf.length) {
      const nl = buf.indexOf(0x0a, at);
      if (nl < 0) break;
      const header = /^([0-9a-f]{40,64}) \S+ (\d+)$/.exec(buf.subarray(at, nl).toString("utf8"));
      if (!header) break;
      const len = Number(header[2]);
      const size = largeStubSize(buf.subarray(nl + 1, nl + 1 + len));
      if (size !== null) stubShas.set(header[1]!, size);
      at = nl + 1 + len + 1;
    }
    for (const s of small) {
      const size = stubShas.get(s.sha);
      if (size !== undefined) found.set(s.spec, size);
    }
    return found;
  }

  /**
   * `tree` with the mods paths (§32) as the worktree holds them now — for a review snapshotted before mods were
   * captured: its A gains today's mods entries, so the next B shows no phantom additions (their earlier changes are
   * simply not part of that review).
   */
  async withMods(tree: string): Promise<string> {
    const tmpIndex = join(tmpdir(), `rg-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await this.git(["read-tree", tree], { env });
      await this.addMods(env);
      return (await this.git(["write-tree"], { env })).text.trim();
    } finally {
      await rm(tmpIndex, { force: true }).catch(() => undefined);
      await rm(tmpIndex + ".lock", { force: true }).catch(() => undefined);
    }
  }

  /** True when `tree:path` is a mods stub (§32): content the snapshot did not capture, never to be written to disk. */
  async isModsStub(tree: string, path: string): Promise<boolean> {
    if (!isModsPath(path)) return false;
    const out = await this.git(["cat-file", "-p", `${tree}:${path}`], { allowFailure: true });
    return out.status === 0 && isStubContent(out.stdout);
  }

  /**
   * `tree` with `paths` replaced by their current worktree state (added, updated or removed), built
   * through a temporary index like `snapshot()`; the user's index is never touched.
   */
  async overlayWorktree(tree: string, paths: string[]): Promise<string> {
    if (paths.length === 0) return tree;
    const tmpIndex = join(tmpdir(), `rg-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await this.git(["read-tree", tree], { env });
      // MARK: wave4 w4-install: the paths on stdin — hundreds of them overflow a Windows command line.
      await this.git(["update-index", "--add", "--remove", "-z", "--stdin"], { env, stdin: Buffer.from(paths.join("\0") + "\0") });
      return (await this.git(["write-tree"], { env })).text.trim();
    } finally {
      await rm(tmpIndex, { force: true }).catch(() => undefined);
      await rm(tmpIndex + ".lock", { force: true }).catch(() => undefined);
    }
  }

  /**
   * `tree` with the changes of commits `from..to` applied (a temporary index; the user's index and worktree are never
   * touched); null when they do not apply on it (`tree` changed the same lines). §46 `keepConflicts`: a file whose change
   * conflicts keeps its content from `tree` instead — what applies is carried, null only when the patch cannot apply at all.
   */
  async carryCommits(tree: string, from: string, to: string, opts: { keepConflicts?: boolean } = {}): Promise<string | null> {
    // Plumbing-safe whatever the user's config says (`diff.noprefix`, `diff.mnemonicPrefix`, `color.ui=always`).
    const patch = await this.git(["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color",
      "--src-prefix=a/", "--dst-prefix=b/", from, to]);
    if (patch.stdout.length === 0) return tree;
    const tmpIndex = join(tmpdir(), `rg-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await this.git(["read-tree", tree], { env });
      const apply = (stdin: Buffer) => this.git(["apply", "--cached", "--3way", "--whitespace=nowarn"], { env, stdin, allowFailure: true });
      let failed = (await apply(patch.stdout)).status !== 0;
      let unmerged = await this.git(["ls-files", "-u", "-z"], { env });
      if (failed && unmerged.stdout.length === 0 && opts.keepConflicts) {
        // One file git cannot apply at all (a rename whose old file we changed, a deletion of a file we changed, a file
        // already there) refuses the whole patch and applies nothing: each file then goes on its own, and one that does
        // not apply keeps `tree`'s content.
        for (const one of splitPatch(patch.stdout)) await apply(one);
        failed = false;
        unmerged = await this.git(["ls-files", "-u", "-z"], { env });
      }
      if (unmerged.stdout.length > 0) {
        // `mode sha stage<TAB>path`: drop every stage of a conflicted path, then put back stage 2 — `tree`'s own entry.
        const entries = nulSplit(unmerged.stdout).map((e) => /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(e)).filter((m) => m !== null);
        if (!opts.keepConflicts || entries.length === 0) return null;
        const lines = [...new Set(entries.map((m) => m[4]!))].map((p) => `0 ${"0".repeat(entries[0]![2]!.length)}\t${p}`);
        for (const m of entries) if (m[3] === "2") lines.push(`${m[1]} ${m[2]} 0\t${m[4]}`);
        await this.git(["update-index", "-z", "--index-info"], { env, stdin: Buffer.from(lines.join("\0") + "\0") });
      } else if (failed) return null;
      return (await this.git(["write-tree"], { env })).text.trim();
    } finally {
      await rm(tmpIndex, { force: true }).catch(() => undefined);
      await rm(tmpIndex + ".lock", { force: true }).catch(() => undefined);
    }
  }

  /**
   * The subset of repo-relative `paths` that `.gitignore` / `info/exclude` hide from `snapshot()`
   * (`git check-ignore -z --stdin`; tracked files are never reported).
   */
  /**
   * `files` without the deletions that are not deletions: an A taken before a `.gitignore` rule hid a file still has it,
   * the snapshot after leaves it out — the file is on disk, now ignored, and was never deleted.
   */
  async dropIgnoredDeletions<T extends { path: string; status: string }>(files: T[]): Promise<T[]> {
    const deleted = files.filter((f) => f.status === "D").map((f) => f.path);
    if (deleted.length === 0) return files;
    const ignored = new Set(await this.ignored(deleted));
    if (ignored.size === 0) return files;
    const present = new Set<string>();
    for (const p of ignored) if (await lstat(this.fsPath(p)).then(() => true, () => false)) present.add(p);
    return present.size === 0 ? files : files.filter((f) => !(f.status === "D" && present.has(f.path)));
  }

  async ignored(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const out = await this.git(["check-ignore", "-z", "--stdin"], { stdin: Buffer.from(paths.join("\0") + "\0"), allowFailure: true });
    // exit 1 = nothing ignored; 128 = fatal (e.g. a path outside the repository)
    if (out.status !== 0) return [];
    return nulSplit(out.stdout);
  }

  /** `git update-ref` on `ref` (`refs/reviewgate/*`), or delete it when `sha` is null. */
  async pinRef(ref: string, sha: string | null): Promise<void> {
    if (sha === null) await this.git(["update-ref", "-d", ref], { allowFailure: true });
    else await this.git(["update-ref", ref, sha]);
  }

  /** What `ref` points at; null when it does not exist. */
  async refValue(ref: string): Promise<string | null> {
    const out = await this.git(["rev-parse", "--verify", "--quiet", ref], { allowFailure: true });
    return out.status === 0 ? out.text.trim() || null : null;
  }

  /** True when every object exists (`git cat-file -e`). */
  async hasObjects(shas: string[]): Promise<boolean> {
    for (const sha of shas) {
      const out = await this.git(["cat-file", "-e", sha], { allowFailure: true });
      if (out.status !== 0) return false;
    }
    return true;
  }

  /** Deletes every ref under `prefix` (`refs/reviewgate/<ns>/history/<id>/`, `refs/reviewgate/<ns>/`) in one `update-ref --stdin`. */
  async deleteRefsUnder(prefix: string): Promise<void> {
    const refs = await this.refsUnder(prefix);
    if (refs.length === 0) return;
    await this.git(["update-ref", "--stdin"], { stdin: Buffer.from(refs.map((r) => `delete ${r}\n`).join("")), allowFailure: true });
  }

  /** Every ref name under `prefix` (`git for-each-ref`); [] on failure. */
  async refsUnder(prefix: string): Promise<string[]> {
    const out = await this.git(["for-each-ref", "--format=%(refname)", prefix], { allowFailure: true });
    if (out.status !== 0) return [];
    return out.text.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /** True when `ref` resolves to `sha` (both must exist). */
  async refIs(ref: string, sha: string): Promise<boolean> {
    const out = await this.git(["rev-parse", "--verify", "--quiet", ref], { allowFailure: true });
    return out.status === 0 && out.text.trim() === sha;
  }

  // MARK: - Diff

  async changes(a: string, b: string): Promise<ChangedFile[]> {
    const entries = await this.nameStatus(a, b);

    // numstat -z: "added\tdeleted\tpath\0" or, for renames, "added\tdeleted\t\0old\0new\0"
    // (the trailing tab is still there, so the third tab-field is empty).
    const numOut = await this.git(["diff-tree", "-r", "-M", "-z", "--numstat", a, b]);
    const counts = new Map<string, { added: number; deleted: number; isBinary: boolean }>();
    const fields = nulSplit(numOut.stdout);
    let i = 0;
    while (i < fields.length) {
      const parts = splitTabs(fields[i]!, 3);
      if (parts.length < 2) {
        i += 1;
        continue;
      }
      const isBinary = parts[0] === "-";
      const added = parseInt(parts[0]!, 10) || 0;
      const deleted = parseInt(parts[1]!, 10) || 0;
      let path: string;
      if (parts.length === 3 && parts[2] !== "") {
        path = parts[2]!;
        i += 1;
      } else {
        if (i + 2 >= fields.length) break;
        path = fields[i + 2]!;
        i += 3;
      }
      counts.set(path, { added, deleted, isBinary });
    }

    return entries.map((e) => {
      const c = counts.get(e.path) ?? { added: 0, deleted: 0, isBinary: false };
      return {
        path: e.path,
        oldPath: e.oldPath,
        status: e.status,
        added: c.added,
        deleted: c.deleted,
        isBinary: c.isBinary,
        tools: [],
        toolUseIds: [],
        state: "pending",
        ...modeFields(e),
      };
    });
  }

  /**
   * Single-file unified patch. When `oldPath` is omitted the rename target is looked up so both
   * paths are passed to git; pass it explicitly (from `changes`) to skip that extra call.
   */
  async patch(a: string, b: string, path: string, oldPath?: string | null): Promise<string> {
    if (oldPath === undefined) {
      oldPath = (await this.nameStatus(a, b)).find((e) => e.path === path)?.oldPath ?? null;
    }
    const args = ["diff-tree", "-r", "-M", "-p", "--no-color", a, b, "--", path];
    if (oldPath && oldPath !== path) args.push(oldPath);
    return (await this.git(args)).text;
  }

  // MARK: - Revert

  /** Restores `file` on disk to its content in tree `a`. Never touches the index. */
  async revert(file: Pick<ChangedFile, "path" | "oldPath" | "status">, a: string): Promise<void> {
    switch (file.status) {
      case "A":
        await this.removeFile(file.path);
        break;
      case "R":
        await this.removeFile(file.path);
        await this.restore(file.oldPath ?? file.path, a);
        break;
      default:
        await this.restore(file.path, a);
    }
  }

  private async restore(path: string, tree: string): Promise<void> {
    // §32: a stub stands for content that was never captured — writing it would destroy the real file.
    if (await this.isModsStub(tree, path)) throw new Error(`${path} was not captured (too large / binary): it cannot be restored`);
    // MARK: wave4b w4b-bigturn — §39.1: nor is a large-file stub.
    if (await this.isLargeStub(tree, path)) throw new Error(`${path} was not captured (too large): it cannot be restored`);
    const out = await this.git(["restore", `--source=${tree}`, "--worktree", "--", path], { allowFailure: true });
    if (out.status !== 0) await this.writeBlob(path, tree);
  }

  // MARK: wave4b w4b-bigturn
  /**
   * §39.1 (robustness-10 ①): `revert` for many files at once — the added files (and a rename's new path) removed, then
   * every other path restored from `a` with one `git restore` (paths on stdin, literal). Stubs (§32 mods, §39.1 large)
   * are refused for the whole batch before anything is written. When the one restore fails (a path git refuses), each
   * remaining path goes through `restore` on its own, as `revert` does — so the result is the same as one `revert` per file.
   */
  async revertMany(files: readonly Pick<ChangedFile, "path" | "oldPath" | "status">[], a: string): Promise<void> {
    const removes: string[] = [];
    const restores: string[] = [];
    for (const f of files) {
      if (f.status === "A") removes.push(f.path);
      else if (f.status === "R") {
        removes.push(f.path);
        restores.push(f.oldPath ?? f.path);
      } else restores.push(f.path);
    }
    for (const p of restores) {
      if (isModsPath(p) && (await this.isModsStub(a, p))) throw new Error(`${p} was not captured (too large / binary): it cannot be restored`);
    }
    const stubs = await this.largeStubs(restores.map((path) => ({ tree: a, path })));
    if (stubs.size > 0) throw new Error(`${[...stubs.keys()][0]!.slice(a.length + 1)} was not captured (too large): it cannot be restored`);
    for (const p of removes) await this.removeFile(p);
    if (restores.length === 0) return;
    const out = await this.git(["restore", `--source=${a}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      allowFailure: true,
      env: { GIT_LITERAL_PATHSPECS: "1" },
      stdin: Buffer.from(restores.join("\0") + "\0"),
    });
    if (out.status === 0) return;
    for (const p of restores) await this.restore(p, a);
  }

  /**
   * Fallback for paths `git restore` refuses: write the blob bytes directly, preserving mode 100755;
   * a symlink entry (120000) becomes a symlink again, never a regular file holding the target text —
   * except on Windows where git itself would write that file (`core.symlinks` not true, or no privilege).
   */
  async writeBlob(path: string, tree: string): Promise<void> {
    const blob = await this.git(["cat-file", "-p", `${tree}:${path}`]);
    const full = this.fsPath(path);
    await mkdir(dirname(full), { recursive: true });
    const mode = await this.treeMode(tree, path);
    if (mode === "120000" && (await this.symlinksEnabled())) {
      const tmp = `${full}.rg-${randomUUID()}`;
      let linked = false;
      try {
        await symlink(blob.stdout.toString("utf8"), tmp);
        linked = true;
        await rename(tmp, full);
        return;
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        // Windows without the symlink privilege: a plain file holding the target, as git itself does then.
        if (linked || process.platform !== "win32") throw e;
      }
    }
    await writeAtomic(full, blob.stdout);
    if (process.platform !== "win32") await chmod(full, mode === "100755" ? 0o755 : 0o644);
  }

  /**
   * Whether a symlink entry is checked out as a symlink: always on POSIX; on Windows only with
   * `core.symlinks=true` (Git for Windows defaults to false and writes a file holding the target).
   */
  private async symlinksEnabled(): Promise<boolean> {
    if (process.platform !== "win32") return true;
    const out = await this.git(["config", "--bool", "core.symlinks"], { allowFailure: true }).catch(() => null);
    return out !== null && out.status === 0 && out.text.trim() === "true";
  }

  /** The tree entry's mode (`100644`, `100755`, `120000` symlink, `160000` submodule, …); null when absent. */
  async treeMode(tree: string, path: string): Promise<string | null> {
    const out = await this.git(["ls-tree", "-z", tree, "--", path], { allowFailure: true });
    if (out.status !== 0) return null;
    // "<mode> <type> <sha>\t<path>\0" — ls-tree also lists a directory of that name; only an exact path counts.
    for (const entry of nulSplit(out.stdout)) {
      const tab = entry.indexOf("\t");
      if (tab < 0 || entry.slice(tab + 1) !== path) continue;
      return entry.slice(0, entry.indexOf(" "));
    }
    return null;
  }

  /** Removes a file and prunes now-empty parent directories up to (not including) the root. */
  private async removeFile(path: string): Promise<void> {
    const full = this.fsPath(path);
    await rm(full, { force: true }).catch(() => undefined);
    let dir = dirname(full);
    while (!samePath(dir, this.root) && isInsidePath(dir, this.root)) {
      let items: string[];
      try {
        items = await readdir(dir);
      } catch {
        break;
      }
      if (items.length > 0) break;
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }

  // MARK: - Content

  /** File bytes: the worktree file when `tree` is null, else `git cat-file -p <tree>:<path>`. */
  async fileContent(path: string, tree: string | null = null): Promise<Buffer> {
    if (tree === null) return readFile(this.fsPath(path));
    return (await this.git(["cat-file", "-p", `${tree}:${path}`])).stdout;
  }

  /** Blob id of `path` in `tree` (`git rev-parse <tree>:<path>`); null when absent. */
  async blobId(tree: string, path: string): Promise<string | null> {
    const out = await this.git(["rev-parse", "--verify", "--quiet", `${tree}:${path}`], { allowFailure: true });
    return out.status === 0 ? out.text.trim() || null : null;
  }

  /** Blob id the worktree file would get from `git add` (clean filters / eol applied); null when missing. */
  async worktreeBlobId(path: string): Promise<string | null> {
    const full = this.fsPath(path);
    if (!(await exists(full))) return null;
    const out = await this.git(["hash-object", `--path=${path}`, "--", full], { allowFailure: true });
    return out.status === 0 ? out.text.trim() || null : null;
  }

  /**
   * True when the worktree entry at `path` is exactly what `tree` holds there: a regular file's bytes through the
   * clean filters (`worktreeBlobId`, as `git add` would store them), a symlink's target, absent when the tree has
   * no such path (a directory of that name is no file). A submodule (160000) is not compared (always true).
   */
  async worktreeMatches(tree: string, path: string): Promise<boolean> {
    const [mode, want] = await Promise.all([this.treeMode(tree, path), this.blobId(tree, path)]);
    const full = this.fsPath(path);
    const st = await lstat(full).catch(() => null);
    if (mode === null || want === null) return st === null || st.isDirectory();
    if (mode === "160000") return true;
    if (st === null) return false;
    if (mode === "120000") {
      if (!st.isSymbolicLink()) return false;
      const target = await readlink(full).catch(() => null);
      if (target === null) return false;
      const out = await this.git(["hash-object", "--no-filters", "--stdin"], { stdin: Buffer.from(target, "utf8"), allowFailure: true });
      return out.status === 0 && out.text.trim() === want;
    }
    if (!st.isFile()) return false;
    return (await this.worktreeBlobId(path)) === want;
  }

  // MARK: wave4b w4b-bigturn
  /**
   * §39.1 (robustness-10 ①): `worktreeMatches` for many paths — one `ls-tree -r` of `tree` and one
   * `hash-object --stdin-paths` (clean filters per path, as `git add`) for the regular files, instead of three git calls
   * per path. Symlinks, paths holding a newline and a failed hash call fall back to `worktreeMatches`. Returns the
   * paths that match.
   */
  async worktreeMatchesMany(tree: string, paths: readonly string[]): Promise<Set<string>> {
    const matched = new Set<string>();
    if (paths.length === 0) return matched;
    const listing = await this.git(["ls-tree", "-r", "-z", "--full-tree", tree]);
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const e of nulSplit(listing.stdout)) {
      const tab = e.indexOf("\t");
      if (tab < 0) continue;
      const [mode, , sha] = e.slice(0, tab).split(" ");
      if (mode && sha) entries.set(e.slice(tab + 1), { mode, sha });
    }
    const unique = [...new Set(paths)];
    const stats = new Map<string, Awaited<ReturnType<typeof lstat>> | null>();
    for (let i = 0; i < unique.length; i += 64) {
      const part = unique.slice(i, i + 64);
      const st = await Promise.all(part.map((p) => lstat(this.fsPath(p)).catch(() => null)));
      part.forEach((p, k) => stats.set(p, st[k] ?? null));
    }
    const regular: string[] = [];
    const slow: string[] = [];
    for (const p of unique) {
      const want = entries.get(p);
      const st = stats.get(p) ?? null;
      if (!want) {
        if (st === null || st.isDirectory()) matched.add(p);
      } else if (want.mode === "160000") matched.add(p);
      else if (st === null) continue;
      else if (want.mode === "120000" || p.includes("\n") || p.startsWith('"')) slow.push(p);
      else if (st.isFile()) regular.push(p);
    }
    if (regular.length > 0) {
      const out = await this.git(["hash-object", "--stdin-paths"], { stdin: Buffer.from(regular.join("\n") + "\n"), allowFailure: true });
      const shas = out.status === 0 ? out.text.split("\n").map((l) => l.trim()).filter(Boolean) : [];
      if (shas.length === regular.length) regular.forEach((p, i) => (shas[i] === entries.get(p)!.sha ? matched.add(p) : undefined));
      else slow.push(...regular);
    }
    for (const p of slow) if (await this.worktreeMatches(tree, p)) matched.add(p);
    return matched;
  }

  /**
   * Writes repository-form `content` (as stored in a blob) to the worktree file `path`: stored as a
   * blob, smudged back with `cat-file --filters` (eol / smudge filters like a checkout), written
   * atomically, keeping the file's mode.
   */
  async writeWorktreeContent(path: string, content: Buffer): Promise<void> {
    const full = this.fsPath(path);
    const st = await lstat(full).catch(() => null);
    // Writing through `rename` would replace a symlink (or a submodule directory) with a regular file.
    if (st && !st.isFile()) throw new Error(`${path} is not a regular file`);
    const sha = (await this.git(["hash-object", "-w", "--no-filters", "--stdin"], { stdin: content })).text.trim();
    const bytes = (await this.git(["cat-file", "--filters", `--path=${path}`, sha])).stdout;
    const mode = st?.mode;
    await writeAtomic(full, bytes);
    if (mode !== undefined && process.platform !== "win32") await chmod(full, mode & 0o7777);
  }

  // MARK: - Internals

  /**
   * `diff-tree -z --raw`: ":<old mode> <new mode> <sha> <sha> S\0path\0" or "…R<score>\0old\0new\0" (wave4b w4b-files:
   * the raw form of what `--name-status` printed, so the modes and a rename's score come with the same call).
   */
  private async nameStatus(a: string, b: string): Promise<NameStatusEntry[]> {
    const out = await this.git(["diff-tree", "-r", "-M", "-z", "--raw", a, b]);
    const fields = nulSplit(out.stdout);
    const entries: NameStatusEntry[] = [];
    let i = 0;
    while (i + 1 < fields.length) {
      const raw = parseRawHead(fields[i]!);
      const letter = raw.status.charAt(0);
      if (letter === "R" || letter === "C") {
        if (i + 2 >= fields.length) break;
        entries.push({ path: fields[i + 2]!, oldPath: fields[i + 1]!, status: letter === "R" ? "R" : "X", ...raw.meta });
        i += 3;
      } else {
        entries.push({ path: fields[i + 1]!, oldPath: null, status: toStatus(letter), ...raw.meta });
        i += 2;
      }
    }
    return entries;
  }

  /** MARK: wave4b w4b-files — §40.2: the size in bytes of `path` in `tree` (a binary's "12KB → 14KB"); null when absent. */
  async blobSize(tree: string, path: string): Promise<number | null> {
    const out = await this.git(["cat-file", "-s", `${tree}:${path}`], { allowFailure: true });
    if (out.status !== 0) return null;
    const n = Number.parseInt(out.text.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
}

// MARK: wave4b w4b-files — §40.2
const NULL_MODE = "000000";
type ModeMeta = Pick<NameStatusEntry, "oldMode" | "newMode" | "similarity">;

/** ":100644 100755 <sha> <sha> M" → the status ("M", "R100") with its modes / similarity; a bare status letter passes. */
function parseRawHead(head: string): { status: string; meta: ModeMeta } {
  if (!head.startsWith(":")) return { status: head, meta: {} };
  const parts = head.slice(1).split(" ");
  const status = parts[4] ?? "";
  const meta: ModeMeta = {};
  if (parts[0] && parts[0] !== NULL_MODE) meta.oldMode = parts[0];
  if (parts[1] && parts[1] !== NULL_MODE) meta.newMode = parts[1];
  const score = /^[RC](\d+)$/.exec(status);
  if (score) meta.similarity = Number.parseInt(score[1]!, 10);
  return { status, meta };
}

/** What a changed file carries: both modes when they differ, `newMode` of a new executable file, a rename's similarity. */
function modeFields(e: NameStatusEntry): ModeMeta {
  const out: ModeMeta = {};
  if (e.oldMode !== undefined && e.newMode !== undefined && e.oldMode !== e.newMode) {
    out.oldMode = e.oldMode;
    out.newMode = e.newMode;
  } else if (e.oldMode === undefined && e.newMode === "100755") {
    out.newMode = e.newMode;
  }
  if (e.similarity !== undefined && e.status === "R") out.similarity = e.similarity;
  return out;
}

function toStatus(letter: string): ChangeStatus {
  return letter === "A" || letter === "M" || letter === "D" || letter === "R" ? letter : "X";
}

/** `String.split("\t", maxSplits)` with Swift semantics: at most `max` parts, the last keeps the rest. */
function splitTabs(s: string, max: number): string[] {
  const parts: string[] = [];
  let rest = s;
  while (parts.length < max - 1) {
    const i = rest.indexOf("\t");
    if (i < 0) break;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  parts.push(rest);
  return parts;
}

function isAbsoluteGitPath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(full: string, data: Buffer): Promise<void> {
  const tmp = `${full}.rg-${randomUUID()}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, full);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/**
 * Windows Defender can hold `rg-index-*` briefly during `git add -A`: retry once after 100ms.
 * A concurrent writer under the worktree (e.g. a user hook writing/deleting transient files) can
 * also make `git add -A` fail transiently even outside excluded patterns: retry up to 3 times
 * with a 150ms backoff for those.
 */
async function retryOnLock<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof GitCommandError ? e.stderr : "";
    if (process.platform === "win32" && /EBUSY|EPERM|Permission denied|being used by another process/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 100));
      return fn();
    }
    if (attempt < 3 && /unable to stat|No such file or directory|index\.lock/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 150));
      return retryOnLock(fn, attempt + 1);
    }
    throw e;
  }
}

/**
 * Renders ignore patterns (prefix, or `*`-glob — see `matchesIgnore`) as `core.excludesFile` lines.
 * Prefix patterns are anchored to the repo root with a leading `/` (matching `matchesIgnore`'s
 * root-relative-prefix semantics, and avoiding git's refusal to `add` paths under a name that's
 * *also* gitignored via an unanchored pattern); glob patterns are passed through unchanged.
 */
function excludesFileLines(patterns: string[]): string {
  return (
    patterns
      .filter((p) => p.length > 0)
      .map((p) => (p.includes("*") || p.startsWith("/") ? p : `/${p}`))
      .join("\n") + "\n"
  );
}

/** The non-glob (prefix) patterns, normalized to pathspecs for `git rm --cached`. */
function prefixPatterns(patterns: string[]): string[] {
  return patterns
    .map((raw) => (raw.startsWith("/") ? raw.slice(1) : raw))
    .filter((p) => p.length > 0 && !p.includes("*"))
    .map((p) => (p.endsWith("/") ? p.slice(0, -1) : p));
}

/** A `git diff` patch cut into one patch per file (a line of a file's content never starts with `diff --git `). */
function splitPatch(patch: Buffer): Buffer[] {
  return patch.toString("latin1").split(/(?=^diff --git )/m).filter((p) => p.startsWith("diff --git ")).map((p) => Buffer.from(p, "latin1"));
}
