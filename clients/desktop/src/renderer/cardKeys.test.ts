import { describe, expect, it } from "vitest";
import { cardShortcut, focusInOtherCard, isTextField, isTypingIn, MAIN_COMPOSER_SELECTOR, MONACO_INPUT_SELECTOR, permissionShortcut, planEscape, type FocusLike, type KeyLike } from "./permissionKeys";

// ---------------------------------------------------------------- card keys (audit polish-01)

type FakeOpts = { value?: string; type?: string; readOnly?: boolean; editable?: boolean; composer?: boolean; inside?: string[]; card?: string };
/** A focused element as the key checks see it: `inside` lists the ancestor selectors `closest` finds. */
function el(tagName: string, o: FakeOpts = {}): FocusLike {
  return {
    tagName,
    ...(o.value !== undefined ? { value: o.value } : {}),
    ...(o.type !== undefined ? { type: o.type } : {}),
    readOnly: o.readOnly === true,
    isContentEditable: o.editable === true,
    matches: (sel) => sel === MAIN_COMPOSER_SELECTOR && o.composer === true,
    closest: (sel) => {
      if (sel === "[data-permission-id]") return o.card !== undefined ? { getAttribute: () => o.card! } : null;
      const wanted = sel.split(",").map((s) => s.trim());
      return (o.inside ?? []).some((s) => wanted.includes(s)) ? { getAttribute: () => null } : null;
    },
  };
}
const key = (k: string, m: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });

describe("card shortcuts stay out of text fields (audit polish-01)", () => {
  const composerEmpty = el("TEXTAREA", { value: "", composer: true, inside: [".composer"] });
  const composerDraft = el("TEXTAREA", { value: "draft", composer: true, inside: [".composer"] });
  const sideEmpty = el("TEXTAREA", { value: "", inside: [".side-panel"] });
  const findEmpty = el("INPUT", { value: "", type: "text", inside: [".find-bar"] });
  const noteEmpty = el("TEXTAREA", { value: "", inside: [".note-composer"] });
  const planNote = el("INPUT", { value: "", type: "text", inside: [".plan-card"] });

  it("only the EMPTY main composer lets ⌘↩ through to the card; every other field owns its keys even while empty", () => {
    expect(isTypingIn(null)).toBe(false);
    expect(isTypingIn(el("BODY"))).toBe(false);
    expect(isTypingIn(el("BUTTON"))).toBe(false);
    expect(isTypingIn(composerEmpty)).toBe(false);
    expect(isTypingIn(composerDraft)).toBe(true);
    expect(isTypingIn(sideEmpty)).toBe(true);
    expect(isTypingIn(findEmpty)).toBe(true);
    expect(isTypingIn(noteEmpty)).toBe(true);
    expect(isTypingIn(planNote)).toBe(true);
    expect(isTypingIn(el("DIV", { editable: true }))).toBe(true);
    expect(isTypingIn(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTypingIn(el("TEXTAREA", { value: "", readOnly: true }))).toBe(false);
    // the read-only Monaco diff view keeps the shortcuts working (its hidden textarea is not a field); the fields Monaco
    // hosts for us — a note composer, the find widget — own their keys (cardKeysMonaco.test.ts)
    expect(isTypingIn({ ...el("TEXTAREA", { value: "", inside: [".monaco-editor"] }), matches: (sel) => sel === MONACO_INPUT_SELECTOR })).toBe(false);
    expect(isTextField(el("INPUT", { type: "search" }))).toBe(true);
    expect(isTextField(el("SELECT"))).toBe(false);
  });

  const ctx = (focus: FocusLike | null, extra: Partial<{ allowSession: boolean; dialogOpen: boolean; mac: boolean }> = {}) => ({ mac: true, focus, requestId: "r1", allowSession: true, dialogOpen: false, ...extra });

  it("⌘↩ / ⌥⌘↩ / ⌘⌫ in the side question, find and note fields never answer the card", () => {
    for (const focus of [sideEmpty, findEmpty, noteEmpty, planNote, composerDraft]) {
      expect(cardShortcut(key("Enter", { metaKey: true }), ctx(focus))).toBeNull();
      expect(cardShortcut(key("Enter", { metaKey: true, altKey: true }), ctx(focus))).toBeNull();
      expect(cardShortcut(key("Backspace", { metaKey: true }), ctx(focus))).toBeNull();
      // Ctrl on Windows / Linux — the same fields own the same keys
      expect(cardShortcut(key("Enter", { ctrlKey: true }), ctx(focus, { mac: false }))).toBeNull();
    }
  });

  it("answers the target card from an empty composer or a plain focus; Ctrl elsewhere", () => {
    expect(cardShortcut(key("Enter", { metaKey: true }), ctx(composerEmpty))).toBe("once");
    expect(cardShortcut(key("Enter", { metaKey: true, altKey: true }), ctx(null))).toBe("session");
    expect(cardShortcut(key("Backspace", { metaKey: true }), ctx(el("BODY")))).toBe("deny");
    expect(cardShortcut(key("Enter", { ctrlKey: true }), ctx(null, { mac: false }))).toBe("once");
    expect(cardShortcut(key("Enter", { ctrlKey: true }), ctx(null))).toBeNull();
  });

  it("no session allow for a reason / SendMessage card, nothing over a dialog, nothing while another card has focus, nothing while composing", () => {
    expect(cardShortcut(key("Enter", { metaKey: true, altKey: true }), ctx(null, { allowSession: false }))).toBeNull();
    expect(cardShortcut(key("Enter", { metaKey: true }), ctx(null, { allowSession: false }))).toBe("once");
    expect(cardShortcut(key("Enter", { metaKey: true }), ctx(null, { dialogOpen: true }))).toBeNull();
    const radioInQuestion = el("INPUT", { type: "radio", card: "q9" });
    expect(focusInOtherCard(radioInQuestion, "r1")).toBe(true);
    expect(focusInOtherCard(el("BUTTON", { card: "r1" }), "r1")).toBe(false);
    expect(cardShortcut(key("Enter", { metaKey: true }), ctx(radioInQuestion))).toBeNull();
    expect(cardShortcut(key("Enter", { metaKey: true }), ctx(el("BUTTON", { card: "r1" })))).toBe("once");
    expect(permissionShortcut(key("Enter", { metaKey: true, isComposing: true }), { mac: true, typing: false })).toBeNull();
    expect(permissionShortcut(key("Enter", { metaKey: true, defaultPrevented: true }), { mac: true, typing: false })).toBeNull();
  });

  it("Esc keeps planning only when nothing else wants it", () => {
    const quiet = { dialogOpen: false, overlayOpen: false };
    expect(planEscape(key("Escape"), { focus: null, ...quiet })).toBe(true);
    expect(planEscape(key("Escape"), { focus: el("BODY"), ...quiet })).toBe(true);
    expect(planEscape(key("Escape"), { focus: el("BUTTON", { inside: [".plan-card"] }), ...quiet })).toBe(true);
    // a field (composer, find bar, side question, review note, the plan's own note) or the diff editor has focus
    for (const focus of [composerEmpty, composerDraft, findEmpty, sideEmpty, noteEmpty, planNote, el("DIV", { inside: [".monaco-editor"] })]) {
      expect(planEscape(key("Escape"), { focus, ...quiet })).toBe(false);
    }
    // a button elsewhere (a menu / popover / side panel button) — its Esc is not about the plan
    expect(planEscape(key("Escape"), { focus: el("BUTTON", { inside: [".side-panel"] }), ...quiet })).toBe(false);
    // the composer's palette / the find bar already handled it
    expect(planEscape(key("Escape", { defaultPrevented: true }), { focus: null, ...quiet })).toBe(false);
    expect(planEscape(key("Escape", { isComposing: true }), { focus: null, ...quiet })).toBe(false);
    expect(planEscape(key("Escape", { shiftKey: true }), { focus: null, ...quiet })).toBe(false);
    expect(planEscape(key("Escape"), { focus: null, dialogOpen: true, overlayOpen: false })).toBe(false);
    expect(planEscape(key("Escape"), { focus: null, dialogOpen: false, overlayOpen: true })).toBe(false);
    expect(planEscape(key("Enter"), { focus: null, ...quiet })).toBe(false);
  });
});
