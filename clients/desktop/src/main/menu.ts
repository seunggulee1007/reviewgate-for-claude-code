/** Application menu: File (Open / Recent / Switch / New Workbench / Settings), View, Help. Actions go to the focused window. */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { basename } from "node:path";
import { loadSettings } from "./settings.js";
import { recentEntries } from "./recentProjects.js"; // MARK: wave4 w4-install
import type { MenuAction } from "../shared/ipc.js";
import { t } from "../renderer/i18n"; // MARK: wave4d w4d-windows (polish-07): the menu bar in the UI language (`initI18n` in main.ts)

const isMac = process.platform === "darwin";

function dispatch(action: MenuAction, onNoWindow: () => void): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send("rg:menu", action);
  else onNoWindow();
}

export function buildMenu(opts: { newWindow: () => void; openInNewWindow: (path?: string) => void; copyDiagnostics: () => void }): void {
  // MARK: wave4 w4-install (daily-17): no temporary folders; a folder that is gone is shown but never opened.
  const entries = recentEntries(loadSettings().recentProjects);
  const recents = entries.filter((e) => e.exists).map((e) => e.path);
  const missingItems: MenuItemConstructorOptions[] = entries
    .filter((e) => !e.exists)
    .map((e) => ({ label: t("{0} — not found", basename(e.path)), sublabel: e.path, toolTip: t("Not found: {0}", e.path), enabled: false }));
  // M19: ⌥ on a recent opens it in a new window instead of switching this one.
  const recentItems: MenuItemConstructorOptions[] =
    entries.length === 0
      ? [{ label: t("No recent projects"), enabled: false }]
      : [...recents.map((p): MenuItemConstructorOptions => ({
          label: basename(p),
          sublabel: p,
          toolTip: p,
          click: (_i, _w, e) => (e.altKey ? opts.openInNewWindow(p) : dispatch({ type: "open_recent", path: p }, opts.newWindow)),
        })), ...missingItems];

  const file: MenuItemConstructorOptions = {
    label: t("File"),
    submenu: [
      { label: t("Open Project…"), accelerator: "CmdOrCtrl+O", click: () => dispatch({ type: "open_project" }, opts.newWindow) },
      { label: t("Open in New Window…"), accelerator: "CmdOrCtrl+Shift+N", click: () => opts.openInNewWindow() },
      { label: t("Open Recent"), submenu: recentItems },
      { label: t("Switch Project…"), accelerator: "CmdOrCtrl+Shift+O", click: () => dispatch({ type: "switch_project" }, opts.newWindow) },
      { type: "separator" },
      { label: t("New Workbench…"), click: () => dispatch({ type: "new_workbench" }, opts.newWindow) },
      // MARK: §49 — "Run as Task…" while Settings › Workbenches › "업무로 실행" is on (a settings change rebuilds the menu)
      ...(loadSettings().runAsTaskEnabled !== false ? [{ label: t("Run as Task…"), click: () => dispatch({ type: "run_as_task" }, opts.newWindow) }] : []),
      { label: t("New Window"), click: () => opts.newWindow() },
      { type: "separator" },
      { label: t("Settings…"), accelerator: "CmdOrCtrl+,", click: () => dispatch({ type: "settings" }, opts.newWindow) },
      { type: "separator" },
      isMac ? { role: "close", label: t("Close Window") } : { role: "quit", label: t("Quit") },
    ],
  };
  // Audit polish-03: Force Reload owns Shift+CmdOrCtrl+R — the reject shortcut — and a reload loses the renderer's
  // draft and queue; Developer Tools are no tool for users either. Both stay in development builds only.
  const devItems: MenuItemConstructorOptions[] = app.isPackaged ? [] : [{ role: "forceReload", label: t("Force Reload") }, { role: "toggleDevTools", label: t("Toggle Developer Tools") }, { type: "separator" }];
  const view: MenuItemConstructorOptions = {
    label: t("View"),
    submenu: [
      { label: t("Toggle Sidebar"), accelerator: "CmdOrCtrl+B", click: () => dispatch({ type: "toggle_sidebar" }, () => undefined) },
      { label: t("Refresh"), accelerator: "CmdOrCtrl+R", click: () => dispatch({ type: "refresh" }, () => undefined) },
      // MARK: wave4d w4d-windows (polish-08): the Mac's View menu. The renderer owns these keys (src/renderer/shortcuts.ts):
      // the menu shows them without taking them (`registerAccelerator: false`).
      { label: t("Toggle Diff Pane"), ...shownKey("CmdOrCtrl+Shift+D"), click: () => dispatch({ type: "toggle_diff_pane" }, () => undefined) },
      { label: t("Toggle Agent Panel"), ...shownKey("CmdOrCtrl+Alt+A"), click: () => dispatch({ type: "toggle_agent_panel" }, () => undefined) },
      { label: t("Toggle Side Questions"), ...shownKey("CmdOrCtrl+Alt+S"), click: () => dispatch({ type: "toggle_side_panel" }, () => undefined) },
      // MARK: wave5 w5-board — §43.1: the agent board (the Mac's Window › Agent Board).
      { label: t("Agent Board"), ...shownKey("CmdOrCtrl+Alt+B"), click: () => dispatch({ type: "toggle_board" }, () => undefined) },
      { type: "separator" },
      ...devItems,
      { role: "resetZoom", label: t("Actual Size") },
      { role: "zoomIn", label: t("Zoom In") },
      { role: "zoomOut", label: t("Zoom Out") },
      { type: "separator" },
      { role: "togglefullscreen", label: t("Toggle Full Screen") },
    ],
  };
  const help: MenuItemConstructorOptions = {
    label: t("Help"),
    submenu: [
      { label: t("Open Log Folder"), click: () => void shell.openPath(`${app.getPath("userData")}/logs`) },
      { label: t("Open Settings Folder"), click: () => void shell.openPath(app.getPath("userData")) },
      { label: t("Copy Diagnostics"), click: () => opts.copyDiagnostics() },
      { type: "separator" },
      // MARK: wave4d w4d-windows (polish-08): the table of docs/SHORTCUTS.md — the Mac has the same Help item.
      { label: t("Keyboard Shortcuts"), click: () => dispatch({ type: "shortcuts" }, () => undefined) },
      { type: "separator" },
      { label: `ReviewGate ${app.getVersion()} · Electron ${process.versions.electron}`, enabled: false },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu()] : []),
    file,
    editMenu(),
    view,
    windowMenu(),
    help,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * MARK: wave4d w4d-windows — polish-08: a key the renderer handles itself, shown in the menu. Windows / Linux display it
 * without registering it; a Mac menu always takes its key equivalent, so the (development-only) Mac build shows none.
 */
function shownKey(accelerator: string): Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator"> {
  return isMac ? {} : { accelerator, registerAccelerator: false };
}

// MARK: wave4d w4d-windows — audit polish-07: Electron's role menus (appMenu / editMenu / windowMenu) carry English labels
// whatever the UI language; these are the same items with labels from the UI language.
function appMenu(): MenuItemConstructorOptions {
  return {
    label: app.name,
    submenu: [
      { role: "about", label: t("About ReviewGate") },
      { type: "separator" },
      { role: "services", label: t("Services") },
      { type: "separator" },
      { role: "hide", label: t("Hide ReviewGate") },
      { role: "hideOthers", label: t("Hide Others") },
      { role: "unhide", label: t("Show All") },
      { type: "separator" },
      { role: "quit", label: t("Quit ReviewGate") },
    ],
  };
}

function editMenu(): MenuItemConstructorOptions {
  return {
    label: t("Edit"),
    submenu: [
      { role: "undo", label: t("Undo") },
      { role: "redo", label: t("Redo") },
      { type: "separator" },
      { role: "cut", label: t("Cut") },
      { role: "copy", label: t("Copy") },
      { role: "paste", label: t("Paste") },
      ...(isMac ? [{ role: "pasteAndMatchStyle" as const, label: t("Paste and Match Style") }] : []),
      { role: "delete", label: t("Delete") },
      { type: "separator" },
      { role: "selectAll", label: t("Select All") },
    ],
  };
}

function windowMenu(): MenuItemConstructorOptions {
  return {
    label: t("Window"),
    submenu: isMac
      ? [{ role: "minimize", label: t("Minimize") }, { role: "zoom", label: t("Zoom") }, { type: "separator" }, { role: "front", label: t("Bring All to Front") }]
      : [{ role: "minimize", label: t("Minimize") }, { role: "close", label: t("Close Window") }],
  };
}
