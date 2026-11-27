// docs/PROTOCOL.md §72.3: `/plugin` and `/reload-plugins` — a typed subcommand, the words, the reload's summary. As Core
// PluginManagerTests on the Mac.
import { beforeAll, describe, expect, it } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { marketplaceLocation, parsePluginRequest, pluginActionConfirms, pluginManageBlocker, reloadedText, reloadPluginsBlocker } from "./pluginManager";
import { appCommandDescription, parseSlashAppCommand, TERMINAL_ONLY } from "./slashAppCommands";

beforeAll(() => initI18n("en", "win32"));

describe("§72.3 /plugin", () => {
  it("reads a typed subcommand as the terminal's session forms", () => {
    expect(parsePluginRequest("")).toEqual({ tab: "discover" });
    expect(parsePluginRequest("install deploy@acme-market")).toEqual({ tab: "discover", action: "install", target: "deploy@acme-market" });
    expect(parsePluginRequest("install")).toEqual({ tab: "discover" });
    expect(parsePluginRequest("manage")).toEqual({ tab: "installed" });
    expect(parsePluginRequest("enable fmt")).toEqual({ tab: "installed", action: "enable", target: "fmt" });
    expect(parsePluginRequest("uninstall fmt@acme-market")).toEqual({ tab: "installed", action: "uninstall", target: "fmt@acme-market" });
    expect(parsePluginRequest("marketplace")).toEqual({ tab: "marketplaces" });
    expect(parsePluginRequest("market add acme/plugins")).toEqual({ tab: "marketplaces", action: "marketplace_add", target: "acme/plugins" });
    expect(parsePluginRequest("marketplace rm acme-market")).toEqual({ tab: "marketplaces", action: "marketplace_remove", target: "acme-market" });
    expect(parsePluginRequest("validate .").unknown).toBe("validate");
    expect(pluginActionConfirms("install") && pluginActionConfirms("marketplace_remove") && !pluginActionConfirms("enable")).toBe(true);
  });

  it("says what cannot be managed here, and where a marketplace comes from", () => {
    const base = { id: "x@m", name: "x", marketplace: "m", version: "1", enabled: true, installPath: "C:\\p" };
    expect(pluginManageBlocker({ ...base, scope: "managed" })).toBe("Your organization manages this plugin");
    expect(pluginManageBlocker({ ...base, scope: "session" })).toBe("Loaded for this session only (--plugin-dir)");
    expect(pluginManageBlocker({ ...base, scope: "user" })).toBeNull();
    expect(marketplaceLocation({ name: "acme", source: "github", repo: "acme/plugins", ref: "v1" })).toBe("acme/plugins#v1");
    expect(marketplaceLocation({ name: "dev", source: "directory", path: "C:\\work\\market" })).toBe("C:\\work\\market");
  });

  it("the reload's summary as the terminal's, or why it was held", () => {
    expect(reloadedText({ applied: true, held: false, plugins: 2, skills: 5, agents: 4, hooks: 3, mcpServers: 1, errors: 0 })).toBe("Reloaded: 2 plugins · 5 skills · 4 agents · 3 hooks · 1 plugin MCP servers");
    expect(reloadedText({ applied: true, held: false, plugins: 1, skills: 0, agents: 0, hooks: 0, mcpServers: 0, errors: 2 })).toContain("2 errors during load — see /plugin");
    expect(reloadedText({ applied: false, held: true, cacheImpact: { mcpServersAdded: ["plugin:fmt:srv"], mcpServersRemoved: [], lspToolChange: null }, plugins: 0, skills: 0, agents: 0, hooks: 0, mcpServers: 0, errors: 0 })).toContain("plugin:fmt:srv");
    const state = (open: boolean, phase: string) => ({ session: { open }, gate: { phase } }) as unknown as ReviewState;
    expect(reloadPluginsBlocker(state(false, "idle"))).toBeTruthy();
    expect(reloadPluginsBlocker(state(true, "running"))).toBe("Claude is working — reload the plugins once the turn ends");
    expect(reloadPluginsBlocker(state(true, "idle"))).toBeNull();
  });

  it("/plugin, its other names and /reload-plugins are the app's own now", () => {
    expect(parseSlashAppCommand("/plugin", [])).toEqual({ kind: "plugin", arg: "" });
    expect(parseSlashAppCommand("/plugins install fmt", [])).toEqual({ kind: "plugin", arg: "install fmt" });
    expect(parseSlashAppCommand("/marketplace add acme/plugins", [])).toEqual({ kind: "plugin", arg: "marketplace add acme/plugins" });
    expect(parseSlashAppCommand("/reload-plugins", [])).toEqual({ kind: "reloadPlugins", force: false });
    expect(parseSlashAppCommand("/reload-plugins --force", [])).toEqual({ kind: "reloadPlugins", force: true });
    expect(TERMINAL_ONLY.has("plugin")).toBe(false);
    expect(appCommandDescription("marketplace")).toBe(appCommandDescription("plugin"));
  });
});
