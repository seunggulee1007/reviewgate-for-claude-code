import { describe, expect, it } from "vitest";
import { addSegments, SEGMENT_LINE_MAX_UNITS, SEGMENT_MAX_PAIRED_LINES, segmentPair, tokenize } from "../src/diff/segments.js";
import { allLines, parseUnifiedDiff, type DiffLine } from "../src/diff/parse.js";

/** A one-hunk patch: `-` / `+` / ` ` prefixed body lines (counts are derived). */
function patch(body: string[]): string {
  const old = body.filter((l) => !l.startsWith("+")).length;
  const neu = body.filter((l) => !l.startsWith("-")).length;
  return [`diff --git a/f.txt b/f.txt`, `--- a/f.txt`, `+++ b/f.txt`, `@@ -1,${old} +1,${neu} @@`, ...body, ""].join("\n");
}

const changed = (lines: DiffLine[]) => lines.filter((l) => l.kind === "add" || l.kind === "del");
/** The text covered by a line's segments. */
const covered = (l: DiffLine) => (l.segments ?? []).map(([s, e]) => l.text.slice(s, e));

describe("tokenize (§34.7)", () => {
  it("splits into words, whitespace runs and single code points, with UTF-16 offsets", () => {
    expect(tokenize("a_b1 +=  한글😀x").map((t) => [t.text, t.start])).toEqual([
      ["a_b1", 0],
      [" ", 4],
      ["+", 5],
      ["=", 6],
      ["  ", 7],
      ["한글", 9],
      ["😀", 11],
      ["x", 13],
    ]);
  });
});

describe("segmentPair (§34.7)", () => {
  it("marks only the changed tokens; an insertion leaves the other side with an empty list", () => {
    const a = "    return repo.find(id).orElseThrow();";
    const b = "    return repo.find(id).orElseThrow(NotFound::new);";
    const r = segmentPair(a, b)!;
    expect(r.a).toEqual([]);
    expect(r.b).toEqual([[37, 50]]);
    expect(b.slice(37, 50)).toBe("NotFound::new");
  });

  it("merges adjacent changed tokens and keeps ranges ascending", () => {
    const a = "const value = x+y; // keep this comment as it is";
    const b = "const value = a-b; // keep this comment as it is";
    const r = segmentPair(a, b)!;
    expect(r.a).toEqual([[14, 17]]);
    expect(r.b).toEqual([[14, 17]]);
    const c = segmentPair("int total = first + second + third;", "int total = first * second * third;")!;
    expect(c.a).toEqual([[18, 19], [27, 28]]);
  });

  it("never splits a code point (offsets are UTF-16 units of each line)", () => {
    const a = "😀 상태값 확인: enabled = true; // 기존 주석은 그대로 둡니다";
    const b = "😀 상태값 확인: enabled = false; // 기존 주석은 그대로 둡니다";
    const r = segmentPair(a, b)!;
    expect(r.a.map(([s, e]) => a.slice(s, e))).toEqual(["true"]);
    expect(r.b.map(([s, e]) => b.slice(s, e))).toEqual(["false"]);
    // An emoji (two UTF-16 units) is one token: a change of it covers both units, never one of them.
    const e = segmentPair("😀 상태: 정상 — 이 줄의 나머지는 그대로입니다", "😎 상태: 정상 — 이 줄의 나머지는 그대로입니다")!;
    expect(e.a).toEqual([[0, 2]]);
    expect(e.b).toEqual([[0, 2]]);
  });

  it("gives none for a rewrite (> 60 % of the longer line) and for lines over the length limit", () => {
    expect(segmentPair("line2", "line2 changed")).toBeNull(); // 8 of 13 units changed
    expect(segmentPair("alpha beta gamma", "totally different words")).toBeNull();
    const long = "x".repeat(SEGMENT_LINE_MAX_UNITS) + " tail";
    expect(segmentPair(long, long + "!")).toBeNull();
  });

  it("identical texts (an end-of-line change) pair with empty lists", () => {
    expect(segmentPair("same", "same")).toEqual({ a: [], b: [] });
  });
});

describe("addSegments over a parsed diff (§34.7)", () => {
  it("pairs the i-th del with the i-th add of a block; unpaired lines and context get nothing", () => {
    const d = parseUnifiedDiff(
      patch([
        " context line stays the same",
        "-  call(alpha, beta);",
        "-  call(gamma, delta);",
        "-  removed without a partner",
        "+  call(alpha, BETA);",
        "+  call(gamma, DELTA);",
        " another context line",
        "+  added alone",
      ]),
    );
    const lines = allLines(d);
    const [d1, d2, d3, a1, a2, a3] = changed(lines);
    expect(covered(d1!)).toEqual(["beta"]);
    expect(covered(a1!)).toEqual(["BETA"]);
    expect(covered(d2!)).toEqual(["delta"]);
    expect(covered(a2!)).toEqual(["DELTA"]);
    expect(d3!.segments).toBeUndefined();
    expect(a3!.segments).toBeUndefined();
    expect(lines.filter((l) => l.kind === "context" || l.kind === "hunkHeader").every((l) => l.segments === undefined && l.wsOnly === undefined)).toBe(true);
    expect(d.segmentsLimited).toBeUndefined();
  });

  it("wsOnly on both lines of a pair that differs only in whitespace", () => {
    const d = parseUnifiedDiff(patch(["-if (a) {", "+if (a)  {", "-  x();", "+  y();"]));
    const [d1, a1, d2, a2] = changed(allLines(d));
    expect(d1!.wsOnly).toBe(true);
    expect(a1!.wsOnly).toBe(true);
    expect(covered(a1!)).toEqual(["  "]);
    expect(d2!.wsOnly).toBeUndefined();
    expect(a2!.wsOnly).toBeUndefined();
  });

  it("a block with more than 200 lines on either side is not paired", () => {
    const dels = Array.from({ length: 201 }, (_, i) => `-value ${i} = old;`);
    const adds = Array.from({ length: 3 }, (_, i) => `+value ${i} = new;`);
    const d = parseUnifiedDiff(patch([...dels, ...adds]));
    expect(changed(allLines(d)).every((l) => l.segments === undefined && l.wsOnly === undefined)).toBe(true);
  });

  it("at most 4 000 paired lines of a file get segments; the rest none with segmentsLimited", () => {
    // 2 100 one-line blocks (separated by context): 4 200 paired lines.
    const body: string[] = [];
    for (let i = 0; i < 2100; i++) body.push(` ctx ${i}`, `-item ${i} = old value here;`, `+item ${i} = new value here;`);
    const d = parseUnifiedDiff(patch(body));
    const pairs = changed(allLines(d));
    const withSegments = pairs.filter((l) => l.segments !== undefined);
    expect(withSegments).toHaveLength(SEGMENT_MAX_PAIRED_LINES);
    expect(pairs.slice(0, SEGMENT_MAX_PAIRED_LINES).every((l) => l.segments !== undefined)).toBe(true);
    expect(pairs.slice(SEGMENT_MAX_PAIRED_LINES).every((l) => l.segments === undefined)).toBe(true);
    expect(d.segmentsLimited).toBe(true);
  });

  it("stays fast on a large, heavily rewritten file: rewrites are rejected before any token diff", () => {
    const body: string[] = [];
    const words = (seed: number) => Array.from({ length: 300 }, (_, k) => `w${(k * 7919 + seed) % 1000}`).join(" ");
    for (let i = 0; i < 150; i++) body.push(...Array.from({ length: 10 }, (_, k) => `-${words(i * 10 + k)}`), ...Array.from({ length: 10 }, (_, k) => `+${words(i * 10 + k + 1)}`));
    const t0 = performance.now();
    const d = parseUnifiedDiff(patch(body));
    const ms = performance.now() - t0;
    expect(changed(allLines(d))).toHaveLength(3000);
    expect(changed(allLines(d)).every((l) => l.segments === undefined)).toBe(true);
    expect(d.segmentsLimited).toBeUndefined();
    expect(ms).toBeLessThan(10_000); // the structural checks above prove the rejection; this only catches an explosion, with room for a slow runner
  });

  it("the token-diff work budget: lines that share their tokens in another order stop it, cheaper pairs still get theirs", () => {
    const words = Array.from({ length: 300 }, (_, k) => `w${k}`);
    const body: string[] = [];
    for (let i = 0; i < 20; i++) body.push(` ctx ${i}`, `-${words.join(" ")}`, `+${[...words].reverse().join(" ")}`);
    body.push(" ctx end", "-int small = 1; // a short pair after the expensive ones", "+int small = 2; // a short pair after the expensive ones");
    const t0 = performance.now();
    const d = parseUnifiedDiff(patch(body));
    const ms = performance.now() - t0;
    const lines = changed(allLines(d));
    expect(lines.slice(0, 40).every((l) => l.segments === undefined)).toBe(true);
    expect(covered(lines[41]!)).toEqual(["2"]);
    expect(d.segmentsLimited).toBe(true);
    expect(ms).toBeLessThan(10_000); // the structural checks above prove the rejection; this only catches an explosion, with room for a slow runner
  });

  it("binary and header-only diffs are untouched", () => {
    const bin = parseUnifiedDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n");
    expect(bin).toEqual({ oldPath: "x.png", newPath: "x.png", isBinary: true, hunks: [] });
    expect(addSegments({ oldPath: "a", newPath: "a", isBinary: false, hunks: [] })).toEqual({ oldPath: "a", newPath: "a", isBinary: false, hunks: [] });
  });
});
