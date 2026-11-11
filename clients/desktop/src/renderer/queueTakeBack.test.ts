import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";

/** What reached the composer (composerBridge `insertIntoComposer`): text, mentions, images. */
const handed = vi.hoisted(() => [] as { text: string; mentions: string[]; images: number }[]);
vi.mock("./composerBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composerBridge")>()),
  insertIntoComposer: (text: string, chips?: { mentions: string[]; images: unknown[] }) => {
    handed.push({ text, mentions: chips?.mentions ?? [], images: chips?.images.length ?? 0 });
    return true;
  },
}));

// docs/PROTOCOL.md §50.3: a message in Claude's turn taken back before Claude reads it (× and ✎ on its chip), a queued
// message moved into the composer, and ↑ in an empty composer bringing the last waiting message back. Mac:
// SteerTakeBackTests (QueueSendNowTests.swift).

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const sent: EngineCommand[] = [];
let answer: (c: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand): Promise<Reply> => {
        sent.push(c);
        return answer(c);
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "win32",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;

const IMAGE = { kind: "image", mediaType: "image/png", dataBase64: "iVBORw0KGgo=" } as const;

function running(useStore: UseStore, steering: { id: string; text: string; mentions?: string[] }[], items: { id: number; text: string; mentions?: string[]; attachments?: (typeof IMAGE)[] }[] = []) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, externalTurn: null, steering },
      gate: { ...s.gate, canSend: false, phase: "running", blockedReason: "running" },
    } as ReviewState,
    errorBanner: null,
    steerTakingBack: [],
    queue: { items, paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
  });
}


const WAITING = [{ id: "u1", text: "Also README", mentions: ["README.md"] }, { id: "u2", text: "then the tests" }];
const ofType = <T extends EngineCommand["type"]>(type: T) => sent.filter((c): c is Extract<EngineCommand, { type: T }> => c.type === type);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("taking a message back from Claude's turn (§50.3)", () => {
  beforeEach(() => {
    sent.length = 0;
    handed.length = 0;
    answer = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("in time: steer_take_back with its id; Edit hands its text and mentions to the composer", async () => {
    const useStore = await loadStore();
    running(useStore, WAITING);
    const p = useStore.getState().takeBackSteering("u1", true);
    expect(useStore.getState().steerTakingBack).toEqual(["u1"]); // its chip waits
    expect(await p).toBe("taken");
    expect(ofType("steer_take_back")).toEqual([{ type: "steer_take_back", messageId: "u1" }]);
    expect(useStore.getState().steerTakingBack).toEqual([]);
    expect(handed).toEqual([{ text: "Also README", mentions: ["README.md"], images: 0 }]);
    // × takes it back without handing anything to the composer.
    expect(await useStore.getState().takeBackSteering("u2", false)).toBe("taken");
    expect(handed).toHaveLength(1);
  });

  it("too late: a toast says Claude read it, nothing comes back; a gone id is not asked", async () => {
    const useStore = await loadStore();
    const { useToast } = await import("./toast");
    running(useStore, WAITING);
    answer = () => ({ ok: false, error: "steer_already_read: Claude already read this message", code: "steer_already_read" });
    expect(await useStore.getState().takeBackSteering("u2", true)).toBe("alreadyRead");
    expect(useToast.getState().text).toBe("Claude already read this message — it stays in the chat");
    expect(handed).toEqual([]); // its row is in the chat: a copy in the box would send it twice
    sent.length = 0;
    expect(await useStore.getState().takeBackSteering("gone", true)).toBe("alreadyRead");
    expect(sent).toEqual([]);
  });

  it("failed: a toast says Claude still reads it", async () => {
    const useStore = await loadStore();
    const { useToast } = await import("./toast");
    running(useStore, WAITING);
    answer = () => ({ ok: false, error: "steer_take_back_failed: the CLI could not", code: "steer_take_back_failed" });
    expect(await useStore.getState().takeBackSteering("u1", false)).toBe("failed");
    expect(useToast.getState().text).toBe("Couldn't take the message back — Claude still reads it");
  });
});

describe("↑ in an empty composer (§50.3)", () => {
  beforeEach(() => {
    sent.length = 0;
    handed.length = 0;
    answer = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("brings the last queued message back first (with its mentions and images), then the turn's", async () => {
    const useStore = await loadStore();
    running(useStore, WAITING, [{ id: 1, text: "first" }, { id: 2, text: "look", mentions: ["a.ts"], attachments: [IMAGE] }]);
    expect(useStore.getState().pullBackLastWaiting()).toBe(true);
    expect(useStore.getState().queue.items.map((m) => m.id)).toEqual([1]);
    expect(handed).toEqual([{ text: "look", mentions: ["a.ts"], images: 1 }]);
    expect(useStore.getState().pullBackLastWaiting()).toBe(true);
    expect(useStore.getState().queue.items).toEqual([]);
    expect(ofType("steer_take_back")).toEqual([]);
    expect(useStore.getState().pullBackLastWaiting()).toBe(true); // now the turn's last message
    await flush();
    expect(ofType("steer_take_back")).toEqual([{ type: "steer_take_back", messageId: "u2" }]);
    expect(handed.at(-1)).toEqual({ text: "then the tests", mentions: [], images: 0 });
  });

  it("with nothing waiting it is the prompt history (false)", async () => {
    const useStore = await loadStore();
    running(useStore, []);
    expect(useStore.getState().pullBackLastWaiting()).toBe(false);
  });
});
