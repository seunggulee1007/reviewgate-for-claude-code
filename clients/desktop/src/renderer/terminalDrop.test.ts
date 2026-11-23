/** §57.5 / §57.17: a drop on a terminal chat's terminal — paths as the platform's terminal writes them, review rows as @path. */
import { describe, expect, it } from "vitest";
import { dropText, dropWord, mentionText } from "./terminalDrop";

describe("a drop on the terminal", () => {
  it("Windows: a path with a space or a shell character in double quotes, as Windows Terminal writes it", () => {
    expect(dropWord("C:\\Users\\dev\\acme\\notes.md", "win32")).toBe("C:\\Users\\dev\\acme\\notes.md");
    expect(dropWord("C:\\Users\\dev\\Pictures\\Screenshot 2026-11-23.png", "win32")).toBe('"C:\\Users\\dev\\Pictures\\Screenshot 2026-11-23.png"');
    expect(dropWord("C:\\tmp\\a&b(1).txt", "win32")).toBe('"C:\\tmp\\a&b(1).txt"');
    expect(dropWord("C:\\Users\\dev\\문서\\스크린샷.png", "win32")).toBe("C:\\Users\\dev\\문서\\스크린샷.png");
    expect(dropText(["C:\\a b.png", "C:\\c.txt"], "win32")).toBe('"C:\\a b.png" C:\\c.txt ');
  });
  it("macOS / Linux: a backslash before each shell character, as Terminal.app writes it; unicode as it is", () => {
    expect(dropWord("/Users/dev/Screenshot 1.png", "darwin")).toBe("/Users/dev/Screenshot\\ 1.png");
    expect(dropWord(`/tmp/it's "q".txt`, "darwin")).toBe(`/tmp/it\\'s\\ \\"q\\".txt`);
    expect(dropWord("/Users/dev/문서/스크린샷 1.png", "linux")).toBe("/Users/dev/문서/스크린샷\\ 1.png");
    expect(dropWord("/tmp/a\nb", "darwin")).toBe("'/tmp/a\nb'");
  });
  it("nothing for no path (a file not on disk has none)", () => {
    expect(dropText([], "win32")).toBe("");
    expect(dropText([""], "win32")).toBe("");
  });
  it("review-list rows as @path mentions", () => {
    expect(mentionText(["src/a.ts", "docs/my notes.md"])).toBe('@src/a.ts @"docs/my notes.md" ');
    expect(mentionText([])).toBe("");
  });
});
