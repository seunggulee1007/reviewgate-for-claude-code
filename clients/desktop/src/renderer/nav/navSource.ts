/**
 * §73.5 on Windows — "Exact" (the language server answered) or "Estimated" (the search did, and why), the words the label
 * next to a definition list, the peek band and the References tab shows. The Mac's words (Core `LanguageServer.swift`).
 */
import type { LspFallback, NavSource } from "@reviewgate/engine";
import { t } from "../i18n";

/** The label: the language server's answer is exact; the search's (and an older engine's) is an estimate. */
export function sourceLabel(source: NavSource | undefined): string {
  return source === "lsp" ? t("Exact") : t("Estimated");
}

/** Its tooltip: who answered, and why the search did when the language server could not. */
export function sourceHelp(source: NavSource | undefined, fallback: LspFallback | undefined): string {
  if (source === "lsp") return t("Found by the language server (TypeScript)");
  switch (fallback) {
    case "starting":
      return t("The language server is still starting, so this was found by searching");
    case "timeout":
      return t("The language server did not answer in time, so this was found by searching");
    case "failed":
    case "unavailable":
      return t("The language server is not available, so this was found by searching");
    case "no_result":
      return t("The language server found nothing inside the project, so this was found by searching");
    case "off":
      return t("The language server is off in Settings — found by searching");
    default:
      return t("Found by searching — other things with the same name may be listed");
  }
}
