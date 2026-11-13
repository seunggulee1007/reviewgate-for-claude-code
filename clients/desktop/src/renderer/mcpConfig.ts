/**
 * Settings › MCP servers: opening the file that defines a server (`.mcp.json` of the project or a folder above it,
 * `~/.claude.json`) and noticing that it was saved (the restart banner). The files are read and written by the main process
 * (`window.rg.mcpConfigFile`, src/main/mcpConfigFile.ts); this is the words and the bookkeeping of what was opened.
 * Same strings as the Mac (Core `McpConfigFile`, App `McpConfigActions.swift`).
 */
import { t } from "./i18n";

/** The modification time each opened file had when it was opened (null: it did not exist). */
const opened = new Map<string, number | null>();

/** `~/.claude.json`: large, and it holds other state than MCP servers. */
export const isHomeConfig = (path: string): boolean => /[\\/]\.claude\.json$/.test(path);

/** The project's own `.mcp.json`. */
export const projectMcpJson = (root: string, sep: string): string => root.replace(/[\\/]+$/, "") + sep + ".mcp.json";

/** The tooltip of "Open Config File"; the disabled reason when there is no file. */
export function openHelp(file: string | null | undefined): string {
  if (!file) return t("ReviewGate does not know which file defines this server");
  return isHomeConfig(file) ? t("Opens ~/.claude.json — a large file that also holds your other Claude Code state. Edit it with care.") : t("Open the file that defines this server");
}

/** The tooltip of the clickable "Defined in …" line. */
export function originHint(file: string): string {
  return isHomeConfig(file) ? t("Click to show it in the file manager — it is a large file that also holds your other Claude Code state") : t("Click to open the file");
}

const bridge = () => (typeof window !== "undefined" ? window.rg?.mcpConfigFile : undefined);

/** Opens `path` in the editor (else the default app) and starts watching it; null when it opened, else why not. */
export async function openConfigFile(path: string): Promise<string | null> {
  const call = bridge();
  if (!call) return t("Could not open {0}", path);
  const r = await call("open", path);
  if (!r.ok) return r.error === "missing" ? t("That file no longer exists: {0}", path) : t("Could not open {0}", path);
  opened.set(path, r.mtime);
  return null;
}

/** Creates a `.mcp.json` with an empty server list, then opens it; null on success, else why not. */
export async function createAndOpenMcpJson(path: string): Promise<string | null> {
  const call = bridge();
  const made = call ? await call("create", path) : null;
  if (!made?.ok) return t("Could not create {0}", path);
  return openConfigFile(path);
}

/** Whether the project's `.mcp.json` is there (a missing one is offered to be created). */
export async function mcpJsonExists(path: string): Promise<boolean> {
  const r = await bridge()?.("stat", path);
  return r?.ok === true;
}

/** True when a file opened from here was saved since (once per save) — the app came back to the front. */
export async function openedConfigSaved(): Promise<boolean> {
  const call = bridge();
  if (!call) return false;
  let saved = false;
  for (const [path, before] of [...opened]) {
    const now = (await call("stat", path)).mtime;
    if (now !== before) {
      opened.set(path, now);
      saved = true;
    }
  }
  return saved;
}

export function forgetOpenedConfigs(): void {
  opened.clear();
}
