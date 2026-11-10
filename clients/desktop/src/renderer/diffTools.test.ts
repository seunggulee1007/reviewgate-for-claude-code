import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff } from "@reviewgate/engine";
import { MAX_FIND_MATCHES, findInDiff, newLineNear, pathLineOf } from "./diffTools";

const line = (id: number, kind: DiffLine["kind"], oldNo: number | null, newNo: number | null, text: string): DiffLine => ({ id, kind, oldNo, newNo, text });

const DIFF: FileDiff = {
  oldPath: "api/Old.java",
  newPath: "api/Svc.java",
  isBinary: false,
  hunks: [
    {
      id: 0,
      header: "@@ -1,3 +1,3 @@ class Svc",
      lines: [
        line(0, "hunkHeader", null, null, "@@ -1,3 +1,3 @@ class Svc userId"),
        line(1, "context", 1, 1, "long userId = 1;"),
        line(2, "del", 2, null, "find(userId, UserId)"),
        line(3, "add", null, 2, "find(userId, cartId)"),
      ],
    },
  ],
};

describe("findInDiff (diff에서 찾기)", () => {
  it("every case-insensitive hit of the code lines, in order; hunk header rows are not searched", () => {
    expect(findInDiff(DIFF, "userid")).toEqual([
      { lineId: 1, start: 5 },
      { lineId: 2, start: 5 },
      { lineId: 2, start: 13 },
      { lineId: 3, start: 5 },
    ]);
    expect(findInDiff(DIFF, "cart")).toEqual([{ lineId: 3, start: 13 }]);
  });

  it("an empty / blank query finds nothing; the number of hits is capped", () => {
    expect(findInDiff(DIFF, "")).toEqual([]);
    expect(findInDiff(DIFF, "   ")).toEqual([]);
    const many: FileDiff = { ...DIFF, hunks: [{ id: 0, header: "@@", lines: Array.from({ length: MAX_FIND_MATCHES + 50 }, (_, i) => line(i, "add", null, i + 1, "x")) }] };
    expect(findInDiff(many, "x")).toHaveLength(MAX_FIND_MATCHES);
  });
});

describe("newLineNear (에디터에서 열기 at a line)", () => {
  it("a new-side line is its own number; a deleted line opens where it was (the next new line, else the one before)", () => {
    const [, ctx, del, add] = DIFF.hunks[0]!.lines;
    expect(newLineNear(DIFF, ctx!)).toBe(1);
    expect(newLineNear(DIFF, add!)).toBe(2);
    expect(newLineNear(DIFF, del!)).toBe(2);
    const tailDel: FileDiff = { ...DIFF, hunks: [{ id: 0, header: "@@ -1,2 +1,1 @@", lines: [line(0, "hunkHeader", null, null, "@@"), line(1, "context", 1, 1, "a"), line(2, "del", 2, null, "b")] }] };
    expect(newLineNear(tailDel, tailDel.hunks[0]!.lines[2]!)).toBe(1);
    expect(newLineNear(DIFF, DIFF.hunks[0]!.lines[0]!)).toBeNull();
  });
});

describe("pathLineOf (경로:줄 복사)", () => {
  it("new-side lines name the file and their new number; a deleted line its old path and old number", () => {
    expect(pathLineOf(DIFF.hunks[0]!.lines[1]!, "api/Svc.java", "api/Old.java")).toBe("api/Svc.java:1");
    expect(pathLineOf(DIFF.hunks[0]!.lines[3]!, "api/Svc.java", "api/Old.java")).toBe("api/Svc.java:2");
    expect(pathLineOf(DIFF.hunks[0]!.lines[2]!, "api/Svc.java", "api/Old.java")).toBe("api/Old.java:2");
    expect(pathLineOf(DIFF.hunks[0]!.lines[2]!, "api/Svc.java", null)).toBe("api/Svc.java:2");
    expect(pathLineOf(DIFF.hunks[0]!.lines[0]!, "api/Svc.java", null)).toBeNull();
  });
});
