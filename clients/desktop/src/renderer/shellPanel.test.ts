/**
 * §57.6 / §57.17 (plan §4.7): the bottom shell panel — Ctrl+`'s three cases, the height's floor and ceiling, which exits
 * close a tab, tab titles, opening a shell through the bridge (never a file, args or folder of the renderer's), closing
 * the last tab hides the panel, and the panel's names and tooltips.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewState } from "@reviewgate/engine";
import type { PtyBridge, PtyOpen } from "../shared/ipc";
import { initI18n } from "./i18n";
import { clampPanelHeight, panelToggleAction, PANEL_MIN_HEIGHT, shellExitKeepsTab } from "./terminal/shellPanel";

const opened: PtyOpen[] = [];
const killed: string[] = [];
let next = 0;

async function load() {
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { dataset: {} },
    hasFocus: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ className: "", isConnected: false, remove: () => undefined, contains: () => false, getContext: () => null }),
    querySelector: () => null,
    activeElement: null,
  };
  const pty = {
    open: async (req: PtyOpen) => (opened.push(req), { ok: true as const, ptyId: `s${++next}` }),
    kill: async (id: string) => void killed.push(id),
    input: () => undefined,
    ack: () => undefined,
    focus: () => undefined,
    resize: () => undefined,
    onData: () => () => undefined,
    onExit: () => () => undefined,
  };
  (globalThis as unknown as { window: unknown }).window = {
    innerHeight: 800,
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "win32", pty },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  const { useStore } = await import("./store");
  const host = await import("./terminal/termHost");
  const panel = await import("./terminal/shellPanel");
  const { usePtyInfo } = await import("./terminal/ptyInfo");
  const { ShellPanel } = await import("./components/terminal/ShellPanel");
  host.setTerminalLoader(() => new Promise<never>(() => undefined)); // the markup only
  host.initTermHost(pty as unknown as PtyBridge);
  return { useStore, host, panel, usePtyInfo, ShellPanel };
}

describe("the panel's rules", () => {
  it("Ctrl+`: hidden → show; shown and focused → hide; shown elsewhere → focus", () => {
    expect(panelToggleAction({ shown: false, focused: false })).toBe("show");
    expect(panelToggleAction({ shown: true, focused: true })).toBe("hide");
    expect(panelToggleAction({ shown: true, focused: false })).toBe("focus");
  });

  it("at least 80 px; the window keeps 200 px above", () => {
    expect(clampPanelHeight(undefined, 800)).toBe(240);
    expect(clampPanelHeight(10, 800)).toBe(PANEL_MIN_HEIGHT);
    expect(clampPanelHeight(900, 800)).toBe(600);
    expect(clampPanelHeight(500, 0)).toBe(500);
    expect(clampPanelHeight(500, 250)).toBe(PANEL_MIN_HEIGHT);
  });

  it("exit 0 or an end with the project closes the tab; any other exit keeps it", () => {
    expect(shellExitKeepsTab({ exitCode: 0, reason: "exited" })).toBe(false);
    expect(shellExitKeepsTab({ exitCode: 1, reason: "exited" })).toBe(true);
    expect(shellExitKeepsTab({ exitCode: null, reason: "killed" })).toBe(true);
    expect(shellExitKeepsTab({ exitCode: null, reason: "closed" })).toBe(false);
    expect(shellExitKeepsTab({ exitCode: 3, reason: "switched" })).toBe(false);
  });
});

describe("shell tabs", () => {
  let m: Awaited<ReturnType<typeof load>>;
  const put = <T extends object>(store: { getInitialState(): T; setState(p: Partial<T>): void }, patch: Partial<T>) => {
    Object.assign(store.getInitialState(), patch);
    store.setState(patch);
  };
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
    put(m.usePtyInfo, { info: { available: true, reason: null, osBuild: 22631, shells: ["powershell", "cmd"] } });
    const init = m.useStore.getInitialState().state;
    put(m.useStore, { state: { ...init, project: { path: "C:\\Users\\dev\\acme", root: "C:\\Users\\dev\\acme", name: "acme", branch: "main", remoteURL: null } } as unknown as ReviewState });
  });
  beforeEach(() => {
    opened.length = 0;
    killed.length = 0;
  });

  it("opens a shell by kind and size only; the panel shows it", async () => {
    expect(await m.panel.openShell("powershell")).toBe(true);
    expect(await m.panel.openShell("cmd")).toBe(true);
    expect(await m.panel.openShell("powershell")).toBe(true);
    expect(opened.map((o) => (o.kind === "shell" ? o.shell : o.kind))).toEqual(["powershell", "cmd", "powershell"]);
    for (const o of opened) expect(Object.keys(o).sort()).toEqual(["cols", "kind", "rows", "shell"]);
    expect(m.panel.useShellPanel.getState()).toMatchObject({ shown: true, active: "s3", failed: null });
  });

  it("names the tabs and its buttons", () => {
    put(m.panel.useShellPanel, { ...m.panel.useShellPanel.getState() });
    const out = renderToStaticMarkup(createElement(m.ShellPanel));
    expect(out).toContain('role="region" aria-label="Terminal"');
    expect(out).toContain(">PowerShell 1<");
    expect(out).toContain(">Command Prompt<");
    expect(out).toContain(">PowerShell 2<");
    expect(out).toContain("PowerShell 2 — in C:\\Users\\dev\\acme");
    expect(out).toContain('aria-label="Close the terminal ‘Command Prompt’"');
    expect(out).toContain('title="Close this terminal — its shell ends"');
    expect(out).toContain('aria-label="New terminal"');
    expect(out).toContain('title="Hide the terminal panel (Ctrl+`) — its shells keep running"');
    expect(out).toContain('title="Drag to resize the terminal panel"');
  });

  it("closing tabs kills their shells; the last one hides the panel", async () => {
    for (const id of m.host.shellTerminals()) await m.panel.closeShell(id);
    expect(killed).toEqual(["s1", "s2", "s3"]);
    expect(m.host.shellTerminals()).toEqual([]);
    expect(m.panel.useShellPanel.getState().shown).toBe(false);
  });

  it("a refusal says why", async () => {
    (window.rg.pty as unknown as { open: unknown }).open = async () => ({ ok: false, code: "no_project", error: "no project is open in this window" });
    expect(await m.panel.openShell("cmd")).toBe(false);
    expect(m.panel.useShellPanel.getState().failed).toBe("Open a project first (Ctrl+O)");
  });
});
