/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.5 on the client (SME-03), pure and unit-tested: the slash palette's entries — name, one-line
 * description and dimmed argument hint from `capabilities.commands` — grouped by where they come from (built-in / mine /
 * project / each plugin / MCP) with this project's recently used commands first, the ranking of a typed /token and the
 * empty states ("Starting session…" while the CLI starts — never "enable user settings" when they are on). The same rules
 * as the Mac's SlashCommandCatalog, so both clients list the same thing.
 */
import type { SessionCapabilities, SlashCommandInfo, SlashCommandSource } from "@reviewgate/engine";
import { t } from "./i18n";
import { withAppMeanings } from "./slashBuiltins"; // MARK: wave4c w4c-commit (§41.1)

/** A palette group, in display order. */
export type SlashGroup =
  /** This project's recently used commands (no query). */
  | { kind: "recent" }
  | { kind: "builtin" }
  /** The user's own commands and skills (`~/.claude`). */
  | { kind: "mine" }
  /** `<root>/.claude`. */
  | { kind: "project" }
  | { kind: "plugin"; name: string }
  /** An MCP server's prompts (server name when known). */
  | { kind: "mcp"; server: string | null }
  /** Not known where from (an engine before §36 sends names only). */
  | { kind: "other" }
  /** The ranked results of a query: one list, no header. */
  | { kind: "matches" };

/** One command of the palette. */
export type SlashEntry = {
  /** Without the leading slash. */
  name: string;
  /** One line (the first line of what the CLI reports); "" when unknown. */
  description: string;
  /** "" when the command takes none. */
  argumentHint: string;
  isSkill: boolean;
  aliases: string[];
  /** Where it comes from (never `recent` / `matches`). */
  group: SlashGroup;
};

export type SlashSection = { group: SlashGroup; entries: SlashEntry[] };

/** Why the palette has nothing to list. */
export type PaletteEmptyState =
  /** The CLI has not answered initialize yet. */
  | "starting"
  /** An engine before §36 reports the commands with the first message only. */
  | "afterFirstMessage"
  /** "Load user settings" is off: the user's skills and commands are not loaded. */
  | "userSettingsOff"
  /** Nothing matches the typed text. */
  | "noMatch";

/** How many recently used commands lead the palette. */
export const RECENT_LIMIT = 5;
/** How many are remembered per project. */
export const RECENT_MEMORY = 20;

const SOURCES: ReadonlySet<SlashCommandSource> = new Set(["builtin", "user", "project", "plugin", "mcp", "unknown"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `capabilities.commands`, each row checked (a cache written by another build, a field missing): malformed rows are left out. */
function commandsOf(caps: SessionCapabilities): SlashCommandInfo[] {
  const raw = (caps as { commands?: unknown }).commands;
  if (!Array.isArray(raw)) return [];
  const out: SlashCommandInfo[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const name = str(r.name).trim().replace(/^\//, "");
    if (!name) continue;
    const source = SOURCES.has(r.source as SlashCommandSource) ? (r.source as SlashCommandSource) : "unknown";
    out.push({
      name,
      description: str(r.description),
      argumentHint: str(r.argumentHint),
      source,
      ...(typeof r.plugin === "string" && r.plugin ? { plugin: r.plugin } : {}),
      ...(typeof r.server === "string" && r.server ? { server: r.server } : {}),
      ...(Array.isArray(r.aliases) ? { aliases: r.aliases.filter((a): a is string => typeof a === "string" && a.length > 0) } : {}),
    });
  }
  return out;
}

function prefixOf(name: string): string | null {
  const i = name.indexOf(":");
  return i > 0 ? name.slice(0, i) : null;
}

function groupFor(command: SlashCommandInfo): SlashGroup {
  switch (command.source) {
    case "builtin":
      return { kind: "builtin" };
    case "user":
      return { kind: "mine" };
    case "project":
      return { kind: "project" };
    case "plugin":
      return { kind: "plugin", name: command.plugin ?? prefixOf(command.name) ?? t("Plugin") };
    case "mcp":
      return { kind: "mcp", server: command.server ?? null };
    default:
      return { kind: "other" };
  }
}

/** A name without a source: a `<plugin>:` prefix of a known plugin, else unknown. */
function inferredGroup(name: string, plugins: ReadonlySet<string>): SlashGroup {
  const prefix = prefixOf(name);
  return prefix && plugins.has(prefix) ? { kind: "plugin", name: prefix } : { kind: "other" };
}

const firstLine = (text: string): string => (text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").trim();
const byName = (a: SlashEntry, b: SlashEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * Every command the session knows, once each: `commands` (with descriptions and source) first, then the bare names of
 * `skills` / `slashCommands` the list did not have (an engine before §36 sends names only). Sorted by name.
 */
export function slashEntries(caps: SessionCapabilities | null): SlashEntry[] {
  if (!caps) return [];
  const skills = new Set(Array.isArray(caps.skills) ? caps.skills : []);
  const plugins = new Set(Array.isArray(caps.plugins) ? caps.plugins : []);
  const seen = new Set<string>();
  const out: SlashEntry[] = [];
  for (const c of commandsOf(caps)) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, description: firstLine(c.description), argumentHint: c.argumentHint.trim(), isSkill: skills.has(c.name), aliases: c.aliases ?? [], group: groupFor(c) });
  }
  for (const name of [...skills, ...(Array.isArray(caps.slashCommands) ? caps.slashCommands : [])]) {
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: "", argumentHint: "", isSkill: skills.has(name), aliases: [], group: inferredGroup(name, plugins) });
  }
  return withAppMeanings(out.sort(byName)); // wave4c w4c-commit: /clear is the app's new chat (§41.1)
}

function groupRank(g: SlashGroup): number {
  switch (g.kind) {
    case "recent":
    case "matches":
      return 0;
    case "builtin":
      return 1;
    case "mine":
      return 2;
    case "project":
      return 3;
    case "plugin":
      return 4;
    case "mcp":
      return 5;
    case "other":
      return 6;
  }
}

/** A stable key per group (plugins and MCP servers by name). */
export function groupKey(g: SlashGroup): string {
  if (g.kind === "plugin") return `plugin:${g.name}`;
  if (g.kind === "mcp") return `mcp:${g.server ?? ""}`;
  return g.kind;
}

const sortName = (g: SlashGroup): string => (g.kind === "plugin" ? g.name.toLowerCase() : g.kind === "mcp" ? (g.server ?? "").toLowerCase() : "");

/** The section header; null for ranked matches. */
export function groupTitle(g: SlashGroup): string | null {
  switch (g.kind) {
    case "recent":
      return t("Recently used");
    case "builtin":
      return t("Built-in");
    case "mine":
      return t("My commands");
    case "project":
      return t("Project");
    case "plugin":
      return g.name;
    case "mcp":
      return g.server ? `MCP · ${g.server}` : "MCP";
    case "other":
      return t("Commands");
    case "matches":
      return null;
  }
}

/** 0 name prefix, 1 a word of the name, 2 inside the name or an alias, 3 the description; null = no match. */
function matchTier(e: SlashEntry, q: string): number | null {
  const name = e.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.split(/[:\-_/.]/).some((w) => w.startsWith(q))) return 1;
  if (name.includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q))) return 2;
  if (e.description.toLowerCase().includes(q)) return 3;
  return null;
}

/**
 * The palette for `query` (the text after `/`). Without a query: up to five recently used commands, then every group in
 * order (a command shows once). With one: a single ranked list — name prefix, a word of the name (`writer-deck` in
 * `writer-kit:writer-deck`), anywhere in the name or an alias, then the description — recently used first within a tier.
 */
export function slashSections(entries: SlashEntry[], query: string, recents: string[]): SlashSection[] {
  const q = query.trim().toLowerCase();
  const recentRank = new Map<string, number>();
  recents.forEach((n, i) => {
    if (!recentRank.has(n)) recentRank.set(n, i);
  });
  if (q.length > 0) {
    const ranked: { e: SlashEntry; tier: number }[] = [];
    for (const e of entries) {
      const tier = matchTier(e, q);
      if (tier !== null) ranked.push({ e, tier });
    }
    ranked.sort((a, b) => a.tier - b.tier || (recentRank.get(a.e.name) ?? Infinity) - (recentRank.get(b.e.name) ?? Infinity) || byName(a.e, b.e));
    return ranked.length === 0 ? [] : [{ group: { kind: "matches" }, entries: ranked.map((r) => r.e) }];
  }
  const index = new Map(entries.map((e) => [e.name, e]));
  const recent: SlashEntry[] = [];
  for (const n of recents) {
    const e = index.get(n);
    if (e && !recent.includes(e)) recent.push(e);
    if (recent.length >= RECENT_LIMIT) break;
  }
  const sections: SlashSection[] = recent.length > 0 ? [{ group: { kind: "recent" }, entries: recent }] : [];
  const groups = new Map<string, SlashSection>();
  for (const e of entries) {
    if (recent.includes(e)) continue;
    const key = groupKey(e.group);
    const s = groups.get(key);
    if (s) s.entries.push(e);
    else groups.set(key, { group: e.group, entries: [e] });
  }
  const ordered = [...groups.values()].sort((a, b) => groupRank(a.group) - groupRank(b.group) || sortName(a.group).localeCompare(sortName(b.group)));
  return [...sections, ...ordered];
}

/** The sections' entries in display order (what ↑ / ↓ walk through). */
export const flattenSections = (sections: SlashSection[]): SlashEntry[] => sections.flatMap((s) => s.entries);

/** The session fields the start state reads (`ReviewState.session`). */
export type StartingFacts = { starting: boolean; open: boolean; ready?: boolean; capabilities?: SessionCapabilities | null };

/** The CLI has not answered initialize yet: the start itself, an open session not `ready`, or `capabilities.state` starting. */
export function sessionStarting(s: StartingFacts): boolean {
  return s.starting || (s.open && s.ready === false) || s.capabilities?.state === "starting";
}

/**
 * This session's own capabilities — not a replayed cache (`capabilitiesCached`), not the empty lists of a start
 * (`state: "starting"`); null otherwise. What the client keeps as its own cache, and the sign the CLI initialized.
 */
export function freshCapabilities(s: { capabilities?: SessionCapabilities | null; capabilitiesCached?: boolean }): SessionCapabilities | null {
  const caps = s.capabilities ?? null;
  if (!caps || s.capabilitiesCached === true || caps.state === "starting") return null;
  return caps;
}

/** Why nothing is listed (`shown`: the entries for the typed text); null when there is something to show. */
export function paletteEmptyState(o: { caps: SessionCapabilities | null; entries: SlashEntry[]; shown: SlashEntry[]; starting: boolean; loadUserSettings: boolean }): PaletteEmptyState | null {
  if (o.shown.length > 0) return null;
  if (o.entries.length > 0) return "noMatch";
  if (o.starting || o.caps?.state === "starting") return "starting";
  if (!o.loadUserSettings) return "userSettingsOff";
  return o.caps === null ? "afterFirstMessage" : "noMatch";
}

export function paletteEmptyText(s: PaletteEmptyState): string {
  switch (s) {
    case "starting":
      return t("Starting session…");
    case "afterFirstMessage":
      return t("The command list arrives with the first message");
    case "userSettingsOff":
      return t("no skills loaded — enable in Settings → Load user settings");
    case "noMatch":
      return t("No matching command");
  }
}

const isEmpty = (c: SessionCapabilities) => c.skills.length === 0 && c.slashCommands.length === 0 && (c.commands?.length ?? 0) === 0;

/** The composer's capabilities caption: the counts (cached), "Starting session…" for the empty starting lists, else why there are none. */
export function capabilitiesCaption(o: { caps: SessionCapabilities | null; cached: boolean; mcpCount: number; starting: boolean; loadUserSettings: boolean }): string {
  const { caps } = o;
  if (caps && !((o.starting || caps.state === "starting") && isEmpty(caps))) {
    return t("{0} skills · {1} commands · {2} MCP servers", caps.skills.length, caps.slashCommands.length, o.mcpCount) + (o.cached ? ` ${t("(cached)")}` : "");
  }
  return paletteEmptyText(paletteEmptyState({ caps, entries: [], shown: [], starting: o.starting, loadUserSettings: o.loadUserSettings }) ?? "noMatch");
}

/** The command a sent message starts with (`/writer-kit:writer-deck 1406` → `writer-kit:writer-deck`), if it is one of `entries` (or an alias). */
export function slashCommandIn(text: string, entries: SlashEntry[]): string | null {
  const m = /^\/(\S+)/.exec(text.trim());
  if (!m) return null;
  const token = m[1]!;
  if (entries.some((e) => e.name === token)) return token;
  return entries.find((e) => e.aliases.includes(token))?.name ?? null;
}

/** `recents` with `name` moved to the front, at most twenty long. */
export function recordRecent(name: string, recents: string[]): string[] {
  return [name, ...recents.filter((n) => n !== name)].slice(0, RECENT_MEMORY);
}

type KV = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function defaultStorage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const recentsKey = (hash: string) => `rg.slashRecents.${hash}`;

/** This project's recently used commands (localStorage `rg.slashRecents.<projectRootHash>`), most recent first. */
export function loadSlashRecents(hash: string | null, storage: KV | null = defaultStorage()): string[] {
  if (!hash || !storage) return [];
  try {
    const v: unknown = JSON.parse(storage.getItem(recentsKey(hash)) ?? "[]");
    return Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n.length > 0).slice(0, RECENT_MEMORY) : [];
  } catch {
    return [];
  }
}

export function saveSlashRecents(hash: string | null, recents: string[], storage: KV | null = defaultStorage()): void {
  if (!hash || !storage) return;
  try {
    storage.setItem(recentsKey(hash), JSON.stringify(recents.slice(0, RECENT_MEMORY)));
  } catch {
    /* private mode / quota: recents are a convenience */
  }
}
