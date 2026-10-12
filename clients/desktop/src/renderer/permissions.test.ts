import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PermissionRequest, WorkbenchInfo } from "@reviewgate/engine";
import { EngineRefusal, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { initI18n } from "./i18n";
import {
  agentChipText,
  allowPatternLabel,
  alwaysAllowChoices,
  canAllowBeyondOnce,
  hudPermissionText,
  isPermissionPending,
  markPermissionRow,
  peerTurnText,
  pendingPermissionsOf,
  permissionCardStatus,
  reasonView,
  requestsWithoutRow,
  requestWaitingFor,
  sessionWithoutRequest,
  sessionWithRequest,
  shortcutTargetId,
  shortPath,
  workbenchAt,
} from "./permissionQueue";
import { importPatch, isRiskyImport, modeSuggestion, ruleScopeText, ruleSourceStatus, ruleWhyText } from "./terminalRules";
import type { ChatItem } from "./store";

const req = (requestId: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ requestId, toolName: "Bash", input: { command: `echo ${requestId}` }, ...extra });
const session = (list: PermissionRequest[] | undefined, single: PermissionRequest | null = list?.[0] ?? null) => ({ pendingPermission: single, ...(list ? { pendingPermissions: list } : {}) });

// ---------------------------------------------------------------- queue

describe("§33.1 permission queue", () => {
  it("lists the open requests oldest first; an engine without the queue gives its single slot", () => {
    const a = req("a");
    const b = req("b");
    expect(pendingPermissionsOf({ session: session([a, b]) })).toEqual([a, b]);
    expect(pendingPermissionsOf({ session: session(undefined, a) })).toEqual([a]);
    expect(pendingPermissionsOf({ session: session(undefined, null) })).toEqual([]);
    expect(isPermissionPending({ session: session([a, b]) }, "b")).toBe(true);
    expect(isPermissionPending({ session: session([a]) }, "b")).toBe(false);
  });

  it("aims the shortcuts at the request that has waited longest", () => {
    expect(shortcutTargetId({ session: session([req("old"), req("new")]) })).toBe("old");
    expect(shortcutTargetId({ session: session([]) })).toBeNull();
  });

  it("a request event queues at the end without replacing the oldest (the P0 of M1)", () => {
    const a = req("a");
    const b = req("b", { agent: { agentId: "t2", agentToolUseId: "tu2" } });
    const s1 = sessionWithRequest(session([a]), b);
    expect(s1.pendingPermissions!.map((p) => p.requestId)).toEqual(["a", "b"]);
    expect(s1.pendingPermission!.requestId).toBe("a");
    // the same id again (snapshot first, then the event) refreshes in place
    const s2 = sessionWithRequest(s1, { ...b, input: { command: "x" } });
    expect(s2.pendingPermissions!.map((p) => p.requestId)).toEqual(["a", "b"]);
    expect(s2.pendingPermissions![1]!.input).toEqual({ command: "x" });
    // an older engine (no list): the slot is still the first
    const s3 = sessionWithRequest(session(undefined, a), b);
    expect(s3.pendingPermission!.requestId).toBe("a");
  });

  it("answering takes exactly that request off; the next oldest becomes the slot", () => {
    const s = session([req("a"), req("b"), req("c")]);
    const after = sessionWithoutRequest(s, "b");
    expect(after.pendingPermissions!.map((p) => p.requestId)).toEqual(["a", "c"]);
    expect(after.pendingPermission!.requestId).toBe("a");
    const first = sessionWithoutRequest(after, "a");
    expect(first.pendingPermission!.requestId).toBe("c");
    expect(sessionWithoutRequest(first, "zzz")).toBe(first);
  });

  it("card states: active while open, decided when answered here, handled when it left the queue otherwise", () => {
    expect(permissionCardStatus(null, true)).toBe("active");
    expect(permissionCardStatus(true, false)).toBe("decided");
    expect(permissionCardStatus(false, true)).toBe("decided");
    expect(permissionCardStatus(null, false)).toBe("handled");
  });
});

describe("§33.1 transcript rows of permission cards", () => {
  const rows = (): ChatItem[] => [
    { kind: "permission", id: 1, request: req("a"), allowed: null },
    { kind: "user", id: 2, text: "hi" },
    { kind: "permission", id: 3, request: req("b"), allowed: null },
  ];

  it("marks only the named row and can undo it", () => {
    const marked = markPermissionRow(rows(), "b", true);
    expect(marked.map((r) => (r.kind === "permission" ? r.allowed : "-"))).toEqual([null, "-", true]);
    const cleared = markPermissionRow(markPermissionRow(rows(), "a", true, { q: "green" }), "a", null);
    expect(cleared[0]).toEqual({ kind: "permission", id: 1, request: req("a"), allowed: null });
    const items = rows();
    expect(markPermissionRow(items, "nope", true)).toBe(items);
  });

  it("finds open requests that have no card yet (reload / reconnect)", () => {
    expect(requestsWithoutRow(rows(), [req("a"), req("c")]).map((p) => p.requestId)).toEqual(["c"]);
    expect(requestsWithoutRow(rows(), [])).toEqual([]);
  });
});

// ---------------------------------------------------------------- card words

describe("permission card words (§2.1)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("labels the asking agent", () => {
    expect(agentChipText({})).toBe("메인 에이전트");
    expect(agentChipText({ agent: { agentId: "t1", agentToolUseId: "tu1", subagentType: "oh-my-claudecode:executor", description: "컴파일" } })).toBe("🧩 executor · 컴파일");
    expect(agentChipText({ agent: { agentId: "t1" } })).toBe("🧩 서브에이전트");
  });

  it("badges a peer turn with the senders (§29)", () => {
    expect(peerTurnText({ peerTurn: null })).toBeNull();
    expect(peerTurnText({})).toBeNull();
    expect(peerTurnText({ peerTurn: { messageIds: ["m1"], fromNames: ["acme-api", "docs"] } })).toBe("acme-api, docs 요청");
    expect(peerTurnText({ peerTurn: { messageIds: ["m1"], fromNames: [] } })).toBe("다른 세션 요청");
  });

  it("words every reason, shortens the path, and falls back to the engine text for an unknown code", () => {
    expect(shortPath("/Users/me/repo/.claude/worktrees/x")).toBe("worktrees/x");
    expect(shortPath("C:\\work\\repo\\sub")).toBe("repo/sub");
    expect(shortPath("a")).toBe("a");
    expect(reasonView(undefined)).toBeNull();
    const outside = reasonView({ code: "outside_project", message: "m" });
    expect(outside).toMatchObject({ tone: "orange", text: "프로젝트 밖 파일입니다 — 리뷰에 잡히지 않습니다" });
    expect(reasonView({ code: "nested_repository", message: "m", path: "/r/.claude/worktrees/x" })!.text).toBe("중첩 저장소(서브모듈·worktree·clone) 안입니다 — 리뷰에 잡히지 않습니다 (worktrees/x)");
    expect(reasonView({ code: "other_worktree", message: "m", path: "/w/acme-4821" })!.text).toBe("다른 worktree(w/acme-4821)의 위치입니다 — 이 창의 리뷰에 잡히지 않습니다");
    expect(reasonView({ code: "worktree_command", message: "m", path: "/r/../wt" })).toMatchObject({ tone: "red" });
    expect(reasonView({ code: "worktree_isolation", message: "m" })!.text).toContain("격리 worktree");
    // engine-followup adds claude_config: the path comes from the reason, else the edit's file
    const config = reasonView({ code: "claude_config", message: "m" }, "/repo/.claude/settings.local.json")!;
    expect(config.text).toBe("Claude Code 설정 파일(.claude/settings.local.json)을 바꿉니다 — 훅·권한·MCP 설정이 바뀌며, settings.local.json 은 리뷰에 남지 않아 되돌릴 수 없습니다");
    expect(config.tone).toBe("red");
    expect(reasonView({ code: "brand_new", message: "ReviewGate: something new" })).toMatchObject({ text: "ReviewGate: something new", tone: "orange" });
  });

  it("offers always-allow only without a reason and never for SendMessage; engine patterns win over the Bash one", () => {
    expect(canAllowBeyondOnce({ toolName: "Bash" })).toBe(true);
    expect(canAllowBeyondOnce({ toolName: "SendMessage" })).toBe(false);
    expect(canAllowBeyondOnce({ toolName: "Edit", reason: { code: "nested_repository", message: "m" } })).toBe(false);
    expect(alwaysAllowChoices({ toolName: "mcp__github__get_issue", allowPatterns: ["mcp__github__get_issue", "mcp__github__*"] }, null)).toEqual(["mcp__github__get_issue", "mcp__github__*"]);
    expect(alwaysAllowChoices({ toolName: "Bash" }, "Bash(npm test:*)")).toEqual(["Bash(npm test:*)"]);
    expect(alwaysAllowChoices({ toolName: "Bash", reason: { code: "other_worktree", message: "m" } }, "Bash(make:*)")).toEqual([]);
    expect(alwaysAllowChoices({ toolName: "SendMessage" }, null)).toEqual([]);
    expect(alwaysAllowChoices({ toolName: "WebFetch" }, null)).toEqual([]);
  });

  it("words the always-allow choices", () => {
    expect(allowPatternLabel("mcp__github__get_issue")).toBe("이 도구만 (get_issue)");
    expect(allowPatternLabel("mcp__github__*")).toBe("github 서버 전체");
    expect(allowPatternLabel("mcp__claude_ai_Claude_Docs__batch")).toBe("이 도구만 (batch)");
    expect(allowPatternLabel("mcp__github")).toBe("github 서버 전체");
    expect(allowPatternLabel("WebFetch(domain:docs.spring.io)")).toBe("이 도메인 (docs.spring.io)");
    expect(allowPatternLabel("WebSearch")).toBe("WebSearch");
    expect(allowPatternLabel("Bash(npm test:*)")).toBe("Bash(npm test:*)");
  });

  it("matches agents waiting for permission and the HUD count", () => {
    const pending = [req("a"), req("b", { agent: { agentId: "t2", agentToolUseId: "tu-2" } })];
    expect(requestWaitingFor(pending, "tu-2")?.requestId).toBe("b");
    expect(requestWaitingFor(pending, "tu-9")).toBeNull();
    expect(hudPermissionText(0)).toBeNull();
    expect(hudPermissionText(1)).toBe("권한 대기 중");
    expect(hudPermissionText(3)).toBe("권한 요청 3개 대기");
  });

  it("words the unknown_permission_request refusal (shown as a toast, never a red banner)", () => {
    expect(refusalMessage(refusalOf(new EngineRefusal("unknown_permission_request", "unknown_permission_request")))).toBe("이미 처리된 권한 요청입니다");
  });

  it("finds the workbench a reason path opens as (never this window's)", () => {
    const wb = (path: string, isCurrent = false): WorkbenchInfo => ({ path, branch: "b", head: "h", isMain: false, isCurrent, locked: null, dirty: null });
    const list = [wb("/repo", true), wb("/wt/acme-4821"), wb("C:\\Work\\Repo-2")];
    expect(workbenchAt(list, "/wt/acme-4821/")?.path).toBe("/wt/acme-4821");
    expect(workbenchAt(list, "c:/work/repo-2")?.path).toBe("C:\\Work\\Repo-2");
    expect(workbenchAt(list, "/repo")).toBeNull();
    expect(workbenchAt(list, undefined)).toBeNull();
    expect(workbenchAt(list, "/elsewhere")).toBeNull();
  });
});

// ---------------------------------------------------------------- terminal allow rules (§33.8)

describe("§33.8 terminal allow rules", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("words every why, scope and source state", () => {
    const whys = ["non_mutating_tool", "read_mcp_tool", "read_mcp_tools", "already_allowed", "mutating_mcp_tool", "bash", "edit_tool", "send_message", "unsupported", "invalid", "rules_off", "user_settings_off", "local_settings_off"];
    for (const why of whys) expect(ruleWhyText(why)).toMatch(/[가-힣]/);
    expect(ruleWhyText("local_settings_off")).toBe("로컬 설정 불러오기가 꺼져 있음"); // §36.6, the Mac's key
    expect(ruleWhyText("non_mutating_tool")).toBe("적용 중 — 파일을 바꾸지 않는 도구");
    expect(ruleWhyText("bash")).toBe("명령은 리뷰 게이트가 우선 — 가져오면 이 앱 허용 패턴으로 추가");
    expect(ruleWhyText("something_new")).toBe("something_new");
    expect(ruleScopeText("user")).toBe("사용자");
    expect(ruleScopeText("project")).toBe("프로젝트");
    expect(ruleScopeText("local")).toBe("로컬");
    expect(ruleSourceStatus({ exists: false })).toBe("없음");
    expect(ruleSourceStatus({ exists: true, error: "Unexpected token" })).toBe("읽기 오류: Unexpected token");
    expect(ruleSourceStatus({ exists: true })).toBe("읽음");
  });

  it("flags risky imports: deleting / pushing / globbing Bash and MCP tools that write", () => {
    expect(isRiskyImport({ importAs: "Bash(rm:*)", why: "bash" })).toBe(true);
    expect(isRiskyImport({ importAs: "Bash(git push:*)", why: "bash" })).toBe(true);
    expect(isRiskyImport({ importAs: "Bash(git *)", why: "bash" })).toBe(true);
    expect(isRiskyImport({ importAs: "Bash(sudo make:*)", why: "bash" })).toBe(true);
    expect(isRiskyImport({ importAs: "Bash(./gradlew:*)", why: "bash" })).toBe(false);
    expect(isRiskyImport({ importAs: "Bash(npm test:*)", why: "bash" })).toBe(false);
    expect(isRiskyImport({ importAs: "mcp__jira__create_issue", why: "mutating_mcp_tool" })).toBe(true);
    expect(isRiskyImport({ importAs: "mcp__github__*", why: "read_mcp_tools" })).toBe(false);
    expect(isRiskyImport({ importAs: null, why: "edit_tool" })).toBe(false);
  });

  it("imports the ticked patterns into the global or this project's list (deduplicated)", () => {
    const settings = { bashAllowPatterns: "Bash(make:*)\n", projectBashAllowPatterns: { "0badc0de": "Bash(x:*)" } };
    const g = importPatch(settings, ["Bash(make:*)", "mcp__github__*", " mcp__github__* "], "global", null)!;
    expect(g.patch).toEqual({ bashAllowPatterns: "Bash(make:*)\nmcp__github__*" });
    expect(g.added).toBe(1);
    const p = importPatch(settings, ["WebFetch(domain:docs.spring.io)"], "project", "/repo")!;
    const map = p.patch.projectBashAllowPatterns!;
    expect(map["0badc0de"]).toBe("Bash(x:*)");
    expect(Object.values(map)).toContain("WebFetch(domain:docs.spring.io)");
    expect(p.added).toBe(1);
    expect(importPatch(settings, [], "global", null)).toBeNull();
    expect(importPatch(settings, ["a"], "project", null)).toBeNull();
  });

  it("suggests the terminal's default mode once: supported, different, not declined", () => {
    const rules = (defaultMode: string | null, defaultModeSupported = true) => ({ defaultMode, defaultModeSupported });
    expect(modeSuggestion(rules("acceptEdits"), "default", "default", [])).toBe("acceptEdits");
    expect(modeSuggestion(rules("acceptEdits"), "acceptEdits", "default", [])).toBeNull();
    expect(modeSuggestion(rules("acceptEdits"), "default", "acceptEdits", [])).toBeNull();
    expect(modeSuggestion(rules("acceptEdits"), "default", "default", ["acceptEdits"])).toBeNull();
    expect(modeSuggestion(rules("bypassPermissions", false), "default", "default", [])).toBeNull();
    expect(modeSuggestion(rules("weird", true), "default", "default", [])).toBeNull();
    expect(modeSuggestion(rules(null), "default", "default", [])).toBeNull();
  });
});
