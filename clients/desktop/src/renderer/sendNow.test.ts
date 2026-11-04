import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { canSteerDraft, composerEnter, primarySend, steerPossible, workingHint } from "./sendNow";

// §50 "Send now" (바로 보내기) in Electron, as on the Mac (RunAsTaskTests.swift §50, ChatComposer.swift): while a turn of ours
// runs, a typed message goes into it (`steer`); a refusal, or a draft with images, waits in the queue — never lost.

type Gate = ReviewState["gate"];
type Session = ReviewState["session"];
const at = (gate: Partial<Gate>, session: Partial<Session> = {}) =>
  ({ gate: { phase: "running", canSend: false, blockedReason: "running", ...gate }, session: { externalTurn: null, ...session } }) as Pick<ReviewState, "gate" | "session">;
const working = at({});

describe("when a message can go into the turn (§50)", () => {
  it("only while a turn of ours runs in the chat shown — not another session's, not while collecting", () => {
    expect(steerPossible(working, false)).toBe(true);
    expect(steerPossible(working, true)).toBe(false);
    expect(steerPossible(at({}, { externalTurn: { peer: true } as unknown as Session["externalTurn"] }), false)).toBe(false);
    expect(steerPossible(at({ phase: "collecting", blockedReason: "collecting" }), false)).toBe(false);
    expect(steerPossible(at({ phase: "reviewing", canSend: true, blockedReason: null }), false)).toBe(false);
  });

  it("a draft with images is queued: the CLI takes images only with a message of its own", () => {
    expect(canSteerDraft(working, { queueMode: true, viewing: false, images: 0 })).toBe(true);
    const withImage = canSteerDraft(working, { queueMode: true, viewing: false, images: 1 });
    expect(withImage).toBe(false);
    expect(primarySend({ canSend: false, queueMode: true, canSteer: withImage })).toBe("queue");
    expect(composerEnter({ shiftKey: false, altKey: false }, { viewing: false, canSend: false, canSteer: withImage })).toBe("queue");
    expect(canSteerDraft(working, { queueMode: false, viewing: false, images: 0 })).toBe(false);
  });

  it("while Claude works the primary button and ⌘↩ send it now; the old keys keep their meaning", () => {
    const o = { viewing: false, canSend: false, canSteer: true };
    expect(primarySend({ canSend: false, queueMode: true, canSteer: true })).toBe("steer");
    expect(composerEnter({ shiftKey: false, altKey: false }, o)).toBe("steer");
    expect(composerEnter({ shiftKey: false, altKey: true }, o)).toBe("stopAndSend");
    expect(composerEnter({ shiftKey: true, altKey: false }, o)).toBe("acceptAndSend");
    // Idle: a plain Send, whatever the turn could take.
    expect(primarySend({ canSend: true, queueMode: false, canSteer: false })).toBe("send");
    expect(composerEnter({ shiftKey: false, altKey: false }, { viewing: false, canSend: true, canSteer: false })).toBe("send");
    // Another chat shown read-only: only a plain ⌘↩ (it sends there).
    expect(composerEnter({ shiftKey: false, altKey: false }, { viewing: true, canSend: true, canSteer: false })).toBe("send");
    expect(composerEnter({ shiftKey: false, altKey: true }, { viewing: true, canSend: true, canSteer: false })).toBeNull();
  });

  it("the hint says ⌘↩ sends it now (Ctrl+Enter on Windows), in Korean", () => {
    initI18n("ko", "darwin");
    try {
      expect(workingHint("Claude 작업 중…", true)).toBe("Claude 작업 중… — ⌘↩로 바로 보내기");
      expect(workingHint("Claude 작업 중…", false)).toBe("Claude 작업 중…");
      expect(workingHint(null, true)).toBeNull();
      // ⌘↩ with an empty draft answers the open permission card: the reason alone.
      expect(workingHint("권한 결정 대기 중", true, true)).toBe("권한 결정 대기 중");
      initI18n("ko", "win32");
      expect(workingHint("x", true)).toBe("x — Ctrl+Enter로 바로 보내기");
    } finally {
      initI18n("en", "darwin");
    }
    expect(workingHint("Claude is working…", true)).toBe("Claude is working… — ⌘↩ sends it to Claude now");
  });
});

// ---------------------------------------------------------------- store (engine bridge mocked)

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
const ok: Reply = { ok: true, reply: { type: "result", ok: true } };
let respond: (cmd: EngineCommand) => Reply = () => ok;

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

function running(useStore: UseStore) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, peerInbox: [], externalTurn: null },
      gate: { ...s.gate, canSend: false, phase: "running", blockedReason: "running" },
    } as ReviewState,
    transcript: [],
    queue: { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
  });
}

describe("steer from the store (§50, Mac AppState.steer)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ok;
  });

  it("requests steer with the trimmed text and its mentions; nothing is queued", async () => {
    const useStore = await loadStore();
    running(useStore);
    await useStore.getState().steer("  Also check README  ", { mentions: ["README.md"] });
    expect(sent).toEqual([{ type: "steer", text: "Also check README", mentions: ["README.md"] }]);
    await useStore.getState().steer("no mentions", { mentions: [] });
    expect(sent.at(-1)).toEqual({ type: "steer", text: "no mentions" });
    expect(useStore.getState().queue.items).toEqual([]);
    await useStore.getState().steer("   ");
    expect(sent).toHaveLength(2);
    await flush();
  });

  it("a refusal queues the message instead (never lost); it goes out once the gate opens", async () => {
    const useStore = await loadStore();
    running(useStore);
    respond = (c) => (c.type === "steer" ? { ok: false, error: "steer_unavailable:collecting", code: "steer_unavailable" } : ok);
    await useStore.getState().steer("Then run the tests", { mentions: ["test/a.test.ts"] });
    expect(sent.map((c) => c.type)).toEqual(["steer"]);
    expect(useStore.getState().queue.items).toMatchObject([{ text: "Then run the tests", mentions: ["test/a.test.ts"] }]);
    expect(useStore.getState().queue.paused).toBeNull();
    // The turn's review is collected, the gate opens: the queued message is sent as its own turn.
    const s = useStore.getState().state;
    useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, gate: { ...s.gate, canSend: true, phase: "reviewing", blockedReason: null } } });
    await flush();
    expect(sent.at(-1)).toEqual({ type: "send", text: "Then run the tests", mentions: ["test/a.test.ts"] });
    await flush();
  });

  it("the steered row is a user row of the same turn — live and restored", async () => {
    const useStore = await loadStore();
    running(useStore);
    useStore.getState().handleEvent({ type: "user_message", text: "Fix the parser", turn: 3 });
    useStore.getState().handleEvent({ type: "user_message", text: "Also check README", turn: 3, mentions: ["README.md"], steered: true });
    const rows = useStore.getState().transcript;
    expect(rows.at(-2)).toEqual({ kind: "user", id: expect.any(Number), text: "Fix the parser", turn: 3 });
    expect(rows.at(-1)).toEqual({ kind: "user", id: expect.any(Number), text: "Also check README", turn: 3, mentions: ["README.md"], steered: true });
    useStore.setState({ replaceTranscript: true });
    useStore.getState().handleEvent({ type: "transcript_restore", items: [{ at: "x", turn: 3, kind: "user_message", text: "Also check README", steered: true }] });
    expect(useStore.getState().transcript).toEqual([{ kind: "user", id: expect.any(Number), text: "Also check README", turn: 3, steered: true }]);
  });
});
