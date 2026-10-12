import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChangedFile } from "../git/checkpoint.js";
import type { HistoryVerdict, ReviewHistoryEntry, ReviewHistoryFile, ReviewHistoryNote } from "../protocol.js";
import type { ReviewNote } from "./notes.js";
import { historyRefs, readJSON, writeAtomicJSON } from "./persist.js";

/**
 * Review history (docs/PROTOCOL.md §14): every completed review round becomes one
 * `ReviewHistoryEntry` in `<gitdir>/reviewgate/history.json` (newest last, capped at `HISTORY_CAP`),
 * its trees pinned by `refs/reviewgate/<ns>/history/<id>/…` so past diffs stay viewable.
 *
 * A **round** starts with the first collection that has changed files after a fresh snapshot A and
 * spans every follow-up turn on the same review (questions / request-changes). It ends when the next
 * fresh `send` takes a new A, or when nothing is left to review (everything rejected / committed).
 */
export const HISTORY_FILE = join("reviewgate", "history.json");
export const HISTORY_CAP = 50;
export const HISTORY_PROMPT_CHARS = 200;

/** One file of a round in progress; `verdict` is `pending` until the user decides. */
export type RoundFile = Omit<ReviewHistoryFile, "verdict"> & { verdict: HistoryVerdict | "pending"; committed?: boolean };

/** The round in progress (persisted with the review file so a restart keeps it). */
export type HistoryRound = {
  id: string;
  sessionId: string | null;
  turns: number[];
  startedAt: string;
  prompt: string;
  turnStartTree: string;
  turnEndTree: string;
  files: RoundFile[];
  notes: ReviewHistoryNote[];
};

/** What the engine knows about the turn that is running (gate.beginTurn). */
export type TurnInfo = { turn: number; prompt: string; startedAt: string; sessionId: string | null };

export function newHistoryId(now = Date.now()): string {
  return `${now.toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function clipPrompt(text: string): string {
  const t = text.trim();
  return t.length > HISTORY_PROMPT_CHARS ? t.slice(0, HISTORY_PROMPT_CHARS - 1) + "…" : t;
}

export function newRound(info: TurnInfo | null, start: string, end: string, fallbackPrompt: string | null = null): HistoryRound {
  return {
    id: newHistoryId(),
    sessionId: info?.sessionId ?? null,
    turns: info ? [info.turn] : [],
    startedAt: info?.startedAt ?? new Date().toISOString(),
    prompt: clipPrompt(info?.prompt ?? fallbackPrompt ?? ""),
    turnStartTree: start,
    turnEndTree: end,
    files: [],
    notes: [],
  };
}

function verdictOf(f: ChangedFile, prev: RoundFile | undefined): RoundFile["verdict"] {
  if (f.state === "accepted") return "accepted";
  if (f.state === "changesRequested") return "changes_requested";
  return prev?.verdict === "accepted" && f.state !== "pending" ? "accepted" : "pending";
}

/**
 * Re-syncs the round's files with the current review list (after a collection, refresh, restore or a
 * commit): listed files take their current numbers and verdict; rejected and committed files the list
 * no longer shows are kept; anything else that vanished (its diff became empty) is dropped.
 */
export function syncRound(round: HistoryRound, files: ChangedFile[], end: string, turn: number | null): void {
  if (turn !== null && !round.turns.includes(turn)) round.turns.push(turn);
  round.turnEndTree = end;
  const prev = new Map(round.files.map((f) => [f.path, f]));
  const next: RoundFile[] = [];
  const listed = new Set<string>();
  for (const f of files) {
    const p = prev.get(f.path);
    listed.add(f.path);
    next.push({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      verdict: verdictOf(f, p),
      adds: f.added,
      dels: f.deleted,
      toolUseIds: [...new Set([...(p?.toolUseIds ?? []), ...f.toolUseIds])],
      ...(p?.changesRequested ? { changesRequested: p.changesRequested } : {}),
      ...(f.state === "accepted" && f.autoAccepted ? { autoAccepted: f.autoAccepted } : {}), // MARK: wave4c w4c-trust (§41.2)
      ...((f.rejectedHunks ?? p?.rejectedHunks) ? { rejectedHunks: f.rejectedHunks ?? p?.rejectedHunks } : {}),
      // A partially reverted file keeps the B that held the whole proposal; a request-changes rebuild (no
      // longer partial) proposes anew, so the old pin no longer describes it.
      ...(f.partial && p?.endTree ? { endTree: p.endTree } : {}),
    });
  }
  for (const p of round.files) {
    if (listed.has(p.path)) continue;
    if (p.verdict === "rejected" || p.committed) next.push(p);
  }
  next.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  round.files = next;
}

export function setVerdict(round: HistoryRound | null, path: string, verdict: RoundFile["verdict"], extra: Partial<RoundFile> = {}): void {
  const f = round?.files.find((x) => x.path === path);
  if (!f) return;
  f.verdict = verdict;
  Object.assign(f, extra);
}

export function addRoundNotes(round: HistoryRound | null, notes: readonly ReviewNote[]): void {
  if (!round) return;
  for (const n of notes) {
    round.notes.push({ path: n.path, line: n.line, side: n.side, body: n.body });
    const f = round.files.find((x) => x.path === n.path);
    if (f && f.verdict !== "changes_requested") {
      f.verdict = "changes_requested";
      f.changesRequested = (f.changesRequested ?? 0) + 1;
    }
  }
}

/** The finished entry, or null when the round never had a file. `finished`: closed by `finish_review` (§31). */
export function completeRound(round: HistoryRound, endedAt = new Date().toISOString(), finished = false): ReviewHistoryEntry | null {
  if (round.files.length === 0) return null;
  return {
    id: round.id,
    sessionId: round.sessionId,
    turns: [...round.turns],
    startedAt: round.startedAt,
    endedAt,
    prompt: round.prompt,
    files: round.files.map(({ committed: _c, ...f }) => ({ ...f, toolUseIds: [...f.toolUseIds], ...(_c ? { committed: true } : {}) })),
    notes: round.notes.map((n) => ({ ...n })),
    turnStartTree: round.turnStartTree,
    turnEndTree: round.turnEndTree,
    ...(finished ? { finished: true as const } : {}),
  };
}

/** Every tree an entry needs pinned: `start`, `end`, and `end-<n>` for each distinct per-file end tree. */
export function entryTreeRefs(ns: string, entry: ReviewHistoryEntry): { ref: string; sha: string }[] {
  const refs = historyRefs(ns, entry.id);
  const out = [
    { ref: refs.start, sha: entry.turnStartTree },
    { ref: refs.end, sha: entry.turnEndTree },
  ];
  const extra = [...new Set(entry.files.map((f) => f.endTree).filter((t): t is string => typeof t === "string" && t !== entry.turnEndTree))];
  extra.forEach((sha, i) => out.push({ ref: `${refs.end}-${i + 1}`, sha }));
  return out;
}

export type HistoryFileContent = { version: 1; entries: ReviewHistoryEntry[] };

export function historyFilePath(gitDir: string): string {
  return join(gitDir, HISTORY_FILE);
}

/** Entries oldest first; [] when missing / unparsable / foreign version. */
export async function loadHistory(gitDir: string): Promise<ReviewHistoryEntry[]> {
  const o = await readJSON<Partial<HistoryFileContent>>(historyFilePath(gitDir));
  if (!o || o.version !== 1 || !Array.isArray(o.entries)) return [];
  return o.entries.filter((e) => e && typeof e.id === "string" && typeof e.turnStartTree === "string" && typeof e.turnEndTree === "string" && Array.isArray(e.files));
}

export async function saveHistory(gitDir: string, entries: ReviewHistoryEntry[]): Promise<void> {
  const path = historyFilePath(gitDir);
  await mkdir(dirname(path), { recursive: true });
  const value: HistoryFileContent = { version: 1, entries };
  await writeAtomicJSON(path, value);
}

/** Appends `entry` (replacing one with the same id) and keeps the newest `cap`; returns the dropped ones. */
export function appendCapped(entries: ReviewHistoryEntry[], entry: ReviewHistoryEntry, cap = HISTORY_CAP): { entries: ReviewHistoryEntry[]; dropped: ReviewHistoryEntry[] } {
  const all = [...entries.filter((e) => e.id !== entry.id), entry];
  const over = Math.max(0, all.length - cap);
  return { entries: all.slice(over), dropped: all.slice(0, over) };
}

/** `review_history` order: newest first, optionally one session's only. */
export function historyView(entries: ReviewHistoryEntry[], sessionId: string | null | undefined): ReviewHistoryEntry[] {
  const list = sessionId === undefined ? entries : entries.filter((e) => e.sessionId === sessionId);
  return [...list].reverse();
}

export function isRound(v: unknown): v is HistoryRound {
  const r = v as HistoryRound | null;
  return !!r && typeof r === "object" && typeof r.id === "string" && typeof r.turnStartTree === "string" && typeof r.turnEndTree === "string" && Array.isArray(r.files) && Array.isArray(r.turns) && Array.isArray(r.notes);
}
