/**
 * §34.11 — the diff's two layouts: unified (one column, the default) or split (the old version on the left, the new on
 * the right, as git tools and GitHub show it). The Mac's Core `DiffSplit` is the same rules (`DiffSplitTests`).
 *
 * Split rows are built from the unified rows in display order, so folds, "20줄 더 보기", find and the line ids stay the
 * same: a run of changed lines (removed / added with nothing between them — never across a hunk header, an unchanged line
 * or a fold) pairs its i-th removed line with its i-th added line, the shorter side padded; an unchanged line is on both
 * sides; every other row stays full width. Store-free and pure (diffSplit.test.ts).
 */
import type { DiffLine } from "@reviewgate/engine";

export type DiffLayout = "unified" | "split";

/** One split row over `T` (a unified row): a pair of sides (null = padded) or a full-width row. */
export type SplitRow<T> = { kind: "pair"; left: T | null; right: T | null } | { kind: "full"; row: T };

/** `lineOf(row)`: the row's code line, or null for a row that is no line (a fold, an expander, a hunk's own header row). */
export function splitRows<T>(rows: readonly T[], lineOf: (row: T) => DiffLine | null): SplitRow<T>[] {
  const out: SplitRow<T>[] = [];
  let dels: T[] = [];
  let adds: T[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    const line = lineOf(row);
    if (line?.kind === "del") {
      // A removed line after added ones starts another change (git writes a change's removals first).
      if (adds.length > 0) flush();
      dels.push(row);
    } else if (line?.kind === "add") {
      adds.push(row);
    } else if (line?.kind === "context") {
      flush();
      out.push({ kind: "pair", left: row, right: row });
    } else {
      flush();
      out.push({ kind: "full", row });
    }
  }
  flush();
  return out;
}

/** The side a line's notes, comments and findings sit on: a removed line's is the old side, any other the new side. */
export function anchorSide(line: DiffLine): "old" | "new" {
  return line.kind === "del" ? "old" : "new";
}

/** The narrowest a side's code may get, in characters of the diff font, before the pane shows unified instead. */
export const SPLIT_MIN_COLUMNS = 38;
/** The diff font's character (12px monospace ≈ 7.2px) and one side's gutter: line number 50 + "+" 18 + "?" 16 + sign 14. */
export const SPLIT_CHAR_PX = 7.2;
export const SPLIT_GUTTER_PX = 98;

/** The pane width split needs: two sides of a gutter plus `SPLIT_MIN_COLUMNS` characters, and the divider (≈ 745px). */
export function splitMinWidth(charPx = SPLIT_CHAR_PX, gutterPx = SPLIT_GUTTER_PX): number {
  return 2 * (gutterPx + SPLIT_MIN_COLUMNS * charPx) + 1;
}

/** What is shown: split only when it was chosen and the pane is wide enough (an unmeasured pane — 0 — is not). */
export function effectiveLayout(chosen: DiffLayout, width: number, min = splitMinWidth()): DiffLayout {
  return chosen === "split" && width >= min ? "split" : "unified";
}
