/** §58.1: the Changes list's "Accept All & Continue" — on per chat kind under that kind's rule, off with the reason. */
import { beforeAll, describe, expect, it } from "vitest";
import type { ChangedFileState, ReviewState, TerminalSessionState } from "@reviewgate/engine";
import type { ContinueChat } from "./acceptAllContinue";
import { splitAccepted } from "./reviewGate";

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
const acceptAllContinueBlocker = (s: ReviewState, c: ContinueChat) => mod.acceptAllContinueBlocker(s, c);
const acceptAllContinueHelp = (s: ReviewState, c: ContinueChat, d: boolean) => mod.acceptAllContinueHelp(s, c, d);

const term = (over: Partial<TerminalSessionState> = {}): TerminalSessionState => ({
  running: true,
  hooksSeen: true,
  promptId: null,
  waiting: null,
  interruptSuspected: false,
  ...over,
});

function state(over: { phase?: string; canSend?: boolean; blocked?: string | null; pending?: number; requested?: number; terminal?: TerminalSessionState } = {}): ReviewState {
  return {
    gate: {
      phase: over.phase ?? "reviewing",
      canSend: over.canSend ?? true,
      blockedReason: over.blocked ?? null,
      pendingCount: over.pending ?? 2,
      changesRequestedCount: over.requested ?? 0,
    },
    session: { terminal: over.terminal ?? term() },
  } as unknown as ReviewState;
}

const chat: ContinueChat = { viewing: false, terminal: null };
const terminal: ContinueChat = { viewing: false, terminal: { ptyId: "p1", shown: true, running: true, bracketed: true } };

describe("Accept All & Continue", () => {
  it("in a chat follows the message box: files pending, none sent back, Claude able to take a message", () => {
    expect(acceptAllContinueBlocker(state(), chat)).toBeNull();
    expect(acceptAllContinueBlocker(state({ phase: "running", canSend: false, blocked: "running" }), chat)).toMatch(/working/);
    expect(acceptAllContinueBlocker(state({ phase: "running", canSend: false, blocked: "awaitingPermission" }), chat)).not.toBeNull();
    expect(acceptAllContinueBlocker(state({ requested: 1 }), chat)).toMatch(/change request \(1 file/);
    expect(acceptAllContinueBlocker(state({ pending: 0 }), chat)).toMatch(/No file waits/);
    expect(acceptAllContinueBlocker(state(), { viewing: true, terminal: null })).toMatch(/running chat/);
  });

  it("in a terminal chat waits for Claude Code's prompt", () => {
    expect(acceptAllContinueBlocker(state(), terminal)).toBeNull();
    expect(acceptAllContinueBlocker(state({ terminal: term({ promptId: "p1" }) }), terminal)).toMatch(/still working/);
    expect(acceptAllContinueBlocker(state({ terminal: term({ waiting: { kind: "permission", message: "Bash", since: "x" } }) }), terminal)).toMatch(/waits for you/);
    expect(acceptAllContinueBlocker(state(), { viewing: false, terminal: { ptyId: "", shown: true, running: false, bracketed: false } })).toMatch(/not running/);
    expect(acceptAllContinueHelp(state(), terminal, false)).toMatch(/Continue\.” into Claude Code with Enter/);
    expect(acceptAllContinueHelp(state(), chat, true)).toMatch(/summary/);
  });
});

describe("the accepted group", () => {
  const f = (path: string, s: ChangedFileState["state"]) => ({ path, state: s }) as ChangedFileState;

  it("folds accepted files apart; a file pending again is back in the open part", () => {
    const files = [f("a.ts", "pending"), f("b.ts", "accepted"), f("c.ts", "rejected"), f("d.ts", "accepted")];
    const split = splitAccepted(files);
    expect(split.open.map((x) => x.path)).toEqual(["a.ts", "c.ts"]);
    expect(split.accepted.map((x) => x.path)).toEqual(["b.ts", "d.ts"]);
    const again = splitAccepted([f("a.ts", "pending"), f("b.ts", "pending"), f("d.ts", "accepted")]);
    expect(again.open.map((x) => x.path)).toEqual(["a.ts", "b.ts"]);
    expect(again.accepted.map((x) => x.path)).toEqual(["d.ts"]);
  });
});
