/** §58 / §57.17: "Accept N & Continue" in a terminal chat — on only while Claude Code is idle at its prompt; accept, paste, Enter. */
import { describe, expect, it } from "vitest";
import type { ReviewState, TerminalSessionState } from "@reviewgate/engine";
import { CONTINUE_MESSAGE, runTerminalAcceptContinue, terminalAcceptContinueBlocker } from "./terminalAcceptContinue";

const term = (over: Partial<TerminalSessionState> = {}): TerminalSessionState => ({
  running: true,
  hooksSeen: true,
  promptId: null,
  waiting: null,
  interruptSuspected: false,
  ...over,
});

function state(over: { phase?: string; canSend?: boolean; pending?: number; requested?: number; terminal?: TerminalSessionState } = {}): Pick<ReviewState, "gate" | "session"> {
  return {
    gate: {
      phase: over.phase ?? "reviewing",
      canSend: over.canSend ?? true,
      pendingCount: over.pending ?? 2,
      changesRequestedCount: over.requested ?? 0,
    },
    session: { terminal: over.terminal ?? term() },
  } as unknown as Pick<ReviewState, "gate" | "session">;
}

const ready = { shown: true, running: true, bracketed: true };

describe("the terminal chat's Accept N & Continue", () => {
  it("is on only while Claude Code is idle at its prompt with files pending", () => {
    expect(terminalAcceptContinueBlocker(state(), ready)).toBeNull();
    expect(terminalAcceptContinueBlocker(state({ phase: "running", canSend: false }), ready)).toMatch(/still working/);
    expect(terminalAcceptContinueBlocker(state({ terminal: term({ promptId: "p1" }) }), ready)).toMatch(/still working/);
    expect(terminalAcceptContinueBlocker(state({ terminal: term({ waiting: { kind: "permission", message: "Bash", since: "x" } }) }), ready)).toMatch(/waits for you/);
    expect(terminalAcceptContinueBlocker(state({ phase: "collecting", canSend: false }), ready)).toMatch(/Collecting/);
    expect(terminalAcceptContinueBlocker(state({ requested: 1 }), ready)).toMatch(/change request \(1 file/);
    expect(terminalAcceptContinueBlocker(state({ pending: 0 }), ready)).toMatch(/No file waits/);
    expect(terminalAcceptContinueBlocker(state(), { ...ready, shown: false })).toMatch(/not a live terminal chat/);
    expect(terminalAcceptContinueBlocker(state(), { ...ready, running: false })).toMatch(/not running/);
    expect(terminalAcceptContinueBlocker(state(), { ...ready, bracketed: false })).toMatch(/not ready for a paste/);
  });

  it("accepts first, then pastes Continue. and presses Enter", async () => {
    const order: string[] = [];
    const why = await runTerminalAcceptContinue({
      accept: async () => void order.push("accept_all"),
      paste: (text) => (order.push(`paste:${text}`), true),
      enter: () => void order.push("enter"),
      refusal: () => "refused",
      wait: async () => void order.push("wait"),
    });
    expect(why).toBeNull();
    expect(order).toEqual(["accept_all", `paste:${CONTINUE_MESSAGE}`, "wait", "enter"]);
    expect(CONTINUE_MESSAGE).toBe("Continue.");
  });

  it("types nothing when the accept is refused or the paste cannot go", async () => {
    const typed: string[] = [];
    const refused = await runTerminalAcceptContinue({
      accept: async () => {
        throw new Error("reverting");
      },
      paste: (text) => (typed.push(text), true),
      enter: () => void typed.push("enter"),
      refusal: (e) => (e as Error).message,
      wait: async () => undefined,
    });
    expect(refused).toBe("reverting");
    const noPaste = await runTerminalAcceptContinue({
      accept: async () => undefined,
      paste: () => false,
      enter: () => void typed.push("enter"),
      refusal: () => "x",
      wait: async () => undefined,
    });
    expect(noPaste).toMatch(/not ready for a paste/);
    expect(typed).toEqual([]);
  });
});
