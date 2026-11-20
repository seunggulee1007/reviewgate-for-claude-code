// MARK: polish p-lifecycle — P1-chrome-09 / P2-review-28 / P4-composer-06 / P1-chrome-06 / P1-chrome-20 / P1-chrome-28 /
// P5-sheets-46 / PX-13: the Windows menu bar lists the Mac's menus with their keys, and its items follow the focused window.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import type { ReviewState } from "@reviewgate/engine";
import type { MenuAction } from "../shared/ipc";
import { NOTHING_ENABLED, type MenuEnabled } from "../shared/menuState";

const built: { template: MenuItemConstructorOptions[]; builds: number } = { template: [], builds: 0 };
const sent: MenuAction[] = [];
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.5.10", getPath: () => "/tmp/rg-user-data", getLocale: () => "en" },
  BrowserWindow: { getFocusedWindow: () => ({ webContents: { send: (_c: string, a: MenuAction) => sent.push(a) } }), getAllWindows: () => [] },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      built.template = template;
      built.builds += 1;
      return template;
    },
    setApplicationMenu: () => undefined,
  },
  shell: { openPath: async () => "", openExternal: async () => undefined },
}));
const settings: { recentProjects: string[]; terminalChatPreview?: boolean } = { recentProjects: [] };
vi.mock("./settings.js", () => ({ loadSettings: () => settings }));
const pty = { available: true, reason: null as string | null, osBuild: 22631, shells: ["powershell", "cmd"] };
vi.mock("./pty/nodePty.js", () => ({ ptyInfo: () => pty }));

import { initI18n } from "../renderer/i18n";

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

function walk(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? walk(i.submenu as MenuItemConstructorOptions[]) : [])]);
}

const state = (o: { project?: boolean; tabs?: [string, string][] } = {}) =>
  ({
    project: o.project === false ? null : { path: "/work/acme-api", root: "/work/acme-api", name: "acme-api", branch: "main" },
    sessions: { list: (o.tabs ?? []).map(([id, title]) => ({ id, title })), currentId: o.tabs?.[0]?.[0] ?? null, openTabIds: (o.tabs ?? []).map(([id]) => id) },
  }) as unknown as ReviewState;

async function menu(focused: { state: ReviewState; menu: MenuEnabled | null } | null) {
  const { buildMenu, invalidateMenu } = await import("./menu");
  invalidateMenu();
  buildMenu({ newWindow: () => undefined, openInNewWindow: () => undefined, copyDiagnostics: () => undefined, checkForUpdates: () => undefined, reportIssue: () => undefined, clearRecent: () => undefined, focused: () => focused });
  return walk(built.template);
}

describe("the Windows menu bar (P1-chrome-09)", () => {
  beforeAll(() => {
    setPlatform("win32"); // read once, when menu.ts loads
    initI18n("en", "win32");
  });
  afterAll(() => setPlatform(realPlatform));

  it("lists the Mac's Review and Chat items with their keys, shown but left to the page", async () => {
    const items = await menu({ state: state({ tabs: [["c1", "New chat"], ["c2", "Fix the login & tests"]] }), menu: { ...NOTHING_ENABLED, accept: true, pending: true, commit: true, chatSwitch: true } });
    const find = (label: string) => items.find((i) => i.label === label);
    for (const [label, key] of [["Accept", "CmdOrCtrl+Shift+A"], ["Reject", "CmdOrCtrl+Shift+R"], ["Next Pending File", "CmdOrCtrl+]"], ["Ask About Selection…", "CmdOrCtrl+Alt+/"], ["Request Changes", "CmdOrCtrl+Shift+C"], ["Commit Accepted…", "CmdOrCtrl+Shift+K"], ["New chat", "CmdOrCtrl+T"], ["Close Chat Tab", "CmdOrCtrl+Shift+W"], ["Stop", "CmdOrCtrl+."], ["Find in Chat…", "CmdOrCtrl+F"], ["Find in Diff…", "CmdOrCtrl+Alt+F"], ["Changes", "CmdOrCtrl+Alt+1"], ["History", "CmdOrCtrl+Alt+2"], ["PRs", "CmdOrCtrl+Alt+3"]] as const) {
      expect(find(label)?.accelerator, label).toBe(key);
      expect(find(label)?.registerAccelerator, label).toBe(false);
    }
    // The page's state decides: accept and commit can, reject cannot; the chat tabs are listed with ⌘1…, "&" kept as text.
    expect(find("Accept")?.enabled).toBe(true);
    expect(find("Reject")?.enabled).toBe(false);
    expect(find("Commit Accepted…")?.enabled).toBe(true);
    expect(find("Stop")?.enabled).toBe(false);
    expect(find("Fix the login && tests")?.accelerator).toBe("CmdOrCtrl+2");
    // File › New Window takes ⌘N; Go to File / Find in Project are the menu's own keys (lane p-window shows the pages).
    expect(find("New Window")?.accelerator).toBe("CmdOrCtrl+N");
    expect(find("Go to File…")?.accelerator).toBe("CmdOrCtrl+P");
    expect(find("Go to File…")?.registerAccelerator).toBeUndefined();
    expect(find("Close Project")?.enabled).toBe(true);
  });

  it("a click sends the window its action", async () => {
    const items = await menu({ state: state({ tabs: [["c1", "a"], ["c2", "b"]] }), menu: null });
    sent.length = 0;
    const click = (label: string) => (items.find((i) => i.label === label)?.click as unknown as () => void)();
    click("Accept All…");
    click("Changes");
    click("b");
    click("Close Project");
    expect(sent).toEqual([{ type: "accept_all" }, { type: "sidebar_tab", tab: "changes" }, { type: "chat_tab", index: 1 }, { type: "close_project" }]);
  });

  it("without a project the project items are off", async () => {
    const items = await menu({ state: state({ project: false }), menu: null });
    for (const label of ["Accept", "Add a review note on the selected line", "New chat", "Close Project", "Go to File…", "Changes"]) {
      expect(items.find((i) => i.label === label)?.enabled, label).toBe(false);
    }
    expect(items.find((i) => i.label === "New Window")?.enabled).toBeUndefined();
  });

  it("builds again only when what it shows changed", async () => {
    const { buildMenu } = await import("./menu");
    const handlers = { newWindow: () => undefined, openInNewWindow: () => undefined, copyDiagnostics: () => undefined, checkForUpdates: () => undefined, reportIssue: () => undefined, clearRecent: () => undefined, focused: () => ({ state: state(), menu: NOTHING_ENABLED }) };
    await menu({ state: state(), menu: NOTHING_ENABLED });
    const before = built.builds;
    buildMenu(handlers);
    expect(built.builds).toBe(before);
    buildMenu({ ...handlers, focused: () => ({ state: state(), menu: { ...NOTHING_ENABLED, stop: true } }) });
    expect(built.builds).toBe(before + 1);
  });

  it("§57.10: terminal chat items only while the preview is on and a PTY runs; the panel toggle whenever shells can open; a terminal chat turns off its chat-only items", async () => {
    const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label);
    settings.terminalChatPreview = false;
    let items = await menu({ state: state(), menu: { ...NOTHING_ENABLED, chatSwitch: true } });
    for (const label of ["New Terminal Chat", "New Chat (Classic)", "Continue as Terminal Chat"]) expect(labels(items), label).not.toContain(label);
    const panel = items.find((i) => i.label === "Toggle Terminal Panel");
    expect(panel?.accelerator).toBe("Ctrl+`");
    expect(panel?.registerAccelerator).toBe(false);

    settings.terminalChatPreview = true;
    items = await menu({ state: state(), menu: { ...NOTHING_ENABLED, chatSwitch: true } });
    const find = (label: string) => items.find((i) => i.label === label);
    expect(find("New Terminal Chat")).toMatchObject({ accelerator: "CmdOrCtrl+Alt+T", registerAccelerator: false, enabled: true });
    expect(find("New Chat (Classic)")).toMatchObject({ accelerator: "CmdOrCtrl+Alt+Shift+T", registerAccelerator: false, enabled: true });
    expect(find("Continue as Terminal Chat")?.enabled).toBe(true);
    expect(find("Find in Chat…")?.enabled).toBe(true);
    expect(find("Request Changes")?.enabled).toBe(true);
    sent.length = 0;
    for (const label of ["New Terminal Chat", "New Chat (Classic)", "Continue as Terminal Chat", "Toggle Terminal Panel"]) (find(label)?.click as unknown as () => void)();
    expect(sent).toEqual([{ type: "new_terminal_chat" }, { type: "new_classic_chat" }, { type: "continue_as_terminal" }, { type: "toggle_terminal_panel" }]);

    // The shown chat is a terminal chat: Find in Chat, Request Changes and Continue are off.
    items = await menu({ state: state(), menu: { ...NOTHING_ENABLED, chatSwitch: true, terminalChat: true } });
    for (const label of ["Find in Chat…", "Request Changes", "Continue as Terminal Chat"]) expect(items.find((i) => i.label === label)?.enabled, label).toBe(false);

    // No PTY (node-pty did not load, Windows before 1903): neither the chat items nor the panel.
    pty.available = false;
    pty.shells = [];
    items = await menu({ state: state(), menu: { ...NOTHING_ENABLED, chatSwitch: true } });
    for (const label of ["New Terminal Chat", "Toggle Terminal Panel"]) expect(labels(items), label).not.toContain(label);
    pty.available = true;
    pty.shells = ["powershell", "cmd"];
    settings.terminalChatPreview = false;
  });

  it("Open Recent ends with Clear Menu; the jump list starts the app with each folder, quoted (P1-chrome-07)", async () => {
    const { jumpListItems } = await import("./menu");
    expect(jumpListItems(["C:\\Work\\acme api", "D:\\x"], "C:\\Program Files\\ReviewGate\\ReviewGate.exe")[0]).toMatchObject({ title: "acme api", args: '"C:\\Work\\acme api"', program: "C:\\Program Files\\ReviewGate\\ReviewGate.exe" });
    expect(jumpListItems(Array.from({ length: 12 }, (_, i) => `/w/p${i}`), "x")).toHaveLength(10);
  });

  it("access keys: '&' before the English letter, '(&F)' after a Korean label, before its '…' (PX-13)", async () => {
    const { mn } = await import("./menu");
    expect(mn("File", "F", false)).toBe("&File");
    expect(mn("Open Recent", "R", false)).toBe("Open &Recent");
    expect(mn("Exit", "X", false)).toBe("E&xit");
    expect(mn("파일", "F", false)).toBe("파일(&F)");
    expect(mn("프로젝트 열기…", "O", false)).toBe("프로젝트 열기(&O)…");
    expect(mn("Q&A", "Q", false)).toBe("&Q&&A");
    expect(mn("File", "F", true)).toBe("File");
  });
});
