import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, PeerMessage, ReviewState, TranscriptItem } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { peerCardModel } from "./peer";
import { errorTone, sessionActions, type ErrorRow } from "./sessionErrors";

// ---------------------------------------------------------------- store harness (engine bridge mocked, as in composer.test.ts)

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

/** A fresh project view: idle gate that can send, empty transcript / queue / banner. */
function reset(useStore: UseStore, session: Partial<ReviewState["session"]> = {}, gate: Partial<ReviewState["gate"]> = {}) {
  const s = useStore.getState().state;
  useStore.setState({
    state: {
      ...s,
      seq: s.seq + 1,
      project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null },
      session: { ...s.session, open: true, ready: true, peerInbox: [], externalTurn: null, ...session },
      gate: { ...s.gate, canSend: true, phase: "idle", blockedReason: null, ...gate },
    } as ReviewState,
    transcript: [],
    errorBanner: null,
    lastError: null,
    queue: { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false },
    peerNotice: null,
    peerBusy: null,
    peerHidden: [],
  });
}

/** The engine's next snapshot: the current state with `session` / `gate` patched and a higher seq. */
function snapshot(useStore: UseStore, session: Partial<ReviewState["session"]> = {}, gate: Partial<ReviewState["gate"]> = {}) {
  const s = useStore.getState().state;
  useStore.getState().handleEvent({ type: "state", state: { ...s, seq: s.seq + 1, session: { ...s.session, ...session }, gate: { ...s.gate, ...gate } } });
}

const queueSome = (useStore: UseStore) => useStore.setState((s) => ({ queue: { ...s.queue, items: [{ id: 901, text: "queued" }] }, state: { ...s.state, gate: { ...s.state.gate, canSend: false, phase: "running", blockedReason: "running" } } }));
const errorRows = (useStore: UseStore) => useStore.getState().transcript.filter((i) => i.kind === "error") as ErrorRow[];
const held = (id: string, extra: Partial<PeerMessage> = {}): PeerMessage => ({ id, from: `uds:/tmp/cc-socks/${id.length}0.sock`, fromName: `term-${id}`, verifiedPeerPid: null, cause: "explicit-setting", receivedAt: "2026-10-22T08:00:00Z", state: "held", ...extra });

describe("session start and recovery in the store (§30, test points 17–21)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("18: the same session_start_failed five times is one row ×5 and the banner offers New chat first", async () => {
    const useStore = await loadStore();
    reset(useStore);
    for (let i = 0; i < 5; i++) {
      useStore.getState().handleEvent({ type: "error", message: "Claude Code exited while starting.", fatal: true, scope: "session", code: "session_start_failed", detail: "Error: Invalid settings", exitCode: 1, signal: null });
    }
    const rows = errorRows(useStore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 5, fatal: true, facts: { code: "session_start_failed", cliDetail: "Error: Invalid settings", exitCode: 1 } });
    expect(rows[0]!.message).toBe("Claude Code가 시작하자마자 종료됐어요.");
    const banner = useStore.getState().errorBanner!;
    expect(banner.count).toBe(5);
    expect(sessionActions(banner.code, { count: banner.count ?? 1, facts: banner.facts })[0]).toBe("newChat");
  });

  it("19: resume_not_found is information — the queue keeps going and lastError stays", async () => {
    const useStore = await loadStore();
    reset(useStore);
    queueSome(useStore);
    useStore.getState().handleEvent({ type: "error", message: "Claude Code has no record…", fatal: false, scope: "session", code: "resume_not_found", sessionId: "old-chat", detail: "No conversation found" });
    expect(useStore.getState().queue.paused).toBeNull();
    const banner = useStore.getState().errorBanner!;
    expect(errorTone(banner.code, banner.fatal)).toBe("info");
    expect(banner.facts?.sessionId).toBe("old-chat");
    expect(useStore.getState().lastError).toBeNull();
    expect(errorRows(useStore)[0]!.message).toContain("새 대화로 시작했어요");
  });

  it("17: worktree notices and the §29 fallback never pause the queue; failures do", async () => {
    const useStore = await loadStore();
    reset(useStore);
    queueSome(useStore);
    useStore.getState().handleEvent({ type: "error", message: "blocked", fatal: false, scope: "session", code: "worktree_blocked", toolName: "EnterWorktree", branch: "feat-x" });
    useStore.getState().handleEvent({ type: "error", message: "outside", fatal: false, scope: "session", code: "worktree_outside_review", toolName: "Bash", path: "/p/.claude/worktrees/a" });
    useStore.getState().handleEvent({ type: "error", message: "unprompted", fatal: false, scope: "session", code: "unprompted_blocked" });
    useStore.getState().handleEvent({ type: "error", message: "release", fatal: false, scope: "session", code: "peer_release_failed" });
    expect(useStore.getState().queue.paused).toBeNull();
    expect(useStore.getState().errorBanner?.facts).toMatchObject({ code: "peer_release_failed" });
    useStore.getState().handleEvent({ type: "error", message: "git-lfs", fatal: false, scope: "git", code: "lfs_missing" });
    expect(useStore.getState().queue.paused).toContain("Git LFS");
  });

  it("17 / 20: transcript_restore draws error rows like live ones and merges repeats", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const items: TranscriptItem[] = [
      { at: "2026-10-22T08:00:00Z", turn: 1, kind: "user_message", text: "go" },
      { at: "2026-10-22T08:00:10Z", turn: 1, kind: "error", message: "Claude tried to work in a git worktree", fatal: false, scope: "session", code: "worktree_blocked" },
      { at: "2026-10-22T08:00:20Z", turn: 1, kind: "error", message: "Claude tried to work in a git worktree", fatal: false, scope: "session", code: "worktree_blocked" },
      { at: "2026-10-22T08:01:00Z", turn: 1, kind: "error", message: "Claude Code exited", fatal: true, scope: "session", code: "session_crashed", detail: "Error: boom" },
    ];
    useStore.getState().handleEvent({ type: "transcript_restore", items });
    const rows = errorRows(useStore);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ count: 2, fatal: false, lastAt: Date.parse("2026-10-22T08:00:20Z"), facts: { code: "worktree_blocked" } });
    expect(rows[0]!.message).toMatch(/막았어요/);
    expect(rows[1]).toMatchObject({ fatal: true, facts: { code: "session_crashed", cliDetail: "Error: boom" } });
    expect(rows[1]!.message).toBe("Claude 세션이 비정상 종료됐어요.");
  });

  it("21: ready false → true clears the crash banner (a notice stays)", async () => {
    const useStore = await loadStore();
    reset(useStore, { ready: false });
    useStore.getState().handleEvent({ type: "error", message: "crashed", fatal: true, scope: "session", code: "session_crashed", detail: "x" });
    expect(useStore.getState().errorBanner?.code).toBe("session_crashed");
    snapshot(useStore, { ready: false, open: true });
    expect(useStore.getState().errorBanner).not.toBeNull();
    snapshot(useStore, { ready: true });
    expect(useStore.getState().errorBanner).toBeNull();
    // A resume notice comes after the new chat is up: the next ready transition must not hide it.
    snapshot(useStore, { ready: false });
    useStore.getState().handleEvent({ type: "error", message: "gone", fatal: false, scope: "session", code: "resume_not_found", sessionId: "s" });
    snapshot(useStore, { ready: true });
    expect(useStore.getState().errorBanner?.code).toBe("resume_not_found");
  });
});

describe("messages from other sessions in the store (§29, test points 22–28)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("22–24: one held message is one card; a second joins it; accept names every held id; inbox_changed / peer_none", async () => {
    const useStore = await loadStore();
    reset(useStore);
    snapshot(useStore, { peerInbox: [held("a")] });
    let card = peerCardModel(useStore.getState().state.session, useStore.getState().state.gate, useStore.getState().peerHidden)!;
    expect(card.messages).toHaveLength(1);
    snapshot(useStore, { peerInbox: [held("a"), held("bb")] });
    card = peerCardModel(useStore.getState().state.session, useStore.getState().state.gate, useStore.getState().peerHidden)!;
    expect(card.heldIds).toEqual(["a", "bb"]);
    expect(card.senders).toEqual(["term-a", "term-bb"]);

    expect(await useStore.getState().acceptPeers()).toBeNull();
    expect(sent.find((c) => c.type === "peer_accept")).toEqual({ type: "peer_accept", ids: ["a", "bb"] });

    respond = (c) => (c.type === "peer_accept" ? { ok: false, error: "peer_inbox_changed:a,bb,ccc", code: "peer_inbox_changed" } : { ok: true, reply: {} });
    expect(await useStore.getState().acceptPeers()).toBe("peer_inbox_changed:a,bb,ccc");
    expect(useStore.getState().peerNotice).toBe("새 메시지가 도착해 목록이 바뀌었어요. 다시 확인해 주세요");
    expect(useStore.getState().peerBusy).toBeNull();

    respond = (c) => (c.type === "peer_dismiss" ? { ok: false, error: "peer_none", code: "peer_none" } : { ok: true, reply: {} });
    await useStore.getState().dismissPeers();
    expect(peerCardModel(useStore.getState().state.session, useStore.getState().state.gate, useStore.getState().peerHidden)).toBeNull();
  });

  it("a release that failed says so once (its own banner), not again on the card", async () => {
    const useStore = await loadStore();
    reset(useStore, { peerInbox: [held("a")] });
    respond = (c) => {
      if (c.type !== "peer_accept") return { ok: true, reply: {} };
      useStore.getState().handleEvent({ type: "error", message: "release", fatal: false, scope: "session", code: "peer_release_failed" });
      return { ok: false, error: "peer_release_failed:timeout", code: "peer_release_failed" };
    };
    await useStore.getState().acceptPeers();
    expect(useStore.getState().peerNotice).toBeNull();
    expect(useStore.getState().errorBanner?.code).toBe("peer_release_failed");
  });

  it("25: a delivered message is its turn's first row, restored and live (once)", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.setState({ replaceTranscript: true });
    useStore.getState().handleEvent({
      type: "transcript_restore",
      items: [
        { at: "x", turn: 1, kind: "user_message", text: "mine" },
        { at: "x", turn: 2, kind: "peer_message", id: "m1", from: "uds:/tmp/cc-socks/4242.sock", fromName: "acme-b4", verifiedPeerPid: 4242, state: "delivered", body: "please run the tests" },
        { at: "x", turn: 2, kind: "assistant_text", text: "Running them." },
      ],
    });
    const kinds = useStore.getState().transcript.map((i) => i.kind);
    expect(kinds).toEqual(["user", "peer", "assistant"]);
    expect(useStore.getState().transcript[1]).toMatchObject({ kind: "peer", messageId: "m1", state: "delivered", verifiedPeerPid: 4242, turn: 2, body: "please run the tests" });

    const live: PeerMessage = { ...held("m2"), state: "delivered", body: "again", verifiedPeerPid: 77, turn: 3 };
    useStore.getState().handleEvent({ type: "peer_message", message: { ...live, state: "delivering" } });
    useStore.getState().handleEvent({ type: "peer_message", message: live });
    useStore.getState().handleEvent({ type: "peer_message", message: live });
    expect(useStore.getState().transcript.filter((i) => i.kind === "peer")).toHaveLength(2);
    expect(useStore.getState().transcript.at(-1)).toMatchObject({ kind: "peer", messageId: "m2", turn: 3 });
  });

  it("26: after a dismiss the refused row stays", async () => {
    const useStore = await loadStore();
    reset(useStore, { peerInbox: [held("a")] });
    expect(await useStore.getState().dismissPeers()).toBeNull();
    expect(sent.find((c) => c.type === "peer_dismiss")).toEqual({ type: "peer_dismiss", ids: ["a"] });
    useStore.getState().handleEvent({ type: "peer_message", message: { ...held("a"), state: "dropped", outcome: "refused" } });
    snapshot(useStore, { peerInbox: [] });
    const row = useStore.getState().transcript.find((i) => i.kind === "peer");
    expect(row).toMatchObject({ kind: "peer", state: "dropped", outcome: "refused" });
  });

  it("27: during an external turn a message waits in the queue, goes out when it ends, and the queue never pauses", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const externalTurn = { commandUuid: "c1", since: "2026-10-22T08:00:00Z", peer: { from: "uds:/tmp/cc-socks/1.sock", fromName: "term", verifiedPeerPid: 1 } };
    snapshot(useStore, { externalTurn }, { canSend: false, blockedReason: "running" });
    const { cannotSendReason } = await import("./store");
    expect(cannotSendReason(useStore.getState().state)).toBe("다른 세션의 메시지를 처리하는 중이에요 — 보낸 메시지는 끝나면 전송돼요");
    useStore.getState().enqueueMessage("after the peer turn");
    expect(sent.filter((c) => c.type === "send")).toHaveLength(0);
    snapshot(useStore, { externalTurn: null }, { canSend: true, blockedReason: null });
    expect(sent.filter((c) => c.type === "send")).toEqual([{ type: "send", text: "after the peer turn" }]);
    expect(useStore.getState().queue.paused).toBeNull();

    // The turn started between the snapshot and the click: the engine refuses — the message is kept, first, not paused.
    await flush();
    useStore.setState((s) => ({ queue: { ...s.queue, items: [], awaitingTurn: false, inflight: false } }));
    respond = (c) => (c.type === "send" ? { ok: false, error: "gate_closed:external_turn", code: "gate_closed" } : { ok: true, reply: {} });
    useStore.getState().send("typed right then");
    await flush();
    await flush();
    expect(useStore.getState().queue.items.map((m) => m.text)).toEqual(["typed right then"]);
    expect(useStore.getState().queue.paused).toBeNull();
    expect(useStore.getState().errorBanner).toBeNull();
    // A refusal that is not a closed gate still reaches the banner.
    respond = (c) => (c.type === "send" ? { ok: false, error: "invalid_mention:../x", code: "invalid_mention" } : { ok: true, reply: {} });
    useStore.getState().send("bad", { mentions: ["../x"] });
    await flush();
    await flush();
    expect(useStore.getState().errorBanner?.code).toBe("invalid_mention");
  });

  it("28: the fallback row's “이 메시지 처리하기” goes out as an ordinary send, once", async () => {
    const useStore = await loadStore();
    reset(useStore);
    useStore.getState().handleEvent({ type: "peer_message", message: { ...held("u1"), fromName: "acme-b4", state: "delivered", unprompted: true, body: "fix the build" } });
    expect(useStore.getState().queue.paused).toBeNull();
    expect(useStore.getState().errorBanner).toBeNull();
    const row = useStore.getState().transcript.find((i) => i.kind === "peer")!;
    useStore.getState().handleUnpromptedPeer(row.id);
    useStore.getState().handleUnpromptedPeer(row.id);
    expect(sent.filter((c) => c.type === "send")).toEqual([{ type: "send", text: "다른 세션(acme-b4)이 보낸 메시지:\nfix the build" }]);
    expect(useStore.getState().transcript.find((i) => i.kind === "peer")).toMatchObject({ handled: true });

    // With the gate closed it waits in the queue instead.
    reset(useStore, {}, { canSend: false, phase: "running", blockedReason: "running" });
    useStore.getState().handleEvent({ type: "peer_message", message: { ...held("u2"), state: "delivered", unprompted: true, body: "later" } });
    const row2 = useStore.getState().transcript.find((i) => i.kind === "peer")!;
    useStore.getState().handleUnpromptedPeer(row2.id);
    expect(useStore.getState().queue.items.map((m) => m.text)).toEqual(["다른 세션(term-u2)이 보낸 메시지:\nlater"]);
  });

  it("peer_set sends the project's mode", async () => {
    const useStore = await loadStore();
    reset(useStore);
    expect(await useStore.getState().setPeerMode("off")).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "peer_set", mode: "off" });
  });
});
