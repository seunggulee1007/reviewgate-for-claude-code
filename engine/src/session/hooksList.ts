import path, { type PlatformPath } from "node:path";
import type { HookEntry, HookFile, HookSource, HooksListEvent } from "../protocol.js";
import { safeReadOrNull, wellFormed } from "../util/safeRead.js";

/**
 * docs/PROTOCOL.md §72.1 `/hooks`: the hooks in effect for the session, as the terminal's read-only `/hooks` browser lists
 * them — each one with its event, matcher, what it runs and where it is defined (user, project or local settings, a
 * plugin, the managed policy). Pure reads of the settings files the session loads (every file through `safeReadOrNull`).
 * The hooks a skill or a subagent registers while it runs (the terminal's "current session" label) are not in a file and
 * are not listed.
 */

/** The terminal's lifecycle order of the hook events (the hooks reference, 2026-11); others follow by name. */
export const HOOK_EVENTS = [
  "SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion", "PreSkillShellCommand", "PreToolUse", "PermissionRequest",
  "PermissionDenied", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "MessageDisplay", "SubagentStart",
  "SubagentStop", "TaskCreated", "TaskCompleted", "Stop", "StopFailure", "TeammateIdle", "InstructionsLoaded", "ConfigChange",
  "CwdChanged", "DirectoryAdded", "FileChanged", "WorktreeCreate", "WorktreeRemove", "PreCompact", "PostCompact", "PreModelSwitch",
  "PostModelSwitch", "Elicitation", "ElicitationResult", "SessionEnd",
] as const;

/** What a hook's `text` is cut to (a command can be a whole script). */
export const HOOK_TEXT_MAX = 4000;

const SOURCE_ORDER: Record<HookSource, number> = { user: 0, project: 1, local: 2, plugin: 3, managed: 4 };

type Raw = Record<string, unknown>;

function obj(v: unknown): Raw | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
}

function readJson(path: string, read: (p: string) => string | null): Raw | null {
  const text = read(path);
  if (text === null) return null;
  try {
    return obj(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function cut(s: string): string {
  const t = wellFormed(s).trim();
  return t.length > HOOK_TEXT_MAX ? `${t.slice(0, HOOK_TEXT_MAX - 1)}…` : t;
}

/** An exec-form argument as a shell would show it. */
function shown(arg: string): string {
  return /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** What a handler runs, by its type: the command (with its `args`), the URL, the MCP tool, the prompt. */
function handlerText(h: Raw): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (h.type) {
    case "http":
      return str(h.url);
    case "mcp_tool":
      return [str(h.server), str(h.tool)].filter(Boolean).join(" › ");
    case "prompt":
    case "agent":
      return str(h.prompt);
    default: {
      const args = Array.isArray(h.args) ? h.args.filter((a): a is string => typeof a === "string") : [];
      return [str(h.command), ...args.map(shown)].filter(Boolean).join(" ");
    }
  }
}

/** The `hooks` object of one settings file (or a plugin's `hooks.json`) as entries. */
export function hookEntriesOf(hooks: unknown, from: { source: HookSource; path: string; plugin?: string }): HookEntry[] {
  const byEvent = obj(hooks);
  if (!byEvent) return [];
  const out: HookEntry[] = [];
  for (const event of Object.keys(byEvent)) {
    const groups = Array.isArray(byEvent[event]) ? (byEvent[event] as unknown[]) : [];
    for (const g of groups) {
      const group = obj(g);
      const list = group?.hooks;
      if (!group || !Array.isArray(list)) continue;
      const matcher = typeof group.matcher === "string" ? wellFormed(group.matcher) : "";
      for (const item of list) {
        const h = obj(item);
        if (!h) continue;
        const type = typeof h.type === "string" && h.type.trim() ? wellFormed(h.type) : "command";
        const entry: HookEntry = { event: wellFormed(event), matcher: matcher === "*" ? "" : matcher, type, text: cut(handlerText(h)), source: from.source, path: wellFormed(from.path) };
        if (from.plugin) entry.plugin = wellFormed(from.plugin);
        if (typeof h.if === "string" && h.if.trim()) entry.if = cut(h.if);
        if (typeof h.timeout === "number" && Number.isFinite(h.timeout) && h.timeout > 0) entry.timeout = h.timeout;
        if (h.async === true) entry.async = true;
        if (typeof h.statusMessage === "string" && h.statusMessage.trim()) entry.statusMessage = cut(h.statusMessage);
        out.push(entry);
      }
    }
  }
  return out;
}

function eventRank(event: string): number {
  const i = (HOOK_EVENTS as readonly string[]).indexOf(event);
  return i < 0 ? HOOK_EVENTS.length : i;
}

/** In the terminal's order: by event (lifecycle), then by where it is defined, then as written. */
export function sortHooks(hooks: HookEntry[]): HookEntry[] {
  return hooks
    .map((h, i) => ({ h, i }))
    .sort((a, b) => eventRank(a.h.event) - eventRank(b.h.event) || a.h.event.localeCompare(b.h.event)
      || SOURCE_ORDER[a.h.source] - SOURCE_ORDER[b.h.source] || a.i - b.i)
    .map(({ h }) => h);
}

export type HooksListOptions = {
  /** `<config>` (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
  configDir: string;
  /** The session's folder (null: no project — only the user's and the managed hooks). */
  cwd: string | null;
  loadUser: boolean;
  loadLocal: boolean;
  /** The plugins the session loaded (enabled): their `hooks/hooks.json`. */
  plugins: { name: string; path: string | null }[];
  /** ReviewGate's "turn off my hooks" (`settings.disableUserHooks`: the flag layer's `disableAllHooks`). */
  appHooksOff: boolean;
  /** The managed tier's settings and where it comes from (null: none). */
  managed: { settings: Raw | null; path: string | null };
  read?: (path: string) => string | null;
  /** Path rules (default: this platform's); tests pass `path.win32`. */
  pathApi?: PlatformPath;
};

/**
 * `hooks_list`: every hook of the files the session loads, whether each runs, and the files themselves (for Open in
 * Editor, also when a file has none yet). As the CLI: `disableAllHooks` of the highest settings file that sets it turns
 * off the settings and plugin hooks (ReviewGate's switch is that flag); only the managed tier's turns off its own; the
 * managed `allowManagedHooksOnly` leaves only the managed ones.
 */
export function listHooks(opts: HooksListOptions): Omit<HooksListEvent, "type" | "id"> {
  const pa = opts.pathApi ?? path;
  const read = opts.read ?? ((p: string) => safeReadOrNull(p));
  const files: HookFile[] = [];
  const hooks: HookEntry[] = [];
  let disableAll: boolean | null = null;
  const settingsFile = (source: "user" | "project" | "local", path: string) => {
    const data = readJson(path, read);
    const found = data ? hookEntriesOf(data.hooks, { source, path }) : [];
    files.push({ source, path: wellFormed(path), exists: read(path) !== null, count: found.length });
    hooks.push(...found);
    if (data && typeof data.disableAllHooks === "boolean") disableAll = data.disableAllHooks; // the later (higher) file wins
  };
  if (opts.loadUser) settingsFile("user", pa.join(opts.configDir, "settings.json"));
  if (opts.cwd) {
    settingsFile("project", pa.join(opts.cwd, ".claude", "settings.json"));
    if (opts.loadLocal) settingsFile("local", pa.join(opts.cwd, ".claude", "settings.local.json"));
  }
  for (const p of opts.plugins) {
    if (!p.path || p.path === "builtin") continue;
    const path = pa.join(p.path, "hooks", "hooks.json");
    const text = read(path);
    if (text === null) continue;
    let data: Raw | null = null;
    try {
      data = obj(JSON.parse(text) as unknown);
    } catch {
      data = null;
    }
    const found = hookEntriesOf(data?.hooks, { source: "plugin", path, plugin: p.name });
    files.push({ source: "plugin", plugin: wellFormed(p.name), path: wellFormed(path), exists: true, count: found.length });
    hooks.push(...found);
  }
  const managed = opts.managed.settings;
  const managedHooks = managed ? hookEntriesOf(managed.hooks, { source: "managed", path: opts.managed.path ?? "managed settings" }) : [];
  if (managed && opts.managed.path) files.push({ source: "managed", path: wellFormed(opts.managed.path), exists: true, count: managedHooks.length });
  hooks.push(...managedHooks);

  const managedOff = managed?.disableAllHooks === true;
  const managedOnly = managed?.allowManagedHooksOnly === true;
  const off: HooksListEvent["off"] = managedOff ? "managed" : managedOnly ? "managed_only" : opts.appHooksOff ? "app" : disableAll === true ? "settings" : null;
  for (const h of hooks) h.active = h.source === "managed" ? !managedOff : off === null;
  return { hooks: sortHooks(hooks), files, off };
}
