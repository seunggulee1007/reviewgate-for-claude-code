// §62 / §65.8 — code navigation keys (Windows): F12, Shift+F12, Alt+F12, F4 / Shift+F4, Alt+← / Alt+→, Ctrl+Alt+O and the
// palettes Ctrl+P / Ctrl+F12 / Ctrl+Alt+Shift+N; none of them is another key's — the window's key maps and the shortcut table.
import { describe, expect, it } from "vitest";
import { chatTabKey, isAskAboutKey, isWorkbenchChatKey, navKey, sideThreadKey, terminalChatKey, windowKey } from "../keymap";
import { isNoteKey } from "../noteShortcut";
import { isTerminalPanelKey } from "../terminal/terminalKeys";
import { isHistoryKey, isReopenTabKey, tabStepKey } from "../chatTabsState";
import { isExternalEditKey } from "../externalEdit";
import { isModeCycleKey } from "../terminalMode";
import { SHORTCUT_SECTIONS } from "../shortcutTable";

const k = (key: string, over: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

/** Every key of the navigation, as Windows sends it (the palettes' letters also as a Korean layout reads them). */
const NAV_KEYS = [
  [k("F12"), "definition"],
  [k("F12", { shiftKey: true }), "references"],
  [k("F12", { altKey: true }), "peek"],
  [k("F4"), "nextReference"],
  [k("F4", { shiftKey: true }), "previousReference"],
  [k("ArrowLeft", { altKey: true }), "back"],
  [k("ArrowRight", { altKey: true }), "forward"],
  [k("o", { code: "KeyO", ctrlKey: true, altKey: true }), "openInIde"],
  [k("ㅐ", { code: "KeyO", ctrlKey: true, altKey: true }), "openInIde"],
  [k("p", { code: "KeyP", ctrlKey: true }), "goToFile"],
  [k("ㅔ", { code: "KeyP", ctrlKey: true }), "goToFile"],
  [k("F12", { ctrlKey: true }), "fileSymbols"],
  [k("N", { code: "KeyN", ctrlKey: true, altKey: true, shiftKey: true }), "projectSymbols"],
  [k("ㅜ", { code: "KeyN", ctrlKey: true, altKey: true, shiftKey: true }), "projectSymbols"],
] as const;

describe("navKey (§62, §65.8)", () => {
  it("reads every navigation key (the physical letter — a Korean layout reads ㅐ / ㅔ / ㅜ)", () => {
    for (const [e, want] of NAV_KEYS) expect(navKey(e), `${e.key} ${JSON.stringify(e)}`).toBe(want);
  });

  it("leaves the neighbours alone: Alt+F4 is Windows', Ctrl+Shift+O / Ctrl+T stay Switch Project / New chat", () => {
    for (const e of [
      k("F4", { altKey: true }),
      k("F4", { ctrlKey: true }),
      k("F12", { altKey: true, shiftKey: true }),
      k("F12", { ctrlKey: true, shiftKey: true }),
      k("ArrowLeft"),
      k("ArrowLeft", { altKey: true, shiftKey: true }),
      k("ArrowLeft", { ctrlKey: true, altKey: true }),
      k("o", { code: "KeyO", ctrlKey: true }),
      k("O", { code: "KeyO", ctrlKey: true, shiftKey: true }),
      k("o", { code: "KeyO", ctrlKey: true, altKey: true, shiftKey: true }),
      k("t", { code: "KeyT", ctrlKey: true }),
      k("P", { code: "KeyP", ctrlKey: true, shiftKey: true }),
      k("p", { code: "KeyP", ctrlKey: true, altKey: true }),
      k("n", { code: "KeyN", ctrlKey: true, altKey: true }),
      k("N", { code: "KeyN", ctrlKey: true, shiftKey: true }),
    ])
      expect(navKey(e), JSON.stringify(e)).toBeNull();
  });

  it("no other key map of the window reads a navigation key", () => {
    for (const [e] of NAV_KEYS) {
      const what = JSON.stringify(e);
      expect(windowKey(e), what).toBeNull();
      expect(chatTabKey(e), what).toBeNull();
      expect(terminalChatKey(e), what).toBeNull();
      expect(isWorkbenchChatKey(e), what).toBe(false);
      expect(isAskAboutKey(e), what).toBe(false);
      expect(sideThreadKey(e), what).toBeNull();
      expect(isNoteKey(e), what).toBe(false);
      expect(isTerminalPanelKey(e), what).toBe(false);
      expect(tabStepKey(e), what).toBeNull();
      expect(isReopenTabKey(e, false), what).toBe(false);
      expect(isHistoryKey(e, false), what).toBe(false);
      expect(isExternalEditKey(e), what).toBe(false);
      expect(isModeCycleKey(e), what).toBe(false);
    }
  });

  it("no other row of the shortcut table (docs/SHORTCUTS.md) uses a Windows key of the navigation", () => {
    const rows = SHORTCUT_SECTIONS.flatMap((s) => s.rows.map((r) => ({ ...r, section: s.title })));
    const nav = ["F12", "Shift+F12", "Alt+F12", "F4", "Shift+F4", "Alt+←", "Alt+→", "Ctrl+Alt+O", "Ctrl+P", "Ctrl+F12", "Ctrl+Alt+Shift+N"];
    for (const key of nav) {
      const users = rows.filter((r) => r.win === key);
      expect(users.length, key).toBe(1);
      expect(["Code navigation", "Find"], key).toContain(users[0]!.section);
    }
    // the keys Windows kept: Ctrl+Shift+O and Ctrl+T are not the symbol palettes there
    expect(rows.find((r) => r.win === "Ctrl+Shift+O")?.action).toBe("Switch Project…");
    expect(rows.find((r) => r.win === "Ctrl+T")?.action).toBe("New chat");
  });
});
