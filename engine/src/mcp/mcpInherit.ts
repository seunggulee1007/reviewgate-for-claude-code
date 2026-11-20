import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { isInsidePath, samePath } from "../platform/paths.js";

/**
 * §42.3: the `.mcp.json` servers of the folders above a project that a session in one of its worktrees would lose.
 *
 * The CLI loads the `.mcp.json` of its working folder and of every folder above it (not the filesystem root; CLI 2.1.322,
 * `claude mcp list` / an SDK session alike). A workbench in ReviewGate's managed folder (`~/.reviewgate/worktrees/…`) is
 * not below the project's main checkout, so `/work/acme/.mcp.json` above `/work/acme/app` never loads there although the
 * terminal in `/work/acme/app` — and Claude Code's own worktrees, inside the repository — have its servers. The engine
 * reads those files and gives their servers to the session as SDK servers (`setMcpServers`), labelled with their file.
 */

/** A `.mcp.json` larger than this is not read (as mcpOrigin.ts). */
const MAX_FILE_BYTES = 1024 * 1024;
/** Folders walked above the main checkout. */
const MAX_LEVELS = 40;

export type InheritedMcpServer = { file: string; config: Record<string, unknown> };

/** The main checkout of the repository whose common git dir is `commonDir` (`/x/app/.git` → `/x/app`); null for a bare one. */
export function mainCheckoutOf(commonDir: string): string | null {
  const trimmed = commonDir.replace(/[\\/]+$/, "");
  return basename(trimmed) === ".git" ? dirname(trimmed) : null;
}

/** `dir` and the folders above it, nearest first, without the filesystem root (the CLI does not read `/.mcp.json`). */
function foldersUp(dir: string): string[] {
  const out: string[] = [];
  let d = resolve(dir);
  for (let i = 0; i < MAX_LEVELS && d !== parse(d).root; i++) {
    out.push(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/**
 * The `.mcp.json` files above `mainRoot` the CLI does not read from `cwd` — root-most first, as the CLI merges them (a
 * nearer file's server wins). Empty when `cwd` is the main checkout or below it (the CLI walks through its folders then).
 */
export function inheritedMcpFiles(cwd: string, mainRoot: string): string[] {
  if (samePath(cwd, mainRoot) || isInsidePath(cwd, mainRoot)) return [];
  const own = foldersUp(cwd);
  const seen = (d: string) => own.some((o) => samePath(o, d));
  return foldersUp(dirname(resolve(mainRoot)))
    .filter((d) => !seen(d))
    .map((d) => join(d, ".mcp.json"))
    .reverse();
}

async function readServers(file: string): Promise<Record<string, unknown> | null> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const o = JSON.parse(await readFile(file, "utf8")) as { mcpServers?: unknown } | null;
    const servers = o && typeof o === "object" ? o.mcpServers : undefined;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `${VAR}` / `${VAR:-default}` in a string, as Claude Code expands `.mcp.json` values; an unset variable stays as written. */
export function expandMcpVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (whole, name: string, fallback: string | undefined) => env[name] ?? fallback ?? whole);
}

function expandDeep(v: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof v === "string") return expandMcpVars(v, env);
  if (Array.isArray(v)) return v.map((x) => expandDeep(x, env));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x, env)]));
  return v;
}

/**
 * One `.mcp.json` entry as an SDK server config (`type` filled in: stdio when it has a command); null when it is neither.
 * `expand: false` (§57.11, a terminal chat's `--mcp-config`) leaves `${VAR}` as written: the CLI expands it from the PTY's
 * environment, the user's real one.
 */
function sdkConfigOf(raw: unknown, env: Record<string, string | undefined>, expand = true): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = (expand ? expandDeep(raw, env) : raw) as Record<string, unknown>;
  const type = typeof c.type === "string" ? c.type : typeof c.command === "string" ? "stdio" : null;
  if (type === "stdio" && typeof c.command === "string") return { ...c, type };
  if ((type === "http" || type === "sse") && typeof c.url === "string") return { ...c, type };
  return null;
}

/**
 * The servers of `inheritedMcpFiles(cwd, mainRoot)` by name (a nearer file wins), leaving out `skip` — names the session
 * already has (its own walk, user / local scope, plugins: the CLI's server stays) and the ones settings reject
 * (`disabledMcpjsonServers`).
 */
export async function inheritedMcpServers(
  cwd: string,
  mainRoot: string,
  opts: { skip: ReadonlySet<string>; env: Record<string, string | undefined>; expand?: boolean },
): Promise<Map<string, InheritedMcpServer>> {
  const out = new Map<string, InheritedMcpServer>();
  for (const file of inheritedMcpFiles(cwd, mainRoot)) {
    const servers = await readServers(file);
    if (!servers) continue;
    for (const [name, raw] of Object.entries(servers)) {
      if (opts.skip.has(name)) continue;
      const config = sdkConfigOf(raw, opts.env, opts.expand ?? true);
      if (config) out.set(name, { file, config });
    }
  }
  return out;
}

/** `disabledMcpjsonServers` of the settings files the session loads (user, the project's shared and local settings). */
export async function rejectedMcpjsonServers(files: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const file of files) {
    try {
      const o = JSON.parse(await readFile(file, "utf8")) as { disabledMcpjsonServers?: unknown } | null;
      const list = o && typeof o === "object" ? o.disabledMcpjsonServers : undefined;
      if (Array.isArray(list)) for (const n of list) if (typeof n === "string") out.add(n);
    } catch {
      // missing or not JSON: nothing rejected there
    }
  }
  return out;
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > MAX_CLAUDE_JSON_BYTES) return null;
    const o = JSON.parse(await readFile(file, "utf8")) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `.claude.json` grows with the CLI's history; larger than this it is not read for names (§57.11). */
const MAX_CLAUDE_JSON_BYTES = 64 * 1024 * 1024;

const namesOf = (v: unknown): string[] => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);

/**
 * §57.11: the MCP server names a terminal's CLI in `cwd` loads by itself — user scope (`.claude.json` `mcpServers`), local
 * scope (`projects[<cwd>].mcpServers`) and the `.mcp.json` files along `cwd`'s own walk. Read-only; unreadable = none.
 */
export async function knownMcpNames(o: { cwd: string; claudeJson: string }): Promise<Set<string>> {
  const out = new Set<string>();
  const cfg = await readJsonObject(o.claudeJson);
  for (const n of namesOf(cfg?.mcpServers)) out.add(n);
  const projects = cfg?.projects && typeof cfg.projects === "object" ? (cfg.projects as Record<string, unknown>) : {};
  for (const [key, p] of Object.entries(projects)) {
    if (!samePath(key, o.cwd) || !p || typeof p !== "object") continue;
    for (const n of namesOf((p as { mcpServers?: unknown }).mcpServers)) out.add(n);
  }
  for (const dir of foldersUp(o.cwd)) for (const n of namesOf(await readServers(join(dir, ".mcp.json")))) out.add(n);
  return out;
}

/** §57.11: the `--mcp-config` JSON (`{"mcpServers":{…}}`) of the inherited servers; null when there are none. */
export function terminalMcpConfig(servers: ReadonlyMap<string, InheritedMcpServer>): string | null {
  if (servers.size === 0) return null;
  return JSON.stringify({ mcpServers: Object.fromEntries([...servers].map(([n, s]) => [n, s.config])) });
}
