import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionHook, NotAppliedLocalSettings } from "../protocol.js";
import { LOCAL_SETTINGS } from "../git/mods.js";

/**
 * §36.6 (audit SME-01): what the terminal loads besides user / project settings — `<root>/.claude/settings.local.json`
 * (hooks, env, allow rules, …) and the local-scope MCP servers (`<config>/.claude.json` with `CLAUDE_CONFIG_DIR`, else
 * `~/.claude.json`: `projects[<project path>].mcpServers`). The CLI loads both with `settingSources` "local" (verified
 * against CLI 2.1.309: a local SessionStart hook ran with the local env, the local MCP server connected with source
 * "local"). When the app does not apply them, `notApplied` names what is left out — names, commands (≤ 200 chars) and
 * counts only, never a value. Pure reads.
 */

/** A hook command shown in `notApplied.hooks` is cut to this many chars. */
export const NOT_APPLIED_COMMAND_MAX = 200;
/** `~/.claude.json` can be megabytes: read once per (mtime, size). */
let claudeJsonCache: { path: string; mtimeMs: number; size: number; projects: Record<string, unknown> | null } | null = null;

export function localSettingsPath(root: string): string {
  return join(root, ...LOCAL_SETTINGS.split("/"));
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function cut(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** `hooks` of a settings object → `{event, command}` per command hook (other hook types have no command to show). */
function hookCommands(hooks: unknown): { event: string; command: string }[] {
  const out: { event: string; command: string }[] = [];
  const byEvent = obj(hooks);
  if (!byEvent) return out;
  for (const event of Object.keys(byEvent).sort()) {
    const matchers = Array.isArray(byEvent[event]) ? (byEvent[event] as unknown[]) : [];
    for (const m of matchers) {
      const list = obj(m)?.hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        const hook = obj(h);
        if (hook && typeof hook.command === "string" && hook.command.trim()) out.push({ event, command: cut(hook.command, NOT_APPLIED_COMMAND_MAX) });
      }
    }
  }
  return out;
}

/** `<config>/.claude.json` (CLAUDE_CONFIG_DIR) or `~/.claude.json` — the CLI's global config holding the local-scope MCP servers. */
export function claudeJsonPath(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir && dir.trim() ? join(resolve(dir), ".claude.json") : join(homedir(), ".claude.json");
}

function claudeJsonProjects(path: string): Record<string, unknown> | null {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  if (claudeJsonCache && claudeJsonCache.path === path && claudeJsonCache.mtimeMs === st.mtimeMs && claudeJsonCache.size === st.size) return claudeJsonCache.projects;
  const projects = obj(readJsonObject(path)?.projects);
  claudeJsonCache = { path, mtimeMs: st.mtimeMs, size: st.size, projects };
  return projects;
}

/** Names of the local-scope MCP servers of the project (keyed by its path as given or symlink-resolved, and its root). */
export function localMcpServerNames(opts: { root: string; projectPath: string; env: Record<string, string | undefined> }): string[] {
  const projects = claudeJsonProjects(claudeJsonPath(opts.env));
  if (!projects) return [];
  const keys = new Set<string>();
  for (const p of [opts.projectPath, opts.root]) {
    keys.add(p);
    try {
      keys.add(realpathSync(p));
    } catch {
      // a path that does not resolve is looked up as given
    }
  }
  const names = new Set<string>();
  for (const k of keys) {
    const servers = obj(obj(projects[k])?.mcpServers);
    if (servers) for (const n of Object.keys(servers)) names.add(n);
  }
  return [...names].sort();
}

/**
 * `extensions.notApplied`: what the local settings hold that a session without `local` does not apply; null when they hold
 * none of it (or cannot be read).
 */
export function notAppliedLocalSettings(opts: { root: string; projectPath: string; env: Record<string, string | undefined> }): NotAppliedLocalSettings | null {
  const local = readJsonObject(localSettingsPath(opts.root));
  const hooks = hookCommands(local?.hooks);
  const envKeys = Object.keys(obj(local?.env) ?? {}).sort();
  const allow = obj(local?.permissions)?.allow;
  const allowRuleCount = Array.isArray(allow) ? allow.filter((r) => typeof r === "string" && r.trim()).length : 0;
  const mcpServers = localMcpServerNames(opts);
  if (hooks.length === 0 && envKeys.length === 0 && allowRuleCount === 0 && mcpServers.length === 0) return null;
  return { hooks, envKeys, mcpServers, allowRuleCount };
}

/**
 * The applied local hooks as a hook source of `extensions.hooks` (§16). `source: "project"` — the file is the project's
 * (`ExtensionHook.source` has no `local`; the path says which file); `active` false when `disableUserHooks` turns them off.
 */
export function localHookSources(root: string, disabled: boolean): ExtensionHook[] {
  const path = localSettingsPath(root);
  if (!existsSync(path)) return [];
  const hooks = obj(readJsonObject(path)?.hooks);
  const events = hooks ? Object.keys(hooks).sort() : [];
  return events.length > 0 ? [{ source: "project", path, events, active: !disabled }] : [];
}
