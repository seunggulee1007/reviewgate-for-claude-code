/**
 * MARK: wave4d w4d-windows — audit polish-07: words that name the OS's own tools follow the platform the client runs on.
 * Windows' file manager is Explorer (탐색기), never the Mac's Finder; there the toolchain is found on PATH (src/main/winClaude.ts),
 * not through a login shell.
 */
import { t } from "./i18n";

/** "Reveal in Finder" / "Show in Explorer" / "Show in Folder" — `shell.showItemInFolder` on each platform. */
export function revealInFolderLabel(platform: string): string {
  if (platform === "darwin") return t("Reveal in Finder");
  if (platform === "win32") return t("Show in Explorer");
  return t("Show in Folder");
}

/** Settings › General › Toolchain: where the detected paths came from. */
export function toolchainDetectedNote(platform: string, hasProject: boolean): string {
  if (!hasProject) return t("Detected when a project is opened.");
  return platform === "win32" ? t("Detected on PATH for the current session.") : t("Detected via the login shell for the current session.");
}

/** The workbench setup command's help line — engine `git/workbenchSetup.ts` runs it through cmd.exe on Windows. */
export function workbenchSetupNote(platform: string): string {
  return platform === "win32"
    ? t("Runs in the new workbench through cmd.exe when you create one (at most 10 minutes) — never when a window opens and never by Claude. A failure still opens the window with the log.")
    : t("Runs in the new workbench through your login shell when you create one (at most 10 minutes) — never when a window opens and never by Claude. A failure still opens the window with the log.");
}

/** Settings › General › Toolchain overrides: what "auto-detect" means here. */
export function toolchainOverrideNote(platform: string): string {
  return platform === "win32"
    ? t("Choose the program file, or leave it on auto-detect (PATH). Takes effect on the next Open Project.")
    : t("Choose the program file, or leave it on auto-detect (login shell). Takes effect on the next Open Project.");
}
