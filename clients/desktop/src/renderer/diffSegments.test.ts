import { describe, expect, it } from "vitest";
import { segmentParts, validSegments } from "./diffSegments";

// docs/PROTOCOL.md §34.7: the two lines of the example pair.
const DEL = "    return repo.find(id).orElseThrow();";
const ADD = "    return repo.find(id).orElseThrow(NotFound::new);";

describe("segmentParts (§34.7 DiffLine.segments)", () => {
  it("splits the protocol example into unchanged / changed parts that cover the whole line", () => {
    expect(segmentParts(DEL, [[27, 38]])).toEqual([
      { text: DEL.slice(0, 27), changed: false },
      { text: DEL.slice(27, 38), changed: true },
      { text: DEL.slice(38), changed: false },
    ]);
    // a range reaching the end of the line leaves no empty tail part
    expect(segmentParts(ADD, [[27, 52]])).toEqual([
      { text: ADD.slice(0, 27), changed: false },
      { text: ADD.slice(27), changed: true },
    ]);
  });

  it("no segments (absent, empty, an older engine) → the line as one unchanged part", () => {
    expect(segmentParts("abc", undefined)).toEqual([{ text: "abc", changed: false }]);
    expect(segmentParts("abc", [])).toEqual([{ text: "abc", changed: false }]);
    expect(segmentParts("", [[0, 0]])).toEqual([{ text: "", changed: false }]);
  });

  it("several ranges, a range at the start and one reaching the end", () => {
    expect(segmentParts("a = b + c", [[0, 1], [8, 9]])).toEqual([
      { text: "a", changed: true },
      { text: " = b + ", changed: false },
      { text: "c", changed: true },
    ]);
  });

  it("is lenient with what the wire carries: unsorted, overlapping, adjacent, out of range, garbage", () => {
    // unsorted + overlapping + adjacent ranges merge; out-of-range ends are clamped; junk entries are dropped
    expect(validSegments("0123456789", [[6, 8], [2, 4], [3, 5], [5, 6], [8, 99]])).toEqual([[2, 10]]);
    expect(validSegments("0123456789", [[4, 2], [-3, 1], [1.5, 3], "x", null, [7], [Number.NaN, 2]] as unknown)).toEqual([[0, 1]]);
    expect(validSegments("abc", "nope" as unknown)).toEqual([]);
    expect(validSegments("abc", [[3, 9]])).toEqual([]);
  });

  it("never splits a surrogate pair (UTF-16 offsets as the engine sends them)", () => {
    const text = "x😀y"; // "😀" is two UTF-16 code units at [1, 3)
    // a range ending inside the pair grows to its end; one starting inside it moves to its start
    expect(validSegments(text, [[0, 2]])).toEqual([[0, 3]]);
    expect(validSegments(text, [[2, 4]])).toEqual([[1, 4]]);
    expect(segmentParts(text, [[1, 3]])).toEqual([
      { text: "x", changed: false },
      { text: "😀", changed: true },
      { text: "y", changed: false },
    ]);
  });

  it("Korean text and tabs keep their offsets (JS string indices = UTF-16 units)", () => {
    const text = "\tlog.info(\"사용자 조회\");";
    const start = text.indexOf("조회");
    const parts = segmentParts(text, [[start, start + 2]]);
    expect(parts.find((p) => p.changed)?.text).toBe("조회");
    expect(parts.map((p) => p.text).join("")).toBe(text);
  });
});
