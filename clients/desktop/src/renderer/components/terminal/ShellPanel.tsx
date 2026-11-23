/**
 * §57.6 / §57.17 (plan §4.7): the bottom terminal panel — PowerShell / Command Prompt tabs in the project's folder, below
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
import { clampPanelHeight, closeShell, forgetShell, openShell, PANEL_TABS, panelTabHelp, panelTabTitle, restartShell, shellExitKeepsTab, shellTabTitle, toggleShellPanel, useShellPanel, type PanelTab } from "../../terminal/shellPanel";
import type { OutputFilter } from "../../outputLog";
import { OutputControls, OutputPanel } from "./OutputPanel"; // MARK: c-panel (§57.18)
import { RunPanel } from "./RunPanel";
import { ReferencesPanel } from "../../nav/ReferencesPanel"; // §65.8
import { useNav } from "../../nav/navStore";
import { isTerminalPanelKey } from "../../terminal/terminalKeys";
import { focusLiveTerminal } from "../../terminal/terminalChat";
import { focusTerminal, runningRuns, shellTerminals, subscribeTerminals, terminalsVersion, terminalStatus } from "../../terminal/termHost";
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

/** MARK: c-panel — §57.18: the panel's tab, remembered per project (`ui.terminalPanelTab`). */
function currentTab(): PanelTab {
  return useStore.getState().ui.terminalPanelTab ?? "terminal";
}

/** The status bar's buttons and the panel's tabs: the panel on `tab` (a first shell for the terminal tab). */
export function showPanelTab(tab: PanelTab): void {
  if (currentTab() !== tab) useStore.getState().setUI({ terminalPanelTab: tab });
  useShellPanel.setState({ shown: true, failed: null });
  if (tab !== "terminal" || (usePtyInfo.getState().info?.shells.length ?? 0) === 0) return;
  const tabs = shellTerminals();
  const s = useShellPanel.getState();
  const active = s.active && tabs.includes(s.active) ? s.active : (tabs[0] ?? null);
  if (active) {
    useShellPanel.setState({ active });
    setTimeout(() => focusTerminal(active), 0);
  } else void openShell(defaultShell());
}

/** App-wide (mounted once): Ctrl+`, the menu's Toggle Terminal Panel, and tabs whose shell ended for good. */
export function useShellPanelHost(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTerminalPanelKey(e)) return;
      const s = useStore.getState();
      if (!s.state.project || s.dialog) return;
      // §57.18: without a PTY the panel still opens (Output works); its terminal tab says why it cannot.
      const noPty = (usePtyInfo.getState().info?.shells.length ?? 0) === 0;
      if (noPty && currentTab() === "terminal" && !useShellPanel.getState().shown) return showPanelTab("output"), e.preventDefault();
      e.preventDefault();
      toggleShellPanel(defaultShell(), backToChat, currentTab());
    };
    document.addEventListener("keydown", onKey);
    // §65.8: a new Find References / Find in Project brings the References tab forward (the PRs tab has its own strip).
    const offRefs = useNav.subscribe((n, prev) => {
      if (n.refs && n.refs.seq !== prev.refs?.seq && useStore.getState().tab !== "prs") showPanelTab("references");
    });
    // A shell that exited 0, or ended with the project: its tab goes.
    const offTerms = subscribeTerminals(() => {
      for (const id of shellTerminals()) {
        const exit = terminalStatus(id).exit;
        if (exit && !shellExitKeepsTab(exit)) forgetShell(id, currentTab() === "terminal");
      }
    });
    return () => {
      document.removeEventListener("keydown", onKey);
      offTerms();
      offRefs();
    };
  }, []);
}

/** §57.18: the Output tab's source, per user (`localStorage` `rg.outputFilter`). */
function readOutputFilter(): OutputFilter {
  try {
    const v = localStorage.getItem("rg.outputFilter");
    return v === "reviewGate" || v === "claude" ? v : "all";
  } catch {
    return "all";
  }
}

function writeOutputFilter(f: OutputFilter): void {
  try {
    localStorage.setItem("rg.outputFilter", f);
  } catch {
    /* private mode etc. */
  }
}

/** View › Toggle Terminal Panel (menuActions.terminal.ts). */
export function toggleShellPanelFromMenu(): void {
  if (!useStore.getState().state.project) return;
  if ((usePtyInfo.getState().info?.shells.length ?? 0) === 0 && currentTab() === "terminal" && !useShellPanel.getState().shown) return showPanelTab("output");
  toggleShellPanel(defaultShell(), backToChat, currentTab());
}

/**
 * MARK: c-panel — §57.18: the bar under the window while the panel is hidden — the way to it for anyone who does not
 * know Ctrl+`: Terminal · Output · Run (with how many commands run).
 */
export function PanelStatusBar() {
  const { shown } = useShellPanel();
  useSyncExternalStore(subscribeTerminals, terminalsVersion, terminalsVersion);
  if (shown) return null;
  const running = runningRuns().length;
  return (
    <div className="panel-status-bar" role="toolbar" aria-label={t("Terminal")} data-testid="Panel status bar">
      <span className="grow" />
      {PANEL_TABS.map((tab) => (
        <button key={tab} type="button" className="plain small" title={panelTabHelp(tab)} onClick={() => showPanelTab(tab)} data-testid={`Panel status ${tab}`}>
          <Icon name={tab === "terminal" ? "terminal" : tab === "output" ? "lines" : tab === "references" ? "search" : "play"} size={11} />
          <span>{panelTabTitle(tab)}</span>
          {tab === "run" && running > 0 && <span className="run-count">{running}</span>}
        </button>
      ))}
    </div>
  );
}

export function ShellPanel() {
  const { shown, active, opening, failed } = useShellPanel();
  const shells = usePtyInfo((s) => s.info?.shells ?? []);
  const project = useStore((s) => s.state.project?.path ?? "");
  const wanted = useStore((s) => s.ui.terminalPanelHeight);
  const tab = useStore((s) => s.ui.terminalPanelTab ?? "terminal"); // MARK: c-panel (§57.18)
  const setUI = useStore((s) => s.setUI);
  useSyncExternalStore(subscribeTerminals, terminalsVersion, terminalsVersion);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [outputFilter, setOutputFilter] = useState<OutputFilter>(() => readOutputFilter());
  const [outputQuery, setOutputQuery] = useState("");
  const drag = useRef<{ y: number; h: number } | null>(null);
  if (!shown) return null;
  const running = runningRuns().length;
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
        {PANEL_TABS.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={p === tab}
            className={`panel-tab ${p === tab ? "active" : ""}`}
            title={panelTabHelp(p)}
            onClick={() => showPanelTab(p)}
            data-testid={`Panel tab ${p}`}
          >
            {panelTabTitle(p)}
            {p === "run" && running > 0 && <span className="run-count">{running}</span>}
          </button>
        ))}
        <span className="panel-tab-sep" aria-hidden="true" />
        {tab === "terminal" && tabs.map((id) => {
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
        {tab === "terminal" && <button
          type="button"
          className="plain small"
          disabled={opening || shells.length === 0}
          aria-label={t("New terminal")}
          aria-haspopup="menu"
          title={t("New terminal in the project folder")}
          onClick={(e) => setMenuAt({ x: e.clientX, y: e.clientY })}
          data-testid="New shell"
        >
          <Icon name="plus" size={12} />
        </button>}
        <span className="grow" />
        {tab === "output" && (
          <OutputControls
            filter={outputFilter}
            onFilter={(f) => {
              setOutputFilter(f);
              writeOutputFilter(f);
            }}
            query={outputQuery}
            onQuery={setOutputQuery}
          />
        )}
        {tab === "terminal" && failed && current && (
          <span className="caption orange truncate" role="status" title={failed} data-testid="Shell failed">
            {failed}
          </span>
        )}
        <button type="button" className="plain small" aria-label={t("Hide the terminal panel")} title={hideKey} onClick={() => useShellPanel.setState({ shown: false })} data-testid="Hide shell panel">
          <Icon name="chevronDown" size={12} />
        </button>
      </div>
      {tab === "output" && (
        <div className="shell-body">
          <OutputPanel filter={outputFilter} query={outputQuery} />
        </div>
      )}
      {tab === "run" && (
        <div className="shell-body">
          <RunPanel />
        </div>
      )}
      {tab === "references" && (
        <div className="shell-body">
          <ReferencesPanel />
        </div>
      )}
      {tab === "terminal" && <div className="shell-body">
        {shells.length === 0 && (
          <div className="terminal-starting terminal-chat" role="status" data-testid="Shell unavailable">
            <span className="muted">{t("Terminals need Windows 10 1903 or later")}</span>
          </div>
        )}
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
      </div>}
      {menuAt && <PointerMenu at={menuAt} items={newItems} onClose={() => setMenuAt(null)} />}
    </div>
  );
}
