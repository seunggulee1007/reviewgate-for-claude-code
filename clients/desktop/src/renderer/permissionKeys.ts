/**
 * Card shortcuts (pure, unit-tested). Permission card: Ctrl/⌘↩ allow once, Alt+Ctrl/⌘↩ allow for the session,
 * Ctrl/⌘⌫ deny — on the card that has waited longest (§33.1). They never steal keys from text the user is typing:
 * they apply when focus is outside any text field, or in the EMPTY main composer (where ⌘↩ would send nothing anyway).
 * Every other field — side question, find bar, review note, the plan's note — owns its keys even while empty
 * (audit polish-01). Plan card: Esc = keep planning only when nothing else wants the Esc.
 */
export type PermissionAnswer = "once" | "session" | "deny";

export type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; defaultPrevented?: boolean };

/** `mac`: ⌘ is the modifier (Ctrl elsewhere). `typing`: focus is in a field that owns the key (`isTypingIn`). */
export function permissionShortcut(e: KeyLike, ctx: { mac: boolean; typing: boolean }): PermissionAnswer | null {
  const mod = ctx.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.shiftKey || ctx.typing || e.isComposing === true || e.defaultPrevented === true) return null;
  if (e.key === "Enter") return e.altKey ? "session" : "once";
  if ((e.key === "Backspace" || e.key === "Delete") && !e.altKey) return "deny";
  return null;
}

/** wave3 check-clients: the deny key as the card shows it — ⌫ is a Mac glyph, Windows / Linux read "Ctrl+Backspace". */
export const denyKeyHint = (mac: boolean): string => (mac ? "⌘⌫" : "Ctrl+Backspace");

/** What the focus checks read of an element — a DOM `Element`, or a plain fake in the unit tests. */
export type FocusLike = {
  tagName: string;
  value?: string;
  type?: string;
  readOnly?: boolean;
  isContentEditable?: boolean;
  matches?(selector: string): boolean;
  closest?(selector: string): { getAttribute(name: string): string | null } | null;
};

/** The main message box (components/chat/Composer.tsx): while empty, ⌘↩ there answers the card (the Mac app's "Send or allow"). */
export const MAIN_COMPOSER_SELECTOR = ".composer > textarea";

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image", "hidden"]);

/** A field that takes typed text — `<textarea>`, a text-like `<input>`, contenteditable — and is not read-only. */
export function isTextField(el: FocusLike | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || (tag === "INPUT" && !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase()))) return el.readOnly !== true;
  return el.isContentEditable === true;
}

/**
 * The read-only diff editor's own hidden input (Monaco's textarea, its EditContext element, its IME textarea) — not a
 * field the user types into. Fields Monaco hosts for us (the review note composer in a view zone, its find widget) are.
 */
export const MONACO_INPUT_SELECTOR = ".monaco-editor textarea.inputarea, .monaco-editor .native-edit-context, .monaco-editor textarea.ime-text-area";

/** Card shortcuts leave the key to the focused field: any text field except the empty main composer and the read-only diff editor. */
export function isTypingIn(el: FocusLike | null): boolean {
  // wave2 check-clients: only the editor's own input is exempt — a note typed in the full-file view keeps ⌘↩ / Ctrl+⌫.
  if (!el || el.matches?.(MONACO_INPUT_SELECTOR)) return false;
  if (!isTextField(el)) return false;
  if (el.matches?.(MAIN_COMPOSER_SELECTOR)) return (el.value ?? "").length > 0;
  return true;
}

/** Focus sits inside another card (a question card's option, another permission card): the keys are about that card. */
export function focusInOtherCard(el: FocusLike | null, requestId: string): boolean {
  const card = el?.closest?.("[data-permission-id]") ?? null;
  return card !== null && card.getAttribute("data-permission-id") !== requestId;
}

/**
 * The answer a key press gives the shortcut target card (`requestId`), or null: not a card key, a field owns it,
 * another card has focus, a dialog is open, or ⌥⌘↩ on a card that offers no session allow (a reason / SendMessage card).
 */
export function cardShortcut(
  e: KeyLike,
  ctx: { mac: boolean; focus: FocusLike | null; requestId: string; allowSession: boolean; dialogOpen: boolean },
): PermissionAnswer | null {
  if (ctx.dialogOpen || focusInOtherCard(ctx.focus, ctx.requestId)) return null;
  const answer = permissionShortcut(e, { mac: ctx.mac, typing: isTypingIn(ctx.focus) });
  if (answer === "session" && !ctx.allowSession) return null;
  return answer;
}

/**
 * Esc = "keep planning" (components/chat/PlanCard.tsx) only for a plain Esc nothing has handled yet, with no dialog,
 * menu or popover open, and the focus on the page itself or a button of the plan card — never in a text field (the
 * composer, find bar, side question, review note or the plan's own note) or the diff editor, where Esc means something
 * else (audit polish-01: closing the find bar or a palette used to re-plan).
 */
export function planEscape(e: KeyLike, ctx: { focus: FocusLike | null; dialogOpen: boolean; overlayOpen: boolean }): boolean {
  if (e.key !== "Escape" || e.defaultPrevented === true || e.isComposing === true) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || ctx.dialogOpen || ctx.overlayOpen) return false;
  const f = ctx.focus;
  if (!f) return true;
  const tag = f.tagName.toUpperCase();
  if (tag === "BODY" || tag === "HTML") return true;
  if (isTextField(f) || f.closest?.(".monaco-editor")) return false;
  return Boolean(f.closest?.(".plan-card"));
}
