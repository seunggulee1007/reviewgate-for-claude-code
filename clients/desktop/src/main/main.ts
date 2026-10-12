/**
 * Main process bootstrap: app lifecycle, crash handling, diagnostics and the startup windows
 * (`REVIEWGATE_PROJECT`, else the windows of the last session — docs/M19-MULTIPROJECT.md).
 * Windows and their engines live in src/main/windows.ts, the `rg:*` handlers in src/main/ipc.ts.
 */
import { app, BrowserWindow, clipboard } from "electron";
import { statSync } from "node:fs";
import { join, sep } from "node:path";
import { buildMenu } from "./menu.js";
import { secondInstanceAction, type SecondInstanceData } from "./singleInstance.js";
import { applyAppearance, detectWindowsClaude, loadSettings } from "./settings.js";
import { installE2E, type E2EMode } from "./e2e.js";
import { installIPC } from "./ipc.js";
import { installNotifications } from "./notifications.js";
import { appUserModelId } from "./notify.js"; // MARK: wave4b w4-notify
import { logDir, logLine } from "./log.js";
import { redactLog } from "./logRedact.js";
import { installNavigationGuards } from "./navigationGuard.js";
import {
  allWorkbenches,
  APP_ORIGIN,
  confirmStop, // MARK: wave4 w4-safety
  createWindow,
  disposeAll,
  engineFor,
  findWindowFor,
  focusProjectWindow,
  focusWindow,
  initWindows,
  openInNewWindow,
  persistWindows,
  restoreWindows,
  withTimeout,
  workbenchFor,
  workingReasons, // MARK: wave4 w4-safety
} from "./windows.js";
import { initI18n } from "../renderer/i18n"; // MARK: wave4 w4-safety — the close / quit confirm speaks the UI language

app.setPath("userData", join(app.getPath("appData"), "ReviewGate"));
// Every renderer is sandboxed (the windows also set `sandbox: true`); navigation is app-only (src/main/navigationGuard.ts).
app.enableSandbox();
// MARK: wave4b w4-notify — Windows shows toasts only for the AUMID of the installer's Start menu shortcut (= appId).
if (process.platform === "win32") app.setAppUserModelId(appUserModelId(app.isPackaged, process.execPath));
installNavigationGuards(APP_ORIGIN);
const E2E: E2EMode | null = process.argv.includes("--e2e") ? { project: process.env.REVIEWGATE_PROJECT ?? "" } : null;

// Audit daily-19: one ReviewGate process per user — a second launch hands its project to this one and quits instead of
// opening the same worktrees with a second set of engines (src/main/singleInstance.ts). The --e2e harness skips the lock.
const secondLaunchData: SecondInstanceData = { project: process.env.REVIEWGATE_PROJECT ?? "" };
const primaryInstance = E2E !== null || app.requestSingleInstanceLock(secondLaunchData);
if (!primaryInstance) app.exit(0);
const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
app.on("second-instance", (_e, argv, workingDirectory, additionalData) => {
  void app.whenReady().then(() => {
    const action = secondInstanceAction(argv, workingDirectory, additionalData, isDirectory, { firstUserArg: process.defaultApp ? 2 : 1 });
    logLine("main", "main", `second launch: ${action.kind === "open" ? `open ${action.path}` : "focus a window"}`);
    if (action.kind === "open") {
      void openInNewWindow(action.path);
      return;
    }
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (win) focusWindow(win);
    else createWindow();
  });
});

/** Help → Copy Diagnostics: versions, log folder and the focused window's last `ReviewState` as JSON (docs/M11-WINDOWS.md). */
function copyDiagnostics(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const wb = win ? workbenchFor(win.webContents) : undefined;
  const diagnostics = {
    app: `ReviewGate ${app.getVersion()}`,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    logDir: logDir(),
    settings: loadSettings(),
    state: wb?.engine.state ?? null,
  };
  // wave3 check-clients: masked like the log file (the Mac's LogRedactor rules) — the state holds paths under the home folder.
  clipboard.writeText(redactLog(JSON.stringify(diagnostics, null, 2)));
  logLine("main", "main", "diagnostics copied to the clipboard");
}

const menuHandlers = {
  newWindow: () => void createWindow(),
  openInNewWindow: () => void openInNewWindow(),
  copyDiagnostics,
};
const rebuildMenu = () => buildMenu(menuHandlers);

// ---------------------------------------------------------------- lifecycle

/** A crash in main must not leave `claude` running: log, dispose every engine (≤ 3 s), exit 1 (§3.7). */
let crashing = false;
function onCrash(kind: string, err: unknown): void {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logLine("main", "error", `${kind}: ${msg}`);
  if (crashing) return;
  crashing = true;
  void withTimeout(disposeAll(), 3000).finally(() => app.exit(1));
}
process.on("uncaughtException", (err) => onCrash("uncaughtException", err));
process.on("unhandledRejection", (err) => onCrash("unhandledRejection", err));

let quitting = false;
// MARK: wave4 w4-safety — daily-12: quitting while Claude works in any window asks once (with the count).
let quitConfirmed = false;
let quitAsking = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  if (!quitConfirmed && !crashing) {
    const reasons = workingReasons();
    if (reasons.length > 0) {
      if (quitAsking) return;
      quitAsking = true;
      void confirmStop(BrowserWindow.getFocusedWindow() ?? null, reasons, "quit").then((ok) => {
        quitAsking = false;
        if (!ok) return;
        quitConfirmed = true;
        app.quit();
      });
      return;
    }
  }
  quitting = true;
  // M19: the window list is written while the engines (and their project paths) are still alive.
  persistWindows();
  void disposeAll().then(() => app.exit(0));
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || E2E) app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  logLine("main", "main", `ReviewGate ${app.getVersion()} electron ${process.versions.electron} ${process.platform} ${sep}`);
  initI18n(app.getLocale(), process.platform); // MARK: wave4 w4-safety
  applyAppearance();
  // win32: an npm `claude.cmd` cannot be spawned without a shell (EINVAL) — resolve it before any engine starts.
  await detectWindowsClaude();
  initWindows({ e2e: E2E, rebuildMenu });
  rebuildMenu();
  installIPC({
    engineFor,
    allEngines: () => allWorkbenches().map((w) => ({ engine: w.engine, projectRoot: w.projectRoot })),
    findWindowFor,
    createWindow,
    openInNewWindow,
    focusProjectWindow,
    rebuildMenu,
  });
  installNotifications({ focusWindow });
  if (E2E) {
    installE2E(E2E, { createWindow, disposeAll });
    createWindow({ e2eRole: "primary" });
    return;
  }
  if (process.env.REVIEWGATE_PROJECT) {
    createWindow({ project: process.env.REVIEWGATE_PROJECT });
    return;
  }
  // M19: no explicit project — reopen the last session's windows, else the empty state as before.
  if (!(await restoreWindows())) createWindow();
});
