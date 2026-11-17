// docs/PROTOCOL.md §56.4 on Windows: `/mcp` over the composer, as in the terminal — the parsing, the filter, what Enter /
// Alt+Enter do per status, why an action cannot run, a typed name over the selection, and the palette entry.
// Mac: McpPaletteTests.swift.
import { beforeAll, describe, expect, it } from "vitest";
import type { McpServerInfo } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import {
  MCP_NAME,
  actionTitle,
  commandFilter,
  completing,
  disabledReason,
  isAll,
  mcpDescription,
  mcpRows,
  mcpTarget,
  noServerText,
  parseMcpCommand,
  primaryAction,
  rowStatus,
  toggleAction,
  unavailableReason,
} from "./mcpPalette";
import { slashEntries } from "./slashCommands";

const server = (name: string, status: McpServerInfo["status"], extra: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name,
  status,
  scope: null,
  source: "project",
  transport: "stdio",
  toolCount: status === "connected" ? 2 : null,
  tools: [],
  error: null,
  serverInfo: null,
  config: null,
  disabledByUser: false,
  sessionAdded: false,
  ...extra,
});

const servers = [server("acme-docs", "connected"), server("tickets", "needs-auth"), server("docs-search", "failed"), server("Archive", "connected", { disabledByUser: true })];
const live = { sessionOpen: true };

beforeAll(() => initI18n("en", "win32"));

describe("§56.4 /mcp — the command", () => {
  it("is /mcp followed by a space or nothing, any case, one line; a whole verb runs", () => {
    expect(parseMcpCommand("/mcp")).toEqual({ kind: "list", filter: "" });
    expect(parseMcpCommand("  /MCP  ")).toEqual({ kind: "list", filter: "" });
    expect(parseMcpCommand("/mcp acme")).toEqual({ kind: "list", filter: "acme" });
    expect(parseMcpCommand("/mcp reconnect acme-docs")).toEqual({ kind: "run", verb: "reconnect", name: "acme-docs" });
    expect(parseMcpCommand("/mcp Enable  tickets ")).toEqual({ kind: "run", verb: "enable", name: "tickets" });
    expect(parseMcpCommand("/mcp disable")).toEqual({ kind: "run", verb: "disable", name: "" });
    expect(parseMcpCommand("/mcp re")).toEqual({ kind: "list", filter: "re" });
    expect(parseMcpCommand("/mcpx")).toBeNull();
    expect(parseMcpCommand("/mcp__acme-docs__search")).toBeNull();
    expect(parseMcpCommand("please /mcp")).toBeNull();
    expect(parseMcpCommand("/mcp reconnect acme\nand more")).toBeNull();
  });

  it("`all` is every server; Tab completes the name and keeps the verb", () => {
    const all = parseMcpCommand("/mcp disable ALL")!;
    expect(isAll(all)).toBe(true);
    expect(commandFilter(all)).toBe("");
    expect(isAll(parseMcpCommand("/mcp disable allegro")!)).toBe(false);
    expect(completing({ kind: "list", filter: "ac" }, "acme-docs")).toBe("/mcp acme-docs");
    expect(completing({ kind: "run", verb: "reconnect", name: "ac" }, "acme-docs")).toBe("/mcp reconnect acme-docs");
  });
});

describe("§56.4 /mcp — the list", () => {
  it("filters by name, names starting with it first, any case", () => {
    expect(mcpRows(servers, "").map((s) => s.name)).toEqual(["acme-docs", "Archive", "docs-search", "tickets"]);
    expect(mcpRows(servers, "DOCS").map((s) => s.name)).toEqual(["docs-search", "acme-docs"]);
    expect(mcpRows(servers, "nothing")).toEqual([]);
  });

  it("Enter reconnects, logs in to a server that needs it, turns on one that is off; Alt+Enter turns on / off", () => {
    const by = (n: string) => servers.find((s) => s.name === n)!;
    expect(primaryAction(by("acme-docs"))).toBe("reconnect");
    expect(primaryAction(by("docs-search"))).toBe("reconnect");
    expect(primaryAction(by("tickets"))).toBe("login");
    expect(primaryAction(by("Archive"))).toBe("enable");
    expect(toggleAction(by("acme-docs"))).toBe("disable");
    expect(toggleAction(by("Archive"))).toBe("enable");
    expect(actionTitle("login")).toBe("Log in…");
    expect(rowStatus(by("Archive"), false)).toBe("off");
    expect(rowStatus(by("acme-docs"), true)).toBe("Working…");
  });

  it("says why an action cannot run — the session, a busy row, on / off where it already is", () => {
    const by = (n: string) => servers.find((s) => s.name === n)!;
    expect(disabledReason("reconnect", by("acme-docs"), false, live)).toBeNull();
    expect(disabledReason("reconnect", by("Archive"), false, live)).toContain("Alt+Enter"); // the Windows key
    expect(disabledReason("enable", by("acme-docs"), false, live)).not.toBeNull();
    expect(disabledReason("disable", by("Archive"), false, live)).not.toBeNull();
    expect(disabledReason("login", by("tickets"), true, live)).toContain("tickets");
    const stopped = { sessionOpen: false };
    expect(disabledReason("reconnect", by("acme-docs"), false, stopped)).toBe(unavailableReason(stopped));
    expect(unavailableReason(live)).toBeNull();
  });

  it("a typed name wins over the selection; none matching says so", () => {
    const rows = mcpRows(servers, "");
    expect(mcpTarget("TICKETS", rows, 0)?.name).toBe("tickets");
    expect(mcpTarget("", rows, 2)?.name).toBe("docs-search");
    expect(mcpTarget("", rows, 99)?.name).toBe("tickets");
    expect(mcpTarget("gone", [], 0)).toBeNull();
    expect(noServerText("gone")).toContain("“gone”");
  });

  it("the palette always lists /mcp as Built-in with the app's words", () => {
    const entries = slashEntries({ slashCommands: ["compact"], skills: [], plugins: [], mcpServers: [] });
    expect(entries.find((e) => e.name === MCP_NAME)).toMatchObject({ description: mcpDescription(), group: { kind: "builtin" } });
  });
});
