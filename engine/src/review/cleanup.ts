import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { GitCheckpoint } from "../git/checkpoint.js";
import type { ReviewHistoryEntry } from "../protocol.js";
import { CHECKPOINTS_DIR, loadCheckpoints, saveCheckpoints, type CheckpointFile } from "./checkpoints.js";
import { saveHistory } from "./history.js";
import { refPrefix } from "./persist.js";

/**
 * MARK: wave4b w4b-bigturn — §39.1 (robustness-11 ④): Settings › [오래된 리뷰 기록 정리]. The review history keeps 50
 * rounds and every chat 60 checkpoint records; each pins its snapshot trees with a ref under `refs/reviewgate/<ns>/`, so
 * `git gc` never frees them (a 2 GB file captured once stays as long as its round). This drops the rounds and records
 * beyond the newest `keep`, deletes **only their refs** (`refs/reviewgate/<ns>/history/<id>/…`, `…/turns/<id>/…` — never a
 * branch, tag, stash, note or reflog) and runs `git prune --expire=1.hour.ago`, which frees the loose objects nothing
 * else reaches (reflogs, the index and every other ref keep theirs — git's own rule; an object younger than an hour, which
 * another git command may be about to reference, stays).
 */

export const DEFAULT_CLEANUP_KEEP = 20;
export const MIN_CLEANUP_KEEP = 1;
export const MAX_CLEANUP_KEEP = 1000;
/** The prune leaves objects younger than this (another git process may be about to reference them). */
export const PRUNE_EXPIRE = "1.hour.ago";
const MEASURE_TIMEOUT_MS = 60_000;
const PRUNE_TIMEOUT_MS = 300_000;

export function cleanupKeep(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_CLEANUP_KEEP;
  return Math.min(MAX_CLEANUP_KEEP, Math.max(MIN_CLEANUP_KEEP, Math.round(v)));
}

export type CleanupPlan = {
  keep: number;
  /** History entries kept (newest `keep`, in their order) and dropped. */
  keptHistory: ReviewHistoryEntry[];
  droppedHistory: ReviewHistoryEntry[];
  /** Per chat: the checkpoint file with only its newest `keep` records, and how many go. */
  chats: { chatId: string; file: CheckpointFile; dropped: number }[];
  /** Refs that go — every one under `refs/reviewgate/<ns>/history/` or `…/turns/`. */
  refs: string[];
  /** Loose objects only those refs keep, in bytes on disk; null when not measured. */
  bytes: number | null;
};

/** The chat ids that have a checkpoint file in this worktree's git dir. */
async function checkpointChats(gitDir: string): Promise<string[]> {
  try {
    return (await readdir(join(gitDir, CHECKPOINTS_DIR))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/**
 * What a cleanup keeping the newest `keep` rounds and checkpoint records per chat would remove. `live` overrides a
 * chat's file with the engine's in-memory copy (the open chat). Nothing is written.
 */
export async function planCleanup(opts: {
  cp: GitCheckpoint;
  gitDir: string;
  ns: string;
  history: readonly ReviewHistoryEntry[];
  keep: number;
  live?: { chatId: string; file: CheckpointFile } | null;
  measure?: boolean;
}): Promise<CleanupPlan> {
  const { cp, gitDir, ns, keep } = opts;
  const prefix = refPrefix(ns);
  const keptHistory = opts.history.slice(-keep);
  const droppedHistory = opts.history.slice(0, Math.max(0, opts.history.length - keep));
  const chats: CleanupPlan["chats"] = [];
  const droppedRecordIds: string[] = [];
  const chatIds = new Set(await checkpointChats(gitDir));
  if (opts.live) chatIds.add(opts.live.chatId);
  for (const chatId of [...chatIds].sort()) {
    const file = opts.live?.chatId === chatId ? opts.live.file : loadCheckpoints(gitDir, chatId);
    const drop = file.records.slice(0, Math.max(0, file.records.length - keep));
    if (drop.length === 0) continue;
    droppedRecordIds.push(...drop.map((r) => r.id));
    chats.push({ chatId, file: { ...file, records: file.records.slice(-keep) }, dropped: drop.length });
  }
  // Another chat may still reference a dropped record id (a fork copies none, but be safe): keep those refs.
  const stillReferenced = new Set<string>();
  for (const chatId of chatIds) {
    const planned = chats.find((c) => c.chatId === chatId);
    const file = planned?.file ?? (opts.live?.chatId === chatId ? opts.live.file : loadCheckpoints(gitDir, chatId));
    for (const r of file.records) stillReferenced.add(r.id);
  }
  const keptIds = new Set(keptHistory.map((e) => e.id));
  const refs: string[] = [];
  for (const e of droppedHistory) {
    if (keptIds.has(e.id)) continue;
    refs.push(...(await cp.refsUnder(`${prefix}history/${e.id}/`)));
  }
  for (const id of droppedRecordIds) {
    if (stillReferenced.has(id)) continue;
    refs.push(...(await cp.refsUnder(`${prefix}turns/${id}/`)));
  }
  const safe = refs.filter((r) => r.startsWith(`${prefix}history/`) || r.startsWith(`${prefix}turns/`));
  const bytes = opts.measure === false ? null : await measureFreed(cp, safe).catch(() => null);
  return { keep, keptHistory, droppedHistory, chats, refs: safe, bytes };
}

/**
 * The loose objects reachable from `refs` but from no other `refs/reviewgate/` ref and not from HEAD — their size on
 * disk. An estimate of what the prune frees: an object another branch, a tag or a reflog also reaches is counted but
 * stays (the prune itself follows git's own reachability).
 */
async function measureFreed(cp: GitCheckpoint, refs: readonly string[]): Promise<number> {
  if (refs.length === 0) return 0;
  const drop = new Set(refs);
  const keepTips = new Set<string>();
  const dropTips = new Set<string>();
  const values = await cp.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/reviewgate/"], { allowFailure: true, timeoutMs: MEASURE_TIMEOUT_MS });
  for (const line of values.text.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    (drop.has(line.slice(sp + 1).trim()) ? dropTips : keepTips).add(line.slice(0, sp));
  }
  if (dropTips.size === 0) return 0;
  const head = await cp.git(["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true });
  if (head.status === 0 && head.text.trim()) keepTips.add(head.text.trim());
  // `^<sha>` lines rather than `--not` (which `rev-list --stdin` only reads since git 2.42).
  const input = [...dropTips, ...[...keepTips].map((s) => `^${s}`)];
  const listed = await cp.git(["rev-list", "--objects", "--no-object-names", "--stdin"], {
    stdin: Buffer.from(input.join("\n") + "\n"),
    timeoutMs: MEASURE_TIMEOUT_MS,
  });
  const shas = listed.text.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l));
  if (shas.length === 0) return 0;
  const objOut = await cp.git(["rev-parse", "--git-path", "objects"], { allowFailure: true });
  let objects = objOut.text.trim();
  if (!objects) return 0;
  if (!isAbsolute(objects)) objects = join(cp.root, objects);
  let total = 0;
  const CHUNK = 128;
  for (let i = 0; i < shas.length; i += CHUNK) {
    const part = shas.slice(i, i + CHUNK);
    const sizes = await Promise.all(part.map((s) => lstat(join(objects, s.slice(0, 2), s.slice(2))).then((st) => st.size, () => 0)));
    for (const n of sizes) total += n;
  }
  return total;
}

/**
 * Writes the plan: the trimmed history file and checkpoint files, then deletes the planned refs (one `update-ref --stdin`
 * — refs outside the two app prefixes are never in a plan) and prunes. A prune failure (a lock, a timeout) leaves the
 * objects for the next `git gc`; it does not fail the cleanup.
 */
export async function applyCleanup(cp: GitCheckpoint, gitDir: string, ns: string, plan: CleanupPlan, log: (m: string) => void = () => {}): Promise<void> {
  const prefix = refPrefix(ns);
  if (plan.droppedHistory.length > 0) await saveHistory(gitDir, plan.keptHistory);
  for (const c of plan.chats) saveCheckpoints(gitDir, c.chatId, c.file);
  const refs = plan.refs.filter((r) => r.startsWith(`${prefix}history/`) || r.startsWith(`${prefix}turns/`));
  if (refs.length > 0) await cp.git(["update-ref", "--stdin"], { stdin: Buffer.from(refs.map((r) => `delete ${r}\n`).join("")) });
  try {
    const pruned = await cp.git(["prune", `--expire=${PRUNE_EXPIRE}`], { allowFailure: true, timeoutMs: PRUNE_TIMEOUT_MS });
    if (pruned.status !== 0) log(`history cleanup: prune exited ${pruned.status}: ${pruned.text.slice(0, 200)}`);
  } catch (e) {
    log(`history cleanup: prune: ${e instanceof Error ? e.message : String(e)}`);
  }
}
