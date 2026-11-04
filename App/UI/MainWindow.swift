import SwiftUI
import AppKit
import ReviewGateCore

/// Sidebar mode: the session's changed files + chat, past review rounds (§14), or the PR browser.
enum MainTab: String, CaseIterable, Identifiable {
    case changes, history, prs
    case search   // MARK: code-browser (§47): Find in Project
    var id: String { rawValue }
    var title: LocalizedStringKey {
        switch self {
        case .changes: "Changes"
        case .history: "History"
        case .prs: "PRs"
        case .search: "Search"
        }
    }
    /// The diff + chat detail (and the agent panel) belong to this tab.
    var showsReview: Bool { self != .prs }
}

struct MainWindow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Binding var tab: MainTab
    /// Set by the switcher / ⌘⇧O when files are still pending review; the alert below confirms the switch.
    @Binding var pendingSwitch: URL?
    @Environment(WindowModel.self) private var model
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var confirmUnsafeInit = false
    /// Mirrors `store.needsGitInit` so the sheet is driven by plain view state.
    @State private var showGitInit = false
    @State private var showNewBranch = false
    @State private var newBranchName = ""
    // M10 workbenches
    @Environment(\.openWindow) private var openWindow
    @State private var showCreatePR = false
    /// Workbench waiting for the "remove?" confirmation.
    @State private var removeCandidate: WorkbenchInfo?
    /// Removal refused (dirty / in use): offer `force`.
    @State private var forceRemoveCandidate: WorkbenchInfo?
    @State private var removeRefusal = ""
    /// URL of the PR banner the user dismissed.
    @State private var dismissedPRURL: String?
    /// SHA of the commit banner the user dismissed (M12).
    @State private var dismissedCommitSha: String?
    @State private var pushing = false
    // M15 per-project UI state (`AppSettings.projectUIState`): restored when the project opens, saved on change.
    /// Root whose state is loaded.
    @State private var uiStateRoot: String?
    /// Diff pane width as a fraction of the diff+chat split (0…1).
    @State private var diffFraction = 0.5
    /// M16: the diff pane is collapsed to an edge tab (chat takes the width); auto-collapses when nothing is changed.
    @State private var diffCollapsed = false
    /// The agent activity inspector (remembered across launches; ⌥⌘A, the toolbar button, the HUD agents chip).
    @AppStorage(AgentPanel.storageKey) private var showAgentPanel = false
    /// §21 the side-question inspector (remembered; shares the inspector column with the agent panel).
    @AppStorage(SidePanel.storageKey) private var showSidePanel = false
    /// Window width, to make room for the agent panel in narrow windows.
    @State private var windowWidth: CGFloat = 0
    /// The sidebar was hidden to make room for the agent panel (restored when the panel closes or the window widens).
    @State private var sidebarHiddenForPanel = false
    /// §16: the applied-extensions sheet (from the fallback banner).
    @State private var showExtensions = false
    // MARK: wave4 w4-install
    /// Bumped when the switcher removes a recent, so the menu re-reads the list.
    @State private var recentsTick = 0
    @AppStorage(AppSettings.Key.runAsTaskEnabled) private var runAsTaskEnabled = true   // §49

    var body: some View {
        @Bindable var model = model
        splitView
            // M19: when the lock holder is one of OUR windows, focus it instead of offering a takeover.
            .onChange(of: store.lockConflict?.pid) { _, _ in focusOwnWindowHoldingLock() }
            .alert("This workbench is already open", isPresented: Binding(get: { store.lockConflict != nil && ownWindowHoldingLock() == nil }, set: { if !$0 { store.cancelTakeover() } }),
                   presenting: store.lockConflict) { _ in
                Button("Take over") { Task { await store.takeOver() } }
                Button("Cancel", role: .cancel) { store.cancelTakeover() }
            } message: { lock in
                Text("This workbench is already open in another window or session (pid \(String(lock.pid)), since \(lockSince(lock))). Take over?")
            }
            // §19.1: a whole-file reject refused because the user edited files after the review — nothing was reverted.
            .alert("Your own edits will be lost — revert anyway?",
                   isPresented: Binding(get: { store.forceRejectRequest != nil }, set: { if !$0 { store.cancelForceReject() } }),
                   presenting: store.forceRejectRequest) { _ in
                Button("Revert anyway", role: .destructive) { store.confirmForceReject() }
                    .accessibilityIdentifier("Force reject confirm")
                Button("Cancel", role: .cancel) { store.cancelForceReject() }
                    .accessibilityIdentifier("Force reject cancel")
            } message: { request in
                Text(forceRejectMessage(request))
            }
            // wave1 mac-review — §31–32: reverting changes from outside the app, the stale-review sheet, Finish review.
            .modifier(ReviewProvenanceModals())
            .modifier(SessionToolsModals())   // wave3 mac-session (§36.9): CLI 세션 가져오기
            .sheet(isPresented: $model.showNewWorkbench, onDismiss: { model.newWorkbenchBranch = nil; model.newWorkbenchPlanMode = nil; model.newWorkbenchTask = nil }) {
                NewWorkbenchSheet(initialBranch: model.newWorkbenchBranch ?? "") { url in workbenchCreated(url) }   // wave4d w4d-plan
            }
            .sheet(isPresented: $showCreatePR) {
                CreatePRSheet()
            }
            .alert("Remove workbench?", isPresented: Binding(get: { removeCandidate != nil }, set: { if !$0 { removeCandidate = nil } }),
                   presenting: removeCandidate) { wb in
                Button("Remove", role: .destructive) { Task { await removeWorkbench(wb, force: false) } }
                Button("Cancel", role: .cancel) {}
            } message: { wb in
                Text("Deletes the worktree folder \(wb.path). The branch \(wb.branch ?? "") is kept.")
            }
            .alert("Could not remove workbench", isPresented: Binding(get: { forceRemoveCandidate != nil }, set: { if !$0 { forceRemoveCandidate = nil } }),
                   presenting: forceRemoveCandidate) { wb in
                Button("Force remove", role: .destructive) { Task { await removeWorkbench(wb, force: true) } }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("\(removeRefusal)\n\nForce removal discards uncommitted changes and ignores another session's lock.")
            }
    }

    private var splitView: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            VStack(spacing: 0) {
                Picker("Sidebar", selection: $tab) {
                    ForEach(MainTab.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .overlay { ChangesTabBadge(tab: tab) }   // wave1 mac-session (daily-03)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .accessibilityIdentifier("Sidebar tab")
                Divider()
                switch tab {
                case .changes: sidebar
                case .history:
                    if store.projectURL == nil { noProjectSidebar } else { ReviewHistoryList() }
                case .prs: PRListView()
                case .search:   // MARK: code-browser (§47)
                    if store.projectURL == nil { noProjectSidebar } else { ProjectSearchSidebar() }
                }
            }
            .navigationSplitViewColumnWidth(min: 260, ideal: 300, max: 420)
        } detail: {
            switch tab {
            case .changes, .history, .search:
                if store.projectURL == nil {
                    VStack(spacing: 0) {
                        AppMoveBanner()   // MARK: wave4 w4-install — running from a disk image: Move to Applications / Later
                        AppUpdateBannerView()   // MARK: app-update (§48) — "ReviewGate x is available" (with its divider)
                        // An engine that failed to start or stopped leaves the window empty: the banner says why.
                        if let banner = store.errorBanner {
                            errorBanner(banner)
                            Divider()
                        }
                        EmptyProjectView()
                    }
                } else {
                    VStack(spacing: 0) {
                        AppMoveBanner()   // MARK: wave4 w4-install — running from a disk image: Move to Applications / Later
                        StorageBanners()   // MARK: wave4b w4b-bigturn (§39.1) — a save failed / the disk is almost full
                        NotificationsOffBanner()   // MARK: wave4b w4-notify — macOS turned ReviewGate's notifications off (once)
                        // M16: the one banner stack — error, commit, restored review and integrity notices.
                        if let banner = store.errorBanner {
                            errorBanner(banner)
                            Divider()
                        }
                        if let fallback = store.extensionsFallbackBanner {   // wave3 mac-session: once closed, closed for the project
                            extensionsFallbackBanner(fallback)
                            Divider()
                        }
                        CliVersionBannerView()   // wave3 mac-session (§36.8): "새 CLI x — 아직 검증 안 됨" (with its divider)
                        AppUpdateBannerView()   // MARK: app-update (§48) — "ReviewGate x is available" (with its divider)
                        if let commit = store.lastCommit, dismissedCommitSha != commit.sha {
                            commitBanner(commit)
                            Divider()
                        }
                        WorkbenchSetupReportBanner()   // wave3 mac-flow (§36.12): this new workbench's setup failed — the log
                        TransientProjectBanner()   // a project in /tmp: macOS sweeps it, .git included
                        RejectUndoBanner()   // MARK: wave4c w4c-trust (§41.2): "거절했어요 — [거절 취소]" (with its divider)
                        ReviewNoticesBar()
                        if store.isReviewRestored || !store.changedOutside.isEmpty || !store.ignoredTouched.isEmpty || !store.filteredByPattern.isEmpty {
                            Divider()
                        }
                        // The edge tab stays while the pane is open, so the way back (collapse) is where expand was.
                        HStack(spacing: 0) {
                            diffEdgeTab
                            Divider()
                            if diffCollapsed {
                                ChatView()
                            } else {
                                SplitPane(fraction: $diffFraction, minLeading: 420, minTrailing: 360,
                                          onCommit: { fraction in updateUIState { $0.diffFraction = fraction } }) {
                                    if store.codeBrowser.isOpen {
                                        // MARK: code-browser (§47): a project file, read-only, until "Back to review".
                                        ProjectFileView()
                                    } else if tab == .history || store.historySelection != nil {
                                        // §14: a past round's file, read-only, until "Back to current review".
                                        HistoryDiffView { tab = .changes }
                                    } else if store.liveSelection != nil {
                                        // wave2 mac-flow (§34.6): the running turn's change so far, read-only.
                                        LiveDiffView()
                                    } else {
                                        // wave7 w7-state (§45.2): equal inputs (no closures) — a window re-render skips it.
                                        DiffView(
                                            file: store.selectedFile,
                                            diff: store.selectedDiff,
                                            truncated: store.selectedDiffTruncated,
                                            isReviewLocked: store.isReviewLocked)
                                    }
                                } trailing: {
                                    ChatView()
                                }
                            }
                        }
                    }
                    .inspector(isPresented: inspectorVisible) {
                        Group {
                            if showSidePanel {
                                SidePanelView()
                            } else {
                                AgentPanelView()
                            }
                        }
                        .inspectorColumnWidth(min: 280, ideal: 340, max: 560)
                    }
                }
            case .prs:
                VStack(spacing: 0) {
                    ClaudeWaitingBar { tab = .changes }   // wave1 mac-session (daily-03)
                    PRDetailView()
                }
            }
        }
        .navigationTitle(store.windowTitle)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button("Open Project", systemImage: "folder") { ProjectOpener.choose(store: store) }
                    .help("Open a project folder (⌘O)")
                    .accessibilityLabel("Open Project")
                    .accessibilityIdentifier("Open Project")
            }
            ToolbarItem(placement: .primaryAction) {
                // MARK: code-browser (§47): any file of the project, read-only.
                if store.projectURL != nil {
                    Button("Go to File", systemImage: "doc.text.magnifyingglass") { store.codeBrowser.quickOpenShown = true }
                        .help("Go to File — open any file of the project read-only (⌘P); Find in Project: ⇧⌘F")
                        .accessibilityIdentifier("Go to File")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh", systemImage: "arrow.clockwise") { refresh() }
                    .disabled(!canRefresh)
                    .help("Refresh the review, branches, workbenches and PRs (⌘R)")
                    .accessibilityLabel("Refresh")
                    .accessibilityIdentifier("Refresh")
            }
            ToolbarItem(placement: .primaryAction) {
                if tab.showsReview, store.projectURL != nil, store.side.isSupported {
                    Button { toggleSidePanel() } label: {
                        Label("Side questions", systemImage: store.side.runningCount > 0 ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.and.text.bubble.right")
                    }
                    .help("Show or hide side questions — ask about a change without touching the main conversation (⌥⌘S)")
                    .accessibilityIdentifier("Toggle side panel")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                if tab.showsReview, store.projectURL != nil {
                    Button { showAgentPanel.toggle() } label: {
                        Label("Agents", systemImage: store.liveAgentCount > 0 ? "person.2.wave.2.fill" : "person.2.wave.2")
                    }
                    .help("Show or hide the agent activity panel (⌥⌘A)")
                    .accessibilityIdentifier("Toggle agent panel")
                }
            }
            ToolbarItem(placement: .primaryAction) {
                if store.isRefreshing || (tab == .prs && store.pr.isLoading) {
                    ProgressView().controlSize(.small)
                        .accessibilityIdentifier("Refreshing")
                }
            }
        }
        .onChange(of: store.needsGitInit, initial: true) { _, needs in showGitInit = needs }
        .onChange(of: store.projectInfo?.root, initial: true) { _, root in restoreUIState(root: root) }
        .onChange(of: tab) { _, new in updateUIState { $0.sidebarTab = new.rawValue } }
        .onChange(of: store.selectedPath) { _, path in
            if let path {
                updateUIState { $0.selectedPath = path }
                setDiffCollapsed(false, remember: false)   // M16: picking a file always shows its diff
            }
        }
        .onChange(of: model.diffJump?.tick) { _, tick in
            if tick != nil { setDiffCollapsed(false, remember: false) }   // a link to the file already selected shows its diff too
        }
        .onChange(of: store.historySelection) { _, selection in
            if selection != nil { setDiffCollapsed(false, remember: false) }   // a history file always shows its diff
        }
        .onChange(of: store.liveSelection) { _, selection in
            if selection != nil { setDiffCollapsed(false, remember: false) }   // wave2 mac-flow: so does a live one
        }
        .onChange(of: tab) { _, new in
            // Leaving the history (another tab, the turn summary's file links) returns the pane to the current review.
            if new != .history { store.closeHistoryDiff() }
        }
        .sheet(isPresented: $showExtensions) { ExtensionsSheet() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // Coming back from another editor: the same review re-diff as ⌘R, so files saved there show up.
            if store.gatePhase == .reviewing, !store.isRefreshing { Task { await store.refresh(scope: [.review]) } }
        }
        .onChange(of: store.changedFiles.isEmpty) { _, empty in
            // M16: files arriving expand the diff pane; an empty review (nothing selected) collapses it — unless a project
            // file is open there (code-browser, §47).
            setDiffCollapsed(empty && store.selectedFile == nil && !store.codeBrowser.isOpen, remember: false)
        }
        .onChange(of: model.toggleDiffTick) { _, _ in setDiffCollapsed(!diffCollapsed) }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            windowWidth = width
            fitAgentPanel()
        }
        .modifier(InspectorObservers(showAgentPanel: $showAgentPanel, showSidePanel: $showSidePanel, tab: $tab,
                                     onFit: fitAgentPanel, onAskSelection: askAboutSelection))
        .modifier(CodeBrowserObservers(tab: $tab) { setDiffCollapsed(false, remember: false) })   // MARK: code-browser (§47)
        .onChange(of: model.toggleAgentPanelTick) { _, _ in
            if !tab.showsReview { tab = .changes; showAgentPanel = true } else { showAgentPanel.toggle() }
        }
        .alert("Switch project?", isPresented: Binding(get: { pendingSwitch != nil }, set: { if !$0 { pendingSwitch = nil } }),
               presenting: pendingSwitch) { url in
            Button("Switch") { Task { await store.switchProject(to: url) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            // §8 / §31.5: a pending review is saved and restored on reopen (only an accepted-only one is cleaned up).
            Text("\(store.pendingFiles.count) files pending review. The review is saved and comes back when you reopen this project; the files stay on disk as they are.")
        }
        .sheet(isPresented: $showGitInit, onDismiss: { if store.needsGitInit { store.cancelGitInit() } }) {
            gitInitSheet
        }
    }

    // MARK: Agent panel room

    /// Below this window width the sidebar, the diff + chat minimums and the agent panel cannot all fit.
    private static let agentPanelRoomWidth: CGFloat = 1320

    /// With the agent panel open in a narrow window the sidebar steps aside (the toolbar button brings it back);
    /// it returns once the panel closes or the window is wide enough.
    private func fitAgentPanel() {
        guard windowWidth > 0 else { return }
        let tight = (showAgentPanel || showSidePanel) && tab.showsReview && windowWidth < Self.agentPanelRoomWidth
        if tight, !sidebarHiddenForPanel, columnVisibility != .detailOnly {
            sidebarHiddenForPanel = true
            withAnimation(.easeInOut(duration: 0.2)) { columnVisibility = .detailOnly }
        } else if !tight, sidebarHiddenForPanel {
            sidebarHiddenForPanel = false
            withAnimation(.easeInOut(duration: 0.2)) { columnVisibility = .all }
        }
    }

    // MARK: Side questions (§21)

    /// The inspector column shows the side panel or the agent panel (never both).
    private var inspectorVisible: Binding<Bool> {
        Binding(get: { showAgentPanel || showSidePanel },
                set: { if !$0 { showAgentPanel = false; showSidePanel = false } })
    }

    private func toggleSidePanel() {
        withAnimation(.easeInOut(duration: 0.2)) { showSidePanel.toggle() }
    }

    /// ⌥⌘/: a side question on what is selected — the clicked diff line, else the selected file (current review or
    /// history), else the conversation in general.
    private func askAboutSelection() {
        guard store.projectInfo != nil, store.side.isSupported else { return }
        if tab == .history || store.historySelection != nil, let sel = store.historySelection {
            store.side.compose(anchor: SideAnchor(path: sel.path, entryId: sel.entryId))
            return
        }
        if let path = store.selectedPath {
            if let anchor = store.side.selectionAnchor, anchor.path == path {
                store.side.compose(anchor: anchor)
            } else {
                store.side.compose(anchor: SideAnchor(path: path))
            }
            return
        }
        store.side.compose(anchor: nil)
    }

    // MARK: Refresh (M15)

    /// A project is open, or the PR tab is showing (PR lists need no project).
    private var canRefresh: Bool { (store.projectInfo != nil || tab == .prs) && !store.isRefreshing }

    /// ⌘R / toolbar: `refresh` (everything applicable); on the PR tab only the PR lists.
    private func refresh() {
        guard canRefresh else { return }
        let scope: [RefreshScope]? = tab == .prs ? [.pr] : nil
        Task { await store.refresh(scope: scope) }
    }

    // MARK: Diff pane collapse (M16)

    /// The thin edge tab left of the diff pane; click (or ⌘⇧D) collapses or expands it.
    private var diffEdgeTab: some View {
        Button {
            setDiffCollapsed(!diffCollapsed)
        } label: {
            VStack(spacing: 6) {
                Image(systemName: diffCollapsed ? "chevron.right" : "chevron.left").font(.caption2.weight(.semibold))
                Text("Diff")
                    .font(.caption.weight(.medium))
                    .fixedSize()
                    .rotationEffect(.degrees(-90))
                    .frame(width: 12, height: 36)
                if !store.changedFiles.isEmpty {
                    Text(verbatim: String(store.changedFiles.count))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Color.orange.wash(colorScheme, light: 0.20, dark: 0.28), in: Capsule())
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 10)
            .frame(width: 22)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .background(Color(nsColor: .windowBackgroundColor))
        .help(diffCollapsed ? Text("Show the diff pane (⌘⇧D)") : Text("Hide the diff pane (⌘⇧D)"))
        .accessibilityLabel(diffCollapsed ? Text("Show diff pane") : Text("Hide diff pane"))
        .accessibilityIdentifier("Diff edge tab")
    }

    /// `remember` (explicit toggles only — ⌘⇧D, the edge tab) persists the choice per project; automatic
    /// collapse/expand never does, so the remembered value stays what the user last asked for.
    private func setDiffCollapsed(_ collapsed: Bool, remember: Bool = true) {
        guard collapsed != diffCollapsed else { return }
        withAnimation(.easeInOut(duration: 0.15)) { diffCollapsed = collapsed }
        if remember { updateUIState { $0.diffCollapsed = collapsed } }
    }

    // MARK: Per-project UI state (M15)

    private func restoreUIState(root: String?) {
        guard root != uiStateRoot else { return }
        uiStateRoot = root
        // The sidebar lists' folders, author filter, history search and rounds belonged to the project before.
        model.changesExpandedFolders = []
        model.changesAuthorFilter = nil
        model.historyQuery = ""
        model.historyExpansion = [:]
        guard let root else { diffFraction = 0.5; diffCollapsed = false; return }
        let saved = AppSettings.projectUIState(root: root)
        diffFraction = saved.diffFraction ?? 0.5
        if let raw = saved.sidebarTab, let savedTab = MainTab(rawValue: raw) { tab = savedTab }
        if let path = saved.selectedPath, store.changedFiles.contains(where: { $0.path == path }) { store.selectedPath = path }
        // M16: the remembered choice; without one, collapsed exactly while there is nothing to show.
        diffCollapsed = saved.diffCollapsed ?? (store.changedFiles.isEmpty && store.selectedFile == nil)
    }

    private func updateUIState(_ change: (inout AppSettings.ProjectUIState) -> Void) {
        guard let root = uiStateRoot else { return }
        var state = AppSettings.projectUIState(root: root)
        let before = state
        change(&state)
        if state != before { AppSettings.setProjectUIState(state, root: root) }
    }

    // MARK: Workbenches (docs/M10-WORKBENCHES.md)

    /// M19: the window of ours that already holds the refused worktree's lock — matched by the window registry
    /// first (the path is open in one of our windows) and by the sidecar pid the refusal named second.
    private func ownWindowHoldingLock() -> WorkbenchWindowEntry? {
        guard let lock = store.lockConflict else { return nil }
        let registry = WorkbenchRegistry.shared
        let byPath = store.lockConflictURL.flatMap { registry.entry(for: $0) }
        let entry = byPath ?? registry.entry(enginePID: lock.pid)
        return entry?.store === store ? nil : entry
    }

    private func focusOwnWindowHoldingLock() {
        guard store.lockConflict != nil, let entry = ownWindowHoldingLock() else { return }
        entry.focus()
        store.cancelTakeover()
    }

    private func lockSince(_ lock: LockConflict) -> String {
        guard let date = lock.sinceDate else { return lock.since }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    /// MARK: wave4d w4d-plan — §42.1: a workbench made for the pending plan gets it first (its window implements it when it
    /// opens); a refusal stays on the plan card. Either way the new workbench opens.
    private func workbenchCreated(_ url: URL) {
        // A workbench some window already shows ("Open that workbench") would only take the plan when it is opened again.
        guard let mode = model.newWorkbenchPlanMode, store.pendingPlan != nil, WorkbenchRegistry.shared.entry(for: url) == nil else {
            model.newWorkbenchPlanMode = nil
            openWorkbench(url)
            return
        }
        model.newWorkbenchPlanMode = nil
        Task {
            // A refusal is logged and the plan card stays here (it is still pending).
            _ = await store.handPlanToWorkbench(mode: mode, path: url.path)
            openWorkbench(url)
        }
    }

    /// Opens `url` in its own window, or focuses the window that already has it open.
    private func openWorkbench(_ url: URL) {
        if WorkbenchRegistry.shared.focusWindow(for: url) { return }
        openWindow(id: "workbench", value: url.standardizedFileURL)
    }

    private func removeWorkbench(_ wb: WorkbenchInfo, force: Bool) async {
        // Our own window on that worktree holds its lock: close the project there first (releases the lock),
        // then the window itself once the worktree is gone.
        let ownWindow = WorkbenchRegistry.shared.entry(for: URL(fileURLWithPath: wb.path)).flatMap { $0.store === store ? nil : $0 }
        if let ownWindow, ownWindow.store.projectURL != nil {
            if !force, ownWindow.store.isWorktreeDirty || ownWindow.store.hasPendingReview {
                removeRefusal = workbenchRefusalText("worktree_dirty")
                forceRemoveCandidate = wb
                return
            }
            await ownWindow.store.closeProject()
        }
        if let refusal = await store.removeWorkbench(path: wb.path, force: force) {
            if !force {
                removeRefusal = workbenchRefusalText(refusal)
                forceRemoveCandidate = wb
            }
            return
        }
        ownWindow?.window?.close()
        await store.refreshWorkbenches()
    }

    @ViewBuilder
    private var workbenchSection: some View {
        let current = store.projectURL?.standardizedFileURL.path
        Section("Workbenches") {
            ForEach(store.workbenches.list) { wb in
                let isCurrent = URL(fileURLWithPath: wb.path).standardizedFileURL.path == current
                Menu {
                    Button(isCurrent ? "This window" : "Open in Window") { if !isCurrent { openWorkbench(URL(fileURLWithPath: wb.path)) } }
                        .disabled(isCurrent)
                        .accessibilityIdentifier("Open workbench \(wb.branch ?? wb.path)")
                    Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: wb.path)]) }
                    Divider()
                    Button("Remove Workbench…", role: .destructive) { removeCandidate = wb }
                        .disabled(wb.isMain || isCurrent)
                        .accessibilityIdentifier("Remove workbench \(wb.branch ?? wb.path)")
                    if wb.isMain || isCurrent {   // why it is off, as the branch menu's footer
                        Text(verbatim: workbenchRefusalText(wb.isMain ? "cannot_remove_main" : "cannot_remove_current"))
                    }
                } label: {
                    Text(verbatim: workbenchTitle(wb, isCurrent: isCurrent))
                } primaryAction: {
                    if !isCurrent { openWorkbench(URL(fileURLWithPath: wb.path)) }
                }
                .help(wb.path)
                .accessibilityIdentifier("Workbench \(wb.branch ?? wb.path)")
            }
            if store.workbenches.list.isEmpty {
                Text("No workbenches")
            }
            Button("New Workbench…") { model.showNewWorkbench = true }
                .disabled(store.projectInfo == nil)
                .accessibilityIdentifier("New Workbench…")
            if runAsTaskEnabled {   // §49
                Button("Run as Task…") { model.runAsTask("") }
                    .disabled(store.projectInfo == nil)
                    .accessibilityIdentifier("Run as Task…")
            }
            Button("Prune") { Task { await store.pruneWorkbenches() } }
                .disabled(store.projectInfo == nil)
                .accessibilityIdentifier("Prune workbenches")
        }
    }

    /// `branch · ● (dirty) · in use` — menus cannot render badges, so the row is text.
    private func workbenchTitle(_ wb: WorkbenchInfo, isCurrent: Bool) -> String {
        var parts = [wb.branch ?? String(localized: "detached")]
        if wb.isMain { parts.append(String(localized: "primary")) }
        if isCurrent { parts.append("✓") }
        if wb.dirty == true { parts.append("●") }
        // Locked by an engine that is not one of this app's windows (the lock pid is the sidecar's, one per window).
        if wb.locked != nil, !isCurrent, WorkbenchRegistry.shared.entry(for: URL(fileURLWithPath: wb.path)) == nil {
            parts.append(String(localized: "in use"))
        }
        return parts.joined(separator: " · ")
    }

    private var noProjectSidebar: some View {
        ContentUnavailableView("No project open", systemImage: "folder",
                               description: Text("Open a folder (⌘O) to start a Claude session."))
            .frame(maxHeight: .infinity)
    }

    @ViewBuilder
    private var sidebar: some View {
        if store.projectURL == nil {
            noProjectSidebar
        } else {
            VStack(alignment: .leading, spacing: 0) {
                projectHeader
                Divider()
                ChangedFilesList()
                OtherSessionsSection()   // wave3 mac-session (§36.9): 이 저장소의 다른 Claude 세션
            }
        }
    }

    /// Which repo this session touches: root path, branch and remote, so it is never ambiguous.
    private var projectHeader: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                projectSwitcher
                if !store.isMainWorkbench {
                    Text("workbench")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.accentColor.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
                        .foregroundStyle(Color.accentColor)
                        .help(String(localized: "A git worktree of \(store.repoDisplayName) with its own Claude session"))
                        .accessibilityIdentifier("Workbench badge")
                }
            }
            Text(store.projectInfo?.root ?? store.projectURL?.path ?? "")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                .help(store.projectInfo?.root ?? store.projectURL?.path ?? "")
                .accessibilityIdentifier("Project root")
            // Branch / remote only make sense once the folder is an opened git repository.
            if let info = store.projectInfo {
                HStack(spacing: 6) {
                    branchSwitcher(info)
                    if let remote = info.remoteURL {
                        Label(remote, systemImage: "cloud")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                            .help(remote)
                            .accessibilityIdentifier("Project remote")
                    } else {
                        Label("no remote", systemImage: "cloud.slash")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("Project remote")
                    }
                }
            }
            if let model = store.model {
                Text(model).font(.caption2).foregroundStyle(.secondary)
            }
            if let pr = store.lastCreatedPR, dismissedPRURL != pr.url {
                createdPRBanner(pr)
            }
        }
        .padding(12)
        .task(id: store.projectInfo?.root) {
            if store.projectInfo != nil {
                await store.refreshBranches()
                await store.refreshWorkbenches()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { note in
            // Another window may have created / removed a workbench: refresh the list when this one comes back.
            guard let window = note.object as? NSWindow, WorkbenchRegistry.shared.entry(for: store)?.window === window,
                  store.projectInfo != nil else { return }
            Task { await store.refreshWorkbenches() }
        }
        .sheet(isPresented: $showNewBranch) { newBranchSheet }
    }

    /// `state.pr.lastCreatedPR` after "Create PR from this branch…": the URL plus Open / dismiss.
    private func createdPRBanner(_ pr: CreatedPR) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.pull").foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 1) {
                Text("PR created").font(.caption.weight(.medium))
                Text(verbatim: pr.url).font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 4)
            Button("Open") { if let url = URL(string: pr.url) { NSWorkspace.shared.open(url) } }
                .controlSize(.small)
                .accessibilityIdentifier("Open PR")
            Button { dismissedPRURL = pr.url } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .controlSize(.small)
                .accessibilityLabel("Dismiss")
                .accessibilityIdentifier("Dismiss PR banner")
        }
        .padding(8)
        .background(Color.green.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 8))
        .padding(.top, 4)
        .accessibilityIdentifier("PR created banner")
    }

    // MARK: Error banner (audit 4.2)

    /// Non-modal: the last engine `error` event — its style, words, actions and log menu (`SessionErrorBanner`, PROTOCOL §30).
    private func errorBanner(_ banner: ErrorBanner) -> some View {
        SessionErrorBanner(banner: banner)
    }

    /// The force-reject alert's body: the files whose own edits would be lost.
    private func forceRejectMessage(_ request: ForceRejectRequest) -> String {
        let shown = request.paths.prefix(8).joined(separator: "\n")
        let more = request.paths.count > 8 ? "\n" + String(localized: "…and \(request.paths.count - 8) more") : ""
        return String(localized: "You edited these files after the review. Reverting restores the content from before Claude's turn and discards your edits:") + "\n\n" + shown + more
    }

    // MARK: Extensions fallback banner (docs/PROTOCOL.md §16)

    /// The CLI did not initialize with the user's settings in time: the session runs without plugins / MCP servers /
    /// hooks until the project is reopened. Retry reopens it; "Extensions…" shows what was applied (and lets the user
    /// turn the hanging plugin off).
    private func extensionsFallbackBanner(_ fallback: ExtensionsFallback) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "puzzlepiece.extension.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Extensions took longer than \(fallback.timeoutSeconds) s to load, so the session started without them")
                    .font(.callout.weight(.medium))
                    .lineLimit(2)
                    .accessibilityIdentifier("Extensions fallback text")
                Text("Plugins, MCP servers and hooks from ~/.claude are off for this project until you retry. A slow VPN or plugin marketplace is the usual cause — check the network, or turn off the plugin that hangs.")
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Button("Retry with extensions") { Task { await store.retryWithExtensions() } }
                .controlSize(.small)
                .disabled(store.isRunning)
                .help("Restart the session and load your user settings again (the review list and the chat are kept)")   // §36.7 retry_extensions
                .accessibilityIdentifier("Retry with extensions")
            Button("Extensions…") { showExtensions = true }
                .controlSize(.small)
                .accessibilityIdentifier("Show extensions")
            Button {
                store.dismissExtensionsFallback()
                store.sessionTools.silenceFallbackBanner()   // wave3 mac-session (§36.7): the HUD chip stays
            } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .controlSize(.small)
                .accessibilityLabel("Dismiss")
                .accessibilityIdentifier("Dismiss extensions fallback")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Extensions fallback banner")
    }

    // MARK: Commit banner (docs/M12-COMMIT.md)

    /// `state.commit.lastCommit`: green "Committed <sha> on <branch> · Pushed/Not pushed" with "Create PR…" and, when
    /// pushed to a GitHub remote, "Open"; red with "Push now" when the push failed.
    private func commitBanner(_ commit: LastCommit) -> some View {
        let failed = commit.pushError != nil
        let webURL = commit.pushed ? commitWebURL(remote: store.projectInfo?.remoteURL, sha: commit.sha, ghHost: store.pr.host) : nil
        return HStack(spacing: 8) {
            Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                .foregroundStyle(failed ? Color.red : Color.green)
            VStack(alignment: .leading, spacing: 1) {
                Text("Committed \(commit.shortSha) on \(commit.branch) · \(commit.pushed ? String(localized: "Pushed") : String(localized: "Not pushed"))")
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                    .accessibilityIdentifier("Commit banner text")
                if let pushError = commit.pushError {
                    Text(verbatim: commitRefusalText(pushError))
                        .font(.caption).foregroundStyle(.red)
                        .lineLimit(2).textSelection(.enabled)
                        .accessibilityIdentifier("Commit push error")
                } else {
                    Text(verbatim: commit.message.split(whereSeparator: \.isNewline).first.map(String.init) ?? "")
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            Spacer(minLength: 4)
            if pushing { ProgressView().controlSize(.small) }
            if failed {
                Button("Push now") {
                    pushing = true
                    Task { await store.pushNow(); pushing = false }
                }
                .controlSize(.small)
                .disabled(pushing)
                .accessibilityIdentifier("Push now")
            }
            Button("Create PR…") { showCreatePR = true }
                .controlSize(.small)
                .disabled(store.isRunning || store.projectInfo?.branch == nil)
                .accessibilityIdentifier("Create PR from commit")
            if let webURL {
                Button("Open") { NSWorkspace.shared.open(webURL) }
                    .controlSize(.small)
                    .help(webURL.absoluteString)
                    .accessibilityIdentifier("Open commit")
            }
            Button { dismissedCommitSha = commit.sha } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .controlSize(.small)
                .accessibilityLabel("Dismiss")
                .accessibilityIdentifier("Dismiss commit banner")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background((failed ? Color.red : Color.green).wash(colorScheme, light: 0.10, dark: 0.18))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(failed ? "Commit push failed banner" : "Commit banner")
    }

    // MARK: Branch switcher

    /// The branch chip is a menu: current branch ✓, other local branches (with ↑ahead ↓behind),
    /// "New Branch…" and "Refresh". Switching is disabled — with the reason as a footer — while a
    /// review is pending, the worktree is dirty, or Claude is working.
    private func branchSwitcher(_ info: ProjectInfo) -> some View {
        let blocker = store.branchSwitchBlocker()
        return Menu {
            ForEach(store.branches) { branch in
                Button {
                    if !branch.isCurrent { Task { await store.switchBranch(branch.name) } }
                } label: {
                    if branch.isCurrent {
                        Label(branch.name, systemImage: "checkmark")
                    } else {
                        Text(verbatim: branchTitle(branch))
                    }
                }
                .disabled(branch.isCurrent || blocker != nil)
                .accessibilityIdentifier("Branch \(branch.name)")
            }
            if store.branches.isEmpty {
                Text("No branches")
            }
            Divider()
            Button("New Branch…") { newBranchName = ""; showNewBranch = true }
                .disabled(blocker != nil)
                .accessibilityIdentifier("New Branch…")
            Button("Refresh") { Task { await store.refreshBranches() } }
                .accessibilityIdentifier("Refresh branches")
            Divider()
            Button("Create PR from this branch…") { showCreatePR = true }
                .disabled(store.hasPendingReview || store.isWorktreeDirty || store.isRunning || info.branch == nil)
                .help(String(localized: "Push this branch and open a pull request (gh pr create)"))
                .accessibilityIdentifier("Create PR from this branch…")
            if let blocker {
                Divider()
                Text(verbatim: blockerReason(blocker))
            }
        } label: {
            HStack(spacing: 4) {
                Label {
                    if let branch = info.branch { Text(branch) } else { Text("detached") }
                } icon: {
                    Image(systemName: "arrow.triangle.branch")
                }
                .font(.caption.monospaced())
                .lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(blocker.map(blockerReason) ?? String(localized: "Switch branch"))
        .accessibilityLabel("Branch switcher")
        .accessibilityIdentifier("Branch switcher")
    }

    private func branchTitle(_ branch: BranchInfo) -> String {
        var parts = [branch.name]
        if branch.ahead > 0 { parts.append("↑\(branch.ahead)") }
        if branch.behind > 0 { parts.append("↓\(branch.behind)") }
        return parts.joined(separator: "  ")
    }

    private func blockerReason(_ blocker: BranchSwitchBlocker) -> String {
        switch blocker {
        case .pendingReview(let n): String(localized: "Review \(n) pending files first")
        case .dirtyWorktree: String(localized: "Working tree has uncommitted changes")
        case .running: String(localized: "Claude is working")
        }
    }

    /// Client-side mirror of `git check-ref-format --branch`, so the hint updates as the user types.
    private var newBranchHint: String? { branchNameHint(newBranchName, existing: store.branches) }

    private var newBranchSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New Branch").font(.headline)
            TextField("Branch name", text: $newBranchName)
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .accessibilityIdentifier("New branch name")
                .onSubmit { createBranch() }
            if let hint = newBranchHint {
                Text(hint).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("New branch hint")
            } else {
                Text("Branches from \(store.projectInfo?.branch ?? "HEAD") and checks it out.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { showNewBranch = false }
                    .keyboardShortcut(.cancelAction)
                Button("Create branch") { createBranch() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(newBranchHint != nil)
                    .accessibilityIdentifier("Create branch")
            }
        }
        .padding(20)
        .frame(width: 400)
    }

    private func createBranch() {
        guard newBranchHint == nil else { return }
        let name = newBranchName.trimmingCharacters(in: .whitespaces)
        showNewBranch = false
        Task { await store.createBranch(name) }
    }

    /// The project name doubles as a switcher: recent projects, plus open / reveal / close.
    private var projectSwitcher: some View {
        let current = store.projectURL?.standardizedFileURL
        let recentEntries = { _ = recentsTick; return RecentProjects.entries() }()   // MARK: wave4 w4-install (daily-17): no scratch folders; gone ones apart
        let recents = recentEntries.filter(\.exists).map(\.url)
        return Menu {
            ForEach(recents, id: \.self) { url in
                let isCurrent = url.standardizedFileURL == current
                Button {
                    // M19: ⌥-click opens the row in its own window instead of switching this one.
                    if ProjectOpener.optionKeyDown {
                        ProjectOpener.openInNewWindow(url, openWindow: openWindow)
                    } else if !isCurrent {
                        ProjectOpener.requestSwitch(to: url, store: store, pending: $pendingSwitch)
                    }
                } label: {
                    if isCurrent {
                        Label(url.lastPathComponent, systemImage: "checkmark")
                    } else {
                        Text(url.lastPathComponent)
                    }
                }
                .help(url.path)
                .disabled(isCurrent && !ProjectOpener.optionKeyDown)
            }
            // MARK: wave4 w4-install (daily-17): a folder that is gone — a submenu that says so and removes it; or all of them.
            ForEach(recentEntries.filter { !$0.exists }, id: \.url) { MissingRecentMenu(url: $0.url) { recentsTick += 1 } }
            if recentEntries.contains(where: { !$0.exists }) {
                Button("Remove Missing from List") {
                    RecentProjects.removeMissing()
                    recentsTick += 1
                }
                .accessibilityIdentifier("Remove missing recents")
            }
            if recentEntries.isEmpty {
                Text("No recent projects")
            }
            if !recents.isEmpty {
                // M19: the same rows, each in a window of its own (⌥-click above does the same thing).
                Menu("Open in New Window") {
                    ForEach(recents, id: \.self) { url in
                        Button(url.lastPathComponent) { ProjectOpener.openInNewWindow(url, openWindow: openWindow) }
                            .help(url.path)
                            .accessibilityIdentifier("Open in New Window \(url.lastPathComponent)")
                    }
                }
            }
            Divider()
            workbenchSection
            Divider()
            PeerInboundProjectMenu()   // wave1 mac-session (§29)
            Divider()
            Button("Open Project…") { ProjectOpener.choose(store: store) }
                .keyboardShortcut("o", modifiers: .command)
            Button("Open in New Window…") { ProjectOpener.chooseForNewWindow(openWindow: openWindow) }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .accessibilityIdentifier("Open in New Window")
            Button("Reveal in Finder") {
                if let url = store.projectURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            }
            Button("Close Project") { Task { await store.closeProject() } }
        } label: {
            HStack(spacing: 4) {
                Text(store.repoDisplayName).font(.headline)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Switch project (⌘⇧O)")
        .accessibilityLabel("Project switcher")
        .accessibilityIdentifier("Project switcher")
    }

    // MARK: Not a git repository

    private var gitInitSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("This folder is not a git repository", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(store.projectURL?.path ?? "")
                .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            Text("ReviewGate uses git snapshots to show and revert each turn's changes, so it needs a repository to work in.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)

            if !store.gitCandidates.isEmpty {
                Text("Git repositories inside this folder:").font(.subheadline.weight(.medium))
                List(store.gitCandidates, id: \.self) { url in
                    Button {
                        ProjectOpener.open(url, store: store)
                    } label: {
                        Label(url.lastPathComponent, systemImage: "folder.badge.gearshape")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(url.path)
                    .accessibilityIdentifier("Git candidate \(url.lastPathComponent)")
                }
                .listStyle(.bordered)
                .frame(minHeight: 120, maxHeight: 240)
                .accessibilityIdentifier("Git candidates")
            }

            HStack {
                Button("Initialize git here", role: .destructive) {
                    if store.gitInitLooksUnsafe {
                        confirmUnsafeInit = true
                    } else {
                        Task { await store.initRepository() }
                    }
                }
                .accessibilityIdentifier("Initialize git")
                Spacer()
                Button("Choose another folder…") {
                    store.cancelGitInit()
                    ProjectOpener.choose(store: store)
                }
                .accessibilityIdentifier("Choose another folder")
                Button("Cancel", role: .cancel) { store.cancelGitInit() }
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 480)
        .alert("Initialize git in this folder?", isPresented: $confirmUnsafeInit) {
            Button("Initialize anyway", role: .destructive) { Task { await store.initRepository() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This looks like a large or personal folder (\(store.projectURL?.path ?? "")). Initializing git here is probably a mistake.")
        }
    }
}

/// Detail-pane empty state: a prominent Open button plus the recent-projects list.
/// The inspector column's bookkeeping, split out of `MainWindow.splitView` (one long modifier chain is too much for the
/// type checker): the side panel and the agent panel replace each other, entry points bring the side panel forward.
private struct InspectorObservers: ViewModifier {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Binding var showAgentPanel: Bool
    @Binding var showSidePanel: Bool
    @Binding var tab: MainTab
    let onFit: () -> Void
    let onAskSelection: () -> Void

    func body(content: Content) -> some View {
        content
            .onChange(of: showAgentPanel) { _, on in
                if on { showSidePanel = false }
                onFit()
            }
            .onChange(of: showSidePanel) { _, on in
                if on { showAgentPanel = false; store.side.panelOpened() }
                onFit()
            }
            // §21: an entry point ("Why?", a badge, ⌥⌘/) asked for the side panel.
            .onChange(of: store.side.presentTick) { _, _ in
                if !tab.showsReview { tab = .changes }
                if !showSidePanel { withAnimation(.easeInOut(duration: 0.2)) { showSidePanel = true } }
            }
            .onChange(of: model.toggleSidePanelTick) { _, _ in
                if !tab.showsReview { tab = .changes; showSidePanel = true } else {
                    withAnimation(.easeInOut(duration: 0.2)) { showSidePanel.toggle() }
                }
            }
            .onChange(of: model.askSelectionTick) { _, _ in onAskSelection() }
    }
}

private struct EmptyProjectView: View {
    @Environment(AppState.self) private var store

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "folder").font(.system(size: 44)).foregroundStyle(.secondary)
            Text("Open a project to start").font(.title2.weight(.semibold))
            Text("ReviewGate runs Claude in a folder and gates every change behind your review.")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Open Project…", systemImage: "folder.badge.plus") { ProjectOpener.choose(store: store) }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("Open Project…")

            RecentProjectsList()   // MARK: wave4 w4-install (daily-17): a missing folder dimmed with "Not found", every row removable
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
