import SwiftUI
import AppKit
import ReviewGateCore

/// `WindowModel.diffJump`: the file to show in the review diff and the line (a new line number) to scroll to. `tick` is new
/// for every link, so the same link again is a new request.
struct DiffJump: Equatable {
    let path: String
    let line: Int?
    let tick: Int
}

/// Per-window view state that the menu bar needs to reach (`FocusedValues.workbenchWindow`).
@MainActor
@Observable
final class WindowModel {
    var tab: MainTab = .changes
    // M13: sheets / dialogs the Review and Workbenches menus open (the views bind to these).
    /// Accept-all summary sheet (audit 1.9).
    var showAcceptAll = false
    /// Reject-all confirmation.
    var showRejectAll = false
    /// Commit accepted sheet (M12).
    var showCommit = false
    /// New Workbench sheet (M10).
    var showNewWorkbench = false
    /// The chat pane's sidecar-log disclosure; the error banner's "Show log" opens it (audit 4.2).
    var showSidecarLog = false
    /// Bumped by ⌘⇧C: the chat pane focuses its composer, or sends the notes when there are any (audit 1.11).
    var requestChangesTick = 0
    /// M16: bumped by ⌘⇧D (View → Toggle Diff Pane); `MainWindow` collapses / expands the diff pane.
    var toggleDiffTick = 0
    /// Bumped by View → Toggle Agent Panel (⌥⌘A); `MainWindow` flips the remembered inspector state.
    var toggleAgentPanelTick = 0
    /// "Why it changed" → transcript: the tool_use row the chat scrolls to (and flashes); set with `revealTick` bumped.
    var revealToolUseId: String?
    var revealTick = 0
    /// Bumped by ⌘F (Edit → Find in Chat); the chat opens / focuses its find bar.
    var findTick = 0
    /// §21: View → Toggle Side Questions (⌥⌘S).
    var toggleSidePanelTick = 0
    /// §21: Review → Ask About Selection (⌥⌘/).
    var askSelectionTick = 0
    /// §23: the changed-files list's "Mention in Chat" — the chat adds `mentionPaths` to its composer on `mentionTick`.
    var mentionPaths: [String] = []
    var mentionTick = 0
    // MARK: wave1 mac-perms
    /// "카드로 이동" (agent panel, timeline, HUD): the permission card the chat scrolls to and highlights.
    var revealPermissionRequestId: String?
    var revealPermissionTick = 0
    // MARK: wave1 mac-review
    /// §31.5: the "Finish review" confirmation (the Changes header button, Review → Finish Review…).
    var showFinishReview = false
    // MARK: wave1 mac-session
    /// §33.4: the branch the New Workbench sheet starts with (a blocked EnterWorktree's name); nil = empty.
    var newWorkbenchBranch: String?
    // MARK: wave4d w4d-plan
    /// §42.1 [새 워크벤치에서 구현]: the New Workbench sheet hands the pending plan to the workbench it creates (in this mode).
    var newWorkbenchPlanMode: PermissionMode?
    /// §30: bumped to open the chat history with `highlightChatId` marked (the resume notice's "이전 대화 보기").
    var showChatHistoryTick = 0
    var highlightChatId: String?
    // MARK: wave2 mac-diff
    /// Bumped by ⌥⌘F (Edit → Find in Diff): the diff / full-file / history / PR diff list in front opens its find bar.
    var diffFindTick = 0
    /// A chat link to a file under review (`ChatLinkOpener`, "Show diff"): the diff pane opens — also for the file already
    /// selected with the pane collapsed, which `selectedPath` never says — and the diff scrolls to `line` and marks it.
    /// `DiffView` takes it (back to nil) once its diff is there.
    var diffJump: DiffJump?
    private var diffJumpTick = 0

    func showReviewDiff(path: String, line: Int?) {
        diffJumpTick += 1
        diffJump = DiffJump(path: path, line: line, tick: diffJumpTick)
    }
    // The sidebar tabs rebuild their list when shown again: what the user opened there lives here, per window (`MainWindow`
    // empties it for another project).
    /// §39.1: the bulk Changes list's opened folders; agents-13: the author it shows (nil: all).
    var changesExpandedFolders: Set<String> = []
    var changesAuthorFilter: String?
    /// §38.3: the History tab's search, and the rounds the user opened / closed.
    var historyQuery = ""
    var historyExpansion: [String: Bool] = [:]
    // MARK: wave3 mac-agents
    /// §36.1: the subagent whose "Agent details" sheet is open (its Agent tool_use id); nil = closed.
    var agentDetail: AgentDetailRequest?
    // MARK: wave4 w4-input
    /// polish-06: Chat → the tab at ⌘1…⌘9; the tab strip opens it (a record-only chat asks first) and clears it.
    var chatTabRequest: String?
    // MARK: wave4b w4-notify
    /// A clicked notification's card / summary: the chat scrolls there on `notificationRevealTick` (or when it appears)
    /// and clears it (`openFromNotification`).
    var notificationReveal: AttentionTarget?
    var notificationRevealTick = 0

    /// §36.1: opens the "Agent details" sheet (`report`: scrolled to the report — "View full report").
    func showAgentDetails(toolUseId: String, report: Bool = false) {
        agentDetail = AgentDetailRequest(toolUseId: toolUseId, focusReport: report)
    }

    /// Puts `text` into the chat's composer (after what is typed there) and focuses it — never sent by itself. One way in
    /// for every view ("Send to main chat" §36.1, "Send to Claude" on PR comments §36.14): the chat takes `composerDraft`
    /// on `composerDraftTick`, or when it appears.
    func insertIntoComposer(_ text: String) {
        guard !text.isEmpty else { return }
        composerDraft = composerDraft.map { $0 + "\n\n" + text } ?? text
        composerDraftTick &+= 1
    }
    // MARK: wave3 mac-session
    /// §36.9: the "Import a CLI session" sheet (the sidebar's other-sessions section, the chat tabs' menu).
    var showCliImport = false
    // MARK: wave3 mac-flow
    /// §36.14: the PR the New Workbench sheet checks out ("Open as workbench"); the sheet clears it when it closes.
    var newWorkbenchFromPr: PRWorkbenchRequest?
    // MARK: §49 Run as Task
    /// The New Workbench sheet runs as "Run as Task" with this text (the composer's draft, "" from the menu); nil = a plain
    /// workbench. The sheet clears it when it closes.
    var newWorkbenchTask: String?
    /// A task taken from the composer started in its workbench: the composer empties its draft if it still holds that text.
    var startedTaskText: String?
    var startedTaskTick = 0

    /// §49: opens the New Workbench sheet as "Run as Task" with `text`.
    func runAsTask(_ text: String) {
        newWorkbenchTask = text
        showNewWorkbench = true
    }
    /// Text for the composer (`insertIntoComposer`: PR comments §36.14, an agent's report §36.1) — the chat takes it on
    /// `composerDraftTick`, or when it appears (the PR tab has no chat).
    var composerDraft: String?
    var composerDraftTick = 0
    // MARK: r1-composer M12
    /// The chat column's composer and transcript state, kept by the window (§38.1): the chat is made again when it comes
    /// back from the PRs tab or after an engine that stopped, and what is typed (with its mentions and images), the
    /// question card's picks, a deny instruction, the plan card's notes and the folds are still there. PR comments sent
    /// to Claude join the draft kept here.
    let chatComposer = ComposerModel()
    let chatTranscript = TranscriptViewState()
    // MARK: polish p-foundation — seeds the polish lanes fill in (types and helpers: App/UI/Common/WindowSeeds.swift)
    /// P2-review-19: Review › "메모 추가…" (⌥⌘N) asks the diff for the composer; the diff says whether it can open one now.
    var addNoteTick = 0
    var canAddNote = false
    /// P2-review-20: Review › "다음 변경" / "이전 변경" (⌥⌘] / ⌥⌘[) — the diff scrolls to the next / previous hunk.
    var nextChangeTick = 0
    var previousChangeTick = 0
    /// P3-transcript-17: View › "최신 메시지로 이동" (⌥⌘↓), Edit › "다음 찾기" / "이전 찾기" (⌘G / ⇧⌘G), and a page of the
    /// chat up / down from the message box (PageUp / PageDown).
    var jumpToLatestTick = 0
    var transcriptFindNextTick = 0
    var transcriptFindPreviousTick = 0
    var transcriptPageUpTick = 0
    var transcriptPageDownTick = 0
    /// P2-review-09: focus the History tab's search field.
    var historySearchFocusTick = 0
    /// r2-review-flow — polish P5-sheets-46: Review › "이 브랜치로 PR 만들기…" (⌥⌘K) opens the window's PR sheet.
    var createPRTick = 0
    // MARK: r2-chats-cards — polish P4-composer-05 / PX-19 (the Chat menu)
    /// Chat › "커맨드…" (⌘/): the composer takes the focus and opens (or closes) its command palette.
    var commandsTick = 0
    /// Chat › "채팅 이름 바꾸기…": the tab strip asks for a new title of the chat on screen.
    var renameChatTick = 0
    /// Chat › "이미지 첨부…": the composer opens its image picker.
    var attachImagesTick = 0
    /// PX-19: chats whose tabs were closed in this window, the latest last — Chat › "닫은 채팅 탭 다시 열기" (⌘⇧T).
    var closedChatTabs: [String] = []
    /// P2-review-09: where the user last clicked — ⌘F finds in the diff after a click in it. Read when a command runs; not
    /// observed (a click must not redraw anything).
    @ObservationIgnored var lastFocusArea: WindowFocusArea = .other
    /// P2-review-21: the review notes being written, per file — kept while the diff is gone (another tab, the full file).
    /// A plain reference: typing must not redraw the diff.
    let noteDrafts = NoteDrafts()
    /// P2-review-22: where the diff of each file was scrolled to (path → the row key the list scrolls by). Not observed.
    @ObservationIgnored var diffScrollAnchor: [String: String] = [:]
    /// PX-20: where each chat was read (chat id → anchor), to come back there. Not observed.
    @ObservationIgnored var chatScrollAnchors: [String: ChatScrollAnchor] = [:]
    /// P5-sheets-09: the commit sheet's split cards, kept when the sheet closes; reused when it opens on the same files
    /// (`CommitSplitSession.paths`), dropped after the commits are made. Not observed.
    @ObservationIgnored var commitSplitStash: CommitSplitSession?
    /// P1-chrome-01 / P2-review-21: what closing this window would lose, by key — each says its line for the close / quit
    /// confirmation, or nil when there is nothing now. Register with `.registersUnsavedWork(_:line:)`. Not observed.
    @ObservationIgnored private(set) var unsavedWork: [String: @MainActor () -> String?] = [:]

    func registerUnsavedWork(_ key: String, line: @escaping @MainActor () -> String?) { unsavedWork[key] = line }
    func unregisterUnsavedWork(_ key: String) { unsavedWork[key] = nil }

    /// The lines of what closing would lose now, in key order.
    var unsavedWorkLines: [String] { unsavedWork.keys.sorted().compactMap { unsavedWork[$0]?() } }
    #if DEBUG
    /// r1-composer M11: the composer's send button in the window (SwiftUI's global space) — the layout check
    /// (App/Debug/ScreenshotTour.swift) says when it is cut off. Not observed.
    @ObservationIgnored var debugSendFrame: CGRect = .zero
    /// r1-composer: the cards above the composer — `width` the height they are shown at, `height` the height they need.
    @ObservationIgnored var debugCardsHeights: CGSize = .zero
    /// composer: the slash palette in the window (SwiftUI's global space; `.zero` while it is closed) and its rows.
    @ObservationIgnored var debugPaletteFrame: CGRect = .zero
    @ObservationIgnored var debugPaletteRows: [String] = []
    /// composer: the queue bar above the box (`.zero` while it is not shown).
    @ObservationIgnored var debugQueueBarFrame: CGRect = .zero
    /// §50.3: the queue bar's tools by name (`steer.edit`, `steer.takeBack`, `queued.edit`, `queued.remove`; `.zero` when gone).
    @ObservationIgnored var debugQueueTools: [String: CGRect] = [:]
    #endif

    func reveal(toolUseId: String) {
        revealToolUseId = toolUseId
        revealTick += 1
    }

    /// wave1 mac-perms: scrolls the chat to the card of `requestId`.
    func revealPermission(requestId: String) {
        revealPermissionRequestId = requestId
        revealPermissionTick += 1
    }
}

/// One entry per open workbench window: its `AppState` (own engine process) and, once attached, its `NSWindow`.
@MainActor
final class WorkbenchWindowEntry {
    let store: AppState
    let model: WindowModel
    weak var window: NSWindow?
    /// M19: the project whose frame is currently being tracked; `rememberFrame` writes under this root.
    var frameRoot: String?
    // MARK: wave4 w4-safety
    /// daily-12: the close guard in front of the window's delegate (the window holds its delegate weakly).
    var closeGuard: NSWindowDelegate?

    init(store: AppState, model: WindowModel) {
        self.store = store
        self.model = model
    }

    /// Brings this window to the front (and the app with it).
    @discardableResult
    func focus() -> Bool {
        guard let window else { return false }
        if window.isMiniaturized { window.deminiaturize(nil) }   // wave4b w4-notify: from the Dock, too
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    // MARK: polish p-lifecycle (P1-chrome-01)
    /// What closing this window now would stop, lose and leave (Core `QuitReason`), with the lines its parts registered.
    var quitState: WindowQuitState {
        let composer = model.chatComposer
        let typed = !composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return WindowQuitState(name: store.quitDisplayName,
                               reasons: store.quitReasons(draft: typed, draftImages: composer.images.count),
                               unsavedLines: model.unsavedWorkLines)
    }

    /// M19: `openWindows` / `ProjectUIState.frame` entry for this window, nil while it has no project.
    var openWindowState: AppSettings.OpenWindowState? {
        guard let url = store.projectURL else { return nil }
        return AppSettings.OpenWindowState(path: AppSettings.projectKey(url),
                                           frame: window.map { NSStringFromRect($0.frame) })
    }

    /// M19 (spec 3): restores the frame `root` was last seen at, clamped to the screen it lands on.
    /// `preferred` (the `openWindows` snapshot taken at quit) wins over the per-project frame when given.
    func applySavedFrame(root: String, preferred: String? = nil) {
        frameRoot = root
        // The quit snapshot wins over the stored per-project frame and replaces it, so re-applying later agrees.
        var stored = AppSettings.projectUIState(root: root)
        if let preferred, stored.frame != preferred {
            stored.frame = preferred
            AppSettings.setProjectUIState(stored, root: root)
        }
        guard let window, let saved = preferred ?? stored.frame else { return }
        let rect = NSRectFromString(saved)
        guard rect.width > 0, rect.height > 0 else { return }
        window.setFrame(WorkbenchRegistry.clamp(rect, to: window), display: true)
    }

    /// Stores the current frame under the open project (move / resize / quit).
    func rememberFrame() {
        guard let window, let root = frameRoot else { return }
        var state = AppSettings.projectUIState(root: root)
        let frame = NSStringFromRect(window.frame)
        guard state.frame != frame else { return }
        state.frame = frame
        AppSettings.setProjectUIState(state, root: root)
    }
}

/// Every open workbench window (docs/M10-WORKBENCHES.md): lets the switcher focus an existing window instead of
/// opening the same worktree twice, gives the Settings scene and the menu bar a store to talk to, and lets
/// `AppDelegate` stop every engine on Quit.
@MainActor
@Observable
final class WorkbenchRegistry {
    static let shared = WorkbenchRegistry()

    private(set) var entries: [WorkbenchWindowEntry] = []
    /// The window that most recently became key.
    private(set) var focused: WorkbenchWindowEntry?
    /// `REVIEWGATE_PROJECT` is consumed by the first window only.
    var environmentProjectConsumed = false
    /// M19: the launch restore runs once, in whichever window comes up first.
    var restoreAttempted = false
    /// M19: set by `AppDelegate` once the window list has been persisted, so the windows closing during
    /// Quit do not overwrite it with a shorter list.
    var isTerminating = false
    private var fallbackStore: AppState?

    var stores: [AppState] { entries.map(\.store) }

    func register(_ entry: WorkbenchWindowEntry) {
        guard !entries.contains(where: { $0 === entry }) else { return }
        entries.append(entry)
        if focused == nil { focused = entry }
    }

    func unregister(_ entry: WorkbenchWindowEntry) {
        entries.removeAll { $0 === entry }
        if focused === entry { focused = entries.last }
    }

    func setFocused(_ entry: WorkbenchWindowEntry) { focused = entry }

    /// The window whose store has `url` open (standardized path), if any.
    func entry(for url: URL) -> WorkbenchWindowEntry? {
        let path = AppSettings.projectKey(url)
        return entries.first { $0.store.projectURL.map(AppSettings.projectKey) == path }
    }

    func entry(for store: AppState) -> WorkbenchWindowEntry? { entries.first { $0.store === store } }

    /// M19: the window whose sidecar process is `pid` — the owner named by a `locked_by_other_session:<pid>`
    /// refusal when the lock is held by one of our own windows rather than a foreign session.
    func entry(enginePID pid: Int) -> WorkbenchWindowEntry? {
        guard pid > 0 else { return nil }
        return entries.first { $0.store.enginePID.map(Int.init) == pid }
    }

    /// Brings the window showing `url` to the front; false when no window has it open.
    @discardableResult
    func focusWindow(for url: URL) -> Bool {
        guard let entry = entry(for: url) else { return false }
        let window = entry.window ?? NSApp.windows.first { $0.title == entry.store.windowTitle && $0.isVisible }
        guard let window else { return false }
        if window.isMiniaturized { window.deminiaturize(nil) }   // wave4b w4-notify: a notification's window may sit in the Dock
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    // MARK: - Session restore (docs/M19-MULTIPROJECT.md)

    /// Writes the current window list to `AppSettings.openWindows` — called whenever a window opens a project,
    /// changes project or closes, and once more from `applicationShouldTerminate` before the engines are disposed.
    func persistOpenWindows() {
        // polish P1-chrome-02 / P5-sheets-52: the last window going away keeps the list it was in (a window that closed its
        // project but stays still writes the empty list — the user closed it on purpose). Core `OpenWindowList`.
        guard let list = OpenWindowList.toWrite(entries.map(\.openWindowState), terminating: isTerminating) else { return }
        AppSettings.setOpenWindows(list)
    }

    /// Quit path: persist first, then freeze the list so the closing windows cannot shrink it.
    func persistOpenWindowsForTermination() {
        for entry in entries { entry.rememberFrame() }
        AppSettings.setOpenWindows(entries.compactMap(\.openWindowState))
        isTerminating = true
    }

    // MARK: polish p-lifecycle (P1-chrome-01)
    /// The quit question over every window (nil: quit without asking) — ⌘Q / the Dock, or the last window's close.
    func quitPrompt(kind: QuitPrompt.Kind) -> QuitPrompt? {
        let projects = entries.filter { $0.store.projectURL != nil }.count
        return QuitPrompt.make(entries.map(\.quitState), kind: kind, confirmQuit: AppSettings.confirmQuit(),
                               confirmWhileWorking: AppSettings.confirmCloseWhileWorking(),
                               reopenCount: AppSettings.reopenLastProjects() ? min(projects, AppSettings.maxRestoredWindows) : nil)
    }

    /// Keeps a restored frame on screen: shrunk to the visible frame of the screen it overlaps most and
    /// nudged back inside it.
    static func clamp(_ frame: NSRect, to window: NSWindow?) -> NSRect {
        let screen = NSScreen.screens.max { a, b in
            a.frame.intersection(frame).areaOrZero < b.frame.intersection(frame).areaOrZero
        }
        guard let visible = (screen ?? window?.screen ?? NSScreen.main)?.visibleFrame else { return frame }
        var rect = frame
        rect.size.width = min(rect.width, visible.width)
        rect.size.height = min(rect.height, visible.height)
        rect.origin.x = min(max(rect.minX, visible.minX), visible.maxX - rect.width)
        rect.origin.y = min(max(rect.minY, visible.minY), visible.maxY - rect.height)
        return rect
    }

    /// The store the Settings scene talks to: the focused window's, else any open window's, else a lazily created
    /// idle one (its engine only starts if a setting actually needs it).
    var settingsStore: AppState {
        if let store = focused?.store ?? entries.first?.store { return store }
        if let fallbackStore { return fallbackStore }
        let store = AppState(engineScript: ReviewGateApp.resolveSidecarScript())
        store.fileLog = EngineLogFile.shared   // wave1 mac-session (robustness-03)
        fallbackStore = store
        return store
    }

    /// Every store that may own an engine process (open windows + the Settings fallback).
    var allStores: [AppState] { stores + (fallbackStore.map { [$0] } ?? []) }
}

private extension NSRect {
    /// 0 for the null rect `intersection` returns when two frames do not overlap.
    var areaOrZero: CGFloat { isNull || isEmpty ? 0 : width * height }
}

// MARK: - Focused window plumbing

struct WorkbenchWindowKey: FocusedValueKey {
    typealias Value = WorkbenchWindowEntry
}

extension FocusedValues {
    /// The key window's workbench (store + view model), for the menu bar commands.
    var workbenchWindow: WorkbenchWindowEntry? {
        get { self[WorkbenchWindowKey.self] }
        set { self[WorkbenchWindowKey.self] = newValue }
    }
}

/// Hands the hosting `NSWindow` to the registry entry and reports key-window changes.
struct WindowAttacher: NSViewRepresentable {
    let entry: WorkbenchWindowEntry

    func makeNSView(context: Context) -> NSView {
        let view = AttachView()
        view.entry = entry
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? AttachView)?.entry = entry
    }

    final class AttachView: NSView {
        var entry: WorkbenchWindowEntry?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // Selector observers are unregistered automatically when the view is deallocated.
            NotificationCenter.default.removeObserver(self, name: NSWindow.didBecomeKeyNotification, object: nil)
            NotificationCenter.default.removeObserver(self, name: NSWindow.didMoveNotification, object: nil)
            NotificationCenter.default.removeObserver(self, name: NSWindow.didEndLiveResizeNotification, object: nil)
            guard let window, let entry else { return }
            entry.window = window
            CloseGuardDelegate.install(on: window, entry: entry)   // wave4 w4-safety (daily-12)
            NotificationCenter.default.addObserver(self, selector: #selector(becameKey), name: NSWindow.didBecomeKeyNotification, object: window)
            // M19: the frame is remembered per project (`ProjectUIState.frame`) as the user moves / resizes.
            NotificationCenter.default.addObserver(self, selector: #selector(frameChanged), name: NSWindow.didMoveNotification, object: window)
            NotificationCenter.default.addObserver(self, selector: #selector(frameChanged), name: NSWindow.didEndLiveResizeNotification, object: window)
            if window.isKeyWindow { WorkbenchRegistry.shared.setFocused(entry) }
        }

        @objc private func frameChanged(_ note: Notification) {
            entry?.rememberFrame()
        }

        @objc private func becameKey(_ note: Notification) {
            guard let entry else { return }
            WorkbenchRegistry.shared.setFocused(entry)
            AttentionCenter.shared.windowBecameKey(entry)   // MARK: polish p-lifecycle (PX-15)
            if let window { CloseGuardDelegate.install(on: window, entry: entry) }   // wave4 w4-safety: SwiftUI may swap it
        }
    }
}
