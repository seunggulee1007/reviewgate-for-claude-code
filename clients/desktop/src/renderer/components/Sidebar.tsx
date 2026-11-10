/** Sidebar: Changes | PRs segmented control, project header (switcher + branch menu), changed files or the PR list. */
import { useEffect } from "react";
import type { WorkbenchInfo } from "@reviewgate/engine";
import { t } from "../i18n";
import { revealInFolderLabel } from "../platformWords"; // MARK: wave4d w4d-windows (polish-07): Explorer on Windows
import { isMainWorkbench, lastComponent, repoDisplayName, useStore } from "../store";
import { BranchSwitcher } from "./BranchSwitcher";
import { ChangedFiles } from "./ChangedFiles";
import { HistoryList } from "./history/HistoryList";
import { Menu, type MenuItem } from "./Menu";
import { PRList } from "./pr/PRList";
import { PEER_MODES, peerModeLabel } from "../peer";
import { TabStatusDot } from "./TabAttention";
import { OtherSessionsSection } from "./OtherSessions"; // MARK: wave3 desktop-session
import { removeRecent, useRecentEntries } from "../recentProjects"; // MARK: wave4 w4-install
import { runAsTaskEnabled } from "../runAsTask"; // MARK: §49

export function Sidebar() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const project = useStore((s) => s.state.project);
  const gitInit = useStore((s) => s.state.gitInit);
  const width = useStore((s) => s.ui.sidebarWidth);
  return (
    <div className="sidebar" style={width ? { width } : undefined}>
      <div className="segmented" role="tablist" data-testid="Sidebar tab">
        <button type="button" className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>{t("Changes")}<TabStatusDot /></button>
        <button type="button" className={tab === "prs" ? "active" : ""} onClick={() => setTab("prs")}>{t("PRs")}</button>
        <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")} title={t("Review history")} data-testid="History tab">{t("History")}</button>
      </div>
      <hr />
      {tab === "prs" ? (
        <PRList />
      ) : tab === "history" && project ? (
        <HistoryList />
      ) : project || gitInit ? (
        <>
          <ProjectHeader />
          <hr />
          <ChangedFiles />
          {/* wave3 desktop-session — §36.9 "이 저장소의 다른 Claude 세션" */}
          <OtherSessionsSection />
        </>
      ) : (
        <div className="empty">
          <div className="glyph">▭</div>
          <h2>{t("No project open")}</h2>
          <div>{t("Open a folder (⌘O) to start a Claude session.")}</div>
        </div>
      )}
    </div>
  );
}

function ProjectHeader() {
  const state = useStore((s) => s.state);
  const refreshBranches = useStore((s) => s.refreshBranches);
  const refreshWorkbenches = useStore((s) => s.refreshWorkbenches);
  const dismissedPRURL = useStore((s) => s.dismissedPRURL);
  const dismissPRBanner = useStore((s) => s.dismissPRBanner);
  const refresh = useStore((s) => s.refresh);
  const isRefreshing = useStore((s) => s.isRefreshing);
  const info = state.project;
  const root = info?.root ?? state.project?.path ?? state.gitInit?.path ?? "";
  useEffect(() => {
    if (info?.root) {
      void refreshBranches();
      void refreshWorkbenches();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.root]);
  useEffect(() => {
    const onFocus = () => {
      if (useStore.getState().state.project) void refreshWorkbenches();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshWorkbenches]);
  const pr = state.pr.lastCreatedPR;
  return (
    <div className="col" style={{ padding: "10px 12px", gap: 3 }}>
      <div className="row" style={{ gap: 6 }}>
        <ProjectSwitcher />
        {!isMainWorkbench(state) && (
          <span className="pill" title={t("A git worktree of {0} with its own Claude session", repoDisplayName(state))} data-testid="Workbench badge">
            {t("workbench")}
          </span>
        )}
        <span className="spacer" />
        {isRefreshing ? (
          <span className="spinner" data-testid="Refreshing" />
        ) : (
          <button type="button" className="plain small icon" title={t("Refresh (⌘R)")} disabled={!info} onClick={() => void refresh()} data-testid="Refresh">
            ↻
          </button>
        )}
      </div>
      <div className="caption muted truncate" title={root} data-testid="Project root">{displayPath(root)}</div>
      {info && (
        <div className="row" style={{ gap: 6 }}>
          <BranchSwitcher />
          {info.remoteURL ? (
            <span className="caption muted truncate" title={info.remoteURL} data-testid="Project remote">☁ {info.remoteURL}</span>
          ) : (
            <span className="caption faint" data-testid="Project remote">{t("no remote")}</span>
          )}
        </div>
      )}
      {state.session.model && <div className="tiny faint">{state.session.model}</div>}
      {pr && dismissedPRURL !== pr.url && (
        <div className="banner green" style={{ borderRadius: 8, marginTop: 4, padding: "6px 8px" }} data-testid="PR created banner">
          <div className="col grow" style={{ gap: 1 }}>
            <span className="caption bold">{t("PR created")}</span>
            <span className="tiny muted truncate">{pr.url}</span>
          </div>
          <button type="button" className="small" onClick={() => void window.rg.openExternal(pr.url)}>{t("Open")}</button>
          <button type="button" className="plain small" onClick={dismissPRBanner} title={t("Dismiss")} aria-label={t("Dismiss")}>✕</button>{/* MARK: wave4d w4d-speed — polish-10 */}
        </div>
      )}
    </div>
  );
}

/** Displayed with the OS separator; the engine always receives paths as given. */
export function displayPath(p: string): string {
  return window.rg.sep === "\\" ? p.replace(/\//g, "\\") : p;
}

function ProjectSwitcher() {
  const state = useStore((s) => s.state);
  const requestSwitch = useStore((s) => s.requestSwitch);
  const chooseAndOpen = useStore((s) => s.chooseAndOpen);
  const closeProject = useStore((s) => s.closeProject);
  const openDialog = useStore((s) => s.openDialog);
  const runAsTask = useStore((s) => runAsTaskEnabled(s.settings)); // MARK: §49
  const pruneWorkbenches = useStore((s) => s.pruneWorkbenches);
  const setPeerMode = useStore((s) => s.setPeerMode);
  const current = state.project?.path ?? state.gitInit?.path ?? null;
  // MARK: wave4 w4-install (daily-17): no temp folders; a folder that is gone is listed (never opened) and removable.
  const recentList = useRecentEntries();
  const recents = recentList.filter((e) => e.exists).map((e) => e.path);
  const missing = recentList.filter((e) => !e.exists).map((e) => e.path);
  const items: MenuItem[] = [];
  if (recentList.length === 0) items.push({ kind: "item", label: t("No recent projects"), disabled: true });
  // M19: ⌥-click (or the item below) opens a project in its own window instead of switching this one.
  const newWindowHint = t("⌥-click to open in a new window");
  for (const p of recents) {
    const isCurrent = current !== null && samePath(p, current);
    items.push({
      kind: "item",
      label: lastComponent(p),
      title: `${displayPath(p)}\n${newWindowHint}`,
      checked: isCurrent,
      disabled: isCurrent,
      onClick: (e) => (e.altKey ? void window.rg.openInNewWindow(p) : requestSwitch(p)),
    });
  }
  // MARK: wave4 w4-install (daily-17)
  for (const p of missing) {
    items.push({ kind: "item", label: t("{0} — not found", lastComponent(p)), title: t("Not found: {0}", displayPath(p)), disabled: true, testId: `Missing recent ${p}` });
  }
  if (missing.length > 0) items.push({ kind: "item", label: t("Remove Missing from List"), onClick: () => void removeRecent(null), testId: "Remove missing recents" });
  items.push({ kind: "sep" }, { kind: "head", label: t("Workbenches") });
  for (const wb of state.workbenches.list) {
    const isCurrent = current !== null && samePath(wb.path, current);
    items.push({
      kind: "item",
      label: workbenchTitle(wb, isCurrent),
      title: displayPath(wb.path),
      disabled: isCurrent,
      testId: `Workbench ${wb.branch ?? wb.path}`,
      onClick: () => void window.rg.openWorkbenchWindow(wb.path),
    });
  }
  if (state.workbenches.list.length === 0) items.push({ kind: "item", label: t("No workbenches"), disabled: true });
  items.push(
    { kind: "item", label: t("New Workbench…"), disabled: !state.project, onClick: () => openDialog({ kind: "newWorkbench" }), testId: "New Workbench…" },
    // MARK: §49 — "업무로 실행…" starts with an empty task
    ...(runAsTask ? [{ kind: "item" as const, label: t("Run as Task…"), disabled: !state.project, onClick: () => openDialog({ kind: "newWorkbench", task: "" }), testId: "Run as Task…" }] : []),
    { kind: "item", label: t("Prune"), disabled: !state.project, onClick: () => void pruneWorkbenches() },
    { kind: "sep" },
    { kind: "item", label: t("Open Project…"), onClick: () => void chooseAndOpen("switch") },
    { kind: "item", label: t("Open in New Window…"), title: newWindowHint, onClick: () => void window.rg.openInNewWindow(), testId: "Open in New Window…" },
    { kind: "item", label: revealInFolderLabel(window.rg.platform), disabled: !current, onClick: () => current && void window.rg.showItemInFolder(current) },
    { kind: "item", label: t("Close Project"), onClick: () => void closeProject() },
  );
  // MARK: wave1 desktop-session — §29 this project's own choice (`peer_set`; the effective mode is `session.peerInbound`).
  items.push({ kind: "sep" }, { kind: "head", label: t("Messages from other sessions (this project)") });
  for (const mode of PEER_MODES) {
    items.push({ kind: "item", label: peerModeLabel(mode), checked: state.session.peerInbound === mode, disabled: !state.project, onClick: () => void setPeerMode(mode), testId: `Peer mode ${mode}` });
  }
  return <Menu label={<span className="bold" style={{ fontSize: 14 }}>{repoDisplayName(state)}</span>} items={items} title={t("Switch project (⌘⇧O)")} testId="Project switcher" />;
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/** `branch · primary · ✓ · ● (dirty) · in use` — menus cannot render badges, so the row is text. */
function workbenchTitle(wb: WorkbenchInfo, isCurrent: boolean): string {
  const parts = [wb.branch ?? t("detached")];
  if (wb.isMain) parts.push(t("primary"));
  if (isCurrent) parts.push("✓");
  if (wb.dirty === true) parts.push("●");
  if (wb.locked && !isCurrent) parts.push(t("in use"));
  return parts.join(" · ");
}
