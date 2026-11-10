import { beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewState, TranscriptItem } from "@reviewgate/engine";

// MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2 on Electron (the same rules as Core ChatViewingTests): another chat tab is
// read without switching (daily-13) and a run of exploration calls folds into one row (market-12). The engine bridge is
// mocked as in transcriptHistory.test.ts.

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });

async function load() {
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
  const store = await import("./store");
  const viewed = await import("./viewedChat");
  const fold = await import("./exploreFold");
  return { useStore: store.useStore, ...viewed, ...fold };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function snapshot(l: Loaded, phase: string, current = "s1"): ReviewState {
  const s = l.useStore.getState().state;
  return {
    ...s,
    seq: s.seq + 1,
    project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
    session: { ...s.session, open: true, starting: false },
    gate: { ...s.gate, phase, canSend: phase === "idle", collectError: null },
    changedFiles: [],
    reviewNotes: [],
    sessions: { list: [{ id: "s1", title: "Mapper fix" }, { id: "s2", title: "Yesterday" }], currentId: current, openTabIds: ["s1", "s2"] },
  } as unknown as ReviewState;
}

const rows: TranscriptItem[] = [
  { at: "t5", turn: 3, kind: "user_message", text: "what changed?" },
  { at: "t6", turn: 3, kind: "assistant_text", text: "the mapper" },
];

describe("chats you can read without switching (§39.2)", () => {
  beforeEach(() => {
    sent.length = 0;
    respond = (cmd) => (cmd.type === "transcript_page" ? { ok: true, reply: { type: "transcript_page", sessionId: "s2", items: rows, start: 5, before: 7 } } : { ok: true, reply: { type: "result", ok: true } });
  });

  it("another tab shows its rows while Claude works in the live chat; nothing switches and a send is held until it is done (M33)", async () => {
    const l = await load();
    l.stopViewing();
    l.useStore.setState({ state: snapshot(l, "running"), transcript: [{ kind: "user", id: 1, text: "live" }] });
    await l.viewChat("s2");
    expect(sent).toEqual([{ type: "transcript_page", sessionId: "s2", before: l.CHAT_END, limit: 200 }]);
    const shown = l.viewingOf(l.useViewedChat.getState().chat, l.useStore.getState().state);
    expect(shown?.id).toBe("s2");
    expect(shown?.start).toBe(5);
    expect(shown?.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(l.useStore.getState().transcript).toHaveLength(1); // the live chat keeps its rows
    expect(l.viewingSendBlocker(l.useStore.getState().state, false)).toBeNull();
    expect(l.viewingSendWait(l.useStore.getState().state, false)).toBe("Claude is working in 'Mapper fix'");
    const { usePendingSwitch, cancelPendingSwitch } = await import("./pendingSwitch");
    expect(await l.sendInViewedChat("go on")).toBe(true);
    expect(usePendingSwitch.getState().pending).toMatchObject({ kind: "open", id: "s2", messages: [{ text: "go on" }] });
    expect(sent.some((c) => c.type === "session_open")).toBe(false);
    cancelPendingSwitch();
    // The running tab brings the live chat back.
    await l.viewChat("s1");
    expect(l.viewingOf(l.useViewedChat.getState().chat, l.useStore.getState().state)).toBeNull();
  });

  it("sending from a viewed chat switches first, then queues the message once the switch has landed", async () => {
    const l = await load();
    l.stopViewing();
    l.useStore.setState({ state: snapshot(l, "idle") });
    await l.viewChat("s2");
    respond = (cmd) => {
      if (cmd.type === "session_open") l.useStore.setState({ state: snapshot(l, "starting", "s2") });
      return { ok: true, reply: { type: "result", ok: true } };
    };
    expect(await l.sendInViewedChat("continue here")).toBe(true);
    expect(sent.map((c) => c.type)).toContain("session_open");
    expect(l.useStore.getState().queue.items.map((m) => m.text)).toEqual(["continue here"]);
    expect(l.useStore.getState().queue.paused).toBeNull();
    // The live chat is the viewed one now: the view is over.
    expect(l.viewingOf(l.useViewedChat.getState().chat, l.useStore.getState().state)).toBeNull();
    l.useStore.setState({ queue: { ...l.useStore.getState().queue, items: [] } });
  });

  it("a reveal stays in the shown chat only for its own calls (wave4b integration, §39.2 × §39.3)", async () => {
    const l = await load();
    l.stopViewing();
    l.useStore.setState({ state: snapshot(l, "idle"), transcript: [{ kind: "user", id: 1, text: "live" }] });
    expect(l.revealStaysInViewedChat(null, "agentB")).toBe(false);
    respond = (cmd) =>
      cmd.type === "transcript_page"
        ? { ok: true, reply: { type: "transcript_page", sessionId: "s2", items: [...rows, { at: "t7", turn: 3, kind: "tool_use", id: "agentB", name: "Agent", input: { subagent_type: "executor" } }], start: 0, before: 8 } }
        : { ok: true, reply: { type: "result", ok: true } };
    await l.viewChat("s2");
    const shown = l.viewingOf(l.useViewedChat.getState().chat, l.useStore.getState().state);
    expect(l.revealStaysInViewedChat(shown, "agentB")).toBe(true); // its turn summary card's link
    expect(l.revealStaysInViewedChat(shown, "liveAgent")).toBe(false); // an agent card / diff → cause: the running chat
    l.stopViewing();
  });

  it("a switch that never shows up gives the text back — nothing joins the old chat's queue", async () => {
    const l = await load();
    l.stopViewing();
    l.useStore.setState({ state: snapshot(l, "idle"), queue: { ...l.useStore.getState().queue, items: [] } });
    await l.viewChat("s2");
    // session_open is accepted, but no snapshot with the new chat arrives in time.
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    expect(await l.sendInViewedChat("not into Mapper fix", {}, 20)).toBe(false);
    expect(sent.map((c) => c.type)).toContain("session_open");
    expect(l.useStore.getState().queue.items).toEqual([]);
    expect(sent.some((c) => c.type === "send")).toBe(false);
  });

  it("an engine before §38.3 switches as before; the live chat's queue makes a send wait, a review never does (M31 / M33)", async () => {
    const l = await load();
    l.stopViewing();
    l.useStore.setState({ state: snapshot(l, "idle") });
    respond = (cmd) => (cmd.type === "transcript_page" ? { ok: false, error: "unknown command: transcript_page", code: "unknown_command" } : { ok: true, reply: { type: "result", ok: true } });
    await l.viewChat("s2");
    expect(sent.at(-1)).toEqual({ type: "session_open", sessionId: "s2" });
    expect(l.useViewedChat.getState().chat).toBeNull();
    const idle = snapshot(l, "idle");
    expect(l.viewingSendWait(idle, true)).toBe("Messages are waiting in the queue of 'Mapper fix'");
    expect(l.viewingSendWait(idle, false)).toBeNull();
    expect(l.viewingSendBlocker(idle, false)).toBeNull();
    expect(l.viewingSendBlocker({ ...idle, reviewNotes: [{ id: "n", sent: false }] } as unknown as ReviewState, false)).toBeNull();
    expect(l.viewingSendBlocker({ ...idle, gate: { ...idle.gate, collectError: "git add -A failed" } } as ReviewState, false)).toBe("Retry collecting the changes first");
  });
});

describe("exploration rows fold (§39.2, market-12)", () => {
  it("consecutive reads / searches fold; text, edits, one call alone, a failed call and a subagent's call stay", async () => {
    const l = await load();
    let id = 0;
    const use = (toolUseId: string, name: string, explore = true, extra: Record<string, unknown> = {}) =>
      ({ kind: "toolUse", id: ++id, toolUseId, name, input: {}, ...(explore ? { explore: true } : {}), ...extra }) as never;
    const res = (toolUseId: string, isError = false) => ({ kind: "toolResult", id: ++id, toolUseId, isError, preview: "" }) as never;
    const items = [
      use("r1", "Read", true, { file: "/p/A.java" }), use("r2", "Read", true, { file: "/p/B.xml" }), res("r1"), res("r2"),
      use("g1", "Grep"), res("g1"), use("b1", "Bash"), res("b1"),
      { kind: "assistant", id: ++id, text: "Now the edit.", streaming: false } as never,
      use("e1", "Edit", false), res("e1"),
      use("r3", "Read"), res("r3"),
      use("r4", "Read"), res("r4", true), use("r5", "Read"), res("r5"),
      use("n1", "Read", true, { parentToolUseId: "agent" }), use("m1", "mcp__es__search"),
    ];
    const entries = l.foldExplore(items);
    const shape = entries.map((e) => (e.kind === "run" ? `run(${e.items.length})` : e.item.kind === "toolUse" ? e.item.toolUseId : e.item.kind === "toolResult" ? `=${e.item.toolUseId}` : e.item.kind));
    expect(shape).toEqual(["run(8)", "assistant", "e1", "=e1", "r3", "=r3", "r4", "=r4", "r5", "=r5", "n1", "m1"]);
    const run = entries[0]!;
    if (run.kind !== "run") throw new Error("no run");
    expect(run.counts).toEqual({ files: 2, searches: 1, commands: 1, lookups: 0, open: 0 });
    expect(l.exploreSummary({ files: 12, searches: 5, commands: 0, lookups: 0, open: 0 })).toBe("12 files read · 5 searches");
    expect(l.exploreMetaOf({ explore: true })).toEqual({ explore: true });
    expect(l.exploreMetaOf({ explore: "yes" })).toEqual({});
  });
});
