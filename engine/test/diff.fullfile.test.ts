import { describe, expect, test } from "vitest";
import { FULL_FILE_MAX_LINES, deriveFullFile } from "../src/diff/fullfile.js";
import { parseUnifiedDiff, type FileDiff } from "../src/diff/parse.js";

// Port of Core/Tests/ReviewGateCoreTests/FullFileViewTests.swift (3 cases).
describe("deriveFullFile", () => {
  test("changedLinesAndDeletedAnchors", () => {
    // old: l1 l2 l3 l4 l5   →   new: l1 X l3 Y l5  (l2 replaced by X; l4 deleted; Y added after l3)
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,5 +1,5 @@",
      " l1",
      "-l2",
      "+X",
      " l3",
      "-l4",
      "+Y",
      " l5",
      "",
    ].join("\n");
    const diff = parseUnifiedDiff(patch);
    const view = deriveFullFile("f.txt", Buffer.from("l1\nX\nl3\nY\nl5\n", "utf8"), diff);
    expect(view.lines).toEqual(["l1", "X", "l3", "Y", "l5"]);
    expect(view.changedNewLines).toEqual([2, 4]);
    expect(view.deletedAfterNewLine).toEqual({ 1: ["l2"], 3: ["l4"] });
    expect(view.isBinary).toBe(false);
    expect(view.isTooLarge).toBe(false);
    expect(view.newText).toBe("l1\nX\nl3\nY\nl5\n");
    expect(view.oldText).toBe("l1\nl2\nl3\nl4\nl5\n");
  });

  test("deletionAtTopAnchorsAtZero", () => {
    const patch = ["@@ -1,2 +1 @@", "-gone", " kept", ""].join("\n");
    const view = deriveFullFile("f", Buffer.from("kept\n", "utf8"), parseUnifiedDiff(patch));
    expect(view.lines).toEqual(["kept"]);
    expect(view.changedNewLines).toEqual([]);
    expect(view.deletedAfterNewLine).toEqual({ 0: ["gone"] });
    expect(view.oldText).toBe("gone\nkept\n");
  });

  test("binaryAndTooLargeFlags", () => {
    const empty: FileDiff = { oldPath: null, newPath: "x", isBinary: false, hunks: [] };
    const bin = deriveFullFile("x", Buffer.from([0x41, 0x00, 0x42]), empty);
    expect(bin.isBinary).toBe(true);
    expect(bin.lines).toEqual([]);
    expect(bin.oldText).toBeNull();
    expect(bin.newText).toBeNull();

    const big = Buffer.from("a\n".repeat(FULL_FILE_MAX_LINES + 1), "utf8");
    const large = deriveFullFile("x", big, empty);
    expect(large.isTooLarge).toBe(true);
    expect(large.lines).toEqual([]);
    expect(large.isBinary).toBe(false);
  });

  test("splitsCRLF", () => {
    const empty: FileDiff = { oldPath: null, newPath: "x", isBinary: false, hunks: [] };
    const view = deriveFullFile("x", Buffer.from("a\r\nb\r\n", "utf8"), empty);
    expect(view.lines).toEqual(["a", "b"]);
  });
});
