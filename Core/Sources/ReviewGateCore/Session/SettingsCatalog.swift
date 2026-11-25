import Foundation

// docs/PROTOCOL.md §55.11 — Settings: panes, search and when a change applies.
// The Mac Settings window lists its settings in panes (a sidebar), finds them by their words in either language and marks
// the ones that do not apply at once. This file is that index: every setting's pane, its words (English keys of
// App/Localizable.xcstrings, localized by the caller) and when a change takes effect. The Windows client keeps the same
// index in clients/desktop/src/renderer/settingsIndex.ts.

/// A pane of the Settings window, in sidebar order. The raw values are what `SettingsView.tabKey` stores (`general`,
/// `extensions`, `project` and `accounts` were the tabs before the split, so a stored choice still opens there).
public enum SettingsPane: String, CaseIterable, Sendable, Identifiable {
    case general, permissions, session, review, git, tasks, extensions, project, accounts, advanced   // MARK: task-start: tasks (§63)

    public var id: String { rawValue }

    /// The English key of its name.
    public var title: String {
        switch self {
        case .general: "General"
        case .permissions: "Permissions"
        case .session: "Session"
        case .review: "Review"
        case .git: "Git & Workbenches"
        case .tasks: "Tasks"   // MARK: task-start (§63)
        case .extensions: "Extensions"
        case .project: "Project"
        case .accounts: "Accounts"
        case .advanced: "Advanced"
        }
    }

    /// A stored tab value (also one from before the split); unknown → General.
    public init(stored: String?) {
        self = stored.flatMap(SettingsPane.init(rawValue:)) ?? .general
    }
}

/// When a changed setting takes effect. Settings without a badge apply at once; the others say which of these it is.
public enum SettingApplies: String, Sendable, Equatable {
    /// The open windows and sessions use it right away (pushed with `set_settings`, or read where it is used).
    case immediately
    /// The engine reads it when a Claude session starts: restarting the session (Settings' banner, `restart_session`) or a
    /// new chat picks it up. Never "the next Open Project" — the open window's engine already has the new value.
    case nextSession
    /// Read when a window's engine process starts (`hello`): windows opened from now on.
    case newWindow
    /// The mode a project opened for the first time starts in; a project already opened keeps its own (§39.5).
    case newProject

    /// The English key of the badge; nil = no badge (applies at once).
    public var badge: String? {
        switch self {
        case .immediately: nil
        case .nextSession: "Next session"
        case .newWindow: "New windows"
        case .newProject: "New projects"
        }
    }

    /// The English key of the badge's tooltip.
    public var help: String? {
        switch self {
        case .immediately: nil
        case .nextSession: "Takes effect when this window's Claude session restarts or a new chat starts"
        case .newWindow: "Takes effect in windows opened from now on; an open window keeps the old value"
        case .newProject: "Projects opened for the first time start with it; a project you opened before keeps its own"
        }
    }
}

/// One setting of the index. `title`, `section` and `info` are English keys of the App's string catalog.
public struct SettingEntry: Sendable, Equatable, Identifiable {
    /// Stable anchor: Settings scrolls to the row with this id and highlights it (usually the defaults key).
    public let id: String
    public let pane: SettingsPane
    /// The section heading it sits under.
    public let section: String
    public let title: String
    /// The longer explanation (the ⓘ popover and the tooltip); searched too.
    public let info: String?
    public let applies: SettingApplies

    public init(_ id: String, _ pane: SettingsPane, section: String, title: String, info: String? = nil, applies: SettingApplies = .immediately) {
        self.id = id
        self.pane = pane
        self.section = section
        self.title = title
        self.info = info
        self.applies = applies
    }
}

public enum SettingsCatalog {
    // MARK: Explanations (the ⓘ of a row) — one home each, without the timing (the badge says it)

    public enum Info {
        public static let appearance = "System follows macOS. Light and Dark apply to every window, sheet and menu right away."
        public static let returnSends = "On: ↩ sends and ⇧↩ starts a new line. Off: ↩ starts a new line and ⌘↩ sends. ⌘↩ sends either way."
        public static let exploreDetail = "Off: reads, searches and read-only commands in a row fold into one line in the chat (click it to open)."
        public static let confirmQuit = "Closing the last window or quitting asks first. \"Don't ask again\" in that question turns this off."
        public static let confirmClose = "Closing a window or quitting while a turn runs, or while Claude waits for your answer, asks first."
        public static let notifications = "Turn finished (with the files waiting for review), permission requests, questions, plans and errors that need you. The dock badge counts files pending review across windows, or shows ! while Claude waits for an answer."
        public static let startingMode = "New projects start in this mode; each project then keeps the mode you pick."
        public static let readOnlyBash = "Commands that only read (git status, ls, cat, grep, …) with no redirection or chaining run without asking."
        public static let autoAllowBash = "Off: every shell command asks for permission in the chat. Edits are always auto-allowed (within the change limit, when it is on)."
        public static let allowPatterns = "One per line — Bash(npm test:*), Bash(git *), mcp__github__* (an MCP server), mcp__github__get_issue (one tool), WebFetch(domain:docs.spring.io), WebSearch. Matching calls never ask."
        public static let projectPatterns = "Saved from the permission card: simple Bash commands, MCP tools and servers, WebFetch domains."
        public static let worktreeIsolation = "In auto mode they run without a card; otherwise each asks with a card. A row afterwards says where they worked."
        public static let terminalAllowRules = "Tools you allowed in Claude Code that cannot change files — web search and fetch, read-only MCP tools, agents — run without a card here too. Edits and commands still go through the review."
        public static let terminalBashRules = "Commands your Bash(…) rules allow (e.g. Bash(mvn:*)) run without a card, as in the terminal; your deny and ask rules still win, and the files they change are reviewed."
        public static let keepSessionAllows = "Kept when the app reopens · shared by the repository's worktrees and workbenches"
        public static let newChatKind = "For ⌘T, the + of the chat tabs and a project's first chat. Both kinds stay in the Chat menu: New Terminal Chat (⌃⌘T) and New Chat (Classic) (⌃⌥⌘T). Chats you already have keep their kind."
        public static let terminalBridge = "Claude Code's permission dialog in a terminal chat also shows as a card over the terminal, with Allow once and Deny. The terminal's own dialog stays open either way, and \"always allow\" is only there. Off: answer in the terminal only."
        public static let autoRestart = "Starts a new Claude session once when the current one dies unexpectedly. The review list is kept either way; off, the chat shows \"Session ended — Restart\"."
        public static let backgroundWork = "As in the terminal: Claude can run a command in the background (a dev server, a long build) and /loop can repeat a prompt. When a background command ends or a scheduled run starts, Claude goes on by itself — that turn is reviewed like any other, and files a background command changed in between go into the next review."
        public static let subagentsInTurn = "Off (the default): as in the terminal, a subagent works in the background and Claude answers your messages meanwhile; what it changes still goes into the next review, and Claude goes on when it is done. On: Claude waits for its subagents before it answers, as before."
        public static let budget = "Off (the default): no limit on the files or lines one reply changes — Claude finishes the task as in the terminal, and you review the changes afterwards."
        public static let maxTurns = "Off (the default): no limit — Claude works through a message until it is done, as in the terminal. On: Claude stops after this many tool calls for one message; Continue goes on from there."
        public static let sideQuestions = "Side questions run in their own read-only Claude session forked from the chat; they never change files or the main conversation."
        public static let sideModel = "Same model as the main conversation: it reuses the conversation's cache and answers fastest. Another model (e.g. haiku) costs less per token but reads the whole conversation again."
        public static let wrapLines = "Off: each line stays on one line and all lines of a diff scroll sideways together (trackpad, or Shift + scroll wheel)."
        public static let diffLayout = "Split shows the old version on the left and the new on the right — a narrow diff pane shows unified until it is wide enough."
        public static let commandClick = "Peek shows the definition in a band under the line, so the place you read stays where it is; Go to Definition jumps there (Back returns). F12 always jumps, ⌥F12 always peeks."
        public static let peerInbound = "When another Claude session of yours (a terminal, the IDE) sends a message to this window's Claude: handle it as it arrives — once Claude is free, its changes reviewed like any other; a sender your session list does not show still asks — ask with a card first, or decline it. A project can choose its own in the project menu."
        public static let statusLine = "Your own status line (the statusLine command of your Claude Code settings, such as the OMC HUD) under the message box, colored as in the terminal. It runs while a project is open and the chat is on screen."
        public static let systemPrompt = "Added to Claude's system prompt in every session. Placeholders {maxFiles} and {maxLines} are substituted."
        public static let reviewFirst = "Until you accept or reject Claude's changes, it may fix the files under review — when you ask in the chat or send Request changes — but its edits to other files wait; Bash commands run. In chats and in terminal chats; a blocked edit's row can allow the rest of that turn. Block prompts too: every change and a new message wait until the review is done (Accept & Send accepts first). Turn off: a message during a review may change any file, as before."
        public static let ignorePatterns = "One per line; a path prefix (e.g. .omc/) or a glob with * (e.g. *.log). Matching files are hidden from the review list and never reverted. Applied when you leave the box, from the next collected turn."
        public static let testCommands = "One per line, matched against each command of a Bash call as typed — * is any run of characters, ? one character. A matching command counts as a test run in the turn summary. Applied when you leave this box."
        public static let largeFiles = "Such a file (a heap dump, an archive) stays in the review list but its content is not stored: it cannot be reverted and the app does not commit it. Files git tracks are always stored."
        public static let worktreeRoot = "New workbenches are created under this folder as <repo>-<hash>/<branch>. Never inside the repository."
        public static let runAsTask = "Adds \"Run as Task\" to the composer and the Workbenches menu: the message starts in a new workbench (its own branch, folder, window and chat), so this chat is left as it is."
        public static let pushByDefault = "Preselects \"Push to origin\" in the Commit accepted sheet."
        public static let commitTrailer = "Appended as the last line of every commit message (e.g. Co-Authored-By: …). Leave empty for none."
        /// MARK: git-sync (§68.4)
        public static let autoFetch = "A quiet git fetch when a project opens and when its window comes to the front — at most every 5 minutes — so the branch shows how far behind it is. It never pulls, never touches your files and never asks for a password. Fetch and Pull are in the branch menu."
        public static let loadUserSettings = "Skills, plugins, MCP servers and hooks from ~/.claude. Bash and other non-edit tools still require approval here."
        public static let userHooks = "Off: hooks in ~/.claude and project settings and plugin hooks do not run — your statusLine is turned off too. ReviewGate's own safety hooks always stay on."
        public static let cliPin = "Claude Code updates itself in the background. Pin a version to keep starting new sessions with it; ReviewGate marks the versions it was checked with."
        public static let toolchainOverrides = "Leave empty to detect via the login shell."
        // MARK: task-start (§63)
        public static let startScreen = "When a project opens in a window: start straight away, start from a task, or continue a recent chat (1 / 2 / 3, Esc starts straight away). Off: the window opens into its chat."
        public static let taskPlatform = "GitHub Issues are read with the GitHub CLI (gh). Jira, Linear and other trackers are read by Claude through the MCP server below — ReviewGate never calls the tracker and keeps no token."
        public static let taskBranchPrefix = "The task's branch is <prefix><id>-<title words>, e.g. feature/ACME-123-fix-cart-total. {type} becomes fix, docs, chore or feature from the issue's labels."
        public static let taskLocation = "A new branch in this window (your uncommitted changes come along), or a new workbench — its own folder, branch and window."
        public static let taskMcpServer = "The MCP server Claude reads Jira, Linear and other tasks with (its mcp__<server>__* tools). The list is this project's servers; you can type another name."
        public static let taskPromptTemplate = "The first message, put into the message box (or the terminal's prompt) and never sent by itself. {id}, {title}, {url}, {body} are the task's; {mcp} is how Claude reads it. A line whose placeholders are all empty is left out."
    }

    /// Every setting the search finds, in pane order (then the order they show in).
    public static let entries: [SettingEntry] = [
        // General
        SettingEntry("appearance", .general, section: "Appearance", title: "Appearance", info: Info.appearance),
        SettingEntry("reopenLastProjects", .general, section: "Appearance", title: "Reopen last projects on launch"),
        SettingEntry("returnSends", .general, section: "Typing and the chat", title: "Return sends the message", info: Info.returnSends),
        SettingEntry("showExploreDetail", .general, section: "Typing and the chat", title: "Show exploration rows in detail", info: Info.exploreDetail),
        SettingEntry("confirmQuit", .general, section: "Closing and quitting", title: "Ask before quitting", info: Info.confirmQuit),
        SettingEntry("confirmCloseWhileWorking", .general, section: "Closing and quitting", title: "Ask before closing while Claude works", info: Info.confirmClose),
        SettingEntry("notificationsEnabled", .general, section: "Notifications", title: "Notify when a window in the background needs you", info: Info.notifications),
        SettingEntry("notificationSound", .general, section: "Notifications", title: "Play a sound"),
        SettingEntry("notificationSounds", .general, section: "Notifications", title: "Sounds"),
        SettingEntry("notifyWaiting", .general, section: "Notifications", title: "Permission requests, questions and plans"),
        SettingEntry("notifyTurnEnd", .general, section: "Notifications", title: "When work finishes"),
        SettingEntry("notifyOther", .general, section: "Notifications", title: "Everything else (errors, side questions, other sessions, subagents)"),
        SettingEntry("checkForUpdatesAutomatically", .general, section: "Updates", title: "Check for updates automatically"),
        // Permissions
        SettingEntry("startPermissionMode", .permissions, section: "Permissions", title: "Starting mode", info: Info.startingMode, applies: .newProject),
        SettingEntry("autoAllowReadOnlyBash", .permissions, section: "Permissions", title: "Auto-allow read-only Bash", info: Info.readOnlyBash),
        SettingEntry("autoAllowBash", .permissions, section: "Permissions", title: "Auto-allow Bash", info: Info.autoAllowBash, applies: .nextSession),
        SettingEntry("bashAllowPatterns", .permissions, section: "Allow patterns", title: "Allow patterns", info: Info.allowPatterns),
        SettingEntry("projectAllowPatterns", .permissions, section: "Allow patterns", title: "Always allowed in this project", info: Info.projectPatterns),
        SettingEntry("applyUserAllowRules", .permissions, section: "Terminal (Claude Code) allow rules", title: "Apply the terminal's allow rules (lookup and read tools)", info: Info.terminalAllowRules),
        SettingEntry("applyUserBashRules", .permissions, section: "Terminal (Claude Code) allow rules", title: "Also apply the terminal's Bash allow rules", info: Info.terminalBashRules),
        SettingEntry("terminalAllowRules", .permissions, section: "Terminal (Claude Code) allow rules", title: "Terminal (Claude Code) allow rules"),
        SettingEntry("persistSessionAllows", .permissions, section: "Allowed for this session", title: "Keep \"Allow for session\" for this repository", info: Info.keepSessionAllows),
        SettingEntry("rememberedAllows", .permissions, section: "Allowed for this session", title: "Allowed for this session"),
        SettingEntry("allowWorktreeIsolation", .permissions, section: "Agents and worktrees", title: "Allow agents that work in another worktree (isolation)", info: Info.worktreeIsolation, applies: .nextSession),
        // Session
        SettingEntry("newChatKind", .session, section: "Chats", title: "New chats open as", info: Info.newChatKind),
        SettingEntry("terminalPermissionBridge", .session, section: "Chats", title: "Answer terminal chats' permission prompts in ReviewGate too", info: Info.terminalBridge),
        SettingEntry("autoRestartSession", .session, section: "Session", title: "Auto-restart session", info: Info.autoRestart),
        SettingEntry("backgroundWork", .session, section: "Session", title: "Allow background work and /loop", info: Info.backgroundWork, applies: .nextSession),
        SettingEntry("subagentsInTurn", .session, section: "Session", title: "Subagents finish inside the turn", info: Info.subagentsInTurn, applies: .nextSession),
        SettingEntry("budgetEnabled", .session, section: "Limits", title: "Limit changes per reply", info: Info.budget),
        SettingEntry("maxTurns", .session, section: "Limits", title: "Limit tool calls per message", info: Info.maxTurns, applies: .nextSession),
        SettingEntry("sideModel", .session, section: "Side questions", title: "Side question model", info: Info.sideModel),
        SettingEntry("sideWeb", .session, section: "Side questions", title: "Web in side questions"),
        SettingEntry("peerInbound", .session, section: "Messages from other sessions", title: "Messages from other sessions", info: Info.peerInbound),
        SettingEntry("showStatusLine", .session, section: "Claude Code status line", title: "Show the Claude Code status line", info: Info.statusLine),
        SettingEntry("systemPromptAppend", .session, section: "System prompt append", title: "System prompt append", info: Info.systemPrompt, applies: .nextSession),
        // Review
        SettingEntry("diffWrapLines", .review, section: "Diff", title: "Wrap lines", info: Info.wrapLines),
        SettingEntry("diffLayout", .review, section: "Diff", title: "Diff layout", info: Info.diffLayout),
        SettingEntry("codeNavCommandClick", .review, section: "Diff", title: "⌘-click on a name", info: Info.commandClick),   // ide-nav (§65.8)
        SettingEntry("reviewFirst", .review, section: "Review first", title: "Claude waits for your review before its next work", info: Info.reviewFirst),
        SettingEntry("checkpointIgnorePatterns", .review, section: "Checkpoint ignore patterns", title: "Checkpoint ignore patterns", info: Info.ignorePatterns),
        SettingEntry("testCommandPatterns", .review, section: "Test command patterns", title: "Test command patterns", info: Info.testCommands),
        SettingEntry("largeFileMB", .review, section: "Disk space", title: "Leave untracked files out of snapshots from", info: Info.largeFiles),
        SettingEntry("historyCleanup", .review, section: "Disk space", title: "Clean Up Old Review History…"),
        // Git & Workbenches
        SettingEntry("worktreeRoot", .git, section: "Workbenches", title: "Worktree folder", info: Info.worktreeRoot),
        SettingEntry("runAsTaskEnabled", .git, section: "Workbenches", title: "Run as Task", info: Info.runAsTask),
        SettingEntry("commitPushByDefault", .git, section: "Commit", title: "Push by default", info: Info.pushByDefault),
        SettingEntry("commitTrailer", .git, section: "Commit", title: "Commit trailer", info: Info.commitTrailer),
        SettingEntry("autoFetch", .git, section: "Fetch and Pull", title: "Fetch automatically", info: Info.autoFetch),
        // Tasks — MARK: task-start (§63)
        SettingEntry("skipStartScreen", .tasks, section: "Start screen", title: "Show the start screen when a project opens", info: Info.startScreen),
        SettingEntry("taskPlatform", .tasks, section: "Start from a task", title: "Task platform", info: Info.taskPlatform),
        SettingEntry("taskBranchPrefix", .tasks, section: "Start from a task", title: "Branch prefix", info: Info.taskBranchPrefix),
        SettingEntry("taskStartLocation", .tasks, section: "Start from a task", title: "Start in", info: Info.taskLocation),
        SettingEntry("taskMcpServer", .tasks, section: "Start from a task", title: "MCP server for tasks", info: Info.taskMcpServer),
        SettingEntry("taskPromptTemplate", .tasks, section: "First prompt", title: "First prompt template", info: Info.taskPromptTemplate),
        // Extensions
        SettingEntry("loadUserSettings", .extensions, section: "Extensions", title: "Load user settings (skills, plugins, MCP, hooks from ~/.claude)", info: Info.loadUserSettings, applies: .nextSession),
        SettingEntry("disabledPlugins", .extensions, section: "Plugins", title: "Plugins", applies: .nextSession),
        SettingEntry("disableUserHooks", .extensions, section: "Hooks", title: "Run hooks from settings files and plugins", info: Info.userHooks, applies: .nextSession),
        SettingEntry("mcpServers", .extensions, section: "MCP servers", title: "MCP servers"),
        SettingEntry("skills", .extensions, section: "Skills and commands", title: "Skills and commands"),
        // Project (this repository)
        SettingEntry("commitTemplate", .project, section: "Commit message template", title: "Commit message template"),
        SettingEntry("workbenchSetup", .project, section: "Workbench setup", title: "Workbench setup"),
        SettingEntry("prRespondCommand", .project, section: "PR comments", title: "Command for PR comments"),
        // Accounts
        SettingEntry("githubAccounts", .accounts, section: "GitHub accounts", title: "GitHub accounts"),
        SettingEntry("addHost", .accounts, section: "Add a host", title: "Add a host"),
        // Advanced
        SettingEntry("toolchain", .advanced, section: "Toolchain", title: "Toolchain"),
        SettingEntry("cliPin", .advanced, section: "Pin CLI version", title: "Pin CLI version", info: Info.cliPin, applies: .nextSession),
        SettingEntry("claudePath", .advanced, section: "Toolchain overrides", title: "claude path", info: Info.toolchainOverrides, applies: .nextSession),
        SettingEntry("nodePath", .advanced, section: "Toolchain overrides", title: "node path", info: Info.toolchainOverrides, applies: .newWindow),
    ]

    /// The entry with this id.
    public static func entry(_ id: String) -> SettingEntry? { entries.first { $0.id == id } }

    /// When a change of this setting takes effect (unknown ids apply at once).
    public static func applies(_ id: String) -> SettingApplies { entry(id)?.applies ?? .immediately }

    /// The entries `query` finds: every word, in any order and any case, in the title, section, explanation or pane name —
    /// their English keys and their `localize`d words. An empty query finds nothing (the panes show instead).
    public static func search(_ query: String, entries: [SettingEntry] = entries,
                              localize: (String) -> String = { $0 }) -> [SettingEntry] {
        let words = fold(query).split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return [] }
        return entries.filter { entry in
            let hay = [entry.title, entry.section, entry.info, entry.pane.title].compactMap { $0 }
                .flatMap { [$0, localize($0)] }
                .map(fold)
                .joined(separator: "\n")
            return words.allSatisfy { hay.contains($0) }
        }
    }

    /// Case and width folded (so "bash" finds "Bash" and "ＭＣＰ" finds "MCP"); Korean stays as typed.
    private static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .widthInsensitive], locale: nil)
    }
}
