import { describe, expect, it } from "vitest";
import type { DiffHunk, DiffLine, FileDiff } from "@reviewgate/engine";
import { CONTEXT_STEP, contextMatches, contextRow, diffGaps, gapView, hunkRange, revealGap } from "./diffContext";

/** The new file: n1 … n40. Old: line 11 was "o11", and an old line "gone" sat after line 30. */
const NEW = Array.from({ length: 40 }, (_, i) => `n${i + 1}`);

let nextId = 0;
const ctx = (o: number, n: number): DiffLine => ({ id: nextId++, kind: "context", oldNo: o, newNo: n, text: `n${n}` });
const del = (o: number, text: string): DiffLine => ({ id: nextId++, kind: "del", oldNo: o, newNo: null, text });
const add = (n: number): DiffLine => ({ id: nextId++, kind: "add", oldNo: null, newNo: n, text: `n${n}` });
const head = (text: string): DiffLine => ({ id: nextId++, kind: "hunkHeader", oldNo: null, newNo: null, text });
const hunk = (id: number, header: string, lines: DiffLine[]): DiffHunk => ({ id, header, lines: [head(header), ...lines] });

const A = hunk(0, "@@ -8,7 +8,7 @@ class X", [ctx(8, 8), ctx(9, 9), ctx(10, 10), del(11, "o11"), add(11), ctx(12, 12), ctx(13, 13), ctx(14, 14)]);
const B = hunk(1, "@@ -28,7 +28,6 @@", [ctx(28, 28), ctx(29, 29), ctx(30, 30), del(31, "gone"), ctx(32, 31), ctx(33, 32), ctx(34, 33)]);
const DIFF: FileDiff = { oldPath: "a.java", newPath: "a.java", isBinary: false, hunks: [A, B] };

describe("hunkRange", () => {
  it("reads the header row (counts default to 1; a zero count is an insertion / deletion point)", () => {
    expect(hunkRange(A)).toEqual({ oldStart: 8, oldCount: 7, newStart: 8, newCount: 7 });
    expect(hunkRange({ id: 0, header: "@@ -3 +3 @@", lines: [] })).toEqual({ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 });
    expect(hunkRange({ id: 0, header: "not a header", lines: [] })).toBeNull();
  });
});

describe("diffGaps", () => {
  it("before the first hunk, between hunks, and after the last one (old numbers follow the hunks' offsets)", () => {
    expect(diffGaps(DIFF, { fileLines: null })).toEqual([
      { index: 0, from: 1, to: 7, oldOffset: 0 },
      { index: 1, from: 15, to: 27, oldOffset: 0 },
      { index: 2, from: 34, to: null, oldOffset: 1 },
    ]);
    // the file's length closes the last gap once full_file is known
    expect(diffGaps(DIFF, { fileLines: 40 })[2]).toEqual({ index: 2, from: 34, to: 40, oldOffset: 1 });
    expect(diffGaps(DIFF, { fileLines: 33 }).map((g) => g.index)).toEqual([0, 1]);
  });

  it("no gap after the last hunk when the diff was truncated or the hunk ends with fewer than 3 context lines (end of file)", () => {
    expect(diffGaps(DIFF, { fileLines: null, truncated: true }).map((g) => g.index)).toEqual([0, 1]);
    const atEof = hunk(1, "@@ -38,3 +38,3 @@", [ctx(38, 38), ctx(39, 39), del(40, "x"), add(40)]);
    expect(diffGaps({ ...DIFF, hunks: [A, atEof] }, { fileLines: null }).map((g) => g.index)).toEqual([0, 1]);
  });

  it("zero-count headers: an insertion after old line 10, a deletion of old lines 5–6", () => {
    const ins = hunk(0, "@@ -10,0 +11,3 @@", [add(11), add(12), add(13)]);
    expect(diffGaps({ ...DIFF, hunks: [ins] }, { fileLines: 20 })).toEqual([{ index: 0, from: 1, to: 10, oldOffset: 0 }]);
    const gone = hunk(0, "@@ -5,2 +4,0 @@", [del(5, "a"), del(6, "b")]);
    expect(diffGaps({ ...DIFF, hunks: [gone] }, { fileLines: 12 })).toEqual([{ index: 0, from: 1, to: 4, oldOffset: 0 }]);
  });

  it("a new file (one hunk from line 1, no trailing context) has no gap", () => {
    const created = hunk(0, "@@ -0,0 +1,3 @@", [add(1), add(2), add(3)]);
    expect(diffGaps({ ...DIFF, hunks: [created] }, { fileLines: 3 })).toEqual([]);
  });
});

describe("gapView / revealGap (20줄 더 보기)", () => {
  const big = { index: 1, from: 100, to: 149, oldOffset: -2 };

  it("down reveals the lines right after the previous hunk, up the lines right before the next one", () => {
    let s = revealGap({}, big, "down");
    expect(gapView(big, s[1], null)).toEqual({ down: range(100, 119), up: [], hidden: 30 });
    s = revealGap(s, big, "up");
    expect(gapView(big, s[1], null)).toEqual({ down: range(100, 119), up: range(130, 149), hidden: 10 });
    s = revealGap(s, big, "down");
    // the gap closes: nothing is shown twice
    expect(gapView(big, s[1], null)).toEqual({ down: range(100, 129), up: range(130, 149), hidden: 0 });
  });

  it("a gap smaller than a step is revealed whole by one click", () => {
    const small = { index: 0, from: 1, to: 7, oldOffset: 0 };
    expect(gapView(small, revealGap({}, small, "up")[0], null)).toEqual({ down: [], up: range(1, 7), hidden: 0 });
    expect(CONTEXT_STEP).toBe(20);
  });

  it("the last gap is unknown in size until full_file arrives", () => {
    const tail = { index: 2, from: 34, to: null, oldOffset: 1 };
    expect(gapView(tail, undefined, null)).toEqual({ down: [], up: [], hidden: null });
    const s = revealGap({}, tail, "down");
    expect(gapView(tail, s[2], null)).toEqual({ down: [], up: [], hidden: null });
    expect(gapView(tail, s[2], 40)).toEqual({ down: range(34, 40), up: [], hidden: 0 });
  });
});

describe("contextRow / contextMatches", () => {
  it("a revealed line is an ordinary context row with both numbers and an id no diff line has", () => {
    expect(contextRow(NEW, 35, 1)).toEqual({ id: -35, kind: "context", oldNo: 36, newNo: 35, text: "n35" });
  });

  it("the full file must be the diff's new side (an edit on disk since the snapshot disables the context)", () => {
    expect(contextMatches(DIFF, NEW)).toBe(true);
    const edited = [...NEW];
    edited[12] = "changed on disk";
    expect(contextMatches(DIFF, edited)).toBe(false);
    expect(contextMatches(DIFF, [])).toBe(false);
    // CRLF files: git keeps the CR in the diff text, full_file splits it off
    const crlf: FileDiff = { ...DIFF, hunks: [hunk(0, "@@ -1,1 +1,1 @@", [{ id: 900, kind: "context", oldNo: 1, newNo: 1, text: "n1\r" }])] };
    expect(contextMatches(crlf, NEW)).toBe(true);
  });
});

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
