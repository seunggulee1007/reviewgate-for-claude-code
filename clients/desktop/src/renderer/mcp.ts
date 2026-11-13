/**
 * MCP servers (docs/PROTOCOL.md §22) — the pure part, unit-tested: status / source / transport in words, the
 * attention state of the composer caption, the "서버 추가" form → `mcp_add` validation (the engine's own rules,
 * checked before sending) and the argument splitter. Env / header VALUES only live in the form until it is sent;
 * the engine never sends them back (`envKeys` / `headerKeys`).
 */
import type { McpAddConfig, McpScope, McpServerInfo } from "@reviewgate/engine";
import { t } from "./i18n";

export type McpState = {
  servers: McpServerInfo[];
  restartRequired: boolean;
  /** A config file opened from the list was saved since (src/renderer/mcpConfig.ts): the session reads it at its next start. */
  configEdited?: boolean;
  /** MARK: wave4d w4d-config — §42.3: the engine keeps a choice for every workbench of the repository. */
  repositoryToggle?: boolean;
  /** At least one `mcp_status` arrived (else the dialog falls back to `extensions.mcpServers`). */
  loaded: boolean;
  /** Servers with a command in flight → which one (the row shows a spinner, its buttons wait). */
  busy: Record<string, "reconnect" | "toggle" | "remove" | "auth">;
};

export const EMPTY_MCP: McpState = { servers: [], restartRequired: false, loaded: false, busy: {} };

export type McpStatus = McpServerInfo["status"];

/** Dot / text tone: connected green, failed red, needs-auth amber, pending / disabled gray. */
export function mcpTone(status: string): "green" | "red" | "orange" | "gray" {
  switch (status) {
    case "connected":
      return "green";
    case "failed":
      return "red";
    case "needs-auth":
      return "orange";
    default:
      return "gray";
  }
}

export function mcpStatusLabel(status: string): string {
  switch (status) {
    case "connected":
      return t("connected");
    case "failed":
      return t("failed");
    case "needs-auth":
      return t("needs sign-in");
    case "pending":
      return t("connecting");
    case "disabled":
      return t("off");
    default:
      return status;
  }
}

export function mcpSourceLabel(source: McpServerInfo["source"]): string {
  switch (source) {
    case "user":
      return t("user");
    case "project":
      return t("project");
    case "local":
      return t("local");
    case "plugin":
      return t("plugin");
    case "claude.ai":
      return "claude.ai";
    case "managed":
      return t("managed");
    case "session":
      return t("this session");
    default:
      return t("unknown");
  }
}

/**
 * The scope `mcp_remove` needs, or null when ReviewGate cannot remove it (plugin, claude.ai, managed, …). MARK: wave3
 * desktop-session — §36.6: a `local` server only with an engine that takes `scope: "local"` (`opts.localScope`).
 */
export function removableScope(s: McpServerInfo, opts: { localScope?: boolean } = {}): McpScope | null {
  if (s.sessionAdded || s.source === "session") return "session";
  if (s.source === "project") return "project";
  if (s.source === "user") return "user";
  if (s.source === "local" && opts.localScope === true) return "local";
  return null;
}

/** The composer caption's warning: a failed server (red) wins over one that waits for a sign-in (amber). */
export function mcpAttention(servers: { status: string }[]): "red" | "orange" | null {
  if (servers.some((s) => s.status === "failed")) return "red";
  if (servers.some((s) => s.status === "needs-auth")) return "orange";
  return null;
}

/** Connected first, then needs-auth, failed, pending, disabled; by name inside a group. */
export function sortServers(servers: McpServerInfo[]): McpServerInfo[] {
  const rank: Record<string, number> = { "needs-auth": 0, failed: 1, connected: 2, pending: 3, disabled: 4 };
  return [...servers].sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || a.name.localeCompare(b.name));
}

/** "npx -y @x/server --root \"a b\"" → ["npx", "-y", "@x/server", "--root", "a b"] (single / double quotes, backslash escapes). */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      any = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

export type KV = { key: string; value: string };

export type McpForm = {
  name: string;
  scope: McpScope;
  type: "stdio" | "http" | "sse";
  command: string;
  args: string;
  env: KV[];
  url: string;
  headers: KV[];
};

export const EMPTY_FORM: McpForm = { name: "", scope: "session", type: "stdio", command: "", args: "", env: [], url: "", headers: [] };

export type FormErrors = Partial<Record<"name" | "command" | "args" | "env" | "url" | "headers", string>>;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BAD_CHARS = /[\r\n\0]/;

/** The form → `mcp_add` (same rules as the engine's `invalid_mcp_*`), or the per-field errors. */
export function validateForm(f: McpForm, existing: string[] = []): { ok: true; name: string; scope: McpScope; config: McpAddConfig } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const name = f.name.trim();
  if (!name) errors.name = t("Enter a name");
  else if (!NAME_RE.test(name)) errors.name = t("Letters, digits, _ . - only (start with a letter or digit, at most 64)");
  else if (existing.includes(name)) errors.name = t("A server with this name already exists");
  const rows = (list: KV[]) => list.filter((r) => r.key.trim() || r.value.trim());
  if (f.type === "stdio") {
    const command = f.command.trim();
    if (!command) errors.command = t("Enter the command that starts the server");
    else if (command.startsWith("-")) errors.command = t("The command cannot start with -");
    else if (BAD_CHARS.test(command)) errors.command = t("No line breaks");
    const args = splitArgs(f.args);
    if (args.length > 100) errors.args = t("At most 100 arguments");
    else if (args.some((a) => BAD_CHARS.test(a))) errors.args = t("No line breaks");
    const env = rows(f.env);
    const badKey = env.find((r) => !ENV_KEY_RE.test(r.key.trim()));
    if (badKey) errors.env = t("Not a valid variable name: {0}", badKey.key.trim() || "(empty)");
    else if (env.some((r) => BAD_CHARS.test(r.value))) errors.env = t("No line breaks");
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    const config: McpAddConfig = { type: "stdio", command, ...(args.length > 0 ? { args } : {}), ...(env.length > 0 ? { env: Object.fromEntries(env.map((r) => [r.key.trim(), r.value])) } : {}) };
    return { ok: true, name, scope: f.scope, config };
  }
  const url = f.url.trim();
  if (!url) errors.url = t("Enter the server URL");
  else if (!/^https?:\/\/[^\s]+$/i.test(url) || BAD_CHARS.test(url)) errors.url = t("Use an http:// or https:// URL");
  const headers = rows(f.headers);
  const badHeader = headers.find((r) => !HEADER_RE.test(r.key.trim()));
  if (badHeader) errors.headers = t("Not a valid header name: {0}", badHeader.key.trim() || "(empty)");
  else if (headers.some((r) => BAD_CHARS.test(r.value))) errors.headers = t("No line breaks");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const config: McpAddConfig = { type: f.type, url, ...(headers.length > 0 ? { headers: Object.fromEntries(headers.map((r) => [r.key.trim(), r.value])) } : {}) };
  return { ok: true, name, scope: f.scope, config };
}

/** Where each scope writes (the form's explanation). */
export function scopeHelp(scope: McpScope): string {
  switch (scope) {
    case "session":
      return t("Only this ReviewGate session (kept for this project until ReviewGate quits); nothing is written to disk.");
    case "project":
      return t("Written to the project's .mcp.json — shared with everyone who uses the repository; shows up as a working-tree change.");
    case "user":
      return t("Written to your ~/.claude.json — available in every project. Takes effect after a session restart.");
    // MARK: wave3 desktop-session — §36.6 (the Mac's words)
    case "local":
      return t("Written to ~/.claude.json for this project only — not shared through git, also used by claude in the terminal. Applies after a session restart.");
  }
}

/** The redacted config line under a server (command + args, or the URL). */
export function configLine(s: McpServerInfo): string {
  const c = s.config;
  if (!c) return "";
  if (c.url) return c.url;
  return [c.command, ...(c.args ?? [])].filter(Boolean).join(" ");
}
