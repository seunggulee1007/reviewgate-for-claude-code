/**
 * wave3 check-clients — review round 2 (docs/PROTOCOL.md §34) read adversarially on Electron: what the 0.2.2 store and diff
 * pane get wrong at the edges of a running turn, each pinned here before its fix (the engine bridge mocked, §34 shapes
 * injected as in reviewRoundStore.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangedFileState, EngineCommand, FileDiff, GateState, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

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
      setSettings: async (patch: Record<string, unknown>) => ({ appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400, ...patch }),
      getSettings: async () => ({ appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400 }),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
      sep: "/",
    },
  };
  return (await import("./store")).useStore;
}
type UseStore = Awaited<ReturnType<typeof loadStore>>;

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const file = (path: string, p: Partial<ChangedFileState> = {}): ChangedFileState => ({
  path,
  oldPath: null,
  status: "M",
  added: 1,
  deleted: 0,
  isBinary: false,
  tools: ["Edit"],
  toolUseIds: ["toolu_" + path],
  state: "pending",
  noteCount: 0,
  origin: "tool",
  ...p,
});

const gate = (p: Partial<GateState> = {}): GateState => ({
  phase: "reviewing",
  canSend: true,
  canRequestChanges: false,
  blockedReason: null,
  collectError: null,
  pendingCount: 0,
  changesRequestedCount: 0,
  isRequestingChanges: false,
  turnStartTree: "A",
  turnEndTree: "B1",
  lastReviewSummary: null,
  changedOutside: [],
  ignoredTouched: [],
  filteredByPattern: [],
  restored: false,
  reviewSummary: { files: 0, added: 0, deleted: 0 },
  externalPendingCount: 0,
  ...p,
});

const diffOf = (path: string, text: string): FileDiff => ({
  oldPath: path,
  newPath: path,
  isBinary: false,
  hunks: [
    {
      id: 0,
      header: "@@ -1 +1 @@",
      lines: [
        { id: 0, kind: "hunkHeader", oldNo: null, newNo: null, text: "@@ -1 +1 @@" },
        { id: 1, kind: "del", oldNo: 1, newNo: null, text: "old" },
        { id: 2, kind: "add", oldNo: null, newNo: 1, text },
      ],
    },
  ],
});

const diffReplies = (cmd: EngineCommand): Reply =>
  cmd.type === "select_file"
    ? { ok: true, reply: { type: "file_diff", scope: "turn", path: cmd.path, diff: diffOf(cmd.path, cmd.path), truncated: false, endTree: "B1", baseTree: "A" } }
    : { ok: true, reply: { type: "result", ok: true } };

let seq = 9000;
const running = { phase: "running" as const, canSend: false, blockedReason: "running" as const };

describe("review round 2 at the edges of a turn (wave3 check-clients)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  let useStore: UseStore;
  beforeEach(async () => {
    sent.length = 0;
    respond = diffReplies;
    useStore = await loadStore();
    const s = useStore.getState().state;
    useStore.setState({
      transcript: [],
      errorBanner: null,
      dialog: null,
      tab: "changes",
      selectedPath: null,
      selectedDiff: null,
      diffLoading: false,
      diffCache: {},
      fullFileCache: {},
      viewedPaths: {},
      historyView: null,
      ui: {},
      wantedPath: null,
      riskFirst: true,
      sidebarVisible: true,
      liveOpen: true,
      state: { ...s, seq: ++seq, changedFiles: [], reviewNotes: [], gate: gate({ turnStartTree: `A${seq}`, turnEndTree: null }), project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null } } as ReviewState,
    });
    useStore.getState().resetReviewRound();
  });

  const snapshot = (files: ChangedFileState[], g: Partial<GateState> = {}, extra: Partial<ReviewState> = {}) => {
    const s = useStore.getState().state;
    useStore.getState().handleEvent({ type: "state", state: { ...s, seq: ++seq, changedFiles: files, gate: gate({ pendingCount: files.filter((f) => f.state === "pending").length, ...g }), ...extra } as ReviewState });
  };

  it("a fresh turn: opening the previous round's files marks nothing “viewed” for the review the turn starts", async () => {
    const { viewStateOf } = await import("./reviewRound");
    // round 1: b.ts (text) and logo.png (binary) were viewed, then everything was decided
    snapshot([file("b.ts", { blob: "b1" }), file("logo.png", { blob: "p1", isBinary: true })], { turnStartTree: "A1", turnEndTree: "B1", reviewEndTree: "B1" });
    await flush();
    useStore.getState().selectFile("b.ts");
    await flush();
    useStore.getState().selectFile("logo.png");
    await flush();
    const decided = [file("b.ts", { blob: "b1", state: "accepted" }), file("logo.png", { blob: "p1", isBinary: true, state: "accepted" }), file("old.ts", { blob: "o1", state: "accepted" })];
    snapshot(decided, { turnStartTree: "A1", turnEndTree: "B1", reviewEndTree: "B1" });
    // a fresh send: a new A, no B yet — the list still shows round 1's decided files (dimmed)
    snapshot(decided, { ...running, turnStartTree: "A2", turnEndTree: null, reviewEndTree: null });
    expect(useStore.getState().viewedPaths).toEqual({});
    useStore.getState().selectFile("b.ts");
    useStore.getState().selectFile("logo.png");
    useStore.getState().selectFile("old.ts");
    await flush();
    // nothing of round 2 has been shown yet
    expect(useStore.getState().viewedPaths).toEqual({});
    // the turn is collected: it changed both files again (c.ts comes first on screen and is the one auto-selected)
    snapshot([file("c.ts", { blob: "c1" }), file("b.ts", { blob: "b2" }), file("logo.png", { blob: "p2", isBinary: true })], { turnStartTree: "A2", turnEndTree: "B2", reviewEndTree: "B2" });
    await flush();
    const st = useStore.getState();
    expect(st.selectedPath).toBe("c.ts");
    const states = Object.fromEntries(st.state.changedFiles.map((f) => [f.path, viewStateOf(f, st.viewedPaths)]));
    expect(states).toEqual({ "c.ts": "viewed", "b.ts": "unviewed", "logo.png": "unviewed" });
  });

  it("a fresh turn: a previous-round file without a diff on screen gets no “이번 턴 전 기준 diff” banner", async () => {
    snapshot([file("a.ts", { blob: "a1", state: "accepted" })], { ...running, turnStartTree: "A2", turnEndTree: null, reviewEndTree: null });
    useStore.getState().selectFile("a.ts");
    await flush();
    expect(useStore.getState().selectedDiff).toBeNull();
    expect(useStore.getState().diffUnavailable).toBe("이 diff는 턴이 끝나면 볼 수 있어요");
    Object.assign(useStore.getInitialState(), useStore.getState());
    const { DiffRound, staleBannerShown } = await import("./components/diff/DiffRound");
    const html = renderToStaticMarkup(createElement(DiffRound, { file: useStore.getState().state.changedFiles[0]! }));
    expect(html).not.toContain("Stale diff banner");
    // …so the Changes list says why reject waits itself (nothing on screen says it otherwise)
    expect(staleBannerShown(useStore.getState())).toBe(false);
  });

  it("a standing review: the diff read while Claude works keeps its banner (and while another file loads)", async () => {
    snapshot([file("a.ts", { blob: "a1" }), file("b.ts", { blob: "b1" })], { turnEndTree: "B1", reviewEndTree: "B1" });
    await flush();
    snapshot([file("a.ts", { blob: "a1" }), file("b.ts", { blob: "b1" })], { ...running, turnEndTree: null, reviewEndTree: "B1" });
    const { DiffRound, staleBannerShown } = await import("./components/diff/DiffRound");
    const render = () => {
      Object.assign(useStore.getInitialState(), useStore.getState());
      return renderToStaticMarkup(createElement(DiffRound, { file: useStore.getState().state.changedFiles[0]! }));
    };
    expect(render()).toContain("Stale diff banner");
    expect(staleBannerShown(useStore.getState())).toBe(true);
    respond = () => new Promise(() => undefined) as never;
    useStore.getState().selectFile("b.ts");
    expect(useStore.getState().diffLoading).toBe(true);
    expect(render()).toContain("Stale diff banner");
  });

  it("the 진행 중 변경 list does not stall behind a hidden window: the read it skipped runs once the window is shown", async () => {
    const doc = globalThis as unknown as { document: { visibilityState?: string } };
    const liveReply: Reply = { ok: true, reply: { type: "live_changes", running: true, turn: 5, baseTree: "T", liveTree: "L", at: "t", files: [{ path: "a.ts", oldPath: null, status: "M", added: 3, deleted: 1, isBinary: false, inReview: false }] } };
    respond = (cmd) => (cmd.type === "live_changes" ? liveReply : diffReplies(cmd));
    vi.useFakeTimers();
    try {
      snapshot([], { ...running, turnEndTree: null, reviewEndTree: null }, { hud: { ...useStore.getState().state.hud, turnFiles: 0 } });
      snapshot([], { ...running, turnEndTree: null, reviewEndTree: null }, { hud: { ...useStore.getState().state.hud, turnFiles: 1 } });
      doc.document.visibilityState = "hidden";
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(0);   // nothing asked while nobody can see it
      doc.document.visibilityState = "visible";
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(1);
      expect(useStore.getState().live.files.map((f) => f.path)).toEqual(["a.ts"]);
    } finally {
      delete doc.document.visibilityState;
      vi.useRealTimers();
    }
  });

  it("an open History tab follows the round in progress on a verdict or a note too, not only a new B (as on the Mac)", async () => {
    respond = (cmd) => (cmd.type === "review_history" ? { ok: true, reply: { type: "review_history", sessionId: null, entries: [], current: null } } : diffReplies(cmd));
    const files = [file("a.ts", { blob: "a1" }), file("b.ts", { blob: "b1" })];
    snapshot(files, { turnEndTree: "B1", reviewEndTree: "B1" });
    await flush();
    useStore.setState({ tab: "history" });
    const histories = () => sent.filter((c) => c.type === "review_history").length;
    sent.length = 0;
    // a.ts accepted (accept never moves B)
    const accepted = [file("a.ts", { blob: "a1", state: "accepted" }), file("b.ts", { blob: "b1" })];
    snapshot(accepted, { turnEndTree: "B1", reviewEndTree: "B1" });
    await flush();
    expect(histories()).toBe(1);
    // a note on b.ts
    const note = { id: "n1", path: "b.ts", line: 1, side: "new" as const, excerpt: "x", body: "keep it" };
    snapshot(accepted, { turnEndTree: "B1", reviewEndTree: "B1" }, { reviewNotes: [note] });
    await flush();
    expect(histories()).toBe(2);
    // a snapshot that changes nothing the round shows (the HUD ticking): no reload
    snapshot(accepted, { turnEndTree: "B1", reviewEndTree: "B1" }, { reviewNotes: [note] });
    await flush();
    expect(histories()).toBe(2);
  });
});
