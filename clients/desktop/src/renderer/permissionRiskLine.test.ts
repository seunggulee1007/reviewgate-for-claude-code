import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionRequest } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import type { ChatItem } from "./store";

// wave2 check-clients — a §33.3 reason card ("…안입니다 — 리뷰에 잡히지 않습니다", red) also drew the calm line
// "✓ 위험 신호 없음 — 프로젝트 안에서 실행, 네트워크·삭제 없음" right below it: the card said both "outside this window's
// review" and "all clear, inside the project". The calm line is left out there; real risk flags still show.

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  const { useStore } = await import("./store");
  const { PermissionCard } = await import("./components/chat/PermissionCard");
  return { useStore, PermissionCard };
}
type Loaded = Awaited<ReturnType<typeof load>>;

function scene(m: Loaded, pending: PermissionRequest[]) {
  const init = m.useStore.getInitialState();
  const state = init.state;
  Object.assign(init, {
    transcript: pending.map((request, i): ChatItem => ({ kind: "permission", id: i + 1, request, allowed: null })),
    state: { ...state, project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null }, session: { ...state.session, open: true, pendingPermission: pending[0] ?? null, pendingPermissions: pending, peerTurn: null } },
  });
}

const render = (m: Loaded, request: PermissionRequest) => {
  scene(m, [request]);
  return renderToStaticMarkup(createElement(m.PermissionCard, { request, decision: null }));
};

describe("permission card risk line next to a §33.3 reason", () => {
  let m: Loaded;
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));
  beforeEach(() => scene(m, []));

  it("a reason card never says 'no risk signals — inside the project'", () => {
    const file = "/repo/.claude/worktrees/wt1/src/A.java";
    const nested: PermissionRequest = { requestId: "n", toolName: "Edit", input: { file_path: file, old_string: "a", new_string: "b" }, file, reason: { code: "nested_repository", message: "m", path: "/repo/.claude/worktrees/wt1" } };
    const out = render(m, nested);
    expect(out).toContain('data-testid="Permission reason"');
    expect(out).not.toContain("위험 신호 없음");
    expect(out).not.toContain('data-testid="Permission risk"');
  });

  it("real risk flags still show on a reason card; a card without a reason keeps the calm line", () => {
    const risky: PermissionRequest = { requestId: "r", toolName: "Bash", input: { command: "cd .claude/worktrees/wt1 && rm -rf build" }, reason: { code: "nested_repository", message: "m", path: "/repo/.claude/worktrees/wt1" } };
    const out = render(m, risky);
    expect(out).toContain('data-testid="Permission risk"');
    expect(out).toContain("파일 삭제");
    const plain: PermissionRequest = { requestId: "p", toolName: "Bash", input: { command: "npm test" } };
    expect(render(m, plain)).toContain("위험 신호 없음");
  });

  it("a call the check cannot read (an MCP tool) is not called 'no network, deletes nothing' — the Mac's neutral words", () => {
    // Next to "이 프로젝트에서 항상 허용 ▾" (the whole MCP server) the card claimed the call has no network access.
    const mcp: PermissionRequest = { requestId: "m", toolName: "mcp__github__get_issue", input: { issue_number: "200" }, allowPatterns: ["mcp__github__get_issue", "mcp__github__*"] };
    const out = render(m, mcp);
    expect(out).toContain('data-testid="Permission risk"');
    expect(out).toContain("위험 패턴 없음");
    expect(out).not.toContain("네트워크·삭제 없음");
    // An edit inside the project keeps the full sentence (its path was checked).
    const edit: PermissionRequest = { requestId: "e", toolName: "Edit", input: { file_path: "/repo/src/A.java" }, file: "/repo/src/A.java" };
    expect(render(m, edit)).toContain("위험 신호 없음 — 프로젝트 안에서 실행, 네트워크·삭제 없음");
  });
});
