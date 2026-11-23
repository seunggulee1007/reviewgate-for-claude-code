/**
 * §62 Open in IDE from the renderer: the repo-relative path and the line go to main (`rg:openInIde`), which builds the
 * `vscode://` / `idea://` URL from the window's project root and checks the file is the project's (src/main/ideOpen.ts).
 */
import type { IdeKind, OpenInIdeResult } from "../../shared/ipc";
import { t } from "../i18n";
import { useStore } from "../store";
import { showToast } from "../toast";

export const IDE_CHOICES: IdeKind[] = ["vscode", "idea", "system"];

export function ideTitle(kind: IdeKind): string {
  return kind === "vscode" ? "VS Code" : kind === "idea" ? "IntelliJ IDEA" : t("System default");
}

/** Settings "Open in" (absent: VS Code). */
export function preferredIde(): IdeKind {
  const v = useStore.getState().settings?.openInIde;
  return v === "idea" || v === "system" ? v : "vscode";
}

/** What the user is told when the file did not open (null: it did). */
export function ideResultText(result: OpenInIdeResult, kind: IdeKind): string | null {
  switch (result) {
    case "opened":
      return null;
    case "no_project":
      return t("Open a project first (⌘O)");
    case "outside_project":
    case "not_a_file":
      return t("Only a file of this project can be opened in the IDE");
    default:
      return t("{0} did not open — is it installed?", ideTitle(kind));
  }
}

/** Opens `path` (repo-relative) at `line` / `column` in `ide` (default: the "Open in" setting); a failure says why in a toast. */
export async function openInIde(path: string, line: number, column = 1, ide: IdeKind = preferredIde()): Promise<boolean> {
  let result: OpenInIdeResult;
  try {
    result = await window.rg.openInIde(ide, path, Math.max(1, Math.trunc(line) || 1), Math.max(1, Math.trunc(column) || 1));
  } catch {
    result = "failed";
  }
  const text = ideResultText(result, ide);
  if (text) showToast(text);
  return text === null;
}
