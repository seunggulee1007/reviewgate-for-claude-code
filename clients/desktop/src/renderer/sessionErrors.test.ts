import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { needsAction } from "./attention";
import { errorEventText, lfsInstallCommand, presentationOf, refusalMessage } from "./errorCodes";
import { EngineRefusal, refusalOf } from "./engineRequest";
import { initI18n } from "./i18n";
import { appendErrorRow, clearsOnReady, createWorkbenchDialog, errorKey, errorSubline, errorTone, factsOf, pausesQueue, queueRetryDelayMs, queueStopOf, repeatLabel, requeuesSend, sessionActions, type ErrorRow } from "./sessionErrors";
import type { ChatItem } from "./store";

const row = (message: string, facts: ErrorRow["facts"], extra: Partial<ErrorRow> = {}): ErrorRow => ({ kind: "error", id: Math.random(), message, fatal: true, ...(facts ? { facts } : {}), ...extra });

describe("session errors (docs/PROTOCOL.md §29 / §30 / §33.4, M4)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("notices are information or warnings, never a red failure", () => {
    expect(errorTone("resume_not_found", false)).toBe("info");
    expect(errorTone("resume_failed", false)).toBe("info");
    expect(errorTone("worktree_blocked", false)).toBe("warning");
    expect(errorTone("worktree_outside_review", false)).toBe("warning");
    expect(errorTone("peer_release_failed", false)).toBe("warning");
    expect(errorTone("unprompted_blocked", false)).toBe("warning");
    expect(errorTone("session_start_failed", true)).toBe("fatal");
    expect(errorTone("session_id_in_use", true)).toBe("fatal");
    expect(errorTone("lfs_missing", false)).toBe("error");
    expect(errorTone(undefined, false)).toBe("error");
    expect(presentationOf("session_id_in_use")).toBe("fatalSession");
  });

  it("§2.9 / §50.1: notices and unrelated failures keep the queue going; the message's own send, its session, a login and the API stop it", () => {
    for (const code of ["resume_not_found", "resume_failed", "worktree_blocked", "worktree_outside_review", "peer_release_failed", "unprompted_blocked", "api_retrying", "cli_start_slow"]) {
      expect(pausesQueue({ fatal: false, code }), code).toBe(false);
    }
    // A failing PR list, a refresh, a commit, an MCP server, a collection (the gate holds the queue itself): the banner only.
    for (const code of ["command_failed", "refresh_failed", "commit_failed", "mcp_failed", "branch_failed", "workbench_failed", "revert_failed", "collect_failed", "plan_followup_failed", "max_turns", "brand_new_failure"]) {
      expect(queueStopOf({ fatal: false, code }), code).toBe("none");
    }
    expect(queueStopOf({ fatal: false })).toBe("none");
    for (const [code, fatal] of [["session_start_failed", true], ["session_crashed", true], ["session_id_in_use", true], ["lfs_missing", false], ["send_failed", false], ["auth_required", false], ["command_failed", true]] as const) {
      expect(queueStopOf({ fatal, code }), code).toBe("pause");
      expect(pausesQueue({ fatal, code }), code).toBe(true);
    }
    expect(queueStopOf({ fatal: false, code: "api_error" })).toBe("retry");
    expect(queueStopOf({ fatal: false, code: "rate_limited" })).toBe("retry");
    expect(queueStopOf({ fatal: false, code: "usage_limit" })).toBe("untilReset");
    expect([queueRetryDelayMs(1), queueRetryDelayMs(2), queueRetryDelayMs(7)]).toEqual([30_000, 120_000, 120_000]);
  });

  it("§29: a send the gate refused for a moment waits in the queue; other refusals do not", () => {
    expect(requeuesSend({ code: "gate_closed", detail: "external_turn" })).toBe(true);
    expect(requeuesSend({ code: "gate_closed", detail: "running" })).toBe(true);
    expect(requeuesSend({ code: "gate_closed", detail: "awaiting_permission" })).toBe(true);
    expect(requeuesSend({ code: "gate_closed", detail: "changes_requested" })).toBe(false);
    expect(requeuesSend({ code: "gate_closed", detail: "no_session" })).toBe(false);
    expect(requeuesSend({ code: "invalid_mention", detail: "../x" })).toBe(false);
  });

  it("notices never ask for the user in an OS notification; lfs_missing does", () => {
    expect(needsAction({ fatal: false, code: "resume_not_found" })).toBe(false);
    expect(needsAction({ fatal: false, code: "worktree_blocked" })).toBe(false);
    expect(needsAction({ fatal: false, code: "unprompted_blocked" })).toBe(false);
    expect(needsAction({ fatal: false, code: "peer_release_failed" })).toBe(false);
    expect(needsAction({ fatal: false, code: "lfs_missing" })).toBe(true);
    expect(needsAction({ fatal: true, code: "session_start_failed" })).toBe(true);
  });

  it("keeps only the facts an error carries", () => {
    expect(factsOf({ code: "session_crashed", detail: "boom", exitCode: 1, signal: null })).toEqual({ code: "session_crashed", cliDetail: "boom", exitCode: 1 });
    expect(factsOf({ code: "worktree_blocked", toolName: "EnterWorktree", branch: "feat-x", path: "/r/.claude/worktrees/x" })).toEqual({ code: "worktree_blocked", toolName: "EnterWorktree", branch: "feat-x", path: "/r/.claude/worktrees/x" });
    expect(factsOf({})).toEqual({});
  });

  it("test point 18: the same session_start_failed five times is one row ×5", () => {
    let items: ChatItem[] = [{ kind: "user", id: 1, text: "hi" }];
    for (let i = 0; i < 5; i++) items = appendErrorRow(items, row("start failed", { code: "session_start_failed", cliDetail: "Error: unknown option '--x'" }, { lastAt: 1000 + i })).items;
    const errors = items.filter((i) => i.kind === "error") as ErrorRow[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.count).toBe(5);
    expect(errors[0]!.lastAt).toBe(1004);
    expect(sessionActions("session_start_failed", { count: 5 })[0]).toBe("newChat");
  });

  it("merges on code + the CLI's words (else the text), past trailing turn-end lines only", () => {
    const a = row("crashed", { code: "session_crashed", cliDetail: "x" });
    const b = row("crashed", { code: "session_crashed", cliDetail: "y" });
    expect(errorKey(a.message, a.facts)).not.toBe(errorKey(b.message, b.facts));
    let items: ChatItem[] = appendErrorRow([], a).items;
    items = appendErrorRow(items, b).items;
    expect(items).toHaveLength(2);
    items = [...items, { kind: "turnEnd", id: 9, summary: "s" }];
    const merged = appendErrorRow(items, row("crashed", { code: "session_crashed", cliDetail: "y" }));
    expect(merged.items).toHaveLength(3);
    expect(merged.row.count).toBe(2);
    // A conversation row in between: the error happened again later — a new row at the bottom.
    const later = appendErrorRow([...merged.items, { kind: "user", id: 10, text: "again" }], row("crashed", { code: "session_crashed", cliDetail: "y" }));
    expect(later.items.filter((i) => i.kind === "error")).toHaveLength(3);
    // No code, no detail: the text decides.
    const plain = appendErrorRow(appendErrorRow([], row("Failed to load diff", undefined)).items, row("Failed to load diff", undefined));
    expect(plain.items).toHaveLength(1);
    expect(plain.row.count).toBe(2);
  });

  it("§2.6 actions: New chat first after a start failure or a repeated crash", () => {
    expect(sessionActions("session_start_failed", { count: 1 })).toEqual(["newChat", "retry", "openLog"]);
    expect(sessionActions("session_crashed", { count: 1 })).toEqual(["reconnect", "newChat", "openLog"]);
    expect(sessionActions("session_crashed", { count: 2 })).toEqual(["newChat", "reconnect", "openLog"]);
    expect(sessionActions("session_id_in_use", { count: 1 })[0]).toBe("newChat");
    expect(sessionActions("resume_not_found", { count: 1, facts: { sessionId: "old" } })).toEqual(["history"]);
    expect(sessionActions("resume_failed", { count: 1, facts: {} })).toEqual([]);
    expect(sessionActions("peer_release_failed", { count: 1 })).toEqual([]);
    expect(sessionActions("lfs_missing", { count: 1 })).toEqual(["copyCommand"]);
  });

  it("§2.5 worktree actions: a workbench opens as one, any other folder in a new window", () => {
    const isWorkbench = (p: string) => p === "/wt/feat";
    expect(sessionActions("worktree_blocked", { count: 1, facts: { toolName: "EnterWorktree", branch: "feat" } })).toEqual(["createWorkbench"]);
    // Test point 16: the sheet opens with the branch Claude wanted.
    expect(createWorkbenchDialog({ code: "worktree_blocked", toolName: "EnterWorktree", branch: " feat-login " })).toEqual({ kind: "newWorkbench", branch: "feat-login" });
    expect(createWorkbenchDialog({ code: "worktree_blocked", toolName: "Workflow" })).toEqual({ kind: "newWorkbench" });
    // wave4b w4b-follow (§39.4): a worktree of this repository — the chat can follow it there first.
    expect(sessionActions("worktree_outside_review", { count: 1, facts: { path: "/wt/feat" }, isWorkbench })).toEqual(["moveChat", "openWorkbench"]);
    expect(sessionActions("worktree_outside_review", { count: 1, facts: { path: "/elsewhere" }, isWorkbench })).toEqual(["openFolder"]);
    expect(sessionActions("worktree_outside_review", { count: 1, facts: {} , isWorkbench })).toEqual([]);
  });

  it("the second line: the CLI's words and how it ended; ×N and the last time", () => {
    expect(errorSubline({ cliDetail: "Error: bad settings", exitCode: 1 })).toBe("Error: bad settings · 종료 코드 1");
    expect(errorSubline({ signal: "SIGKILL" })).toBe("신호 SIGKILL");
    expect(errorSubline(undefined)).toBe("");
    expect(repeatLabel(1, 5)).toBe("");
    const at = Date.UTC(2026, 9, 22, 6, 12);
    expect(repeatLabel(3, at, { timeZone: "Asia/Seoul" })).toBe("×3 · 오후 3:12");
  });

  it("§30: a crash banner goes away once the session answers initialize again; notices do not", () => {
    expect(clearsOnReady({ code: "session_crashed", fatal: true, scope: "session" })).toBe(true);
    expect(clearsOnReady({ code: "session_start_failed", fatal: true, scope: "session" })).toBe(true);
    expect(clearsOnReady({ code: "cli_not_found", fatal: true, scope: "engine" })).toBe(true);
    expect(clearsOnReady({ code: "resume_not_found", fatal: false, scope: "session" })).toBe(false);
    expect(clearsOnReady({ code: "commit_failed", fatal: false, scope: "git" })).toBe(false);
    expect(clearsOnReady(null)).toBe(false);
  });
});

describe("session / peer / worktree words (Korean)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("§2.6 session start and recovery", () => {
    expect(errorEventText({ code: "session_start_failed", message: "Claude Code exited while starting.", detail: "x" })).toBe("Claude Code가 시작하자마자 종료됐어요.");
    expect(errorEventText({ code: "session_crashed", message: "x" })).toBe("Claude 세션이 비정상 종료됐어요.");
    expect(errorEventText({ code: "resume_not_found", message: "x" })).toContain("새 대화로 시작했어요");
    expect(errorEventText({ code: "resume_failed", message: "x" })).toContain("불러오지 못해");
    expect(errorEventText({ code: "session_id_in_use", message: "x" })).toContain("새 채팅으로 시작해 주세요");
    expect(errorEventText({ code: "peer_release_failed", message: "x" })).toContain("다시 시도하거나 거절해 주세요");
  });

  it("§2.5 worktree_blocked has one sentence per tool; worktree_outside_review names the folder", () => {
    expect(errorEventText({ code: "worktree_blocked", message: "x", toolName: "EnterWorktree", branch: "feat-x" })).toContain("'feat-x'");
    expect(errorEventText({ code: "worktree_blocked", message: "x", toolName: "Workflow" })).toContain("워크플로");
    expect(errorEventText({ code: "worktree_blocked", message: "x", toolName: "Agent" })).toContain("격리(worktree)");
    expect(errorEventText({ code: "worktree_blocked", message: "x", toolName: "Task" })).toContain("격리(worktree)");
    // A restored row has no tool: still a sentence, not the English fallback.
    expect(errorEventText({ code: "worktree_blocked", message: "Claude tried to work in …" })).toMatch(/막았어요/);
    expect(errorEventText({ code: "worktree_outside_review", message: "x", path: "/r/.claude/worktrees/a" })).toBe("리뷰에 잡히지 않는 위치에서 작업했습니다: /r/.claude/worktrees/a");
  });

  it("lfs_missing gives this platform's install command", () => {
    expect(errorEventText({ code: "lfs_missing", message: "x" }, { platform: "darwin" })).toContain("brew install git-lfs && git lfs install");
    expect(errorEventText({ code: "lfs_missing", message: "x" }, { platform: "win32" })).toContain("git-lfs.com");
    expect(lfsInstallCommand("win32")).toBe("git lfs install");
  });

  it("§29 refusals and gate_closed:external_turn", () => {
    const words = (error: string, code?: string) => refusalMessage(refusalOf(new EngineRefusal(error, code)));
    expect(words("gate_closed:external_turn")).toBe("다른 작업이 끝나면 보낼게요");
    // wave4d w4d-windows (polish-07): the Mac's words for the gate state, never the raw "running" in brackets.
    expect(words("gate_closed:running")).toBe("Claude가 작업 중입니다 — 턴이 끝날 때까지 기다리세요");
    expect(words("peer_inbox_changed:a,b", "peer_inbox_changed")).toBe("새 메시지가 도착해 목록이 바뀌었어요. 다시 확인해 주세요");
    expect(words("peer_none")).toContain("없어요");
    expect(words("peer_release_failed:timeout")).toContain("timeout");
    expect(words("peer_dismiss_failed:timeout")).toContain("거절하지 못했어요");
    expect(words("invalid_peer_mode")).toBe("알 수 없는 다른 세션 메시지 설정이에요.");
    expect(words("peer_unsupported")).toContain("업데이트");
  });
});
