/**
 * The screenshot harness's `window.rg` (docs/M11-WINDOWS.md "Screenshot harness"): the same bridge the real preload
 * (src/preload.ts) exposes — typed `Required<RGBridge>`, so a member added there and not here fails `tsc` — but every call
 * goes to the harness's main (scripts/shots/main.ts), which answers from the scene's fixture. No engine, no `claude`,
 * no PTY, no dialog: nothing here reaches the real main process's handlers (they are not even loaded).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { EngineCommand, EngineEvent } from "@reviewgate/engine";
import type { MenuAction, RGBridge } from "../../src/shared/ipc.js";

type Boot = { locale: string; initialProject: string | null; noStartScreen: boolean };
const boot = ipcRenderer.sendSync("shots:boot") as Boot;

/** One bridge method, answered by the fixture (`bridge.<name>` in the scene, else the harness's default). */
const call = (name: string) => (...args: unknown[]) => ipcRenderer.invoke("shots:call", name, args) as Promise<never>;

/** A main → page channel the harness pushes on (engine events, menu actions, toasts, …). */
function listen<T extends unknown[]>(channel: string, cb: (...a: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...a: unknown[]) => cb(...(a as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const none = () => () => undefined;

const bridge: Required<RGBridge> = {
  send: (cmd: EngineCommand) => void ipcRenderer.invoke("shots:send", cmd),
  request: async (cmd: EngineCommand) => {
    const r = (await ipcRenderer.invoke("shots:request", cmd)) as { __error?: string };
    if (r && typeof r === "object" && "__error" in r) throw new Error(r.__error);
    return r as never;
  },
  requestDetailed: async (cmd: EngineCommand) => {
    const r = (await ipcRenderer.invoke("shots:request", cmd)) as { __error?: string; __code?: string };
    if (r && typeof r === "object" && "__error" in r) return { ok: false as const, error: String(r.__error), ...(r.__code ? { code: r.__code } : {}) };
    return { ok: true as const, reply: r as never };
  },
  onEvent: (cb: (ev: EngineEvent) => void) => {
    const off = listen<[EngineEvent]>("shots:evt", cb);
    // As the real preload: the current snapshot (and the scene's events after it) once the page listens.
    void ipcRenderer.invoke("shots:attach").then((events: EngineEvent[]) => events.forEach(cb));
    return off;
  },
  onMenu: (cb: (a: MenuAction) => void) => listen<[MenuAction]>("shots:menu", cb),
  chooseDirectory: call("chooseDirectory"),
  pickAddDirectory: call("pickAddDirectory"),
  openInEditor: call("openInEditor"),
  openInIde: call("openInIde"),
  openExternal: call("openExternal"),
  openLog: call("openLog"),
  showItemInFolder: call("showItemInFolder"),
  mcpConfigFile: call("mcpConfigFile"),
  openMarkdown: call("openMarkdown"),
  openGraphHtml: call("openGraphHtml"),
  getSettings: call("getSettings"),
  setSettings: call("setSettings"),
  pickExecutable: call("pickExecutable"),
  clearExecutable: call("clearExecutable"),
  pinClaudeVersion: call("pinClaudeVersion"),
  setUI: call("setUI"),
  openWorkbenchWindow: call("openWorkbenchWindow"),
  takeWorkbenchSetupReport: call("takeWorkbenchSetupReport"),
  composeInWindow: call("composeInWindow"),
  takeWorkbenchDraft: call("takeWorkbenchDraft"),
  openInNewWindow: call("openInNewWindow"),
  focusProjectWindow: call("focusProjectWindow"),
  closeProjectInWindow: call("closeProjectInWindow"),
  toolchainInfo: call("toolchainInfo"),
  logError: call("logError"),
  notify: call("notify"),
  onNotificationClick: none,
  onNotificationTrouble: none,
  openNotificationSettings: call("openNotificationSettings"),
  recentProjects: call("recentProjects"),
  removeRecentProject: call("removeRecentProject"),
  copyText: call("copyText"),
  draftEditStart: call("draftEditStart"),
  draftEditFinish: call("draftEditFinish"),
  onDraftEdit: none,
  pathForFile: () => "",
  copyImage: call("copyImage"),
  readiness: call("readiness"),
  onCloseGuardQuery: none,
  confirmProjectChange: call("confirmProjectChange"),
  reportMenuState: () => undefined,
  onToast: (cb: (text: string) => void) => listen<[string]>("shots:toast", cb),
  updateStatus: call("updateStatus"),
  onUpdateStatus: none,
  openUpdate: call("openUpdate"),
  dismissUpdate: call("dismissUpdate"),
  installUpdate: call("installUpdate"),
  cancelUpdate: call("cancelUpdate"),
  restartNowForUpdate: call("restartNowForUpdate"),
  dismissUpdateNotice: call("dismissUpdateNotice"),
  checkUpdatesNow: call("checkUpdatesNow"),
  checkUpdateAgain: call("checkUpdateAgain"),
  focusUpdateBlocker: call("focusUpdateBlocker"),
  updateNotes: call("updateNotes"),
  pickImages: call("pickImages"),
  // The Windows client is what is shot: its separators, its key names (Ctrl, Alt) and its wording.
  sep: "\\",
  locale: boot.locale,
  platform: "win32",
  e2e: null,
  e2eReport: () => undefined,
  e2eReadFile: async () => null,
  e2eScreenshot: async () => "",
  e2eOpenSecondary: async () => null,
  e2eGitLog: async () => null,
  pty: {
    info: call("pty.info"),
    open: call("pty.open"),
    restart: call("pty.restart"),
    kill: call("pty.kill"),
    attach: call("pty.attach"),
    list: call("pty.list"),
    input: () => undefined,
    resize: () => undefined,
    ack: () => undefined,
    focus: () => undefined,
    detectRuns: call("pty.detectRuns"),
    onData: none,
    onExit: none,
  },
};

contextBridge.exposeInMainWorld("rg", bridge);
contextBridge.exposeInMainWorld("rgInitialProject", boot.initialProject);
contextBridge.exposeInMainWorld("rgNoStartScreen", boot.noStartScreen);
