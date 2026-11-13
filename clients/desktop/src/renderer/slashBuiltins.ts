/**
 * MARK: wave4c w4c-commit
 * docs/PROTOCOL.md §41.1 (SME-11): the CLI's built-in commands the app gives its own meaning. `/clear` (and its aliases)
 * is the app's new chat — the engine opens one instead of emptying Claude's memory under a chat that still shows it — so the
 * palette says so (as on the Mac, `SlashCommandCatalog.withAppMeanings`). §56.1: `/btw` is the app's side question (the CLI
 * lists it to the terminal only), so the palette always has it.
 */
import { BTW_NAME, btwDescription } from "./btw";
import { t } from "./i18n";
import type { SlashEntry } from "./slashCommands";

export function withAppMeanings(entries: SlashEntry[]): SlashEntry[] {
  const out = entries.map((e) =>
    e.name === "clear" ? { ...e, description: t("Opens a new chat in the app — this chat stays in the list") }
    : e.name === BTW_NAME ? { ...e, description: btwDescription() }
    : e,
  );
  if (out.some((e) => e.name === BTW_NAME)) return out;
  const btw: SlashEntry = { name: BTW_NAME, description: btwDescription(), argumentHint: "<question>", isSkill: false, aliases: [], group: { kind: "builtin" } };
  return [...out, btw].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
