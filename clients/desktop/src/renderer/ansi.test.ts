// MARK: wave6 w6-statusline — §44.2: the status line's ANSI rules, checked against the vectors the Mac's Core
// AnsiTextTests read too (engine/test/fixtures/ansiVectors.json).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANSI_PALETTE, ansiColorCss, openableLink, parseAnsiLine, parseAnsiLines, textWidth, truncateRuns, xterm256, type AnsiRun } from "./ansi";

type Fixture = {
  palette: { dark: string[]; light: string[] };
  xterm256: [number, string][];
  parse: { name: string; lines: string[]; runs: AnsiRun[][] }[];
  width: [string, number][];
  truncate: { name: string; line: string; columns: number; runs: AnsiRun[] }[];
};

const fixture = JSON.parse(readFileSync(new URL("../../../../engine/test/fixtures/ansiVectors.json", import.meta.url), "utf8")) as Fixture;

describe("ANSI status line text (§44.2)", () => {
  for (const c of fixture.parse) {
    it(`parse: ${c.name}`, () => {
      expect(parseAnsiLines(c.lines)).toEqual(c.runs);
    });
  }

  for (const [text, width] of fixture.width) {
    it(`width: ${JSON.stringify(text)} is ${width}`, () => {
      expect(textWidth(text)).toBe(width);
    });
  }

  for (const c of fixture.truncate) {
    it(`truncate: ${c.name}`, () => {
      expect(truncateRuns(parseAnsiLine(c.line).runs, c.columns)).toEqual(c.runs);
    });
  }

  it("the 16 colors per appearance and the xterm 256 cube are the fixture's", () => {
    expect(ANSI_PALETTE.dark).toEqual(fixture.palette.dark);
    expect(ANSI_PALETTE.light).toEqual(fixture.palette.light);
    for (const [index, hex] of fixture.xterm256) expect(xterm256(index)).toBe(hex);
    expect(ansiColorCss(1, true)).toBe(fixture.palette.dark[1]);
    expect(ansiColorCss(1, false)).toBe(fixture.palette.light[1]);
    expect(ansiColorCss(214, true)).toBe("#ffaf00");
    expect(ansiColorCss("#102030", false)).toBe("#102030");
  });

  it("only http(s) links open", () => {
    expect(openableLink("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    expect(openableLink("HTTP://x.y")).toBe("HTTP://x.y");
    expect(openableLink("file:///Users/me/dev")).toBeNull();
    expect(openableLink("vscode://file/x")).toBeNull();
    expect(openableLink(undefined)).toBeNull();
  });
});
