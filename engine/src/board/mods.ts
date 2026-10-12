/**
 * MARK: wave5 w5-graph — docs/PROTOCOL.md §43.3: the user's Claude Code mods, listed for Settings › Extensions.
 *
 * A mod is a plugin folder (`.claude-plugin/plugin.json`, often a hooks module that draws panes in the terminal). Claude
 * Code keeps the ones a session made under `<config>/dev-mods/<session id>/<name>` — loaded by that session only — and
 * loads the folders named in `CLAUDE_CODE_PLUGIN_DIRS` (the environment, or the `env` of `<config>/settings.json`) in every
 * session, ReviewGate's included. Read only: nothing here writes, moves or runs a mod.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter as hostDelimiter, isAbsolute, join, resolve } from "node:path";
import type { UserMod } from "../protocol.js";
import { samePath } from "../platform/paths.js";

export const MODS_MAX = 50;
const DESCRIPTION_MAX = 300;
const MANIFEST_MAX_BYTES = 256 * 1024;

type Manifest = { name: string; description: string; version?: string };

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function children(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `.claude-plugin/plugin.json` of a folder (name falls back to the folder's), null when it is not a plugin. */
export function readManifest(dir: string): Manifest | null {
  const file = join(dir, ".claude-plugin", "plugin.json");
  try {
    if (statSync(file).size > MANIFEST_MAX_BYTES) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const folder = dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : folder;
    const description = typeof raw.description === "string" ? raw.description.trim().slice(0, DESCRIPTION_MAX) : "";
    return { name, description, ...(typeof raw.version === "string" && raw.version.trim() ? { version: raw.version.trim() } : {}) };
  } catch {
    return null;
  }
}

/**
 * The folders `CLAUDE_CODE_PLUGIN_DIRS` names, split as the CLI splits it (the platform's path delimiter), `~` expanded,
 * absolute ones only (the CLI skips the rest).
 */
export function pluginDirsOf(value: string | undefined, opts: { home?: string; delimiter?: string } = {}): string[] {
  if (!value?.trim()) return [];
  const home = opts.home ?? homedir();
  const out: string[] = [];
  for (const raw of value.split(opts.delimiter ?? hostDelimiter)) {
    const t = raw.trim();
    if (!t) continue;
    const p = t === "~" ? home : t.startsWith("~/") || t.startsWith("~\\") ? join(home, t.slice(2)) : t;
    if (!isAbsolute(p)) continue;
    const abs = resolve(p);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** `env.CLAUDE_CODE_PLUGIN_DIRS` of `<config>/settings.json` (read only), undefined when absent or unreadable. */
export function settingsPluginDirs(configDir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as { env?: Record<string, unknown> };
    const v = raw?.env?.CLAUDE_CODE_PLUGIN_DIRS;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's mods: `CLAUDE_CODE_PLUGIN_DIRS` folders first (a folder of plugins lists each child, as `--plugin-dir`), then
 * `<config>/dev-mods/<session>/<name>` newest first; one entry per real folder, ≤ 50. `loaded` = the running session
 * reported a plugin at that folder.
 */
export function listUserMods(opts: {
  configDir: string;
  /** `CLAUDE_CODE_PLUGIN_DIRS` of the session's environment, else of settings.json. */
  pluginDirs: string | undefined;
  loadedPaths: readonly string[];
  home?: string;
  delimiter?: string;
}): UserMod[] {
  const seen: string[] = [];
  const loaded = opts.loadedPaths.map(realOrSelf);
  const mods: UserMod[] = [];
  const add = (dir: string, source: UserMod["source"], sessionId?: string): void => {
    if (mods.length >= MODS_MAX) return;
    const real = realOrSelf(dir);
    if (seen.some((s) => samePath(s, real))) return;
    const m = readManifest(dir);
    if (!m) return;
    seen.push(real);
    mods.push({
      name: m.name,
      description: m.description,
      ...(m.version ? { version: m.version } : {}),
      path: dir,
      source,
      ...(sessionId ? { sessionId } : {}),
      loaded: loaded.some((p) => samePath(p, real)),
      hasHooks: isFile(join(dir, "hooks", "hooks.json")),
    });
  };
  for (const dir of pluginDirsOf(opts.pluginDirs, { home: opts.home, delimiter: opts.delimiter })) {
    if (!isDir(dir)) continue;
    if (readManifest(dir)) add(dir, "plugin_dirs");
    else for (const child of children(dir)) add(child, "plugin_dirs");
  }
  const dev = join(opts.configDir, "dev-mods");
  const sessions = children(dev)
    .map((d) => ({ d, t: mtime(d) }))
    .sort((a, b) => b.t - a.t);
  for (const { d } of sessions) {
    const sessionId = d.split(/[\\/]/).at(-1);
    for (const child of children(d)) add(child, "dev", sessionId);
  }
  return mods;
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
