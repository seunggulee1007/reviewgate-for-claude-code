import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UserPermissionRule } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { initI18n } from "./i18n";

// Settings › Permissions rendered to static HTML (the store's initial state object is the scene, as in permissionCards.test.ts).

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "darwin", toolchainInfo: async () => null },
  };
  const { useStore } = await import("./store");
  const { PermissionsTab } = await import("./components/settings/PermissionsTab");
  const { RulesTable } = await import("./components/settings/TerminalRules");
  const { SettingsPanel } = await import("./components/settings/SettingsPanel");
  return { useStore, PermissionsTab, RulesTable, SettingsPanel };
}

/** The opening tag of the element with `testId` (the attribute order is React's, not ours). */
const tag = (out: string, testId: string): string => {
  const at = out.indexOf(`data-testid="${testId}"`);
  if (at < 0) return "";
  const start = out.lastIndexOf("<", at);
  const end = out.indexOf(">", at);
  return out.slice(start, end + 1);
};
const checked = (out: string, testId: string): boolean => tag(out, testId).includes('checked=""');
const disabled = (out: string, testId: string): boolean => tag(out, testId).includes('disabled=""');

const base = { bashAllowPatterns: "Bash(make:*)", projectBashAllowPatterns: {}, permissionMode: "default" } as unknown as AppSettings;

describe("Settings › Permissions (§2.8)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("ko", "darwin");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  const scene = (remembered: string[], settings: AppSettings = base) => {
    const init = m.useStore.getInitialState();
    Object.assign(init, {
      settings,
      state: { ...init.state, project: { path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: null }, session: { ...init.state.session, rememberedAllows: remembered } },
    });
  };

  it("three switches with their defaults (isolation off, terminal rules on, keep-session-allows off)", () => {
    scene([]);
    const out = renderToStaticMarkup(createElement(m.PermissionsTab, { settings: base }));
    expect(out).toContain("격리 worktree 에이전트 허용 (Workflow, isolation)");
    expect(out).toContain("켜도 매번 카드와 경고가 뜹니다 · 다음 세션부터 적용");
    expect(out).toContain("터미널 허용 규칙 적용 (조회·읽기 도구)");
    expect(out).toContain("&#x27;세션 동안 허용&#x27;을 이 worktree에 저장");
    expect(out).toContain("앱을 다시 열어도 유지 · 워크벤치마다 따로");
    expect(checked(out, "Apply user allow rules")).toBe(true);
    expect(checked(out, "Allow worktree isolation")).toBe(false);
    expect(checked(out, "Persist session allows")).toBe(false);
    expect(out).toContain("세션 동안 허용한 항목이 없습니다.");
    expect(disabled(out, "Forget session allows")).toBe(true);
    // the allow patterns now speak of MCP / WebFetch too, and apply at once
    expect(out).toContain("mcp__서버__도구");
    expect(out).toContain("Bash(make:*)");
  });

  it("test 7 (client part): the remembered allows are listed with 모두 지우기", () => {
    const settings = { ...base, persistSessionAllows: true, allowWorktreeIsolation: true, applyUserAllowRules: false };
    scene(["Bash:npm test", "WebFetch:WebFetch"], settings);
    const out = renderToStaticMarkup(createElement(m.PermissionsTab, { settings }));
    expect(out).toContain("Bash:npm test");
    expect(out).toContain("WebFetch:WebFetch");
    expect(out).toContain("모두 지우기");
    expect(checked(out, "Persist session allows")).toBe(true);
    expect(checked(out, "Allow worktree isolation")).toBe(true);
    expect(checked(out, "Apply user allow rules")).toBe(false);
    expect(disabled(out, "Forget session allows")).toBe(false);
  });

  it("the settings dialog opens on the Permissions tab", () => {
    scene([]);
    const out = renderToStaticMarkup(createElement(m.SettingsPanel, { initialTab: "permissions" }));
    expect(out).toContain('data-testid="Settings permissions"');
    expect(out).toContain('class="active" data-testid="Settings Permissions"');
  });

  it("the terminal rules: why in words, a checkbox only where a rule can be imported, ⚠ on risky ones", () => {
    const rules: UserPermissionRule[] = [
      { rule: "mcp__github", source: "user", status: "applied", why: "read_mcp_tools", importAs: "mcp__github__*" },
      { rule: "Bash(rm:*)", source: "project", status: "ignored", why: "bash", importAs: "Bash(rm:*)" },
      { rule: "Edit", source: "local", status: "ignored", why: "edit_tool", importAs: null },
      { rule: "SendMessage", source: "user", status: "ignored", why: "send_message", importAs: null },
    ];
    const out = renderToStaticMarkup(createElement(m.RulesTable, { rules, ticked: { "mcp__github__*": true }, onTick: () => undefined }));
    expect(out).toContain("읽기 도구에만 적용 중");
    expect(out).toContain("명령은 리뷰 게이트가 우선 — 가져오면 이 앱 허용 패턴으로 추가");
    expect(out).toContain("편집은 항상 리뷰");
    expect(out).toContain("다른 세션에 보내는 메시지는 항상 확인");
    expect(out).toContain('data-testid="Import mcp__github__*"');
    expect(out).toContain('data-testid="Import Bash(rm:*)"');
    expect(out).not.toContain('data-testid="Import Edit"');
    expect((out.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect(checked(out, "Import mcp__github__*")).toBe(true);
    expect(checked(out, "Import Bash(rm:*)")).toBe(false);
    expect((out.match(/class="risk-mark"/g) ?? []).length).toBe(1);
    expect(out).toContain("사용자");
    expect(out).toContain("프로젝트");
    expect(out).toContain("로컬");
  });
});
