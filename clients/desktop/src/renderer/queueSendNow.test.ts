import { beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";
import { queuedSendNow } from "./sendQueue";

// composer (docs/PROTOCOL.md §50.2): a queued message can go at once, as in the terminal — into the running turn, else stop
// the turn and send it right after, else first in line now. Mac: QueueSendNowTests.swift.

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

const IMAGE = { mediaType: "image/png", data: "iVBORw0KGgo=", name: "shot.png" } as never;

function withQueue(useStore: UseStore, phase: "running" | "idle", paused: string | null = null) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, externalTurn: null },
      gate: { ...s.gate, canSend: phase === "idle", phase, blockedReason: phase === "running" ? "running" : null },
    } as ReviewState,
    errorBanner: null,
    queue: {
      items: [{ id: 701, text: "first" }, { id: 702, text: "second", mentions: ["src/cart.ts"] }, { id: 703, text: "with a picture", attachments: [IMAGE] }],
      paused, inflight: false, awaitingTurn: false, skipInterruptPause: false,
    },
  });
}

const ofType = <T extends EngineCommand["type"]>(type: T) => sent.filter((c): c is Extract<EngineCommand, { type: T }> => c.type === type);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a queued message sent now", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("decides by what the turn can take", () => {
    expect(queuedSendNow({ id: 1, text: "a" }, { canSteer: true, running: true })).toBe("steer");
    expect(queuedSendNow({ id: 1, text: "a", attachments: [IMAGE] }, { canSteer: true, running: true })).toBe("stopAndSend");
    expect(queuedSendNow({ id: 1, text: "a" }, { canSteer: false, running: true })).toBe("stopAndSend");
    expect(queuedSendNow({ id: 1, text: "a" }, { canSteer: false, running: false })).toBe("first");
  });

  it("while Claude works: into the turn with its mentions, out of the queue; the others stay in order", async () => {
    const useStore = await loadStore();
    withQueue(useStore, "running");
    useStore.getState().sendQueuedNow(702);
    await flush();
    expect(ofType("steer")).toEqual([expect.objectContaining({ type: "steer", text: "second", mentions: ["src/cart.ts"] })]);
    expect(useStore.getState().queue.items.map((m) => m.id)).toEqual([701, 703]);
  });

  it("with images while Claude works: stops the turn and sends it right after", async () => {
    const useStore = await loadStore();
    withQueue(useStore, "running");
    useStore.getState().sendQueuedNow(703);
    await flush();
    expect(ofType("steer")).toEqual([]);
    expect(ofType("interrupt")).toHaveLength(1);
    expect(ofType("send").map((c) => c.text)).toEqual(["with a picture"]);
    expect(useStore.getState().queue.items.map((m) => m.id)).toEqual([701, 702]);
  });

  it("a paused queue: that message goes first and the queue goes on", async () => {
    const useStore = await loadStore();
    withQueue(useStore, "idle", "The Claude API returned an error.");
    useStore.getState().sendQueuedNow(702);
    await flush();
    expect(useStore.getState().queue.paused).toBeNull();
    expect(ofType("send").map((c) => c.text)).toEqual(["second"]);
  });
});

describe("the queue bar (§50.2)", () => {
  it("shows what waits in Claude's turn (§50.3: with ✎ and × until Claude reads it) and Send now on each queued message", async () => {
    const useStore = await loadStore();
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { QueueBar, sendNowHelp } = await import("./components/chat/QueueBar");
    const init = useStore.getInitialState();
    const state = init.state;
    const scene = (items: { id: number; text: string }[]) =>
      Object.assign(init, {
        queue: { items, paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
        state: {
          ...state,
          project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
          session: { ...state.session, open: true, externalTurn: null, steering: [{ id: "u1", text: "Also update the README" }] },
          gate: { ...state.gate, canSend: false, phase: "running", blockedReason: "running" },
        },
      });
    scene([]);
    let html = renderToStaticMarkup(createElement(QueueBar));
    expect(html).toContain('data-testid="Queue steering chip"');
    expect(html).toContain("Also update the README");
    expect(html).toContain("Claude reads it after the current step");
    expect(html).not.toContain('data-testid="Queue send now"');
    expect(html).not.toContain('data-testid="Clear queue"');
    // §50.3: it can be edited (back into the composer) or taken back, each with its tooltip.
    expect(html).toContain('data-testid="Queue steering edit"');
    expect(html).toContain('data-testid="Queue steering take back"');
    const { takeBackHelp } = await import("./components/chat/QueueBar");
    expect(html).toContain(takeBackHelp().remove);
    // While it is being taken back, a waiting mark stands in for the tools.
    Object.assign(init, { steerTakingBack: ["u1"] });
    html = renderToStaticMarkup(createElement(QueueBar));
    expect(html).toContain('data-testid="Queue steering busy"');
    expect(html).not.toContain('data-testid="Queue steering take back"');
    Object.assign(init, { steerTakingBack: [] });
    scene([{ id: 5, text: "then run the tests" }]);
    html = renderToStaticMarkup(createElement(QueueBar));
    expect(html).toContain('data-testid="Queue send now"');
    expect(html).toContain(sendNowHelp("steer").replace(/'/g, "&#x27;"));
    expect(html).toContain('data-testid="Queue edit button"'); // §50.3: edit in sight, not only behind a click
  });
});
