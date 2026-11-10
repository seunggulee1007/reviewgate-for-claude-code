import { join } from "node:path";
import { CommandRefused } from "../errors.js";
import type { McpAddConfig, McpScope, McpServerInfo } from "../protocol.js";
import { readJSON } from "../review/persist.js";

/**
 * MCP server management (docs/PROTOCOL.md §22): the live list from `Query.mcpServerStatus()`, redacted
 * for the wire; validation and `claude mcp add/remove` argv for the persistent scopes; the per-project
 * toggle file.
 */

/** The SDK's status entry (structural subset of `McpServerStatus`). */
export type RawMcpStatus = {
  name: string;
  status: string;
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: Record<string, unknown>;
  scope?: string;
  tools?: { name: string }[];
};

const STATUSES = new Set(["connected", "failed", "needs-auth", "pending", "disabled"]);
const SECRET_RE = /(key|token|secret|password|passwd|pwd|auth|bearer|credential|cookie|session)/i;
export const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/** `user` / `project` / `local` / `plugin` / `claude.ai` / `managed` / `session` from the SDK's scope string and the name. */
export function mcpSource(scope: string | undefined, name: string, sessionAdded: boolean): McpServerInfo["source"] {
  const s = (scope ?? "").toLowerCase();
  if (sessionAdded) return "session";
  // Plugin servers are scoped "plugin:<plugin>:<server>" and reported with the dynamic scope (CLI 2.1.304).
  if (s === "plugin" || name.startsWith("plugin:")) return "plugin";
  if (s === "dynamic" || s === "session" || s === "sdk") return "session";
  if (s === "user" || s === "project" || s === "local" || s === "managed") return s;
  if (s === "claudeai" || s === "claude.ai" || s === "claude_ai") return "claude.ai";
  return "unknown";
}

/** A URL without credentials: userinfo dropped, query values masked when the key looks secret (all values when unparsable). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    for (const k of [...u.searchParams.keys()]) if (SECRET_RE.test(k) || u.searchParams.get(k)!.length > 24) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return url.replace(/\?.*$/, "?***");
  }
}

/** Args without secrets: the value after a secret-looking flag, `--flag=value` / `KEY=value` with a secret-looking name, long opaque tokens. */
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const a of args) {
    if (maskNext) {
      out.push("***");
      maskNext = false;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0 && SECRET_RE.test(a.slice(0, eq))) out.push(`${a.slice(0, eq)}=***`);
    else if (/^--?[A-Za-z]/.test(a) && SECRET_RE.test(a) && eq < 0) {
      out.push(a);
      maskNext = true;
    } else if (/^[A-Za-z0-9_\-+/=.]{32,}$/.test(a) && !a.includes("/") ) out.push("***");
    else if (/^https?:\/\//i.test(a)) out.push(redactUrl(a));
    else out.push(a);
  }
  return out;
}

/** The wire form of one server: env / header values never leave the engine. */
export function toServerInfo(raw: RawMcpStatus, opts: { disabled: ReadonlySet<string>; sessionAdded: ReadonlySet<string> }): McpServerInfo {
  const cfg = raw.config ?? {};
  const type = typeof cfg.type === "string" ? cfg.type : typeof cfg.command === "string" ? "stdio" : "unknown";
  const transport: McpServerInfo["transport"] = type === "stdio" || type === "http" || type === "sse" || type === "sdk" || type === "claudeai-proxy" ? type : "unknown";
  const config: NonNullable<McpServerInfo["config"]> = {};
  if (typeof cfg.command === "string") config.command = cfg.command;
  if (Array.isArray(cfg.args)) config.args = redactArgs(cfg.args.filter((a): a is string => typeof a === "string"));
  if (typeof cfg.url === "string") config.url = redactUrl(cfg.url);
  if (cfg.env && typeof cfg.env === "object") config.envKeys = Object.keys(cfg.env as object).sort();
  if (cfg.headers && typeof cfg.headers === "object") config.headerKeys = Object.keys(cfg.headers as object).sort();
  const tools = Array.isArray(raw.tools) ? raw.tools.map((t) => t?.name).filter((n): n is string => typeof n === "string") : null;
  const sessionAdded = opts.sessionAdded.has(raw.name);
  return {
    name: raw.name,
    status: (STATUSES.has(raw.status) ? raw.status : "pending") as McpServerInfo["status"],
    scope: typeof raw.scope === "string" ? raw.scope : null,
    source: mcpSource(raw.scope, raw.name, sessionAdded),
    transport,
    toolCount: tools ? tools.length : null,
    tools: tools ?? [],
    error: typeof raw.error === "string" && raw.error ? raw.error.slice(0, 2000) : null,
    serverInfo: raw.serverInfo && typeof raw.serverInfo.name === "string" ? { name: raw.serverInfo.name, version: String(raw.serverInfo.version ?? "") } : null,
    config: Object.keys(config).length > 0 ? config : null,
    disabledByUser: opts.disabled.has(raw.name),
    sessionAdded,
  };
}

export function validateMcpName(name: unknown): string {
  if (typeof name !== "string" || !MCP_NAME_RE.test(name)) throw new CommandRefused(`invalid_mcp_name:${typeof name === "string" ? name.slice(0, 80) : ""}`, { code: "invalid_mcp_name" });
  return name;
}

/** Name of a server that already exists (plugin `plugin:x:y`, claude.ai `claude.ai Gmail` names included). */
export function validateServerRef(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 200 || /[\0-\x1f]/.test(name)) throw new CommandRefused("invalid_mcp_name");
  return name;
}

/** MARK: wave3 engine-session — §36.6 adds `local` (`claude mcp add|remove --scope local`: `~/.claude.json`, this project only). */
export function validateMcpScope(scope: unknown): McpScope {
  if (scope !== "session" && scope !== "project" && scope !== "user" && scope !== "local") throw new CommandRefused("invalid_mcp_scope");
  return scope;
}

const bad = (detail: string): never => {
  throw new CommandRefused(`invalid_mcp_config:${detail}`, { code: "invalid_mcp_config" });
};
const noControl = (s: string) => !/[\0\r\n]/.test(s);

/** A checked copy of `config` (unknown fields dropped). */
export function validateMcpConfig(config: unknown): McpAddConfig {
  if (!config || typeof config !== "object") return bad("missing");
  const c = config as Record<string, unknown>;
  const type = c.type ?? "stdio";
  if (type === "stdio") {
    if (typeof c.command !== "string" || !c.command.trim() || !noControl(c.command) || c.command.length > 1024) return bad("command");
    if (c.command.trim().startsWith("-")) return bad("command");
    const args = c.args ?? [];
    if (!Array.isArray(args) || args.length > 100 || !args.every((a) => typeof a === "string" && noControl(a) && a.length <= 4096)) return bad("args");
    const env = c.env ?? {};
    if (typeof env !== "object" || Array.isArray(env)) return bad("env");
    for (const [k, v] of Object.entries(env as object)) if (!ENV_KEY_RE.test(k) || typeof v !== "string" || !noControl(v)) return bad(`env:${k.slice(0, 64)}`);
    return { type: "stdio", command: c.command.trim(), args: [...(args as string[])], env: { ...(env as Record<string, string>) } };
  }
  if (type === "http" || type === "sse") {
    if (typeof c.url !== "string" || !noControl(c.url)) return bad("url");
    let u: URL;
    try {
      u = new URL(c.url);
    } catch {
      return bad("url");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return bad("url");
    const headers = c.headers ?? {};
    if (typeof headers !== "object" || Array.isArray(headers)) return bad("headers");
    for (const [k, v] of Object.entries(headers as object)) if (!HEADER_KEY_RE.test(k) || typeof v !== "string" || !noControl(v)) return bad(`header:${k.slice(0, 64)}`);
    return { type, url: c.url, headers: { ...(headers as Record<string, string>) } };
  }
  return bad("type");
}

type RemoteConfig = Extract<McpAddConfig, { url: string }>;
type StdioConfig = Exclude<McpAddConfig, RemoteConfig>;
function isRemote(c: McpAddConfig): c is RemoteConfig {
  return c.type === "http" || c.type === "sse";
}

/** `claude mcp add` argv for the persistent scopes (no shell; options before positionals, variadic flags last or before `--`). */
export function mcpAddArgs(name: string, scope: Exclude<McpScope, "session">, cfg: McpAddConfig): string[] {
  if (isRemote(cfg)) {
    const config = cfg;
    const args = ["mcp", "add", "--scope", scope, "--transport", config.type, name, config.url];
    for (const [k, v] of Object.entries(config.headers ?? {})) args.push("--header", `${k}: ${v}`);
    return args;
  }
  const config: StdioConfig = cfg;
  const args = ["mcp", "add", "--scope", scope, "--transport", "stdio", name];
  for (const [k, v] of Object.entries(config.env ?? {})) args.push("--env", `${k}=${v}`);
  args.push("--", config.command, ...(config.args ?? []));
  return args;
}

export function mcpRemoveArgs(name: string, scope: Exclude<McpScope, "session">): string[] {
  return ["mcp", "remove", "--scope", scope, name];
}

/** The SDK config for `setMcpServers` (session scope). */
export function sdkMcpConfig(config: McpAddConfig): Record<string, unknown> {
  if (isRemote(config)) return { type: config.type, url: config.url, ...(config.headers && Object.keys(config.headers).length ? { headers: config.headers } : {}) };
  return { type: "stdio", command: config.command, args: config.args ?? [], ...(config.env && Object.keys(config.env).length ? { env: config.env } : {}) };
}

// ---------------------------------------------------------------- per-project preferences

export const MCP_PREFS_FILE = join("reviewgate", "mcp.json");
export type McpPrefs = { version: 1; disabled: string[] };

export async function loadMcpPrefs(gitDir: string): Promise<string[]> {
  const f = await readJSON<McpPrefs>(join(gitDir, MCP_PREFS_FILE));
  return f?.version === 1 && Array.isArray(f.disabled) ? f.disabled.filter((n) => typeof n === "string" && n.length > 0 && n.length <= 200 && !/[\0-\x1f]/.test(n)) : [];
}

// MARK: wave4d w4d-config — §42.3: written by `saveWorktreeToggles` (mcp/mcpScopes.ts), which keeps this shape and adds `enabled`.
