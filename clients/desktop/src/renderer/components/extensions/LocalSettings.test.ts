/**
 * MARK: wave3 desktop-session — §36.6 "Applied extensions" as it renders (react-dom/server, the view fed with props): the
 * per-project switch, Loaded / Off, the older-engine reason and "Not applied in the app" (MCP scope local: sessionTools.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewState, SessionExtensions } from "@reviewgate/engine";
import { initI18n } from "../../i18n";
import * as sessionTools from "../../sessionTools";

type ViewProps = import("./LocalSettings").LocalSettingsViewProps;
let LocalSettingsView: FunctionComponent<ViewProps>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  LocalSettingsView = (await import("./LocalSettings")).LocalSettingsView;
  initI18n("ko", "darwin");
});
afterAll(() => initI18n("en", "darwin"));

const ext = (more: Partial<SessionExtensions> = {}): SessionExtensions => ({
  settingSources: ["user", "project"],
  fallback: null,
  plugins: [],
  disabledPlugins: [],
  unresolvedDisabledPlugins: [],
  userHooksDisabled: false,
  skills: [],
  slashCommands: [],
  mcpServers: [],
  memoryFiles: null,
  claudeMd: { user: true, project: false, source: "cli" },
  hooks: [],
  ...more,
});

/** The `<input …>` tag with `data-testid="<id>"` (attribute order is React's). */
const tag = (html: string, id: string): string => new RegExp(`<input[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";

/** The view as the connected section feeds it (a server render reads the store's initial state, so props are given). */
function show(e: SessionExtensions, more: Partial<ViewProps> = {}) {
  const { knowsSessionTools } = sessionTools;
  const supported = knowsSessionTools({ open: true, starting: false, extensions: e } as unknown as ReviewState["session"]);
  return renderToStaticMarkup(createElement(LocalSettingsView, { ext: e, wanted: true, supported, hasProject: true, starting: false, onToggle: () => undefined, onRetry: () => undefined, ...more }));
}

describe("Load local settings (§36.6)", () => {
  it("a §36 session that loaded them: the switch is on, 'Loaded', nothing listed as not applied", () => {
    const html = show(ext({ settingSources: ["user", "project", "local"], notApplied: null }));
    expect(html).toContain("로컬 설정 불러오기(settings.local.json)");
    expect(tag(html, "Load local settings")).toContain('checked=""');
    expect(tag(html, "Load local settings")).not.toContain("disabled");
    expect(html).toContain("✓ 로드됨");
    expect(html).not.toContain('data-testid="Not applied in the app"');
    expect(html).not.toContain('data-testid="Load local settings unavailable"');
  });

  it("off for the project: the switch is off and 'Not applied in the app' lists hooks, env keys, local MCP servers and the allow count", () => {
    const html = show(
      ext({ notApplied: { hooks: [{ event: "Stop", command: "~/bin/on-stop.sh" }], envKeys: ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], mcpServers: ["notes", "serena"], allowRuleCount: 42 } }),
      { wanted: false },
    );
    expect(tag(html, "Load local settings")).not.toContain("checked");
    expect(html).toContain("꺼짐");
    expect(html).toContain("앱에서 적용 안 된 설정");
    expect(html).toContain("이 프로젝트는 로컬 설정이 꺼져 있습니다.");
    expect(html).toContain("~/bin/on-stop.sh");
    expect(html).toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
    expect(html).toContain("notes, serena");
    expect(html).toContain("허용 규칙 42개");
    expect(html).toContain('data-testid="Load local settings now"');
  });

  it("after the §16 fallback the block says so and offers 'Retry with extensions'", () => {
    const html = show(ext({ fallback: { reason: "init_timeout", timeoutMs: 45000, at: "2026-10-23T00:00:00Z" }, notApplied: { hooks: [], envKeys: [], mcpServers: ["serena"], allowRuleCount: 0 } }));
    expect(html).toContain("확장이 제때 시작되지 않아");
    expect(html).toContain("확장 켜고 다시 시도");
    expect(html).not.toContain('data-testid="Load local settings now"');
  });

  it("an engine before §36: the switch is off with the one-line reason", () => {
    const html = show(ext());
    expect(tag(html, "Load local settings")).toContain('disabled=""');
    expect(html).toContain("이 엔진은 아직 지원하지 않습니다 — ReviewGate를 업데이트하세요");
    expect(html).not.toContain('data-testid="Local settings applied"');
  });
});
