import Foundation

// MARK: wave7 w7-state — §45.2: what one window's menus show — the Review, Workbenches and Chat menus and the View / Edit
// items that need a project — as one Equatable value (`AppState.menuState`). The menus read only this, so a snapshot that
// does not change it never re-evaluates them (nor AppKit's pass over the menu bar's key equivalents).

/// A worktree of the Workbenches menu (the app words its title: `branch · primary · ●`).
public struct WorkbenchMenuItem: Equatable, Sendable, Identifiable {
    public var id: String { path }
    public var path: String
    public var branch: String?
    public var isMain: Bool
    public var dirty: Bool?
    /// This window's own worktree (checked, disabled).
    public var isCurrent: Bool

    public init(path: String, branch: String?, isMain: Bool, dirty: Bool?, isCurrent: Bool) {
        self.path = path
        self.branch = branch
        self.isMain = isMain
        self.dirty = dirty
        self.isCurrent = isCurrent
    }
}

/// A chat tab of the Chat menu (⌘1…⌘9).
public struct ChatMenuTab: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    /// The live chat (disabled: it is shown already).
    public var isCurrent: Bool

    public init(id: String, title: String, isCurrent: Bool) {
        self.id = id
        self.title = title
        self.isCurrent = isCurrent
    }
}

public struct MenuState: Equatable, Sendable {
    public var hasProject = false
    /// §59: the folder is tracked without git — commit, branches, workbenches and PRs are off.
    public var isShadowProject = false
    public var isRefreshing = false
    // Review
    /// The selected file is pending and accept / reject may run now (reject: it is captured, too) — and its diff is what
    /// the pane shows: not while a project file, a past round's file or the running turn's file covers it (MainWindow).
    public var canAcceptSelected = false
    public var canRejectSelected = false
    /// Undo Accept has a file (`AppState.undoAcceptTarget`) and may run now; Undo Reject has a reject to put back now.
    public var canUndoAccept = false
    public var canUndoReject = false
    public var hasPending = false
    public var canAcceptAll = false
    public var canRejectAll = false
    public var canFinishReview = false
    /// A side question can be asked (a project, an engine that knows §21).
    public var canAskSide = false
    public var canCommit = false
    // Workbenches
    public var workbenches: [WorkbenchMenuItem] = []
    // Chat
    /// A chat switch is refused now (`chatSwitchBlocker`).
    public var chatSwitchBlocked = false
    /// r2-chats-cards M31 (§9): ⌘T cannot open a chat at all (`newChatBlocker`: a failed collection); while Claude works
    /// the new chat waits for the turn instead.
    public var newChatBlocked = false
    /// §9 Chat › New Chat in a Workbench… (⌥⌘T): why it cannot run (nil: it can — no project, or no git, §59).
    public var workbenchChatBlocker: String? = String(localized: "Open a project first (⌘O)", bundle: .module)
    /// The first nine open tabs.
    public var chatTabs: [ChatMenuTab] = []
    /// Chat › Close Chat Tab: the tab on screen can be closed (`AppState.canCloseTab`).
    public var canCloseShownTab = false
    // MARK: r2-chats-cards — polish P4-composer-05: the Chat menu's Stop, history, next / previous tab and mode
    /// Claude works: Chat › Claude 중지 (⌘.).
    public var isRunning = false
    /// A `!` command runs (§67.2): Stop stops it too.
    public var shellRunning = false
    /// The engine keeps chats (M15): history and renaming.
    public var hasChatSessions = false
    /// The chat on screen (the live one, or one shown read-only), for next / previous tab.
    public var shownChatId: String?
    /// The permission mode and whether it can be picked now (Chat › 권한 모드).
    public var permissionMode: PermissionMode = .default
    public var canPickPermissionMode = false
    // MARK: terminal-chat (§57.5)
    /// The live chat runs Claude Code in a terminal: Stop goes to its PTY; Request Changes is refused by the engine.
    public var isTerminalChat = false
    /// The chat on screen is a terminal chat: no message box — Commands…, Attach Images…, Find in Chat and the
    /// permission mode are the TUI's own.
    public var shownChatIsTerminal = false
    /// MARK: terminal-continue (§57.9): Chat › "Continue as Terminal Chat" acts on the chat on screen (nil: a terminal chat
    /// or none — not offered) and why it is off.
    public var continueTerminalChatId: String?
    public var continueTerminalBlocker: String?

    public init() {}

    /// What `store`'s menus show now (reads the slices and client state the menus need, never the HUD).
    @MainActor public init(_ store: AppState) {
        hasProject = store.projectInfo != nil
        isShadowProject = store.isShadowProject
        isRefreshing = store.isRefreshing
        let selected = store.selectedFile
        let onScreen = !store.codeBrowser.isOpen && store.historySelection == nil && store.liveSelection == nil
        let pending = selected?.state == .pending && onScreen
        canAcceptSelected = pending && !store.isAcceptLocked
        canRejectSelected = pending && !store.isRejectLocked && selected?.uncaptured != true
            && selected?.rejectScheduled != true   // r2-review-flow M32: already waits for the turn's end
        canUndoAccept = store.undoAcceptTarget != nil && !store.isReviewLocked
        canUndoReject = store.rejectUndoOffer.map { $0.blocked == nil } ?? false
        hasPending = !store.pendingFiles.isEmpty
        canAcceptAll = hasPending && !store.isAcceptLocked
        canRejectAll = hasPending && !store.isRejectLocked
        canFinishReview = store.canFinishReview
        canAskSide = hasProject && store.side.isSupported
        canCommit = store.canOpenCommitSheet   // r2-review-flow M28: pending files are committed (accepted) from the sheet too
        let current = store.projectURL?.standardizedFileURL.path
        workbenches = store.workbenches.list.map { wb in
            WorkbenchMenuItem(path: wb.path, branch: wb.branch, isMain: wb.isMain, dirty: wb.dirty,
                              isCurrent: URL(fileURLWithPath: wb.path).standardizedFileURL.path == current)
        }
        chatSwitchBlocked = store.chatSwitchBlocker != nil
        newChatBlocked = store.newChatBlocker != nil
        workbenchChatBlocker = store.workbenchChatBlocker
        let live = store.currentSessionId
        chatTabs = store.openTabs.prefix(9).map { ChatMenuTab(id: $0.id, title: $0.title, isCurrent: $0.id == live) }
        canCloseShownTab = store.shownChatId.map { store.canCloseTab(id: $0) } ?? false
        isRunning = store.isRunning
        shellRunning = store.shellRun != nil
        hasChatSessions = store.hasChatSessions
        shownChatId = store.shownChatId
        permissionMode = store.scheduledPermissionMode ?? store.permissionMode
        isTerminalChat = store.isTerminalChat
        shownChatIsTerminal = store.shownChatIsTerminal
        canPickPermissionMode = store.canPickPermissionMode && !isTerminalChat && !shownChatIsTerminal
        if let shown = store.shownChatId, let meta = store.sessions.first(where: { $0.id == shown }), meta.kind != .terminal {
            continueTerminalChatId = shown
            continueTerminalBlocker = store.continueAsTerminalBlocker(meta)
        }
    }
}
