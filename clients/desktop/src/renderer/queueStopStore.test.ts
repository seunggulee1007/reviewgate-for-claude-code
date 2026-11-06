import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";

// docs/PROTOCOL.md §50.1 in Electron, as on the Mac (QueueStopTests.swift): an error stops the queue only when it is about
// the message's own send, its session, a login or the API; the API and the usage limit stop it for a while. §38.2: the
// tool-call limit never stops it; after the user's Stop the next message waits for [보내기].

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const sent: EngineCommand[] = [];

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand): Promise<Reply> => {
        sent.push(c);
        return { ok: true, reply: { type: "result", ok: true } };
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;

/** A running turn with "next" queued behind it. */
function running(useStore: UseStore) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, externalTurn: null },
      gate: { ...s.gate, canSend: false, phase: "running", blockedReason: "running" },
    } as ReviewState,
    errorBanner: null,
    queue: { items: [{ id: 901, text: "next" }], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
  });
}

/** The engine's next snapshot: the turn is over and a message can go out. */
function idle(useStore: UseStore) {
  const s = useStore.getState().state;
  useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, gate: { ...s.gate, canSend: true, phase: "idle", blockedReason: null } } });
}

const sends = () => sent.filter((c): c is Extract<EngineCommand, { type: "send" }> => c.type === "send").map((c) => c.text);
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 } as never;

describe("the queue keeps going (§50.1)", () => {
  beforeEach(() => {
    sent.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a failing PR list, a refresh or a commit: the banner says it, the queued message still goes out", async () => {
    const useStore = await loadStore();
    running(useStore);
    useStore.getState().handleEvent({ type: "error", message: "gh pr list failed", fatal: false, scope: "pr", code: "command_failed" });
    useStore.getState().handleEvent({ type: "error", message: "git status failed", fatal: false, scope: "git", code: "refresh_failed" });
    useStore.getState().handleEvent({ type: "error", message: "commit failed", fatal: false, scope: "git", code: "commit_failed" });
    expect(useStore.getState().queue.paused).toBeNull();
    idle(useStore);
    expect(sends()).toEqual(["next"]);
  });

  it("the API failed: the queue stops and goes on by itself after 30 s, then 2 min while it keeps failing", async () => {
    vi.useFakeTimers();
    const useStore = await loadStore();
    running(useStore);
    const t0 = Date.now();
    useStore.getState().handleEvent({ type: "error", message: "The Claude API returned an error.", fatal: false, scope: "session", code: "api_error" });
    expect(useStore.getState().queue.paused).not.toBeNull();
    expect(useStore.getState().queue.resumeAt).toBe(t0 + 30_000);
    idle(useStore);
    expect(sends()).toEqual([]);
    vi.advanceTimersByTime(29_000);
    expect(sends()).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(sends()).toEqual(["next"]);
    expect(useStore.getState().queue.paused).toBeNull();
    // Its turn fails the same way: the next wait is 2 minutes.
    useStore.setState((s) => ({ queue: { ...s.queue, items: [{ id: 902, text: "after" }], inflight: false, awaitingTurn: false } }));
    const t1 = Date.now();
    useStore.getState().handleEvent({ type: "error", message: "rate limited", fatal: false, scope: "session", code: "rate_limited" });
    expect(useStore.getState().queue.resumeAt).toBe(t1 + 120_000);
    // [지금 보내기] sends at once and drops the timer.
    useStore.getState().resumeQueue();
    expect(useStore.getState().queue.resumeAt).toBeNull();
  });

  it("the usage limit: the queue goes on a minute after the reset; without a reset it waits for the user", async () => {
    vi.useFakeTimers();
    const useStore = await loadStore();
    running(useStore);
    const reset = Date.now() + 3_600_000;
    useStore.getState().handleEvent({ type: "error", message: "Your Claude usage limit is reached.", fatal: false, scope: "session", code: "usage_limit", resetAt: new Date(reset).toISOString() });
    expect(useStore.getState().queue.resumeAt).toBe(reset + 60_000);
    idle(useStore);
    vi.advanceTimersByTime(3_600_000);
    expect(sends()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(sends()).toEqual(["next"]);

    running(useStore);
    useStore.getState().handleEvent({ type: "error", message: "limit", fatal: false, scope: "session", code: "usage_limit" });
    expect(useStore.getState().queue.paused).not.toBeNull();
    expect(useStore.getState().queue.resumeAt).toBeNull();
  });

  it("§38.2: the tool-call limit does not stop the queue; the user's Stop does, and the next message waits for [보내기]", async () => {
    const useStore = await loadStore();
    running(useStore);
    useStore.getState().handleEvent({ type: "turn_end", stopReason: "error_max_turns", usage, files: 0, added: 0, deleted: 0, changedOutside: [] } as never);
    expect(useStore.getState().queue.paused).toBeNull();
    running(useStore);
    useStore.getState().handleEvent({ type: "turn_end", stopReason: "interrupted", usage, files: 0, added: 0, deleted: 0, changedOutside: [] } as never);
    const q = useStore.getState().queue;
    expect(q.paused).toBe("Stopped — the next message waits");
    expect(q.afterStop).toBe(true);
    idle(useStore);
    expect(sends()).toEqual([]);
    useStore.getState().resumeQueue();
    expect(sends()).toEqual(["next"]);
  });
});
