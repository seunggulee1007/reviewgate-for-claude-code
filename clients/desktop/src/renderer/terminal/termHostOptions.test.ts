/** §57.10 / plan §4.1: xterm's options per platform and setting, the WebGL decision, links, acks. */
import { describe, expect, it } from "vitest";
import { ackStep, ACK_CHARS, clampFontSize, isOpenableLink, steppedFontSize, terminalOptions, TERMINAL_FONT_FAMILY, terminalTheme, usesWebgl } from "./termHostOptions";

describe("terminalOptions", () => {
  it("on Windows: ConPTY with the OS build, the console fonts, 5000 lines", () => {
    const o = terminalOptions({ platform: "win32", osBuild: 22631, fontSize: 13, theme: "dark" });
    expect(o.windowsPty).toEqual({ backend: "conpty", buildNumber: 22631 });
    expect(o.fontFamily).toBe(TERMINAL_FONT_FAMILY);
    expect(o.fontFamily).toMatch(/^'Cascadia Mono', Consolas, 'D2Coding', 'Malgun Gothic', monospace$/);
    expect(o.scrollback).toBe(5000);
    expect(o.allowProposedApi).toBe(true);
    expect(o.cursorBlink).toBe(true);
    expect(o.rightClickSelectsWord).toBe(false);
    expect(o.altClickMovesCursor).toBe(false);
    expect(o.screenReaderMode).toBe(false);
  });

  it("no build number when main does not know it; no windowsPty elsewhere", () => {
    expect(terminalOptions({ platform: "win32", osBuild: null, fontSize: 13, theme: "dark" }).windowsPty).toEqual({ backend: "conpty" });
    expect(terminalOptions({ platform: "darwin", osBuild: null, fontSize: 13, theme: "dark" }).windowsPty).toBeUndefined();
  });

  it("the font size setting, kept within 9…28", () => {
    expect(terminalOptions({ platform: "win32", osBuild: null, fontSize: 16, theme: "dark" }).fontSize).toBe(16);
    expect(clampFontSize(4)).toBe(9);
    expect(clampFontSize(99)).toBe(28);
    expect(clampFontSize("12")).toBe(13);
    expect(clampFontSize(undefined)).toBe(13);
    expect(steppedFontSize(13, 1)).toBe(14);
    expect(steppedFontSize(9, -1)).toBe(9);
    expect(steppedFontSize(28, 1)).toBe(28);
    expect(steppedFontSize(20, 0)).toBe(13);
  });

  it("the theme follows the window's", () => {
    expect(terminalOptions({ platform: "win32", osBuild: null, fontSize: 13, theme: "light" }).theme).toEqual(terminalTheme("light"));
    expect(terminalTheme("dark").background).not.toBe(terminalTheme("light").background);
    expect(terminalOptions({ platform: "win32", osBuild: null, fontSize: 13, theme: "dark", screenReader: true }).screenReaderMode).toBe(true);
  });
});

describe("WebGL or the DOM renderer", () => {
  it("auto uses WebGL until it failed once in this window; off never does", () => {
    expect(usesWebgl("auto", false)).toBe(true);
    expect(usesWebgl(undefined, false)).toBe(true);
    expect(usesWebgl("auto", true)).toBe(false);
    expect(usesWebgl("off", false)).toBe(false);
  });
});

describe("links", () => {
  it("only http(s) opens", () => {
    expect(isOpenableLink("https://example.com/a?b=c")).toBe(true);
    expect(isOpenableLink("http://localhost:3000")).toBe(true);
    for (const bad of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "vscode://file/x", "ms-settings:", "not a url"]) {
      expect(isOpenableLink(bad)).toBe(false);
    }
  });
});

describe("flow-control acks", () => {
  it("acks once 5,000 chars were written, carrying the rest", () => {
    expect(ackStep(0, 100)).toEqual([0, 100]);
    expect(ackStep(4900, 100)).toEqual([ACK_CHARS, 0]);
    expect(ackStep(4000, 70000)).toEqual([74000, 0]);
  });
});
