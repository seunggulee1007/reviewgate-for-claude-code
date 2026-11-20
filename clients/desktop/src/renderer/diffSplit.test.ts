// §34.11 — the split layout's rows, as the Mac's Core DiffSplitTests: removed lines on the left beside the added lines they
// pair with, unchanged lines on both sides, hunk headers and other rows full width.
import { describe, expect, it } from "vitest";
import type { DiffLine } from "@reviewgate/engine";
import { anchorSide, effectiveLayout, splitMinWidth, splitRows, type SplitRow } from "./diffSplit";

let nextId = 0;
const line = (kind: DiffLine["kind"], text: string, extra: Partial<DiffLine> = {}): DiffLine => ({
  id: nextId++,
  kind,
  oldNo: kind === "add" || kind === "hunkHeader" ? null : 1,
  newNo: kind === "del" || kind === "hunkHeader" ? null : 1,
  text,
  ...extra,
});

/** Rows of plain lines; a string is a row that is no line (a fold, an expander). */
type Entry = DiffLine | string;
const lineOf = (e: Entry): DiffLine | null => (typeof e === "string" ? null : e.kind === "hunkHeader" ? null : e);
const text = (e: Entry | null) => (e === null ? "_" : typeof e === "string" ? e : e.text);
const shape = (rows: SplitRow<Entry>[]) => rows.map((r) => (r.kind === "full" ? `H:${text(r.row)}` : `${text(r.left)}|${text(r.right)}`));

describe("split rows (§34.11)", () => {
  it("pairs removed with added lines and pads the shorter side", () => {
    const rows = [line("hunkHeader", "@@"), line("context", "a"), line("del", "b"), line("del", "c"), line("del", "d"), line("add", "B"), line("add", "C"), line("context", "e"), line("add", "f")];
    expect(shape(splitRows(rows, lineOf))).toEqual(["H:@@", "a|a", "b|B", "c|C", "d|_", "e|e", "_|f"]);
  });

  it("never pairs across a hunk header or another row (a fold, an expander)", () => {
    const rows: Entry[] = [line("del", "x"), line("del", "y"), line("add", "X"), line("hunkHeader", "@@ 2"), line("add", "n1"), "fold", line("del", "z")];
    expect(shape(splitRows(rows, lineOf))).toEqual(["x|X", "y|_", "H:@@ 2", "_|n1", "H:fold", "z|_"]);
  });

  it("starts another change at a removal after additions", () => {
    const rows = [line("del", "a"), line("add", "A"), line("del", "b"), line("add", "B")];
    expect(shape(splitRows(rows, lineOf))).toEqual(["a|A", "b|B"]);
  });

  it("puts an unchanged line on both sides — the same row object", () => {
    const ctx = line("context", "same");
    const [row] = splitRows([ctx], lineOf);
    expect(row).toEqual({ kind: "pair", left: ctx, right: ctx });
  });

  it("keeps a whitespace-only pair's flag on both sides", () => {
    const [row] = splitRows([line("del", "a  b", { wsOnly: true }), line("add", "a b", { wsOnly: true })], lineOf);
    expect(row?.kind === "pair" && row.left !== null && row.right !== null && typeof row.left !== "string" && typeof row.right !== "string" && row.left.wsOnly && row.right.wsOnly).toBe(true);
  });

  it("anchors notes on a removed line's old side, every other line's new side", () => {
    expect(anchorSide(line("del", "x"))).toBe("old");
    expect(anchorSide(line("add", "x"))).toBe("new");
    expect(anchorSide(line("context", "x"))).toBe("new");
  });

  it("shows split only where two readable columns fit", () => {
    const min = splitMinWidth();
    expect(min).toBeGreaterThan(700);
    expect(min).toBeLessThan(800);
    expect(effectiveLayout("split", min)).toBe("split");
    expect(effectiveLayout("split", min - 1)).toBe("unified");
    expect(effectiveLayout("split", 0)).toBe("unified"); // not measured yet
    expect(effectiveLayout("unified", 5000)).toBe("unified");
  });

  it("splits a 20 000-line rewrite in one pass", () => {
    const rows: DiffLine[] = [];
    for (let i = 0; i < 10_000; i++) rows.push(line("del", `old ${i}`));
    for (let i = 0; i < 10_000; i++) rows.push(line("add", `new ${i}`));
    const start = performance.now();
    const out = splitRows(rows, lineOf);
    expect(performance.now() - start).toBeLessThan(500);
    expect(out).toHaveLength(10_000);
  });
});
