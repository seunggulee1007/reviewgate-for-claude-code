/**
 * §57.6 / §57.17 (plan §4.7): the bottom shell panel — PowerShell / Command Prompt tabs in the project's folder, the Mac's
 * terminal panel on Windows. It needs no Claude and no preview: only a PTY (Windows with node-pty). The shells live in
 * main; their terminals in the registry (termHost.ts), so hiding the panel or switching tabs never ends one. Ctrl+`
 * (the physical Backquote): hidden → shown and focused (a first tab opened if needed); shown and focused → hidden, the
 * keyboard back to the chat; shown elsewhere → focused.
 */
import { create } from "zustand";
import type { ShellKind } from "../../shared/ipc";
import { t, usesMacKeys } from "../i18n";
import { measureCellWidth } from "../terminalLayout";
import { terminalStartRefusal } from "../terminalStrip";
import { adoptTerminal, disposeTerminal, estimateSize, focusTerminal, shellTerminals, terminalConfig, terminalHasFocus, terminalShellOf, terminalStatus } from "./termHost";
import { TERMINAL_FONT_FAMILY } from "./termHostOptions";

export const PANEL_MIN_HEIGHT = 80;
/** The window keeps this much above the panel. */
export const PANEL_KEEP_ABOVE = 200;
export const PANEL_DEFAULT_HEIGHT = 240;

export const useShellPanel = create<{ shown: boolean; active: string | null; opening: boolean; failed: string | null }>(() => ({
  shown: false,
  active: null,
  opening: false,
  failed: null,
}));

/** MARK: c-panel — §57.18: the panel's tabs. */
export type PanelTab = "terminal" | "output" | "run";
export const PANEL_TABS: readonly PanelTab[] = ["terminal", "output", "run"];

/** A tab's name: Terminal · Output · Run (the Mac's catalog key for Output, whose plain "Output" means something else). */
export function panelTabTitle(tab: PanelTab): string {
  if (tab === "terminal") return t("Terminal");
  if (tab === "run") return t("Run");
  const ko = t("panel.output");
  return ko === "panel.output" ? "Output" : ko;
}

export function panelTabHelp(tab: PanelTab): string {
  if (tab === "terminal") return usesMacKeys() ? t("Terminal panel (⌃`)") : t("Terminal panel (Ctrl+`)");
  if (tab === "output") return t("Output — ReviewGate's log and the Bash commands Claude ran");
  return t("Run — the project's commands (dev server, tests), each in its own terminal");
}

/** What Ctrl+` does now. §57.18: on the Output or Run tab it shows the panel, and hides it when shown. */
export function panelToggleAction(p: { shown: boolean; focused: boolean; tab?: PanelTab }): "show" | "hide" | "focus" {
  if (!p.shown) return "show";
  if (p.tab && p.tab !== "terminal") return "hide";
  return p.focused ? "hide" : "focus";
}

/** The panel's height within its floor and what the window leaves (`windowHeight`; 0: unknown). */
export function clampPanelHeight(want: number | undefined, windowHeight: number): number {
  const h = want !== undefined && Number.isFinite(want) ? want : PANEL_DEFAULT_HEIGHT;
  const max = windowHeight > 0 ? Math.max(PANEL_MIN_HEIGHT, windowHeight - PANEL_KEEP_ABOVE) : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(max, Math.max(PANEL_MIN_HEIGHT, h)));
}

/** A tab's title: its shell, numbered when the same shell is open more than once. */
export function shellTabTitle(ptyId: string, tabs: readonly string[]): string {
  const kind = terminalShellOf(ptyId);
  const name = kind === "cmd" ? t("Command Prompt") : t("PowerShell");
  const same = tabs.filter((id) => terminalShellOf(id) === kind);
  return same.length > 1 ? `${name} ${same.indexOf(ptyId) + 1}` : name;
}

/** What a tab's exit means: gone (0, or ended with the project) or kept with "exited (n)" / "stopped". */
export function shellExitKeepsTab(exit: { exitCode: number | null; reason: string }): boolean {
  if (exit.reason === "closed" || exit.reason === "switched") return false;
  return exit.exitCode !== 0;
}

/** A new shell tab (`kind`; absent: Settings' default shell) in the project's folder; it becomes the active tab. */
export async function openShell(kind: ShellKind): Promise<boolean> {
  const pty = window.rg?.pty;
  if (!pty || useShellPanel.getState().opening) return false;
  useShellPanel.setState({ shown: true, opening: true, failed: null });
  const size = estimateSize(document.querySelector<HTMLElement>(".shell-panel .shell-body"), measureCellWidth(`${terminalConfig().fontSize}px ${TERMINAL_FONT_FAMILY}`));
  try {
    const r = await pty.open({ kind: "shell", shell: kind, ...size });
    if (!r.ok) {
      useShellPanel.setState({ opening: false, failed: terminalStartRefusal(r.code, r.error) ?? (r.error || r.code) });
      return false;
    }
    adoptTerminal(r.ptyId, "shell", { shell: kind });
    useShellPanel.setState({ opening: false, active: r.ptyId });
    setTimeout(() => focusTerminal(r.ptyId), 0);
    return true;
  } catch (e) {
    useShellPanel.setState({ opening: false, failed: terminalStartRefusal("spawn_failed", e instanceof Error ? e.message : String(e)) });
    return false;
  }
}

/** × on a tab: a running shell ends; the tab goes. The last tab closing hides the panel. */
export async function closeShell(ptyId: string): Promise<void> {
  if (terminalStatus(ptyId).running) await window.rg?.pty?.kill(ptyId).catch(() => undefined);
  else void window.rg?.pty?.kill(ptyId).catch(() => undefined); // main forgets an exited one
  forgetShell(ptyId);
}

/**
 * The tab goes (its PTY ended or was closed); the neighbour becomes active; none left hides the panel — §57.18: only
 * while the panel shows the terminal tab (`onTerminalTab`), so a shell ending behind Output or Run leaves it open.
 */
export function forgetShell(ptyId: string, onTerminalTab = true): void {
  const before = shellTerminals();
  disposeTerminal(ptyId);
  const rest = shellTerminals();
  const s = useShellPanel.getState();
  if (rest.length === 0) {
    useShellPanel.setState(onTerminalTab ? { shown: false, active: null } : { active: null });
    return;
  }
  if (s.active === ptyId) {
    const i = Math.min(before.indexOf(ptyId), rest.length - 1);
    useShellPanel.setState({ active: rest[Math.max(0, i)] ?? null });
  }
}

/** Restart an exited shell: a new one of the same kind in its place. */
export async function restartShell(ptyId: string): Promise<void> {
  const kind = terminalShellOf(ptyId) ?? "powershell";
  void window.rg?.pty?.kill(ptyId).catch(() => undefined);
  disposeTerminal(ptyId);
  await openShell(kind);
}

/**
 * Ctrl+` / View › Toggle Terminal Panel. `defaultShell`: Settings' choice for a first tab. `backToChat`: where the
 * keyboard goes when the panel hides (the chat's terminal, else the message box).
 */
export function toggleShellPanel(defaultShell: ShellKind, backToChat: () => void, tab: PanelTab = "terminal"): void {
  const s = useShellPanel.getState();
  const tabs = shellTerminals();
  const focused = document.activeElement?.closest?.(".shell-panel") != null || tabs.some((id) => terminalHasFocus(id));
  switch (panelToggleAction({ shown: s.shown, focused, tab })) {
    case "show": {
      useShellPanel.setState({ shown: true, failed: null });
      if (tab !== "terminal") return;
      const active = s.active && tabs.includes(s.active) ? s.active : (tabs[0] ?? null);
      if (active) {
        useShellPanel.setState({ active });
        setTimeout(() => focusTerminal(active), 0);
      } else void openShell(defaultShell);
      return;
    }
    case "hide":
      useShellPanel.setState({ shown: false });
      backToChat();
      return;
    case "focus": {
      const active = s.active ?? tabs[0] ?? null;
      if (active) focusTerminal(active);
      else void openShell(defaultShell);
    }
  }
}
