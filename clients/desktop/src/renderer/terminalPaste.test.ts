/** §57.7 / plan §4.6: what a paste into the terminal carries, and why it cannot happen. */
import { afterAll, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { pastedText, pasteRefusal, sanitizePaste } from "./terminalPaste";

describe("sanitizePaste", () => {
  it("drops the paste markers and any other ESC", () => {
    expect(sanitizePaste("a\x1b[201~b")).toBe("ab");
    expect(sanitizePaste("\x1b[200~x\x1b[201~")).toBe("x");
    expect(sanitizePaste("red \x1b[31mtext\x1b[0m")).toBe("red [31mtext[0m");
    expect(sanitizePaste("\x1b")).toBe("");
  });
  it("line breaks become CR — inside the brackets a newline in the prompt, never Enter", () => {
    expect(sanitizePaste("one\r\ntwo\nthree\rfour")).toBe("one\rtwo\rthree\rfour");
  });
  it("keeps Korean, tabs and the rest as is", () => {
    expect(sanitizePaste("한글\t'quote' \"x\" `y` — …")).toBe("한글\t'quote' \"x\" `y` — …");
  });
});

describe("pasteRefusal", () => {
  afterAll(() => initI18n("en", "darwin"));
  const ok = { liveTerminalChat: true, running: true, bracketed: true };
  it("pastes into the live, running terminal chat with bracketed paste on", () => {
    expect(pasteRefusal(ok, "fix it")).toBeNull();
  });
  it("says why not", () => {
    expect(pasteRefusal({ ...ok, liveTerminalChat: false }, "x")).toBe("The chat on screen is not a live terminal chat");
    expect(pasteRefusal({ ...ok, running: false }, "x")).toBe("Claude Code is not running in this terminal — restart it first");
    expect(pasteRefusal({ ...ok, bracketed: false }, "x")).toBe("Claude Code is not ready for a paste yet — try again once its prompt shows");
    expect(pasteRefusal(ok, "\x1b[201~")).toBe("Claude Code is not ready for a paste yet — try again once its prompt shows");
  });
  it("the toast names Enter on Windows, Return on a Mac — in Korean too", () => {
    initI18n("en", "win32");
    expect(pastedText()).toBe("Pasted into the terminal — press Enter there to send it");
    initI18n("en", "darwin");
    expect(pastedText()).toBe("Pasted into the terminal — press Return there to send it");
    initI18n("ko", "win32");
    expect(pastedText()).toMatch(/[가-힣]/);
    expect(pasteRefusal({ ...ok, running: false }, "x")).toMatch(/[가-힣]/);
  });
});
