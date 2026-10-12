import { beforeEach, describe, expect, it } from "vitest";
import type { EngineCommand, ReviewHistoryEntry, ReviewState, TranscriptItem } from "@reviewgate/engine";

// MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 on Electron: restored summary cards, [이전 대화 더 보기] paging (store
// level, the engine bridge mocked as in restoredNotices.test.ts), search rows, the review history filter and jumps.

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
  const history = await import("./transcriptHistory");
  return { useStore: store.useStore, ...history };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function reset(l: Loaded) {
  const s = l.useStore.getState().state;
  l.useStore.setState({
    state: { ...s, seq: s.seq + 1, project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null } } as ReviewState,
    transcript: [],
    transcriptRestored: false,
    replaceTranscript: false,
  });
  l.useTranscriptPaging.setState({ sessionId: null, start: null, oldestAt: null, loading: false, error: null, rowIds: {}, target: null });
}

const at = (i: number) => `2026-10-22T09:00:${String(i).padStart(2, "0")}.000Z`;
const user = (i: number, text: string): TranscriptItem => ({ at: at(i), turn: i, kind: "user_message", text });
const answer = (i: number, text: string): TranscriptItem => ({ at: at(i), turn: i, kind: "assistant_text", text });
const summaryRow = (i: number): TranscriptItem => ({
  at: at(i),
  turn: i,
  kind: "turn_summary",
  files: [{ path: "a.ts", status: "M", state: "pending", adds: 2, dels: 1, why: "Fix the parser.", whyToolUseId: "e1", tools: ["Edit"], toolUseIds: ["e1"] }],
  commands: [],
  plan: null,
  review: { files: 1, added: 2, deleted: 1 },
});

describe("history that lasts on Electron (§38.3)", () => {
  beforeEach(() => {
    sent.length = 0;
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  it("a restored turn_summary row is the summary card again; a row without files makes none", async () => {
    const l = await load();
    reset(l);
    const empty: TranscriptItem = { ...summaryRow(3), files: [] } as TranscriptItem;
    l.useStore.getState().handleEvent({ type: "transcript_restore", items: [user(1, "fix"), summaryRow(2), empty] });
    const cards = l.useStore.getState().transcript.filter((c) => c.kind === "turnSummary");
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    if (card.kind !== "turnSummary") throw new Error("no card");
    expect(card.summary).toMatchObject({ type: "turn_summary", turn: 2, review: { files: 1, added: 2, deleted: 1 } });
    expect(card.summary.files[0]!.why).toBe("Fix the parser.");
  });

  it("[이전 대화 더 보기]: the rows before the restored ones go above them (under the divider), the start moves up", async () => {
    const l = await load();
    reset(l);
    l.useStore.getState().handleEvent({ type: "transcript_restore", items: [user(10, "ten"), answer(11, "eleven")], start: 10, sessionId: "chat-1" });
    expect(l.useTranscriptPaging.getState()).toMatchObject({ sessionId: "chat-1", start: 10, oldestAt: at(10) });
    respond = (c) => ({ ok: true, reply: { type: "transcript_page", sessionId: "chat-1", start: 8, before: 10, items: [user(8, "eight"), answer(9, "nine")] } });
    expect(await l.loadOlderRows()).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "transcript_page", sessionId: "chat-1", before: 10, beforeAt: at(10), limit: 200 });
    const tr = l.useStore.getState().transcript;
    expect(tr[0]!.kind).toBe("restoredDivider");
    expect(tr.slice(1).map((c) => (c.kind === "user" || c.kind === "assistant" ? c.text : c.kind))).toEqual(["eight", "nine", "ten", "eleven"]);
    const p = l.useTranscriptPaging.getState();
    expect(p.start).toBe(8);
    expect(p.oldestAt).toBe(at(8));
    // Row 8 / 11 map to their items (a search match scrolls there).
    expect(p.rowIds[8]).toBe(tr[1]!.id);
    expect(p.rowIds[11]).toBe(tr[4]!.id);
  });

  it("a page of another chat (switched meanwhile) is dropped; a refusal shows a line; an older engine shows no button", async () => {
    const l = await load();
    reset(l);
    l.useStore.getState().handleEvent({ type: "transcript_restore", items: [user(5, "five")], start: 5, sessionId: "chat-1" });
    respond = () => {
      l.useTranscriptPaging.setState({ sessionId: "chat-2" });
      return { ok: true, reply: { type: "transcript_page", sessionId: "chat-1", start: 0, before: 5, items: [user(0, "zero")] } };
    };
    expect(await l.loadOlderRows()).toBe(false);
    expect(l.useStore.getState().transcript.some((c) => c.kind === "user" && c.text === "zero")).toBe(false);
    l.useTranscriptPaging.setState({ sessionId: "chat-1", start: 5 });
    respond = () => ({ ok: false, error: "unknown_session:chat-1" });
    expect(await l.loadOlderRows()).toBe(false);
    expect(l.useTranscriptPaging.getState().error).not.toBeNull();
    // An engine before §38.3: no start, nothing to page.
    reset(l);
    l.useStore.getState().handleEvent({ type: "transcript_restore", items: [user(1, "one")] });
    expect(l.useTranscriptPaging.getState()).toMatchObject({ sessionId: null, start: null });
  });

  it("a jump lands on a loaded row, else asks for the rows above it", async () => {
    const l = await load();
    reset(l);
    l.useStore.getState().handleEvent({ type: "transcript_restore", items: [user(300, "a"), answer(301, "b")], start: 300, sessionId: "chat-1" });
    l.jumpToRow("chat-1", 301);
    const tr = l.useStore.getState().transcript;
    expect(l.jumpState(l.useTranscriptPaging.getState())).toEqual({ itemId: tr[2]!.id, load: 0 });
    expect(l.messageOrdinal(tr, tr[2]!.id)).toBe(1);
    l.jumpToRow("chat-1", 40);
    expect(l.jumpState(l.useTranscriptPaging.getState())).toEqual({ itemId: null, load: 261 });
    l.jumpToRow("other", 1);
    expect(l.jumpState(l.useTranscriptPaging.getState())).toEqual({ itemId: null, load: 0 });
    // A jump waits for its chat's rows, not for ever.
    expect(l.jumpExpired(l.useTranscriptPaging.getState())).toBe(false);
    expect(l.jumpExpired(l.useTranscriptPaging.getState(), Date.now() + l.JUMP_WAIT_MS + 1)).toBe(true);
  });

  it("search rows: title matches and message matches (with their line); review history filter by path, request, note, commit", async () => {
    const l = await load();
    const list = [
      { id: "a", title: "Mapper fix", lastUserText: "" },
      { id: "b", title: "Other", lastUserText: "" },
      { id: "c", title: "Third", lastUserText: "" },
    ];
    const match = { sessionId: "b", title: "Other", row: 7, turn: 2, at: at(1), kind: "assistant_text" as const, line: "the mapper query" };
    expect(l.chatSearchRows(list, "mapper", [match]).map((r) => [r.meta.id, r.match?.line ?? null])).toEqual([["a", null], ["b", "the mapper query"]]);
    expect(l.chatSearchRows(list, "mapper", null).map((r) => r.meta.id)).toEqual(["a"]);
    expect(l.chatSearchRows(list, " ", [match]).map((r) => r.meta.id)).toEqual(["a", "b", "c"]);

    const entry = (id: string, extra: Partial<ReviewHistoryEntry>): ReviewHistoryEntry => ({
      id, sessionId: "s", turns: [1], startedAt: at(1), endedAt: at(2), prompt: "", files: [], notes: [], turnStartTree: "a", turnEndTree: "b", ...extra,
    });
    const file = (path: string, extra = {}) => ({ path, oldPath: null, status: "M" as const, verdict: "accepted" as const, adds: 1, dels: 0, toolUseIds: [], ...extra });
    const entries = [
      entry("1", { prompt: "invoiceMapper.xml 고쳐줘", files: [file("api/invoiceMapper.xml")] }),
      entry("2", { files: [file("b.ts", { committed: true, commit: { sha: "abc", subject: "fix: tenant key" } })] }),
      entry("3", { files: [file("c.ts")], notes: [{ path: "c.ts", line: 3, side: "new", body: "null 체크 빠짐" }] }),
    ];
    expect(l.filterHistoryEntries(entries, "MAPPER").map((e) => e.id)).toEqual(["1"]);
    expect(l.filterHistoryEntries(entries, "tenant").map((e) => e.id)).toEqual(["2"]);
    expect(l.filterHistoryEntries(entries, "null 체크").map((e) => e.id)).toEqual(["3"]);
    expect(l.filterHistoryEntries(entries, "").map((e) => e.id)).toEqual(["1", "2", "3"]);
  });
});
