import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnCheckpointView } from "../protocol.js";
import { refPrefix } from "./persist.js";

/**
 * Per-chat turn checkpoints (docs/PROTOCOL.md §26): the timeline `rewind` works from. One record per user turn
 * (its start tree, end tree, the files it changed, where the conversation stood right before it) plus one per
 * file rewind (what it restored and the tree afterwards). `<gitdir>/reviewgate/checkpoints/<chatId>.json`;
 * the trees are pinned by `refs/reviewgate/<ns>/turns/<recordId>/start|end`.
 */
export const CHECKPOINTS_DIR = join("reviewgate", "checkpoints");
/** Records kept per chat (oldest dropped; their pins are pruned on the next open). */
export const MAX_CHECKPOINT_RECORDS = 60;
/** Turns listed in `state.session.checkpoints`. */
export const MAX_CHECKPOINT_VIEWS = 50;

/** Where the conversation stood right before a turn: the chat's beginning, or a chain uuid of a CLI session. */
export type ForkPoint = { mode: "fresh" } | { mode: "at"; sessionId: string; uuid: string };

export type CheckpointRecord = {
  id: string;
  kind: "turn" | "rewind";
  /** turn records: transcript turn number */
  turn: number | null;
  prompt: string;
  startedAt: string;
  endedAt: string | null;
  /** The worktree when the turn was sent (snapshot, ignore patterns applied); null for a rewind record or when it failed. */
  startTree: string | null;
  /** The worktree after the turn's collection / after the rewind; null until then. */
  endTree: string | null;
  /** Repo-relative paths that changed between start and end (both sides of a rename); null until collected. */
  files: string[] | null;
  /** null = unknown (the conversation cannot be rewound to right before this turn). */
  before: ForkPoint | null;
  /** The CLI session the turn ran in and its last top-level assistant chain uuid (the fork point of the next turn). */
  cliSessionId: string | null;
  lastUuid: string | null;
  /** A turn of the chat this chat was rewound from, after the rewind point (kept for the file timeline, never listed). */
  abandoned?: true;
  /** §32: its trees include the mods paths (records of older engines do not: a file rewind to them leaves mods alone). */
  modsCaptured?: true;
  // MARK: wave2 check-engine
  /** §35.11: the turn's files nothing of Claude's explains (§31 origin `external` at its collection): a file rewind leaves them. */
  external?: string[];
};

export type CheckpointFile = {
  version: 1;
  records: CheckpointRecord[];
  /** A `rewind` fork the CLI has not materialized yet: started as `resume: sessionId, resumeSessionAt: uuid, forkSession` until it reports in. */
  pendingFork?: { sessionId: string; uuid: string } | null;
};

export function checkpointFilePath(gitDir: string, chatId: string): string {
  return join(gitDir, CHECKPOINTS_DIR, `${chatId}.json`);
}

export function checkpointRefs(ns: string, id: string): { start: string; end: string } {
  return { start: `${refPrefix(ns)}turns/${id}/start`, end: `${refPrefix(ns)}turns/${id}/end` };
}

export function newRecord(kind: CheckpointRecord["kind"], fields: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    kind,
    turn: null,
    prompt: "",
    startedAt: new Date().toISOString(),
    endedAt: null,
    startTree: null,
    endTree: null,
    files: null,
    before: null,
    cliSessionId: null,
    lastUuid: null,
    ...fields,
  };
}

/** Synchronous read (small file, read on every chat bind); a missing / corrupt / foreign file is empty. */
export function loadCheckpoints(gitDir: string, chatId: string): CheckpointFile {
  try {
    const o = JSON.parse(readFileSync(checkpointFilePath(gitDir, chatId), "utf8")) as Partial<CheckpointFile>;
    if (o && o.version === 1 && Array.isArray(o.records)) {
      return { version: 1, records: o.records.filter(isRecord), pendingFork: isForkAt(o.pendingFork) ? o.pendingFork : null };
    }
  } catch {
    // none yet
  }
  return { version: 1, records: [], pendingFork: null };
}

export function saveCheckpoints(gitDir: string, chatId: string, file: CheckpointFile): void {
  const path = checkpointFilePath(gitDir, chatId);
  mkdirSync(join(gitDir, CHECKPOINTS_DIR), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...file, records: file.records.slice(-MAX_CHECKPOINT_RECORDS) }));
  renameSync(tmp, path);
}

export function removeCheckpoints(gitDir: string, chatId: string): void {
  rmSync(checkpointFilePath(gitDir, chatId), { force: true });
}

export function renameCheckpoints(gitDir: string, from: string, to: string): void {
  try {
    renameSync(checkpointFilePath(gitDir, from), checkpointFilePath(gitDir, to));
  } catch {
    // nothing recorded yet
  }
}

/** Every record id any chat of the worktree still references (the pins of all others can go). */
export function referencedRecordIds(gitDir: string): Set<string> {
  const ids = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(join(gitDir, CHECKPOINTS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    return ids;
  }
  for (const n of names) for (const r of loadCheckpoints(gitDir, n.slice(0, -5)).records) ids.add(r.id);
  return ids;
}

function isForkAt(v: unknown): v is { sessionId: string; uuid: string } {
  return !!v && typeof v === "object" && typeof (v as { sessionId?: unknown }).sessionId === "string" && typeof (v as { uuid?: unknown }).uuid === "string";
}

function isRecord(r: unknown): r is CheckpointRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Partial<CheckpointRecord>;
  return typeof o.id === "string" && (o.kind === "turn" || o.kind === "rewind") && typeof o.startedAt === "string";
}

/** Index of the (listed, not abandoned) turn record of `turn`, or -1. */
export function indexOfTurn(records: readonly CheckpointRecord[], turn: number): number {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.kind === "turn" && r.turn === turn && !r.abandoned) return i;
  }
  return -1;
}

/**
 * What a file rewind to `records[index]` would do: every path a record from that one on changed, the tree that
 * should still hold each path's content (the end tree of the last record that changed it — anything else on disk
 * was written by someone else since), and the target start tree. null when the timeline has a gap (a turn that
 * was never collected, a missing start tree). MARK: wave2 check-engine — §35.11: `external` = the paths no record of
 * the range changed as Claude's (each one that changed them said `external`): the rewind leaves those.
 */
export function filesPlan(records: readonly CheckpointRecord[], index: number): { startTree: string; paths: string[]; lastEnd: Map<string, string>; external: Set<string> } | null {
  const target = records[index];
  if (!target || target.kind !== "turn" || !target.startTree) return null;
  const lastEnd = new Map<string, string>();
  const claude = new Set<string>();
  for (let i = index; i < records.length; i++) {
    const r = records[i]!;
    if (!r.endTree || !r.files) return null;
    const external = new Set(Array.isArray(r.external) ? r.external : []);
    for (const p of r.files) {
      lastEnd.set(p, r.endTree);
      if (!external.has(p)) claude.add(p);
    }
  }
  const paths = [...lastEnd.keys()].sort();
  return { startTree: target.startTree, paths, lastEnd, external: new Set(paths.filter((p) => !claude.has(p))) };
}

/**
 * `state.session.checkpoints`: the chat's listed turns, oldest first. MARK: wave3 check-engine — §37.4: `conversationLost`
 * (the open chat is a record, §35.4): a point inside a CLI conversation cannot be forked — only a fresh one rewinds.
 */
export function checkpointViews(records: readonly CheckpointRecord[], opts: { conversationLost?: boolean } = {}): TurnCheckpointView[] {
  const out: TurnCheckpointView[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.kind !== "turn" || r.abandoned || r.turn === null) continue;
    const plan = filesPlan(records, i);
    out.push({
      turn: r.turn,
      prompt: r.prompt.length > 120 ? r.prompt.slice(0, 119) + "…" : r.prompt,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      filesChanged: r.files?.length ?? 0,
      filesSince: plan ? plan.paths.length - plan.external.size : 0, // §35.11: what the rewind would restore
      canRewindFiles: plan !== null,
      canRewindConversation: r.before !== null && !(opts.conversationLost === true && r.before.mode === "at"),
    });
  }
  return out.slice(-MAX_CHECKPOINT_VIEWS);
}
