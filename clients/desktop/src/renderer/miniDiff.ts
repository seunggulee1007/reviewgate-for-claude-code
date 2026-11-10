/**
 * MARK: wave2 desktop-diff — the chat's folded mini diff of an Edit / MultiEdit / Write call (docs/PROTOCOL.md §34.6, audit
 * comp-03 / market-13): what the call writes, from its own `tool_use.input` (old_string → new_string; a Write's first lines),
 * so a turn can be followed while it runs — no engine round trip. A one-to-one changed line marks its changed words like
 * the review diff does (§34.7's limits: ≤ 500 chars, no more than 60 % of the line). Pure and unit-tested (miniDiff.test.ts).
 */
import { diffLines, diffWordsWithSpace } from "diff";

export type MiniLine = { kind: "add" | "del" | "context" | "gap"; text: string; segments?: [number, number][] };
export type MiniDiff = {
  /** The rows shown (at most `MINI_MAX_LINES`; a Write's first `WRITE_PREVIEW_LINES`). */
  lines: MiniLine[];
  added: number;
  deleted: number;
  /** Rows not shown. */
  hidden: number;
  /** A Write: every line counts as added (the file's old content is not in the call). */
  write: boolean;
};

export const MINI_MAX_LINES = 40;
export const WRITE_PREVIEW_LINES = 20;
/** Above this many characters on a side an edit is only counted, not diffed (a diff of huge strings stalls the chat). */
const MAX_DIFF_CHARS = 200_000;
const MAX_SEGMENT_LINE = 500;
const MAX_CHANGED_SHARE = 0.6;

const splitLines = (s: string): string[] => {
  if (s.length === 0) return [];
  const out = s.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
};

/** The changed words of a one-to-one pair as [start, end) ranges of each line (none when most of the line changed). */
function pairSegments(a: string, b: string): [[number, number][], [number, number][]] | null {
  if (a.length > MAX_SEGMENT_LINE || b.length > MAX_SEGMENT_LINE) return null;
  const del: [number, number][] = [];
  const add: [number, number][] = [];
  let i = 0;
  let j = 0;
  for (const part of diffWordsWithSpace(a, b)) {
    const n = part.value.length;
    if (part.removed) {
      del.push([i, i + n]);
      i += n;
    } else if (part.added) {
      add.push([j, j + n]);
      j += n;
    } else {
      i += n;
      j += n;
    }
  }
  const share = (r: [number, number][], len: number) => (len === 0 ? 0 : r.reduce((s, [x, y]) => s + y - x, 0) / len);
  if (share(del, a.length) > MAX_CHANGED_SHARE || share(add, b.length) > MAX_CHANGED_SHARE) return null;
  return [del, add];
}

/** One old → new replacement as rows (context / del / add), its counts, or only the counts when it is too large to diff. */
function editRows(oldStr: string, newStr: string): { rows: MiniLine[]; added: number; deleted: number } {
  if (oldStr.length > MAX_DIFF_CHARS || newStr.length > MAX_DIFF_CHARS) return { rows: [], added: splitLines(newStr).length, deleted: splitLines(oldStr).length };
  const nl = (s: string) => (s.length === 0 || s.endsWith("\n") ? s : `${s}\n`);
  const rows: MiniLine[] = [];
  let added = 0;
  let deleted = 0;
  let dels: MiniLine[] = [];
  const flushPairs = (adds: MiniLine[]) => {
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const seg = pairSegments(dels[k]!.text, adds[k]!.text);
      if (seg && seg[0].length + seg[1].length > 0) {
        dels[k]!.segments = seg[0];
        adds[k]!.segments = seg[1];
      }
    }
    dels = [];
  };
  for (const part of diffLines(nl(oldStr), nl(newStr))) {
    const lines = splitLines(part.value);
    if (part.removed) {
      const block = lines.map((text): MiniLine => ({ kind: "del", text }));
      rows.push(...block);
      dels.push(...block);
      deleted += lines.length;
    } else if (part.added) {
      const block = lines.map((text): MiniLine => ({ kind: "add", text }));
      rows.push(...block);
      flushPairs(block);
      added += lines.length;
    } else {
      dels = [];
      rows.push(...lines.map((text): MiniLine => ({ kind: "context", text })));
    }
  }
  return { rows, added, deleted };
}

const isStr = (v: unknown): v is string => typeof v === "string";

export function miniDiffOf(name: string, input: Record<string, unknown>): MiniDiff | null {
  if (name === "Write") {
    const content = input["content"];
    if (!isStr(content)) return null;
    const all = splitLines(content);
    const lines = all.slice(0, WRITE_PREVIEW_LINES).map((text): MiniLine => ({ kind: "add", text }));
    return { lines, added: all.length, deleted: 0, hidden: all.length - lines.length, write: true };
  }
  let edits: { old: string; neu: string }[];
  if (name === "Edit") {
    if (!isStr(input["old_string"]) || !isStr(input["new_string"])) return null;
    edits = [{ old: input["old_string"], neu: input["new_string"] }];
  } else if (name === "MultiEdit") {
    const list = input["edits"];
    if (!Array.isArray(list)) return null;
    edits = list
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .filter((e) => isStr(e["old_string"]) && isStr(e["new_string"]))
      .map((e) => ({ old: e["old_string"] as string, neu: e["new_string"] as string }));
    if (edits.length === 0) return null;
  } else {
    return null;
  }
  const all: MiniLine[] = [];
  let added = 0;
  let deleted = 0;
  edits.forEach((e, i) => {
    const r = editRows(e.old, e.neu);
    if (i > 0 && r.rows.length > 0 && all.length > 0) all.push({ kind: "gap", text: "" });
    all.push(...r.rows);
    added += r.added;
    deleted += r.deleted;
  });
  const lines = all.slice(0, MINI_MAX_LINES);
  const shownCode = lines.filter((l) => l.kind !== "gap").length;
  const totalCode = all.filter((l) => l.kind !== "gap").length;
  const unlisted = added + deleted - all.filter((l) => l.kind === "add" || l.kind === "del").length;
  return { lines, added, deleted, hidden: totalCode - shownCode + unlisted, write: false };
}
