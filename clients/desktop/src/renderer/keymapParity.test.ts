// MARK: wave4d w4d-windows — audit polish-08: one set of keys on both apps (docs/SHORTCUTS.md). The Mac's View menu keys
// (⌥⌘A agent panel, ⌥⌘S side questions, ⌥⌘F find in diff) and its Stop (⌘.) work the same here (Ctrl on Windows).
import { describe, expect, it } from "vitest";
import { windowKey } from "./keymap";

const key = (k: string, over: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("window keys shared with the Mac (polish-08)", () => {
  it("⌥⌘A / Ctrl+Alt+A toggles the agent panel — the physical key decides (⌥A reads å, a Korean layout ㅁ)", () => {
    expect(windowKey(key("å", { code: "KeyA", metaKey: true, altKey: true }))).toBe("agentPanel");
    expect(windowKey(key("a", { code: "KeyA", ctrlKey: true, altKey: true }))).toBe("agentPanel");
    expect(windowKey(key("ㅁ", { code: "KeyA", ctrlKey: true, altKey: true }))).toBe("agentPanel");
  });

  it("⌥⌘S / Ctrl+Alt+S toggles the side questions, ⌥⌘F / Ctrl+Alt+F finds in the diff", () => {
    expect(windowKey(key("ß", { code: "KeyS", metaKey: true, altKey: true }))).toBe("sidePanel");
    expect(windowKey(key("s", { code: "KeyS", ctrlKey: true, altKey: true }))).toBe("sidePanel");
    expect(windowKey(key("ƒ", { code: "KeyF", metaKey: true, altKey: true }))).toBe("findInDiff");
    expect(windowKey(key("f", { code: "KeyF", ctrlKey: true, altKey: true }))).toBe("findInDiff");
  });

  // MARK: wave5 w5-board — §43.1
  it("⌥⌘B / Ctrl+Alt+B opens the agent board — the physical key decides (⌥B reads ∫, a Korean layout ㅠ)", () => {
    expect(windowKey(key("∫", { code: "KeyB", metaKey: true, altKey: true }))).toBe("board");
    expect(windowKey(key("b", { code: "KeyB", ctrlKey: true, altKey: true }))).toBe("board");
    expect(windowKey(key("ㅠ", { code: "KeyB", ctrlKey: true, altKey: true }))).toBe("board");
    expect(windowKey(key("b", { code: "KeyB", ctrlKey: true }))).toBeNull();
  });

  it("⌘. / Ctrl+. stops the turn", () => {
    expect(windowKey(key(".", { code: "Period", metaKey: true }))).toBe("stop");
    expect(windowKey(key(".", { code: "Period", ctrlKey: true }))).toBe("stop");
  });

  it("leaves every other combination alone — ⌘⇧E is no longer the agent panel, ⌘A selects all, ⌘S is not ours", () => {
    expect(windowKey(key("e", { code: "KeyE", metaKey: true, shiftKey: true }))).toBeNull();
    expect(windowKey(key("a", { code: "KeyA", metaKey: true }))).toBeNull();
    expect(windowKey(key("s", { code: "KeyS", ctrlKey: true }))).toBeNull();
    expect(windowKey(key("A", { code: "KeyA", metaKey: true, altKey: true, shiftKey: true }))).toBeNull();
    expect(windowKey(key(".", { code: "Period" }))).toBeNull();
    expect(windowKey(key(">", { code: "Period", metaKey: true, shiftKey: true }))).toBeNull();
    expect(windowKey(key("a", { code: "KeyA", altKey: true }))).toBeNull();
  });
});
