import { describe, expect, test } from "vitest";
import { allLines, parseUnifiedDiff } from "../src/diff/parse.js";

// Port of Core/Tests/ReviewGateCoreTests/UnifiedDiffParserTests.swift (12 cases).
describe("parseUnifiedDiff", () => {
  test("multiHunkModifiedFile", () => {
    const patch = [
      "diff --git a/src/main.swift b/src/main.swift",
      "index 1111111..2222222 100644",
      "--- a/src/main.swift",
      "+++ b/src/main.swift",
      "@@ -1,4 +1,4 @@",
      " import Foundation",
      "-let a = 1",
      "+let a = 2",
      " let b = 3",
      " let c = 4",
      "@@ -20,3 +20,5 @@ func foo() {",
      "     x()",
      "+    y()",
      "+    z()",
      "     w()",
      " }",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.oldPath).toBe("src/main.swift");
    expect(d.newPath).toBe("src/main.swift");
    expect(d.isBinary).toBe(false);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0].header).toBe("@@ -1,4 +1,4 @@");
    expect(d.hunks[1].header).toBe("@@ -20,3 +20,5 @@ func foo() {");

    const h0 = d.hunks[0].lines;
    expect(h0.map((l) => l.kind)).toEqual(["hunkHeader", "context", "del", "add", "context", "context"]);
    expect([h0[1].oldNo, h0[1].newNo, h0[1].text]).toEqual([1, 1, "import Foundation"]);
    expect([h0[2].oldNo, h0[2].newNo, h0[2].text]).toEqual([2, null, "let a = 1"]);
    expect([h0[3].oldNo, h0[3].newNo, h0[3].text]).toEqual([null, 2, "let a = 2"]);
    expect([h0[4].oldNo, h0[4].newNo]).toEqual([3, 3]);
    expect([h0[5].oldNo, h0[5].newNo]).toEqual([4, 4]);

    const h1 = d.hunks[1].lines;
    expect(h1.map((l) => l.kind)).toEqual(["hunkHeader", "context", "add", "add", "context", "context"]);
    expect([h1[1].oldNo, h1[1].newNo, h1[1].text]).toEqual([20, 20, "    x()"]);
    expect([h1[2].newNo, h1[3].newNo]).toEqual([21, 22]);
    expect([h1[4].oldNo, h1[4].newNo]).toEqual([21, 23]);
    expect([h1[5].oldNo, h1[5].newNo, h1[5].text]).toEqual([22, 24, "}"]);

    // ids are indices into allLines and hunkHeader rows are included
    const all = allLines(d);
    expect(all).toHaveLength(12);
    expect(all.map((l) => l.id)).toEqual([...Array(12).keys()]);
    expect(all[6].kind).toBe("hunkHeader");
    expect(all[6].text).toBe(d.hunks[1].header);
    expect([all[6].oldNo, all[6].newNo]).toEqual([null, null]);
  });

  test("newFile", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..3b18e51",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.oldPath).toBeNull();
    expect(d.newPath).toBe("new.txt");
    expect(d.hunks).toHaveLength(1);
    const lines = d.hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(["hunkHeader", "add", "add"]);
    expect([lines[1].newNo, lines[1].oldNo, lines[1].text]).toEqual([1, null, "hello"]);
    expect([lines[2].newNo, lines[2].text]).toEqual([2, "world"]);
  });

  test("deletedFile", () => {
    const patch = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 3b18e51..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-hello",
      "-world",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.oldPath).toBe("gone.txt");
    expect(d.newPath).toBeNull();
    const lines = d.hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(["hunkHeader", "del", "del"]);
    expect([lines[1].oldNo, lines[1].newNo]).toEqual([1, null]);
    expect(lines[2].oldNo).toBe(2);
  });

  test("renameWithHunk", () => {
    const patch = [
      "diff --git a/old/name.txt b/new/name.txt",
      "similarity index 80%",
      "rename from old/name.txt",
      "rename to new/name.txt",
      "index 1111111..2222222 100644",
      "--- a/old/name.txt",
      "+++ b/new/name.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.oldPath).toBe("old/name.txt");
    expect(d.newPath).toBe("new/name.txt");
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].lines.map((l) => l.kind)).toEqual(["hunkHeader", "context", "del", "add", "context"]);
  });

  test("pureRenameWithoutHunk", () => {
    const patch = [
      "diff --git a/README.md b/RENAMED.md",
      "similarity index 100%",
      "rename from README.md",
      "rename to RENAMED.md",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.oldPath).toBe("README.md");
    expect(d.newPath).toBe("RENAMED.md");
    expect(d.hunks).toEqual([]);
    expect(d.isBinary).toBe(false);
  });

  test("binaryFilesDiffer", () => {
    const patch = [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.isBinary).toBe(true);
    expect([d.oldPath, d.newPath]).toEqual(["img.png", "img.png"]);
    expect(d.hunks).toEqual([]);
  });

  test("gitBinaryPatch", () => {
    const patch = [
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "index 0000000..2222222",
      "GIT binary patch",
      "literal 12",
      "Tc$@<Z0000000000000000000",
      "@@ -1 +1 @@ this is payload, not a hunk",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.isBinary).toBe(true);
    expect(d.newPath).toBe("img.png");
    expect(d.hunks).toEqual([]);
  });

  test("headerlessGitHubPatch", () => {
    const patch = [
      "@@ -10,3 +10,4 @@ class Foo {",
      "   let x = 1",
      "+  let y = 2",
      "   let z = 3",
      " }",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    expect([d.oldPath, d.newPath]).toEqual([null, null]);
    expect(d.isBinary).toBe(false);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].header).toBe("@@ -10,3 +10,4 @@ class Foo {");
    const lines = d.hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(["hunkHeader", "context", "add", "context", "context"]);
    expect([lines[1].oldNo, lines[1].newNo]).toEqual([10, 10]);
    expect([lines[2].oldNo, lines[2].newNo]).toEqual([null, 11]);
    expect([lines[3].oldNo, lines[3].newNo]).toEqual([11, 12]);
    expect([lines[4].oldNo, lines[4].newNo, lines[4].text]).toEqual([12, 13, "}"]);
  });

  test("noNewlineMarkerIsSkipped", () => {
    const patch = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const d = parseUnifiedDiff(patch);
    const lines = d.hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(["hunkHeader", "del", "add"]);
    expect([lines[1].text, lines[1].oldNo]).toEqual(["old", 1]);
    expect([lines[2].text, lines[2].newNo]).toEqual(["new", 1]);
    expect(allLines(d)).toHaveLength(3);
  });

  test("hunkHeaderWithoutCounts", () => {
    const patch = ["@@ -5 +7 @@", "-a", "+b", ""].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.hunks).toHaveLength(1);
    const lines = d.hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(["hunkHeader", "del", "add"]);
    expect(lines[1].oldNo).toBe(5);
    expect(lines[2].newNo).toBe(7);
  });

  test("deletedLineStartingWithDashesIsNotAHeader", () => {
    const patch = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,2 +1,1 @@", "--- not a header", " keep", ""].join("\n");
    const d = parseUnifiedDiff(patch);
    expect(d.oldPath).toBe("f.txt");
    const lines = d.hunks[0].lines;
    expect(lines.map((l) => l.kind)).toEqual(["hunkHeader", "del", "context"]);
    expect(lines[1].text).toBe("-- not a header");
  });

  test("emptyPatch", () => {
    const d = parseUnifiedDiff("");
    expect(d.hunks).toEqual([]);
    expect(d.isBinary).toBe(false);
    expect([d.oldPath, d.newPath]).toEqual([null, null]);
    expect(allLines(d)).toEqual([]);
  });
});
