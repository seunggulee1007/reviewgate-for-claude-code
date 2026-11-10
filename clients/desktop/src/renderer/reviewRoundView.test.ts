/**
 * wave2 desktop-flow — what review round 2 (docs/PROTOCOL.md §34) puts on screen, as static markup from the store's state
 * (the engine bridge mocked; the §34 JSON shapes injected): the Changes list ("본 뒤 바뀜", sent notes, "요청 후 바뀌지
 * 않음", why reject waits during a turn, the previous round dimmed), Accept all, the diff head (the "이번 턴 전 기준" banner,
 * the ranges), sent note cards, the running turn's changes so far (list, HUD chip, read-only diff), the history's round
 * in progress and the composer's pending banner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangedFileState, EngineCommand, GateState, LiveChangedFile, ReviewHistoryEntry, ReviewNote, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

async function loadStore() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: () => undefined,
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => ({ ok: true, reply: c.type === "select_file" ? { type: "file_diff", scope: "turn", path: c.path, diff: { oldPath: c.path, newPath: c.path, isBinary: false, hunks: [] }, truncated: false, endTree: "B1" } : { type: "result", ok: true } }),
      setSettings: async (patch: Record<string, unknown>) => patch,
      getSettings: async () => ({}),
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

const running = { phase: "running" as const, canSend: false, blockedReason: "running" as const };
let seq = 5000;

describe("review round 2 on screen (wave2 desktop-flow)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  let useStore: UseStore;
  beforeEach(async () => {
    useStore = await loadStore();
    const s = useStore.getState().state;
    useStore.setState({
      transcript: [],
      errorBanner: null,
      dialog: null,
      tab: "changes",
      selectedPath: null,
      selectedDiff: null,
      diffCache: {},
      viewedPaths: {},
      historyView: null,
      ui: {},
      riskFirst: true,
      state: { ...s, seq: ++seq, changedFiles: [], reviewNotes: [], gate: gate({ turnStartTree: `A${seq}`, turnEndTree: null }), project: { path: "/p", root: "/p", name: "p", branch: "main", remoteURL: null } } as ReviewState,
    });
    useStore.getState().resetReviewRound();
  });

  /** The store's state as a snapshot would leave it (set directly: no fetches, no auto-selection). */
  const show = (files: ChangedFileState[], g: Partial<GateState> = {}, extra: Partial<ReviewState> = {}) => {
    const s = useStore.getState().state;
    useStore.setState({ state: { ...s, seq: ++seq, changedFiles: files, gate: gate({ pendingCount: files.filter((f) => f.state === "pending").length, ...g }), ...extra } as ReviewState });
  };
  /** Server rendering reads zustand's initial state: copy the current one into it (test-only). */
  const render = (component: unknown, props: Record<string, unknown> = {}) => {
    Object.assign(useStore.getInitialState(), useStore.getState());
    return renderToStaticMarkup(createElement(component as never, props as never));
  };
  const rowOf = (html: string, path: string) => {
    const at = html.indexOf(`data-testid="File ${path}"`);
    return at < 0 ? "" : html.slice(at, html.indexOf("</li>", at));
  };

  it("the Changes list: “본 뒤 바뀜” per file and counted, “수락 뒤 바뀜”, sent notes apart, “요청 후 바뀌지 않음”", async () => {
    const req = { lastRequest: { turn: 4, at: "2026-10-23T01:00:00.000Z", notes: 1 }, lastTurnChanges: { turn: 4, files: 1, added: 1, deleted: 0 }, reviewTurns: [3, 4] };
    show([file("a.ts", { blob: "a2" }), file("b.ts", { blob: "b1", changedSinceAccepted: true }), file("c.ts", { blob: "c1", sentNoteCount: 1 })], { turnEndTree: "B3", reviewEndTree: "B3", ...req }, {
      reviewNotes: [{ id: "n1", path: "c.ts", line: 1, side: "new", excerpt: "x", body: "keep it", sent: { at: "2026-10-23T01:00:00.000Z", turn: 4 } }],
    });
    useStore.setState({ viewedPaths: { "a.ts": "a1", "b.ts": "b1" } });
    const { ChangedFiles } = await import("./components/ChangedFiles");
    const html = render(ChangedFiles);
    expect(html).toContain("본 뒤 바뀜 1개");
    expect(rowOf(html, "a.ts")).toContain('data-testid="Changed since viewed a.ts"');
    expect(rowOf(html, "b.ts")).not.toContain("Changed since viewed");
    expect(rowOf(html, "b.ts")).toContain("수락 뒤 바뀜");
    expect(rowOf(html, "c.ts")).toContain('data-testid="Sent note badge c.ts"');
    expect(rowOf(html, "c.ts")).not.toContain('data-testid="Note badge c.ts"');
    expect(rowOf(html, "c.ts")).toContain("요청 후 바뀌지 않음");
    // an engine before §34: none of it
    show([file("a.ts"), file("b.ts")], { turnEndTree: "B3" });
    useStore.setState({ viewedPaths: { "a.ts": "" } });
    const plain = render(ChangedFiles);
    expect(plain).not.toContain("본 뒤 바뀜");
    expect(plain).not.toContain("수락 뒤 바뀜");
    expect(rowOf(plain, "a.ts")).toContain('data-testid="Viewed"');
  });

  it("the Changes list while a turn runs: Accept all and Reject all stay (r2-review-flow M32: a reject waits for the turn's end in the engine); a fresh turn dims the previous round", async () => {
    show([file("a.ts")], { ...running, turnEndTree: null, reviewEndTree: "B1" });
    const { ChangedFiles } = await import("./components/ChangedFiles");
    let html = render(ChangedFiles);
    expect(html).toMatch(/<button type="button" class="small" title="[^"]*" data-testid="Accept all"/);
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="Reject all"/);
    expect(html).not.toContain('data-testid="Reject blocked reason"');
    expect(html).not.toContain("previous-round");
    // a turn on a fresh review (no held B): reject still waits, with the reason in a line
    show([file("a.ts")], { ...running, turnEndTree: null, reviewEndTree: null });
    expect(render(ChangedFiles)).toContain('data-testid="Reject blocked reason">거절은 이번 턴이 끝난 뒤에 할 수 있어요');
    // a fresh send (nothing pending: no review B) — the decided files of the previous round, dimmed
    show([file("a.ts", { state: "accepted" })], { ...running, turnEndTree: null, reviewEndTree: null });
    html = render(ChangedFiles);
    expect(html).toContain("previous-round");
    // an engine before §34 while a turn runs: accept waits as before
    show([file("a.ts")], { ...running, turnEndTree: null });
    html = render(ChangedFiles);
    expect(html).toMatch(/disabled=""[^>]*data-testid="Accept all"/);
  });

  it("Accept all: a file viewed and then changed is said apart; during a turn it says that a changed file comes back", async () => {
    show([file("a.ts", { blob: "a2" }), file("b.ts", { blob: "b1" }), file("c.ts", { blob: "c1" })], { ...running, turnEndTree: null, reviewEndTree: "B1" });
    useStore.setState({ viewedPaths: { "a.ts": "a1", "b.ts": "b1" }, dialog: { kind: "acceptAll" } });
    const { Dialogs } = await import("./components/dialogs/Dialogs");
    const html = render(Dialogs);
    expect(html).toContain("아직 확인하지 않은 파일 1개.");
    expect(html).toContain('data-testid="Accept all changed since viewed">본 뒤 바뀜 1개');
    expect(html).toContain("Claude가 아직 작업 중이에요: 이번 턴이 다시 바꾼 파일은 대기로 돌아와요(수락 뒤 바뀜).");
  });

  it("the diff head: “이번 턴 전 기준” banner with why reject waits while a turn runs; the ranges only when there is more than one", async () => {
    const g = { reviewTurns: [3, 4], lastTurnChanges: { turn: 4, files: 1, added: 1, deleted: 0 } };
    const a = file("a.ts", { changedThisTurn: true, changedSinceAccepted: true });
    show([a], { turnEndTree: "B1", reviewEndTree: "B1", ...g });
    useStore.setState({ diffSince: "accepted" });
    const { DiffRound } = await import("./components/diff/DiffRound");
    let html = render(DiffRound, { file: a });
    expect(html).toContain('data-testid="Range review">전체');
    expect(html).toContain('data-testid="Range turn">이번 턴');
    expect(html).toMatch(/aria-checked="true" class="active" data-testid="Range accepted">수락 이후/);
    expect(html).not.toContain("요청 이후");
    expect(html).toContain("수락 뒤 바뀜");
    expect(html).not.toContain("Claude가 작업 중이에요");
    expect(html).toContain('data-testid="Range ask hint">줄 곁질문은 ‘전체’ 보기에서 할 수 있어요');
    useStore.setState({ diffSince: "review" });
    expect(render(DiffRound, { file: a })).not.toContain("Range ask hint");
    useStore.setState({ diffSince: "accepted" });
    show([a], { ...running, turnEndTree: null, reviewEndTree: "B1", ...g });
    html = render(DiffRound, { file: a });
    expect(html).toContain("Claude가 작업 중이에요 — 이번 턴 전 기준 diff예요(읽기 전용)");
    // r2-review-flow M32: a reject on this review is taken now (reverted when the turn ends) — no "wait" line
    expect(html).not.toContain('data-testid="Stale reject reason"');
    const plain = file("b.ts");
    show([plain], { turnEndTree: "B2", reviewEndTree: "B2" });
    expect(render(DiffRound, { file: plain })).toBe("");
  });

  it("sent notes: “요청함: …” with “반영 확인” (waiting while a change request runs); a gone line reads “위치 사라짐”", async () => {
    const sentNote: ReviewNote = { id: "n1", path: "a.ts", line: 42, side: "new", excerpt: "int b = 2;", body: "b는 2 그대로 둬", sent: { at: "2026-10-23T01:00:00.000Z", turn: 4 }, anchor: "moved" };
    const gone: ReviewNote = { ...sentNote, id: "n2", body: "이 줄 지워", anchor: "gone" };
    const unsentGone: ReviewNote = { ...gone, id: "n3", sent: undefined };
    show([file("a.ts", { sentNoteCount: 2 })], { turnEndTree: "B1", reviewEndTree: "B1" }, { reviewNotes: [sentNote, gone, unsentGone] });
    const { ReviewNoteBubble, OutsideNotes } = await import("./components/diff/NoteCards");
    const card = render(ReviewNoteBubble, { note: sentNote, onRemove: () => undefined });
    expect(card).toContain("요청함: b는 2 그대로 둬");
    expect(card).toContain("+42");
    expect(card).toMatch(/<button type="button" class="small" title="[^"]*" data-testid="Mark as addressed">✓ 반영 확인/);
    const outside = render(OutsideNotes, { notes: [gone, unsentGone], onRemove: () => undefined });
    expect(outside).toContain('data-testid="Note line gone">위치 사라짐');
    expect(outside).toContain("+42 · 위치 사라짐"); // the unsent one keeps the plain note bubble
    expect(render(OutsideNotes, { notes: [], onRemove: () => undefined })).toBe("");
    show([file("a.ts", { sentNoteCount: 2 })], { ...running, isRequestingChanges: true, turnEndTree: null, reviewEndTree: "B1" }, { reviewNotes: [sentNote] });
    expect(render(ReviewNoteBubble, { note: sentNote, onRemove: () => undefined })).toMatch(/disabled=""[^>]*data-testid="Mark as addressed"/);
  });

  it("the running turn's changes so far: the list, the HUD chip, the read-only diff — nothing before the turn touched a file", async () => {
    const lives: LiveChangedFile[] = [
      { path: "api/Svc.java", oldPath: null, status: "M", added: 12, deleted: 3, isBinary: false, inReview: true },
      { path: "package-lock.json", oldPath: null, status: "M", added: 310, deleted: 204, isBinary: false, inReview: false, generated: "lockfile" },
    ];
    const { LiveChanges } = await import("./components/LiveChanges");
    const { InProgressChip } = await import("./components/chat/InProgressChip");
    const { LiveDiffPane } = await import("./components/diff/LiveDiffPane");
    const hud = (turnFiles: number | undefined) => ({ hud: { ...useStore.getState().state.hud, turnFiles } });
    show([], { ...running, turnEndTree: null, reviewEndTree: null }, hud(0));
    expect(render(LiveChanges)).toBe("");
    expect(render(InProgressChip)).toBe("");
    // touched, not listed yet: the count only
    show([], { ...running, turnEndTree: null, reviewEndTree: null }, hud(2));
    expect(render(InProgressChip)).toContain("진행 중: 파일 2개");
    useStore.setState({ live: { files: lives, turn: 5, at: "2026-10-23T01:05:00.000Z", truncated: false, loading: false, error: null } });
    expect(render(InProgressChip)).toContain("진행 중: 파일 2개 · +322 −207");
    const list = render(LiveChanges);
    expect(list).toContain("진행 중 변경 (아직 수락 불가)");
    expect(list).toContain('data-testid="Live file api/Svc.java"');
    expect(list).toContain("리뷰에도 있음");
    expect(list).not.toContain("✓"); // nothing here can be accepted
    useStore.setState({ liveView: { path: "api/Svc.java", diff: { oldPath: "api/Svc.java", newPath: "api/Svc.java", isBinary: false, hunks: [], truncated: false }, loading: false, error: null } });
    const pane = render(LiveDiffPane);
    expect(pane).toContain("읽기 전용 — Claude가 아직 이 파일을 바꿀 수 있어요. 턴이 끝나면 리뷰해요");
    expect(pane).not.toContain('data-testid="Accept"');
    // an engine before §34 sends no turnFiles: nothing
    useStore.getState().resetReviewRound();
    show([], { ...running, turnEndTree: null }, hud(undefined));
    expect(render(LiveChanges)).toBe("");
    expect(render(InProgressChip)).toBe("");
  });

  it("History: the round in progress first, marked “진행 중”", async () => {
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
    useStore.setState({ reviewHistory: { entries: [entry("old")], all: false, loading: false, error: null, loadedAt: 1, current: entry("cur", { inProgress: true, prompt: "prompt now" }) } });
    const { HistoryList } = await import("./components/history/HistoryList");
    const html = render(HistoryList);
    expect(html.indexOf("prompt now")).toBeGreaterThan(-1);
    expect(html.indexOf("prompt now")).toBeLessThan(html.indexOf("prompt old"));
    expect(html).toContain('data-testid="History in progress">진행 중');
    expect(html).toContain("리뷰 1회"); // the finished rounds only
  });

  it("the composer's pending banner says what a send does to the review", async () => {
    show([file("a.ts")], { turnEndTree: "B1", reviewEndTree: "B1", pendingCount: 1 });
    const { PendingBanner } = await import("./components/chat/PendingBanner");
    const html = render(PendingBanner);
    expect(html).toContain("리뷰 대기 파일 1개 — 수락하지 않고도 질문할 수 있습니다");
    expect(html).toContain("지금 보내면 Claude의 새 변경이 이 리뷰에 합쳐져요(같은 시작점 기준). 따로 보려면 먼저 수락하거나 거절하세요.");
  });
});
