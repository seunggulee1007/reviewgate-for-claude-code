import type { FileDiff, DiffLine } from "../diff/parse.js";
import { hunkRanges } from "../diff/hunks.js";
import { CommandRefused } from "../errors.js";
import { nulSplit } from "../git/exec.js";
import type { ChangedFile, GitCheckpoint } from "../git/checkpoint.js";
import { isDiffSince, type ChangeTotals, type DiffSince, type LastTurnChanges, type ReviewRequestInfo, type TurnSummaryEvent } from "../protocol.js";
import type { ReviewNote } from "./notes.js";

/**
 * Review round 2, the review half (docs/PROTOCOL.md §34.1–34.5): which tree a diff range starts from, the per-file
 * bookkeeping that follows B (`blob`, `changedSinceRequest`), notes carried to a new B, the `refs/reviewgate/<ns>/range/…`
 * pins of the range trees and what the review file keeps of them. The gate (`review/gate.ts`) owns the state.
 */

/** `select_file.since` / `full_file.since`: absent (or null) = `review`; any other value is refused `invalid_since`. */
export function sinceOf(raw: unknown): DiffSince {
  if (raw === undefined || raw === null) return "review";
  if (isDiffSince(raw)) return raw;
  throw new CommandRefused(`invalid_since:${String(raw)}`, { code: "invalid_since" });
}

/** The range's old side is not known (`turn` before a first collection, `request` without one, `accepted` never accepted). */
export function rangeUnavailable(since: DiffSince): CommandRefused {
  return new CommandRefused(`range_unavailable:${since}`, { code: "range_unavailable" });
}

/** Paths per `ls-tree` call (command-line length on Windows). */
const LS_TREE_CHUNK = 100;

/**
 * The tree entry id (`git rev-parse <tree>:<path>`: a blob, a symlink's blob, a submodule's commit) of each of `paths` in
 * `tree`, by `ls-tree` with literal pathspecs; absent paths (and directories) are missing from the map.
 */
export async function treeEntryIds(cp: GitCheckpoint, tree: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(paths)];
  for (let i = 0; i < wanted.length; i += LS_TREE_CHUNK) {
    const chunk = wanted.slice(i, i + LS_TREE_CHUNK);
    const res = await cp.git(["--literal-pathspecs", "ls-tree", "-z", tree, "--", ...chunk], { allowFailure: true });
    if (res.status !== 0) continue;
    // A directory among the paths also lists what is under it once ls-tree descends there: keep the named paths only.
    const named = new Set(chunk);
    for (const entry of nulSplit(res.stdout)) {
      // "<mode> <type> <oid>\t<path>"
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const [, type, oid] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      if (!oid || type === "tree" || !named.has(path)) continue;
      out.set(path, oid);
    }
  }
  return out;
}

/**
 * §34.4: a note carried through its file's old B → new B diff. A new-side line outside every changed block shifts (`moved`
 * when its number changed); a line inside one keeps a place only on a new line of that block whose trimmed text is the
 * note's trimmed `excerpt` (the nearest one; `moved`), else it is `gone` and `line` keeps its last number. Old-side notes
 * (A is fixed), file-level notes and gone notes never move. Returns `note` itself when nothing changes.
 */
export function carryNote(note: ReviewNote, diff: FileDiff): ReviewNote {
  if (note.side !== "new" || note.line === null || note.line === undefined || note.anchor === "gone" || diff.isBinary) return note;
  const line = note.line;
  let delta = 0;
  for (const h of diff.hunks) {
    let ranges: [number, number, number, number];
    try {
      ranges = hunkRanges(h.header);
    } catch {
      return note;
    }
    const [oldStart, oldCount, , newCount] = ranges;
    // A zero count names the line BEFORE the (empty) range.
    const first = oldCount === 0 ? oldStart + 1 : oldStart;
    const last = oldCount === 0 ? oldStart : oldStart + oldCount - 1;
    if (line < first) break;
    if (line > last) {
      delta += newCount - oldCount;
      continue;
    }
    const i = h.lines.findIndex((l) => l.oldNo === line);
    const hit = h.lines[i];
    if (!hit) return note;
    if (hit.kind === "context") return moveTo(note, hit.newNo ?? line);
    return inChangedBlock(note, h.lines, i);
  }
  return moveTo(note, line + delta);
}

function moveTo(note: ReviewNote, line: number): ReviewNote {
  return line === note.line ? note : { ...note, line, anchor: "moved" };
}

/** The note's line is a `del` at `lines[i]`: the run of del / add lines around it is its block. */
function inChangedBlock(note: ReviewNote, lines: DiffLine[], i: number): ReviewNote {
  const changed = (l: DiffLine | undefined) => l !== undefined && (l.kind === "del" || l.kind === "add");
  let start = i;
  while (changed(lines[start - 1])) start -= 1;
  let end = i;
  while (changed(lines[end + 1])) end += 1;
  const block = lines.slice(start, end + 1);
  const dels = block.filter((l) => l.kind === "del");
  const adds = block.filter((l) => l.kind === "add");
  const k = dels.indexOf(lines[i]!);
  const excerpt = note.excerpt.trim();
  let best = -1;
  if (excerpt.length > 0) {
    for (let j = 0; j < adds.length; j++) {
      if (adds[j]!.text.trim() !== excerpt) continue;
      if (best < 0 || Math.abs(j - k) < Math.abs(best - k)) best = j;
    }
  }
  const target = best >= 0 ? adds[best]!.newNo : null;
  return target === null ? { ...note, anchor: "gone" } : moveTo(note, target);
}

/** `refs/reviewgate/<ns>/range/` (next to persist.ts `refPrefix(ns)`): one ref per referenced range tree, named by the tree id. */
export function rangeRefPrefix(ns: string): string {
  return `refs/reviewgate/${ns}/range/`;
}

/** Pins exactly `trees` under `rangeRefPrefix(ns)` (creating the missing refs, deleting the others). Best effort. */
export async function syncRangePins(cp: GitCheckpoint, ns: string, trees: readonly string[]): Promise<void> {
  const prefix = rangeRefPrefix(ns);
  const want = new Set(trees);
  const have = new Set((await cp.refsUnder(prefix)).map((r) => r.slice(prefix.length)));
  for (const sha of have) if (!want.has(sha)) await cp.git(["update-ref", "-d", `${prefix}${sha}`], { allowFailure: true });
  for (const sha of want) if (!have.has(sha)) await cp.git(["update-ref", `${prefix}${sha}`, sha], { allowFailure: true });
}

/** What the review file keeps of §34 (absent in files written before it). Trees are re-checked on restore. */
export type PersistedRanges = {
  turnBaseTree: string | null;
  heldEndTree: string | null;
  requestTree: string | null;
  lastRequest: ReviewRequestInfo | null;
  lastTurnChanges: LastTurnChanges | null;
  acceptedTrees: Record<string, string>;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Lenient read of `PersistedReview.ranges`: malformed fields read as empty. */
export function parsePersistedRanges(raw: unknown): PersistedRanges | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const req = o.lastRequest as Partial<ReviewRequestInfo> | null | undefined;
  const ltc = o.lastTurnChanges as Partial<LastTurnChanges> | null | undefined;
  const accepted: Record<string, string> = {};
  if (o.acceptedTrees && typeof o.acceptedTrees === "object") {
    for (const [path, tree] of Object.entries(o.acceptedTrees as Record<string, unknown>)) {
      const t = str(tree);
      if (t) accepted[path] = t;
    }
  }
  return {
    turnBaseTree: str(o.turnBaseTree),
    heldEndTree: str(o.heldEndTree),
    requestTree: str(o.requestTree),
    lastRequest: req && int(req.turn) && typeof req.at === "string" && int(req.notes) ? { turn: req.turn, at: req.at, notes: req.notes } : null,
    lastTurnChanges: ltc && int(ltc.turn) && int(ltc.files) && int(ltc.added) && int(ltc.deleted) ? { turn: ltc.turn, files: ltc.files, added: ltc.added, deleted: ltc.deleted } : null,
    acceptedTrees: accepted,
  };
}

/** §34.3: the per-file marks a refresh / restore keeps (recomputed only at a collection). */
export function keptTurnMarks(f: ChangedFile): Pick<ChangedFile, "changedThisTurn" | "turnAdded" | "turnDeleted" | "changedSinceAccepted"> {
  return {
    ...(f.changedThisTurn ? { changedThisTurn: true as const } : {}),
    ...(f.changedThisTurn && f.turnAdded !== undefined ? { turnAdded: f.turnAdded } : {}),
    ...(f.changedThisTurn && f.turnDeleted !== undefined ? { turnDeleted: f.turnDeleted } : {}),
    ...(f.changedSinceAccepted ? { changedSinceAccepted: true as const } : {}),
  };
}

/** §34.3: the turn's own numbers of a changed file (`turn_summary.files[].adds` / `dels`). */
export function withTurnCounts(f: ChangedFile): ChangedFile {
  return { ...f, added: f.turnAdded ?? f.added, deleted: f.turnDeleted ?? f.deleted };
}

/** §34.3: `turn_summary` with the whole review's numbers: per file `reviewAdds` / `reviewDels`, `review`, `merged`. */
export function withReviewTotals(
  summary: Omit<TurnSummaryEvent, "type">,
  review: { files: readonly ChangedFile[]; totals: ChangeTotals; merged: boolean },
): Omit<TurnSummaryEvent, "type"> {
  const byPath = new Map(review.files.map((f) => [f.path, f]));
  return {
    ...summary,
    files: summary.files.map((f) => {
      const all = byPath.get(f.path);
      return all ? { ...f, reviewAdds: all.added, reviewDels: all.deleted } : f;
    }),
    review: { ...review.totals },
    ...(review.merged ? { merged: true as const } : {}),
  };
}
