/** §58.1 continue-states: the Changes list's primary follows the review — the Mac's ContinueStatesTests. */
import { beforeAll, describe, expect, it } from "vitest";
import type { ChangedFileState, ReviewState, TerminalSessionState } from "@reviewgate/engine";
import type { ContinueChat } from "./acceptAllContinue";
import { runTerminalAcceptContinue, terminalContinueBlocker } from "./terminalAcceptContinue";

// The module reads the store (the send's reasons), which needs a window to load.
let mod: typeof import("./acceptAllContinue");
beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {},
  };
  mod = await import("./acceptAllContinue");
});

const term = (over: Partial<TerminalSessionState> = {}): TerminalSessionState => ({
  running: true,
  hooksSeen: true,
  promptId: null,
  waiting: null,
  interruptSuspected: false,
  ...over,
});
const f = (path: string, s: ChangedFileState["state"]) => ({ path, state: s }) as ChangedFileState;

function state(over: {
  phase?: string; canSend?: boolean; blocked?: string | null; files?: ChangedFileState[]; untold?: { accepted: number; rejected: number } | null;
  summary?: string | null; notes?: { sent?: unknown }[]; canRequest?: boolean; terminal?: TerminalSessionState; reviewFirst?: { mode: string; waiting: number } | null;
} = {}): ReviewState {
  const files = over.files ?? [];
  return {
    gate: {
      phase: over.phase ?? "reviewing",
      canSend: over.canSend ?? true,
      canRequestChanges: over.canRequest ?? true,
      blockedReason: over.blocked ?? null,
      pendingCount: files.filter((x) => x.state === "pending").length,
      changesRequestedCount: files.filter((x) => x.state === "changesRequested").length,
      untoldDecisions: over.untold ?? null,
      lastReviewSummary: over.summary ?? (over.untold ? "[Review gate] …" : null),
      reviewFirst: over.reviewFirst ?? null,
    },
    changedFiles: files,
    reviewNotes: over.notes ?? [],
    session: { terminal: over.terminal ?? term() },
  } as unknown as ReviewState;
}

const chat: ContinueChat = { viewing: false, terminal: null };
const terminal: ContinueChat = { viewing: false, terminal: { ptyId: "p1", shown: true, running: true, bracketed: true } };

describe("the review's Continue (§58.1)", () => {
  it("the decision table", () => {
    const p = (pending: number, unsentNotes: number, decided: boolean, untold: boolean) => mod.continuePrimaryOf({ pending, unsentNotes, decided, untold });
    expect(p(3, 0, false, false)).toEqual({ kind: "acceptAll", pending: 3 });
    expect(p(2, 0, true, false)).toEqual({ kind: "acceptRest", pending: 2 });
    expect(p(2, 0, false, true)).toEqual({ kind: "acceptRest", pending: 2 });
    expect(p(0, 0, true, true)).toEqual({ kind: "continue" });
    expect(p(0, 0, false, true)).toEqual({ kind: "continue" });
    expect(p(2, 1, true, true)).toEqual({ kind: "requestChanges", notes: 1 });
    expect(p(0, 2, false, false)).toEqual({ kind: "requestChanges", notes: 2 });
    expect(p(0, 0, true, false)).toBeNull();
    expect(p(0, 0, false, false)).toBeNull();
  });

  it("a chat follows the review, with titles", () => {
    const primary = (s: ReviewState) => mod.continuePrimary(s);
    expect(primary(state({ files: [f("a", "pending"), f("b", "pending")] }))).toEqual({ kind: "acceptAll", pending: 2 });
    expect(mod.continuePrimaryTitle({ kind: "acceptAll", pending: 2 })).toBe("Accept All & Continue");
    expect(primary(state({ files: [f("a", "accepted"), f("b", "pending")], untold: { accepted: 1, rejected: 0 } }))).toEqual({ kind: "acceptRest", pending: 1 });
    expect(mod.continuePrimaryTitle({ kind: "acceptRest", pending: 1 })).toBe("Accept 1 More & Continue");
    // A rejected file left the list; the summary still says something was decided.
    expect(primary(state({ files: [f("b", "pending")], untold: { accepted: 0, rejected: 1 } }))).toEqual({ kind: "acceptRest", pending: 1 });
    const all = state({ files: [f("a", "accepted")], untold: { accepted: 1, rejected: 1 } });
    expect(primary(all)).toEqual({ kind: "continue" });
    expect(mod.continuePrimaryTitle({ kind: "continue" })).toBe("Continue");
    expect(mod.continuePrimaryBlocker(all, chat)).toBeNull();
    expect(mod.continuePrimaryHelp(all, chat, false)).toMatch(/accepted \(1\) and rejected \(1\)/);
    // Told already: nothing.
    expect(primary(state({ files: [f("a", "accepted")] }))).toBeNull();
    // An older engine: its summary text.
    expect(primary(state({ summary: "[Review gate] Rejected (reverted on disk, do not redo unless asked): b." }))).toEqual({ kind: "continue" });
    // Notes to send.
    const noted = state({ files: [f("a", "pending")], notes: [{}, {}, { sent: { at: "x", turn: 1 } }] });
    expect(primary(noted)).toEqual({ kind: "requestChanges", notes: 2 });
    expect(mod.continuePrimaryTitle({ kind: "requestChanges", notes: 2 })).toBe("Request changes (2)");
    expect(mod.continuePrimaryBlocker(noted, chat)).toBeNull();
  });

  it("off with the reason", () => {
    const working = state({ phase: "running", canSend: false, blocked: "running", untold: { accepted: 1, rejected: 0 } });
    expect(mod.continuePrimaryBlocker(working, chat)).toMatch(/working/);
    expect(mod.continuePrimaryBlocker(state({ untold: { accepted: 1, rejected: 0 } }), { viewing: true, terminal: null })).toMatch(/running chat/);
    expect(mod.continuePrimaryBlocker(state({ files: [f("a", "pending")], notes: [{}], canRequest: false, canSend: false, blocked: "running" }), chat)).toMatch(/working/);
    expect(mod.continuePrimaryBlocker(state({ files: [f("a", "pending"), f("c", "changesRequested")], untold: { accepted: 1, rejected: 0 } }), chat)).toMatch(/change request/);
  });

  it("a terminal chat continues only at its prompt", () => {
    const told = { accepted: 1, rejected: 1 };
    expect(mod.continuePrimaryBlocker(state({ untold: told }), terminal)).toBeNull();
    expect(mod.continuePrimaryHelp(state({ untold: told }), terminal, false)).toMatch(/Continue\.” into Claude Code with Enter — the files you accepted \(1\)/);
    expect(mod.continuePrimaryBlocker(state({ untold: told, terminal: term({ promptId: "p1" }) }), terminal)).toMatch(/still working/);
    expect(mod.continuePrimaryBlocker(state({ untold: told, terminal: term({ waiting: { kind: "permission", message: "Bash", since: "x" } }) }), terminal)).toMatch(/waits for you/);
    expect(mod.continuePrimaryBlocker(state({ untold: told }), { viewing: false, terminal: { ptyId: "", shown: true, running: false, bracketed: false } })).toMatch(/not running/);
    // The idle rule needs no pending file.
    expect(terminalContinueBlocker(state({ untold: told }), { shown: true, running: true, bracketed: true })).toBeNull();
  });

  it("⋯ Continue, Leave the Rest Pending", () => {
    expect(mod.continueLeavingRestBlocker(state({ untold: { accepted: 1, rejected: 0 } }), chat)).toMatch(/No file waits/);
    const some = state({ files: [f("a", "accepted"), f("b", "pending")], untold: { accepted: 1, rejected: 0 } });
    expect(mod.continueLeavingRestBlocker(some, chat)).toBeNull();
    expect(mod.continueLeavingRestHelp(some, chat)).toMatch(/without deciding the 1 pending/);
    expect(mod.continueLeavingRestBlocker(state({ files: [f("b", "pending")], reviewFirst: { mode: "prompts", waiting: 1 } }), chat)).toMatch(/holds new messages/);
    expect(mod.continueLeavingRestBlocker(state({ files: [f("b", "pending")], reviewFirst: { mode: "edits", waiting: 1 } }), chat)).toBeNull();
    expect(mod.continueLeavingRestBlocker(state({ files: [f("b", "pending")], phase: "running", canSend: false, blocked: "running" }), chat)).toMatch(/working/);
    expect(mod.continueLeavingRestBlocker(state({ files: [f("b", "pending")], terminal: term({ promptId: "p1" }) }), terminal)).toMatch(/still working/);
    expect(mod.continueLeavingRestBlocker(state({ files: [f("b", "pending")] }), terminal)).toBeNull();
  });

  it("a terminal Continue with nothing to accept only pastes and presses Enter", async () => {
    const order: string[] = [];
    const why = await runTerminalAcceptContinue({
      paste: (text) => (order.push(`paste:${text}`), true),
      enter: () => order.push("enter"),
      refusal: () => "refused",
      wait: async () => undefined,
    });
    expect(why).toBeNull();
    expect(order).toEqual(["paste:Continue.", "enter"]);
  });
});
