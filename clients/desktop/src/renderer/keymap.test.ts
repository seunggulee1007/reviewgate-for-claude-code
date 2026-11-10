/** wave4 w4-input: the window's shortcuts (src/renderer/keymap.ts) and their hints on each platform. */
import { afterAll, describe, expect, it } from "vitest";
import { initI18n, t } from "./i18n";
import { chatTabKey, isAskAboutKey, sideThreadKey } from "./keymap";

const key = (k: string, over: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("side question: ⌥⌘/ (Ctrl+Alt+/), not ⌘⇧/ (macOS's Help menu search)", () => {
  it("takes ⌥⌘/ on a Mac (the key reads ÷ with ⌥ held) and Ctrl+Alt+/ elsewhere", () => {
    expect(isAskAboutKey(key("÷", { code: "Slash", metaKey: true, altKey: true }))).toBe(true);
    expect(isAskAboutKey(key("/", { code: "Slash", ctrlKey: true, altKey: true }))).toBe(true);
  });

  it("leaves ⌘⇧/ to the system and ⌘/ to the slash palette", () => {
    expect(isAskAboutKey(key("?", { code: "Slash", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isAskAboutKey(key("/", { code: "Slash", metaKey: true }))).toBe(false);
    expect(isAskAboutKey(key("÷", { code: "Slash", altKey: true }))).toBe(false);
  });

  afterAll(() => initI18n("en", "darwin"));
  it("hints read ⌥⌘/ on a Mac and Ctrl+Alt+/ on Windows", () => {
    initI18n("en", "darwin");
    expect(t("New side question (⌥⌘/)")).toBe("New side question (⌥⌘/)");
    initI18n("ko", "darwin");
    expect(t("New side question (⌥⌘/)")).toBe("새 곁질문 (⌥⌘/)");
    expect(t("Ask a side question about this — the main conversation is not affected (⌥⌘/)")).toContain("(⌥⌘/)");
    initI18n("ko", "win32");
    expect(t("New side question (⌥⌘/)")).toBe("새 곁질문 (Ctrl+Alt+/)");
  });
});

describe("chat tabs: ⌘T new chat, ⌘1…⌘9 a tab (Ctrl on Windows)", () => {
  it("reads the physical key", () => {
    expect(chatTabKey(key("t", { code: "KeyT", metaKey: true }))).toEqual({ kind: "new" });
    expect(chatTabKey(key("ㅅ", { code: "KeyT", metaKey: true }))).toEqual({ kind: "new" });
    expect(chatTabKey(key("t", { code: "KeyT", ctrlKey: true }))).toEqual({ kind: "new" });
    expect(chatTabKey(key("1", { code: "Digit1", metaKey: true }))).toEqual({ kind: "tab", index: 0 });
    expect(chatTabKey(key("9", { code: "Digit9", ctrlKey: true }))).toEqual({ kind: "tab", index: 8 });
  });

  it("⌘⇧W / Ctrl+Shift+W closes the tab on screen; ⌘W stays the window's", () => {
    expect(chatTabKey(key("W", { code: "KeyW", metaKey: true, shiftKey: true }))).toEqual({ kind: "close" });
    expect(chatTabKey(key("ㅉ", { code: "KeyW", ctrlKey: true, shiftKey: true }))).toEqual({ kind: "close" });
    expect(chatTabKey(key("w", { code: "KeyW", metaKey: true }))).toBeNull();
    expect(chatTabKey(key("W", { code: "KeyW", ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
  });

  it("leaves other combinations alone", () => {
    expect(chatTabKey(key("t", { code: "KeyT" }))).toBeNull();
    expect(chatTabKey(key("T", { code: "KeyT", metaKey: true, shiftKey: true }))).toBeNull();
    expect(chatTabKey(key("0", { code: "Digit0", metaKey: true }))).toBeNull();
    expect(chatTabKey(key("1", { code: "Digit1", metaKey: true, altKey: true }))).toBeNull();
  });

  it("hints read ⌘T on a Mac and Ctrl+T on Windows", () => {
    initI18n("en", "win32");
    expect(t("{0} ({1})", t("New chat"), "⌘T")).toBe("New chat (Ctrl+T)");
    expect(t("{0} ({1})", "x", "⌘1")).toBe("x (Ctrl+1)");
    expect(t("{0} ({1})", "x", "⌥⌘↩")).toBe("x (Ctrl+Alt+Enter)");
    expect(t("{0} ({1})", t("Add note"), "⌥⌘N")).toBe("Add note (Ctrl+Alt+N)");
    initI18n("en", "darwin");
    expect(t("{0} ({1})", t("New chat"), "⌘T")).toBe("New chat (⌘T)");
  });
});

describe("side thread follow-up: ⌘↩ to the main conversation, ⌥⌘↩ as a review note", () => {
  it("maps the two keys", () => {
    expect(sideThreadKey(key("Enter", { metaKey: true }))).toBe("message");
    expect(sideThreadKey(key("Enter", { ctrlKey: true, altKey: true }))).toBe("note");
  });

  it("leaves plain Enter (ask), ⇧ and the IME's Enter alone", () => {
    expect(sideThreadKey(key("Enter"))).toBeNull();
    expect(sideThreadKey(key("Enter", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(sideThreadKey({ ...key("Enter", { metaKey: true }), keyCode: 229 })).toBeNull();
  });
});
