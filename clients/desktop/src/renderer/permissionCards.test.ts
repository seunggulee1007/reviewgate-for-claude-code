import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionRequest, ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ChatItem } from "./store";

// Cards rendered to static HTML (no DOM in the unit tests): the store is read through zustand's server snapshot,
// i.e. the store's initial state object — the tests put the scene there.

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  const { useStore } = await import("./store");
  const { PermissionCard } = await import("./components/chat/PermissionCard");
  const { QuestionCard } = await import("./components/chat/QuestionCard");
  const { AwaitingPermissionBadge, PermissionHudChip, PeerTurnBadge } = await import("./components/chat/PermissionBits");
  return { useStore, PermissionCard, QuestionCard, AwaitingPermissionBadge, PermissionHudChip, PeerTurnBadge };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const req = (requestId: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ requestId, toolName: "Bash", input: { command: "npm test -- --watch" }, ...extra });

/** The scene: the open requests (oldest first) and an optional peer turn. */
function scene(m: Loaded, pending: PermissionRequest[], extra: Partial<ReviewState["session"]> = {}) {
  const init = m.useStore.getInitialState();
  const state = init.state;
  Object.assign(init, {
    transcript: pending.map((request, i): ChatItem => ({ kind: "permission", id: i + 1, request, allowed: null })),
    state: {
      ...state,
      project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null },
      session: { ...state.session, open: true, pendingPermission: pending[0] ?? null, pendingPermissions: pending, peerTurn: null, ...extra },
      workbenches: { list: [{ path: "/wt/acme-4821", branch: "b", head: "h", isMain: false, isCurrent: false, locked: null, dirty: null }], current: "/repo", managedRoot: "" },
    },
  });
}

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe("permission cards (§2.1)", () => {
  let m: Loaded;
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => scene(m, []));

  it("the oldest open card carries the focus ring and the shortcut hints; a newer one answers by click only", () => {
    scene(m, [req("a"), req("b")]);
    const older = html(createElement(m.PermissionCard, { request: req("a"), decision: null }));
    const newer = html(createElement(m.PermissionCard, { request: req("b"), decision: null }));
    expect(older).toContain('class="perm target"');
    expect(older).toContain("<kbd>⌘↩</kbd>");
    expect(older).toContain("단축키는 가장 오래 기다린 이 카드에 적용됩니다");
    expect(newer).not.toContain("target");
    expect(newer).not.toContain("<kbd>");
    expect(newer).toContain('data-testid="Allow"');
  });

  it("labels the asking agent and the main agent", () => {
    const sub = req("s", { agent: { agentId: "t1", agentToolUseId: "tu1", subagentType: "oh-my-claudecode:executor", description: "컴파일" } });
    scene(m, [req("a"), sub]);
    expect(html(createElement(m.PermissionCard, { request: sub, decision: null }))).toContain("🧩 executor · 컴파일");
    expect(html(createElement(m.PermissionCard, { request: req("a"), decision: null }))).toContain("메인 에이전트");
  });

  it("test 4: a reason card shows the warning line and has no always-allow / session buttons", () => {
    const nested = req("n", { reason: { code: "other_worktree", message: "m", path: "/wt/acme-4821" } });
    scene(m, [nested]);
    const out = html(createElement(m.PermissionCard, { request: nested, decision: null }));
    expect(out).toContain("다른 worktree(wt/acme-4821)의 위치입니다 — 이 창의 리뷰에 잡히지 않습니다");
    expect(out).toContain('data-testid="Open as workbench"');
    expect(out).not.toContain('data-testid="Always allow"');
    expect(out).not.toContain('data-testid="Allow for session"');
    expect(out).toContain('data-testid="Allow"');
    // engine-followup's claude_config (a code the engine types do not list yet) and an unknown one still get a line
    const config = { requestId: "c", toolName: "Edit", input: { file_path: "/repo/.claude/settings.local.json" }, file: "/repo/.claude/settings.local.json", reason: { code: "claude_config", message: "m" } } as unknown as PermissionRequest;
    scene(m, [config]);
    const cfg = html(createElement(m.PermissionCard, { request: config, decision: null }));
    expect(cfg).toContain("Claude Code 설정 파일(.claude/settings.local.json)을 바꿉니다");
    expect(cfg).not.toContain('data-testid="Allow for session"');
    const odd = req("u", { reason: { code: "future_code", message: "ReviewGate: somewhere new" } as unknown as PermissionRequest["reason"] });
    scene(m, [odd]);
    expect(html(createElement(m.PermissionCard, { request: odd, decision: null }))).toContain("ReviewGate: somewhere new");
  });

  it("offers the engine's always-allow choices behind '항상 허용 ▾' (MCP)", () => {
    const mcp: PermissionRequest = { requestId: "m", toolName: "mcp__github__get_issue", input: { id: 1 }, allowPatterns: ["mcp__github__get_issue", "mcp__github__*"] };
    scene(m, [mcp]);
    const out = html(createElement(m.PermissionCard, { request: mcp, decision: null }));
    expect(out).toContain("이 프로젝트에서 항상 허용 ▾");
    expect(out).toContain('data-testid="Allow for session"');
  });

  it("SendMessage: who receives it, the summary and the message — Send / Decline only", () => {
    const sm: PermissionRequest = { requestId: "sm", toolName: "SendMessage", input: { to: "acme-docs", summary: "API 변경 알림", message: "주문 API 응답이 바뀌었어요" } };
    scene(m, [sm]);
    const out = html(createElement(m.PermissionCard, { request: sm, decision: null }));
    expect(out).toContain("받는 세션: acme-docs");
    expect(out).toContain("API 변경 알림");
    expect(out).toContain("주문 API 응답이 바뀌었어요");
    expect(out).toContain('data-testid="SendMessage send"');
    expect(out).toContain('data-testid="SendMessage decline"');
    expect(out).not.toContain("Allow for session");
    expect(out).not.toContain('data-testid="Always allow"');
    expect(out).not.toContain("세션 동안 허용");
  });

  it("test 3: a card whose request left the queue is 'handled' (grey) without buttons", () => {
    scene(m, []);
    const out = html(createElement(m.PermissionCard, { request: req("gone"), decision: null }));
    expect(out).toContain("처리됨");
    expect(out).toContain('class="perm handled"');
    expect(out).not.toContain('data-testid="Allow"');
    const q: ChatItem = { kind: "permission", id: 9, request: { requestId: "q", toolName: "AskUserQuestion", input: { questions: [] } }, allowed: null };
    expect(html(createElement(m.QuestionCard, { item: q as Extract<ChatItem, { kind: "permission" }> }))).toContain("처리됨");
  });

  it("an answered card keeps its decision", () => {
    scene(m, []);
    expect(html(createElement(m.PermissionCard, { request: req("x"), decision: true }))).toContain("허용됨");
    expect(html(createElement(m.PermissionCard, { request: { requestId: "y", toolName: "SendMessage", input: { to: "a", message: "b" } }, decision: false }))).toContain("거절함");
  });

  it("test 29: the peer turn badge on the card and in the HUD; the HUD counts several requests", () => {
    scene(m, [req("a"), req("b")], { peerTurn: { messageIds: ["m1"], fromNames: ["acme-api"] } });
    expect(html(createElement(m.PermissionCard, { request: req("a"), decision: null }))).toContain("acme-api 요청");
    expect(html(createElement(m.PeerTurnBadge))).toContain("acme-api 요청");
    expect(html(createElement(m.PermissionHudChip))).toContain("권한 요청 2개 대기");
    scene(m, [req("a")]);
    expect(html(createElement(m.PermissionHudChip))).toContain("권한 대기 중");
    expect(html(createElement(m.PeerTurnBadge))).toBe("");
    scene(m, []);
    expect(html(createElement(m.PermissionHudChip))).toBe("");
  });

  it("the agent panel marks the agent whose call waits on a card, with a jump to it", () => {
    scene(m, [req("a"), req("b", { agent: { agentId: "t2", agentToolUseId: "tu-2" } })]);
    const out = html(createElement(m.AwaitingPermissionBadge, { agentToolUseId: "tu-2" }));
    expect(out).toContain("권한 대기");
    expect(out).toContain("카드로 이동");
    expect(html(createElement(m.AwaitingPermissionBadge, { agentToolUseId: "tu-9" }))).toBe("");
    expect(html(createElement(m.AwaitingPermissionBadge, { agentToolUseId: null }))).toContain("권한 대기");
    expect(html(createElement(m.AwaitingPermissionBadge, { agentToolUseId: "tu-2", compact: true }))).toContain('aria-label="권한 대기 — 카드로 이동"');
  });
});
