/**
 * wave1 desktop-review — review provenance, mods files and the gate notices of docs/PROTOCOL.md §31–32
 * (src/renderer/reviewGate.ts) plus the store flows that use them (engine bridge mocked like composer.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangedFileState, ConcurrentClaude, EngineCommand, EngineEvent, GateState, NestedChange, ReviewState } from "@reviewgate/engine";
import { notificationFor } from "./attention";
import { initI18n, t } from "./i18n";
import {
  addIgnorePatternLines,
  carryGateNotices,
  commitPaths,
  concurrentKey,
  concurrentText,
  dismissConcurrent,
  dismissGateNotice,
  EMPTY_GATE_NOTICES,
  externalCountOf,
  externalPendingOf,
  finishReviewBlocked,
  groupChanges,
  headLabel,
  headMovedText,
  isConcurrentShown,
  isGateNoticeShown,
  joinRoot,
  localSettingsHint,
  localSettingsText,
  modsRiskLabel,
  modsRisksOf,
  nestedDetails,
  nestedKindLabel,
  nestedText,
  originOf,
  commandOfCause,
  planRejectAll,
  restoredNotice,
  showsGroupHeaders,
  skippedText,
  staleLines,
  staleSheetKey,
  turnDoneBody,
  uncapturedText,
} from "./reviewGate";
import { riskKinds, sortByRisk } from "./risk";
import { refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";

/** store.ts `refusalText` without importing the store (it needs the window stub below). */
const refusalText = (code: string) => refusalMessage(refusalOf(code));

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
const ext = (path: string, p: Partial<ChangedFileState> = {}) => file(path, { tools: [], toolUseIds: [], origin: "external", ...p });
const bash = (path: string, p: Partial<ChangedFileState> = {}) => file(path, { tools: ["Bash"], origin: "bash", ...p });
const claude = (pid: number, p: Partial<ConcurrentClaude> = {}): ConcurrentClaude => ({
  pid,
  sessionId: null,
  cwd: "/repo",
  name: null,
  kind: "interactive",
  entrypoint: "cli",
  status: "busy",
  startedAt: "2026-10-22T01:00:00.000Z",
  ...p,
});
const gate = (p: Partial<GateState> = {}): GateState =>
  ({
    phase: "reviewing",
    canSend: true,
    canRequestChanges: true,
    blockedReason: null,
    collectError: null,
    pendingCount: 0,
    changesRequestedCount: 0,
    isRequestingChanges: false,
    turnStartTree: "a",
    turnEndTree: "b",
    lastReviewSummary: null,
    changedOutside: [],
    ignoredTouched: [],
    filteredByPattern: [],
    restored: false,
    reviewSummary: { files: 0, added: 0, deleted: 0 },
    externalPendingCount: 0,
    headMoved: null,
    concurrentClaude: [],
    stale: null,
    localSettingsChanged: null,
    nestedChanges: [],
    snapshotSkipped: [],
    ...p,
  }) as GateState;

describe("review provenance (§31)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("origin comes from the engine; unknown or missing values are neutral, never 'outside'", () => {
    expect(originOf({ origin: "tool" })).toBe("tool");
    expect(originOf({ origin: "bash" })).toBe("bash");
    expect(originOf({ origin: "external" })).toBe("external");
    expect(originOf({ origin: "skill" })).toBe("skill"); // MARK: r2-skills-side (§31.1, M35)
    expect(commandOfCause("skill:acme-verify")).toBe("acme-verify");
    expect([commandOfCause("skill:"), commandOfCause("toolu_01")]).toEqual([null, null]);
    expect(originOf({ origin: "from_the_future" })).toBe("other");
    expect(originOf({})).toBe("other");
    // An engine before §31 (no origin): a Bash cause still reads as Bash, an empty cause list is NOT called outside —
    // that engine's reject_all would revert it.
    expect(originOf({ tools: ["Bash"] })).toBe("bash");
    expect(originOf({ tools: ["Bash", "Edit"] })).toBe("other");
    expect(originOf({ tools: [] })).toBe("other");
  });

  it("badges: 'Bash' only for origin bash, 'outside the app' for external (M2)", () => {
    expect(riskKinds(ext("ide/Mine.java"))).toEqual(["external"]);
    expect(riskKinds(ext("ide/Mine.java"))).not.toContain("bash");
    expect(riskKinds(bash("gen.txt"))).toEqual(["bash"]);
    expect(riskKinds(file("a.ts"))).toEqual([]);
    expect(riskKinds(file("a.ts", { origin: "weird" as never, tools: [] }))).toEqual([]);
    // a turn_summary file mapped onto the risk input keeps its origin
    expect(riskKinds({ path: "x.txt", status: "A", tools: [], added: 1, deleted: 0, origin: "external" })).toEqual(["external"]);
    expect(sortByRisk([file("a.ts"), ext("b.ts"), bash("c.ts")]).map((f) => f.path)).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("counts: the outside pending files come from the engine (fallback: the list)", () => {
    expect(externalPendingOf({ gate: gate({ pendingCount: 3, externalPendingCount: 2 }), changedFiles: [] })).toBe(2);
    const old = { gate: { ...gate({ pendingCount: 2 }), externalPendingCount: undefined }, changedFiles: [ext("x"), file("y"), ext("z", { state: "accepted" })] };
    expect(externalPendingOf(old)).toBe(1);
    expect(externalCountOf([{ origin: "external" }, { origin: "tool" }, {}])).toBe(1);
  });

  it("groups: mods first, then Claude's, then outside the app; one Claude group needs no headers", () => {
    const groups = groupChanges([file("a.ts"), ext("b.ts"), file(".claude/hooks/x.sh", { group: "mods", risk: ["hook", "script"] }), ext("c.ts", { state: "accepted" }), file("d.ts", { group: "other" as never })]);
    expect(groups.map((g) => [g.kind, g.files.map((f) => f.path), g.pending])).toEqual([
      ["mods", [".claude/hooks/x.sh"], 1],
      ["claude", ["a.ts", "d.ts"], 2],
      ["external", ["b.ts", "c.ts"], 1],
    ]);
    expect(showsGroupHeaders(groups)).toBe(true);
    expect(showsGroupHeaders(groupChanges([file("a.ts")]))).toBe(false);
    expect(showsGroupHeaders(groupChanges([ext("a.ts")]))).toBe(true);
    expect(groupChanges([])).toEqual([]);
  });

  it("“모두 되돌리기” plans Claude's changes only; includeExternal adds the outside ones (M3)", () => {
    const files = [file("a.ts"), bash("b.sh"), ext("ide.txt"), file("done.ts", { state: "accepted" })];
    const plain = planRejectAll(files, false);
    expect(plain.cmd).toEqual({ type: "reject_all" });
    expect(plain.revert.map((f) => f.path)).toEqual(["a.ts", "b.sh"]);
    expect(plain.keptExternal.map((f) => f.path)).toEqual(["ide.txt"]);
    expect(plain.external).toEqual([]);
    const all = planRejectAll(files, true);
    expect(all.cmd).toEqual({ type: "reject_all", includeExternal: true });
    expect(all.revert.map((f) => f.path)).toEqual(["a.ts", "b.sh", "ide.txt"]);
    expect(all.external.map((f) => f.path)).toEqual(["ide.txt"]);
    expect(all.keptExternal).toEqual([]);
    // only outside changes pending: nothing of Claude's to revert
    expect(planRejectAll([ext("ide.txt")], false).cmd).toBeNull();
  });

  it("an uncaptured file never blocks the others: they go out as reject{paths} (§32 not_captured)", () => {
    const files = [file("a.ts"), file(".claude/big.bin", { group: "mods", uncaptured: true }), ext("logs/root.log", { uncaptured: true })];
    const plain = planRejectAll(files, false);
    expect(plain.cmd).toEqual({ type: "reject", paths: ["a.ts"] });
    expect(plain.uncaptured.map((f) => f.path)).toEqual([".claude/big.bin"]);
    const all = planRejectAll(files, true);
    expect(all.cmd).toEqual({ type: "reject", paths: ["a.ts"] });
    expect(all.uncaptured.map((f) => f.path)).toEqual([".claude/big.bin", "logs/root.log"]);
    expect(planRejectAll([file("x", { uncaptured: true })], false)).toMatchObject({ cmd: null, uncaptured: [{ path: "x" }] });
  });

  it("the commit sheet never lists gitignored files (§32 ignored)", () => {
    const files = [file("a.ts", { state: "accepted" }), file(".claude/settings.json", { state: "accepted", group: "mods", ignored: true })];
    expect(commitPaths(["a.ts", ".claude/settings.json"], files)).toEqual({ paths: ["a.ts"], ignored: [".claude/settings.json"] });
    expect(commitPaths(["a.ts"], files)).toEqual({ paths: ["a.ts"], ignored: [".claude/settings.json"] });
  });

  it("mods risks in Korean; unknown risks stay visible with a generic label", () => {
    expect(modsRisksOf({ risk: ["script", "hook", "hook", "brand_new"] })).toEqual(["hook", "script", "brand_new"]);
    expect(modsRisksOf({})).toEqual([]);
    expect(modsRiskLabel("hook")).toBe("훅 — 다음 프롬프트부터 자동 실행");
    expect(modsRiskLabel("script")).toBe("실행 스크립트");
    expect(modsRiskLabel("mcp")).toBe("MCP 서버");
    expect(modsRiskLabel("permissions")).toBe("권한 규칙");
    expect(modsRiskLabel("env")).toBe("환경 변수");
    expect(modsRiskLabel("brand_new")).toBe("기타 위험 (brand_new)");
    expect(uncapturedText(file("big.bin", { uncaptured: true }), gate())).toBe("내용 미수집(큰 파일/바이너리) — 되돌릴 수 없음");
    expect(uncapturedText(file("logs/a.log", { uncaptured: true }), gate({ snapshotSkipped: [{ path: "logs/a.log", reason: "unreadable" }] }))).toContain("읽을 수 없어");
  });

  it("the turn's notification counts Claude's files, outside ones apart (badge = pending − external)", () => {
    // wave4b w4-notify: the Mac's words ("리뷰할 파일 N개"), behind "작업이 끝났어요 — ".
    expect(turnDoneBody({ files: 3 })).toBe("리뷰할 파일 3개");
    expect(turnDoneBody({ files: 3, external: 1 })).toBe("리뷰할 파일 2개 · 앱 밖 변경 1개 포함");
    expect(turnDoneBody({ files: 2, external: 2 })).toBe("리뷰할 파일 없음 · 앱 밖 변경 2개 포함");
    const usage = { costUsd: 0, durationMs: 1, inputTokens: 0, outputTokens: 0 } as never;
    const n = notificationFor({ type: "turn_end", stopReason: "end_turn", usage, files: 4, added: 1, deleted: 0, changedOutside: [], external: 3 } as EngineEvent, { project: null })!;
    expect(n.body).toBe("작업이 끝났어요 — 리뷰할 파일 1개 · 앱 밖 변경 3개 포함");
    const stopped = notificationFor({ type: "turn_end", stopReason: "interrupted", usage, files: 2, added: 1, deleted: 0, changedOutside: [], external: 1 } as EngineEvent, { project: null })!;
    expect(stopped.body).toBe("턴이 중단되었습니다 — 리뷰할 파일 1개 · 앱 밖 변경 1개 포함");
  });
});

describe("stale review and finish_review (§31.5)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("HEAD in words: branch@sha7, detached, unborn, unknown", () => {
    expect(headLabel({ branch: "main", sha: "0123456789abcdef" })).toBe("main@0123456");
    expect(headLabel({ branch: null, sha: "0123456789abcdef" })).toBe("분리된 HEAD@0123456");
    expect(headLabel({ branch: "main", sha: null })).toBe("main (커밋 없음)");
    expect(headLabel(null)).toBe("알 수 없음");
  });

  it("the sheet says when it was saved and why it is stale; unknown reasons are skipped", () => {
    const lines = staleLines(
      { reasons: ["head_moved", "old", "brand_new" as never], savedAt: "2026-10-01T00:00:00Z", savedHead: { branch: "main", sha: "aaaaaaa1" }, head: { branch: "main", sha: "bbbbbbb2" }, externalFiles: 13 },
      () => "3주 전",
    );
    expect(lines).toEqual(["저장: 3주 전", "그 뒤 HEAD 가 바뀌었습니다: main@aaaaaaa → main@bbbbbbb", "12시간 이상 지났습니다", "앱 밖 변경 13개가 섞였습니다"]);
    expect(staleLines({ reasons: ["old"], savedAt: "x", savedHead: null, head: null, externalFiles: 0 }, () => "어제")).toEqual(["저장: 어제", "12시간 이상 지났습니다"]);
  });

  it("the sheet opens once per stale review (project + savedAt)", () => {
    const stale = { reasons: ["old" as const], savedAt: "2026-10-01T00:00:00Z", savedHead: null, head: null, externalFiles: 0 };
    expect(staleSheetKey({ project: { root: "/r" }, gate: gate() })).toBeNull();
    expect(staleSheetKey({ project: { root: "/r" }, gate: gate({ stale }) })).toBe(staleSheetKey({ project: { root: "/r" }, gate: gate({ stale: { ...stale } }) }));
    expect(staleSheetKey({ project: { root: "/r" }, gate: gate({ stale }) })).not.toBe(staleSheetKey({ project: { root: "/other" }, gate: gate({ stale }) }));
  });

  it("“리뷰 끝내기” waits for a running turn / collection / revert and needs something to finish", () => {
    const s = (phase: GateState["phase"], files: ChangedFileState[] = [file("a")], notes = 0) => ({ gate: gate({ phase }), changedFiles: files, reviewNotes: Array.from({ length: notes }) as never[] });
    expect(finishReviewBlocked(s("reviewing"))).toBeNull();
    for (const phase of ["running", "collecting", "reverting", "collect_failed"] as const) expect(finishReviewBlocked(s(phase))).toBe("busy");
    expect(finishReviewBlocked(s("idle", []))).toBe("empty");
    expect(finishReviewBlocked(s("idle", [], 1))).toBeNull();
  });

  it("the restored banner stays while the review is stale or outside changes came in", () => {
    expect(restoredNotice({ gate: gate({ restored: true }), changedFiles: [] })).toEqual({ external: 0, stale: false, sticky: false });
    expect(restoredNotice({ gate: gate({ restored: true, externalPendingCount: 13 }), changedFiles: [] })).toEqual({ external: 13, stale: false, sticky: true });
    const stale = { reasons: ["old" as const], savedAt: "x", savedHead: null, head: null, externalFiles: 0 };
    expect(restoredNotice({ gate: gate({ restored: true, stale }), changedFiles: [] }).sticky).toBe(true);
  });
});

describe("gate banners (§31.3–§32.3)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("head_moved in words (also after a peer turn, test point 30)", () => {
    expect(headMovedText({ from: { branch: "feature/a", sha: "1111111aaa" }, to: { branch: "main", sha: "2222222bbb" } })).toBe(
      "이번 턴 동안 브랜치/커밋이 바뀌었습니다 (feature/a@1111111 → main@2222222). 그 차이는 '앱 밖 변경'으로 표시됩니다.",
    );
  });

  it("another Claude: name or pid, terminal or app; the same sessions never show again (test point 10)", () => {
    expect(concurrentText([claude(4242, { name: "acme-b4" })])).toBe(
      "이 worktree 에서 다른 Claude 세션이 실행 중입니다: acme-b4 (터미널) — 그 세션의 수정은 '앱 밖 변경'으로 섞입니다. 워크벤치로 분리하세요.",
    );
    expect(concurrentText([claude(7, { entrypoint: "sdk-ts" }), claude(8, { entrypoint: null })])).toContain("pid 7 (앱/SDK), pid 8 (앱/SDK)");
    expect(concurrentText([1, 2, 3, 4, 5].map((n) => claude(n)))).toContain("외 2개");

    let mem = EMPTY_GATE_NOTICES;
    const open = gate({ concurrentClaude: [claude(1), claude(2)] });
    expect(isConcurrentShown(open, mem)).toBe(true);
    mem = dismissConcurrent(mem, open);
    // every send re-reports the same sessions: still dismissed; one of them exiting changes nothing
    expect(isConcurrentShown(gate({ concurrentClaude: [claude(2), claude(1)] }), mem)).toBe(false);
    expect(isConcurrentShown(gate({ concurrentClaude: [claude(1)] }), mem)).toBe(false);
    // a new terminal session (or a reused pid with another start) shows it again
    expect(isConcurrentShown(gate({ concurrentClaude: [claude(1), claude(3)] }), mem)).toBe(true);
    expect(isConcurrentShown(gate({ concurrentClaude: [claude(1, { startedAt: "2026-10-23T00:00:00Z" })] }), mem)).toBe(true);
    expect(isConcurrentShown(gate({ concurrentClaude: [] }), EMPTY_GATE_NOTICES)).toBe(false);
    expect(isConcurrentShown({ ...gate(), concurrentClaude: undefined }, EMPTY_GATE_NOTICES)).toBe(false);
    expect(concurrentKey(claude(9, { startedAt: null }))).toBe("9@");
    // a new turn does not bring dismissed sessions back
    expect(carryGateNotices(mem, gate({ phase: "reviewing" }), gate({ phase: "running" })).concurrent).toEqual(mem.concurrent);
  });

  it("settings.local.json: which parts, the permissions hint, never the content", () => {
    const c = { path: ".claude/settings.local.json", hooks: true, permissions: true, env: false, mcp: true };
    expect(localSettingsText(c)).toBe(".claude/settings.local.json 이 바뀌었습니다 (훅 · 권한 · MCP) — 비밀값이 있을 수 있어 내용은 보관하지 않으며 되돌릴 수 없습니다.");
    expect(localSettingsHint(c)).toContain("다음 세션부터 조회·읽기 도구");
    expect(localSettingsHint({ ...c, permissions: false })).toBeNull();
    expect(localSettingsText({ ...c, hooks: false, permissions: false, mcp: false })).toBe(".claude/settings.local.json 이 바뀌었습니다 — 비밀값이 있을 수 있어 내용은 보관하지 않으며 되돌릴 수 없습니다.");
  });

  it("nested repositories: kind, branch, file count, HEAD move, timeout (test point 14)", () => {
    const wt: NestedChange = { path: ".claude/worktrees/x", kind: "worktree", branch: "wf-x", head: { from: "aaaaaaaaaa", to: "bbbbbbbbbb" }, dirtyFiles: 4, touchedFiles: ["a", "b"], via: ["edit"] };
    expect(nestedText(wt)).toBe("리뷰 밖 변경 — .claude/worktrees/x (워크트리 · wf-x, 파일 2개): 이 창에서 리뷰되지 않습니다");
    expect(nestedDetails(wt)).toEqual(["HEAD aaaaaaa → bbbbbbb"]);
    const slow: NestedChange = { path: "libs/core", kind: "submodule", branch: null, head: null, dirtyFiles: null, touchedFiles: [], via: ["bash"] };
    expect(nestedText(slow)).toBe("리뷰 밖 변경 — libs/core (서브모듈): 이 창에서 리뷰되지 않습니다");
    expect(nestedDetails(slow)).toEqual(["상태 확인 시간 초과"]);
    expect(nestedText({ ...slow, kind: "repo", dirtyFiles: 3 })).toBe("리뷰 밖 변경 — libs/core (중첩 저장소, 파일 3개): 이 창에서 리뷰되지 않습니다");
    expect(nestedKindLabel("from_the_future")).toBe("중첩 저장소");
  });

  it("unreadable files: the notice and “무시 패턴에 추가” without duplicates (test point 15)", () => {
    expect(skippedText([{ path: "logs/a.log", reason: "unreadable" }, { path: "logs/b.log", reason: "other" as never }])).toBe("읽을 수 없는 파일 2개를 이번 리뷰에서 제외했습니다: logs/a.log, logs/b.log");
    expect(skippedText(["1", "2", "3", "4", "5"].map((p) => ({ path: p, reason: "unreadable" as const })))).toBe("읽을 수 없는 파일 5개를 이번 리뷰에서 제외했습니다: 1, 2, 3 외 2개");
    expect(addIgnorePatternLines(".omc/\r\n/logs/a.log\n", ["logs/a.log", "logs/b.log", "logs/b.log", "", "bad\nline"])).toEqual({ text: ".omc/\n/logs/a.log\nlogs/b.log", added: ["logs/b.log"] });
    expect(addIgnorePatternLines("", ["x.log"])).toEqual({ text: "x.log", added: ["x.log"] });
  });

  it("a dismissed notice stays hidden for that turn and comes back with the next occurrence", () => {
    const moved = { from: { branch: "main", sha: "1" }, to: { branch: "main", sha: "2" } };
    const g1 = gate({ headMoved: moved, phase: "reviewing" });
    let mem = dismissGateNotice(EMPTY_GATE_NOTICES, "headMoved", g1);
    expect(isGateNoticeShown("headMoved", g1, mem)).toBe(false);
    // the next snapshot repeats it: still hidden
    const again = gate({ headMoved: { ...moved }, phase: "reviewing" });
    mem = carryGateNotices(mem, g1, again);
    expect(isGateNoticeShown("headMoved", again, mem)).toBe(false);
    // the next turn starts (the engine clears it) and ends with the same move again: shown
    const running = gate({ headMoved: null, phase: "running" });
    mem = carryGateNotices(mem, again, running);
    expect(mem.dismissed.headMoved).toBeUndefined();
    expect(isGateNoticeShown("headMoved", gate({ headMoved: moved }), mem)).toBe(true);
    // unchanged memory keeps its identity (no store churn)
    expect(carryGateNotices(EMPTY_GATE_NOTICES, g1, again)).toBe(EMPTY_GATE_NOTICES);
    expect(isGateNoticeShown("nested", gate({ nestedChanges: [] }), EMPTY_GATE_NOTICES)).toBe(false);
    expect(isGateNoticeShown("skipped", { ...gate(), snapshotSkipped: undefined }, EMPTY_GATE_NOTICES)).toBe(false);
    expect(isGateNoticeShown("localSettings", gate({ localSettingsChanged: { path: "p", hooks: true, permissions: false, env: false, mcp: false } }), EMPTY_GATE_NOTICES)).toBe(true);
  });

  it("joins a repo-relative path onto the native root", () => {
    expect(joinRoot("/Users/me/repo", ".claude/settings.local.json", "/")).toBe("/Users/me/repo/.claude/settings.local.json");
    expect(joinRoot("C:\\repo\\", ".claude/worktrees/x", "\\")).toBe("C:\\repo\\.claude\\worktrees\\x");
  });

  it("not_captured / uncaptured refusals in words with the way out", () => {
    expect(refusalText("not_captured:.claude/big.bin")).toBe("내용을 수집하지 못한 파일이라 되돌릴 수 없습니다: .claude/big.bin — 직접 고치거나 수락하세요");
    expect(refusalText("partial_reject_unsupported:uncaptured")).toBe("내용을 수집하지 못한 파일이라 부분 되돌리기도 할 수 없습니다");
  });
});

// ---------------------------------------------------------------- store flows (engine bridge mocked)

type Reply = { ok: true; reply: unknown } | { ok: false; error: string; code?: string; paths?: string[] };
const sent: EngineCommand[] = [];
let respond: (cmd: EngineCommand) => Reply = () => ({ ok: true, reply: { type: "result", ok: true } });
let savedSettings: Record<string, unknown>[] = [];

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
      setSettings: async (patch: Record<string, unknown>) => {
        savedSettings.push(patch);
        return { appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400, checkpointIgnorePatterns: ".omc/", ...patch };
      },
      getSettings: async () => ({ appearance: "system", budgetMaxFiles: 10, budgetMaxLines: 400, checkpointIgnorePatterns: ".omc/" }),
      setUI: async () => undefined,
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "darwin",
    },
  };
  return (await import("./store")).useStore;
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("review store flows (wave1 desktop-review)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => {
    sent.length = 0;
    savedSettings = [];
    respond = () => ({ ok: true, reply: { type: "result", ok: true } });
  });

  let seq = 100;
  /** Applies a snapshot through `handleEvent` (the live path), on top of a reviewing project. */
  const snapshot = (useStore: Awaited<ReturnType<typeof loadStore>>, files: ChangedFileState[], g: Partial<GateState> = {}, extra: Partial<ReviewState> = {}) => {
    const s = useStore.getState().state;
    const pending = files.filter((f) => f.state === "pending");
    useStore.getState().handleEvent({
      type: "state",
      state: {
        ...s,
        seq: ++seq,
        project: { path: "/p", root: "/p", name: "p" } as never,
        changedFiles: files,
        gate: gate({ pendingCount: pending.length, externalPendingCount: pending.filter((f) => f.origin === "external").length, ...g }),
        ...extra,
      } as ReviewState,
    });
  };

  it("“모두 되돌리기” leaves the outside changes; “앱 밖 변경도 되돌리기” asks again, then includeExternal (test points 8–9)", async () => {
    const useStore = await loadStore();
    useStore.setState({ dialog: null });
    snapshot(useStore, [file("a.ts"), ext("ide/Mine.java")]);
    useStore.getState().rejectAll();
    await flush();
    expect(sent.filter((c) => c.type.startsWith("reject"))).toEqual([{ type: "reject_all" }]);

    sent.length = 0;
    useStore.getState().rejectAll(true);
    await flush();
    expect(useStore.getState().dialog).toEqual({ kind: "rejectExternal", paths: ["ide/Mine.java"], all: true });
    expect(sent.filter((c) => c.type.startsWith("reject"))).toEqual([]);
    useStore.getState().answerRejectExternal(true);
    await flush();
    expect(useStore.getState().dialog).toBeNull();
    expect(sent.filter((c) => c.type.startsWith("reject"))).toEqual([{ type: "reject_all", includeExternal: true }]);
  });

  it("closing the second confirm any other way keeps the outside changes", async () => {
    const useStore = await loadStore();
    snapshot(useStore, [file("a.ts"), ext("ide/Mine.java")]);
    useStore.getState().rejectAll(true);
    await flush();
    expect(useStore.getState().dialog?.kind).toBe("rejectExternal");
    useStore.getState().openDialog(null);
    await flush();
    expect(sent.filter((c) => c.type.startsWith("reject"))).toEqual([]);
    // a declined answer sends nothing either
    useStore.getState().reject("ide/Mine.java");
    await flush();
    expect(useStore.getState().dialog).toEqual({ kind: "rejectExternal", paths: ["ide/Mine.java"], all: false });
    useStore.getState().answerRejectExternal(false);
    await flush();
    expect(sent.filter((c) => c.type.startsWith("reject"))).toEqual([]);
  });

  it("a single outside file is reverted after the confirm; an uncaptured one is never sent", async () => {
    const useStore = await loadStore();
    snapshot(useStore, [ext("ide/Mine.java"), file(".claude/big.bin", { group: "mods", uncaptured: true })]);
    useStore.getState().reject("ide/Mine.java");
    await flush();
    useStore.getState().answerRejectExternal(true);
    await flush();
    expect(sent.filter((c) => c.type.startsWith("reject"))).toEqual([{ type: "reject", paths: ["ide/Mine.java"] }]);

    sent.length = 0;
    useStore.getState().reject(".claude/big.bin");
    await flush();
    expect(sent).toEqual([]);
    expect(useStore.getState().errorBanner?.message).toBe("내용을 수집하지 못한 파일이라 되돌릴 수 없습니다: .claude/big.bin — 직접 고치거나 수락하세요");
    expect(useStore.getState().errorBanner?.code).toBe("not_captured");
  });

  it("a not_captured refusal reaches the banner in Korean", async () => {
    const useStore = await loadStore();
    snapshot(useStore, [file("a.ts")]);
    respond = (c) => (c.type === "reject_all" ? { ok: false, error: "not_captured:a.ts", code: "not_captured", paths: ["a.ts"] } : { ok: true, reply: {} });
    useStore.getState().rejectAll();
    await flush();
    expect(useStore.getState().errorBanner?.message).toBe("내용을 수집하지 못한 파일이라 되돌릴 수 없습니다: a.ts — 직접 고치거나 수락하세요");
  });

  it("a stale review never opens a sheet by itself (r2-review-flow M29: the banner decides); 이어서 리뷰 = keep_review, 정리 = finish_review; a sheet still up closes with the flag (test point 11)", async () => {
    const useStore = await loadStore();
    useStore.setState({ dialog: null });
    const stale = { reasons: ["head_moved" as const], savedAt: "2026-10-01T00:00:00Z", savedHead: { branch: "main", sha: "a" }, head: { branch: "main", sha: "b" }, externalFiles: 2 };
    snapshot(useStore, [file("a.ts"), ext("b.ts"), ext("c.ts")], { restored: true, stale });
    expect(useStore.getState().dialog).toBeNull();
    snapshot(useStore, [file("a.ts"), ext("b.ts"), ext("c.ts")], { restored: true, stale: { ...stale } });
    expect(useStore.getState().dialog).toBeNull();

    expect(await useStore.getState().keepReview()).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "keep_review" });
    useStore.getState().openDialog({ kind: "staleReview" });
    snapshot(useStore, [file("a.ts"), ext("b.ts"), ext("c.ts")], { restored: true, stale: null });
    expect(useStore.getState().dialog).toBeNull();

    expect(await useStore.getState().finishReview()).toBeNull();
    expect(sent.at(-1)).toEqual({ type: "finish_review" });
    respond = (c) => (c.type === "finish_review" ? { ok: false, error: "session_running", code: "session_running" } : { ok: true, reply: {} });
    expect(await useStore.getState().finishReview()).toBe("session_running");
    expect(useStore.getState().errorBanner?.message).toBe("Claude가 작업 중…");
  });

  it("dismissed notices: concurrent sessions by pid for good, the rest until the next turn", async () => {
    const useStore = await loadStore();
    const moved = { from: { branch: "main", sha: "1" }, to: { branch: "main", sha: "2" } };
    snapshot(useStore, [file("a.ts")], { concurrentClaude: [claude(11)], headMoved: moved });
    expect(isConcurrentShown(useStore.getState().state.gate, useStore.getState().gateNotices)).toBe(true);
    useStore.getState().dismissConcurrentClaude();
    useStore.getState().dismissGateNotice("headMoved");
    snapshot(useStore, [file("a.ts")], { concurrentClaude: [claude(11)], headMoved: moved });
    let st = useStore.getState();
    expect(isConcurrentShown(st.state.gate, st.gateNotices)).toBe(false);
    expect(isGateNoticeShown("headMoved", st.state.gate, st.gateNotices)).toBe(false);
    snapshot(useStore, [file("a.ts")], { phase: "running", canSend: false, concurrentClaude: [claude(11)], headMoved: null });
    snapshot(useStore, [file("a.ts")], { concurrentClaude: [claude(11)], headMoved: moved });
    st = useStore.getState();
    expect(isConcurrentShown(st.state.gate, st.gateNotices)).toBe(false);
    expect(isGateNoticeShown("headMoved", st.state.gate, st.gateNotices)).toBe(true);
  });

  it("“무시 패턴에 추가” merges the unreadable files into the ignore patterns once", async () => {
    const useStore = await loadStore();
    await useStore.getState().loadSettings();
    snapshot(useStore, [], { snapshotSkipped: [{ path: "logs/root.log", reason: "unreadable" }] });
    await useStore.getState().ignoreSkippedFiles();
    expect(savedSettings).toEqual([{ checkpointIgnorePatterns: ".omc/\nlogs/root.log" }]);
    const st = useStore.getState();
    expect(isGateNoticeShown("skipped", st.state.gate, st.gateNotices)).toBe(false);
  });

  it("“앱 밖 변경 보기” selects the first outside file", async () => {
    const useStore = await loadStore();
    snapshot(useStore, [file("a.ts"), ext("z.txt", { state: "accepted" }), ext("b.txt")]);
    useStore.getState().revealExternalChanges();
    expect(useStore.getState().selectedPath).toBe("b.txt");
  });

  // ---------------------------------------------------------------- components (static markup)

  /**
   * Server rendering reads zustand's *initial* state (`getServerSnapshot`); copying the current state into that object
   * lets `renderToStaticMarkup` show what the window would show now (test-only).
   */
  const render = (useStore: Awaited<ReturnType<typeof loadStore>>, component: Parameters<typeof createElement>[0]) => {
    Object.assign(useStore.getInitialState(), useStore.getState());
    return renderToStaticMarkup(createElement(component as never));
  };

  it("the Changes list: settings & hooks, Claude's, outside — badges, no Bash for outside files, uncaptured Reject off (M2, test point 13)", async () => {
    const useStore = await loadStore();
    useStore.setState({ dialog: null, gateNotices: EMPTY_GATE_NOTICES });
    snapshot(useStore, [
      file("src/A.java"),
      bash("gen/out.txt"),
      ext("ide/Mine.java"),
      file(".claude/hooks/sweep.sh", { group: "mods", risk: ["hook", "script"], ignored: true, origin: "bash", tools: ["Bash"] }),
      file(".claude/big.bin", { group: "mods", uncaptured: true }),
    ]);
    const { ChangedFiles } = await import("./components/ChangedFiles");
    const html = render(useStore, ChangedFiles);
    const order = ["설정·훅 (Claude 동작 변경)", "Claude 변경", "앱 밖 변경"].map((label) => html.indexOf(label));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("모두 거절은 이 파일들을 그대로 둡니다");
    expect(html).toContain("훅 — 다음 프롬프트부터 자동 실행");
    expect(html).toContain("gitignore 됨");
    expect(html).toContain("내용 미수집");
    expect(html).toContain("리뷰 끝내기");
    // Bash only for the Bash files; the outside file carries no Bash badge (its group says where it is from)
    const mine = html.slice(html.indexOf('data-testid="File ide/Mine.java"'));
    expect(mine.slice(0, mine.indexOf("</li>"))).not.toContain("Bash로 변경");
    const gen = html.slice(html.indexOf('data-testid="File gen/out.txt"'));
    expect(gen.slice(0, gen.indexOf("</li>"))).toContain("Bash로 변경");
    // the uncaptured file's Reject is disabled
    const big = html.slice(html.indexOf('data-testid="File .claude/big.bin"'));
    expect(big.slice(0, big.indexOf("</li>"))).toMatch(/<button(?=[^>]*aria-label="거절 \(⌘⇧R\)")(?=[^>]*disabled="")[^>]*>/);
    const src = html.slice(html.indexOf('data-testid="File src/A.java"'));
    expect(src.slice(0, src.indexOf("</li>"))).not.toMatch(/<button(?=[^>]*aria-label="거절 \(⌘⇧R\)")(?=[^>]*disabled="")[^>]*>/);
  });

  it("only Claude's files: the list looks as before (no group headers)", async () => {
    const useStore = await loadStore();
    snapshot(useStore, [file("a.ts"), file("b.ts")]);
    const { ChangedFiles } = await import("./components/ChangedFiles");
    const html = render(useStore, ChangedFiles);
    expect(html).not.toContain('data-testid="Group claude"');
    expect(html).not.toContain("앱 밖 변경");
  });

  it("MARK: r2-skills-side (§31.1, M35): a skill's !`command` lines are its file's cause — the command named, not a call missing from the chat", async () => {
    const useStore = await loadStore();
    const own = file("gen/version.txt", { origin: "skill", tools: ["Skill"], toolUseIds: ["skill:acme-verify"], risks: ["bash"] });
    snapshot(useStore, [own, ext("ide/Mine.java")]);
    const { ChangeCause } = await import("./components/diff/ChangeCause");
    Object.assign(useStore.getInitialState(), useStore.getState());
    const html = renderToStaticMarkup(createElement(ChangeCause, { file: own }));
    expect(html).toContain('data-testid="Cause skill command"');
    expect(html).toContain("/acme-verify");
    expect(html).toContain(t("Its !`…` lines ran while the command loaded"));
    expect(html).not.toContain(t("This call is not in the loaded conversation"));
    // In the Changes list it is Claude's — never outside the app — with the engine's Bash badge.
    const { ChangedFiles } = await import("./components/ChangedFiles");
    const list = render(useStore, ChangedFiles);
    const row = list.slice(list.indexOf('data-testid="File gen/version.txt"'));
    expect(list.indexOf('data-testid="File gen/version.txt"')).toBeLessThan(list.indexOf("앱 밖 변경"));
    expect(row.slice(0, row.indexOf("</li>"))).toContain("Bash로 변경");
  });

  it("the gate banners say what happened and offer the way out (§2.5)", async () => {
    const useStore = await loadStore();
    useStore.setState({ gateNotices: EMPTY_GATE_NOTICES });
    snapshot(useStore, [ext("pulled.txt")], {
      headMoved: { from: { branch: "main", sha: "1111111aaa" }, to: { branch: "main", sha: "2222222bbb" } },
      concurrentClaude: [claude(4242, { name: "acme-b4" })],
      localSettingsChanged: { path: ".claude/settings.local.json", hooks: true, permissions: true, env: false, mcp: false },
      nestedChanges: [{ path: ".claude/worktrees/x", kind: "worktree", branch: "wf-x", head: null, dirtyFiles: 1, touchedFiles: ["a.ts"], via: ["edit"] }],
      snapshotSkipped: [{ path: "logs/root.log", reason: "unreadable" }],
    });
    const { GateBanners } = await import("./components/GateBanners");
    const html = render(useStore, GateBanners);
    for (const id of ["Head moved banner", "Concurrent Claude banner", "Local settings banner", "Nested changes banner", "Snapshot skipped banner"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain("앱 밖 변경 보기");
    expect(html).toContain("acme-b4 (터미널)");
    expect(html).toContain("워크벤치 만들기");
    expect(html).toContain("파일 열기");
    expect(html).toContain("다음 세션부터 조회·읽기 도구");
    // The changed allow rules lead to Settings › 권한 (desktop-perms' tab), where the terminal's rules are listed.
    expect(html).toContain("설정 &gt; 권한 &gt; 터미널(Claude Code) 허용 규칙");
    expect(html).toContain(`data-testid="Show terminal allow rules"`);
    expect(html).toContain("터미널 허용 규칙 보기");
    expect(html).toContain("워크벤치로 열기");
    expect(html).toContain("무시 패턴에 추가");
    useStore.getState().dismissConcurrentClaude();
    expect(render(useStore, GateBanners)).not.toContain("Concurrent Claude banner");
  });

  it("the Reject all dialog: Claude's changes only, with the outside ones as a second choice (M3)", async () => {
    const useStore = await loadStore();
    snapshot(useStore, [file("a.ts"), file("b.ts"), ext("ide/Mine.java")]);
    useStore.setState({ dialog: { kind: "rejectAll" } });
    const { Dialogs } = await import("./components/dialogs/Dialogs");
    const html = render(useStore, Dialogs);
    expect(html).toContain("Claude 변경 2개를 되돌립니다. 앱 밖 변경 1개는 그대로 둡니다.");
    expect(html).toContain("앱 밖 변경도 되돌리기");
    // no outside change: the second choice is not offered
    snapshot(useStore, [file("a.ts")]);
    expect(render(useStore, Dialogs)).not.toContain("앱 밖 변경도 되돌리기");
    // the second confirm lists the outside files
    useStore.setState({ dialog: { kind: "rejectExternal", paths: ["ide/Mine.java"], all: true } });
    const second = render(useStore, Dialogs);
    expect(second).toContain("이 파일들은 Claude가 바꾸지 않았을 수 있습니다. 되돌리면 그 수정이 사라집니다:");
    expect(second).toContain("ide/Mine.java");
    useStore.setState({ dialog: null });
  });

  it("the stale sheet and the restored banner (§31.5)", async () => {
    const useStore = await loadStore();
    const stale = { reasons: ["head_moved" as const, "old" as const], savedAt: "2026-10-01T00:00:00Z", savedHead: { branch: "main", sha: "aaaaaaa1" }, head: { branch: "main", sha: "bbbbbbb2" }, externalFiles: 13 };
    snapshot(useStore, [ext("x.txt")], { restored: true, stale }, { reviewNotes: [{ id: "n1" }] as never });
    useStore.setState({ dialog: { kind: "staleReview" } });
    const { Dialogs } = await import("./components/dialogs/Dialogs");
    const sheet = render(useStore, Dialogs);
    expect(sheet).toContain("오래된 리뷰입니다");
    expect(sheet).toContain("그 뒤 HEAD 가 바뀌었습니다: main@aaaaaaa → main@bbbbbbb");
    expect(sheet).toContain("12시간 이상 지났습니다");
    expect(sheet).toContain("앱 밖 변경 13개가 섞였습니다");
    expect(sheet).toContain("메모 1개도 함께 지워집니다");
    expect(sheet).toContain("정리");
    expect(sheet).toContain("이어서 리뷰");
    useStore.setState({ dialog: null });
    const { BannerStack } = await import("./components/BannerStack");
    const banner = render(useStore, BannerStack);
    expect(banner).toContain("새로 끼어든 변경 1개");
    expect(banner).toContain("정리…");
  });
});
