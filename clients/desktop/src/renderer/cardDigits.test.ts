import { beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "./i18n";
import { cardDigit, type KeyLike } from "./permissionKeys";
import { composerEnter, primarySend, workingHint } from "./sendNow";

/**
 * r2-chats-cards M24 — docs/PROTOCOL.md §33.10 (clients): with a permission card waiting and text typed, the send key denies
 * the card with the text as its instruction (⌥: stop and send); on the focused card 1 / 2 / 3 answer as in the terminal —
 * never an allow by a digit on a red card, never from a field.
 */
const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

describe("card keys (§33.10, M24)", () => {
  beforeEach(() => initI18n("en", "darwin"));

  it("1 / 2 / 3 on the focused card; nothing on a red card's allow, a SendMessage card's extras or with a modifier", () => {
    const plain = { cardFocused: true, danger: false, allowSession: true, sendMessage: false };
    expect(cardDigit(key("1"), plain)).toBe("once");
    expect(cardDigit(key("2"), plain)).toBe("session");
    expect(cardDigit(key("3"), plain)).toBe("instruct");
    expect(cardDigit(key("4"), plain)).toBeNull();
    expect(cardDigit(key("2"), { ...plain, allowSession: false })).toBeNull();
    const red = { ...plain, danger: true };
    expect(cardDigit(key("1"), red)).toBeNull();
    expect(cardDigit(key("2"), red)).toBeNull();
    expect(cardDigit(key("3"), red)).toBe("instruct");
    expect(cardDigit(key("2"), { ...plain, sendMessage: true })).toBeNull();
    expect(cardDigit(key("3"), { ...plain, sendMessage: true })).toBeNull();
    expect(cardDigit(key("1"), { ...plain, cardFocused: false })).toBeNull();
    expect(cardDigit(key("1", { metaKey: true }), plain)).toBeNull();
    expect(cardDigit(key("1", { isComposing: true }), plain)).toBeNull();
  });

  it("with a card waiting and text typed, the send key denies the card with the text; ⌥ stops and sends", () => {
    const o = { viewing: false, canSend: false, canSteer: true, question: false, card: true };
    expect(composerEnter({ shiftKey: false, altKey: false }, o)).toBe("deny");
    expect(composerEnter({ shiftKey: false, altKey: true }, o)).toBe("stopAndSend");
    expect(composerEnter({ shiftKey: false, altKey: false }, { ...o, card: false })).toBe("steer");
    expect(composerEnter({ shiftKey: false, altKey: false }, { ...o, viewing: true })).toBe("send"); // another chat: never the live card
    expect(primarySend({ canSend: false, queueMode: true, canSteer: true, card: true })).toBe("deny");
    expect(primarySend({ canSend: false, queueMode: true, canSteer: true, card: false })).toBe("steer");
    expect(workingHint("Waiting for your permission decision", true, false, false, false, true)).toBe("⌘↩ denies the card with this instruction · ⌥⌘↩ stops and sends");
    // With "Return sends the message" on (polish P4-composer-13) the key named is ↩.
    expect(workingHint("Waiting for your permission decision", true, false, false, true, true)).toBe("↩ denies the card with this instruction · ⌥⌘↩ stops and sends");
  });
});
