import type { SlashCommandInfo, SlashCommandSource } from "../protocol.js";
import { mcpToolName } from "./permissionRules.js";

/**
 * §36.5 (audit SME-03): the palette's commands — the CLI's `SlashCommand`s (`initializationResult().commands`, about a
 * second after the start with no message needed, then every `system/commands_changed`) with where each one comes from.
 * What CLI 2.1.309 sends (probed, docs/PROTOCOL.md §36.5): its own commands carry `builtin: true`; a command or skill
 * under `~/.claude` / `<root>/.claude` ends its description with " (user)" / " (project)" (a subfolder command is
 * `<folder>:<name>`); a plugin's is `<plugin>:<name>`; an MCP prompt is listed as `<server>:<prompt> (MCP)` and invoked
 * as `/mcp__<server>__<prompt>` (the `system/init` `slash_commands` spelling, which is what the palette inserts). Pure.
 */

/** A description is one line of at most this many chars (the state snapshot carries every command). */
export const COMMAND_DESCRIPTION_MAX = 200;
export const COMMAND_HINT_MAX = 120;
const MAX_COMMANDS = 1000;
const MAX_ALIASES = 10;
const SOURCES = new Set<SlashCommandSource>(["builtin", "user", "project", "plugin", "mcp", "unknown"]);
const SOURCE_MARK_RE = /\s+\((user|project)\)$/;
/** `<server>:<prompt> (MCP)`, split at the last colon: a plugin's server is named `plugin:<plugin>:<server>`. */
const MCP_PROMPT_RE = /^(.+):([^:]+?)\s+\(MCP\)$/;
/** A skill of the user's claude.ai account ("docx", "pdf", …): its alias names the set (`anthropic-skills:docx`). */
const CLAUDE_AI_MARK_RE = /\s+\(claude\.ai sync\)$/;

function oneLine(s: string, max: number): string {
  const line = (s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "").replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function aliasesOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [...new Set(v.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map((a) => a.trim()))].slice(0, MAX_ALIASES);
  return out.length > 0 ? out : undefined;
}

/**
 * The CLI's commands as `capabilities.commands`; null when `raw` is not a list. A CLI that marks none of its commands
 * `builtin` (older than the field) has its plain names counted as built-in; otherwise a plain name nothing marks is `unknown`.
 */
export function toCommandInfos(raw: unknown): SlashCommandInfo[] | null {
  if (!Array.isArray(raw)) return null;
  const entries = raw.slice(0, MAX_COMMANDS).filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c));
  const marksBuiltins = entries.some((c) => "builtin" in c);
  const out: SlashCommandInfo[] = [];
  const seen = new Set<string>();
  for (const c of entries) {
    if (typeof c.name !== "string") continue;
    let name = c.name.trim().replace(/^\//, "");
    if (!name) continue;
    let description = typeof c.description === "string" ? c.description.trim() : "";
    const rawHint = typeof c.argumentHint === "string" ? c.argumentHint.trim() : "";
    let source: SlashCommandSource;
    let plugin: string | undefined;
    let server: string | undefined;
    const mcp = MCP_PROMPT_RE.exec(name);
    const mark = SOURCE_MARK_RE.exec(description);
    const synced = CLAUDE_AI_MARK_RE.exec(description);
    if (c.builtin === true) source = "builtin";
    else if (mcp) {
      source = "mcp";
      server = mcp[1]!.trim();
      name = mcpToolName(server, mcp[2]!.trim());
    } else if (mark) {
      source = mark[1] as "user" | "project";
      description = description.slice(0, mark.index);
    } else if (synced) {
      // Grouped like the plugin skills they read as elsewhere (`anthropic-skills:docx`).
      source = "plugin";
      const namespaced = (aliasesOf(c.aliases) ?? []).find((a) => a.includes(":"));
      plugin = namespaced ? namespaced.slice(0, namespaced.indexOf(":")) : "claude.ai";
      description = description.slice(0, synced.index);
    } else if (name.includes(":")) {
      source = "plugin";
      plugin = name.slice(0, name.indexOf(":"));
    } else source = marksBuiltins ? "unknown" : "builtin";
    if (seen.has(name)) continue;
    seen.add(name);
    const aliases = aliasesOf(c.aliases);
    out.push({
      name,
      description: oneLine(description, COMMAND_DESCRIPTION_MAX),
      // The CLI prints a YAML list hint as "[object Object]" (seen in 2.1.309): no hint is better than that.
      argumentHint: rawHint === "[object Object]" ? "" : oneLine(rawHint, COMMAND_HINT_MAX),
      source,
      ...(plugin ? { plugin } : {}),
      ...(server ? { server } : {}),
      ...(aliases ? { aliases } : {}),
    });
  }
  return out;
}

/** `capabilities.commands` as `<gitdir>/reviewgate/capabilities.json` kept it, re-validated; undefined for an older cache. */
export function cachedCommands(raw: unknown): SlashCommandInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SlashCommandInfo[] = [];
  for (const c of raw.slice(0, MAX_COMMANDS)) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name) continue;
    const source = typeof o.source === "string" && SOURCES.has(o.source as SlashCommandSource) ? (o.source as SlashCommandSource) : "unknown";
    const aliases = aliasesOf(o.aliases);
    out.push({
      name: o.name,
      description: typeof o.description === "string" ? oneLine(o.description, COMMAND_DESCRIPTION_MAX) : "",
      argumentHint: typeof o.argumentHint === "string" ? oneLine(o.argumentHint, COMMAND_HINT_MAX) : "",
      source,
      ...(typeof o.plugin === "string" && o.plugin ? { plugin: o.plugin } : {}),
      ...(typeof o.server === "string" && o.server ? { server: o.server } : {}),
      ...(aliases ? { aliases } : {}),
    });
  }
  return out;
}
