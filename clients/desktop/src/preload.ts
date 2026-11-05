/**
 * `window.rg` (src/shared/ipc.ts `RGBridge`): commands → main, EngineEvents ← main, plus dialogs / settings / editor.
 * The renderer is sandboxed (src/main/windows.ts): this preload may only use `electron`'s
 * contextBridge / ipcRenderer and the sandbox's `process` subset (argv, platform) — no Node modules.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { EngineCommand, EngineEvent, PartialSeries } from "@reviewgate/engine";
import type { AppSettings, EditorKind, ExecutableKind, MenuAction, NotifyRequest, ProjectUI, RGBridge } from "./shared/ipc.js";
import type { NotificationClick } from "./shared/ipc.js"; // MARK: wave4b w4-notify
import type { WorkbenchSetupReport } from "./shared/flowSettings.js"; // MARK: wave3 desktop-flow

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  return process.argv.find((a) => a.startsWith(p))?.slice(p.length);
}

/** `{__error}` replies (a refusal in main) become rejections. */
async function unwrap<T>(p: Promise<unknown>): Promise<T> {
  const r = await p;
  if (r && typeof r === "object" && "__error" in r) throw new Error(String((r as { __error: unknown }).__error));
  return r as T;
}

const e2eRole = arg("rg-e2e") as "primary" | "secondary" | undefined;

const bridge: RGBridge = {
  send: (cmd: EngineCommand) =>
    void ipcRenderer.invoke("rg:cmd", cmd).then((r: { __error?: string } | undefined) => {
      // Main refused the command (src/main/ipcGuard.ts); surface it in the devtools console.
      if (r && typeof r === "object" && "__error" in r) console.warn(`rg:cmd ${cmd.type}: ${r.__error}`);
    }),
  request: async (cmd: EngineCommand) => {
    const r = (await ipcRenderer.invoke("rg:request", cmd)) as { __error?: string };
    if (r && typeof r === "object" && "__error" in r) throw new Error(r.__error);
    return r as never;
  },
  requestDetailed: async (cmd: EngineCommand) => {
    const r = (await ipcRenderer.invoke("rg:request", cmd)) as { __error?: string; __code?: string; __paths?: string[]; __partial?: PartialSeries };
    if (r && typeof r === "object" && "__error" in r) {
      return { ok: false as const, error: String(r.__error), ...(typeof r.__code === "string" ? { code: r.__code } : {}), ...(Array.isArray(r.__paths) ? { paths: r.__paths.map(String) } : {}), ...(r.__partial && typeof r.__partial === "object" ? { partial: r.__partial } : {}) };
    }
    return { ok: true as const, reply: r as never };
  },
  onEvent: (cb: (ev: EngineEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: EngineEvent) => cb(ev);
    ipcRenderer.on("rg:evt", listener);
    // Replay the current snapshot: events emitted before this renderer loaded are gone.
    void ipcRenderer.invoke("rg:attach").then((state) => {
      if (state) cb({ type: "state", state });
    });
    return () => ipcRenderer.removeListener("rg:evt", listener);
  },
  onMenu: (cb: (a: MenuAction) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, a: MenuAction) => cb(a);
    ipcRenderer.on("rg:menu", listener);
    return () => ipcRenderer.removeListener("rg:menu", listener);
  },
  chooseDirectory: () => ipcRenderer.invoke("rg:chooseDirectory"),
  openInEditor: (path: string, line: number | null, editor?: EditorKind) => ipcRenderer.invoke("rg:openInEditor", path, line, editor),
  openExternal: (url: string) => ipcRenderer.invoke("rg:openExternal", url),
  openLog: () => ipcRenderer.invoke("rg:openLog"),
  showItemInFolder: (path: string) => ipcRenderer.invoke("rg:showItemInFolder", path),
  openMarkdown: (path: string) => ipcRenderer.invoke("rg:openMarkdown", path), // MARK: wave4d w4d-config (§42.3)
  openGraphHtml: (path: string) => ipcRenderer.invoke("rg:openGraphHtml", path), // MARK: wave5 w5-graph (§43.3)
  getSettings: () => ipcRenderer.invoke("rg:getSettings"),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke("rg:setSettings", patch),
  pickExecutable: (kind: ExecutableKind) => unwrap(ipcRenderer.invoke("rg:pickExecutable", kind)),
  clearExecutable: (kind: ExecutableKind) => unwrap(ipcRenderer.invoke("rg:clearExecutable", kind)),
  // MARK: wave3 desktop-session — §36.8
  pinClaudeVersion: (version: string) => unwrap(ipcRenderer.invoke("rg:pinClaudeVersion", version)),
  setUI: (hash: string, patch: ProjectUI) => ipcRenderer.invoke("rg:setUI", hash, patch),
  openWorkbenchWindow: (path: string, setupReport?: WorkbenchSetupReport) => ipcRenderer.invoke("rg:openWorkbenchWindow", path, setupReport),
  // MARK: wave3 desktop-flow — §36.12 a new workbench's failed setup, §36.14 PR comments into another window's composer
  takeWorkbenchSetupReport: (paths: string[]) => ipcRenderer.invoke("rg:takeWorkbenchSetupReport", paths),
  composeInWindow: (path: string, text: string) => ipcRenderer.invoke("rg:composeInWindow", path, text),
  openInNewWindow: (path?: string) => ipcRenderer.invoke("rg:openInNewWindow", path),
  focusProjectWindow: (path: string) => ipcRenderer.invoke("rg:focusProjectWindow", path),
  closeProjectInWindow: (path: string) => ipcRenderer.invoke("rg:closeProjectInWindow", path),
  toolchainInfo: () => ipcRenderer.invoke("rg:toolchainInfo"),
  logError: (message: string) => ipcRenderer.invoke("rg:logError", message),
  copyText: (text: string) => ipcRenderer.invoke("rg:copyText", text),
  pickImages: () => ipcRenderer.invoke("rg:pickImages"),
  notify: (req: NotifyRequest) => ipcRenderer.invoke("rg:notify", req),
  // MARK: wave4b w4-notify — §39.6
  onNotificationClick: (cb: (click: NotificationClick) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, click: NotificationClick) => cb(click);
    ipcRenderer.on("rg:notificationClick", listener);
    return () => ipcRenderer.removeListener("rg:notificationClick", listener);
  },
  onNotificationTrouble: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("rg:notificationTrouble", listener);
    return () => ipcRenderer.removeListener("rg:notificationTrouble", listener);
  },
  openNotificationSettings: () => ipcRenderer.invoke("rg:openNotificationSettings"),
  // MARK: wave4 w4-install (daily-17)
  recentProjects: () => ipcRenderer.invoke("rg:recentProjects"),
  removeRecentProject: (path: string | null) => ipcRenderer.invoke("rg:removeRecentProject", path),
  sep: process.platform === "win32" ? "\\" : "/",
  locale: arg("rg-locale") ?? "en",
  platform: process.platform,
  e2e: e2eRole ? { role: e2eRole, project: arg("rg-project") ?? "" } : null,
  e2eReport: (result: unknown) => ipcRenderer.send("rg:e2e:report", result),
  e2eReadFile: (path: string) => ipcRenderer.invoke("rg:e2e:readFile", path),
  e2eScreenshot: (name: string) => ipcRenderer.invoke("rg:e2e:screenshot", name),
  e2eOpenSecondary: () => ipcRenderer.invoke("rg:e2e:openSecondary"),
  e2eGitLog: () => ipcRenderer.invoke("rg:e2e:gitLog"),
};

contextBridge.exposeInMainWorld("rg", bridge);
contextBridge.exposeInMainWorld("rgInitialProject", arg("rg-project") ?? null);
