import { describe, expect, it } from "vitest";
import { cardShortcut, isTypingIn, type FocusLike, type KeyLike } from "./permissionKeys";

// wave2 check-clients — the Monaco full-file view hosts text fields of its own inside `.monaco-editor`: the review note
// composer (a view zone) and Monaco's find widget. Only the editor's own hidden input is "not a field".

/** `self`: the selectors the element itself matches (as `Element.matches` would); `inside`: the ancestors `closest` finds. */
function el(tagName: string, o: { value?: string; self?: string[]; inside?: string[] } = {}): FocusLike {
  const anyOf = (sel: string, pool: readonly string[]) => sel.split(",").some((s) => pool.includes(s.trim()));
  return {
    tagName,
    value: o.value ?? "",
    readOnly: false,
    isContentEditable: false,
    matches: (sel) => anyOf(sel, o.self ?? []),
    closest: (sel) => (sel !== "[data-permission-id]" && anyOf(sel, o.inside ?? []) ? { getAttribute: () => null } : null),
  };
}
const key = (k: string, m: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
const ctx = (focus: FocusLike, mac = true) => ({ mac, focus, requestId: "r1", allowSession: true, dialogOpen: false });

describe("card shortcuts and the Monaco full-file view (wave2 check-clients)", () => {
  const noteInZone = el("TEXTAREA", { inside: [".monaco-editor", ".view-zones", ".note-composer"] });
  const findWidget = el("TEXTAREA", { value: "member", inside: [".monaco-editor", ".find-widget"] });
  const monacoInput = el("TEXTAREA", { self: [".monaco-editor textarea.inputarea"], inside: [".monaco-editor"] });
  const monacoEditContext = el("DIV", { self: [".monaco-editor .native-edit-context"], inside: [".monaco-editor"] });
  const monacoIme = el("TEXTAREA", { self: [".monaco-editor textarea.ime-text-area"], inside: [".monaco-editor"] });

  it("the note composer inside the editor owns ⌘↩ / Ctrl+⌫ — typing a note never answers the oldest card", () => {
    expect(isTypingIn(noteInZone)).toBe(true);
    expect(cardShortcut(key("Enter", { metaKey: true }), ctx(noteInZone))).toBeNull();
    // Ctrl+Backspace deletes a word on Windows — it must not deny the card.
    expect(cardShortcut(key("Backspace", { ctrlKey: true }), ctx(noteInZone, false))).toBeNull();
  });

  it("Monaco's find widget owns its keys too", () => {
    expect(isTypingIn(findWidget)).toBe(true);
    expect(cardShortcut(key("Backspace", { ctrlKey: true }), ctx(findWidget, false))).toBeNull();
  });

  it("the read-only editor's own input still lets the card keys through", () => {
    expect(isTypingIn(monacoInput)).toBe(false);
    expect(isTypingIn(monacoEditContext)).toBe(false);
    expect(isTypingIn(monacoIme)).toBe(false);
    expect(cardShortcut(key("Enter", { metaKey: true }), ctx(monacoInput))).toBe("once");
  });
});
