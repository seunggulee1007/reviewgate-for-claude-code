/**
 * §57.6 / §57.10 (plan §4.7): the bottom terminal panel — PowerShell / Command Prompt tabs in the project's folder, below
 * the diff and chat row. Its top edge drags to resize (the Mac's deviation: laid out at its remembered height, not a
 * split view). Exit 0 closes a tab; any other exit keeps it with "exited (n)", Restart and Close. The last tab closing
 * hides the panel; hiding it or switching tabs never ends a shell. Logic: terminal/shellPanel.ts.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t, usesMacKeys } from "../../i18n";
import { Icon } from "../../icons";
import { isEnter } from "../../ime";
import { useStore } from "../../store";
import { usePtyInfo } from "../../terminal/ptyInfo";
import { clampPanelHeight, closeShell, forgetShell, openShell, restartShell, shellExitKeepsTab, shellTabTitle, toggleShellPanel, useShellPanel } from "../../terminal/shellPanel";
import { isTerminalPanelKey } from "../../terminal/terminalKeys";
import { focusLiveTerminal } from "../../terminal/terminalChat";
import { shellTerminals, subscribeTerminals, terminalsVersion, terminalStatus } from "../../terminal/termHost";
import { PointerMenu, type AgentMenuItem } from "../agents/AgentBits";
import { TerminalView } from "./TerminalView";
import "./terminal.css";

/** The keyboard goes back to the chat: its terminal, else the message box. */
function backToChat(): void {
  if (focusLiveTerminal()) return;
  document.querySelector<HTMLTextAreaElement>(".composer > textarea")?.focus();
}

function defaultShell(): "powershell" | "cmd" {
  return useStore.getState().settings?.terminalShell === "cmd" ? "cmd" : "powershell";
}

/** App-wide (mounted once): Ctrl+`, the menu's Toggle Terminal Panel, and tabs whose shell ended for good. */
export function useShellPanelHost(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTerminalPanelKey(e)) return;
      const s = useStore.getState();
      if ((usePtyInfo.getState().info?.shells.length ?? 0) === 0 || !s.state.project || s.dialog) return;
      e.preventDefault();
      toggleShellPanel(defaultShell(), backToChat);
    };
    document.addEventListener("keydown", onKey);
    // A shell that exited 0, or ended with the project: its tab goes.
    const offTerms = subscribeTerminals(() => {
      for (const id of shellTerminals()) {
        const exit = terminalStatus(id).exit;
        if (exit && !shellExitKeepsTab(exit)) forgetShell(id);
      }
    });
    return () => {
      document.removeEventListener("keydown", onKey);
      offTerms();
    };
  }, []);
}

/** View › Toggle Terminal Panel (menuActions.terminal.ts). */
export function toggleShellPanelFromMenu(): void {
  if ((usePtyInfo.getState().info?.shells.length ?? 0) === 0 || !useStore.getState().state.project) return;
  toggleShellPanel(defaultShell(), backToChat);
}

export function ShellPanel() {
  const { shown, active, opening, failed } = useShellPanel();
  const shells = usePtyInfo((s) => s.info?.shells ?? []);
  const project = useStore((s) => s.state.project?.path ?? "");
  const wanted = useStore((s) => s.ui.terminalPanelHeight);
  const setUI = useStore((s) => s.setUI);
  useSyncExternalStore(subscribeTerminals, terminalsVersion, terminalsVersion);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ y: number; h: number } | null>(null);
  if (!shown || shells.length === 0) return null;
  const tabs = shellTerminals();
  const current = active && tabs.includes(active) ? active : (tabs[0] ?? null);
  const height = clampPanelHeight(wanted, typeof window !== "undefined" ? window.innerHeight : 0);
  const status = terminalStatus(current);
  const exited = current && !status.running ? status.exit : null;
  const hideKey = usesMacKeys() ? t("Hide the terminal panel (⌃`) — its shells keep running") : t("Hide the terminal panel (Ctrl+`) — its shells keep running");
  const newItems: AgentMenuItem[] = shells.map((kind) => ({
    label: kind === "cmd" ? t("Command Prompt") : t("PowerShell"),
    onClick: () => void openShell(kind),
    hint: t("New terminal in the project folder"),
    testId: `New shell ${kind}`,
  }));

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { y: e.clientY, h: height };
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return;
      setUI({ terminalPanelHeight: clampPanelHeight(drag.current.h + (drag.current.y - ev.clientY), window.innerHeight) }, false);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      drag.current = null;
      // Live frames are not written; the release is.
      setUI({ terminalPanelHeight: useStore.getState().ui.terminalPanelHeight });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div className="shell-panel" style={{ height }} role="region" aria-label={t("Terminal")} data-testid="Shell panel">
      <div className="shell-drag" role="separator" aria-orientation="horizontal" aria-label={t("Drag to resize the terminal panel")} title={t("Drag to resize the terminal panel")} onMouseDown={onDragStart} data-testid="Shell panel drag" />
      <div className="shell-tabs" role="tablist" aria-label={t("Terminal")}>
        {tabs.map((id) => {
          const title = shellTabTitle(id, tabs);
          const st = terminalStatus(id);
          const state = st.running ? null : st.exit?.exitCode != null ? t("exited ({0})", st.exit.exitCode) : t("stopped");
          return (
            <div
              key={id}
              role="tab"
              tabIndex={0}
              aria-selected={id === current}
              className={`shell-tab ${id === current ? "active" : ""}`}
              title={project ? t("{0} — in {1}", title, project) : title}
              onClick={() => useShellPanel.setState({ active: id })}
              onKeyDown={(e) => {
                if (isEnter(e) || e.key === " ") {
                  e.preventDefault();
                  useShellPanel.setState({ active: id });
                }
              }}
              data-testid={`Shell tab ${id}`}
            >
              <Icon name="terminal" size={12} />
              <span className="truncate">{title}</span>
              {state && <span className="caption orange">{state}</span>}
              <button
                type="button"
                className="plain small close"
                title={t("Close this terminal — its shell ends")}
                aria-label={t("Close the terminal ‘{0}’", title)}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeShell(id);
                }}
                data-testid="Close shell tab"
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="plain small"
          disabled={opening}
          aria-label={t("New terminal")}
          aria-haspopup="menu"
          title={t("New terminal in the project folder")}
          onClick={(e) => setMenuAt({ x: e.clientX, y: e.clientY })}
          data-testid="New shell"
        >
          <Icon name="plus" size={12} />
        </button>
        <span className="grow" />
        {failed && current && (
          <span className="caption orange truncate" role="status" title={failed} data-testid="Shell failed">
            {failed}
          </span>
        )}
        <button type="button" className="plain small" aria-label={t("Hide the terminal panel")} title={hideKey} onClick={() => useShellPanel.setState({ shown: false })} data-testid="Hide shell panel">
          <Icon name="chevronDown" size={12} />
        </button>
      </div>
      <div className="shell-body">
        {current && <TerminalView key={current} ptyId={current} label={shellTabTitle(current, tabs)} testId="Shell terminal" />}
        {exited && current && (
          <div className="terminal-overlay" data-testid="Shell exited">
            <div className="terminal-overlay-panel">
              <div className="terminal-overlay-title" role="status">
                {exited.exitCode !== null ? t("The shell exited ({0})", exited.exitCode) : t("The shell was stopped")}
              </div>
              <div className="row">
                <button type="button" className="primary" title={t("Start a new shell in {0}", project)} onClick={() => void restartShell(current)} data-testid="Restart shell">
                  {t("Restart")}
                </button>
                <button type="button" title={t("Close this terminal tab")} onClick={() => void closeShell(current)} data-testid="Close exited shell">
                  {t("Close")}
                </button>
              </div>
            </div>
          </div>
        )}
        {!current && (opening || failed) && (
          <div className="terminal-starting terminal-chat" role="status" data-testid="Shell starting">
            {opening ? (
              <>
                <span className="spinner" aria-hidden="true" />
                <span className="muted">{t("Starting the shell…")}</span>
              </>
            ) : (
              <>
                <span className="orange">{failed}</span>
                <button type="button" onClick={() => void openShell(defaultShell())} title={t("New terminal in the project folder")} data-testid="Shell try again">
                  {t("Try Again")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {menuAt && <PointerMenu at={menuAt} items={newItems} onClose={() => setMenuAt(null)} />}
    </div>
  );
}
