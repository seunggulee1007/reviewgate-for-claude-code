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
    /// Project waiting for the "discard pending review?" confirmation (alert lives in `MainWindow`).
    var pendingSwitch: URL?
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
        guard !isTerminating else { return }
        AppSettings.setOpenWindows(entries.compactMap(\.openWindowState))
    }

    /// Quit path: persist first, then freeze the list so the closing windows cannot shrink it.
    func persistOpenWindowsForTermination() {
        for entry in entries { entry.rememberFrame() }
        AppSettings.setOpenWindows(entries.compactMap(\.openWindowState))
        isTerminating = true
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
            if let window { CloseGuardDelegate.install(on: window, entry: entry) }   // wave4 w4-safety: SwiftUI may swap it
        }
    }
}
