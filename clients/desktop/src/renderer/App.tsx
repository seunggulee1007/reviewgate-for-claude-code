/**
 * Top-level layout (the Mac app's `ContentView`): Sidebar (Changes | PRs) · `BannerStack` · main pane
 * (`DiffPane` for the review — collapsed to a `DiffEdgeTab` while there is nothing to review (M16) —,
 * `PRDetail` for PRs) · `ChatPane` (Changes tab only) · `<Dialogs />`. Wires
 * `window.rg.onEvent` → store, menu actions, the initial project (`REVIEWGATE_PROJECT` / a
 * workbench window), and starts the `--e2e` script (src/renderer/e2e.ts).
 */
import { useEffect, useRef, useState } from "react";
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
import { useNav } from "./nav/navStore"; // §62 code navigation
import { NavLayer, NavRefsPanel } from "./nav/NavViews";
import { ProjectFilePane } from "./nav/ProjectFilePane";
import { useNotificationNotices } from "./components/NotificationNotices"; // MARK: wave4b w4-notify
import { receiveMovedChat } from "./chatMove"; // MARK: wave4b w4b-follow
import { BoardDialog } from "./components/board/BoardDialog"; // MARK: wave5 w5-board
import { backgroundKeyJustHandled } from "./background"; // §52
import { runMenuAction } from "./menuActions"; // MARK: polish p-foundation (P1-chrome-09)
import { useTermHost } from "./terminal/useTermHost"; // §57.17
import { diffCollapsedNow, draftToLiveChat, shownChatIsTerminal, useTerminalChatPty } from "./terminal/terminalChat"; // §57.17
import { TerminalSplit, useTerminalReviewReopen } from "./components/terminal/TerminalSplit"; // §57.5
import { PanelStatusBar, ShellPanel, useShellPanelHost } from "./components/terminal/ShellPanel"; // §57.17, §57.18
import { useViewing } from "./viewedChat"; // §57.5
import { StartScreen, useStartScreenWatch } from "./components/start/StartScreen"; // MARK: task-start (§63.4)
import { noProjectKey, type NoProjectChoice } from "./newProject"; // §69
import { Icon, type IconName } from "./icons";
import "./components/start/start.css";

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
  const fileOpen = useNav((s) => s.file !== null); // §62: a project file opened by Go to Definition, in the diff pane's place
  const boardOpen = useStore((s) => s.boardOpen); // MARK: wave5 w5-board
  // §57.5: a terminal chat on screen lays the window out terminal-first (components/terminal/TerminalSplit.tsx).
  const viewingId = useViewing()?.id ?? null;
  const terminalFirst = useStore((s) => shownChatIsTerminal(s.state, viewingId));
  useReviewShortcuts();
  useTermHost(); // §57.17: the window's terminals (terminal chats, the shell panel)
  useTerminalChatPty(); // §57.17: the live terminal chat's PTY and its waits
  useTerminalReviewReopen(); // §57.5: a terminal chat's review panel opens again with each review
  useShellPanelHost(); // §57.17: Ctrl+` and the shell tabs' exits
  useStartScreenWatch(); // MARK: task-start — §63.4: whether a project the window opens shows the start screen
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
          // §52: the same Ctrl+B already sent the running command to the background from the message box.
          if (!backgroundKeyJustHandled()) s.toggleSidebar();
          break;
        case "refresh":
          void s.refresh();
          break;
        // MARK: wave3 desktop-flow — §36.14: PR comments another window sent here ("Send to Claude"); never sent by itself.
        case "composer_draft":
          s.setTab("changes");
          draftToLiveChat(action.text); // §57.7: a live terminal chat gets it pasted (no Enter)
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
          if (s.state.project) s.toggleDiffPane(diffCollapsedNow()); // §57.5
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
        // MARK: polish p-foundation (P1-chrome-09): a lane's own menu items, handled in its menuActions.*.ts table
        default:
          runMenuAction(action);
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
            ) : hasProject && terminalFirst ? (
              <>
                <TerminalSplit />
                {sideOpen && <ErrorBoundary name="Side" className="side-panel"><SidePanel /></ErrorBoundary>}
              </>
            ) : hasProject ? (
              <>
                {diffCollapsed && !historyOpen && !liveOpen && !fileOpen ? (
                  <ErrorBoundary name="Diff"><DiffEdgeTab /></ErrorBoundary>
                ) : (
                  <>
                    {fileOpen ? (
                      <ErrorBoundary key="project-file" name="Project file" className="pane diff"><ProjectFilePane /></ErrorBoundary>
                    ) : historyOpen ? (
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
            {/* MARK: task-start — §63.4: over the diff and chat area (the sidebar, menus and bottom panel stay usable) */}
            {tab !== "prs" && hasProject && <ErrorBoundary name="Start screen"><StartScreen /></ErrorBoundary>}
          </div>
          {/* §62: Find References / Find in Project results under the panes — §65.8: elsewhere the bottom panel's References tab */}
          {hasProject && tab === "prs" && <ErrorBoundary name="References"><NavRefsPanel /></ErrorBoundary>}
          {/* §57.17: the bottom terminal panel (PowerShell / Command Prompt) — no Claude, no preview needed */}
          {tab !== "prs" && hasProject && <ErrorBoundary name="Terminal panel"><ShellPanel /></ErrorBoundary>}
          {tab !== "prs" && hasProject && <ErrorBoundary name="Panel status bar"><PanelStatusBar /></ErrorBoundary>}{/* MARK: c-panel (§57.18) */}
          {agentPanelOpen && tab !== "prs" && hasProject && <ErrorBoundary name="Agents" className="agent-panel"><AgentPanel /></ErrorBoundary>}
        </div>
        {boardOpen && hasProject && <ErrorBoundary name="Agent board"><BoardDialog /></ErrorBoundary>}{/* MARK: wave5 w5-board */}
        <ErrorBoundary name="Dialogs"><Dialogs /></ErrorBoundary>
        <ErrorBoundary name="Code navigation"><NavLayer /></ErrorBoundary>
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

/** §69.4: the three cards of the window with no project — 1 / 2 / 3 act at once, the arrows move the mark, Enter takes it. */
function NoProjectCards({ opening, onOpen }: { opening: boolean; onOpen: () => void }) {
  const openDialog = useStore((s) => s.openDialog);
  const dialogOpen = useStore((s) => s.dialog !== null);
  const parent = useStore((s) => s.settings?.newProjectParent);
  const [mark, setMark] = useState<NoProjectChoice>(1);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dialogOpen) root.current?.focus({ preventScroll: true });
  }, [dialogOpen]);
  const act = (c: NoProjectChoice) => {
    if (opening) return;
    if (c === 1) openDialog({ kind: "newProject" });
    else if (c === 2) openDialog({ kind: "taskProject" });
    else onOpen();
  };
  const where = parent?.trim() || (window.rg.platform === "win32" ? "%USERPROFILE%\\ReviewGate" : "~/ReviewGate");
  const cards: { c: NoProjectChoice; icon: IconName; title: string; detail: string; help: string; testId: string }[] = [
    { c: 1, icon: "plus", title: t("New Project"), detail: t("No folder yet — say what you want to make"), help: t("Makes a folder for it under {0} as a git repository (1)", where), testId: "No project choice 1" },
    { c: 2, icon: "branch", title: t("Start from a task"), detail: t("Pick the project the task belongs to"), help: t("A task link, key or number — then its project, its branch and first prompt (2)"), testId: "No project choice 2" },
    { c: 3, icon: "folder", title: t("Open a folder…"), detail: t("A project you already have"), help: t("Choose a project folder (3)"), testId: "Open project" },
  ];
  return (
    <div
      ref={root}
      className="start-cards"
      tabIndex={-1}
      role="group"
      aria-label={t("New Project · Start from a task · Open a folder…")}
      style={{ width: 640, maxWidth: "100%", outline: "none" }}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement || e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing) return;
        const r = noProjectKey(e.key, mark);
        if (!r.handled) return;
        e.preventDefault();
        setMark(r.mark);
        if (r.act !== null) act(r.act);
      }}
      data-testid="No project start"
    >
      {cards.map(({ c, icon, title, detail, help, testId }) => (
        <button
          key={c}
          type="button"
          className={mark === c ? "start-card marked" : "start-card"}
          disabled={opening}
          title={opening ? t("Opening a project…") : help}
          aria-label={`${title} — ${detail}`}
          onClick={() => { setMark(c); act(c); }}
          onFocus={() => setMark(c)}
          data-testid={testId}
        >
          <span className="row" style={{ justifyContent: "space-between" }}>
            <span className="start-card-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
            <span className="start-badge" aria-hidden="true">{c}</span>
          </span>
          <span className="start-card-title">{title}</span>
          <span className="caption muted">{detail}</span>
        </button>
      ))}
    </div>
  );
}

/** Empty state when no project is open: the §69 cards plus the recent projects from settings. */
function NoProject() {
  const entries = useRecentEntries(); // MARK: wave4 w4-install (daily-17): no temp folders, gone ones dimmed, each removable
  const [notice, setNotice] = useState<string | null>(null);
  const chooseAndOpen = useStore((s) => s.chooseAndOpen);
  const openProject = useStore((s) => s.openProject);
  const opening = useStore((s) => s.openingPath);
  return (
    <div className="empty grow" data-testid="No project">
      <div className="glyph">▭</div>
      {/* An open on its way (it may wait on git — the engine caps it at 20 s and then says why): never a silent window. */}
      {opening ? (
        <h2 className="row" style={{ gap: 8 }} title={displayPath(opening)} data-testid="Opening project">
          <span className="spinner" aria-hidden="true" />
          {t("Opening {0}…", lastComponent(opening))}
        </h2>
      ) : (
        <h2>{t("How do you want to start?")}</h2>
      )}
      <div>{t("ReviewGate runs Claude in a folder and gates every change behind your review — no folder yet? Start with New Project.")}</div>
      {/* §69: 1 New · 2 Start from a task · 3 Open a folder… (Open Project), with the keys of the start screen */}
      <NoProjectCards opening={opening !== null} onOpen={() => void chooseAndOpen("open")} />
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
