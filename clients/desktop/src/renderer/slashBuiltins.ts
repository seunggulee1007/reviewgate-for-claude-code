/**
 * MARK: wave4c w4c-commit
 * docs/PROTOCOL.md §41.1 (SME-11): the CLI's built-in commands the app gives its own meaning. `/clear` (and its aliases)
 * is the app's new chat — the engine opens one instead of emptying Claude's memory under a chat that still shows it — so the
 * palette says so (as on the Mac, `SlashCommandCatalog.withAppMeanings`). §56.1: `/btw` is the app's side question (the CLI
 * lists it to the terminal only), so the palette always has it. §56.4: so is `/mcp` (the session's MCP servers over the
 * composer), the app's words over one the CLI lists.
 */
import { BTW_NAME, btwDescription } from "./btw";
import { t } from "./i18n";
import { MCP_HINT, MCP_NAME, mcpDescription } from "./mcpPalette";
import type { SlashEntry } from "./slashCommands";

export function withAppMeanings(entries: SlashEntry[]): SlashEntry[] {
  const out = entries.map((e) =>
    e.name === "clear" ? { ...e, description: t("Opens a new chat in the app — this chat stays in the list") }
    : e.name === BTW_NAME ? { ...e, description: btwDescription() }
    : e.name === MCP_NAME ? { ...e, description: mcpDescription() }
    : e,
  );
  const own = ([
    { name: BTW_NAME, description: btwDescription(), argumentHint: "<question>", isSkill: false, aliases: [], group: { kind: "builtin" as const } },
    { name: MCP_NAME, description: mcpDescription(), argumentHint: MCP_HINT, isSkill: false, aliases: [], group: { kind: "builtin" as const } },
  ] satisfies SlashEntry[]).filter((e) => !out.some((o) => o.name === e.name));
  if (own.length === 0) return out;
  return [...out, ...own].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
