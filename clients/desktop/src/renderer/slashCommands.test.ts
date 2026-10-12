/**
 * MARK: wave3 desktop-session — §36.5 (SME-03): the slash palette's entries from `capabilities.commands` (the §36.5 JSON
 * example), groups, recently used first, the ranking of a typed /token and the empty states — the same rules as the Mac's
 * SlashCommandCatalog so both clients list the same thing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionCapabilities } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import {
  capabilitiesCaption,
  flattenSections,
  freshCapabilities,
  groupTitle,
  loadSlashRecents,
  paletteEmptyState,
  paletteEmptyText,
  recordRecent,
  RECENT_LIMIT,
  RECENT_MEMORY,
  saveSlashRecents,
  sessionStarting,
  slashCommandIn,
  slashEntries,
  slashSections,
  type SlashEntry,
} from "./slashCommands";

/** The §36.5 example, plus a user command, a project skill, an MCP prompt and an unknown one. */
const caps = (more: Partial<SessionCapabilities> = {}): SessionCapabilities => ({
  slashCommands: ["mcp", "team-plugin:team-dev", "review", "deploy", "github:pr", "old-name-only"],
  skills: ["team-plugin:team-dev", "deploy"],
  plugins: ["team-plugin"],
  mcpServers: [],
  state: "ready",
  commands: [
    { name: "mcp", description: "Manage MCP servers", argumentHint: "[reconnect|enable|disable [<server>|all]]", source: "builtin" },
    { name: "team-plugin:team-dev", description: "이슈 기반 개발\nsecond line", argumentHint: "<이슈 번호>", source: "plugin", plugin: "team-plugin" },
    { name: "review", description: "Review a PR", argumentHint: "", source: "user", aliases: ["rv"] },
    { name: "deploy", description: "Deploy the service", argumentHint: " <env> ", source: "project" },
    { name: "github:pr", description: "Open a pull request", argumentHint: "", source: "mcp", server: "github" },
    { name: "weird", description: "", argumentHint: "", source: "unknown" },
  ],
  ...more,
});

const names = (entries: SlashEntry[]) => entries.map((e) => e.name);

describe("slash palette entries (§36.5)", () => {
  it("takes description, argument hint and source from capabilities.commands; names-only leftovers follow", () => {
    const all = slashEntries(caps());
    const dev = all.find((e) => e.name === "team-plugin:team-dev")!;
    expect(dev).toMatchObject({ description: "이슈 기반 개발", argumentHint: "<이슈 번호>", isSkill: true, group: { kind: "plugin", name: "team-plugin" } });
    expect(all.find((e) => e.name === "mcp")).toMatchObject({ description: "Manage MCP servers", argumentHint: "[reconnect|enable|disable [<server>|all]]", group: { kind: "builtin" } });
    expect(all.find((e) => e.name === "deploy")).toMatchObject({ argumentHint: "<env>", isSkill: true, group: { kind: "project" } });
    expect(all.find((e) => e.name === "review")).toMatchObject({ aliases: ["rv"], group: { kind: "mine" } });
    expect(all.find((e) => e.name === "github:pr")?.group).toEqual({ kind: "mcp", server: "github" });
    expect(all.find((e) => e.name === "weird")?.group).toEqual({ kind: "other" });
    // A name only `slashCommands` has (an older cache) is still listed, without a description.
    expect(all.find((e) => e.name === "old-name-only")).toMatchObject({ description: "", argumentHint: "", group: { kind: "other" } });
    expect(names(all)).toEqual([...names(all)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    expect(new Set(names(all)).size).toBe(all.length);
  });

  it("an engine before §36 sends names only: skills flagged, a <plugin>: prefix of a known plugin groups it", () => {
    const old: SessionCapabilities = { slashCommands: ["compact", "team-plugin:team-task"], skills: ["team-plugin:team-task", "my-skill"], plugins: ["team-plugin"], mcpServers: [] };
    const all = slashEntries(old);
    expect(names(all)).toEqual(["compact", "my-skill", "team-plugin:team-task"]);
    expect(all.find((e) => e.name === "team-plugin:team-task")).toMatchObject({ isSkill: true, group: { kind: "plugin", name: "team-plugin" } });
    expect(all.find((e) => e.name === "compact")?.group).toEqual({ kind: "other" });
    expect(slashEntries(null)).toEqual([]);
  });

  it("ignores malformed command rows (lenient decoding)", () => {
    const bad = caps({ commands: [{ name: "" }, null, { name: 3 }, { name: "ok", description: 5, argumentHint: null, source: "nope" }] as unknown as SessionCapabilities["commands"] });
    const ok = slashEntries(bad).find((e) => e.name === "ok")!;
    expect(ok).toMatchObject({ description: "", argumentHint: "", group: { kind: "other" } });
  });
});

describe("palette sections (§36.5)", () => {
  it("without a query: recently used (≤ 5) first, then built-in / mine / project / each plugin / MCP / other", () => {
    const all = slashEntries(caps());
    const plain = slashSections(all, "", []);
    expect(plain.map((s) => s.group.kind)).toEqual(["builtin", "mine", "project", "plugin", "mcp", "other"]);
    const sections = slashSections(all, "", ["deploy", "gone-command", "mcp"]);
    expect(names(sections[0]!.entries)).toEqual(["deploy", "mcp"]);
    // A recent one is not repeated in its own group; the groups it emptied (built-in, project) are left out.
    expect(sections.map((s) => s.group.kind)).toEqual(["recent", "mine", "plugin", "mcp", "other"]);
    expect(names(sections[4]!.entries)).toEqual(["old-name-only", "weird"]);
    const flat = flattenSections(sections);
    expect(new Set(names(flat)).size).toBe(flat.length);
    expect(flat.length).toBe(all.length);
  });

  it("caps the recent group at five", () => {
    const all = Array.from({ length: 8 }, (_, i): SlashEntry => ({ name: `c${i}`, description: "", argumentHint: "", isSkill: false, aliases: [], group: { kind: "other" } }));
    const sections = slashSections(all, "", all.map((e) => e.name));
    expect(sections[0]!.entries.length).toBe(RECENT_LIMIT);
  });

  it("a query ranks name prefix, a word of the name, inside the name or an alias, then the description; recent first within a tier", () => {
    const all = slashEntries(caps());
    const ranked = (q: string, recents: string[] = []) => names(flattenSections(slashSections(all, q, recents)));
    // "team-dev" is a word of team-plugin:team-dev (tier 1).
    expect(ranked("team-dev")).toEqual(["team-plugin:team-dev"]);
    // "de": deploy (prefix) before team-plugin:team-dev (word "dev") before the description match.
    expect(ranked("de").slice(0, 2)).toEqual(["deploy", "team-plugin:team-dev"]);
    // an alias (tier 2) before descriptions that happen to contain the letters ("se-rv-ice", "se-rv-ers")
    expect(ranked("rv")).toEqual(["review", "deploy", "mcp"]);
    // description only
    expect(ranked("pull request")).toEqual(["github:pr"]);
    expect(ranked("이슈")).toEqual(["team-plugin:team-dev"]);
    // one list, no header
    expect(slashSections(all, "m", []).map((s) => s.group.kind)).toEqual(["matches"]);
    expect(slashSections(all, "zzz", [])).toEqual([]);
    // the same tier: recently used first
    expect(ranked("r", ["review"])[0]).toBe("review");
  });

  it("group titles: Built-in / My commands / Project / the plugin's name / MCP · server", () => {
    expect(groupTitle({ kind: "builtin" })).toBe("Built-in");
    expect(groupTitle({ kind: "mine" })).toBe("My commands");
    expect(groupTitle({ kind: "project" })).toBe("Project");
    expect(groupTitle({ kind: "plugin", name: "team-plugin" })).toBe("team-plugin");
    expect(groupTitle({ kind: "mcp", server: "github" })).toBe("MCP · github");
    expect(groupTitle({ kind: "mcp", server: null })).toBe("MCP");
    expect(groupTitle({ kind: "recent" })).toBe("Recently used");
    expect(groupTitle({ kind: "matches" })).toBeNull();
  });
});

describe("empty states and the caption (§36.5, SME-03)", () => {
  beforeAll(() => initI18n("ko", "darwin"));
  afterAll(() => initI18n("en", "darwin"));

  const starting = { starting: true, loadUserSettings: true };
  it("'Starting session…' while the CLI starts — never 'enable user settings' when they are on", () => {
    expect(paletteEmptyState({ caps: null, entries: [], shown: [], ...starting })).toBe("starting");
    const empty: SessionCapabilities = { slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "starting" };
    expect(paletteEmptyState({ caps: empty, entries: [], shown: [], starting: false, loadUserSettings: true })).toBe("starting");
    expect(paletteEmptyText("starting")).toBe("세션 준비 중…");
  });

  it("an older engine after the start says the list comes with the first message; user settings off says so", () => {
    expect(paletteEmptyState({ caps: null, entries: [], shown: [], starting: false, loadUserSettings: true })).toBe("afterFirstMessage");
    expect(paletteEmptyState({ caps: null, entries: [], shown: [], starting: false, loadUserSettings: false })).toBe("userSettingsOff");
    expect(paletteEmptyText("afterFirstMessage")).toBe("명령 목록은 첫 메시지를 보낸 뒤에 받아요");
  });

  it("nothing matching the typed text is 'No matching command'; something shown is no empty state", () => {
    const all = slashEntries(caps());
    expect(paletteEmptyState({ caps: caps(), entries: all, shown: [], starting: false, loadUserSettings: true })).toBe("noMatch");
    expect(paletteEmptyState({ caps: caps(), entries: all, shown: all, starting: true, loadUserSettings: true })).toBeNull();
  });

  it("the composer caption: counts (cached), 'Starting session…' for empty starting lists, the empty text without capabilities", () => {
    expect(capabilitiesCaption({ caps: caps(), cached: true, mcpCount: 2, starting: false, loadUserSettings: true })).toBe("스킬 2 · 커맨드 6 · MCP 서버 2 (캐시됨)");
    const empty: SessionCapabilities = { slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "starting" };
    expect(capabilitiesCaption({ caps: empty, cached: false, mcpCount: 0, starting: true, loadUserSettings: true })).toBe("세션 준비 중…");
    expect(capabilitiesCaption({ caps: null, cached: false, mcpCount: 0, starting: false, loadUserSettings: false })).toBe("로드된 스킬 없음 — 설정 → 사용자 설정 불러오기를 켜세요");
  });

  it("freshCapabilities: neither the engine's replayed cache nor the empty lists of a start", () => {
    const empty: SessionCapabilities = { slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "starting" };
    expect(freshCapabilities({ capabilities: null })).toBeNull();
    expect(freshCapabilities({ capabilities: empty })).toBeNull();
    expect(freshCapabilities({ capabilities: caps(), capabilitiesCached: true })).toBeNull();
    expect(freshCapabilities({ capabilities: caps(), capabilitiesCached: false })).not.toBeNull();
    // An engine before §36: no state → ready.
    const { state: _s, commands: _c, ...old } = caps();
    expect(freshCapabilities({ capabilities: old, capabilitiesCached: false })).not.toBeNull();
  });

  it("sessionStarting: starting, open but not ready, or capabilities.state starting", () => {
    expect(sessionStarting({ starting: true, open: false })).toBe(true);
    expect(sessionStarting({ starting: false, open: true, ready: false })).toBe(true);
    expect(sessionStarting({ starting: false, open: true, ready: true, capabilities: { slashCommands: [], skills: [], plugins: [], mcpServers: [], state: "starting" } })).toBe(true);
    expect(sessionStarting({ starting: false, open: true, ready: true, capabilities: caps() })).toBe(false);
    // An engine without `ready` / `state`: only the start itself.
    expect(sessionStarting({ starting: false, open: true })).toBe(false);
  });
});

describe("recently used commands (per project)", () => {
  it("a sent message that starts with a known command (or an alias) counts as using it", () => {
    const all = slashEntries(caps());
    expect(slashCommandIn("/team-plugin:team-dev 4707", all)).toBe("team-plugin:team-dev");
    expect(slashCommandIn("  /rv now", all)).toBe("review");
    expect(slashCommandIn("/unknown x", all)).toBeNull();
    expect(slashCommandIn("hello /mcp", all)).toBeNull();
    expect(slashCommandIn("/", all)).toBeNull();
  });

  it("moves the name to the front and keeps at most twenty", () => {
    const many = Array.from({ length: 25 }, (_, i) => `c${i}`);
    expect(recordRecent("c3", ["c1", "c3", "c2"])).toEqual(["c3", "c1", "c2"]);
    expect(recordRecent("new", many).length).toBe(RECENT_MEMORY);
    expect(recordRecent("new", many)[0]).toBe("new");
  });

  it("persists per project in localStorage and survives a broken store", () => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveSlashRecents("abcd1234", ["mcp", "deploy"], ls);
    expect(loadSlashRecents("abcd1234", ls)).toEqual(["mcp", "deploy"]);
    expect(loadSlashRecents("ffff0000", ls)).toEqual([]);
    expect(loadSlashRecents(null, ls)).toEqual([]);
    store.set("rg.slashRecents.abcd1234", "{not json");
    expect(loadSlashRecents("abcd1234", ls)).toEqual([]);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadSlashRecents("abcd1234", throwing)).toEqual([]);
    expect(() => saveSlashRecents("abcd1234", ["x"], throwing)).not.toThrow();
  });
});
