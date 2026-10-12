/**
 * The window registry: one `ReviewEngine` per BrowserWindow (a window is a workbench —
 * docs/M10-WORKBENCHES.md), the project each window has open, and the M19 operations over them —
 * open in a new window, focus the window that already has a project, restore the last session's
 * windows (docs/M19-MULTIPROJECT.md). The engine runs in-process (docs/M9-ENGINE.md §3.2).
 */
import { app, BrowserWindow, dialog, type WebContents } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlatform, ReviewEngine, type EngineEvent, type HelloCommand } from "@reviewgate/engine";
import type { OpenWindow, WindowBounds } from "../shared/ipc.js";
import type { E2EMode } from "./e2e.js";
import { logLine } from "./log.js";
import { syncFlowSettings } from "./flowSync.js"; // MARK: wave3 desktop-flow
import { addRecentProject, engineSettings, loadSettings, saveSettings, setCachedCapabilities } from "./settings.js";
import { mergedAllowPatterns } from "./projectPatterns.js";
import { allowedProjectStatusLineFor, loadLocalSettingsFor } from "./sessionSettings.js"; // MARK: wave3 desktop-session, wave6 w6-statusline
import { clampToDisplay, persistOpenWindows, restorableWindows, savedBoundsFor } from "./windowState.js";
import { closeConfirmationReason, closeDialogText, type CloseGuardReason } from "./closeGuard.js"; // MARK: wave4 w4-safety
import { routeMovedChat } from "./chatMove.js"; // MARK: wave4b w4b-follow
import { t } from "../renderer/i18n"; // MARK: wave4d w4d-windows (polish-07)

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
  closing: boolean;
  // MARK: wave4 w4-safety — daily-12: the "Claude is working" confirm is open / was answered "Close".
  confirmingClose?: boolean;
  closeConfirmed?: boolean;
};
type Config = { e2e: E2EMode | null; rebuildMenu: () => void };

const windows = new Map<number, Workbench>();
let config: Config = { e2e: null, rebuildMenu: () => undefined };
/** Set by `disposeAll`: shutting down, engines drop their project and `app.exit` destroys every window — neither may erase the list `before-quit` saved. */
let shuttingDown = false;

export function initWindows(c: Config): void {
  config = c;
}

export const engineFor = (sender: WebContents): ReviewEngine | undefined => windows.get(sender.id)?.engine;
export const workbenchFor = (sender: WebContents): Workbench | undefined => windows.get(sender.id);
export const allWorkbenches = (): Workbench[] => [...windows.values()];

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
  return true;
}

/** Live windows that have a project, with their current frame — the `openWindows` snapshot. */
export function persistWindows(): void {
  if (shuttingDown) return;
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
      if (path !== wb.projectPath) {
        if (path) {
          addRecentProject(path);
          config.rebuildMenu();
        }
        wb.projectPath = path;
        if (!wb.closing && !shuttingDown) persistWindows();
      }
      // Per-project allow patterns: the engine's `bashAllowPatterns` follow the project this window has open.
      if (root !== previousRoot && !wb.closing && !shuttingDown) {
        const s = loadSettings();
        const before = mergedAllowPatterns(s.bashAllowPatterns, s.projectBashAllowPatterns, previousRoot);
        const after = mergedAllowPatterns(s.bashAllowPatterns, s.projectBashAllowPatterns, root);
        // wave3 desktop-session — §36.6: the project's own "Load local settings" follows it too (next session start).
        const localChanged = loadLocalSettingsFor(s.projectLoadLocalSettings, previousRoot) !== loadLocalSettingsFor(s.projectLoadLocalSettings, root);
        // wave6 w6-statusline — §44.2: and its own status line allowance (never the last project's).
        const statusLineChanged = allowedProjectStatusLineFor(s.projectStatusLineAllowed, previousRoot) !== allowedProjectStatusLineFor(s.projectStatusLineAllowed, root);
        if (before.join("\n") !== after.join("\n") || localChanged || statusLineChanged) void engine.handle({ type: "set_settings", settings: engineSettings(s, root) });
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
    // MARK: wave4 w4-safety — daily-12: a close that would stop Claude mid-turn (or while it waits) asks first.
    if (!wb.closeConfirmed && !shuttingDown && !config.e2e) {
      const reason = closeConfirmationReason(engine.state, loadSettings());
      if (reason) {
        e.preventDefault();
        if (wb.confirmingClose) return;
        wb.confirmingClose = true;
        void confirmStop(win, [reason], "close").then((ok) => {
          wb.confirmingClose = false;
          if (!ok || win.isDestroyed()) return;
          wb.closeConfirmed = true;
          win.close();
        });
        return;
      }
    }
    e.preventDefault();
    wb.closing = true;
    persistWindows();
    void withTimeout(engine.dispose(), 3000).finally(() => {
      if (!win.isDestroyed()) win.destroy();
    });
  });
  win.on("closed", () => {
    windows.delete(id);
    persistWindows();
    void engine.dispose().catch(() => undefined);
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

// MARK: wave4 w4-safety
/** Every window whose close would stop Claude now — the quit confirm's count (none while the question is off). */
export function workingReasons(): CloseGuardReason[] {
  if (config.e2e) return [];
  const settings = loadSettings();
  return [...windows.values()].flatMap((w) => {
    if (w.closing || w.win.isDestroyed()) return [];
    const r = closeConfirmationReason(w.engine.state, settings);
    return r ? [r] : [];
  });
}

/**
 * daily-12: "Claude is working — closing stops this turn" with [Close / Quit] [Cancel] and "Don't ask again" (kept only
 * when the user goes ahead). Resolves true to go ahead.
 */
export async function confirmStop(owner: BrowserWindow | null, reasons: CloseGuardReason[], kind: "close" | "quit"): Promise<boolean> {
  const text = closeDialogText(reasons, kind);
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    message: text.title,
    detail: text.message,
    buttons: [text.confirm, text.cancel],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    checkboxLabel: text.dontAskAgain,
    checkboxChecked: false,
  };
  const r = owner && !owner.isDestroyed() ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (r.response !== 0) return false;
  if (r.checkboxChecked) saveSettings({ confirmCloseWhileWorking: false });
  return true;
}

export function withTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([p.catch(() => undefined), new Promise<void>((r) => setTimeout(r, ms))]).then(() => undefined);
}
