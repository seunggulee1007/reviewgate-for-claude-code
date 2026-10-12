/**
 * wave2 desktop-flow — review round 2 (docs/PROTOCOL.md §34) through the store with the engine bridge mocked: the §34 JSON
 * shapes are injected as snapshots / replies (no engine behavior yet). Covers comp-02 (the diff a turn started from stays,
 * accept during a turn, reject waits), §34.1 ranges and their defaults, comp-08 viewed by content, comp-10 screen order,
 * §34.3 the turn_end row / no card for a no-change turn, §34.6 live changes, §34.4 sent notes and the history's round in
 * progress — and that an engine before §34 (none of the fields) behaves as before.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangedFileState, DiffSince, EngineCommand, FileDiff, GateState, LiveChangedFile, ReviewHistoryEntry, ReviewNote, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { sessionSwitchRefusal } from "./sessions";

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

/** A one-hunk diff whose added line says `text`. */
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

/** `file_diff` replies: `select_file {path, since}` → a diff saying `path@since`; `extra` per call. */
const diffReplies =
  (extra: (c: Extract<EngineCommand, { type: "select_file" }>) => Record<string, unknown> = () => ({})) =>
  (cmd: EngineCommand): Reply => {
    if (cmd.type === "select_file") {
      const since = cmd.since ?? "review";
      return { ok: true, reply: { type: "file_diff", scope: "turn", path: cmd.path, diff: diffOf(cmd.path, `${cmd.path}@${since}`), truncated: false, endTree: "B1", baseTree: since === "review" ? "A" : "T", ...(cmd.since ? { since: cmd.since } : {}), ...extra(cmd) } };
    }
    return { ok: true, reply: { type: "result", ok: true } };
  };

const selects = () => sent.filter((c): c is Extract<EngineCommand, { type: "select_file" }> => c.type === "select_file");
const shownText = (useStore: UseStore) => useStore.getState().selectedDiff?.hunks[0]?.lines.find((l) => l.kind === "add")?.text ?? null;

let seq = 1000;

describe("review round 2 in the store (wave2 desktop-flow)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    respond = diffReplies();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fresh project view (nothing selected, no caches). */
  const reset = (useStore: UseStore) => {
    const s = useStore.getState().state;
    useStore.setState({
      transcript: [],
      errorBanner: null,
      lastError: null,
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
    // (optional: the same file runs against a client before §34 to see it fail for the right reasons)
    useStore.getState().resetReviewRound?.();
  };
  /** Applies a snapshot through `handleEvent` (the live path). */
  const snapshot = (useStore: UseStore, files: ChangedFileState[], g: Partial<GateState> = {}, extra: Partial<ReviewState> = {}) => {
    const s = useStore.getState().state;
    const pending = files.filter((f) => f.state === "pending").length;
    useStore.getState().handleEvent({
      type: "state",
      state: { ...s, seq: ++seq, changedFiles: files, gate: gate({ pendingCount: pending, ...g }), ...extra } as ReviewState,
    });
  };

  // ---------------------------------------------------------------- comp-02 / §34.2

  it("comp-02: a send keeps the diff on screen (held B); other files open read-only; accept goes through, reject waits with its reason", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const round = { turnEndTree: "B1", reviewEndTree: "B1" };
    snapshot(useStore, [file("a.ts", { blob: "a1" }), file("b.ts", { blob: "b1" })], round);
    await flush();
    expect(useStore.getState().selectedPath).toBe("a.ts");
    expect(shownText(useStore)).toBe("a.ts@review");
    expect(selects()).toEqual([{ type: "select_file", path: "a.ts" }]);

    // send on the standing review: turnEndTree goes null, reviewEndTree keeps the held B
    snapshot(useStore, [file("a.ts", { blob: "a1" }), file("b.ts", { blob: "b1" })], { phase: "running", canSend: false, blockedReason: "running", turnEndTree: null, reviewEndTree: "B1" });
    expect(shownText(useStore)).toBe("a.ts@review");
    expect(useStore.getState().diffLoading).toBe(false);

    // another pending file opens from the held B (stale, read-only)
    respond = diffReplies(() => ({ stale: true }));
    useStore.getState().selectFile("b.ts");
    await flush();
    expect(shownText(useStore)).toBe("b.ts@review");
    expect(useStore.getState().selectedDiff?.stale).toBe(true);
    expect(useStore.getState().viewedPaths["b.ts"]).toBe("b1");

    // accept during the turn is sent (§34.2); reject waits for the turn's end
    sent.length = 0;
    useStore.getState().accept("b.ts");
    await flush();
    expect(sent.filter((c) => c.type === "accept")).toEqual([{ type: "accept", paths: ["b.ts"] }]);
    // the move after accept lands on the other pending file, from the cache
    expect(useStore.getState().selectedPath).toBe("a.ts");
    expect(selects()).toEqual([]);
    sent.length = 0;
    useStore.getState().reject("a.ts");
    useStore.getState().rejectAll();
    await flush();
    expect(sent.filter((c) => c.type.startsWith("reject"))).toEqual([]);
    expect(useStore.getState().errorBanner?.message).toBe("거절은 이번 턴이 끝난 뒤에 할 수 있어요");

    // collecting: accept is refused too ("a second at most")
    snapshot(useStore, [file("a.ts", { blob: "a1" }), file("b.ts", { blob: "b1", state: "accepted" })], { phase: "collecting", canSend: false, blockedReason: "collecting", turnEndTree: null, reviewEndTree: "B1" });
    sent.length = 0;
    useStore.getState().accept("a.ts");
    expect(sent).toEqual([]);
    expect(useStore.getState().errorBanner?.message).toBe("변경사항 수집 중…");
  });

  it("comp-02, an engine before §34 (no reviewEndTree): the diff on screen stays; a file never loaded says when it can be shown; no accept", async () => {
    const useStore = await loadStore();
    reset(useStore);
    snapshot(useStore, [file("a.ts"), file("b.ts")], { turnEndTree: "B1" });
    await flush();
    expect(shownText(useStore)).toBe("a.ts@review");
    snapshot(useStore, [file("a.ts"), file("b.ts")], { phase: "running", canSend: false, blockedReason: "running", turnEndTree: null });
    expect(shownText(useStore)).toBe("a.ts@review");
    sent.length = 0;
    useStore.getState().selectFile("b.ts");
    await flush();
    expect(selects()).toEqual([]);
    expect(useStore.getState().selectedDiff).toBeNull();
    expect(useStore.getState().diffLoading).toBe(false);
    expect(useStore.getState().diffUnavailable).toBe("이 diff는 턴이 끝나면 볼 수 있어요");
    useStore.getState().selectFile("a.ts");
    expect(shownText(useStore)).toBe("a.ts@review");
    useStore.getState().accept("a.ts");
    expect(sent.filter((c) => c.type === "accept")).toEqual([]);
    expect(useStore.getState().errorBanner?.message).toBe("Claude가 작업 중…");
    // the collection brings a new B: the diff is read again
    snapshot(useStore, [file("a.ts"), file("b.ts")], { turnEndTree: "B2" });
    await flush();
    expect(selects()).toEqual([{ type: "select_file", path: "a.ts" }]);
  });

  // ---------------------------------------------------------------- §34.1 ranges

  it("§34.1: a file accepted and changed again opens “since accepted”; the user's pick holds until the file's content changes; full_file and reject_hunks follow the range", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const g = { turnEndTree: "B1", reviewEndTree: "B1", reviewTurns: [3, 4], lastTurnChanges: { turn: 4, files: 1, added: 2, deleted: 1 } };
    // (this reply does not echo `since`: the diff still knows it shows a range — its hunk ids are not reject_hunks ids)
    respond = diffReplies(() => ({ since: undefined }));
    snapshot(useStore, [file("a.ts", { changedSinceAccepted: true, changedThisTurn: true })], g);
    await flush();
    expect(useStore.getState().diffSince).toBe<DiffSince>("accepted");
    expect(selects()).toEqual([{ type: "select_file", path: "a.ts", since: "accepted" }]);
    expect(shownText(useStore)).toBe("a.ts@accepted");
    expect(useStore.getState().selectedDiff?.since).toBe<DiffSince>("accepted");
    respond = diffReplies();

    useStore.getState().setDiffSince("review");
    await flush();
    expect(shownText(useStore)).toBe("a.ts@review");
    expect(selects().at(-1)).toEqual({ type: "select_file", path: "a.ts" });
    sent.length = 0;
    useStore.getState().setDiffSince("accepted");
    expect(shownText(useStore)).toBe("a.ts@accepted"); // cached per (path, range)
    expect(selects()).toEqual([]);

    // a refused range falls back to the whole review, quietly
    respond = (cmd) => (cmd.type === "select_file" && cmd.since === "turn" ? { ok: false, error: "range_unavailable:turn", code: "range_unavailable" } : diffReplies()(cmd));
    useStore.getState().setDiffSince("turn");
    await flush();
    expect(useStore.getState().diffSince).toBe<DiffSince>("review");
    expect(shownText(useStore)).toBe("a.ts@review");
    expect(useStore.getState().errorBanner).toBeNull();

    // full_file asks for the same range; the whole review's hunk ids go back with their base tree
    respond = () => ({ ok: true, reply: { type: "full_file_content", path: "a.ts", lines: [], changedNewLines: [], deletedAfterNewLine: [], isBinary: false, isTooLarge: false, oldText: "", newText: "" } });
    await useStore.getState().fullFile("a.ts", "accepted");
    expect(sent.at(-1)).toEqual({ type: "full_file", path: "a.ts", since: "accepted" });
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
    sent.length = 0;
    await useStore.getState().rejectHunks("a.ts", [0]);
    expect(sent.find((c) => c.type === "reject_hunks")).toEqual({ type: "reject_hunks", path: "a.ts", hunks: [0], expectedEndTree: "B1", expectedBaseTree: "A" });

    // another B with a.ts as it was (another file rejected): the pick holds (as on the Mac)
    respond = diffReplies();
    useStore.getState().setDiffSince("review");
    snapshot(useStore, [file("a.ts", { changedSinceAccepted: true, changedThisTurn: true, blob: "a1" })], { ...g, turnEndTree: "B2", reviewEndTree: "B2" });
    await flush();
    useStore.getState().setDiffSince("review");
    snapshot(useStore, [file("a.ts", { changedSinceAccepted: true, changedThisTurn: true, blob: "a1" })], { ...g, turnEndTree: "B3", reviewEndTree: "B3" });
    await flush();
    expect(useStore.getState().diffSince).toBe<DiffSince>("review");
    // a.ts itself changed: its default applies again
    snapshot(useStore, [file("a.ts", { changedSinceAccepted: true, changedThisTurn: true, blob: "a2" })], { ...g, turnEndTree: "B4", reviewEndTree: "B4" });
    await flush();
    expect(useStore.getState().diffSince).toBe<DiffSince>("accepted");
  });

  it("§34.1 defaults: pending again after a request → since request; else the whole review (and an engine before §34 never sends since)", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const g = { turnEndTree: "B1", reviewEndTree: "B1", reviewTurns: [3, 4], lastTurnChanges: { turn: 4, files: 2, added: 3, deleted: 1 }, lastRequest: { turn: 4, at: "2026-10-23T01:00:00.000Z", notes: 1 } };
    snapshot(useStore, [file("a.ts", { changedSinceRequest: true, sentNoteCount: 1 }), file("b.ts", { changedThisTurn: true })], g);
    await flush();
    expect(selects()).toEqual([{ type: "select_file", path: "a.ts", since: "request" }]);
    useStore.getState().selectFile("b.ts");
    await flush();
    expect(selects().at(-1)).toEqual({ type: "select_file", path: "b.ts" });

    reset(useStore);
    sent.length = 0;
    snapshot(useStore, [file("a.ts", { state: "pending" })], { turnEndTree: "B9" });
    await flush();
    expect(selects()).toEqual([{ type: "select_file", path: "a.ts" }]);
  });

  // ---------------------------------------------------------------- comp-08 / §34.5

  it("comp-08: viewed by content — only the file whose blob changed is “본 뒤 바뀜”; a reject or another file's change keeps the rest", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const files = (a: string, b: string, c: string | null) => [file("a.ts", { blob: a }), file("b.ts", { blob: b }), ...(c ? [file("c.ts", { blob: c })] : [])];
    snapshot(useStore, files("a1", "b1", "c1"), { turnEndTree: "B1", reviewEndTree: "B1" });
    await flush();
    useStore.getState().selectFile("b.ts");
    await flush();
    useStore.getState().selectFile("c.ts");
    await flush();
    expect(useStore.getState().viewedPaths).toEqual({ "a.ts": "a1", "b.ts": "b1", "c.ts": "c1" });
    // c.ts rejected: B moves, the others keep their "viewed"
    snapshot(useStore, files("a1", "b1", null), { turnEndTree: "B2", reviewEndTree: "B2" });
    await flush();
    const { viewStateOf, changedSinceViewed } = await import("./reviewRound");
    const st = () => useStore.getState();
    expect(st().state.changedFiles.map((f) => viewStateOf(f, st().viewedPaths))).toEqual(["viewed", "viewed"]);
    // a question turn changed a.ts while b.ts was on screen
    useStore.getState().selectFile("b.ts");
    await flush();
    snapshot(useStore, files("a2", "b1", null), { turnEndTree: "B3", reviewEndTree: "B3" });
    await flush();
    expect(st().state.changedFiles.map((f) => viewStateOf(f, st().viewedPaths))).toEqual(["changed", "viewed"]);
    expect(changedSinceViewed(st().state.changedFiles, st().viewedPaths).map((f) => f.path)).toEqual(["a.ts"]);

    // a new review (A changes) forgets every viewed file
    snapshot(useStore, files("a2", "b1", null), { turnStartTree: "A2", turnEndTree: "B4", reviewEndTree: "B4" });
    expect(Object.keys(st().viewedPaths)).not.toContain("a.ts");
  });

  // ---------------------------------------------------------------- comp-10

  it("comp-10: ⌘] / ⌘[, the first pick and the move after accept follow the list's order (groups, risky first)", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const files = [file("src/A.java"), file(".claude/hooks/x.sh", { group: "mods" }), file("src/b.ts", { status: "D" }), file("ide/Mine.java", { origin: "external", tools: [] })];
    snapshot(useStore, files, { turnEndTree: "B1" });
    await flush();
    expect(useStore.getState().selectedPath).toBe(".claude/hooks/x.sh");
    useStore.getState().selectPending(1);
    expect(useStore.getState().selectedPath).toBe("src/b.ts");
    useStore.getState().selectPending(1);
    expect(useStore.getState().selectedPath).toBe("src/A.java");
    useStore.getState().selectPending(1);
    expect(useStore.getState().selectedPath).toBe("ide/Mine.java");
    useStore.getState().selectPending(1);
    expect(useStore.getState().selectedPath).toBe(".claude/hooks/x.sh");
    useStore.getState().selectPending(-1);
    expect(useStore.getState().selectedPath).toBe("ide/Mine.java");
    useStore.getState().selectFile("src/b.ts");
    useStore.getState().accept("src/b.ts");
    expect(useStore.getState().selectedPath).toBe("src/A.java");
    // git order inside the groups when "risky first" is off
    useStore.getState().setRiskFirst(false);
    useStore.getState().selectFile(".claude/hooks/x.sh");
    useStore.getState().selectPending(1);
    expect(useStore.getState().selectedPath).toBe("src/A.java");
    useStore.getState().setRiskFirst(true);
  });

  // ---------------------------------------------------------------- §34.3

  it("§34.3: the turn_end row counts this turn and adds the whole review for a merged turn; a summary without files makes no card", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const usage = { inputTokens: 812, outputTokens: 95, costUsd: 0.0123, durationMs: 41200, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 51200 };
    useStore.getState().handleEvent({ type: "turn_end", stopReason: "end_turn", usage, files: 1, added: 2, deleted: 1, changedOutside: [], external: 0, review: { files: 5, added: 40, deleted: 7 }, merged: true });
    useStore.getState().handleEvent({ type: "turn_end", stopReason: "end_turn", usage, files: 2, added: 3, deleted: 0, changedOutside: [] });
    const rows = useStore.getState().transcript.filter((i) => i.kind === "turnEnd").map((i) => (i.kind === "turnEnd" ? i.summary : ""));
    // wave4b w4b-check4 (§40.1): the stop reason in words ("end_turn" → "완료").
    expect(rows[0]).toBe("파일 1개 변경 (+2 −1) · 완료 · $0.0123 · 41.2s · 리뷰 전체: 파일 5개 (+40 −7)");
    expect(rows[1]).toBe("파일 2개 변경 (+3 −0) · 완료 · $0.0123 · 41.2s");
    useStore.getState().handleEvent({ type: "turn_summary", turn: 4, files: [], commands: [], plan: null, merged: true, review: { files: 5, added: 40, deleted: 7 } });
    expect(useStore.getState().transcript.some((i) => i.kind === "turnSummary")).toBe(false);
  });

  // ---------------------------------------------------------------- §34.6

  it("§34.6: a running turn's changes so far — asked once Claude touched files (debounced), listed, a file's diff read-only; gone when the turn ends", async () => {
    const useStore = await loadStore();
    reset(useStore);
    vi.useFakeTimers();
    const lives: LiveChangedFile[] = [
      { path: "api/Svc.java", oldPath: null, status: "M", added: 12, deleted: 3, isBinary: false, inReview: true },
      { path: "package-lock.json", oldPath: null, status: "M", added: 310, deleted: 204, isBinary: false, inReview: false, generated: "lockfile" },
    ];
    respond = (cmd) => {
      if (cmd.type === "live_changes") return { ok: true, reply: { type: "live_changes", running: true, turn: 5, baseTree: "4b1e", liveTree: "9ac0", at: "2026-10-23T01:05:00.000Z", files: lives } };
      if (cmd.type === "live_diff") return { ok: true, reply: { type: "file_diff", scope: "live", path: cmd.path, diff: diffOf(cmd.path, "live"), truncated: false, baseTree: "4b1e", endTree: "9ac0" } };
      return { ok: true, reply: { type: "result", ok: true } };
    };
    const running = { phase: "running" as const, canSend: false, blockedReason: "running" as const, turnEndTree: null, reviewEndTree: null };
    const hud = (turnFiles: number) => ({ hud: { ...useStore.getState().state.hud, turnFiles } });
    snapshot(useStore, [], running, hud(0));
    snapshot(useStore, [], running, hud(1));
    snapshot(useStore, [], running, hud(2));
    expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(1);
    expect(useStore.getState().live.files.map((f) => f.path)).toEqual(["api/Svc.java", "package-lock.json"]);

    useStore.getState().openLiveDiff("api/Svc.java");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toEqual({ type: "live_diff", path: "api/Svc.java" });
    expect(useStore.getState().liveView?.diff?.hunks).toHaveLength(1);

    // the turn ends: nothing of it is "live" any more
    snapshot(useStore, [file("api/Svc.java")], { phase: "collecting", canSend: false, blockedReason: "collecting", turnEndTree: null, reviewEndTree: null }, hud(0));
    expect(useStore.getState().live.files).toEqual([]);
    expect(useStore.getState().liveView).toBeNull();
  });

  it("§34.6: a link to a reviewed file (chat → diff) leaves the live view; a failed collection says why there is no diff", async () => {
    const useStore = await loadStore();
    reset(useStore);
    respond = (cmd) => (cmd.type === "live_diff" ? { ok: true, reply: { type: "file_diff", scope: "live", path: cmd.path, diff: diffOf(cmd.path, "live"), truncated: false } } : diffReplies()(cmd));
    snapshot(useStore, [file("a.ts")], { phase: "running", canSend: false, blockedReason: "running", turnEndTree: null, reviewEndTree: "B1" });
    useStore.getState().selectFile("a.ts");
    await flush();
    useStore.getState().openLiveDiff("x.ts");
    await flush();
    expect(useStore.getState().liveView?.path).toBe("x.ts");
    useStore.getState().revealFile("a.ts");
    expect(useStore.getState().liveView).toBeNull();
    expect(useStore.getState().selectedPath).toBe("a.ts");
    // an engine before §34 whose collection failed: nothing to read, said in words
    reset(useStore);
    snapshot(useStore, [file("b.ts"), file("c.ts")], { phase: "collect_failed", canSend: false, blockedReason: "collect_failed", collectError: "boom", turnEndTree: null });
    useStore.getState().selectFile("c.ts");
    expect(useStore.getState().diffUnavailable).toBe("이번 턴의 변경사항을 수집하지 못했습니다");
  });

  it("§34.6: live changes are read only while the list is on screen — coming into view reads them at once", async () => {
    const useStore = await loadStore();
    reset(useStore);
    vi.useFakeTimers();
    respond = (cmd) => (cmd.type === "live_changes" ? { ok: true, reply: { type: "live_changes", running: true, turn: 5, baseTree: "b", liveTree: "l", at: "2026-10-23T01:05:00.000Z", files: [] } } : diffReplies()(cmd));
    useStore.setState({ tab: "prs" });
    const running = { phase: "running" as const, canSend: false, blockedReason: "running" as const, turnEndTree: null, reviewEndTree: null };
    const hud = (turnFiles: number) => ({ hud: { ...useStore.getState().state.hud, turnFiles } });
    snapshot(useStore, [], running, hud(0));
    snapshot(useStore, [], running, hud(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(0);
    useStore.getState().setTab("changes");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(1);
    // the section folded: nothing more is asked; unfolding asks again
    useStore.getState().setLiveOpen(false);
    snapshot(useStore, [], running, hud(4));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(1);
    useStore.getState().setLiveOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(2);
  });

  it("§34.6: an engine before §34 (no hud.turnFiles) never asks for live changes", async () => {
    const useStore = await loadStore();
    reset(useStore);
    vi.useFakeTimers();
    snapshot(useStore, [], { phase: "running", canSend: false, blockedReason: "running", turnEndTree: null });
    snapshot(useStore, [], { phase: "running", canSend: false, blockedReason: "running", turnEndTree: null }, { budgetUsage: { files: 1, lines: 10, denied: false } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.filter((c) => c.type === "live_changes")).toHaveLength(0);
  });

  // ---------------------------------------------------------------- §34.4

  it("§34.4: only notes not sent yet hold a chat switch; the history's round in progress is kept apart (none from an engine before §34)", async () => {
    const useStore = await loadStore();
    reset(useStore);
    const sentNote: ReviewNote = { id: "n1", path: "a.ts", line: 1, side: "new", excerpt: "x", body: "b는 2 그대로 둬", sent: { at: "2026-10-23T01:00:00.000Z", turn: 4 } };
    snapshot(useStore, [file("a.ts", { sentNoteCount: 1 })], { turnEndTree: "B1", reviewEndTree: "B1" }, { reviewNotes: [sentNote] });
    expect(sessionSwitchRefusal(useStore.getState().state)).toBeNull();
    snapshot(useStore, [file("a.ts", { sentNoteCount: 1, noteCount: 1 })], { turnEndTree: "B1", reviewEndTree: "B1" }, { reviewNotes: [sentNote, { ...sentNote, id: "n2", sent: undefined }] });
    expect(sessionSwitchRefusal(useStore.getState().state)).toBe("리뷰 메모를 보내거나 삭제하세요");

    const entry = (id: string, p: Partial<ReviewHistoryEntry> = {}): ReviewHistoryEntry => ({
      id,
      sessionId: "s1",
      turns: [3],
      startedAt: "2026-10-23T00:00:00.000Z",
      endedAt: "2026-10-23T00:10:00.000Z",
      prompt: `prompt ${id}`,
      files: [{ path: "a.ts", oldPath: null, status: "M", verdict: "accepted", adds: 1, dels: 0, toolUseIds: [] }],
      notes: [],
      turnStartTree: "A",
      turnEndTree: "B",
      ...p,
    });
    respond = () => ({ ok: true, reply: { type: "review_history", sessionId: "s1", entries: [entry("old")], current: entry("cur", { inProgress: true }) } });
    await useStore.getState().loadReviewHistory();
    expect(useStore.getState().reviewHistory.current?.id).toBe("cur");
    expect(useStore.getState().reviewHistory.entries.map((e) => e.id)).toEqual(["old"]);
    respond = () => ({ ok: true, reply: { type: "review_history", sessionId: "s1", entries: [entry("old")] } });
    await useStore.getState().loadReviewHistory();
    expect(useStore.getState().reviewHistory.current).toBeNull();
  });
});
