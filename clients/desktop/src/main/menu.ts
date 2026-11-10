/**
 * Application menu: File, Edit, View, Review, Chat, Window, Help — the Mac's menus, with the same keys (docs/SHORTCUTS.md).
 * Actions go to the focused window. MARK: polish p-lifecycle (P1-chrome-09 and the rest of lane p-lifecycle's menu items):
 * on Windows the menu bar is where a user finds what a key does — every review and chat action is listed with its key, and
 * Alt+<letter> opens each menu (PX-13).
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { basename } from "node:path";
import type { ReviewState } from "@reviewgate/engine";
import { loadSettings } from "./settings.js";
import { recentEntries } from "./recentProjects.js"; // MARK: wave4 w4-install
import type { MenuAction } from "../shared/ipc.js";
import { NOTHING_ENABLED, type MenuEnabled } from "../shared/menuState.js"; // MARK: polish p-lifecycle (P1-chrome-09)
import { currentLanguage, t } from "../renderer/i18n"; // MARK: wave4d w4d-windows (polish-07): the menu bar in the UI language (`initI18n` in main.ts)
import { helpLinks } from "./links.js"; // MARK: polish p-lifecycle (P1-chrome-08)

const isMac = process.platform === "darwin";

function dispatch(action: MenuAction, onNoWindow: () => void): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send("rg:menu", action);
  else onNoWindow();
}

export type MenuHandlers = {
  newWindow: () => void;
  openInNewWindow: (path?: string) => void;
  copyDiagnostics: () => void;
  // MARK: polish p-lifecycle
  /** P5-sheets-49: Help › Check for Updates… */
  checkForUpdates: () => void;
  /** P1-chrome-08: Help › Report an Issue… — the diagnostics go on the clipboard first. */
  reportIssue: () => void;
  /** P1-chrome-07: File › Open Recent › Clear Menu. */
  clearRecent: () => void;
  /**
   * The focused window's engine state and what its page said its items can do (null: no window): the project menus need a
   * project, the Review and Chat items follow the page (`rg:menuState`), the Chat menu lists its tabs.
   */
  focused: () => { state: ReviewState; menu: MenuEnabled | null } | null;
};

/** What the last build showed: a rebuild that would show the same is skipped (focus changes rebuild — P1-chrome-09). */
let lastSignature = "";

export function buildMenu(opts: MenuHandlers): void {
  const settings = loadSettings();
  const focused = opts.focused();
  const state = focused?.state ?? null;
  const hasProject = state?.project != null;
  const can = hasProject ? (focused?.menu ?? NOTHING_ENABLED) : NOTHING_ENABLED;
  // MARK: wave4 w4-install (daily-17): no temporary folders; a folder that is gone is shown but never opened.
  const entries = recentEntries(settings.recentProjects);
  const tabs = chatTabs(state);
  const runAsTask = settings.runAsTaskEnabled !== false;
  // `t("File")` stands for the UI language.
  const signature = JSON.stringify([t("File"), entries, tabs, hasProject, runAsTask, can]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  const needsProject = { enabled: hasProject };

  const recents = entries.filter((e) => e.exists).map((e) => e.path);
  const missingItems: MenuItemConstructorOptions[] = entries
    .filter((e) => !e.exists)
    .map((e) => ({ label: t("{0} — not found", basename(e.path)), sublabel: e.path, toolTip: t("Not found: {0}", e.path), enabled: false }));
  // M19: ⌥ on a recent opens it in a new window instead of switching this one.
  const recentItems: MenuItemConstructorOptions[] =
    entries.length === 0
      ? [{ label: t("No recent projects"), enabled: false }]
      : [
          ...recents.map((p): MenuItemConstructorOptions => ({
            label: basename(p),
            sublabel: p,
            toolTip: p,
            click: (_i, _w, e) => (e.altKey ? opts.openInNewWindow(p) : dispatch({ type: "open_recent", path: p }, opts.newWindow)),
          })),
          ...missingItems,
          // MARK: polish p-lifecycle (P1-chrome-07): the Mac's Clear Menu.
          { type: "separator" },
          { label: t("Clear Menu"), click: () => opts.clearRecent() },
        ];
  setJumpList(recents);

  const file: MenuItemConstructorOptions = {
    label: mn(t("File"), "F"),
    submenu: [
      // MARK: polish p-lifecycle (P1-chrome-06): an empty window of its own, ⌘N as on the Mac.
      { label: t("New Window"), accelerator: "CmdOrCtrl+N", click: () => opts.newWindow() },
      { label: mn(t("Open Project…"), "O"), accelerator: "CmdOrCtrl+O", click: () => dispatch({ type: "open_project" }, opts.newWindow) },
      { label: t("Open in New Window…"), accelerator: "CmdOrCtrl+Shift+N", click: () => opts.openInNewWindow() },
      { label: mn(t("Open Recent"), "R"), submenu: recentItems },
      { label: t("Switch Project…"), accelerator: "CmdOrCtrl+Shift+O", click: () => dispatch({ type: "switch_project" }, opts.newWindow) },
      { type: "separator" },
      // MARK: polish p-lifecycle (P1-chrome-28): the Mac's File › Go to File (⌘P) and Find in Project (⇧⌘F); the pages
      // themselves are lane p-window's (`quick_open` / `project_search` in menuActions.window.ts).
      { label: t("Go to File…"), accelerator: "CmdOrCtrl+P", ...needsProject, click: () => dispatch({ type: "quick_open" }, () => undefined) },
      { label: t("Find in Project…"), accelerator: "CmdOrCtrl+Shift+F", ...needsProject, click: () => dispatch({ type: "project_search" }, () => undefined) },
      { type: "separator" },
      { label: t("New Workbench…"), ...needsProject, click: () => dispatch({ type: "new_workbench" }, opts.newWindow) },
      // MARK: §49 — "Run as Task…" while Settings › Workbenches › "업무로 실행" is on (a settings change rebuilds the menu)
      ...(runAsTask ? [{ label: t("Run as Task…"), ...needsProject, click: () => dispatch({ type: "run_as_task" }, opts.newWindow) }] : []),
      { type: "separator" },
      // MARK: polish p-lifecycle (P1-chrome-06): the project menu's Close Project here too (it asks first — P1-chrome-03).
      { label: t("Close Project"), ...needsProject, click: () => dispatch({ type: "close_project" }, () => undefined) },
      { type: "separator" },
      { label: mn(t("Settings…"), "S"), accelerator: "CmdOrCtrl+,", click: () => dispatch({ type: "settings" }, opts.newWindow) },
      { type: "separator" },
      // PX-13: Windows' File menu ends with its Quit, X its access key — "종료(X)"; English Windows says "Exit".
      isMac ? { role: "close", label: t("Close Window") } : { role: "quit", label: mn(t("Quit") === "Quit" ? "Exit" : t("Quit"), "X") },
    ],
  };
  // Audit polish-03: Force Reload owns Shift+CmdOrCtrl+R — the reject shortcut — and a reload loses the renderer's
  // draft and queue; Developer Tools are no tool for users either. Both stay in development builds only.
  const devItems: MenuItemConstructorOptions[] = app.isPackaged ? [] : [{ role: "forceReload", label: t("Force Reload") }, { role: "toggleDevTools", label: t("Toggle Developer Tools") }, { type: "separator" }];
  const view: MenuItemConstructorOptions = {
    label: mn(t("View"), "V"),
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
      // MARK: polish p-lifecycle (P1-chrome-20): the sidebar's tabs, in the Mac's order (the keys are the renderer's).
      { type: "separator" },
      { label: t("Changes"), ...shownKey("CmdOrCtrl+Alt+1"), ...needsProject, click: () => dispatch({ type: "sidebar_tab", tab: "changes" }, () => undefined) },
      { label: t("History"), ...shownKey("CmdOrCtrl+Alt+2"), ...needsProject, click: () => dispatch({ type: "sidebar_tab", tab: "history" }, () => undefined) },
      { label: t("PRs"), ...shownKey("CmdOrCtrl+Alt+3"), ...needsProject, click: () => dispatch({ type: "sidebar_tab", tab: "prs" }, () => undefined) },
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
    label: mn(t("Help"), "H"),
    submenu: [
      // MARK: polish p-lifecycle (P1-chrome-08 / P5-sheets-45): the Mac's Help — how to use it, the keys, what changed,
      // where to say what broke (the diagnostics copied first).
      { label: t("ReviewGate Help"), click: () => void shell.openExternal(helpLinks(currentLanguage()).help) },
      // MARK: wave4d w4d-windows (polish-08): the table of docs/SHORTCUTS.md — the Mac has the same Help item.
      { label: t("Keyboard Shortcuts"), click: () => dispatch({ type: "shortcuts" }, () => undefined) },
      { label: t("Release Notes"), click: () => void shell.openExternal(helpLinks(currentLanguage()).releases) },
      { label: t("Report an Issue…"), click: () => opts.reportIssue() },
      { type: "separator" },
      // MARK: polish p-lifecycle (P5-sheets-49): the Mac's ReviewGate › Check for Updates…
      { label: t("Check for Updates…"), click: () => opts.checkForUpdates() },
      { type: "separator" },
      // MARK: r2-review-flow — M27: the engine log in the window (no longer a line under every composer)
      { label: t("Show Engine Log"), click: () => dispatch({ type: "show_engine_log" }, () => undefined) },
      { label: t("Open Log Folder"), click: () => void shell.openPath(`${app.getPath("userData")}/logs`) },
      { label: t("Open Settings Folder"), click: () => void shell.openPath(app.getPath("userData")) },
      { label: t("Copy Diagnostics"), click: () => opts.copyDiagnostics() },
      { type: "separator" },
      { label: `ReviewGate ${app.getVersion()} · Electron ${process.versions.electron}`, enabled: false },
    ],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu()] : []),
    file,
    editMenu(needsProject),
    view,
    reviewMenu(can, hasProject),
    chatMenu(needsProject, can, tabs),
    windowMenu(),
    help,
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The next build shows what it builds even when it looks the same as the last (a settings change made elsewhere). */
export function invalidateMenu(): void {
  lastSignature = "";
}

/**
 * MARK: wave4d w4d-windows — polish-08: a key the renderer handles itself, shown in the menu. Windows / Linux display it
 * without registering it; a Mac menu always takes its key equivalent, so the (development-only) Mac build shows none.
 */
function shownKey(accelerator: string): Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator"> {
  return isMac ? {} : { accelerator, registerAccelerator: false };
}

/**
 * MARK: polish p-lifecycle — PX-13: Windows' access key — Alt+F opens File, then the underlined letter picks an item. An
 * English label gets "&" before its letter ("&File"); a Korean one the Windows habit, "파일(&F)" (before a trailing "…").
 * The Mac shows no access keys.
 */
export function mn(label: string, key: string, mac = isMac): string {
  if (mac) return label;
  const escaped = label.replace(/&/g, "&&");
  const ascii = /^[\x20-\x7e…]*$/.test(label);
  const at = escaped.toLowerCase().indexOf(key.toLowerCase());
  if (ascii && at >= 0) return `${escaped.slice(0, at)}&${escaped.slice(at)}`;
  const tail = escaped.endsWith("…") ? "…" : "";
  return `${tail ? escaped.slice(0, -1) : escaped}(&${key.toUpperCase()})${tail}`;
}

// MARK: polish p-lifecycle — P1-chrome-09 / P2-review-28 / P5-sheets-46: the Mac's Review menu, with its keys. The renderer
// owns the keys (shownKey); a click runs the same thing (src/renderer/menuActions.lifecycle.ts).
function reviewMenu(can: MenuEnabled, project: boolean): MenuItemConstructorOptions {
  const item = (label: string, action: MenuAction, enabled: boolean, key?: string): MenuItemConstructorOptions => ({
    label,
    ...(key ? shownKey(key) : {}),
    enabled,
    click: () => dispatch(action, () => undefined),
  });
  // The ones without a state of their own need a project (`can` is all off without one).
  return {
    label: mn(t("Review"), "R"),
    submenu: [
      item(t("Accept"), { type: "accept" }, can.accept, "CmdOrCtrl+Shift+A"),
      item(t("Reject"), { type: "reject" }, can.reject, "CmdOrCtrl+Shift+R"),
      { type: "separator" },
      item(t("Next Pending File"), { type: "next_pending" }, can.pending, "CmdOrCtrl+]"),
      item(t("Previous Pending File"), { type: "prev_pending" }, can.pending, "CmdOrCtrl+["),
      { type: "separator" },
      item(t("Accept All…"), { type: "accept_all" }, can.acceptAll),
      item(t("Reject All…"), { type: "reject_all" }, can.rejectAll),
      item(t("Finish Review…"), { type: "finish_review" }, can.finishReview),
      { type: "separator" },
      item(t("Add a review note on the selected line"), { type: "add_note" }, project, "CmdOrCtrl+Alt+N"),
      item(t("Ask About Selection…"), { type: "ask_selection" }, project, "CmdOrCtrl+Alt+/"),
      item(t("Request Changes"), { type: "request_changes" }, project, "CmdOrCtrl+Shift+C"),
      item(t("Commit Accepted…"), { type: "commit" }, can.commit, "CmdOrCtrl+Shift+K"),
      item(t("Create PR from this branch…"), { type: "create_pr" }, can.createPR),
    ],
  };
}

/** The open chat tabs as the Chat menu lists them (at most 9 — ⌘1…⌘9). */
export function chatTabs(state: Pick<ReviewState, "sessions"> | null): string[] {
  const sessions = state?.sessions;
  if (!sessions) return [];
  return sessions.openTabIds.slice(0, 9).map((id) => {
    const title = sessions.list.find((m) => m.id === id)?.title ?? "";
    return title === "" || title === "New chat" ? t("New chat") : title;
  });
}

// MARK: polish p-lifecycle — P4-composer-06: the Mac's Chat menu (⌘T, ⌘⇧W, the tabs at ⌘1…⌘9) and Stop (⌘.).
function chatMenu(needsProject: { enabled: boolean }, can: MenuEnabled, tabs: string[]): MenuItemConstructorOptions {
  return {
    label: mn(t("Chat"), "C"),
    submenu: [
      { label: t("New chat"), ...shownKey("CmdOrCtrl+T"), enabled: can.chatSwitch, click: () => dispatch({ type: "new_chat" }, () => undefined) },
      { label: t("Close Chat Tab"), ...shownKey("CmdOrCtrl+Shift+W"), ...needsProject, click: () => dispatch({ type: "close_chat_tab" }, () => undefined) },
      ...(tabs.length > 0 ? [{ type: "separator" as const }] : []),
      ...tabs.map((title, index): MenuItemConstructorOptions => ({
        label: title.replace(/&/g, "&&"),
        ...shownKey(`CmdOrCtrl+${index + 1}`),
        enabled: can.chatSwitch,
        click: () => dispatch({ type: "chat_tab", index }, () => undefined),
      })),
      { type: "separator" },
      { label: t("Stop"), ...shownKey("CmdOrCtrl+."), enabled: can.stop, click: () => dispatch({ type: "stop" }, () => undefined) },
    ],
  };
}

// MARK: polish p-lifecycle — P1-chrome-07: Windows' jump list (the taskbar icon's right click) lists the recent projects; a
// pick starts ReviewGate with the folder, which the running one opens (src/main/singleInstance.ts). Packaged builds only.
function setJumpList(recents: string[]): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  try {
    app.setJumpList(recents.length === 0 ? null : [{ type: "custom", name: t("Recent Projects"), items: jumpListItems(recents, process.execPath) }]);
  } catch {
    // A jump list the shell refuses (policy, no Start menu shortcut) changes nothing else.
  }
}

/** The jump list's rows: at most 10, each starting the app with its folder (quoted — a path may have spaces), named by
 * the folder's own name whichever separator the path uses. */
export function jumpListItems(recents: string[], exe: string): Electron.JumpListItem[] {
  const name = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  return recents.slice(0, 10).map((p) => ({ type: "task", title: name(p), description: p, program: exe, args: `"${p}"`, iconPath: exe, iconIndex: 0 }));
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

function editMenu(needsProject: { enabled: boolean }): MenuItemConstructorOptions {
  return {
    label: mn(t("Edit"), "E"),
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
      // MARK: polish p-lifecycle (P1-chrome-09): the Mac's Edit › Find in Chat (⌘F) and Find in Diff (⌥⌘F).
      { type: "separator" },
      { label: t("Find in Chat…"), ...shownKey("CmdOrCtrl+F"), ...needsProject, click: () => dispatch({ type: "find_chat" }, () => undefined) },
      { label: t("Find in Diff…"), ...shownKey("CmdOrCtrl+Alt+F"), ...needsProject, click: () => dispatch({ type: "find_diff" }, () => undefined) },
    ],
  };
}

function windowMenu(): MenuItemConstructorOptions {
  return {
    label: mn(t("Window"), "W"),
    submenu: isMac
      ? [{ role: "minimize", label: t("Minimize") }, { role: "zoom", label: t("Zoom") }, { type: "separator" }, { role: "front", label: t("Bring All to Front") }]
      : [{ role: "minimize", label: t("Minimize") }, { role: "close", label: t("Close Window") }],
  };
}
