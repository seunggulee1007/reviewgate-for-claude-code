import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionHook, ExtensionPlugin, MemoryFile, SessionExtensions } from "../protocol.js";
import { relativeInside, samePath } from "../platform/paths.js";
import { safeReadOrNull } from "../util/safeRead.js";

/**
 * User extensions of an app session (docs/PROTOCOL.md §16): which settings sources the CLI loads,
 * per-plugin disable, user-hook disable, and the description of what was applied
 * (`state.session.extensions`). Pure helpers; the engine and `ClaudeSession` wire them.
 */

/** MARK: wave3 engine-session — §36.6 `local`: `.claude/settings.local.json` + the local-scope MCP servers. */
export type SettingSourceName = "user" | "project" | "local";

/** What `query({options})` gets for the extension surface. */
export type ExtensionQueryOptions = {
  settingSources: SettingSourceName[];
  skills?: "all";
  /** The flag-settings layer (`--settings`): highest user-controlled priority. */
  settings?: { enabledPlugins?: Record<string, boolean>; disableAllHooks?: boolean; crossSessionInbound?: "accept" | "hold" | "refuse" };
};

/**
 * `loadUserSettings` → `settingSources ["user","project"]` + `skills: "all"`, else `["project"]`.
 * `disabledPlugins` (ids `name@marketplace`) → flag `enabledPlugins: {id: false}` — the flag layer
 * outranks user and project settings, so a plugin either of them enables stays off (verified against
 * CLI 2.1.303: the plugin is missing from the session). `disableUserHooks` → flag `disableAllHooks:
 * true`: every settings-file hook (user / project) and every plugin hook stops, while the SDK
 * callback hooks ReviewGate registers itself (budget, git guard, containment) keep running
 * (verified against CLI 2.1.303; regression-tested by session.extensions.test.ts — same hook wiring and decisions
 * with and without the flag — and by sidecar/test/driver-m21.mjs step g against the real CLI).
 */
export function extensionQueryOptions(s: { loadUserSettings: boolean; loadLocalSettings?: boolean; disabledPlugins?: string[]; disableUserHooks?: boolean; crossSessionInbound?: "accept" | "hold" | "refuse" }): ExtensionQueryOptions {
  const out: ExtensionQueryOptions = { settingSources: settingSourcesOf(s.loadUserSettings, s.loadLocalSettings === true) };
  if (s.loadUserSettings) out.skills = "all";
  const ids = (s.disabledPlugins ?? []).filter((id) => id.includes("@"));
  const settings: NonNullable<ExtensionQueryOptions["settings"]> = {};
  if (ids.length > 0) settings.enabledPlugins = Object.fromEntries(ids.map((id) => [id, false]));
  if (s.disableUserHooks === true) settings.disableAllHooks = true;
  // §29: an explicit value outranks the user's settings (only policy wins), so a peer message is parked, not run.
  if (s.crossSessionInbound) settings.crossSessionInbound = s.crossSessionInbound;
  if (Object.keys(settings).length > 0) out.settings = settings;
  return out;
}

/**
 * MARK: wave3 engine-session — §36.6: `["user","project"]` / `["project"]`, plus `"local"` when the local settings load
 * (the engine leaves it out in the §16 fallback, with `user`).
 */
export function settingSourcesOf(loadUser: boolean, loadLocal: boolean): SettingSourceName[] {
  return [...(loadUser ? (["user", "project"] as const) : (["project"] as const)), ...(loadLocal ? (["local"] as const) : [])];
}

/**
 * `name@marketplace` of an installed plugin from its install path
 * (`…/plugins/cache/<marketplace>/<name>/<version>`); `name@builtin` for `builtin`; null otherwise
 * (`--plugin-dir` / unknown layouts cannot be disabled by id).
 */
export function pluginIdFromPath(name: string, path: string | null | undefined): string | null {
  if (!path) return null;
  if (path === "builtin") return `${name}@builtin`;
  const parts = path.replace(/\\/g, "/").split("/");
  const i = parts.lastIndexOf("cache");
  if (i >= 1 && parts[i - 1] === "plugins" && parts.length > i + 2) {
    const marketplace = parts[i + 1]!;
    const dirName = parts[i + 2]!;
    if (marketplace && dirName) return `${dirName}@${marketplace}`;
  }
  return null;
}

/** Configured entries → plugin ids: `x@y` as is, a bare name through the known plugins. */
export function resolveDisabledPlugins(configured: string[], known: { name: string; id: string | null }[]): { ids: string[]; unresolved: string[] } {
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const raw of configured) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.includes("@")) ids.push(entry);
    else {
      const hit = known.find((p) => p.name === entry && p.id !== null);
      if (hit) ids.push(hit.id!);
      else unresolved.push(entry);
    }
  }
  return { ids: [...new Set(ids)], unresolved };
}

export function claudeConfigDir(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir && dir.trim() ? resolve(dir) : join(homedir(), ".claude");
}

function hookEvents(file: string, wrapped: boolean): string[] | null {
  let o: unknown;
  try {
    // MARK: wave6 w6-statusline — a regular file of at most 1 MB only (a repository's settings.json → /dev/zero or a FIFO).
    const text = safeReadOrNull(file);
    if (text === null) return null;
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const hooks = (o as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return wrapped ? null : [];
  return Object.keys(hooks as Record<string, unknown>).sort();
}

/**
 * Hook sources the CLI would run besides ReviewGate's own: `hooks` of `<config>/settings.json`
 * (user, only when user settings load), `<cwd>/.claude/settings.json` (project) and each loaded
 * plugin's `hooks/hooks.json`. `active` is false when `disableUserHooks` turns them off.
 */
export function discoverHooks(opts: { configDir: string; cwd: string; loadUser: boolean; plugins: { name: string; path: string | null }[]; disabled: boolean }): ExtensionHook[] {
  const out: ExtensionHook[] = [];
  const add = (source: ExtensionHook["source"], path: string, plugin?: string) => {
    if (!existsSync(path)) return;
    const events = hookEvents(path, source === "plugin");
    if (events && events.length > 0) out.push({ source, ...(plugin ? { plugin } : {}), path, events, active: !opts.disabled });
  };
  if (opts.loadUser) add("user", join(opts.configDir, "settings.json"));
  add("project", join(opts.cwd, ".claude", "settings.json"));
  for (const p of opts.plugins) if (p.path && p.path !== "builtin") add("plugin", join(p.path, "hooks", "hooks.json"), p.name);
  return out;
}

/** CLAUDE.md status: from the CLI's memory files when reported, else by file existence. */
export function claudeMdStatus(opts: { configDir: string; cwd: string; memoryFiles: MemoryFile[] | null }): SessionExtensions["claudeMd"] {
  const userFile = join(opts.configDir, "CLAUDE.md");
  const cwd = resolve(opts.cwd);
  const inProject = (p: string) => relativeInside(resolve(p), cwd) !== null;
  if (opts.memoryFiles) {
    return {
      user: opts.memoryFiles.some((m) => samePath(resolve(m.path), userFile)),
      project: opts.memoryFiles.some((m) => /CLAUDE(\.local)?\.md$/i.test(m.path) && inProject(m.path)),
      source: "cli",
    };
  }
  return {
    user: existsSync(userFile),
    project: existsSync(join(cwd, "CLAUDE.md")) || existsSync(join(cwd, ".claude", "CLAUDE.md")),
    source: "files",
  };
}

/** The loaded plugins plus the configured-disabled ones the engine knows from earlier sessions. */
export function pluginList(loaded: { name: string; path: string | null; version?: string }[], disabledIds: string[], known: ExtensionPlugin[]): ExtensionPlugin[] {
  const out: ExtensionPlugin[] = loaded.map((p) => ({
    name: p.name,
    id: pluginIdFromPath(p.name, p.path),
    path: p.path,
    ...(p.version ? { version: p.version } : {}),
    enabled: true,
  }));
  for (const id of disabledIds) {
    if (out.some((p) => p.id === id)) continue;
    const k = known.find((p) => p.id === id);
    out.push({ name: k?.name ?? id.split("@")[0]!, id, path: k?.path ?? null, ...(k?.version ? { version: k.version } : {}), enabled: false });
  }
  return out;
}
