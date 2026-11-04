/**
 * Top-level layout (the Mac app's `ContentView`): Sidebar (Changes | PRs) · `BannerStack` · main pane
 * (`DiffPane` for the review — collapsed to a `DiffEdgeTab` while there is nothing to review (M16) —,
 * `PRDetail` for PRs) · `ChatPane` (Changes tab only) · `<Dialogs />`. Wires
 * `window.rg.onEvent` → store, menu actions, the initial project (`REVIEWGATE_PROJECT` / a
 * workbench window), and starts the `--e2e` script (src/renderer/e2e.ts).
 */
import { useEffect, useState } from "react";
import { AgentPanel } from "./components/agents/AgentPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BannerStack } from "./components/BannerStack";
import ChatPane from "./components/chat/ChatPane";
import { Dialogs } from "./components/dialogs/Dialogs";
import { DiffEdgeTab } from "./components/diff/DiffEdgeTab";
import { HistoryDiffPane } from "./components/history/HistoryDiffPane";
import DiffPane from "./components/diff/DiffPane";
import { Divider } from "./components/Divider";
import { PRDetail } from "./components/pr/PRDetail";
import { SidePanel } from "./components/side/SidePanel";
import { displayPath, Sidebar } from "./components/Sidebar";
import { isDiffCollapsed } from "./friction";
import { t } from "./i18n";
import { useReviewShortcuts } from "./shortcuts";
import { lastComponent, useStore } from "./store";
import { removeRecent, useRecentEntries } from "./recentProjects"; // MARK: wave4 w4-install
import { Toast } from "./components/Toast";
import { useRejectShortcut } from "./rejectShortcut";
import { showToast } from "./toast";
import { LiveDiffPane } from "./components/diff/LiveDiffPane"; // MARK: wave2 desktop-flow
import { insertIntoComposer } from "./composerBridge"; // MARK: wave3 desktop-flow
import { useNotificationNotices } from "./components/NotificationNotices"; // MARK: wave4b w4-notify
import { receiveMovedChat } from "./chatMove"; // MARK: wave4b w4b-follow
import { BoardDialog } from "./components/board/BoardDialog"; // MARK: wave5 w5-board

declare global {
  interface Window {
    /** `--rg-project=<path>` (src/preload.ts): the folder to open once the engine is ready. */
    rgInitialProject: string | null;
  }
}

export function App() {
  const tab = useStore((s) => s.tab);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const hasProject = useStore((s) => s.state.project !== null || s.state.gitInit !== null);
  const diffCollapsed = useStore((s) => isDiffCollapsed(s.state, s.ui, s.selectedPath));
  const agentPanelOpen = useStore((s) => s.agentPanelOpen);
  const historyOpen = useStore((s) => s.historyView !== null);
  // wave2 desktop-flow — §34.6: a file of the running turn's changes so far, read-only in place of the review diff.
  const liveOpen = useStore((s) => s.liveView !== null && s.historyView === null);
  const sideOpen = useStore((s) => s.sidePanelOpen);
  const boardOpen = useStore((s) => s.boardOpen); // MARK: wave5 w5-board
  useReviewShortcuts();
  useNotificationNotices(); // MARK: wave4b w4-notify — §39.6: a clicked notification lands on its card; the OS refusing one
  // polish-03: ⌘⇧R / Ctrl+Shift+R is always the reject shortcut — never the browser's force reload.
  useRejectShortcut(() => {
    const s = useStore.getState();
    return {
      get: () => ({ state: s.state, selectedPath: s.selectedPath, tab: s.tab, ui: s.ui, historyOpen: s.historyView !== null, dialogOpen: s.dialog !== null }),
      reject: (path) => s.openDialog({ kind: "rejectOne", path }), // MARK: wave4 w4-safety — daily-11: asks first
      toast: showToast,
    };
  });

  useEffect(() => {
    const store = useStore.getState();
    const offEvents = window.rg.onEvent((ev) => useStore.getState().handleEvent(ev));
    const offMenu = window.rg.onMenu((action) => {
      const s = useStore.getState();
      switch (action.type) {
        case "open_project":
          void s.chooseAndOpen("open");
          break;
        case "open_recent":
          if (s.state.project) s.requestSwitch(action.path);
          else void s.openProject(action.path);
          break;
        case "switch_project":
          void s.chooseAndOpen("switch");
          break;
        case "new_workbench":
          s.openDialog({ kind: "newWorkbench" });
          break;
        // MARK: §49 — File › "업무로 실행…": the sheet as "Run as Task" with an empty task
        case "run_as_task":
          if (s.state.project) s.openDialog({ kind: "newWorkbench", task: "" });
          break;
        case "settings":
          s.openDialog({ kind: "settings" });
          break;
        case "toggle_sidebar":
          s.toggleSidebar();
          break;
        case "refresh":
          void s.refresh();
          break;
        // MARK: wave3 desktop-flow — §36.14: PR comments another window sent here ("Send to Claude"); never sent by itself.
        case "composer_draft":
          s.setTab("changes");
          insertIntoComposer(action.text);
          break;
        // MARK: wave4b w4b-follow — §39.4: another window handed its chat to this worktree.
        case "chat_receive":
          void receiveMovedChat();
          break;
        // MARK: wave4d w4d-windows — polish-08: Help › Keyboard Shortcuts and the View menu's panel toggles (the Mac's).
        case "shortcuts":
          s.openDialog({ kind: "shortcuts" });
          break;
        case "toggle_diff_pane":
          if (s.state.project) s.toggleDiffPane();
          break;
        case "toggle_agent_panel":
          if (s.state.project) s.toggleAgentPanel();
          break;
        case "toggle_side_panel":
          if (s.state.project) s.toggleSidePanel();
          break;
        // MARK: wave5 w5-board — §43.1
        case "toggle_board":
          if (s.state.project) s.toggleBoard();
          break;
      }
    });
    void store.loadSettings().then(() => {
      const initial = window.rgInitialProject;
      if (initial && !useStore.getState().state.project) void useStore.getState().openProject(initial);
      if (window.rg.e2e) void import("./e2e").then((m) => m.runE2E(window.rg.e2e!));
    });
    return () => {
      offEvents();
      offMenu();
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="app" data-testid="App">
        {sidebarVisible && <ErrorBoundary name="Sidebar" className="sidebar"><Sidebar /></ErrorBoundary>}
        {sidebarVisible && <PaneDivider pref="sidebarWidth" fallback={300} min={240} max={460} testId="Sidebar divider" />}
        <div className="main">
          <ErrorBoundary name="Banners"><BannerStack /></ErrorBoundary>
          <div className="panes">
            {tab === "prs" ? (
              <ErrorBoundary name="PR" className="pane diff"><PRDetail /></ErrorBoundary>
            ) : hasProject ? (
              <>
                {diffCollapsed && !historyOpen && !liveOpen ? (
                  <ErrorBoundary name="Diff"><DiffEdgeTab /></ErrorBoundary>
                ) : (
                  <>
                    {historyOpen ? (
                      <ErrorBoundary key="history" name="History" className="pane diff"><HistoryDiffPane /></ErrorBoundary>
                    ) : liveOpen ? (
                      <ErrorBoundary key="live" name="Live diff" className="pane diff"><LiveDiffPane /></ErrorBoundary>
                    ) : (
                      <ErrorBoundary key="diff" name="Diff" className="pane diff"><DiffPane /></ErrorBoundary>
                    )}
                    <PaneDivider pref="chatWidth" fallback={0} min={360} max={Math.max(360, window.innerWidth - 700)} sign={-1} testId="Chat divider" />
                  </>
                )}
                <ErrorBoundary name="Chat" className="pane chat"><ChatPane /></ErrorBoundary>
                {sideOpen && <ErrorBoundary name="Side" className="side-panel"><SidePanel /></ErrorBoundary>}
              </>
            ) : (
              <ErrorBoundary name="Start" className="pane diff"><NoProject /></ErrorBoundary>
            )}
          </div>
          {agentPanelOpen && tab !== "prs" && hasProject && <ErrorBoundary name="Agents" className="agent-panel"><AgentPanel /></ErrorBoundary>}
        </div>
        {boardOpen && hasProject && <ErrorBoundary name="Agent board"><BoardDialog /></ErrorBoundary>}{/* MARK: wave5 w5-board */}
        <ErrorBoundary name="Dialogs"><Dialogs /></ErrorBoundary>
        <Toast />
      </div>
    </div>
  );
}

/** Drag handle bound to one persisted width (`store.ui`): live frames are not written, the release is. */
function PaneDivider(props: { pref: "sidebarWidth" | "chatWidth"; fallback: number; min: number; max: number; sign?: 1 | -1; testId: string }) {
  const setUI = useStore((s) => s.setUI);
  const current = () => useStore.getState().ui[props.pref] ?? props.fallback;
  const el = () => (props.pref === "sidebarWidth" ? document.querySelector<HTMLElement>(".sidebar") : document.querySelector<HTMLElement>(".pane.chat"));
  return (
    <Divider
      testId={props.testId}
      onDrag={(dx) => {
        const base = current() || el()?.getBoundingClientRect().width || props.fallback;
        setUI({ [props.pref]: Math.min(props.max, Math.max(props.min, Math.round(base + dx * (props.sign ?? 1)))) }, false);
      }}
      onEnd={() => setUI({ [props.pref]: current() })}
    />
  );
}

/** Empty state when no project is open: Open Project… plus the recent projects from settings. */
function NoProject() {
  const entries = useRecentEntries(); // MARK: wave4 w4-install (daily-17): no temp folders, gone ones dimmed, each removable
  const [notice, setNotice] = useState<string | null>(null);
  const chooseAndOpen = useStore((s) => s.chooseAndOpen);
  const openProject = useStore((s) => s.openProject);
  return (
    <div className="empty grow" data-testid="No project">
      <div className="glyph">▭</div>
      <h2>{t("No project open")}</h2>
      <div>{t("Open a folder (⌘O) to start a Claude session.")}</div>
      <button type="button" className="primary" onClick={() => void chooseAndOpen("open")} data-testid="Open project">
        {t("Open Project…")}
      </button>
      {entries.length > 0 && (
        <div className="col" style={{ gap: 4, marginTop: 12, alignItems: "stretch", width: 360, maxWidth: "100%" }}>
          <div className="caption muted bold">{t("Recent projects")}</div>
          {/* M19: ⌥-click opens the project in its own window (docs/M19-MULTIPROJECT.md §1). */}
          {entries.map(({ path: p, exists }) => (
            <div key={p} className="row" style={{ gap: 2 }}>
              <button
                type="button"
                className={exists ? "plain truncate grow" : "plain truncate grow muted"}
                style={{ textAlign: "left", opacity: exists ? 1 : 0.6 }}
                title={exists ? `${displayPath(p)}\n${t("⌥-click to open in a new window")}` : t("Not found: {0}", displayPath(p))}
                aria-label={exists ? undefined : t("{0}, not found", lastComponent(p))}
                data-testid={exists ? undefined : `Missing recent ${p}`}
                onClick={(e) => {
                  // A folder that is gone is never opened: the reason instead.
                  if (!exists) return setNotice(t("{0} was not found at {1}. Moved or deleted? Remove it from the list.", lastComponent(p), displayPath(p)));
                  setNotice(null);
                  return e.altKey ? void window.rg.openInNewWindow(p) : void openProject(p);
                }}
              >
                {exists ? displayPath(p) : t("Not found · {0}", displayPath(p))}
              </button>
              <button
                type="button"
                className="plain muted"
                title={t("Remove from Recent")}
                aria-label={t("Remove {0} from Recent", lastComponent(p))}
                data-testid={`Remove recent ${p}`}
                onClick={() => {
                  setNotice(null);
                  void removeRecent(p);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {notice && (
            <div className="caption orange" role="status" data-testid="Recent not found notice">
              {notice}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
