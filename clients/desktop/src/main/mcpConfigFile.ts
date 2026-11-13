/**
 * Settings › MCP servers: the files that define a server (`.mcp.json` of the project or a folder above it, `~/.claude.json`).
 * The renderer may stat them (to notice a save), open them and create a missing `.mcp.json` — nothing else; the path is
 * checked here, not trusted. Pure `node:fs`, so it is unit-tested without Electron.
 */
import { statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

export const EMPTY_MCP_JSON = '{"mcpServers": {}}\n';

/** An absolute path (no NUL / newline) of a file named `.mcp.json` or `.claude.json`. */
export function isMcpConfigPath(path: unknown): path is string {
  return typeof path === "string" && isAbsolute(path) && !/[\0\r\n]/.test(path) && [".mcp.json", ".claude.json"].includes(basename(path));
}

/** The file's modification time (ms), or null when it is not a file that exists. */
export function mcpConfigMtime(path: string): number | null {
  try {
    const s = statSync(path);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}

/** Creates a `.mcp.json` with an empty server list; "exists" leaves a file that is there alone; "failed" is an unwritable folder. */
export function createMcpJson(path: string): "created" | "exists" | "failed" {
  if (basename(path) !== ".mcp.json") return "failed";
  try {
    writeFileSync(path, EMPTY_MCP_JSON, { flag: "wx" });
    return "created";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
  }
}
