// §62 — code navigation keys (Windows): F12, Shift+F12, Alt+← / Alt+→, Ctrl+Alt+O; none of them is another key's.
import { describe, expect, it } from "vitest";
import { chatTabKey, navKey, terminalChatKey, windowKey } from "../keymap";
import { isNoteKey } from "../noteShortcut";

const k = (key: string, over: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("navKey (§62)", () => {
  it("reads F12, Shift+F12, Alt+arrows and Ctrl+Alt+O (the physical O — a Korean layout reads ㅐ)", () => {
    expect(navKey(k("F12"))).toBe("definition");
    expect(navKey(k("F12", { shiftKey: true }))).toBe("references");
    expect(navKey(k("F12", { altKey: true }))).toBe("peek"); // §65.8
    expect(navKey(k("ArrowLeft", { altKey: true }))).toBe("back");
    expect(navKey(k("ArrowRight", { altKey: true }))).toBe("forward");
    expect(navKey(k("o", { code: "KeyO", ctrlKey: true, altKey: true }))).toBe("openInIde");
    expect(navKey(k("ㅐ", { code: "KeyO", ctrlKey: true, altKey: true }))).toBe("openInIde");
  });

  it("leaves the other keys alone, and no other key map reads these", () => {
    expect(navKey(k("F12", { ctrlKey: true }))).toBeNull();
    expect(navKey(k("ArrowLeft"))).toBeNull();
    expect(navKey(k("ArrowLeft", { altKey: true, shiftKey: true }))).toBeNull();
    expect(navKey(k("ArrowLeft", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(navKey(k("o", { code: "KeyO", ctrlKey: true }))).toBeNull();
    expect(navKey(k("o", { code: "KeyO", ctrlKey: true, altKey: true, shiftKey: true }))).toBeNull();
    expect(navKey(k("F12", { altKey: true, shiftKey: true }))).toBeNull();
    for (const e of [k("o", { code: "KeyO", ctrlKey: true, altKey: true }), k("ArrowLeft", { altKey: true }), k("ArrowRight", { altKey: true }), k("F12"), k("F12", { shiftKey: true }), k("F12", { altKey: true })]) {
      expect(windowKey(e)).toBeNull();
      expect(chatTabKey(e)).toBeNull();
      expect(terminalChatKey(e)).toBeNull();
      expect(isNoteKey(e)).toBe(false);
    }
  });
});
