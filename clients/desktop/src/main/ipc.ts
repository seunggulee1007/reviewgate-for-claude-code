/**
 * `rg:*` IPC handlers (src/shared/ipc.ts `RGBridge`). Engine commands are validated against the
 * client allowlist (src/main/ipcGuard.ts) before they reach `ReviewEngine`; URLs handed to the shell
 * must be http(s). `rg:e2e:*` handlers live in src/main/e2e.ts and exist only under `--e2e`.
 */
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type WebContents } from "electron";
import { openSync, readSync, closeSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { EngineCommand, ReviewEngine } from "@reviewgate/engine";
import type { AppSettings, EditorKind, ProjectUI, ToolchainInfo } from "../shared/ipc.js";
import { checkImage, IMAGE_EXTENSIONS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type PickedImage } from "../shared/attachments.js";
import { openInEditor } from "./editor.js";
import { isOpenableMarkdown } from "./markdownOpen.js"; // MARK: wave4d w4d-config (§42.3)
import { isOpenableGraphHtml } from "./graphOpen.js"; // MARK: wave5 w5-graph (§43.3)
// MARK: wave3 desktop-flow
import { resyncFlowSettings } from "./flowSync.js";
import { createSetupReports } from "./flowWindows.js";
import { isComposerDraft } from "../shared/flowSettings.js";
import { requestWithDetails } from "./engineRequest.js";
import { isSafeExternalURL, validateCommand, type Validated } from "./ipcGuard.js";
import { logDir, logLine } from "./log.js";
import { applyAppearance, engineSettings, loadSettings, saveSettings, saveProjectUI, setExecutablePath } from "./settings.js";
import { allowedNames, isExecutableKind, sanitizeSettingsPatch, validateExecutable } from "./settingsGuard.js";
import { refusalText } from "./settingsGuard.js"; // MARK: wave4d w4d-windows
import { t } from "../renderer/i18n"; // MARK: wave4d w4d-windows (polish-07): dialog titles in the UI language
// MARK: wave3 desktop-session
import { projectOpenPath } from "./sessionSettings.js";
import { pinnedVersionPath } from "./cliPin.js";
import { isDirectory, isTransientProjectPath, recentEntries, withoutRecent } from "./recentProjects.js"; // MARK: wave4 w4-install

type Deps = {
  engineFor: (sender: WebContents) => ReviewEngine | undefined;
  /** Every window's engine with the project root it has open (per-project allow patterns, `engineSettings`). */
  allEngines: () => { engine: ReviewEngine; projectRoot: string | null }[];
  findWindowFor: (path: string) => { win: BrowserWindow; engine: ReviewEngine } | undefined;
  createWindow: (opts: { project?: string }) => unknown;
  /** M19: open `path` (or a folder the user picks) in a new window — focuses the window that has it. */
  openInNewWindow: (path: string | undefined, parent: BrowserWindow | null) => Promise<void>;
  /** M19: focus another window that already has `path` open. */
  focusProjectWindow: (path: string, exceptId?: number) => boolean;
  rebuildMenu: () => void;
};

export function installIPC(deps: Deps): void {
  const withEngine = <T>(sender: WebContents, f: (engine: ReviewEngine) => T): T => {
    const engine = deps.engineFor(sender);
    if (!engine) throw new Error("no engine for this window");
    return f(engine);
  };
  /** A refusal is logged and returned as `{__error}` (the preload turns it into a rejection). */
  const guarded = (sender: WebContents, raw: unknown): Validated => {
    const v = validateCommand(raw);
    if (!v.ok) logLine(`w${sender.id}`, "warn", `ipc: ${v.error}`);
    return v;
  };

  /**
   * MARK: wave3 desktop-session — §36.6: the project's own settings (`loadLocalSettings`, its allow patterns) go to the engine
   * right before its `open_project` / `switch_project` — the same main lane, so the session that starts has them.
   */
  const beforeOpen = (engine: ReviewEngine, cmd: EngineCommand) => {
    const path = projectOpenPath(cmd);
    if (path) void engine.handle({ type: "set_settings", settings: engineSettings(loadSettings(), path) });
  };
  ipcMain.handle("rg:cmd", (evt, raw: unknown) => {
    const v = guarded(evt.sender, raw);
    if (!v.ok) return { __error: v.error };
    return withEngine(evt.sender, (e) => {
      beforeOpen(e, v.cmd);
      return e.handle(v.cmd);
    });
  });
  ipcMain.handle("rg:request", async (evt, raw: unknown) => {
    const v = guarded(evt.sender, raw);
    if (!v.ok) return { __error: v.error };
    try {
      // `result{ok:false}` → `{__error, __code?, __paths?}` (docs/PROTOCOL.md §19.6); the preload turns it into a rejection.
      return await withEngine(evt.sender, (e) => {
        beforeOpen(e, v.cmd);
        return requestWithDetails(e, v.cmd);
      });
    } catch (err) {
      return { __error: err instanceof Error ? err.message : String(err) };
    }
  });
  /** Renderer (re)loaded: resend the current snapshot so nothing emitted before `did-finish-load` is lost. */
  ipcMain.handle("rg:attach", (evt) => withEngine(evt.sender, (e) => e.state));
  ipcMain.handle("rg:chooseDirectory", async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: t("Open Project") });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  ipcMain.handle("rg:openInEditor", (_e, path: string, line: number | null, editor?: EditorKind) => openInEditor(path, line, editor ?? loadSettings().preferredEditor));
  ipcMain.handle("rg:openExternal", (evt, url: unknown) => {
    if (isSafeExternalURL(url)) return shell.openExternal(url);
    logLine(`w${evt.sender.id}`, "warn", `blocked openExternal to ${String(url)}`);
    return undefined;
  });
  ipcMain.handle("rg:openLog", () => shell.openPath(logDir()));
  ipcMain.handle("rg:showItemInFolder", (_e, path: string) => shell.showItemInFolder(path));
  // MARK: wave4d w4d-config — §42.3: an instruction file in the default app (a Markdown file that exists, nothing else).
  ipcMain.handle("rg:openMarkdown", (evt, path: unknown) => {
    if (isOpenableMarkdown(path)) return shell.openPath(path);
    logLine(`w${evt.sender.id}`, "warn", "blocked openMarkdown: not a Markdown file that exists");
    return "refused";
  });
  // MARK: wave5 w5-graph — §43.3: graphify's graph.html in the default browser (graphify-out/graph.html that exists, nothing else).
  ipcMain.handle("rg:openGraphHtml", (evt, path: unknown) => {
    if (isOpenableGraphHtml(path)) return shell.openPath(path);
    logLine(`w${evt.sender.id}`, "warn", "blocked openGraphHtml: not graphify-out/graph.html that exists");
    return "refused";
  });
  ipcMain.handle("rg:getSettings", () => loadSettings());
  // MARK: wave4 w4-install (daily-17): the recent list as shown (no temp folders, gone ones marked) and its clean-up.
  ipcMain.handle("rg:recentProjects", () => recentEntries(loadSettings().recentProjects));
  ipcMain.handle("rg:removeRecentProject", (_e, path: unknown) => {
    const list = loadSettings().recentProjects;
    const next = typeof path === "string" ? withoutRecent(list, path) : list.filter((p) => isTransientProjectPath(p) || isDirectory(p));
    const saved = next.length === list.length ? loadSettings() : saveSettings({ recentProjects: next });
    deps.rebuildMenu();
    return saved;
  });
  /** budget / ignorePatterns / ghHost / worktreeRoot apply live; the rest at the next open_project (docs/PROTOCOL.md §3). */
  const broadcastSettings = (next: AppSettings) => {
    for (const { engine, projectRoot } of deps.allEngines()) void engine.handle({ type: "set_settings", settings: engineSettings(next, projectRoot) });
    // MARK: wave3 desktop-flow — §36.11 / §36.12: an edited template / setup reaches its repository's windows now.
    for (const { engine } of deps.allEngines()) resyncFlowSettings(engine, next);
    deps.rebuildMenu();
  };
  ipcMain.handle("rg:setSettings", (evt, raw: unknown) => {
    // Only the renderer-writable keys with valid values (src/main/settingsGuard.ts); executable paths never.
    const { patch, rejected } = sanitizeSettingsPatch(raw);
    if (rejected.length > 0) logLine(`w${evt.sender.id}`, "warn", `ipc: setSettings ignored ${rejected.join(", ")}`);
    if (Object.keys(patch).length === 0) return loadSettings();
    const next = saveSettings(patch);
    // M18: the OS chrome (titlebar, menus, native dialogs) follows `appearance` immediately.
    if (patch.appearance !== undefined) applyAppearance(next.appearance);
    broadcastSettings(next);
    return next;
  });
  /**
   * Executable overrides: main shows the native file dialog, validates the picked file (absolute,
   * exists, executable, named like the tool) and stores it. The renderer never sends a path.
   * Resolves the new settings, or null when the dialog was cancelled.
   */
  ipcMain.handle("rg:pickExecutable", async (evt, kind: unknown) => {
    if (!isExecutableKind(kind)) return { __error: "unknown tool" };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const names = allowedNames(kind, process.platform);
    const options: Electron.OpenDialogOptions = {
      title: t("Choose {0}", kind),
      properties: ["openFile", "dontAddToRecent"],
      ...(process.platform === "win32" ? { filters: [{ name: kind, extensions: [...new Set(names.map((n) => n.split(".").pop()!))] }] } : {}),
    };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (r.canceled || r.filePaths.length === 0) return null;
    const path = r.filePaths[0]!;
    const why = validateExecutable(path, kind);
    if (why) {
      logLine(`w${evt.sender.id}`, "warn", `pickExecutable(${kind}): refused ${path} (${why})`);
      return { __error: refusalText(why, kind) }; // MARK: wave4d w4d-windows (polish-07): Settings shows it in the UI language
    }
    const next = setExecutablePath(kind, path);
    logLine(`w${evt.sender.id}`, "main", `pickExecutable(${kind}): ${path}`);
    broadcastSettings(next);
    return next;
  });
  /**
   * MARK: wave3 desktop-session — §36.8 "Pin previous version" / Settings "Pin CLI version": the renderer names a version,
   * main builds `~/.local/share/claude/versions/<ver>`, validates it and stores it as `claudePath` (next session start).
   */
  ipcMain.handle("rg:pinClaudeVersion", (evt, version: unknown) => {
    const refuse = (why: string) => {
      logLine(`w${evt.sender.id}`, "warn", `pinClaudeVersion(${String(version).slice(0, 40)}): refused (${why})`);
      return { __error: refusalText(why, "claude") }; // MARK: wave4d w4d-windows (polish-07)
    };
    const found = pinnedVersionPath(version);
    if ("error" in found) return refuse(found.error);
    const why = validateExecutable(found.path, "claude");
    if (why) return refuse(why);
    const next = setExecutablePath("claude", found.path);
    logLine(`w${evt.sender.id}`, "main", `pinClaudeVersion: ${found.path}`);
    broadcastSettings(next);
    return next;
  });
  /** Back to auto-detection for one tool (clearing needs no validation). */
  ipcMain.handle("rg:clearExecutable", (_e, kind: unknown) => {
    if (!isExecutableKind(kind)) return { __error: "unknown tool" };
    const next = setExecutablePath(kind, "");
    broadcastSettings(next);
    return next;
  });
  ipcMain.handle("rg:setUI", (_e, hash: unknown, patch: unknown) => {
    if (typeof hash === "string" && /^[0-9a-f]{8}$/.test(hash) && typeof patch === "object" && patch !== null) saveProjectUI(hash, patch as ProjectUI);
  });
  ipcMain.handle("rg:openWorkbenchWindow", (_e, path: string, setupReport?: unknown) => {
    // MARK: wave3 desktop-flow — §36.12: a failed setup's log goes with the window that opens the new workbench.
    if (setupReport !== undefined) setupReports.remember(path, setupReport);
    const existing = deps.findWindowFor(path);
    if (existing) {
      existing.win.focus();
      return;
    }
    deps.createWindow({ project: path });
  });
  ipcMain.handle("rg:openInNewWindow", (evt, path: unknown) =>
    deps.openInNewWindow(typeof path === "string" && path.length > 0 ? path : undefined, BrowserWindow.fromWebContents(evt.sender)),
  );
  ipcMain.handle("rg:focusProjectWindow", (evt, path: unknown) => (typeof path === "string" && path.length > 0 ? deps.focusProjectWindow(path, evt.sender.id) : false));
  ipcMain.handle("rg:closeProjectInWindow", async (evt, path: string) => {
    const other = deps.findWindowFor(path);
    if (!other || other.win.webContents.id === evt.sender.id) return false;
    await other.engine.handle({ type: "close_project" });
    other.win.close();
    return true;
  });
  ipcMain.handle("rg:logError", (evt, message: unknown) => {
    if (typeof message === "string") logLine(`w${evt.sender.id}`, "error", `renderer: ${message.slice(0, 16_000)}`);
  });
  ipcMain.handle("rg:copyText", (_e, text: unknown) => {
    if (typeof text === "string" && text.length <= 1_000_000) clipboard.writeText(text);
  });
  /**
   * §24 attach button: main shows the image file dialog and reads the picked files itself — the renderer never names a
   * path. Each file is checked like the engine will (magic number, ≤ 5 MiB) before its bytes are read; at most 5.
   */
  ipcMain.handle("rg:pickImages", async (evt): Promise<PickedImage[]> => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const options: Electron.OpenDialogOptions = {
      title: t("Attach images"),
      properties: ["openFile", "multiSelections", "dontAddToRecent"],
      filters: [{ name: t("Images"), extensions: [...IMAGE_EXTENSIONS] }],
    };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (r.canceled) return [];
    return r.filePaths.slice(0, MAX_ATTACHMENTS).map((path) => readPickedImage(path));
  });
  ipcMain.handle("rg:toolchainInfo", (): ToolchainInfo => ({ platform: process.platform, electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }));
  // MARK: wave3 desktop-flow (src/main/flowWindows.ts)
  /** §36.12: the new workbench's window takes its failed setup's report once its project is open. */
  ipcMain.handle("rg:takeWorkbenchSetupReport", (_e, paths: unknown) => setupReports.take(paths));
  /**
   * §36.14 "Send to Claude": PR comments go into the composer of the window that has `path` open (the PR head's workbench),
   * which comes to the front; false when no other window has it (the caller uses its own composer). Nothing is sent.
   */
  ipcMain.handle("rg:composeInWindow", (evt, path: unknown, text: unknown) => {
    if (typeof path !== "string" || path.length === 0 || !isComposerDraft(text)) return false;
    const other = deps.findWindowFor(path);
    if (!other || other.win.isDestroyed() || other.win.webContents.id === evt.sender.id) return false;
    other.win.webContents.send("rg:menu", { type: "composer_draft", text });
    if (other.win.isMinimized()) other.win.restore();
    other.win.show();
    other.win.focus();
    return true;
  });
}

/** MARK: wave3 desktop-flow — reports waiting for the window of their new workbench. */
const setupReports = createSetupReports();

/** One picked image file → its base64, or the §24 code it would be refused with (read only when it passes). */
export function readPickedImage(path: string): PickedImage {
  const name = basename(path);
  try {
    const st = statSync(path);
    if (!st.isFile()) return { name, ok: false, code: "attachment_invalid" };
    const head = new Uint8Array(12);
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 12, 0);
    } finally {
      closeSync(fd);
    }
    const v = checkImage("", head.subarray(0, Math.min(12, st.size)), st.size);
    if (!v.ok) return { name, ok: false, code: v.code };
    if (st.size > MAX_ATTACHMENT_BYTES) return { name, ok: false, code: "attachment_too_large" };
    const bytes = readFileSync(path);
    return { name, ok: true, mediaType: v.mediaType, dataBase64: bytes.toString("base64"), bytes: bytes.length };
  } catch {
    return { name, ok: false, code: "attachment_invalid" };
  }
}
