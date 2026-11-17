/**
 * MARK: composer parity — docs/PROTOCOL.md §56.4: `/mcp`, as in the terminal — the session's MCP servers listed over the
 * composer (↑ / ↓, Enter reconnects or logs in, Alt+Enter turns on / off), and `/mcp reconnect|enable|disable <name>`
 * typed out. The pure part, as on the Mac (Core McpPalette.swift); the list is McpPalette.tsx.
 */
import type { McpServerInfo } from "@reviewgate/engine";
import { t } from "./i18n";
import { mcpStatusLabel } from "./mcp";

/** The palette's entry (Built-in), as the terminal's own /mcp. */
export const MCP_NAME = "mcp";
export const MCP_HINT = "[reconnect|enable|disable] <server|all>";

export type McpVerb = "reconnect" | "enable" | "disable";
export type McpCommand = { kind: "list"; filter: string } | { kind: "run"; verb: McpVerb; name: string };
export type McpAction = "reconnect" | "login" | "enable" | "disable";

export function mcpDescription(): string {
  return t("Manage MCP servers — reconnect, log in, turn on or off");
}

/** `text` is the app's `/mcp` command; null for anything else (`/mcpx`, a second line, a message). */
export function parseMcpCommand(text: string): McpCommand | null {
  const trimmed = text.trim();
  const m = /^\/mcp(?=\s|$)(.*)$/i.exec(trimmed);
  if (!m || /[\r\n]/.test(trimmed)) return null;
  const words = m[1]!.split(/\s+/).filter((w) => w.length > 0);
  const verb = words[0]?.toLowerCase();
  if (verb === "reconnect" || verb === "enable" || verb === "disable") return { kind: "run", verb, name: words.slice(1).join(" ") };
  return { kind: "list", filter: words.join(" ") };
}

/** `/mcp <verb> all`: every server, as in the terminal. */
export function isAll(c: McpCommand): boolean {
  return c.kind === "run" && c.name.toLowerCase() === "all";
}

/** The name part that filters the list (none for `all`). */
export function commandFilter(c: McpCommand): string {
  return c.kind === "list" ? c.filter : isAll(c) ? "" : c.name;
}

/** Tab: `/mcp …` with the name part replaced by `name` (the verb stays). */
export function completing(c: McpCommand, name: string): string {
  return c.kind === "list" ? `/mcp ${name}` : `/mcp ${c.verb} ${name}`;
}

export function isOff(s: Pick<McpServerInfo, "status" | "disabledByUser">): boolean {
  return s.status === "disabled" || s.disabledByUser;
}

/** The servers whose name matches `filter` (any case): names starting with it first, then names containing it, by name. */
export function mcpRows<T extends { name: string }>(servers: T[], filter: string): T[] {
  const q = filter.trim().toLowerCase();
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (!q) return [...servers].sort(byName);
  const prefix = servers.filter((s) => s.name.toLowerCase().startsWith(q)).sort(byName);
  const inside = servers.filter((s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q)).sort(byName);
  return [...prefix, ...inside];
}

/** Enter: Log in… for a server that needs it, Turn On for one that is off, else Reconnect. */
export function primaryAction(s: Pick<McpServerInfo, "status" | "disabledByUser">): McpAction {
  if (isOff(s)) return "enable";
  if (s.status === "needs-auth") return "login";
  return "reconnect";
}

/** Alt+Enter: Turn Off / Turn On. */
export function toggleAction(s: Pick<McpServerInfo, "status" | "disabledByUser">): McpAction {
  return isOff(s) ? "enable" : "disable";
}

export function actionTitle(a: McpAction): string {
  switch (a) {
    case "reconnect":
      return t("Reconnect");
    case "login":
      return t("Log in…");
    case "enable":
      return t("Turn On");
    case "disable":
      return t("Turn Off");
  }
}

/** What it is doing, for the composer's notice line of `/mcp <verb> <name>`. */
export function actionProgress(a: McpAction, name: string): string {
  switch (a) {
    case "reconnect":
      return t("Reconnecting “{0}”…", name);
    case "login":
      return t("Opening Terminal to log in to “{0}”…", name);
    case "enable":
      return t("Turning on “{0}”…", name);
    case "disable":
      return t("Turning off “{0}”…", name);
  }
}

/** `/mcp <verb> all`: what it is doing to every server, and when it is done. */
export function actionProgressAll(a: McpAction, count: number): string {
  return a === "enable" ? t("Turning on {0} MCP servers…", count) : a === "disable" ? t("Turning off {0} MCP servers…", count) : t("Reconnecting {0} MCP servers…", count);
}

export function actionDoneAll(a: McpAction, count: number): string {
  return t("{0} — {1} MCP servers done", actionTitle(a), count);
}

export type McpPaletteContext = { sessionOpen: boolean };

/** Why nothing runs at all; null when actions can. */
export function unavailableReason(ctx: McpPaletteContext): string | null {
  return ctx.sessionOpen ? null : t("The session is not running — MCP servers can be managed once it is");
}

/** Why `a` cannot run on `s` now; null when it can. */
export function disabledReason(a: McpAction, s: Pick<McpServerInfo, "name" | "status" | "disabledByUser">, busy: boolean, ctx: McpPaletteContext): string | null {
  const why = unavailableReason(ctx);
  if (why) return why;
  if (busy) return t("Working on “{0}” — wait for it to finish", s.name);
  if (a === "reconnect" && isOff(s)) return t("“{0}” is off — turn it on first (⌥↩)", s.name);
  if (a === "enable" && !isOff(s)) return t("“{0}” is already on", s.name);
  if (a === "disable" && isOff(s)) return t("“{0}” is already off", s.name);
  return null;
}

/** The server `/mcp <verb> <name>` means: the one with exactly that name (any case), else the row at `selection`. */
export function mcpTarget<T extends { name: string }>(name: string, rows: T[], selection: number): T | null {
  const n = name.trim().toLowerCase();
  const exact = rows.find((r) => r.name.toLowerCase() === n);
  if (exact) return exact;
  if (rows.length === 0) return null;
  return rows[Math.min(Math.max(selection, 0), rows.length - 1)]!;
}

export function noServerText(name: string): string {
  return name ? t("No MCP server is called “{0}” — type /mcp to see the list", name) : t("No MCP server to act on — type /mcp to see the list");
}

/** The status words of a row (Working… while an action runs; off for a server the user turned off). */
export function rowStatus(s: Pick<McpServerInfo, "status" | "disabledByUser">, busy: boolean): string {
  return busy ? t("Working…") : mcpStatusLabel(isOff(s) ? "disabled" : s.status);
}
