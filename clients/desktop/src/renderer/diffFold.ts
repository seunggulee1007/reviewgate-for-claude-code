/**
 * MARK: wave2 desktop-diff — which rows of a unified diff are drawn (docs/PROTOCOL.md §34.7, audit comp-18). The DOM of
 * a 20 000-line diff was the whole diff; now:
 * - a generated file / lockfile / minified code (`changedFiles[].generated`) starts as one fold ("생성 파일 · +N줄 · 펼치기");
 * - a diff over `LARGE_DIFF_LINES` rows draws its first rows — whole hunks while they fit, the hunk crossing the limit
 *   shows its start — and every later hunk only its header row with a fold ("큰 diff · N줄 · 펼치기"); a click reveals
 *   `FOLD_STEP` more rows of that hunk; expanding one hunk never folds another;
 * - anything smaller is drawn whole, as before.
 * Pure and unit-tested (diffFold.test.ts); the fold state is per shown diff (UnifiedDiff resets it with the diff).
 */
import type { DiffHunk, FileDiff } from "@reviewgate/engine";

/** §34.7: "any diff over 3 000 lines" folds — rows counted with the hunk header rows. */
export const LARGE_DIFF_LINES = 3000;
/** Rows one "펼치기" reveals in a folded hunk. */
export const FOLD_STEP = 3000;
/** The hunk crossing the limit shows its start only when at least this many rows are left (no 3-line slivers). */
export const MIN_PREFIX_ROWS = 100;
/** Rows past a found line that come into view with it (find in diff). */
const REVEAL_MARGIN = 20;

export type FoldState = {
  /** The generated-file fold was opened. */
  generatedOpen: boolean;
  /** Hunk id → rows of `hunk.lines` (from the start, the header row included) the user revealed. */
  shown: Readonly<Record<number, number>>;
};
export const NO_FOLDS: FoldState = { generatedOpen: false, shown: {} };

/** `shown` rows of the hunk are drawn; `hidden` > 0 → a fold row follows them. */
export type HunkFold = { hunk: DiffHunk; shown: number; hidden: number };

export type FoldPlan =
  /** The whole diff is one fold; `lines`: its add / del / context lines. `generated`: the engine's kind (unknown ones too). */
  | { kind: "generated"; generated: string; lines: number }
  | { kind: "hunks"; large: boolean; hunks: HunkFold[] };

const headerRows = (h: DiffHunk): number => (h.lines[0]?.kind === "hunkHeader" ? 1 : 0);

/** Any non-empty `generated` value folds — a kind this client does not know yet (a newer engine) included. */
export const foldsAsGenerated = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Rows a diff has (hunk header rows included). */
export const diffRows = (diff: FileDiff): number => diff.hunks.reduce((n, h) => n + h.lines.length, 0);

/** Add / del / context lines of a diff (no header rows): the "+N줄" of a generated fold. */
export const contentLines = (diff: FileDiff): number => diff.hunks.reduce((n, h) => n + h.lines.length - headerRows(h), 0);

export function planFolds(diff: FileDiff, generated: unknown, state: FoldState): FoldPlan {
  if (diff.hunks.length === 0) return { kind: "hunks", large: false, hunks: [] };
  if (foldsAsGenerated(generated) && !state.generatedOpen) return { kind: "generated", generated, lines: contentLines(diff) };
  const large = diffRows(diff) > LARGE_DIFF_LINES;
  if (!large) return { kind: "hunks", large, hunks: diff.hunks.map((hunk) => ({ hunk, shown: hunk.lines.length, hidden: 0 })) };
  let budget = LARGE_DIFF_LINES;
  let cut = false;
  const hunks = diff.hunks.map((hunk, i): HunkFold => {
    const rows = hunk.lines.length;
    const min = headerRows(hunk);
    let byDefault: number;
    if (!cut && rows <= budget) {
      byDefault = rows;
      budget -= rows;
    } else if (!cut && (i === 0 || budget >= MIN_PREFIX_ROWS)) {
      byDefault = Math.max(min, budget);
      cut = true;
    } else {
      byDefault = min;
      cut = true;
    }
    const shown = Math.min(rows, Math.max(min, byDefault, state.shown[hunk.id] ?? 0));
    return { hunk, shown, hidden: rows - shown };
  });
  return { kind: "hunks", large, hunks };
}

/** "펼치기" on a folded hunk: `FOLD_STEP` more of its rows. */
export function expandFold(state: FoldState, fold: HunkFold): FoldState {
  return { ...state, shown: { ...state.shown, [fold.hunk.id]: fold.shown + FOLD_STEP } };
}

export const openGenerated = (state: FoldState): FoldState => ({ ...state, generatedOpen: true });

/** The state with the row of `lineId` drawn (plus a few after it); unchanged when the id is not in the diff. */
export function revealLine(state: FoldState, diff: FileDiff, lineId: number): FoldState {
  for (const h of diff.hunks) {
    const at = h.lines.findIndex((l) => l.id === lineId);
    if (at < 0) continue;
    const want = at + 1 + REVEAL_MARGIN;
    if ((state.shown[h.id] ?? 0) >= want && state.generatedOpen) return state;
    return { generatedOpen: true, shown: { ...state.shown, [h.id]: Math.max(state.shown[h.id] ?? 0, want) } };
  }
  return state;
}

/** Rows a plan draws: its lines plus one row per fold (what the DOM cost test counts). */
export function renderedRows(plan: FoldPlan): number {
  if (plan.kind === "generated") return 1;
  return plan.hunks.reduce((n, h) => n + h.shown + (h.hidden > 0 ? 1 : 0), 0);
}
