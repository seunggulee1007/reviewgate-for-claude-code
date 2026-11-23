/**
 * wave4 w4-input — the window's keyboard map that the Mac's menus share (polish-05, polish-06). ⌘ is Ctrl and ⌥ is Alt
 * on Windows / Linux, as everywhere in this client.
 *
 * - ⌥⌘/ (Ctrl+Alt+/) asks a side question about the selection. It was ⌘⇧/, which macOS keeps for its Help menu search.
 * - ⌘T (Ctrl+T) starts a new chat; ⌘1…⌘9 (Ctrl+1…9) opens the chat tab at that place (polish-06); ⌘⇧W (Ctrl+Shift+W)
 *   closes the chat tab on screen — ⌘W stays the window's.
 * - In a side thread's follow-up field: ⌘↩ (Ctrl+Enter) sends the conclusion to the main conversation, ⌥⌘↩
 *   (Ctrl+Alt+Enter) adds it as a review note (polish-06) — the composer keeps its own ⌘↩.
 */
import { isEnter, type ImeKeyLike } from "./ime";

export type ShortcutKey = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

const mod = (e: ShortcutKey) => e.metaKey || e.ctrlKey;

/** ⌥⌘/ — the key is "÷" with ⌥ held on a Mac, so the physical key decides. */
export function isAskAboutKey(e: ShortcutKey): boolean {
  return mod(e) && e.altKey && !e.shiftKey && (e.code === "Slash" || e.key === "/");
}

export type ChatTabKey = { kind: "new" } | { kind: "tab"; index: number } | { kind: "close" };

/** ⌘T / ⌘1…⌘9 / ⌘⇧W — the physical key decides (a Korean input source reads ⌘T as "ㅅ", ⌘⇧W as "ㅉ"). */
export function chatTabKey(e: ShortcutKey): ChatTabKey | null {
  if (!mod(e) || e.altKey) return null;
  if (e.shiftKey) return e.code === "KeyW" || e.key.toLowerCase() === "w" ? { kind: "close" } : null;
  if (e.code === "KeyT" || e.key.toLowerCase() === "t") return { kind: "new" };
  const digit = /^Digit([1-9])$/.exec(e.code ?? "")?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : undefined);
  return digit ? { kind: "tab", index: Number(digit) - 1 } : null;
}

/**
 * §57.5 / §57.17: Ctrl+Alt+T a new terminal chat, Ctrl+Alt+Shift+T a classic one (the Mac's ⌃⌘T / ⌃⌥⌘T). The physical
 * key decides (a Korean input source reads T as "ㅅ").
 */
export function terminalChatKey(e: ShortcutKey): "terminal" | "classic" | null {
  if (!mod(e) || !e.altKey || !(e.code === "KeyT" || e.key.toLowerCase() === "t")) return null;
  return e.shiftKey ? "classic" : "terminal";
}

/** §9 New Chat in a Workbench: Ctrl+Alt+W (the Mac's ⌥⌘T — Ctrl+Alt+T is New Terminal Chat here). The physical key decides. */
export function isWorkbenchChatKey(e: ShortcutKey): boolean {
  return mod(e) && e.altKey && !e.shiftKey && (e.code === "KeyW" || e.key.toLowerCase() === "w");
}

/** ⌘↩ = "message" (to the main conversation), ⌥⌘↩ = "note" in a side thread's follow-up field; never the IME's Enter. */
export function sideThreadKey(e: ShortcutKey & ImeKeyLike): "message" | "note" | null {
  if (!mod(e) || e.shiftKey || !isEnter(e)) return null;
  return e.altKey ? "note" : "message";
}

// MARK: wave4d w4d-windows — audit polish-08: the Mac's View menu keys and its Stop, the same here (docs/SHORTCUTS.md).
export type WindowKey = "agentPanel" | "sidePanel" | "findInDiff" | "stop" | "board" | "diffLayout"; // MARK: wave5 w5-board: ⌥⌘B the agent board; §34.11 ⌥⌘L unified / split

/**
 * ⌥⌘A agent panel (was ⌘⇧E here), ⌥⌘S side questions, ⌥⌘F find in the diff, ⌘. stop — Ctrl+Alt+… / Ctrl+. on Windows.
 * The physical key decides: ⌥ turns A into "å" on a Mac and a Korean input source reads it as "ㅁ".
 */
export function windowKey(e: ShortcutKey): WindowKey | null {
  if (!mod(e) || e.shiftKey) return null;
  const is = (code: string, letter: string) => e.code === code || e.key.toLowerCase() === letter;
  if (e.altKey) {
    if (is("KeyA", "a")) return "agentPanel";
    if (is("KeyS", "s")) return "sidePanel";
    if (is("KeyF", "f")) return "findInDiff";
    if (is("KeyB", "b")) return "board"; // MARK: wave5 w5-board (§43.1)
    if (is("KeyL", "l")) return "diffLayout"; // §34.11
    return null;
  }
  return is("Period", ".") ? "stop" : null;
}

/**
 * §62 code navigation: F12, Shift+F12, Alt+← / Alt+→ (Back / Forward), Ctrl+Alt+O (Open in IDE — the physical O);
 * §65.8 Alt+F12 (Peek Definition).
 */
export type NavKey = "definition" | "references" | "back" | "forward" | "openInIde" | "peek";

export function navKey(e: ShortcutKey): NavKey | null {
  if (e.key === "F12" && !mod(e) && !e.altKey) return e.shiftKey ? "references" : "definition";
  if (e.key === "F12" && !mod(e) && e.altKey && !e.shiftKey) return "peek";
  if (e.altKey && !mod(e) && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return e.key === "ArrowLeft" ? "back" : "forward";
  if (mod(e) && e.altKey && !e.shiftKey && (e.code === "KeyO" || e.key.toLowerCase() === "o")) return "openInIde";
  return null;
}
