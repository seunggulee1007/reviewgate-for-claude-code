/**
 * §56.4 the `/mcp` list as it renders (react-dom/server; the store loads with the window mocked as in the other component
 * tests): a row per server with its origin, tool count, status and buttons, the busy spinner, the reasons a button is off,
 * the filter's "No server matches", and "No MCP servers" with Add server….
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { McpServerInfo } from "@reviewgate/engine";
import { initI18n } from "../../i18n";
import type { McpCommand } from "../../mcpPalette";

type Props = {
  command: McpCommand;
  rows: McpServerInfo[];
  total: number;
  loaded: boolean;
  selection: number;
  busy: Record<string, unknown>;
  ctx: { sessionOpen: boolean };
  error: string | null;
  onSelect: (i: number) => void;
  onAction: () => void;
  onOpenConfig: () => void;
  onRefresh: () => void;
  onDismissError: () => void;
  onAddServer: () => void;
};
let McpPalette: FunctionComponent<Props>;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: { type: "result", ok: true } }), setSettings: async () => ({}), notify: async () => true, onEvent: () => () => undefined, platform: "win32" },
  };
  initI18n("en", "win32");
  McpPalette = (await import("./McpPalette")).McpPalette as unknown as FunctionComponent<Props>;
});

const server = (name: string, status: McpServerInfo["status"], extra: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name, status, scope: null, source: "project", transport: "stdio", toolCount: null, tools: [], error: null, serverInfo: null, config: null,
  disabledByUser: false, sessionAdded: false, ...extra,
});

const noop = () => undefined;
const render = (p: Partial<Props>) =>
  renderToStaticMarkup(createElement(McpPalette, {
    command: { kind: "list", filter: "" }, rows: [], total: 0, loaded: true, selection: 0, busy: {}, ctx: { sessionOpen: true }, error: null,
    onSelect: noop, onAction: noop, onOpenConfig: noop, onRefresh: noop, onDismissError: noop, onAddServer: noop, ...p,
  }));

describe("McpPalette (§56.4)", () => {
  it("a row per server: origin, tools, status and its Enter action; the selected one is marked", () => {
    const rows = [
      server("acme-docs", "connected", { toolCount: 2, origin: { file: "/work/acme/.mcp.json", place: "project", removable: true } as McpServerInfo["origin"] }),
      server("tickets", "needs-auth", { source: "user" }),
      server("archive", "connected", { disabledByUser: true }),
    ];
    const html = render({ rows, total: 3, selection: 1 });
    expect(html).toContain('data-testid="MCP palette acme-docs"');
    expect(html).toContain("2 MCP tools");
    expect(html).toContain(">project<");
    expect(html).toContain(">Reconnect<");
    expect(html).toContain(">Log in…<");
    expect(html).toContain(">Turn On<");
    expect(html).toMatch(/aria-selected="true"[^>]*data-index="1"/);
    // The Windows keys in the tooltips and the foot.
    expect(html).toContain("Reconnect (Enter)");
    expect(html).toContain("Alt+Enter on/off");
    expect(html).toContain("Ctrl+Enter config file");
    // No known file: Open Config File is off with the reason.
    expect(html).toMatch(/disabled=""[^>]*title="ReviewGate does not know which file defines this server"/);
  });

  it("a busy row shows its spinner and waits; a stopped session says why on every button", () => {
    const busy = render({ rows: [server("acme-docs", "connected")], total: 1, busy: { "acme-docs": "reconnect" } });
    expect(busy).toContain("spinner");
    expect(busy).toContain("Working…");
    expect(busy).toContain("wait for it to finish");
    const stopped = render({ rows: [server("acme-docs", "connected")], total: 1, ctx: { sessionOpen: false } });
    expect(stopped).toContain("The session is not running");
  });

  it("no match for the filter, no servers at all (Add server…), and loading", () => {
    expect(render({ command: { kind: "list", filter: "zzz" }, total: 2 })).toContain("No server matches “zzz”");
    const none = render({ total: 0 });
    expect(none).toContain("No MCP servers");
    expect(none).toContain('data-testid="MCP palette add server"');
    expect(render({ total: 0, loaded: false })).toContain("Loading MCP servers…");
    expect(render({ total: 0, error: "MCP server failed" })).toContain('data-testid="MCP palette error"');
  });
});
