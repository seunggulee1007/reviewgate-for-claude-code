import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

// wave2 check-clients — handoff M7 / §2.9 as on the Mac: a message the engine took but could not hand to Claude
// (`send` → `error{send_failed | lfs_missing}` then `ok`, engine.ts `send` returning false) or refused is never lost —
// it waits first in the stopped queue. Store level, the engine bridge mocked as in sessionStore.test.ts.

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

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
const sends = () => sent.filter((c) => c.type === "send").map((c) => (c as { text: string }).text);

function reset(useStore: UseStore, gate: Partial<ReviewState["gate"]> = {}) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, peerInbox: [], externalTurn: null },
      gate: { ...s.gate, canSend: true, phase: "idle", blockedReason: null, ...gate },
    } as ReviewState,
    transcript: [],
    errorBanner: null,
    lastError: null,
    queue: { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
  });
}

/** The engine's next snapshot: the current one with `gate` / `hud` patched and a higher seq. */
function snapshot(useStore: UseStore, gate: Partial<ReviewState["gate"]> = {}, hud: Partial<ReviewState["hud"]> = {}) {
  const s = useStore.getState().state;
  useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, gate: { ...s.gate, ...gate }, hud: { ...s.hud, ...hud } } });
}

const failure = (code: "send_failed" | "lfs_missing") => ({ type: "error" as const, message: "snapshot failed", fatal: false, scope: "git" as const, code });

/** `send` as the engine answers it when snapshot A fails: the error event first, then `ok`. */
const failingSend = (useStore: UseStore, code: "send_failed" | "lfs_missing") => (c: EngineCommand): Reply => {
  if (c.type === "send") useStore.getState().handleEvent(failure(code));
  return { ok: true, reply: { type: "result", ok: true } };
};

describe("a message the engine took but could not send is not lost (wave2 check-clients)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("a queued message whose snapshot A failed stays first in the stopped queue", async () => {
    const useStore = await loadStore();
    reset(useStore, { canSend: false, phase: "running", blockedReason: "running" });
    useStore.getState().enqueueMessage("first");
    useStore.getState().enqueueMessage("second");
    respond = failingSend(useStore, "lfs_missing");
    snapshot(useStore, { canSend: true, phase: "idle", blockedReason: null });
    await flush();
    await flush();
    expect(sends()).toEqual(["first"]);
    const q = useStore.getState().queue;
    expect(q.items.map((m) => m.text)).toEqual(["first", "second"]);
    expect(q.paused).toContain("Git LFS");
    expect(q).toMatchObject({ inflight: false, awaitingTurn: false });
    // Nothing goes out by itself; Resume sends the same message again.
    snapshot(useStore);
    expect(sends()).toEqual(["first"]);
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    useStore.getState().resumeQueue();
    await flush();
    expect(sends()).toEqual(["first", "first"]);
  });

  it("a typed message whose send failed goes to the front of the stopped queue — Resume sends it again", async () => {
    const useStore = await loadStore();
    reset(useStore);
    respond = failingSend(useStore, "send_failed");
    useStore.getState().send("typed", { mentions: ["a.ts"] });
    await flush();
    await flush();
    const q = useStore.getState().queue;
    expect(q.items).toMatchObject([{ text: "typed", mentions: ["a.ts"] }]);
    expect(q.paused).not.toBeNull();
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    useStore.getState().resumeQueue();
    await flush();
    expect(sent.filter((c) => c.type === "send")).toEqual([
      { type: "send", text: "typed", mentions: ["a.ts"] },
      { type: "send", text: "typed", mentions: ["a.ts"] },
    ]);
  });

  it("the failure may come after the reply: the message still comes back, once", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.getState().send("late");
    await flush();
    await flush();
    useStore.getState().handleEvent(failure("send_failed"));
    useStore.getState().handleEvent(failure("send_failed"));
    expect(useStore.getState().queue.items.map((m) => m.text)).toEqual(["late"]);
    expect(useStore.getState().queue.paused).not.toBeNull();
  });

  it("a message that reached Claude is never put back: once its turn is over a send_failed is about something else", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.getState().send("fine");
    await flush();
    await flush();
    snapshot(useStore, { canSend: false, phase: "running", blockedReason: "running" });
    snapshot(useStore, { canSend: true, phase: "reviewing", blockedReason: null }, { turnCount: useStore.getState().state.hud.turnCount + 1 });
    useStore.getState().handleEvent(failure("send_failed"));
    expect(useStore.getState().queue.items).toEqual([]);
  });

  it("a refused typed message (not a closing gate) waits first in the stopped queue with the reason, and the banner says it", async () => {
    const useStore = await loadStore();
    reset(useStore);
    respond = (c) => (c.type === "send" ? { ok: false, error: "attachment_too_large:6 MB", code: "attachment_too_large" } : { ok: true, reply: {} });
    useStore.getState().send("with a picture");
    await flush();
    await flush();
    const q = useStore.getState().queue;
    expect(q.items.map((m) => m.text)).toEqual(["with a picture"]);
    expect(q.paused).toBe("이미지는 5MB 이하만 첨부할 수 있어요 (6 MB).");
    expect(useStore.getState().errorBanner?.code).toBe("attachment_too_large");
  });
});
