// MARK: wave4b w4b-files — §40.2 (comp-11): what a diff without lines is, the same lines as Core `FileMetaText`.
import { describe, expect, it } from "vitest";
import type { FileDiff } from "@reviewgate/engine";
import { fileMetaLines, formatBytes } from "./fileMeta";

const diff = (over: Partial<FileDiff> = {}): FileDiff => ({ oldPath: "a", newPath: "a", isBinary: false, hunks: [], ...over });

describe("fileMetaLines", () => {
  it("names a pure move, a rename with edits, and a mode change", () => {
    expect(fileMetaLines(diff({ oldPath: "src/Old.java", newPath: "src/New.java", similarity: 100 }))).toEqual(["Moved without a content change (similarity 100%)"]);
    expect(fileMetaLines(diff({ oldPath: "src/Old.java", newPath: "src/New.java", similarity: 87 }))).toEqual(["Renamed (similarity 87%)"]);
    expect(fileMetaLines(diff({ oldMode: "100644", newMode: "100755" }))).toEqual(["Executable permission added 644→755"]);
    expect(fileMetaLines(diff({ oldMode: "100755", newMode: "100644" }))).toEqual(["Executable permission removed 755→644"]);
    expect(fileMetaLines(diff({ newMode: "100755" }))).toEqual(["New executable file (755)"]);
    expect(fileMetaLines(diff({ oldMode: "100644", newMode: "120000" }))).toEqual(["File mode changed 100644→120000"]);
  });

  it("gives a binary's sizes", () => {
    expect(fileMetaLines(diff({ isBinary: true, binarySize: { old: 12_288, new: 14_336 } }))).toEqual(["Binary · 12KB → 14KB"]);
    expect(fileMetaLines(diff({ isBinary: true, binarySize: { old: null, new: 2_048 } }))).toEqual(["Binary · new file 2KB"]);
    expect(fileMetaLines(diff({ isBinary: true, binarySize: { old: 500, new: null } }))).toEqual(["Binary · deleted 500B"]);
    // An older engine sends no sizes: nothing to add to "Binary file".
    expect(fileMetaLines(diff({ isBinary: true }))).toEqual([]);
  });

  it("says nothing for an ordinary diff", () => {
    expect(fileMetaLines(diff())).toEqual([]);
    expect(fileMetaLines(diff({ similarity: undefined, oldMode: undefined }))).toEqual([]);
  });

  it("formats sizes as the Mac does", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(1023)).toBe("1023B");
    expect(formatBytes(1024)).toBe("1KB");
    expect(formatBytes(1536)).toBe("2KB");
    expect(formatBytes(5 * 1024 * 1024 + 300 * 1024)).toBe("5.3MB");
  });
});
