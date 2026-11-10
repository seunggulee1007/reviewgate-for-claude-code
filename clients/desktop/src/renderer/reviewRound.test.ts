/**
 * wave2 desktop-flow (docs/PROTOCOL.md §34): the pure review-round-2 rules — which B the diffs refer to while a turn runs,
 * accept / reject during a turn, the diff ranges and their defaults, viewed by content, the screen order of the Changes
 * list, sent notes, the turn_end row and the live changes totals.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChangedFileState, FileDiff, GateState, ReviewNote, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import {
  acceptBlockedReason,
  availableRanges,
  changedSinceViewed,
  collectFailedReason,
  contentKey,
  defaultRange,
  diffTreeOf,
  displayOrder,
  hasReviewRound2,
  liveTotals,
  nextPendingAfter,
  placeNotes,
  rangeCacheKey,
  rangeLabel,
  rejectBlockedReason, hunkRejectBlockedReason,
  sentNotes,
  stepPending,
  turnEndReviewText,
  unchangedSinceRequest,
  unsentNotes,
  viewStateOf,
} from "./reviewRound";

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
  pendingCount: 1,
  changesRequestedCount: 0,
  isRequestingChanges: false,
  turnStartTree: "A",
  turnEndTree: "B",
  lastReviewSummary: null,
  changedOutside: [],
  ignoredTouched: [],
  filteredByPattern: [],
  restored: false,
  reviewSummary: { files: 1, added: 1, deleted: 0 },
  ...p,
});

const st = (g: Partial<GateState>): Pick<ReviewState, "gate"> => ({ gate: gate(g) });

const note = (id: string, p: Partial<ReviewNote> = {}): ReviewNote => ({ id, path: "a.ts", line: 3, side: "new", excerpt: "x", body: "fix " + id, ...p });

describe("§34.2 the B diffs refer to", () => {
  it("reviewEndTree when the engine sends it, else turnEndTree (an engine before §34)", () => {
    expect(diffTreeOf(gate({ turnEndTree: null, reviewEndTree: "heldB" }))).toBe("heldB");
    expect(diffTreeOf(gate({ turnEndTree: "B", reviewEndTree: "B" }))).toBe("B");
    expect(diffTreeOf(gate({ turnEndTree: null }))).toBeNull();
    expect(diffTreeOf(gate({ turnEndTree: "B" }))).toBe("B");
    expect(diffTreeOf(gate({ turnEndTree: null, reviewEndTree: null }))).toBeNull();
    expect(hasReviewRound2(gate({ reviewEndTree: null }))).toBe(true);
    expect(hasReviewRound2(gate())).toBe(false);
  });
});

describe("§34.2 accept / reject while a turn runs", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("accept during a running turn on a standing review (held B); refused while collecting and without §34", () => {
    expect(acceptBlockedReason(st({ phase: "reviewing" }))).toBeNull();
    expect(acceptBlockedReason(st({ phase: "running", turnEndTree: null, reviewEndTree: "heldB" }))).toBeNull();
    expect(acceptBlockedReason(st({ phase: "running", turnEndTree: null }))).toBe("Claude가 작업 중…");
    expect(acceptBlockedReason(st({ phase: "running", turnEndTree: null, reviewEndTree: null }))).toBe("Claude가 작업 중…");
    expect(acceptBlockedReason(st({ phase: "collecting", turnEndTree: null, reviewEndTree: "heldB" }))).toBe("변경사항 수집 중…");
    expect(acceptBlockedReason(st({ phase: "reverting" }))).toBe("되돌리는 중…");
  });

  it("reject on a standing review is taken while Claude works (r2-review-flow M32) — a fresh turn, the collection and hunks wait, with the reason in words", () => {
    expect(rejectBlockedReason(st({ phase: "reviewing" }))).toBeNull();
    expect(rejectBlockedReason(st({ phase: "running", turnEndTree: null, reviewEndTree: "heldB" }))).toBeNull();
    expect(rejectBlockedReason(st({ phase: "running", turnEndTree: null, reviewEndTree: null }))).toBe("거절은 이번 턴이 끝난 뒤에 할 수 있어요");
    expect(hunkRejectBlockedReason(st({ phase: "running", turnEndTree: null, reviewEndTree: "heldB" }))).toBe("거절은 이번 턴이 끝난 뒤에 할 수 있어요");
    expect(rejectBlockedReason(st({ phase: "collecting", turnEndTree: null }))).toBe("거절은 이번 턴이 끝난 뒤에 할 수 있어요");
    expect(rejectBlockedReason(st({ phase: "reverting" }))).toBe("되돌리는 중…");
  });

  it("§37.1: a failed collection holds reject / reject_all / reject_hunks / commit until Retry — accept stays", () => {
    const failed = st({ phase: "collect_failed", collectError: "fatal: index.lock" });
    expect(rejectBlockedReason(failed)).toBe("변경 수집을 먼저 다시 시도하세요");
    expect(collectFailedReason(failed)).toBe("변경 수집을 먼저 다시 시도하세요");
    expect(acceptBlockedReason(failed)).toBeNull();
    expect(collectFailedReason(st({ phase: "reviewing" }))).toBeNull();
  });
});

describe("§34.1 diff ranges", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  const merged = { reviewTurns: [3, 4], lastTurnChanges: { turn: 4, files: 1, added: 2, deleted: 1 } };

  it("only the ranges a file has; an engine before §34 has the whole review only", () => {
    expect(availableRanges(file("a.ts"), gate())).toEqual(["review"]);
    // this turn: changed by the last collected turn of a review that spans more than one turn
    expect(availableRanges(file("a.ts", { changedThisTurn: true }), gate(merged))).toEqual(["review", "turn"]);
    expect(availableRanges(file("a.ts", { changedThisTurn: true }), gate({ reviewTurns: [3], lastTurnChanges: { turn: 3, files: 1, added: 1, deleted: 0 } }))).toEqual(["review"]);
    // since request: a request in this review and the file changed since — only where it shows something (as on the Mac:
    // a file with sent notes the follow-up left alone has no range of its own, the list says "요청 후 바뀌지 않음")
    const req = { ...merged, lastRequest: { turn: 4, at: "2026-10-23T01:00:00.000Z", notes: 1 } };
    expect(availableRanges(file("a.ts", { changedSinceRequest: true }), gate(req))).toEqual(["review", "request"]);
    expect(availableRanges(file("a.ts", { sentNoteCount: 1 }), gate(req))).toEqual(["review"]);
    expect(availableRanges(file("a.ts", { sentNoteCount: 1 }), gate({ ...req, lastTurnChanges: { turn: 3, files: 1, added: 1, deleted: 0 } }))).toEqual(["review"]);
    expect(availableRanges(file("a.ts", { changedSinceRequest: true }), gate(merged))).toEqual(["review"]);
    // the last turn is the request's own follow-up: "이번 턴" would show what "요청 이후" shows — offered once
    expect(availableRanges(file("a.ts", { changedSinceRequest: true, changedThisTurn: true }), gate(req))).toEqual(["review", "request"]);
    // a later turn than the follow-up: both
    const later = { reviewTurns: [3, 4, 5], lastTurnChanges: { turn: 5, files: 1, added: 1, deleted: 0 }, lastRequest: { turn: 4, at: "x", notes: 1 } };
    expect(availableRanges(file("a.ts", { changedSinceRequest: true, changedThisTurn: true }), gate(later))).toEqual(["review", "turn", "request"]);
    // since accepted
    expect(availableRanges(file("a.ts", { changedSinceAccepted: true, changedThisTurn: true }), gate(merged))).toEqual(["review", "turn", "accepted"]);
  });

  it("defaults: sent back with notes and changed → since request; pending again after an accept → since accepted; else the whole review", () => {
    const req = { reviewTurns: [3, 4], lastTurnChanges: { turn: 4, files: 1, added: 2, deleted: 1 }, lastRequest: { turn: 4, at: "x", notes: 1 } };
    expect(defaultRange(file("a.ts", { changedSinceRequest: true, sentNoteCount: 1 }), gate(req))).toBe("request");
    // pending (no notes) when the request went out: its earlier changes were never looked at — the whole review
    expect(defaultRange(file("a.ts", { changedSinceRequest: true }), gate(req))).toBe("review");
    expect(defaultRange(file("a.ts", { changedSinceAccepted: true }), gate(req))).toBe("accepted");
    expect(defaultRange(file("a.ts", { changedSinceAccepted: true, changedSinceRequest: true }), gate(req))).toBe("accepted");
    expect(defaultRange(file("a.ts", { changedThisTurn: true }), gate(req))).toBe("review");
    expect(defaultRange(file("a.ts", { changedSinceRequest: true, state: "accepted" }), gate(req))).toBe("review");
    expect(defaultRange(file("a.ts"), gate())).toBe("review");
  });

  it("labels and cache keys (the whole review keeps the path as its key)", () => {
    expect(["review", "turn", "request", "accepted"].map((s) => rangeLabel(s as never))).toEqual(["전체", "이번 턴", "요청 이후", "수락 이후"]);
    expect(rangeCacheKey("a.ts", "review")).toBe("a.ts");
    expect(rangeCacheKey("a.ts", "turn")).not.toBe("a.ts");
    expect(rangeCacheKey("a.ts", "turn")).not.toBe(rangeCacheKey("a.ts", "request"));
  });

  it("“요청 후 바뀌지 않음”: sent notes, a collected follow-up and no change since the request", () => {
    const req = { lastTurnChanges: { turn: 4, files: 1, added: 1, deleted: 0 }, lastRequest: { turn: 4, at: "x", notes: 1 } };
    expect(unchangedSinceRequest(file("a.ts", { sentNoteCount: 1 }), gate(req))).toBe(true);
    expect(unchangedSinceRequest(file("a.ts", { sentNoteCount: 1, changedSinceRequest: true }), gate(req))).toBe(false);
    expect(unchangedSinceRequest(file("a.ts", { sentNoteCount: 1 }), gate({ ...req, lastTurnChanges: { turn: 3, files: 1, added: 1, deleted: 0 } }))).toBe(false);
    expect(unchangedSinceRequest(file("a.ts"), gate(req))).toBe(false);
  });
});

describe("§34.5 viewed by content", () => {
  it("a viewed key is (path, blob); a deleted file is 'deleted'; an engine without blob keeps the path rule", () => {
    expect(contentKey(file("a.ts", { blob: "b1" }))).toBe("b1");
    expect(contentKey(file("a.ts", { status: "D" }))).toBe("deleted");
    expect(contentKey(file("a.ts"))).toBe("");
    const viewed = { "a.ts": "b1", "b.ts": "b9", "c.ts": "" };
    expect(viewStateOf(file("a.ts", { blob: "b1" }), viewed)).toBe("viewed");
    expect(viewStateOf(file("b.ts", { blob: "b2" }), viewed)).toBe("changed");
    expect(viewStateOf(file("c.ts"), viewed)).toBe("viewed");
    expect(viewStateOf(file("d.ts", { blob: "b3" }), viewed)).toBe("unviewed");
  });

  it("counts the pending files whose content changed after they were viewed", () => {
    const viewed = { "a.ts": "b1", "b.ts": "b9", "c.ts": "c1" };
    const files = [file("a.ts", { blob: "b1" }), file("b.ts", { blob: "b2" }), file("c.ts", { blob: "c2", state: "accepted" })];
    expect(changedSinceViewed(files, viewed).map((f) => f.path)).toEqual(["b.ts"]);
  });
});

describe("comp-10 screen order", () => {
  const files = [
    file("src/A.java"),
    file("src/b.ts", { status: "D" }),
    file("ide/Mine.java", { origin: "external", tools: [] }),
    file(".claude/hooks/x.sh", { group: "mods" }),
    file("src/c.ts", { state: "accepted" }),
    file("src/d.ts"),
  ];

  it("groups (settings & hooks, Claude's, outside) and, risky first, the risk sort inside each group", () => {
    expect(displayOrder(files, true).map((f) => f.path)).toEqual([".claude/hooks/x.sh", "src/b.ts", "src/A.java", "src/c.ts", "src/d.ts", "ide/Mine.java"]);
    expect(displayOrder(files, false).map((f) => f.path)).toEqual([".claude/hooks/x.sh", "src/A.java", "src/b.ts", "src/c.ts", "src/d.ts", "ide/Mine.java"]);
  });

  it("⌘] / ⌘[ step through the pending files in that order (wrapping); accept moves to the next one on screen", () => {
    const order = displayOrder(files, true);
    expect(stepPending(order, null, 1)).toBe(".claude/hooks/x.sh");
    expect(stepPending(order, null, -1)).toBe("ide/Mine.java");
    expect(stepPending(order, "src/b.ts", 1)).toBe("src/A.java");
    expect(stepPending(order, "src/A.java", 1)).toBe("src/d.ts");
    expect(stepPending(order, "ide/Mine.java", 1)).toBe(".claude/hooks/x.sh");
    expect(stepPending(order, ".claude/hooks/x.sh", -1)).toBe("ide/Mine.java");
    expect(stepPending([file("only.ts")], "only.ts", 1)).toBeNull();
    expect(nextPendingAfter(order, "src/b.ts")).toBe("src/A.java");
    expect(nextPendingAfter(order, "ide/Mine.java")).toBe(".claude/hooks/x.sh");
    expect(nextPendingAfter([file("only.ts")], "only.ts")).toBeNull();
  });
});

describe("§34.4 sent notes", () => {
  it("unsent / sent", () => {
    const notes = [note("1"), note("2", { sent: { at: "x", turn: 4 } })];
    expect(unsentNotes(notes).map((n) => n.id)).toEqual(["1"]);
    expect(sentNotes(notes).map((n) => n.id)).toEqual(["2"]);
  });

  it("a note sits under its line when the shown diff has it; gone, file-level and off-screen notes go above the diff", () => {
    const diff: FileDiff = {
      oldPath: "a.ts",
      newPath: "a.ts",
      isBinary: false,
      hunks: [
        {
          id: 0,
          header: "@@ -1,2 +1,3 @@",
          lines: [
            { id: 0, kind: "hunkHeader", oldNo: null, newNo: null, text: "@@ -1,2 +1,3 @@" },
            { id: 1, kind: "context", oldNo: 1, newNo: 1, text: "a" },
            { id: 2, kind: "del", oldNo: 2, newNo: null, text: "b" },
            { id: 3, kind: "add", oldNo: null, newNo: 2, text: "c" },
            { id: 4, kind: "add", oldNo: null, newNo: 3, text: "x" },
          ],
        },
      ],
    };
    const notes = [
      note("inline", { line: 3 }),
      note("old", { line: 2, side: "old" }),
      note("gone", { line: 3, anchor: "gone", sent: { at: "x", turn: 4 } }),
      note("file", { line: null }),
      note("far", { line: 40 }),
    ];
    const placed = placeNotes(notes, diff);
    expect(placed.inline.map((n) => n.id)).toEqual(["inline", "old"]);
    expect(placed.outside.map((n) => n.id)).toEqual(["gone", "file", "far"]);
    // no diff on screen (full-file view): only gone / file-level notes leave their line
    const full = placeNotes(notes, null);
    expect(full.inline.map((n) => n.id)).toEqual(["inline", "old", "far"]);
    expect(full.outside.map((n) => n.id)).toEqual(["gone", "file"]);
  });
});

describe("§34.3 the turn_end row and the live totals", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("a merged turn adds the whole review's totals; an engine before §34 adds nothing", () => {
    expect(turnEndReviewText({ merged: true, review: { files: 5, added: 40, deleted: 7 } })).toBe("리뷰 전체: 파일 5개 (+40 −7)");
    expect(turnEndReviewText({ review: { files: 1, added: 2, deleted: 1 } })).toBe("");
    expect(turnEndReviewText({})).toBe("");
  });

  it("live totals: the files listed, else the HUD's count", () => {
    expect(liveTotals([{ added: 12, deleted: 3 }, { added: 310, deleted: 204 }], 2)).toEqual({ files: 2, added: 322, deleted: 207 });
    expect(liveTotals([], 3)).toEqual({ files: 3, added: 0, deleted: 0 });
    expect(liveTotals([{ added: 1, deleted: 0 }], 4)).toEqual({ files: 4, added: 1, deleted: 0 });
  });
});
