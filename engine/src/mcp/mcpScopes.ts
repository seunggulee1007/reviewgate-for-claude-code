import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpToggleScope } from "../protocol.js";
import { readJSON, writeAtomicJSON } from "../review/persist.js";
import { MCP_PREFS_FILE } from "./mcp.js";

/**
 * MARK: wave4d w4d-config — §42.3: an MCP server turned off for this worktree or for every worktree of the repository.
 *
 * - This worktree: `<git dir>/reviewgate/mcp.json` `{version: 1, disabled, enabled?}` (§22's file; `enabled` = on here
 *   although the repository turns it off — older engines read `disabled` only).
 * - The repository: `<git common dir>/reviewgate/mcp-repository.json` `{version: 1, disabled}`. Every worktree reads it at
 *   its session start and again on its MCP poll when the file's mtime / size changed, so a choice made in one window
 *   reaches the other open worktrees within a poll.
 */
export const MCP_REPO_PREFS_FILE = join("reviewgate", "mcp-repository.json");

export type McpToggles = {
  /** Off in this worktree. */
  worktreeOff: Set<string>;
  /** On in this worktree although the repository turns it off. */
  worktreeOn: Set<string>;
  /** Off in every worktree of the repository. */
  repoOff: Set<string>;
};

export function emptyToggles(): McpToggles {
  return { worktreeOff: new Set(), worktreeOn: new Set(), repoOff: new Set() };
}

/** Which choice turns `name` off here, or null when it is on. */
export function mcpOffBy(t: McpToggles, name: string): McpToggleScope | null {
  if (t.worktreeOff.has(name)) return "worktree";
  if (t.repoOff.has(name) && !t.worktreeOn.has(name)) return "repository";
  return null;
}

/** Every name turned off here (either choice). */
export function mcpOffNames(t: McpToggles): Set<string> {
  const out = new Set(t.worktreeOff);
  for (const n of t.repoOff) if (!t.worktreeOn.has(n)) out.add(n);
  return out;
}

/**
 * `mcp_toggle {name, enabled, scope}` on the choices. Repository off: off everywhere (and here, whatever this worktree said);
 * repository on: on everywhere a worktree did not turn it off by itself, and here. Worktree off / on: this worktree only — on
 * here while the repository keeps it off is an exception (`worktreeOn`).
 */
export function applyMcpToggle(t: McpToggles, name: string, enabled: boolean, scope: McpToggleScope): void {
  if (scope === "repository") {
    if (enabled) {
      t.repoOff.delete(name);
      t.worktreeOff.delete(name);
    } else {
      t.repoOff.add(name);
    }
    t.worktreeOn.delete(name);
    return;
  }
  if (enabled) {
    t.worktreeOff.delete(name);
    if (t.repoOff.has(name)) t.worktreeOn.add(name);
  } else {
    t.worktreeOff.add(name);
    t.worktreeOn.delete(name);
  }
}

const cleanNames = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 200 && !/[\0-\x1f]/.test(n)) : [];

/** This worktree's choices (`<git dir>/reviewgate/mcp.json`). */
export async function loadWorktreeToggles(gitDir: string): Promise<{ disabled: string[]; enabled: string[] }> {
  const f = await readJSON<{ version?: number; disabled?: unknown; enabled?: unknown }>(join(gitDir, MCP_PREFS_FILE));
  if (f?.version !== 1) return { disabled: [], enabled: [] };
  return { disabled: cleanNames(f.disabled), enabled: cleanNames(f.enabled) };
}

/** Writes this worktree's choices; `enabled` only when there is one (the file keeps §22's shape otherwise). */
export async function saveWorktreeToggles(gitDir: string, t: McpToggles): Promise<void> {
  await mkdir(join(gitDir, "reviewgate"), { recursive: true });
  const disabled = [...t.worktreeOff].sort();
  const enabled = [...t.worktreeOn].sort();
  await writeAtomicJSON(join(gitDir, MCP_PREFS_FILE), { version: 1, disabled, ...(enabled.length > 0 ? { enabled } : {}) });
}

/** The repository's file stamp (mtime + size), null when missing: a poll re-reads it only when this changed. */
export async function repoTogglesStamp(commonDir: string): Promise<string | null> {
  try {
    const st = await stat(join(commonDir, MCP_REPO_PREFS_FILE));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export async function loadRepoToggles(commonDir: string): Promise<string[]> {
  const f = await readJSON<{ version?: number; disabled?: unknown }>(join(commonDir, MCP_REPO_PREFS_FILE));
  return f?.version === 1 ? cleanNames(f.disabled) : [];
}

/**
 * Turns `name` off / on in the repository's file. Read just before writing, so a choice another worktree's window wrote
 * meanwhile is kept (each window changes only the name it toggles).
 */
export async function saveRepoToggle(commonDir: string, name: string, off: boolean): Promise<string[]> {
  const list = new Set(await loadRepoToggles(commonDir));
  if (off) list.add(name);
  else list.delete(name);
  const disabled = [...list].sort();
  await mkdir(join(commonDir, "reviewgate"), { recursive: true });
  await writeAtomicJSON(join(commonDir, MCP_REPO_PREFS_FILE), { version: 1, disabled });
  return disabled;
}
