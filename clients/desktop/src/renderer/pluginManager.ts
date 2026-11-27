/**
 * docs/PROTOCOL.md §72.3: `/plugin` and `/reload-plugins` in a classic chat, through Claude Code's own `claude plugin …
 * --json` commands (`plugins_list`, `plugin_run`) and the SDK's reload (`plugins_reload`). How a typed `/plugin …` maps onto
 * the dialog, the words and the requests; the dialog is components/dialogs/PluginsDialog.tsx. As on the Mac (Core
 * PluginManager.swift); the Korean comes from the Mac's catalog through gen-i18n.mjs.
 */
import type { PluginAction, PluginInstalled, PluginResultEvent, PluginsListEvent, PluginsReloadedEvent, ReviewState } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { t } from "./i18n";

export type PluginsList = Omit<PluginsListEvent, "type" | "id">;
export type PluginResult = Omit<PluginResultEvent, "type" | "id">;
export type PluginsReloaded = Omit<PluginsReloadedEvent, "type" | "id">;
export type PluginTab = "installed" | "discover" | "marketplaces";
export const PLUGIN_TABS: readonly PluginTab[] = ["installed", "discover", "marketplaces"];

/** A typed `/plugin …`: the tab, and an action to confirm (install, uninstall, a marketplace's add / remove) or run. */
export type PluginRequest = { tab: PluginTab; action?: PluginAction; target?: string; unknown?: string };

/** Asks first: it installs or deletes something, as the terminal's panel shows a details pane or asks. */
export const pluginActionConfirms = (a: PluginAction): boolean => a === "install" || a === "uninstall" || a === "marketplace_add" || a === "marketplace_remove";
export const pluginActionWords = (a: PluginAction): string => a.replace("_", " ");

/**
 * As the terminal's session forms (the plugin commands reference): `/plugin` → Discover, `manage` / `list` → Installed,
 * `install | enable | disable | uninstall | update <plugin>`, `marketplace [add <source> | update <name> | remove <name>]`.
 */
export function parsePluginRequest(argument: string): PluginRequest {
  const words = argument.trim().split(/\s+/).filter(Boolean);
  const first = words.shift()?.toLowerCase();
  if (!first) return { tab: "discover" };
  const rest = words.join(" ");
  const withTarget = (tab: PluginTab, action: PluginAction): PluginRequest => (rest ? { tab, action, target: rest } : { tab });
  switch (first) {
    case "install": case "i": return withTarget("discover", "install");
    case "manage": case "list": case "ls": return { tab: "installed" };
    case "enable": return withTarget("installed", "enable");
    case "disable": return withTarget("installed", "disable");
    case "uninstall": return withTarget("installed", "uninstall");
    case "update": return withTarget("installed", "update");
    case "marketplace": case "market": {
      const verb = words.shift()?.toLowerCase();
      const name = words.join(" ");
      const m = (action: PluginAction): PluginRequest => (name ? { tab: "marketplaces", action, target: name } : { tab: "marketplaces" });
      switch (verb) {
        case undefined: case "list": return { tab: "marketplaces" };
        case "add": return m("marketplace_add");
        case "update": return m("marketplace_update");
        case "remove": case "rm": return m("marketplace_remove");
        default: return { tab: "marketplaces", unknown: `marketplace ${verb}` };
      }
    }
    default: return { tab: "discover", unknown: first };
  }
}

export const pluginDescription = (): string => t("Manage plugins and marketplaces — install, turn on or off, update");
export const reloadPluginsDescription = (): string => t("Load the plugins again — what was installed, updated or turned on or off since the chat started");
export const PLUGIN_HINT = "[install|enable|disable|uninstall|marketplace] …";

export function pluginTabTitle(tab: PluginTab): string {
  switch (tab) {
    case "installed": return t("Installed");
    case "discover": return t("Discover");
    case "marketplaces": return t("Marketplaces");
  }
}

export function pluginScopeLabel(scope: string): string {
  switch (scope) {
    case "user": return t("User");
    case "project": return t("Project");
    case "local": return t("Local");
    case "managed": return t("Managed");
    case "session": return t("This session");
    case "synced": return "claude.ai";
    default: return scope;
  }
}

/** Why a plugin's switch, Update or Uninstall cannot be used here; null when they can. */
export function pluginManageBlocker(p: PluginInstalled): string | null {
  if (p.scope === "managed") return t("Your organization manages this plugin");
  if (p.scope === "session") return t("Loaded for this session only (--plugin-dir)");
  return null;
}

export const pluginToggleHelp = (enabled: boolean): string =>
  enabled ? t("Turn off — claude plugin disable, in the settings of the scope that lists it") : t("Turn on — claude plugin enable");

export function marketplaceLocation(m: PluginsList["marketplaces"][number]): string {
  const base = m.repo ?? m.url ?? m.path ?? m.source;
  return m.ref ? `${base}#${m.ref}` : base;
}

export function pluginConfirmTitle(action: PluginAction, target: string): string {
  switch (action) {
    case "install": return t("Install {0}?", target);
    case "uninstall": return t("Uninstall {0}?", target);
    case "marketplace_add": return t("Add the marketplace {0}?", target);
    case "marketplace_remove": return t("Remove the marketplace {0}?", target);
    default: return `claude plugin ${pluginActionWords(action)} ${target}`;
  }
}

export function pluginConfirmMessage(action: PluginAction): string {
  switch (action) {
    case "install": return t("A plugin runs its hooks and MCP servers as you — install only one you trust. Claude Code fetches it and turns it on for the scope you pick.");
    case "uninstall": return t("claude plugin uninstall takes it out of its scope's settings and deletes its files.");
    case "marketplace_add": return t("claude plugin marketplace add fetches it and declares it in your user settings. Its plugins then show under Discover.");
    case "marketplace_remove": return t("Claude Code also uninstalls every plugin you installed from it.");
    default: return "";
  }
}

export function pluginConfirmButton(action: PluginAction): string {
  switch (action) {
    case "install": return t("Install");
    case "uninstall": return t("Uninstall");
    case "marketplace_add": return t("Add Marketplace");
    case "marketplace_remove": return t("Remove Marketplace");
    default: return t("Run");
  }
}

export function installScopeLabel(scope: string): string {
  switch (scope) {
    case "project": return t("For everyone in this repository (project)");
    case "local": return t("For you, in this repository only (local)");
    default: return t("For you, in every project (user)");
  }
}

export const pluginRunning = (a: PluginAction, target: string): string => t("Running claude plugin {0} {1}…", pluginActionWords(a), target);
export const pluginFailed = (a: PluginAction, message: string): string => t("claude plugin {0} failed: {1}", pluginActionWords(a), message);
export const pluginUnknown = (word: string): string => t("/plugin has no “{0}” here — the sheet lists what it can do", word);

/** The terminal's summary line, or why the reload was held. */
export function reloadedText(r: PluginsReloaded): string {
  if (r.held) {
    const servers = [...(r.cacheImpact?.mcpServersAdded ?? []), ...(r.cacheImpact?.mcpServersRemoved ?? [])].join(", ");
    return t("This reload changes MCP tools ({0}) — your next message would read the whole conversation again instead of using the cache. Run /reload-plugins --force to apply it.", servers);
  }
  const line = t("Reloaded: {0} plugins · {1} skills · {2} agents · {3} hooks · {4} plugin MCP servers", r.plugins, r.skills, r.agents, r.hooks, r.mcpServers);
  return r.errors > 0 ? `${line} — ${t("{0} errors during load — see /plugin", r.errors)}` : line;
}

/** Why Reload Plugins cannot run now; null when it can. */
export function reloadPluginsBlocker(state: ReviewState): string | null {
  if (!state.session.open || state.session.terminal) return t("No Claude session is open — restart the session");
  if (state.gate.phase === "running" || state.gate.phase === "collecting") return t("Claude is working — reload the plugins once the turn ends");
  return null;
}

/** `plugins_list`, or the refusal in words. */
export async function loadPlugins(): Promise<{ list: PluginsList } | { error: string }> {
  try {
    const { type: _type, id: _id, ...list } = await engineRequest({ type: "plugins_list" });
    return { list };
  } catch (e: unknown) {
    return { error: refusalMessage(refusalOf(e)) };
  }
}

/** `plugin_run`: the CLI's words (its failure is `ok: false`, the message prefixed), or the refusal. */
export async function runPlugin(action: PluginAction, target: string, scope?: "user" | "project" | "local"): Promise<PluginResult> {
  try {
    const { type: _type, id: _id, ...r } = await engineRequest({ type: "plugin_run", action, target, ...(scope ? { scope } : {}) });
    return r.ok ? r : { ...r, message: pluginFailed(action, r.message) };
  } catch (e: unknown) {
    return { action, target, ok: false, message: refusalMessage(refusalOf(e)), output: "" };
  }
}

/** `/reload-plugins [--force]`: the line under the box (`warning`: held or refused). */
export async function reloadPlugins(force: boolean): Promise<{ notice: string; warning: boolean }> {
  try {
    const { type: _type, id: _id, ...r } = await engineRequest({ type: "plugins_reload", ...(force ? { force: true } : {}) });
    return { notice: reloadedText(r), warning: r.held };
  } catch (e: unknown) {
    return { notice: refusalMessage(refusalOf(e)), warning: true };
  }
}
