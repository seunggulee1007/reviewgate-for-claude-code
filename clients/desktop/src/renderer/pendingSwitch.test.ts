import { beforeEach, describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { cancelPendingSwitch, drainPendingSwitch, holdSwitch, onHeldMessageBack, pendingSwitchText, switchWaits, usePendingSwitch, type SwitchDeps } from "./pendingSwitch";
import { newChatRefusal, sessionSwitchRefusal } from "./sessions";

/**
 * r2-chats-cards M31 / M33 — docs/PROTOCOL.md §9 "Held switches": a new chat or a switch asked for while the live chat works
 * waits for it instead of being refused, goes out once its turn and queue are done, and a message held with it then joins
 * that chat's queue; the review never holds a switch, a failed collection refuses.
 */

function state(phase: string, o: { current?: string; collectError?: string | null; notes?: boolean } = {}): ReviewState {
  return {
    project: { root: "/work/acme", path: "/work/acme", name: "acme", branch: "main" },
    session: { starting: false },
    gate: { phase, collectError: o.collectError ?? null },
    changedFiles: [{ path: "a.ts", state: "changesRequested" }],
    reviewNotes: o.notes ? [{ id: "n1", sent: undefined }] : [],
    sessions: { list: [{ id: "s1", title: "Mapper fix" }, { id: "s2", title: "Yesterday" }], currentId: o.current ?? "s1", openTabIds: ["s1", "s2"] },
  } as unknown as ReviewState;
}

function deps(over: Partial<SwitchDeps> & { s: () => ReviewState; log: string[] }): SwitchDeps {
  return {
    state: over.s,
    queued: over.queued ?? (() => false),
    newChat: over.newChat ?? (async () => (over.log.push("session_new"), true)),
    openChat: over.openChat ?? (async (id) => (over.log.push(`session_open ${id}`), true)),
    untilLive: over.untilLive ?? (async () => true),
    enqueue: over.enqueue ?? ((text) => void over.log.push(`enqueue ${text}`)),
    fail: over.fail ?? ((m) => void over.log.push(`fail ${m}`)),
  };
}

describe("held chat switches (§9, M31 / M33)", () => {
  beforeEach(() => {
    initI18n("en", "darwin");
    usePendingSwitch.setState({ pending: null, inflight: false });
  });

  it("the review never refuses a switch; busy makes it wait; a failed collection refuses", () => {
    const reviewing = state("reviewing", { notes: true });
    expect(sessionSwitchRefusal(reviewing)).toBeNull(); // unsent notes and a change request stay in the review
    expect(newChatRefusal(reviewing)).toBeNull();
    expect(switchWaits(state("running"), false)).toBe(true);
    expect(switchWaits(state("idle"), true)).toBe(true); // the live chat's queue goes first
    expect(switchWaits(state("reviewing"), false)).toBe(false);
    expect(newChatRefusal(state("running"))).toBeNull();
    expect(newChatRefusal(state("collectFailed", { collectError: "git add -A failed" }))).toBe("Retry collecting the changes first");
  });

  it("a new chat waits for the turn and the queue, then goes out once", async () => {
    let s = state("running");
    let queued = false;
    const log: string[] = [];
    const d = deps({ s: () => s, queued: () => queued, log });
    holdSwitch({ kind: "new" });
    expect(pendingSwitchText(s, usePendingSwitch.getState().pending)).toBe("A new chat opens once Claude is done in 'Mapper fix'");
    await drainPendingSwitch(d);
    expect(log).toEqual([]);
    s = state("reviewing");
    queued = true;
    await drainPendingSwitch(d);
    expect(log).toEqual([]); // the queued message goes to the chat it was typed in first
    queued = false;
    await drainPendingSwitch(d);
    await drainPendingSwitch(d);
    expect(log).toEqual(["session_new"]);
    expect(usePendingSwitch.getState().pending).toBeNull();
  });

  it("a message sent from another chat goes there after the switch; called off, it comes back to the composer", async () => {
    const log: string[] = [];
    const back: string[] = [];
    onHeldMessageBack((text) => back.push(text));
    holdSwitch({ kind: "open", id: "s2", messages: [{ text: "go on here" }] });
    expect(pendingSwitchText(state("running"), usePendingSwitch.getState().pending)).toBe("Your message goes to 'Yesterday' once Claude is done in 'Mapper fix'");
    await drainPendingSwitch(deps({ s: () => state("idle"), log }));
    expect(log).toEqual(["session_open s2", "enqueue go on here"]);

    holdSwitch({ kind: "open", id: "s2", messages: [{ text: "never mind" }] });
    cancelPendingSwitch();
    expect(back).toEqual(["never mind"]);
    // A switch that did not land gives the text back too.
    holdSwitch({ kind: "open", id: "s2", messages: [{ text: "again" }] });
    await drainPendingSwitch(deps({ s: () => state("idle"), log, untilLive: async () => false }));
    expect(back).toEqual(["never mind", "again"]);
  });

  it("no held message is lost: the same chat's add up and go out in order, a switch elsewhere gives them back whole", async () => {
    const log: string[] = [];
    const back: { text: string; chips?: unknown }[] = [];
    onHeldMessageBack((text, chips) => back.push({ text, ...(chips ? { chips } : {}) }));
    const chips = { mentions: ["src/cart.ts"], mentionDirs: {}, images: [] };
    holdSwitch({ kind: "open", id: "s2", messages: [{ text: "first", chips }] });
    holdSwitch({ kind: "open", id: "s2", messages: [{ text: "then this" }] });
    holdSwitch({ kind: "open", id: "s2", messages: [] }); // [이 채팅으로 이어가기] to the same chat keeps them
    expect(usePendingSwitch.getState().pending).toMatchObject({ kind: "open", id: "s2", messages: [{ text: "first" }, { text: "then this" }] });
    await drainPendingSwitch(deps({ s: () => state("idle"), log }));
    expect(log).toEqual(["session_open s2", "enqueue first", "enqueue then this"]);
    expect(back).toEqual([]);

    holdSwitch({ kind: "open", id: "s2", messages: [{ text: "first", chips }] });
    holdSwitch({ kind: "open", id: "s2", messages: [{ text: "then this" }] });
    holdSwitch({ kind: "new" }); // the last one wins — what was held for 'Yesterday' goes back, with its chips
    expect(usePendingSwitch.getState().pending).toEqual({ kind: "new" });
    expect(back).toEqual([{ text: "first", chips }, { text: "then this" }]);
  });

  it("a failed collection drops the held switch with its reason", async () => {
    const log: string[] = [];
    holdSwitch({ kind: "new" });
    await drainPendingSwitch(deps({ s: () => state("collectFailed", { collectError: "git add -A failed" }), log }));
    expect(log).toEqual(["fail Retry collecting the changes first"]);
    expect(usePendingSwitch.getState().pending).toBeNull();
  });
});
