/**
 * MARK: wave2 desktop-diff — "20줄 더 보기" (audit comp-19): the unchanged lines a unified diff leaves out between its
 * hunks, revealed 20 at a time from the file's new side (`full_file_content.lines`, the review's B). A gap lies right
 * before hunk i (gap i) or after the last hunk (gap n); "down" reveals the lines right below the previous hunk, "up" the
 * ones right above the next. A revealed line is an ordinary context row (old number = new number + the gap's offset).
 * The file has to be the diff's new side — `contextMatches` checks every new-side line of the hunks against it, so an
 * edit made on disk since the snapshot never shows misplaced context. Pure and unit-tested (diffContext.test.ts).
 */
import type { DiffHunk, DiffLine, FileDiff } from "@reviewgate/engine";

export const CONTEXT_STEP = 20;
/** git's default `-U3`: a last hunk with fewer trailing context lines ends at the end of the file. */
const GIT_CONTEXT = 3;

export type HunkRange = { oldStart: number; oldCount: number; newStart: number; newCount: number };

/** `@@ -a[,b] +c[,d] @@` of a hunk (its header row, else `hunk.header`); null when it does not parse. */
export function hunkRange(h: DiffHunk): HunkRange | null {
  const header = h.lines[0]?.kind === "hunkHeader" ? h.lines[0].text : h.header;
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) };
}

/** The first line a range covers (a zero count names the line before the insertion / deletion point). */
const first = (start: number, count: number): number => (count === 0 ? start + 1 : start);

/** New-side lines `from`…`to` (inclusive) that no hunk shows; `to` null = up to the end of the file (length unknown yet). */
export type Gap = { index: number; from: number; to: number | null; oldOffset: number };

export function diffGaps(diff: FileDiff, opts: { fileLines: number | null; truncated?: boolean }): Gap[] {
  const gaps: Gap[] = [];
  let prevNewEnd = 0;
  let prevOffset = 0;
  for (let i = 0; i < diff.hunks.length; i++) {
    const r = hunkRange(diff.hunks[i]!);
    if (!r) return gaps; // an unreadable header: nothing below it can be placed
    const newFirst = first(r.newStart, r.newCount);
    const oldFirst = first(r.oldStart, r.oldCount);
    if (newFirst - 1 >= prevNewEnd + 1) gaps.push({ index: i, from: prevNewEnd + 1, to: newFirst - 1, oldOffset: oldFirst - newFirst });
    prevNewEnd = newFirst + r.newCount - 1;
    prevOffset = oldFirst + r.oldCount - (newFirst + r.newCount);
  }
  const last = diff.hunks[diff.hunks.length - 1];
  if (!last || opts.truncated) return gaps;
  let trailing = 0;
  for (let j = last.lines.length - 1; j >= 0 && last.lines[j]!.kind === "context"; j--) trailing++;
  if (trailing < GIT_CONTEXT) return gaps;
  const to = opts.fileLines;
  if (to === null || to >= prevNewEnd + 1) gaps.push({ index: diff.hunks.length, from: prevNewEnd + 1, to, oldOffset: prevOffset });
  return gaps;
}

/** Lines revealed below the previous hunk (`down`) and above the next one (`up`). */
export type GapReveal = { down: number; up: number };
/** Gap index → what was revealed in it. */
export type ContextState = Readonly<Record<number, GapReveal>>;

/** One more step of a gap in one direction. */
export function revealGap(state: ContextState, gap: Gap, dir: "up" | "down"): ContextState {
  const cur = state[gap.index] ?? { down: 0, up: 0 };
  return { ...state, [gap.index]: { ...cur, [dir]: cur[dir] + CONTEXT_STEP } };
}

/**
 * What a gap shows: the new line numbers revealed under the previous hunk and over the next one, and how many stay
 * hidden (null: the end of the file is not known yet, so nothing below the last hunk can be shown).
 */
export function gapView(gap: Gap, reveal: GapReveal | undefined, fileLines: number | null): { down: number[]; up: number[]; hidden: number | null } {
  const to = gap.to ?? fileLines;
  if (to === null) return { down: [], up: [], hidden: null };
  const size = Math.max(0, to - gap.from + 1);
  const up = Math.min(reveal?.up ?? 0, size);
  const down = Math.min(reveal?.down ?? 0, size - up);
  return {
    down: Array.from({ length: down }, (_, k) => gap.from + k),
    up: Array.from({ length: up }, (_, k) => to - up + 1 + k),
    hidden: size - up - down,
  };
}

/** A revealed line as a context row; its id (−newNo) is one no diff line has (those are ≥ 0). */
export function contextRow(lines: readonly string[], newNo: number, oldOffset: number): DiffLine {
  return { id: -newNo, kind: "context", oldNo: newNo + oldOffset, newNo, text: lines[newNo - 1] ?? "" };
}

const noCR = (s: string): string => (s.endsWith("\r") ? s.slice(0, -1) : s);

/** Every new-side line of the hunks is that line of `lines` (CR-insensitive): `lines` is the diff's new side. */
export function contextMatches(diff: FileDiff, lines: readonly string[]): boolean {
  let any = false;
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      if ((l.kind !== "add" && l.kind !== "context") || l.newNo === null) continue;
      any = true;
      const have = lines[l.newNo - 1];
      if (have === undefined || noCR(have) !== noCR(l.text)) return false;
    }
  }
  return any || lines.length > 0;
}
