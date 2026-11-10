import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

// wave2 check-clients — handoff M7 / §2.9 for "Stop & send": the interrupted turn ends (its snapshots: collecting →
// reviewing) before the engine runs the send behind it. That end of a turn made the store forget the send it remembered,
// so when the send's snapshot A then failed (`error{send_failed | lfs_missing}`, then `ok`) the message was gone — the
// composer was already cleared. A send is forgotten only once it was answered and its turn is over.

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply | Promise<Reply> = () => ({ ok: true, reply: { type: "result", ok: true } });

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return respond(c);
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

type UseStore = Awaited<ReturnType<typeof loadStore>>;
const flush = () => new Promise((r) => setTimeout(r, 0));
const ok: Reply = { ok: true, reply: { type: "result", ok: true } };

function running(useStore: UseStore) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, peerInbox: [], externalTurn: null },
      gate: { ...s.gate, canSend: false, phase: "running", blockedReason: "running" },
    } as ReviewState,
    transcript: [],
    errorBanner: null,
    lastError: null,
    queue: { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
  });
}

function snapshot(useStore: UseStore, gate: Partial<ReviewState["gate"]>, hud: Partial<ReviewState["hud"]> = {}) {
  const s = useStore.getState().state;
  useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, gate: { ...s.gate, ...gate }, hud: { ...s.hud, ...hud } } });
}

describe("Stop & send whose snapshot A fails (wave2 check-clients)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ok;
  });

  it("the message waits first in the stopped queue (the interrupted turn ended before the send ran)", async () => {
    const useStore = await loadStore();
    running(useStore);
    const turns = useStore.getState().state.hud.turnCount;
    respond = async (c) => {
      if (c.type === "interrupt") {
        // The interrupt's reply waits for the turn's end and its collection — they arrive after both requests went out.
        await flush();
        snapshot(useStore, { phase: "collecting" });
        snapshot(useStore, { canSend: true, phase: "reviewing", blockedReason: null }, { turnCount: turns + 1 });
      }
      if (c.type === "send") {
        // The send behind it runs once that turn is over; its snapshot A fails.
        await flush();
        await flush();
        useStore.getState().handleEvent({ type: "error", message: "snapshot failed", fatal: false, scope: "git", code: "send_failed" });
      }
      return ok;
    };
    useStore.getState().interruptAndSend("이 방향으로 다시 해 줘");
    for (let i = 0; i < 6; i++) await flush();
    const q = useStore.getState().queue;
    expect(q.items.map((m) => m.text)).toEqual(["이 방향으로 다시 해 줘"]);
    expect(q.paused).not.toBeNull();
    expect(q.inflight).toBe(false);
  });

  it("a Stop & send that reached Claude is not put back by a later failure", async () => {
    const useStore = await loadStore();
    running(useStore);
    const turns = useStore.getState().state.hud.turnCount;
    useStore.getState().interruptAndSend("fine");
    await flush();
    await flush();
    snapshot(useStore, { canSend: false, phase: "running", blockedReason: "running" });
    snapshot(useStore, { canSend: true, phase: "reviewing", blockedReason: null }, { turnCount: turns + 1 });
    useStore.getState().handleEvent({ type: "error", message: "x", fatal: false, scope: "git", code: "send_failed" });
    expect(useStore.getState().queue.items).toEqual([]);
  });
});
