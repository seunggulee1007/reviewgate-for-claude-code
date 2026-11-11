/**
 * The window registry: one `ReviewEngine` per BrowserWindow (a window is a workbench —
 * docs/M10-WORKBENCHES.md), the project each window has open, and the M19 operations over them —
 * open in a new window, focus the window that already has a project, restore the last session's
 * windows (docs/M19-MULTIPROJECT.md). The engine runs in-process (docs/M9-ENGINE.md §3.2).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, type WebContents } from "electron";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlatform, ReviewEngine, type EngineEvent, type HelloCommand } from "@reviewgate/engine";
import type { OpenWindow, WindowBounds } from "../shared/ipc.js";
import type { E2EMode } from "./e2e.js";
import { logLine } from "./log.js";
import { syncFlowSettings } from "./flowSync.js"; // MARK: wave3 desktop-flow
import { addRecentProject, engineSettings, loadSettings, saveSettings, setCachedCapabilities } from "./settings.js";
import { mergedAllowPatterns } from "./projectPatterns.js";
import { allowedProjectStatusLineFor, loadLocalSettingsFor } from "./sessionSettings.js"; // MARK: wave3 desktop-session, wave6 w6-statusline
import { clampToDisplay, MAX_RESTORED_WINDOWS, openWindowsToWrite, persistOpenWindows, restorableWindows, savedBoundsFor } from "./windowState.js";
// MARK: wave4 w4-safety / polish p-lifecycle (P1-chrome-01): the close / quit questions with each window's reasons
import { closePrompt, NO_EXTRAS, projectChangePrompt, quitPrompt, validExtras, windowQuitState, type CloseGuardExtras, type QuitPrompt } from "../shared/closeGuard.js";
import { routeMovedChat } from "./chatMove.js"; // MARK: wave4b w4b-follow
import { sameMenuState, validMenuState, type MenuEnabled } from "../shared/menuState.js"; // MARK: polish p-lifecycle (P1-chrome-09)
import { t } from "../renderer/i18n"; // MARK: wave4d w4d-windows (polish-07)
import { textContextMenu } from "./contextMenu.js"; // MARK: polish p-lifecycle (P3-transcript-09 / P4-composer-11)

const here = fileURLToPath(new URL(".", import.meta.url));
const PRELOAD = join(here, "preload.cjs");
const RENDERER_HTML = join(here, "..", "renderer", "index.html");
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
/** The only pages a window may show (src/main/navigationGuard.ts). */
export const APP_ORIGIN = { fileURL: pathToFileURL(RENDERER_HTML).href, ...(DEV_URL ? { devURL: DEV_URL } : {}) };
/** A restored window gets this long to report its `open_project` before the next one is opened (§Notes). */
const RESTORE_STEP_MS = 1500;

export type Workbench = {
  win: BrowserWindow;
  engine: ReviewEngine;
  projectPath: string | null;
  projectRoot: string | null;
  /** MARK: r2-skills-side — §33.6 (M21): the open project's repository (`state.project.commonDir`): its allow patterns. */
  projectRepo?: string | null;
  closing: boolean;
  // MARK: wave4 w4-safety — daily-12: the "Claude is working" confirm is open / was answered "Close".
  confirmingClose?: boolean;
  closeConfirmed?: boolean;
  // MARK: polish p-lifecycle (P1-chrome-09)
  /** What the page said its Review and Chat menu items can do now (`rg:menuState`); null until it says. */
  menuEnabled?: MenuEnabled | null;
  /** The chat tabs the menu last listed for this window (their ids and titles). */
  menuTabs?: string;
};
type Config = { e2e: E2EMode | null; rebuildMenu: () => void };

const windows = new Map<number, Workbench>();
let config: Config = { e2e: null, rebuildMenu: () => undefined };
/** Set by `disposeAll`: shutting down, engines drop their project and `app.exit` destroys every window — neither may erase the list `before-quit` saved. */
let shuttingDown = false;
// MARK: polish p-lifecycle
/** PX-14: Windows is logging off, restarting or shutting down — nothing asks (a question would hold the session end back). */
let sessionEnding = false;
/** P1-chrome-01: the quit `before-quit` is about to ask about came from the last window's close (its question says so). */
let lastWindowQuit = false;
/** P1-chrome-01: the page's answers to `rg:closeGuardQuery`, by query id. */
const extrasWaiters = new Map<number, { sender: number; done: (extras: CloseGuardExtras) => void }>();
let nextExtrasQuery = 1;

export function initWindows(c: Config): void {
  config = c;
  // MARK: polish p-lifecycle (P1-chrome-01): what only a window's page knows — the lines its parts registered, the message
  // being typed, the queue, side questions — for the question main is about to ask (src/shared/closeGuard.ts).
  ipcMain.on("rg:closeGuardExtras", (evt, id: unknown, raw: unknown) => {
    const waiter = typeof id === "number" ? extrasWaiters.get(id) : undefined;
    if (waiter && waiter.sender === evt.sender.id) waiter.done(validExtras(raw));
  });
  // MARK: polish p-lifecycle (P1-chrome-09): the page says what its menu items can do; the focused window's build the menu.
  ipcMain.on("rg:menuState", (evt, raw: unknown) => {
    const wb = windows.get(evt.sender.id);
    if (!wb) return;
    const next = validMenuState(raw);
    if (sameMenuState(wb.menuEnabled ?? null, next)) return;
    wb.menuEnabled = next;
    if (BrowserWindow.getFocusedWindow() === wb.win) config.rebuildMenu();
  });
  // MARK: polish p-lifecycle (P1-chrome-03): switching or closing the window's project stops its session — the page asks
  // here before it does, with what only it knows; the question is the close's (src/shared/closeGuard.ts `projectChangePrompt`).
  ipcMain.handle("rg:confirmProjectChange", async (evt, change: unknown, raw: unknown) => {
    const wb = windows.get(evt.sender.id);
    if (!wb || wb.win.isDestroyed() || config.e2e || (change !== "switch" && change !== "close")) return { asked: false, ok: true };
    const prompt = projectChangePrompt(windowQuitState(wb.engine.state, validExtras(raw)), change, loadSettings());
    if (!prompt) return { asked: false, ok: true };
    const answer = await ask(wb.win, prompt);
    if (answer.suppress) saveSettings({ confirmCloseWhileWorking: false });
    return { asked: true, ok: answer.ok };
  });
}

export const isSessionEnding = (): boolean => sessionEnding;
/** True once after the last window's close turned into `app.quit()` (P1-chrome-01). */
export function takeLastWindowQuit(): boolean {
  const was = lastWindowQuit;
  lastWindowQuit = false;
  return was;
}

/** Asks `wb`'s page for what only it knows (at most `ms`; a page that does not answer counts as having nothing). */
function askExtras(wb: Workbench, ms = 600): Promise<CloseGuardExtras> {
  if (wb.win.isDestroyed() || wb.win.webContents.isDestroyed()) return Promise.resolve(NO_EXTRAS);
  const id = nextExtrasQuery++;
  return new Promise((resolve) => {
    const done = (extras: CloseGuardExtras) => {
      if (!extrasWaiters.delete(id)) return;
      clearTimeout(timer);
      resolve(extras);
    };
    const timer = setTimeout(() => done(NO_EXTRAS), ms);
    extrasWaiters.set(id, { sender: wb.win.webContents.id, done });
    wb.win.webContents.send("rg:closeGuardQuery", id);
  });
}

export const engineFor = (sender: WebContents): ReviewEngine | undefined => windows.get(sender.id)?.engine;
export const workbenchFor = (sender: WebContents): Workbench | undefined => windows.get(sender.id);
export const allWorkbenches = (): Workbench[] => [...windows.values()];
/** MARK: polish p-lifecycle (P1-chrome-09): the focused window's workbench — the menu bar follows it. */
export function focusedWorkbench(): Workbench | undefined {
  const win = BrowserWindow.getFocusedWindow();
  return win ? windows.get(win.webContents.id) : undefined;
}

/** The window that has `projectPath` open — matched on the opened path or on its repository root. */
export function findWindowFor(projectPath: string): Workbench | undefined {
  const p = resolve(projectPath);
  return [...windows.values()].find((w) => [w.projectPath, w.projectRoot].some((x) => x !== null && x !== undefined && resolve(x) === p));
}

export function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * M19: the engine lock is held by another of OUR windows (our engines share this process's pid, so
 * the registry — not the pid — decides): focus it instead of offering a take-over.
 */
export function focusProjectWindow(path: string, exceptId?: number): boolean {
  const wb = findWindowFor(path);
  if (!wb || wb.win.isDestroyed() || wb.win.webContents.id === exceptId) return false;
  logLine("main", "main", `w${wb.win.webContents.id} already has ${path} open — focusing it`);
  focusWindow(wb.win);
  // It may be the window in front already, where coming forward shows nothing: it says so (as the Mac does).
  wb.win.webContents.send("rg:toast", t("{0} is already open in this window", basename(resolve(path))));
  return true;
}

/** Live windows that have a project, with their current frame — the `openWindows` snapshot. */
export function persistWindows(): void {
  // polish P1-chrome-02: never while quitting, never an empty list because the last window went (`openWindowsToWrite`).
  const all = [...windows.values()];
  if (openWindowsToWrite(all.map((w) => ({ projectPath: w.projectPath, destroyed: w.win.isDestroyed() })), shuttingDown) === null) return;
  const open: OpenWindow[] = [];
  const boundsKeys: Record<string, WindowBounds> = {};
  for (const wb of windows.values()) {
    if (wb.projectPath === null || wb.win.isDestroyed()) continue;
    const bounds = wb.win.getNormalBounds();
    open.push({ path: wb.projectPath, bounds });
    boundsKeys[wb.projectRoot ?? wb.projectPath] = bounds;
  }
  persistOpenWindows(open, boundsKeys);
}

export function createWindow(opts: { project?: string; bounds?: WindowBounds; e2eRole?: "primary" | "secondary" } = {}): Workbench {
  const settings = loadSettings();
  const args = [`--rg-locale=${app.getLocale()}`];
  if (opts.e2eRole && config.e2e) args.push(`--rg-e2e=${opts.e2eRole}`, `--rg-project=${config.e2e.project}`);
  else if (opts.project) args.push(`--rg-project=${opts.project}`);
  const saved = opts.bounds ?? (opts.project ? savedBoundsFor(opts.project) : undefined);
  const bounds = saved ? clampToDisplay(saved) : null;
  const win = new BrowserWindow({
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    width: bounds?.width ?? 1400,
    height: bounds?.height ?? 900,
    minWidth: 900,
    minHeight: 560,
    title: "ReviewGate",
    show: false,
    webPreferences: {
      preload: PRELOAD,
      // The renderer only talks to main through the preload's `window.rg` (src/preload.ts uses no Node modules).
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      additionalArguments: args,
      spellcheck: false,
    },
  });
  const id = win.webContents.id;
  const prefix = `w${id}`;
  const engine = new ReviewEngine({
    platform: createPlatform(process.platform),
    env: process.env as Record<string, string>,
    log: (level, msg) => logLine(prefix, level, msg),
  });
  const wb: Workbench = { win, engine, projectPath: null, projectRoot: null, closing: false };
  windows.set(id, wb);
  logLine("main", "main", `window ${prefix}: new engine${opts.project ? ` for ${opts.project}` : ""} (${windows.size} open)`);

  engine.on((ev: EngineEvent) => {
    if (ev.type === "state") {
      const path = ev.state.project?.path ?? null;
      const root = ev.state.project?.root ?? null;
      const previousRoot = wb.projectRoot;
      wb.projectRoot = root;
      // MARK: r2-skills-side (§33.6, M21): the repository the "always allow" list is kept by (not `repo` below: the title's).
      const commonDir = ev.state.project?.commonDir ?? null;
      const previousCommonDir = wb.projectRepo ?? null;
      wb.projectRepo = commonDir;
      if (path !== wb.projectPath) {
        if (path) {
          addRecentProject(path);
          config.rebuildMenu();
        }
        wb.projectPath = path;
        if (!wb.closing && !shuttingDown) persistWindows();
      }
      // Per-project allow patterns: the engine's `bashAllowPatterns` follow the project this window has open.
      if ((root !== previousRoot || commonDir !== previousCommonDir) && !wb.closing && !shuttingDown) {
        const s = loadSettings();
        const before = mergedAllowPatterns(s.bashAllowPatterns, s.projectBashAllowPatterns, previousRoot, previousCommonDir);
        const after = mergedAllowPatterns(s.bashAllowPatterns, s.projectBashAllowPatterns, root, commonDir);
        // wave3 desktop-session — §36.6: the project's own "Load local settings" follows it too (next session start).
        const localChanged = loadLocalSettingsFor(s.projectLoadLocalSettings, previousRoot) !== loadLocalSettingsFor(s.projectLoadLocalSettings, root);
        // wave6 w6-statusline — §44.2: and its own status line allowance (never the last project's).
        const statusLineChanged = allowedProjectStatusLineFor(s.projectStatusLineAllowed, previousRoot) !== allowedProjectStatusLineFor(s.projectStatusLineAllowed, root);
        if (before.join("\n") !== after.join("\n") || localChanged || statusLineChanged) void engine.handle({ type: "set_settings", settings: engineSettings(s, root, commonDir) });
      }
      // wave3 desktop-session — §36.5: never the empty starting lists or the engine's replayed cache.
      const caps = ev.state.session.capabilities;
      if (caps && caps.state !== "starting" && ev.state.session.capabilitiesCached !== true && !settings.cachedCapabilities) {
        settings.cachedCapabilities = caps;
        setCachedCapabilities(caps);
      }
      const repo = ev.state.workbenches.list.find((w) => w.isMain)?.path ?? ev.state.project?.root ?? ev.state.project?.path;
      const name = repo ? repo.split(/[\\/]/).filter(Boolean).pop() : null;
      const branch = ev.state.project?.branch;
      if (!win.isDestroyed()) win.setTitle(name ? (branch ? `${name} — ${branch}` : name) : "ReviewGate");
      // MARK: wave3 desktop-flow — §36.11 / §36.12: the repository's commit template and workbench setup follow the window.
      if (!wb.closing && !shuttingDown) syncFlowSettings(engine, ev.state, loadSettings());
      // MARK: polish p-lifecycle (P1-chrome-09 / P4-composer-06): the Chat menu lists the focused window's tabs.
      const tabs = JSON.stringify([ev.state.sessions?.openTabIds ?? [], (ev.state.sessions?.list ?? []).map((m) => m.title)]);
      if (tabs !== wb.menuTabs) {
        wb.menuTabs = tabs;
        if (!win.isDestroyed() && BrowserWindow.getFocusedWindow() === win) config.rebuildMenu();
      }
    }
    // MARK: wave4b w4b-follow — §39.4: the chat went to another worktree; that worktree's window takes it (or opens).
    if (ev.type === "chat_moved" && !shuttingDown) routeMovedChat(wb, ev, { findWindowFor, focusWindow, openWindow: (path) => createWindow({ project: path }) });
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("rg:evt", ev);
  });

  const hello: HelloCommand = {
    type: "hello",
    protocolVersion: 2,
    client: process.platform === "win32" ? "windows" : "mac",
    settings: engineSettings(settings),
  };
  void engine.handle(hello);

  win.once("ready-to-show", () => win.show());
  // Close = persist the frame, dispose first (≤ 3 s: stops `claude`, releases the lock), then destroy (§3.7).
  win.on("close", (e) => {
    if (wb.closing) return;
    e.preventDefault();
    if (wb.closeConfirmed || shuttingDown || sessionEnding || config.e2e) return closeNow();
    // MARK: polish p-lifecycle (P1-chrome-01 / P1-chrome-02): on Windows and Linux the last window's ✕ / Alt+F4 is a quit —
    // `before-quit` asks, writes the window list while this window is still in it, and stops every engine once.
    if (windows.size === 1 && process.platform !== "darwin") {
      lastWindowQuit = true;
      app.quit();
      return;
    }
    // wave4 w4-safety — daily-12: a close that would stop Claude (or lose work) asks first, with the reasons.
    if (wb.confirmingClose) return;
    wb.confirmingClose = true;
    void askExtras(wb).then(async (extras) => {
      const settings = loadSettings();
      const prompt = win.isDestroyed() ? null : closePrompt(windowQuitState(engine.state, extras), settings);
      const answer = prompt ? await ask(win, prompt) : { ok: true, suppress: false };
      wb.confirmingClose = false;
      if (!answer.ok || win.isDestroyed()) return;
      if (answer.suppress) saveSettings({ confirmCloseWhileWorking: false });
      closeNow();
    });
  });
  function closeNow(): void {
    wb.closing = true;
    persistWindows();
    // P1-chrome-05: the window goes at once; its engine stops behind it.
    if (!win.isDestroyed()) win.hide();
    void withTimeout(engine.dispose(), 3000).finally(() => {
      if (!win.isDestroyed()) win.destroy();
    });
  }
  win.on("closed", () => {
    windows.delete(id);
    // P1-chrome-02 / P5-sheets-54: the last window going away keeps the list it was in (`persistWindows` writes none then).
    persistWindows();
    void engine.dispose().catch(() => undefined);
  });
  // MARK: polish p-lifecycle — PX-14: Windows logs off, restarts or shuts down — the window list is written now and the
  // engines stop (≤ 3 s); no question holds the session end back.
  win.on("query-session-end", () => {
    sessionEnding = true;
    persistWindows();
  });
  win.on("session-end", () => {
    sessionEnding = true;
    void withTimeout(disposeAll(), 3000);
  });
  // MARK: polish p-lifecycle — P3-transcript-09 / P4-composer-11: a right click on text gets the usual menu (a part of the
  // page with a menu of its own prevents the default and never gets it).
  win.webContents.on("context-menu", (_e, p) => {
    const items = textContextMenu(p, { copyLink: (url) => clipboard.writeText(url), replaceMisspelling: (word) => win.webContents.replaceMisspelling(word) });
    if (items.length > 0 && !win.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: win });
  });
  // Navigation, popups and <webview> are locked down for every webContents in src/main/navigationGuard.ts.
  if (config.e2e || process.env.REVIEWGATE_VERBOSE) {
    win.webContents.on("console-message", (d) => process.stderr.write(`[renderer:${d.level}] ${d.message} (${d.sourceId}:${d.lineNumber})\n`));
    win.webContents.on("did-fail-load", (_e, code, desc) => process.stderr.write(`[renderer] did-fail-load ${code} ${desc}\n`));
    win.webContents.on("render-process-gone", (_e, d) => process.stderr.write(`[renderer] gone ${d.reason}\n`));
  }
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(RENDERER_HTML);
  return wb;
}

/** M19: File → Open in New Window… (⌘⇧N) and the "Open in New Window" rows — a folder picker when no path. */
export async function openInNewWindow(path?: string, parent?: BrowserWindow | null): Promise<void> {
  let target = path;
  if (!target) {
    const options: Electron.OpenDialogOptions = { properties: ["openDirectory"], title: t("Open in New Window") }; // MARK: wave4d w4d-windows
    const owner = parent ?? BrowserWindow.getFocusedWindow();
    const r = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (r.canceled || r.filePaths.length === 0) return;
    target = r.filePaths[0]!;
  }
  if (focusProjectWindow(target)) return;
  createWindow({ project: target });
}

/**
 * Launch without `REVIEWGATE_PROJECT`: reopen the saved windows one at a time — each gets until its
 * `open_project` lands (or 1.5 s) so two engines never fight over one lock. The first gets focus.
 */
export async function restoreWindows(): Promise<boolean> {
  const entries = restorableWindows();
  if (entries.length === 0) return false;
  logLine("main", "main", `restore: reopening ${entries.length} window(s): ${entries.map((e) => e.path).join(", ")}`);
  const opened: Workbench[] = [];
  for (const entry of entries) {
    const wb = createWindow({ project: entry.path, bounds: entry.bounds });
    opened.push(wb);
    for (const deadline = Date.now() + RESTORE_STEP_MS; wb.projectPath === null && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 50));
  }
  const first = opened[0];
  if (first && !first.win.isDestroyed()) focusWindow(first.win);
  return true;
}

export async function disposeAll(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...windows.values()].map((w) => w.engine.dispose().catch(() => undefined)));
}

// MARK: wave4 w4-safety / polish p-lifecycle (P1-chrome-01)
/**
 * The quit question over every window — ⌘Q / Ctrl+Q, the menu's Quit, the last window's close (`kind`). Resolves true to
 * quit: nothing asked (no window, the switches off, e2e) or the user said Quit ("Don't ask again" turns off `confirmQuit`).
 */
export async function confirmQuit(kind: "quit" | "lastWindow"): Promise<boolean> {
  const open = [...windows.values()].filter((w) => !w.closing && !w.win.isDestroyed());
  if (config.e2e || sessionEnding || open.length === 0) return true;
  const states = await Promise.all(open.map(async (w) => windowQuitState(w.engine.state, await askExtras(w))));
  const settings = loadSettings();
  const projects = open.filter((w) => w.projectPath !== null).length;
  const reopen = settings.reopenLastProjects === false ? null : Math.min(projects, MAX_RESTORED_WINDOWS);
  const prompt = quitPrompt(states, kind, settings, reopen);
  if (!prompt) return true;
  const owner = BrowserWindow.getFocusedWindow() ?? open[0]?.win ?? null;
  const answer = await ask(owner, prompt);
  if (answer.ok && answer.suppress) saveSettings({ confirmQuit: false });
  return answer.ok;
}

/** P1-chrome-05: once a quit goes ahead every window goes at once; the engines stop behind them. */
export function hideAllWindows(): void {
  for (const w of windows.values()) if (!w.win.isDestroyed()) w.win.hide();
}

/**
 * A question (src/shared/closeGuard.ts `QuitPrompt`) as a message box: [Quit / Close / Switch …] [Cancel], "Don't ask again"
 * when it offers it, Cancel the default when something would be lost. `ok`: the user went ahead.
 */
export async function ask(owner: BrowserWindow | null, prompt: QuitPrompt): Promise<{ ok: boolean; suppress: boolean }> {
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    message: prompt.title,
    detail: prompt.message,
    buttons: [prompt.confirm, prompt.cancel],
    defaultId: prompt.cancelIsDefault ? 1 : 0,
    cancelId: 1,
    noLink: true,
    ...(prompt.offersSuppression ? { checkboxLabel: prompt.dontAskAgain, checkboxChecked: false } : {}),
  };
  const r = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return { ok: r.response === 0, suppress: r.response === 0 && r.checkboxChecked === true };
}

export function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([p.catch(() => undefined), new Promise<void>((r) => setTimeout(r, ms))]).then(() => undefined);
}
