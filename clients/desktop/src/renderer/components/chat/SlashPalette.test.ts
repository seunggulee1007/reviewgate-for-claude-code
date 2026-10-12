/**
 * MARK: wave3 desktop-session — §36.5 the slash palette as it renders (react-dom/server; the store loads with the window
 * mocked as in the other component tests): group headers, the dimmed argument hint, the description line, the skill
 * badge, "Starting session…" and the (cached) foot.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionCapabilities } from "@reviewgate/engine";
import { initI18n } from "../../i18n";
import { slashEntries, slashSections, type PaletteEmptyState, type SlashEntry, type SlashSection } from "../../slashCommands";

type PaletteProps = { sections: SlashSection[]; selection: number; emptyState: PaletteEmptyState | null; cached: boolean; starting: boolean; onPick: (e: SlashEntry) => void };
let SlashPalette: FunctionComponent<PaletteProps>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "darwin" },
  };
  SlashPalette = (await import("./SlashPalette")).SlashPalette as unknown as FunctionComponent<PaletteProps>;
});

const caps: SessionCapabilities = {
  slashCommands: ["mcp", "team-plugin:team-dev"],
  skills: ["team-plugin:team-dev"],
  plugins: ["team-plugin"],
  mcpServers: [],
  state: "ready",
  commands: [
    { name: "mcp", description: "Manage MCP servers", argumentHint: "[reconnect|enable|disable [<server>|all]]", source: "builtin" },
    { name: "team-plugin:team-dev", description: "이슈 기반 개발", argumentHint: "<이슈 번호>", source: "plugin", plugin: "team-plugin" },
  ],
};

const render = (p: Partial<PaletteProps>) =>
  renderToStaticMarkup(createElement(SlashPalette, { sections: [], selection: 0, emptyState: null, cached: false, starting: false, onPick: () => undefined, ...p }));

describe("SlashPalette (§36.5)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  it("groups with headers, each row with its argument hint, description and skill badge", () => {
    const html = render({ sections: slashSections(slashEntries(caps), "", []), selection: 1 });
    expect(html).toContain(">기본<");
    expect(html).toContain(">team-plugin<");
    expect(html).toContain("Manage MCP servers");
    expect(html).toContain("&lt;이슈 번호&gt;");
    expect(html).toContain("이슈 기반 개발");
    expect(html).toContain(">스킬<");
    // the second row (team-plugin:team-dev, in the plugin group after built-in) is the selected one
    expect(html).toMatch(/data-index="1"[^>]*data-testid="Slash team-plugin:team-dev"|aria-selected="true"[^>]*data-index="1"/);
    expect(html).toContain('aria-selected="true"');
  });

  it("a ranked query is one list without a header", () => {
    const html = render({ sections: slashSections(slashEntries(caps), "dev", []) });
    expect(html).not.toContain("slash-head");
    expect(html).toContain('data-testid="Slash team-plugin:team-dev"');
  });

  it("says 'Starting session…' with a spinner while the CLI starts", () => {
    const html = render({ emptyState: "starting" });
    expect(html).toContain('data-testid="Slash palette starting"');
    expect(html).toContain("세션 준비 중…");
    expect(html).toContain("spinner");
  });

  it("a cached list says so in the foot, with 'Starting session…' while it starts", () => {
    const html = render({ sections: slashSections(slashEntries(caps), "", []), cached: true, starting: true });
    expect(html).toContain('data-testid="Slash palette cached"');
    expect(html).toContain("(캐시됨)");
    expect(html).toContain('data-testid="Slash palette starting footer"');
  });
});
