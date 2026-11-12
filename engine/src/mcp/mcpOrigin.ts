import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { McpServerInfo, McpServerOrigin } from "../protocol.js";
import { isInsidePath } from "../platform/paths.js";

/**
 * MARK: wave4d w4d-config — §42.3: the file that defines an MCP server and whether ReviewGate can remove it there.
 *
 * The CLI loads the `.mcp.json` of the project and of every folder above it and reports all of those servers with scope
 * "project", but `claude mcp remove --scope project <name>` only edits the `.mcp.json` of its own cwd: from the project a
 * parent folder's server fails "No MCP server named … in .mcp.json"; run in that folder it is removed (verified with CLI
 * 2.1.309). So the engine finds the nearest `.mcp.json` from the project root upwards that names the server, and removes it
 * by running the CLI there. ReviewGate itself never writes the user's `.claude.json`: user / local servers are removed by
 * the CLI as before.
 */

/** Folders walked above the project root. */
const MAX_LEVELS = 40;
/** A `.mcp.json` larger than this is not read. */
const MAX_FILE_BYTES = 1024 * 1024;

type Entry = { stamp: string; names: Set<string> | null };

/** The server names of `.mcp.json` files, re-read when a file's mtime or size changes (the 10 s poll asks every time). */
export class McpFileIndex {
  private readonly cache = new Map<string, Entry>();

  /** The keys of `mcpServers` in `file`; null when it is missing, too large or not JSON. */
  async names(file: string): Promise<Set<string> | null> {
    let st: { isFile(): boolean; mtimeMs: number; size: number };
    try {
      st = await stat(file);
    } catch {
      this.cache.delete(file);
      return null;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = this.cache.get(file);
    if (hit && hit.stamp === stamp) return hit.names;
    let names: Set<string> | null;
    try {
      const o = JSON.parse(await readFile(file, "utf8")) as { mcpServers?: unknown } | null;
      const servers = o && typeof o === "object" ? o.mcpServers : undefined;
      names = servers && typeof servers === "object" && !Array.isArray(servers) ? new Set(Object.keys(servers)) : new Set();
    } catch {
      names = null;
    }
    this.cache.set(file, { stamp, names });
    return names;
  }

  /** The nearest `.mcp.json` from `root` upwards whose `mcpServers` names `name`; null when none does. */
  async projectFileOf(name: string, root: string): Promise<string | null> {
    let dir = resolve(root);
    for (let i = 0; i < MAX_LEVELS; i++) {
      const file = join(dir, ".mcp.json");
      if ((await this.names(file))?.has(name)) return file;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return null;
  }
}

const SAFE_WORD = /^[A-Za-z0-9_.:@/+=-]+$/;
const quotePosix = (s: string) => (SAFE_WORD.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const quoteWin = (s: string) => (SAFE_WORD.test(s) ? s : `"${s.replace(/"/g, "")}"`);

/** The terminal line that removes a server where ReviewGate cannot (`cd` into the file's folder first). */
export function mcpRemoveCommand(name: string, scope: "project" | "user" | "local", folder: string | null, windows: boolean): string {
  const q = windows ? quoteWin : quotePosix;
  const rm = `claude mcp remove --scope ${scope} ${q(name)}`;
  if (!folder) return rm;
  return windows ? `cd /d ${q(folder)} && ${rm}` : `cd ${q(folder)} && ${rm}`;
}

async function writable(file: string): Promise<boolean> {
  try {
    await access(file, constants.W_OK);
    // The CLI writes the file in place; its folder must let it, too (a temp file / backup next to it).
    await access(dirname(file), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export type McpOriginContext = {
  /** The project root (the session's cwd). */
  root: string;
  /** The CLI's global config file (`claudeJsonPath`): where user / local servers live. */
  claudeJson: string;
  index: McpFileIndex;
  windows: boolean;
  /** §42.3: the file of each server the engine gives a worktree from a `.mcp.json` above its main checkout (mcpInherit.ts). */
  inherited?: ReadonlyMap<string, { file: string }>;
  /** Test seam: whether the CLI may rewrite `file`. */
  isWritable?: (file: string) => Promise<boolean>;
};

/** Where `server` is defined and whether `mcp_remove` can remove it there. */
export async function mcpOriginOf(server: McpServerInfo, ctx: McpOriginContext): Promise<McpServerOrigin> {
  if (server.sessionAdded || server.source === "session") return { file: null, place: null, removable: true };
  switch (server.source) {
    case "plugin":
      return { file: null, place: null, removable: false, reason: "plugin" };
    case "claude.ai":
      return { file: null, place: null, removable: false, reason: "claude_ai" };
    case "managed":
      return { file: null, place: null, removable: false, reason: "managed" };
    case "user":
    case "local":
      return { file: ctx.claudeJson, place: "home", removable: true };
    case "project": {
      const file = (await ctx.index.projectFileOf(server.name, ctx.root)) ?? ctx.inherited?.get(server.name)?.file ?? null;
      if (!file) return { file: null, place: null, removable: false, reason: "not_found", command: mcpRemoveCommand(server.name, "project", null, ctx.windows) };
      const place = isInsidePath(file, resolve(ctx.root)) ? "project" : "parent";
      if (!(await (ctx.isWritable ?? writable)(file))) {
        return { file, place, removable: false, reason: "read_only", command: mcpRemoveCommand(server.name, "project", dirname(file), ctx.windows) };
      }
      return { file, place, removable: true };
    }
    default:
      return { file: null, place: null, removable: false, reason: "unknown" };
  }
}
