/**
 * MARK: wave4c w4c-commit
 * docs/PROTOCOL.md §41.1 (SME-11): the CLI's built-in commands the app gives its own meaning. `/clear` (and its aliases)
 * is the app's new chat — the engine opens one instead of emptying Claude's memory under a chat that still shows it — so the
 * palette says so (as on the Mac, `SlashCommandCatalog.withAppMeanings`).
 */
import { t } from "./i18n";
import type { SlashEntry } from "./slashCommands";

export function withAppMeanings(entries: SlashEntry[]): SlashEntry[] {
  return entries.map((e) => (e.name === "clear" ? { ...e, description: t("Opens a new chat in the app — this chat stays in the list") } : e));
}
