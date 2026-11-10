/**
 * Main process bootstrap: app lifecycle, crash handling, diagnostics and the startup windows
 * (`REVIEWGATE_PROJECT`, else the windows of the last session — docs/M19-MULTIPROJECT.md).
 * Windows and their engines live in src/main/windows.ts, the `rg:*` handlers in src/main/ipc.ts.
 */
import { app, BrowserWindow, clipboard, shell } from "electron";
import { statSync } from "node:fs";
import { join, sep } from "node:path";
import { buildMenu, type MenuHandlers } from "./menu.js";
import { secondInstanceAction, type SecondInstanceData } from "./singleInstance.js";
import { applyAppearance, detectWindowsClaude, loadSettings, saveSettings } from "./settings.js";
import { installE2E, type E2EMode } from "./e2e.js";
import { installIPC } from "./ipc.js";
import { installNotifications } from "./notifications.js";
import { installReadiness } from "./readiness.js"; // MARK: polish p-lifecycle (P5-sheets-44)
import { checkForUpdatesNow, installUpdates } from "./update.js"; // MARK: polish p-lifecycle (P5-sheets-49)
import { appUserModelId } from "./notify.js"; // MARK: wave4b w4-notify
import { logDir, logLine } from "./log.js";
import { redactLog } from "./logRedact.js";
import { installNavigationGuards } from "./navigationGuard.js";
import {
  allWorkbenches,
  APP_ORIGIN,
  confirmQuit, // MARK: wave4 w4-safety / polish p-lifecycle (P1-chrome-01)
  createWindow,
  disposeAll,
  engineFor,
  findWindowFor,
  focusedWorkbench, // MARK: polish p-lifecycle (P1-chrome-09)
  focusProjectWindow,
  focusWindow,
  hideAllWindows, // MARK: polish p-lifecycle (P1-chrome-05)
  initWindows,
  isSessionEnding, // MARK: polish p-lifecycle (PX-14)
  openInNewWindow,
  persistWindows,
  restoreWindows,
  withTimeout,
  takeLastWindowQuit, // MARK: polish p-lifecycle (P1-chrome-01)
  workbenchFor,
} from "./windows.js";
import { currentLanguage, initI18n, t } from "../renderer/i18n"; // MARK: wave4 w4-safety — the close / quit confirm speaks the UI language
import { helpLinks } from "./links.js"; // MARK: polish p-lifecycle (P1-chrome-08)

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
  // MARK: polish p-lifecycle (P1-chrome-13): it says so in the window (it only wrote the log line).
  if (win && !win.isDestroyed()) win.webContents.send("rg:toast", t("Diagnostics copied — paste them into your report"));
}

/** MARK: polish p-lifecycle (P1-chrome-08): Help › Report an Issue… — the diagnostics on the clipboard, then a new issue. */
function reportIssue(): void {
  copyDiagnostics();
  void shell.openExternal(helpLinks(currentLanguage()).newIssue);
}

const menuHandlers: MenuHandlers = {
  newWindow: () => void createWindow(),
  openInNewWindow: () => void openInNewWindow(),
  copyDiagnostics,
  checkForUpdates: () => void checkForUpdatesNow(), // MARK: polish p-lifecycle (P5-sheets-49)
  reportIssue, // MARK: polish p-lifecycle (P1-chrome-08)
  // MARK: polish p-lifecycle (P1-chrome-07): File › Open Recent › Clear Menu — the list, the empty window's and the jump list.
  clearRecent: () => {
    saveSettings({ recentProjects: [] });
    app.clearRecentDocuments();
    rebuildMenu();
  },
  // MARK: polish p-lifecycle (P1-chrome-09): the menu bar follows the focused window.
  focused: () => {
    const wb = focusedWorkbench();
    return wb ? { state: wb.engine.state, menu: wb.menuEnabled ?? null } : null;
  },
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
// MARK: wave4 w4-safety / polish p-lifecycle — P1-chrome-01: quitting asks (each window's reasons; "Ask before quitting",
// or while work would stop "Ask before closing while Claude works"); the last window's close on Windows comes here too.
let quitConfirmed = false;
let quitAsking = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  if (!quitConfirmed && !crashing && !isSessionEnding()) {
    if (quitAsking) return;
    quitAsking = true;
    void confirmQuit(takeLastWindowQuit() ? "lastWindow" : "quit").then((ok) => {
      quitAsking = false;
      if (!ok) return;
      quitConfirmed = true;
      app.quit();
    });
    return;
  }
  quitting = true;
  // M19: the window list is written while the engines (and their project paths) are still alive.
  persistWindows();
  // P1-chrome-05 / P5-sheets-53: the windows go at once, and a stuck engine never holds the quit (at most 6 s).
  hideAllWindows();
  void withTimeout(disposeAll(), 6000).then(() => app.exit(0));
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || E2E) app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
// MARK: polish p-lifecycle (P1-chrome-09): another window in front — its project, its items, its chat tabs.
app.on("browser-window-focus", () => rebuildMenu());

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
    allEngines: () => allWorkbenches().map((w) => ({ engine: w.engine, projectRoot: w.projectRoot, projectRepo: w.projectRepo ?? null })),
    findWindowFor,
    createWindow,
    openInNewWindow,
    focusProjectWindow,
    rebuildMenu,
  });
  installNotifications({ focusWindow });
  installReadiness(); // MARK: polish p-lifecycle (P5-sheets-44): the empty window's checklist
  if (!E2E) installUpdates(); // MARK: polish p-lifecycle (P5-sheets-49): at launch, then every 6 hours

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
