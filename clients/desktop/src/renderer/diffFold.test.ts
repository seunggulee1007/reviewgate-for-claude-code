import { describe, expect, it } from "vitest";
import type { DiffHunk, DiffLine, FileDiff } from "@reviewgate/engine";
import { FOLD_STEP, LARGE_DIFF_LINES, NO_FOLDS, expandFold, openGenerated, planFolds, renderedRows, revealLine } from "./diffFold";

/** A diff of hunks with `sizes[i]` content lines each (every hunk starts with its header row, as the engine's parser emits). */
function diffOf(sizes: number[]): FileDiff {
  let id = 0;
  let no = 1;
  const hunks: DiffHunk[] = sizes.map((n, h) => {
    const header = `@@ -${no},${n} +${no},${n} @@`;
    const lines: DiffLine[] = [{ id: id++, kind: "hunkHeader", oldNo: null, newNo: null, text: header }];
    for (let i = 0; i < n; i++) lines.push({ id: id++, kind: i % 2 ? "add" : "del", oldNo: i % 2 ? null : no, newNo: i % 2 ? no : null, text: `line ${no}` }), no++;
    no += 10;
    return { id: h, header, lines };
  });
  return { oldPath: "a.txt", newPath: "a.txt", isBinary: false, hunks };
}

const hunksOf = (plan: ReturnType<typeof planFolds>) => {
  if (plan.kind !== "hunks") throw new Error("expected a hunk plan");
  return plan.hunks.map((h) => [h.shown, h.hidden]);
};
const foldAt = (plan: ReturnType<typeof planFolds>, i: number) => {
  if (plan.kind !== "hunks" || !plan.hunks[i]) throw new Error("expected a hunk plan");
  return plan.hunks[i]!;
};

describe("planFolds (§34.7 / comp-18)", () => {
  it("a diff up to the large threshold is shown whole, exactly as before", () => {
    const diff = diffOf([10, 2000, 900]);
    const plan = planFolds(diff, undefined, NO_FOLDS);
    expect(plan.kind === "hunks" && plan.large).toBe(false);
    expect(hunksOf(plan)).toEqual([[11, 0], [2001, 0], [901, 0]]);
    expect(renderedRows(plan)).toBe(11 + 2001 + 901);
  });

  it("a generated file / lockfile starts as one fold of its content lines, whatever its size", () => {
    const diff = diffOf([3, 1]);
    expect(planFolds(diff, "lockfile", NO_FOLDS)).toEqual({ kind: "generated", generated: "lockfile", lines: 4 });
    expect(planFolds(diff, "generated", NO_FOLDS).kind).toBe("generated");
    expect(planFolds(diff, "minified", NO_FOLDS).kind).toBe("generated");
    // a kind this client does not know (a newer engine) still folds; no / junk values do not
    expect(planFolds(diff, "vendored", NO_FOLDS).kind).toBe("generated");
    expect(planFolds(diff, undefined, NO_FOLDS).kind).toBe("hunks");
    expect(planFolds(diff, 7, NO_FOLDS).kind).toBe("hunks");
    expect(renderedRows(planFolds(diff, "lockfile", NO_FOLDS))).toBe(1);
    // opened, it follows the ordinary rules
    expect(hunksOf(planFolds(diff, "lockfile", openGenerated(NO_FOLDS)))).toEqual([[4, 0], [2, 0]]);
  });

  it("a huge single hunk (a new 20 000-line file) shows its first rows and folds the rest; each 펼치기 reveals FOLD_STEP more", () => {
    const diff = diffOf([20_000]);
    const plan = planFolds(diff, undefined, NO_FOLDS);
    expect(plan.kind === "hunks" && plan.large).toBe(true);
    expect(hunksOf(plan)).toEqual([[LARGE_DIFF_LINES, 20_001 - LARGE_DIFF_LINES]]);
    expect(renderedRows(plan)).toBe(LARGE_DIFF_LINES + 1);
    const more = planFolds(diff, undefined, expandFold(NO_FOLDS, foldAt(plan, 0)));
    expect(hunksOf(more)).toEqual([[LARGE_DIFF_LINES + FOLD_STEP, 20_001 - LARGE_DIFF_LINES - FOLD_STEP]]);
  });

  it("many hunks: whole hunks while they fit, the hunk crossing the limit shows its start, later ones only their header", () => {
    // 1001 + 1501 rows fit (2502); 498 rows are left for the 1001-row hunk; the rest fold to their header row
    const diff = diffOf([1000, 1500, 1000, 40, 2000]);
    const plan = planFolds(diff, undefined, NO_FOLDS);
    expect(hunksOf(plan)).toEqual([[1001, 0], [1501, 0], [498, 503], [1, 40], [1, 2000]]);
    expect(renderedRows(plan)).toBe(1001 + 1501 + 498 + 1 + 1 + 1 + 1 + 1);
  });

  it("a crossing hunk with almost no room left folds whole instead of showing a sliver", () => {
    const diff = diffOf([2950, 600]);
    expect(hunksOf(planFolds(diff, undefined, NO_FOLDS))).toEqual([[2951, 0], [1, 600]]);
  });

  it("expanding a later hunk never folds an earlier one", () => {
    const diff = diffOf([1000, 1500, 1000, 40, 2000]);
    const plan = planFolds(diff, undefined, NO_FOLDS);
    const next = planFolds(diff, undefined, expandFold(NO_FOLDS, foldAt(plan, 3)));
    expect(hunksOf(next)).toEqual([[1001, 0], [1501, 0], [498, 503], [41, 0], [1, 2000]]);
  });

  it("revealLine makes a folded row visible (find in diff) and opens a generated fold", () => {
    const diff = diffOf([1000, 1500, 1000, 40, 2000]);
    const target = diff.hunks[4]!.lines[1500]!.id;
    const state = revealLine(NO_FOLDS, diff, target);
    expect(foldAt(planFolds(diff, undefined, state), 4).shown).toBeGreaterThan(1500);
    const gen = revealLine(NO_FOLDS, diffOf([5]), 2);
    expect(planFolds(diffOf([5]), "lockfile", gen).kind).toBe("hunks");
    // an id that is not in the diff changes nothing
    expect(revealLine(NO_FOLDS, diff, 99_999_999)).toEqual(NO_FOLDS);
  });

  it("an empty diff is an empty hunk plan (the view shows its own 'no changes' state)", () => {
    const empty: FileDiff = { oldPath: "a", newPath: "a", isBinary: false, hunks: [] };
    expect(planFolds(empty, "lockfile", NO_FOLDS)).toEqual({ kind: "hunks", large: false, hunks: [] });
  });
});
