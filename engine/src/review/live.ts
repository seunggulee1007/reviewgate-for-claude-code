import type { ChangedFile, GitCheckpoint } from "../git/checkpoint.js";
import { matchesIgnore } from "../git/ignore.js";
import { isModsPath } from "../git/mods.js";
import { normalizeForCompare, toRepoRelative } from "../platform/paths.js";
import type { GeneratedKind, LiveChangedFile, LiveChangesEvent } from "../protocol.js";
import type { ToolFileEntry } from "../session/events.js";
import { READ_ONLY_TOOLS } from "../session/hooks.js";
import { classifyGenerated } from "./detail.js";

/**
 * §34.6 live changes (docs/PROTOCOL.md §34.6): what the running turn changed so far — its own start tree → a snapshot
 * of the worktree now — read-only, never persisted. Cheap on a large repository: a snapshot is only taken when none can
 * be reused.
 *
 * - Any live tree is reused while ≤ 2 s old (`LIVE_REUSE_MS`).
 * - Beyond that, a tree taken while no call that can write was running is reused as long as no such call started since
 *   (≤ 30 s, `LIVE_IDLE_REUSE_MS`, so an editor's changes outside Claude still show up): the worktree as Claude left it
 *   cannot have changed. Writers are every tool but the known read-only ones (Read, Grep, Agent …); their tool_use starts
 *   them, their tool_result ends them.
 * - Every post-Bash snapshot the session already takes (§12, hooks.ts) becomes the live tree (`bash_snapshot`) — free.
 * - The file list of a (base, live tree) pair is computed once.
 */

/** Any live tree is reused for this long. */
export const LIVE_REUSE_MS = 2000;
/** A tree no writer could have invalidated is reused for this long. */
export const LIVE_IDLE_REUSE_MS = 30_000;
/** `live_changes.files` holds at most this many files (path order; `truncated` beyond). */
export const LIVE_MAX_FILES = 200;

/**
 * Tools that never write the worktree: their calls never make a live tree stale (everything else may write). The
 * permission layer's read-only tools plus those that only talk (web, questions, plan mode) or spawn — an Agent's own
 * calls are tracked one by one.
 */
const NON_WRITING_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS,
  "WebFetch", "WebSearch", "Agent", "Task", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "ListMcpResourcesTool",
  "ReadMcpResourceTool", "TaskOutput", "KillBash",
]);

export function isWriterTool(name: string): boolean {
  return !NON_WRITING_TOOLS.has(name);
}

type LiveTree = { tree: string; at: number; gen: number; idle: boolean };

/** The live list of one (base, live tree): what `live_changes` shows, and every changed file for `live_diff`. */
export type LiveList = { files: LiveChangedFile[]; truncated: boolean; all: ChangedFile[] };

/** The live-tree cache of the running turn (one per engine; reset at every turn start and end). */
export class LiveView {
  /** Writer calls started this turn. */
  private gen = 0;
  /** Writer calls started and not finished (tool_result / post-Bash snapshot). */
  private readonly running = new Set<string>();
  private latest: LiveTree | null = null;
  private list: { key: string; value: LiveList } | null = null;
  /** Absolute path → repo-relative (null outside), for `turnFileCount`. */
  private readonly rel = new Map<string, string | null>();
  /** Snapshots taken for the live view this turn (the engine logs it at the turn's end). */
  snapshotsTaken = 0;

  constructor(private readonly now: () => number) {}

  /** A turn starts or ends: nothing of the last one is reused. */
  reset(): void {
    this.gen = 0;
    this.running.clear();
    this.latest = null;
    this.list = null;
    this.rel.clear();
    this.snapshotsTaken = 0;
  }

  onToolUse(id: string, name: string): void {
    if (!isWriterTool(name)) return;
    this.gen += 1;
    this.running.add(id);
  }

  onToolResult(id: string): void {
    this.running.delete(id);
  }

  /** A post-Bash snapshot (its call has finished running when the hook takes it). */
  onBashSnapshot(id: string, tree: string): void {
    this.running.delete(id);
    this.latest = { tree, at: this.now(), gen: this.gen, idle: this.running.size === 0 };
  }

  /** The live tree that can stand for "now", or null when a snapshot is needed. */
  reusable(): { tree: string; at: number } | null {
    const t = this.latest;
    if (!t) return null;
    const age = this.now() - t.at;
    if (age >= 0 && age <= LIVE_REUSE_MS) return t;
    if (t.idle && t.gen === this.gen && this.running.size === 0 && age >= 0 && age <= LIVE_IDLE_REUSE_MS) return t;
    return null;
  }

  /** The latest live tree of the turn, however old (`live_diff` diffs against what the list showed). */
  get latestTree(): { tree: string; at: number } | null {
    return this.latest;
  }

  /** A reusable tree, else `take()`'s (recorded as the latest). */
  async liveTree(take: () => Promise<string>): Promise<{ tree: string; at: number }> {
    const reuse = this.reusable();
    if (reuse) return reuse;
    const before = { gen: this.gen, idle: this.running.size === 0 };
    const at = this.now();
    const tree = await take();
    this.snapshotsTaken += 1;
    // A writer that started while git ran may be missing from the tree: it only stands for "now" for 2 s then.
    const t = { tree, at, gen: before.gen, idle: before.idle };
    if (!this.latest || this.latest.at <= at) this.latest = t;
    return t;
  }

  /** The file list of `base` → `tree`, computed once per pair (and ignore patterns): `liveKey`. */
  async files(key: string, compute: () => Promise<LiveList>): Promise<LiveList> {
    if (this.list?.key === key) return this.list.value;
    const value = await compute();
    this.list = { key, value };
    return value;
  }

  /**
   * §34.6 `hud.turnFiles`: distinct files inside the repository (not hidden by the ignore patterns) that the running
   * turn's edit tools (a failed call dropped) and post-Bash snapshots touched so far.
   */
  turnFileCount(entries: Iterable<ToolFileEntry>, root: string, ignore: readonly string[]): number {
    const seen = new Set<string>();
    for (const e of entries) {
      if ((e.toolUseIds?.length ?? 0) === 0) continue;
      let rel = this.rel.get(e.path);
      if (rel === undefined) {
        rel = toRepoRelative(e.path, root);
        this.rel.set(e.path, rel);
      }
      if (rel === null || hidden(rel, ignore)) continue;
      seen.add(normalizeForCompare(rel));
    }
    return seen.size;
  }
}

/** Hidden by the app's ignore patterns — never a mods path (§32). */
function hidden(path: string, ignore: readonly string[]): boolean {
  return !isModsPath(path) && matchesIgnore(path, [...ignore]);
}

function hiddenFile(f: Pick<ChangedFile, "path" | "oldPath">, ignore: readonly string[]): boolean {
  return hidden(f.path, ignore) || (f.oldPath !== null && hidden(f.oldPath, ignore));
}

/** The cache key of a live list. */
export function liveKey(base: string, tree: string, ignore: readonly string[]): string {
  return `${base}\0${tree}\0${ignore.join("\n")}`;
}

/** The live list of `base` → `tree`: path order, ignore patterns applied, at most `LIVE_MAX_FILES`, `generated` set. */
export async function liveFileList(cp: GitCheckpoint, base: string, tree: string, ignore: readonly string[]): Promise<LiveList> {
  const all = (await cp.changes(base, tree)).filter((f) => !hiddenFile(f, ignore));
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shown = all.slice(0, LIVE_MAX_FILES);
  const kinds = await classifyGenerated(cp, shown).catch(() => new Map<string, GeneratedKind>());
  const files: LiveChangedFile[] = shown.map((f) => {
    const kind = kinds.get(f.path);
    return { path: f.path, oldPath: f.oldPath, status: f.status, added: f.added, deleted: f.deleted, isBinary: f.isBinary, inReview: false, ...(kind ? { generated: kind } : {}) };
  });
  return { files, truncated: all.length > LIVE_MAX_FILES, all };
}

/** The `live_changes` reply: `files` with `inReview` against the standing review's paths. */
export function liveChangesEvent(args: {
  running: boolean;
  turn: number | null;
  base: string | null;
  live: { tree: string; at: number } | null;
  list: Pick<LiveList, "files" | "truncated"> | null;
  reviewPaths: ReadonlySet<string>;
  now: number;
}): LiveChangesEvent {
  const files = (args.list?.files ?? []).map((f) => ({ ...f, inReview: args.reviewPaths.has(f.path) || (f.oldPath !== null && args.reviewPaths.has(f.oldPath)) }));
  return {
    type: "live_changes",
    running: args.running,
    turn: args.turn,
    baseTree: args.base,
    liveTree: args.live?.tree ?? null,
    at: new Date(args.live?.at ?? args.now).toISOString(),
    files,
    ...(args.list?.truncated ? { truncated: true as const } : {}),
  };
}
