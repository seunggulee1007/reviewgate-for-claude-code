import Foundation
import Observation

/// Live session status for the HUD (docs/M7-API.md), localized from `state.hud`.
public struct HUDState: Sendable, Equatable {
    public var contextTokens: Int = 0
    public var contextWindow: Int?
    public var sessionCostUSD: Double = 0
    /// §21: side questions of this session (separate from `sessionCostUSD`).
    public var sideCostUSD: Double = 0
    public var turnCount: Int = 0
    public var lastTurnMs: Int = 0
    /// Localized short text, e.g. "Running Bash: npm test…", "Subagent working", "Thinking…", "Idle".
    public var activity: String = String(localized: "Idle", bundle: .module)
    public var activeTool: String?
    public var subagentDepth: Int = 0
    /// Set when a turn starts, cleared at turn end.
    public var turnStartedAt: Date?
    // MARK: wave4 w4-longwork
    /// §38.2: the subscription's usage windows (`state.hud.rateLimits`); empty on older engines.
    public var rateLimits: [RateLimitWindow] = []

    public init() {}

    init(_ wire: HUDWire) {
        contextTokens = wire.contextTokens
        contextWindow = wire.contextWindow
        sessionCostUSD = wire.sessionCostUSD
        sideCostUSD = wire.sideCostUSD
        turnCount = wire.turnCount
        lastTurnMs = wire.lastTurnMs
        subagentDepth = wire.subagentDepth
        turnStartedAt = wire.turnStartedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
        activeTool = wire.activity.toolName
        activity = Self.localizedActivity(wire.activity, subagentDepth: wire.subagentDepth)
        rateLimits = wire.rateLimits   // wave4 w4-longwork (§38.2)
        // MARK: wave4b w4b-agents — §39.3: "서브에이전트 3개 실행 중 — executor: Edit TenantService.java"
        if wire.activity.kind == .subagent, let line = AgentGlance.hudLine(wire.agents) { activity = line }
    }

    static func localizedActivity(_ a: HUDActivity, subagentDepth: Int) -> String {
        switch a.kind {
        case .idle: return String(localized: "Idle", bundle: .module)
        case .working: return String(localized: "Claude is working…", bundle: .module)
        case .thinking:
            // §27: `/compact` reports `thinking/compacting`, then `thinking/compacted`.
            switch a.detail {
            case "compacting": return String(localized: "Compacting the conversation…", bundle: .module)
            case "compacted": return String(localized: "Conversation compacted", bundle: .module)
            default: return String(localized: "Thinking…", bundle: .module)
            }
        case .tool:
            let tool = a.toolName.map { AgentGlance.toolTitle($0, detail: nil) } ?? "?"   // wave4b w4b-agents (§39.3): "github · get issue", "스킬"
            return a.detail.map { String(localized: "Running \(tool): \($0)", bundle: .module) }
                ?? String(localized: "Running \(tool)", bundle: .module)
        case .subagent:
            return a.detail.map { String(localized: "Subagent working: \($0)", bundle: .module) }
                ?? String(localized: "Subagent working", bundle: .module)
        }
    }
}

/// The app-side mirror of the engine's `ReviewState` (protocol v2) plus everything that is client state:
/// the transcript, engine logs, the selected file and its cached diffs, the capabilities cache and the
/// recent-projects list. Every property/method name the views used on the former `SessionStore` is kept;
/// all review-gate semantics now live in the engine — this class only sends commands and renders snapshots.
@MainActor
@Observable
public final class AppState {
    // MARK: wave7 w7-state — §45.2: views observe one stored slice per part of the snapshot, each written only when it
    // changed (`assignSlices`), so a snapshot that changes the HUD alone re-renders only what reads the HUD. `state` stays
    // the whole snapshot for the code that needs it; its readers are told only when some slice (or `pr`, `lastError`) changed.
    /// Last accepted snapshot (`.empty` until the engine's first `state`).
    public internal(set) var state: ReviewState {
        get {
            access(keyPath: \.state)
            return stateStore
        }
        set { applySlices(newValue) }
    }
    @ObservationIgnored private var stateStore: ReviewState
    /// `state.project` / `state.gitInit`, and the folder either names (the project, else the one waiting for `git init`).
    public private(set) var projectInfo: ProjectInfo?
    public private(set) var gitInitInfo: GitInitInfo?
    public private(set) var projectURL: URL?
    /// `state.session` / `state.toolchain`.
    public private(set) var sessionInfo: SessionInfo = ReviewState.empty.session
    public private(set) var engineToolchain: EngineToolchain = ReviewState.empty.toolchain
    /// `state.gate`, and its phase alone (what the locks read: a gate change inside a phase leaves them alone).
    public private(set) var gate: GateInfo = ReviewState.empty.gate
    public private(set) var gatePhase: GatePhase = ReviewState.empty.gate.phase
    public private(set) var changedFiles: [ChangedFile] = []
    public private(set) var reviewNotes: [ReviewNote] = []
    public private(set) var budget: Budget = ReviewState.empty.budget
    public private(set) var budgetUsage: BudgetUsage = ReviewState.empty.budgetUsage
    /// `state.hud` as sent; `hud` localized from it once per change; its agents and how many are live.
    public private(set) var hudWire: HUDWire = ReviewState.empty.hud
    public private(set) var hud = HUDState()
    /// `state.hud.turnCount` alone (the per-turn banners' scope: they need not follow the activity line).
    public private(set) var hudTurnCount = 0
    /// `state.hud.turnFiles` alone (the live changes' chip and list).
    public private(set) var hudTurnFiles = 0
    /// Subagents of the session (`state.hud.agents`); finished ones stay until the next user turn.
    public private(set) var agents: [AgentNode] = []
    /// Subagents still pending / running / paused.
    public private(set) var liveAgentCount = 0
    public private(set) var branchesInfo: BranchesInfo = ReviewState.empty.branches
    /// `state.workbenches`; `.empty` on engines without M10.
    public private(set) var workbenches: WorkbenchesInfo = .empty
    public private(set) var engineLockConflict: LockConflict?
    /// `state.commit`; `.empty` on engines without M12.
    public private(set) var commitState: CommitState = .empty
    /// `state.sessions`, and its open tabs resolved against the list (`openTabs`).
    public private(set) var sessionsInfo: SessionsInfo?
    /// The open tabs in order (`state.sessions.openTabIds` resolved against the list); the current session is always
    /// among them even before its `tabs_set` landed. Ids the engine no longer knows are skipped.
    public private(set) var openTabs: [SessionMeta] = []
    /// `state.storage` (§39.1).
    public private(set) var storage: StorageState?
    /// §41.2: the open repository's auto-accept rules (`state.autoAcceptRules`; none on older engines).
    public private(set) var autoAcceptRules: AutoAcceptRules = .none
    /// What the Review / Workbenches / Chat menus show (`MenuState`), written only when it differs.
    public private(set) var menuState = MenuState()
    public internal(set) var transcript: [ChatItem] = [] {
        // MARK: wave7 w7-chat — §45.1: never reads `oldValue` (that copied the whole array on every change); the shape
        // the row tree depends on is kept apart.
        didSet { transcriptChanged() }
    }
    /// Bumped on every transcript change (streamed deltas included, once per burst) — a cheap `onChange` token instead of
    /// comparing the array.
    public private(set) var transcriptRevision = 0
    /// Bumped when rows are added / removed / replaced wholesale; not by a streaming delta or an in-place decision.
    public private(set) var transcriptStructureRevision = 0
    // MARK: wave7 w7-chat — §45.1
    /// Count, first and last row id of `transcript` as of its last change.
    @ObservationIgnored private var transcriptShape = TranscriptShape()
    /// The streaming answer's text: a delta lands here, not in `transcript` (the row gets the text when it finishes).
    public let liveText = LiveAssistantText()
    /// Deltas arrived since the readers were last told (`publishLiveText`).
    @ObservationIgnored private var livePublishScheduled = false
    /// When the readers were last told (`publishLiveText`).
    @ObservationIgnored private var lastLivePublish: ContinuousClock.Instant?
    static let livePublishInterval: Duration = .milliseconds(100)
    /// The live transcript's row tree, index and lookups (`liveLookups`), brought up to date once per row change.
    @ObservationIgnored private let transcriptLookups = TranscriptLookups()
    /// The decoded prompt history of the open project, until this window adds a prompt (`promptHistory`).
    @ObservationIgnored private var promptHistoryCache: (root: String, entries: [String])?
    /// Messages typed while Claude was busy, sent in order once the session can take them (`drainQueue`).
    public internal(set) var queuedMessages: [QueuedMessage] = []
    /// Auto-sending stopped on an error (the reason); `resumeQueue()` clears it.
    public private(set) var queuePausedReason: String?
    /// "Stop and send": sent first once the interrupted turn has ended.
    public internal(set) var sendAfterInterrupt: String?
    /// §27: the last `context_warning`, until dismissed, compacted, or the context dropped below 80 % / the chat changed.
    public internal(set) var contextWarning: ContextWarning?
    /// §24: decoded image bytes by sha-256 (`attachment_get`, or seeded from what this client sent).
    public internal(set) var attachmentData: [String: Data] = [:]
    /// §24: hashes `attachment_get` could not deliver (`unknown_attachment`); the thumbnail shows a placeholder.
    public internal(set) var missingAttachments: Set<String> = []
    @ObservationIgnored var attachmentLoads: [String: Task<Data?, Never>] = [:]
    /// §26: a `rewind` is in flight (the sheet / editor buttons wait).
    public internal(set) var isRewinding = false
    /// A queued message went out; the next one waits until that turn has started (and ended).
    var queuedSendInFlight = false
    /// §28: the "stop and send" message (with its mentions / images) while its send waits behind the interrupt.
    private var pendingInterruptSend: QueuedMessage?
    /// §28: an older engine refused the send behind the interrupt; `drainQueue` sends it once the turn has ended.
    private var interruptFallback = false
    /// A turn was seen running; its end (phase back to reviewing / idle) is a "turn finished" attention event.
    private var turnInFlight = false
    /// Called for events that need the user (notifications, `AttentionEvent`); the app filters by window focus.
    @ObservationIgnored public var onAttention: (@MainActor (AttentionEvent) -> Void)?
    // MARK: wave1 mac-session
    /// M7: the message the last `send` carried and when — back to the front of the queue when the engine fails it.
    @ObservationIgnored var recentSend: (message: QueuedMessage, at: Date)?
    /// M7: after a `gate_closed:*` refusal the queue waits for a snapshot newer than this seq.
    @ObservationIgnored var queueWaitsAfterSeq: Int?
    /// §29: why the peer card's last action was refused (`peer_inbox_changed`, …), localized; nil after a success.
    public internal(set) var peerNotice: String?
    /// §29: a `peer_accept` / `peer_dismiss` / `peer_set` is in flight (the card's buttons wait).
    public internal(set) var isPeerBusy = false
    /// Robustness-03: the daily log file every log line also goes to; nil = memory only (tests, previews).
    @ObservationIgnored public var fileLog: EngineLogFile?
    /// Robustness-03 ②: drops the stderr copy of a `log` event.
    @ObservationIgnored var logDeduper = SidecarLogDeduper()
    @ObservationIgnored var logFlushScheduled = false
    public private(set) var logs: [String] = []
    public internal(set) var lastError: String?
    /// M13 (audit 4.2): the last engine `error` event with its scope, until the user dismisses it (`dismissErrorBanner()`).
    public internal(set) var errorBanner: ErrorBanner?
    /// §19.6: a transient status (`api_retrying` "재시도 중 (2/10)…", `cli_start_slow`) shown in the HUD — not a banner;
    /// it goes away when the turn makes progress, ends or the session has started.
    public private(set) var transientNotice: TransientNotice?
    /// §19.1: a `reject` / `reject_all` the engine refused because the user edited files after the review; the window
    /// asks whether to revert anyway (`confirmForceReject()` re-sends it with `force: true`) or keep everything.
    public internal(set) var forceRejectRequest: ForceRejectRequest?
    // MARK: wave4b w4b-follow (AppState+ChatMove.swift)
    /// §39.4: a `chat_move` is in flight (the move buttons wait).
    public internal(set) var isMovingChat = false
    /// §39.4: why the last move / receive was refused, one line; the window shows it until dismissed or the next move.
    public internal(set) var chatMoveNotice: String?
    /// §19.5: a `plan_response` is in flight (the plan card's buttons wait).
    public private(set) var isAnsweringPlan = false
    /// Why the last plan answer was refused (`gate_closed:*`, `plan_followup_failed`, …), localized; shown on the plan card.
    public private(set) var planRefusal: String?
    /// The plan the card showed when it was answered, re-shown when the answer is refused.
    private var answeredPlan: PendingPlan?
    // MARK: wave1 mac-perms (AppState+Permissions.swift)
    /// §33.1: requests this client answered that the engine has not confirmed yet — a snapshot taken before the engine
    /// saw the answer still lists them, and must not bring the card back.
    var answeredPermissionIds: Set<String> = []
    /// A short notice about a permission card (`unknown_permission_request` → "이미 처리된 권한 요청입니다"); the chat
    /// shows it as a toast that goes away by itself.
    public internal(set) var permissionNotice: PermissionNotice?
    /// §33.8: the last `permission_rules` reply (Settings › 터미널 허용 규칙), its refusal, and the request in flight.
    public internal(set) var permissionRules: PermissionRulesReply?
    public internal(set) var permissionRulesError: String?
    public internal(set) var isLoadingPermissionRules = false
    /// §2.8: the terminal's default mode, offered once when a project is opened ("터미널처럼 auto 모드로 시작할까요?").
    public internal(set) var defaultModeOffer: PermissionMode?
    /// §52: the screenshot tour's background tasks (DEBUG only; nil = the engine's).
    var debugBackgroundTasks: [BackgroundTaskInfo]?
    /// §49: a task handed to this worktree that the session could not take — the chat puts it into the composer (once per id).
    public internal(set) var taskForComposer: TaskComposerText?
    /// The UserDefaults this window's settings live in (the extensions in other files cannot see `defaults`).
    var permsDefaults: UserDefaults { defaults }
    public internal(set) var selectedDiff: FileDiff?
    /// M13 (audit 1.10): the engine cut `selectedDiff` at its line cap (`file_diff.truncated`).
    public internal(set) var selectedDiffTruncated = false
    /// §17: the `gate.turnEndTree` `selectedDiff` was computed for (`file_diff.endTree`) — what `reject_hunks` echoes.
    public internal(set) var selectedDiffEndTree: String?
    // MARK: wave2 mac-flow — §34 review round 2 (AppState+ReviewRound.swift)
    /// §34.5 "봤음": path → the content (`ViewedKey.content`, the blob in B) its diff was last shown with; `viewedPaths`
    /// and "본 뒤 바뀜" are read from it. Cleared only by a new review (A moved).
    var viewedContent: [String: String] = [:]
    /// §34.1: the range each file's diff is shown in, with the content it was chosen on.
    var rangeChoices: [String: ReviewRangeChoice] = [:]
    /// Diffs per (path, range, B); a newer B drops the older ones, a turn without B keeps them (read-only).
    var reviewDiffs: [ReviewDiffKey: ReviewDiffEntry] = [:]
    /// The range `selectedDiff` shows, and its `file_diff` §34 fields (old side, served during a turn).
    public internal(set) var selectedDiffSince: DiffSince = .review
    public internal(set) var selectedDiffInfo = FileDiffInfo()
    /// §34.4 `review_history.current`: the round in progress (shown on top of the history).
    public internal(set) var currentReviewRound: ReviewHistoryEntry?
    /// §34.6: the running turn's changes so far (`live_changes`); gone once the turn is collected.
    public internal(set) var liveChanges: LiveChanges?
    public internal(set) var isLoadingLiveChanges = false
    /// The engine does not know `live_changes` (before §34): no live list, no HUD summary, not asked again.
    public internal(set) var liveChangesUnsupported = false
    /// The live file whose diff the diff pane shows read-only (`live_diff`); nil = the review.
    public internal(set) var liveSelection: String?
    public internal(set) var liveDiff: FileDiff?
    public internal(set) var liveDiffTruncated = false
    public internal(set) var liveDiffError: String?
    @ObservationIgnored var liveRefreshTask: Task<Void, Never>?
    /// How long a `hud.turnFiles` change waits before `live_changes` (several edits in a row ask once).
    @ObservationIgnored var liveRefreshDelay: Duration = .milliseconds(800)
    /// When `live_changes` was last asked, and the least time between two asked by a writing call (as Electron's).
    @ObservationIgnored var lastLiveRequestAt: Date?
    @ObservationIgnored var liveMinGap: TimeInterval = 5
    /// The checkpoint ignore patterns this window's engine was last given (`set_settings` only when they changed).
    @ObservationIgnored var engineIgnorePatterns: [String]?
    /// M13 (audit 3.1): ids of transcript rows replayed by `transcript_restore` (rendered subtly).
    public private(set) var restoredTranscriptIDs: Set<UUID> = []
    /// M15: a `refresh` round trip is in flight (toolbar spinner).
    public private(set) var isRefreshing = false
    // §14 review history (client state: fetched on demand, reset with the project)
    /// Past review rounds, newest first (`review_history`).
    public private(set) var reviewHistory: [ReviewHistoryEntry] = []
    /// `reviewHistory` lists every session of the worktree (`all: true`) rather than the current chat's.
    public private(set) var historyAllSessions = false
    public private(set) var isLoadingHistory = false
    /// The last `review_history` refusal / failure, localized; nil after a successful load.
    public private(set) var historyLoadError: String?
    /// The history file whose diff the diff pane shows read-only; nil = the current review.
    public private(set) var historySelection: HistorySelection?
    public private(set) var historyDiff: FileDiff?
    public private(set) var historyDiffTruncated = false
    /// Why the selected history diff could not be loaded (`history_trees_gone`, …), localized.
    public private(set) var historyDiffError: String?
    // §17 hunk-level reject
    /// A `reject_hunks` is in flight (the diff's hunk buttons wait).
    public private(set) var isRejectingHunks = false
    /// The last `reject_hunks` refusal for `path`, shown above the diff until the next attempt or selection change.
    public private(set) var hunkRefusal: (path: String, refusal: HunkRefusal)?
    // MARK: wave1 mac-review — §31–32 review provenance
    /// A reject of files nothing of Claude's explains (origin `external`), waiting for the user's "revert them too?".
    public internal(set) var externalRejectRequest: ExternalRejectRequest?
    /// The review notices (§31–32 banners, the restored banner) the user closed, by `ReviewNotice.id`.
    public internal(set) var dismissedReviewNotices: Set<String> = []
    /// The store's settings (the window's `UserDefaults`), for the extensions in other files.
    var settingsDefaults: UserDefaults { defaults }
    // MARK: wave2 check-clients
    /// §29 fallback rows whose "이 메시지 처리하기" was used (by `PeerMessage.id`): each goes out once.
    public internal(set) var handledUnpromptedPeerIds: Set<String> = []
    // MARK: wave3 mac-agents (AppState+Agents.swift)
    /// §36.2: `stop_agent` sent for these agents (Agent tool_use ids); cleared once the snapshot no longer lists them live.
    public internal(set) var stoppingAgentIds: Set<String> = []
    /// §36.2: why stopping an agent was refused, localized; shown on its card and chat group until it ends.
    public internal(set) var agentStopRefusals: [String: String] = [:]
    // MARK: wave5 w5-model (AutoModel.swift)
    /// §43.4: the composer's "이번엔 opus" — only the next message goes out on this model; nil = auto / the chip's model.
    public internal(set) var nextMessageModel: String?
    /// §43.4: bumped when the model mode / policy changed (`modelMode` re-reads the settings).
    public internal(set) var autoModelSettingsRevision = 0
    /// §36.2: the engine does not know `stop_agent` (before §36): no stop control.
    public internal(set) var agentStopUnsupported = false
    /// §36.1: the engine does not know `agent_report` (before §36): the preview is all there is.
    public internal(set) var agentReportUnsupported = false
    // §16 extensions fallback
    /// `extensions_fallback` as the event reported it (the snapshot's `extensions.fallback` wins once it arrives).
    private var fallbackFromEvent: ExtensionsFallback?
    private var fallbackMessage: String?
    /// The fallback the user dismissed (its `at`, or the timeout for an event-only one).
    private var dismissedFallbackKey: String?
    /// PR browsing mirror (`state.pr`); injected into the PR views as their `PRStore` environment.
    public let pr: PRStore
    // MARK: wave3 mac-flow
    /// §36.11–36.13: the commit draft, the workbench preview / steps and the AI pre-review runs (WorkflowTools.swift).
    public let flow = FlowToolsStore()
    /// §21 side questions of the current chat.
    public let side = SideThreadStore()
    /// §22 the live session's MCP servers.
    public let mcp = McpStore()
    // MARK: wave3 mac-session
    /// §36.7–36.9: the extensions retry, the installed CLI versions and the user's other Claude sessions (SessionTools.swift).
    public let sessionTools = SessionToolsStore()
    // MARK: wave5 w5-brain
    /// §43.2: the board's sub-brain tab — the auto-memory snapshots and the selected memory (SubBrain.swift).
    public let subBrain = SubBrainStore()
    // MARK: wave5 w5-graph
    /// §43.3: the board's code graph (graphify), refreshed while its tab is shown (CodeGraph.swift).
    public let codeGraph = CodeGraphStore()
    // MARK: wave6 w6-statusline
    /// §44.2: the user's Claude Code status line under the composer (StatusLine.swift).
    public let statusLine = StatusLineStore()
    // MARK: code-browser
    /// §47: a project file open read-only in the diff pane, and the project search (CodeBrowser.swift).
    public let codeBrowser = CodeBrowserStore()
    // MARK: wave4 w4-safety (AppState+Safety.swift)
    /// daily-14: why the running turn stopped (its `error` events); taken by the turn's "finished" notification.
    var turnStopReason: TurnStopReason?
    /// robustness-07: "Stop" did not end the turn within `AppState.stuckInterruptDelay` — offers "Force restart".
    public internal(set) var interruptStuck = false
    @ObservationIgnored var interruptWatch: Task<Void, Never>?
    /// polish-12: the composer of every other chat of this window, by chat id (`stashDraft` / `takeDraft`).
    @ObservationIgnored var chatDrafts: [String: ChatDraft] = [:]
    // MARK: wave4 w4-longwork
    /// §38.2: the last usage limit's reset and "풀리면 이어서 하기" (AppState+LongWork.swift).
    public internal(set) var longWork = LongWorkState()
    /// The timer of an armed "풀리면 이어서 하기" (cancelled when it is disarmed).
    var limitResumeTask: Task<Void, Never>?
    // MARK: wave4 w4-history (AppState+History.swift)
    /// §38.3: where the shown chat's rows start ([이전 대화 더 보기]) and which items its messages became.
    public internal(set) var transcriptPaging = TranscriptPaging()
    /// §38.3: a chat-history search match waiting for its row to be shown.
    public internal(set) var transcriptJump: TranscriptJump?
    /// §38.3: the item the last jump landed on (the chat view scrolls there).
    public internal(set) var transcriptJumpItem: TranscriptJumpItem?
    /// §38.3 `history_diff.why`: why that round changed the selected history file (nil: the engine had nothing).
    public internal(set) var historyWhy: FileWhy?
    // MARK: wave4b w4b-bigturn (AppState+BigTurn.swift)
    /// §39.1: the `since` of the save-failure banner the user closed (the same run of failures never shows it again).
    public internal(set) var dismissedSaveFailureSince: String?
    /// §39.1: the disk-critical banner was closed — it shows once per window (as in Electron); the HUD chip stays.
    public internal(set) var diskCriticalDismissed = false
    /// §39.1: `retry_save` is on its way.
    public internal(set) var isRetryingSave = false
    // MARK: wave4b w4b-tabs (AppState+ChatViewing.swift)
    /// §39.2: another chat shown read-only (its saved rows) while the live session stays where it is; see `viewingChat`.
    public internal(set) var viewedChat: ViewedChat?
    // MARK: wave4b w4b-auto (AppState+AutoMode.swift)
    /// §39.5: the mode picked while Claude works; applied when the turn ends (nil: none waiting).
    public internal(set) var scheduledPermissionMode: PermissionMode?
    /// §39.5: why the last mode switch was refused (`auto_mode_unavailable`, …); cleared by the next pick.
    public internal(set) var permissionModeRefusal: String?
    // MARK: wave6 w6-terminal (TerminalMode.swift)
    /// §44.1: the CLI cannot run auto mode here (the engine said `auto_mode_unavailable`): shift+tab skips it. Cleared by
    /// another project, another model, or auto mode taken after all.
    public internal(set) var autoModeUnavailable = false
    // MARK: wave4b w4b-side
    /// §40.3: asks the user before a chat switch cuts running side answers (the app shows an alert; nil = no question).
    @ObservationIgnored public var confirmSideSwitch: (@MainActor (String) -> Bool)?
    /// `project|chat` the side threads were loaded for; a change reloads them (`side_list`).
    private var sideLoadedKey: String?
    /// Where `sidecar.mjs` lives; resolved by the app (bundle resource or REVIEWGATE_SIDECAR).
    public let scriptPath: String

    private var selectedPathValue: String?
    /// The file the last accept was for — ⌘⇧A has moved the selection on, so Review › Undo Accept finds it here. Cleared by
    /// undoing that accept and with a new review.
    public internal(set) var lastAcceptedPath: String?
    var diffLoadTask: Task<Void, Never>?
    private var cachedCapabilities: SessionCapabilities?
    private var nodeToolchain: Toolchain?
    private var engineStarted = false
    /// Test seam: when set, `fire` hands commands here instead of the engine client.
    var commandSink: ((EngineCommand) -> Void)?
    /// Test seam for request/reply commands (reject, plan_response): throws like `EngineClient.request`.
    var requestSink: ((EngineCommand) async throws -> Void)?
    /// Test seam for commands with a typed reply (§21 / §22): returns the reply event or throws the refusal.
    var replySink: ((EngineCommand) async throws -> EngineEvent)?
    /// The project whose `open_project` was refused with `locked_by_other_session` (M10); drives the takeover alert.
    private var lockedProjectURL: URL?
    private let defaults: UserDefaults
    let client: EngineClient
    private var eventTask: Task<Void, Never>?

    public init(engineScript: String, defaults: UserDefaults = .standard) {
        self.scriptPath = engineScript
        self.defaults = defaults
        var initial = ReviewState.empty
        initial.budget = AppSettings.budget(defaults: defaults)
        initial.pr.host = PRStore.storedHost(defaults: defaults)
        self.stateStore = initial
        nonisolated(unsafe) let settingsDefaults = defaults   // UserDefaults is thread-safe; read on the engine actor
        let client = EngineClient(
            scriptPath: engineScript,
            settings: { AppSettings.sessionEngineSettings(defaults: settingsDefaults) },   // wave1 mac-session: + peerInbound
            nodePathOverride: { AppSettings.nodePathOverride(defaults: settingsDefaults) })
        self.client = client
        self.pr = PRStore(defaults: defaults)
        _ = assignSlices(initial)   // wave7 w7-state (§45.2): the settings' budget
        pr.attach(self)
        flow.attach(self)   // wave3 mac-flow
        side.attach(self)
        mcp.attach(self)
        sessionTools.attach(self)   // wave3 mac-session
        side.onAnswerFinished = { [weak self] thread in self?.onAttention?(.sideAnswer(thread)) }
        eventTask = Task { [weak self] in
            for await event in client.events {
                guard let self else { break }
                self.handle(event)
            }
        }
        trackMenuState()   // wave7 w7-state (§45.2)
    }

    // MARK: - Mirrored properties (names preserved from SessionStore)
    // wave7 w7-state (§45.2): each reads the slices it needs, never `state` (a view reading one re-renders on its slices).

    public var projectName: String { projectURL?.lastPathComponent ?? "" }
    /// A Claude session is open in the engine.
    public var isSessionOpen: Bool { sessionInfo.open }
    /// The engine process has been spawned by this client (and has not exited / been stopped).
    public var isEngineRunning: Bool { engineStarted }
    /// M19: pid of this window's sidecar — the pid a `locked_by_other_session:<pid>` refusal names when
    /// another of our own windows holds the worktree lock. Nil until the engine has been started.
    public private(set) var enginePID: Int32?
    public var isRunning: Bool { gatePhase == .running }
    public var isStarting: Bool { gatePhase == .starting || sessionInfo.starting }
    /// True while the end-of-turn snapshot/diff is being computed (input stays disabled).
    public var isSnapshotting: Bool { gatePhase == .collecting }
    /// True while a reject is reverting files on disk.
    public var isReverting: Bool { gatePhase == .reverting }
    /// Accept / reject wait while a turn runs, its changes are being collected or a revert is in flight: the engine
    /// refuses them with `session_running` / `reverting` then (a revert mid-turn would make the turn's own changes
    /// skip the review).
    public var isReviewLocked: Bool { isRunning || isSnapshotting || isReverting }
    /// Non-nil when the end-of-turn collection failed: the gate stays closed until `retryCollectReview()` succeeds.
    public var reviewCollectFailed: String? { gate.collectError }
    public var pendingFiles: [ChangedFile] { changedFiles.filter { $0.state == .pending } }
    /// Files sent back with notes by `requestChanges`; they keep the gate closed like pending ones.
    public var changesRequestedFiles: [ChangedFile] { changedFiles.filter { $0.state == .changesRequested } }
    public var hasPendingReview: Bool { !pendingFiles.isEmpty || !changesRequestedFiles.isEmpty }
    public var canSend: Bool { gate.canSend }
    public var canRequestChanges: Bool { gate.canRequestChanges }
    /// The explicit "Accept N & Send" action is offered: files are pending, none is changes-requested
    /// (those go through Request changes) and a message can be sent. Plain Send never accepts anything.
    public var canAcceptAndSend: Bool {
        canSend && !pendingFiles.isEmpty && changesRequestedFiles.isEmpty
    }
    /// M16: what "Accept N & Send" will accept. The engine's `state.gate.reviewSummary` totals every changed file, so it
    /// is used only while all of them are pending; otherwise (some accepted / older engine) the pending files are summed.
    public var reviewSummary: ReviewSummary {
        let pending = pendingFiles
        if let summary = gate.reviewSummary, summary.files == pending.count { return summary }
        return ReviewSummary(files: pending.count, added: pending.reduce(0) { $0 + $1.added }, deleted: pending.reduce(0) { $0 + $1.deleted })
    }
    /// M16: tool + command prefixes "Allow for session" remembered (`state.session.rememberedAllows`).
    public var rememberedAllows: [String] { sessionInfo.rememberedAllows }
    /// M20: the live session's permission mode (`state.session.permissionMode`).
    public var permissionMode: PermissionMode { sessionInfo.permissionMode }
    /// M20: the plan awaiting `plan_response`; the plan card is shown while it is non-nil.
    public var pendingPlan: PendingPlan? { sessionInfo.pendingPlan ?? (planRefusal != nil ? answeredPlan : nil) }
    /// The plan card's approve / keep-planning wait while a turn runs, its changes are collected, a revert is in flight
    /// or the previous answer is still on its way (the engine would refuse it with `gate_closed:*`).
    public var isPlanLocked: Bool { isReviewLocked || isAnsweringPlan }
    /// M20: the session is open and idle — any mode can be set now. §39.5: while a turn runs some can too
    /// (`canSetPermissionMode(to:)`); a start, a collection or a revert takes none (`session_busy`).
    public var canSetPermissionMode: Bool {
        sessionInfo.open && !isRunning && !isStarting && !isSnapshotting && !isReverting
    }
    public var sessionId: String? { sessionInfo.sessionId }
    public var model: String? { sessionInfo.model }
    /// From the session's `system/init` — or, until it arrives, the cached copy of the previous session's.
    public var capabilities: SessionCapabilities? { sessionInfo.capabilities ?? cachedCapabilities }
    /// True while `capabilities` is the UserDefaults cache rather than this session's.
    public var isCapabilitiesCached: Bool { sessionInfo.capabilities == nil && cachedCapabilities != nil }
    /// §16: what the running session applied from the user's extensions (`state.session.extensions`).
    public var extensions: SessionExtensions? { sessionInfo.extensions }
    /// §16: the session runs without user settings because the CLI did not initialize in time; nil once dismissed.
    public var extensionsFallback: ExtensionsFallback? {
        guard projectInfo != nil, let fallback = sessionInfo.extensions?.fallback ?? fallbackFromEvent else { return nil }
        return Self.fallbackKey(fallback) == dismissedFallbackKey ? nil : fallback
    }
    public var pendingPermission: PermissionRequest? { sessionInfo.pendingPermission }
    /// M14: the pending permission decoded as an `AskUserQuestion` prompt; nil for any other tool (or a malformed input).
    public var pendingQuestions: AskUserQuestions? { pendingPermission.flatMap(AskUserQuestions.init) }
    public var branches: [BranchInfo] { branchesInfo.list }
    public var isWorktreeDirty: Bool { branchesInfo.isWorktreeDirty }
    public var isRequestingChanges: Bool { gate.isRequestingChanges }
    public var lastReviewSummary: String? { gate.lastReviewSummary }
    // M13 review-integrity signals (audit 1.1 / 1.2 / 1.3)
    /// Absolute paths of edits outside the project this turn (approved by the user, not in the review).
    public var changedOutside: [String] { gate.changedOutside }
    /// Repo-relative gitignored paths the turn's edit tools wrote (invisible to the review).
    public var ignoredTouched: [String] { gate.ignoredTouched }
    /// Repo-relative changed paths hidden from the list by the checkpoint ignore patterns.
    public var filteredByPattern: [String] { gate.filteredByPattern }
    /// The review list was restored from a previous session by `open_project`.
    public var isReviewRestored: Bool { gate.restored }
    /// `restart_session` is available (audit 1.4).
    public var canRestartSession: Bool { sessionInfo.canRestart }
    /// A project is open but its Claude session is gone: the composer offers "Session ended — Restart".
    public var isSessionEnded: Bool { projectInfo != nil && !sessionInfo.open && !sessionInfo.starting }
    /// Pending files whose current content has not been shown (audit 1.9; §34.5 — "본 뒤 바뀜" files included).
    public var unviewedPendingFiles: [ChangedFile] { pendingFiles.filter { !viewedPaths.contains($0.path) } }
    public var needsGitInit: Bool { gitInitInfo != nil }
    public var gitCandidates: [URL] { (gitInitInfo?.candidates ?? []).map { URL(fileURLWithPath: $0) } }
    public var gitInitLooksUnsafe: Bool { gitInitInfo?.looksUnsafe ?? false }
    /// `node` from the local locator, `claude` from `state.toolchain`; nil until the engine started.
    public var toolchain: Toolchain? {
        nodeToolchain.map {
            Toolchain(nodePath: $0.nodePath, claudePath: engineToolchain.claude, loginPATH: $0.loginPATH,
                      claudeVersion: engineToolchain.claudeVersion)
        }
    }
    public var selectedFile: ChangedFile? { changedFiles.first { $0.path == selectedPathValue } }

    /// Bindable selection for the sidebar list; setting it loads the diff.
    public var selectedPath: String? {
        get { selectedPathValue }
        set {
            codeBrowser.close()   // MARK: code-browser (§47): a file picked in the list shows its diff, not the open project file
            selectFile(changedFiles.first { $0.path == newValue })
        }
    }

    /// `gate.blockedReason` localized.
    public var cannotSendReason: String? {
        if let external = externalTurnNotice { return external }   // wave1 mac-session (§29)
        switch gate.blockedReason {
        case nil: return nil
        case .gitInitNeeded: return String(localized: "Initialize a git repository to continue", bundle: .module)
        case .noSession:
            if isSessionEnded { return String(localized: "Session ended — Restart", bundle: .module) }
            return String(localized: "Open a project first (⌘O)", bundle: .module)
        case .starting: return String(localized: "Starting sidecar…", bundle: .module)
        case .running: return String(localized: "Claude is working…", bundle: .module)
        case .awaitingPermission: return String(localized: "Waiting for permission decision", bundle: .module)
        case .collecting: return String(localized: "Collecting changes…", bundle: .module)
        case .reverting: return String(localized: "Reverting…", bundle: .module)
        case .collectFailed:
            let detail = gate.collectError ?? ""
            return String(localized: "Could not collect changes: \(detail) — Retry", bundle: .module)
        case .pendingReview:
            let pending = gate.pendingCount
            return String(localized: "Review \(pending) pending file(s) to continue", bundle: .module)
        case .changesRequested:
            let requested = gate.changesRequestedCount
            return String(localized: "Send your change request (\(requested) file(s)) to continue", bundle: .module)
        }
    }

    /// nil => switching branches is allowed right now.
    public func branchSwitchBlocker() -> BranchSwitchBlocker? { branchesInfo.switchBlocker }

    // MARK: - Workbenches (docs/M10-WORKBENCHES.md)

    /// This engine's own worktree entry.
    public var currentWorkbench: WorkbenchInfo? {
        workbenches.list.first { $0.isCurrent } ?? workbenches.list.first { $0.path == workbenches.current }
    }
    /// False only when the engine reports this window's worktree as a linked (non-main) worktree.
    public var isMainWorkbench: Bool { currentWorkbench?.isMain ?? true }
    /// The main worktree's folder name (the repository name), falling back to `state.project.name`.
    public var repoDisplayName: String {
        if let main = workbenches.list.first(where: { $0.isMain }) {
            return URL(fileURLWithPath: main.path).lastPathComponent
        }
        return projectInfo?.name ?? projectName
    }
    /// `<repo> — <branch>` for the window title.
    public var windowTitle: String {
        guard projectURL != nil else { return "ReviewGate" }
        let repo = repoDisplayName
        if let branch = projectInfo?.branch { return "\(repo) — \(branch)" }
        return repo
    }
    /// Non-nil while the takeover alert should be shown: the refused `open_project`'s lock holder and folder.
    public var lockConflict: LockConflict? {
        guard lockedProjectURL != nil else { return nil }
        return engineLockConflict ?? refusedLock
    }
    /// The folder whose open was refused (the engine's `lockConflict.path`, else what the window asked for).
    public var lockConflictURL: URL? { engineLockConflict?.path.map { URL(fileURLWithPath: $0) } ?? lockedProjectURL }
    /// Parsed from the `locked_by_other_session:<pid>` reply in case the snapshot's `lockConflict` lags.
    private var refusedLock: LockConflict?
    /// The PR `pr_create` opened last (`state.pr.lastCreatedPR`, as the PR store mirrors it).
    public var lastCreatedPR: CreatedPR? { pr.state.lastCreatedPR }

    // MARK: - Chat sessions (docs/M15-POLISH.md)

    /// `state.sessions.list` (newest first); empty on engines without M15.
    public var sessions: [SessionMeta] { sessionsInfo?.list ?? [] }
    /// The live Claude session's id (`state.sessions.currentId`, falling back to `state.session.sessionId`).
    public var currentSessionId: String? { sessionsInfo?.currentId ?? sessionInfo.sessionId }
    /// The engine reports chat sessions (M15); the tab strip and history are shown only then.
    public var hasChatSessions: Bool { sessionsInfo != nil }
    /// `openTabs` of a `state.sessions` (wave7 w7-state: computed once per change of the list, not per read).
    static func openTabs(_ sessions: SessionsInfo?) -> [SessionMeta] {
        guard let info = sessions else { return [] }
        var ids = info.openTabIds
        if let current = info.currentId, !ids.contains(current) { ids.append(current) }
        let byId = Dictionary(info.list.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ids.compactMap { byId[$0] }
    }
    /// Why switching / creating chats is refused right now; nil when allowed. Mirrors the engine's
    /// `guardSessionSwitch()`: busy, then the cases where the review belongs to *this* chat (a failed
    /// collection, a change request in flight, unsent notes). Plainly pending files do not block —
    /// the review is worktree state that survives the switch.
    public var chatSwitchBlocker: String? {
        guard projectInfo != nil else { return nil }
        switch gatePhase {
        case .starting, .running, .collecting, .reverting: return Self.sessionRefusalText("session_busy")
        case .idle, .reviewing, .collectFailed: break
        }
        if gate.collectError != nil { return Self.sessionRefusalText("collect_failed") }
        if !changesRequestedFiles.isEmpty { return Self.sessionRefusalText("review_pending") }
        if !unsentNotes.isEmpty { return Self.sessionRefusalText("notes_pending") }   // wave2 mac-flow (§34.4): sent notes never block
        return nil
    }
    /// The engine's refusal codes for the session commands, localized; unknown codes pass through.
    nonisolated public static func sessionRefusalText(_ code: String) -> String {
        EngineMessages.refusal(error: code)
    }
    /// Set before `session_open` / `session_new`: the next `transcript_restore` replaces the transcript instead of
    /// pre-filling it (the rows belong to another session).
    var replaceTranscriptOnRestore = false
    /// The last `openTabIds` this client sent, so the current-tab fix-up never loops.
    private var lastTabsSent: [String]?

    // MARK: - Commit (docs/M12-COMMIT.md)

    /// The commit this engine made last (`state.commit.lastCommit`).
    public var lastCommit: LastCommit? { commitState.lastCommit }
    /// Accepted files exist and the gate is not running.
    public var canCommit: Bool { commitState.canCommit }
    /// Repo-relative paths of the files with state `accepted` (what `commit` stages by default).
    public var acceptedPaths: [String] { commitState.acceptedPaths }
    /// The engine's default message (first line of the last instruction + `Files:` list).
    public var suggestedCommitMessage: String { commitState.suggestedMessage }
    /// `user.name` / `user.email` as read at `open_project`.
    public var commitIdentity: CommitIdentity { commitState.identity }

    // MARK: - Lifecycle

    public func openProject(_ url: URL, takeover: Bool = false) async {
        await open(url, command: .openProject(path: url.path, takeover: takeover))
    }

    /// Closes the current session — even with a pending review; the caller confirms that — and opens `url`.
    public func switchProject(to url: URL) async {
        await open(url, command: .switchProject(path: url.path))
    }

    /// `open_project` refused with `locked_by_other_session:<pid>` is not an error row: `lockConflict` is set
    /// and the window asks whether to take the worktree over (`takeOver()`) or stays empty (`cancelTakeover()`).
    private func open(_ url: URL, command: EngineCommand) async {
        resetProjectView()
        cachedCapabilities = AppSettings.cachedCapabilities(defaults: defaults)
        lockedProjectURL = nil
        refusedLock = nil
        do {
            // M20: seed the session the engine is about to start with this project's last mode; the engine's own
            // per-project record (`reviewgate-session.json`) still wins for a project it already knows (§11).
            try await client.send(.setSettings(EngineSettings(
                permissionMode: AppSettings.permissionMode(root: AppSettings.projectKey(url), defaults: defaults))))
            try await client.send(.setSettings(projectSessionSettings(for: url)))   // wave3 mac-session (§36.6): local settings
            _ = try await client.request(command)
            engineStarted = true
            nodeToolchain = await client.toolchain
            enginePID = await client.enginePID
            await settle()
        } catch EngineClientError.refused(let message, _, _, _) where message.hasPrefix("locked_by_other_session") {
            engineStarted = true
            nodeToolchain = await client.toolchain
            enginePID = await client.enginePID
            await settle()
            let pid = Int(message.split(separator: ":", maxSplits: 1).last ?? "") ?? 0
            refusedLock = LockConflict(pid: pid, since: "", client: "")
            lockedProjectURL = url
        } catch {
            // The engine could not be started or died (node missing, sidecar missing, crash): the transcript row is
            // not visible in the empty window, so the banner carries it — with "Reopen" to retry once it is fixed.
            fail(error.localizedDescription, fatal: true, scope: .engine)
            errorBanner?.reopenProject = url
        }
    }

    /// The banner's "Reopen": opens the project again after the engine stopped or failed to start (a new engine is
    /// spawned lazily by the open).
    public func reopenAfterEngineFailure() async {
        guard let url = errorBanner?.reopenProject else { return }
        errorBanner = nil
        await openProject(url)
    }

    /// `open_project{takeover:true}` for the folder whose lock conflict is pending.
    public func takeOver() async {
        guard let url = lockedProjectURL else { return }
        await openProject(url, takeover: true)
    }

    /// Dismisses the takeover alert; the window stays in the empty state.
    public func cancelTakeover() {
        lockedProjectURL = nil
        refusedLock = nil
    }

    /// Closes the session and clears every project-bound state so the empty state (Open Project + recents) shows again.
    public func closeProject() async {
        resetProjectView()
        cachedCapabilities = nil
        cancelTakeover()
        await run(.closeProject)
    }

    /// Runs `git init` in the pending project folder and starts the session.
    public func initRepository() async {
        guard needsGitInit else { return }
        await run(.initRepo, fatal: true)
    }

    /// Dismisses the git-init offer without starting a session.
    public func cancelGitInit() {
        guard needsGitInit else { return }
        fire(.cancelGitInit)
    }

    /// `restart_session` (audit 1.4): a fresh Claude session for the open project; the review list is kept.
    public func restartSession() {
        guard canRestartSession else { return }
        fire(.restartSession)
    }

    /// Stops the engine process (Quit). The client does not respawn afterwards.
    public func shutdown() async {
        diffLoadTask?.cancel()
        diffLoadTask = nil
        await client.stop()
        engineStarted = false
        enginePID = nil
    }

    private func resetProjectView() {
        transcript = []
        dropLiveText()   // MARK: wave7 w7-chat (§45.1)
        promptHistoryCache = nil
        restoredTranscriptIDs = []
        replaceTranscriptOnRestore = false
        lastTabsSent = nil
        lastError = nil
        errorBanner = nil
        selectedPathValue = nil
        selectedDiff = nil
        selectedDiffEndTree = nil
        selectedDiffTruncated = false
        diffLoadTask?.cancel()
        diffLoadTask = nil
        resetReviewRound()   // wave2 mac-flow: viewed marks, ranges, cached diffs, live changes, the round in progress
        reviewHistory = []
        historyLoadError = nil
        closeHistoryDiff()
        hunkRefusal = nil
        transientNotice = nil
        forceRejectRequest = nil
        contextWarning = nil
        attachmentData = [:]
        missingAttachments = []
        attachmentLoads = [:]
        isRewinding = false
        planRefusal = nil
        answeredPlan = nil
        fallbackFromEvent = nil
        fallbackMessage = nil
        dismissedFallbackKey = nil
        side.reset(mainSessionId: nil)
        mcp.reset()
        codeGraph.reset()   // MARK: wave5 w5-graph (§43.3)
        statusLine.reset()   // MARK: wave6 w6-statusline (§44.2)
        codeBrowser.reset()   // MARK: code-browser (§47)
        sideLoadedKey = nil
        resetPermissionView()   // wave1 mac-perms
        resetSessionExtras()   // wave1 mac-session
        resetAgentsView()   // wave3 mac-agents
    }

    // MARK: - Actions

    /// `acceptPending` accepts every pending file first — only ever true when the user picked
    /// "Accept N & Send" explicitly; a plain send leaves the review exactly as it is.
    /// `mentions` (§23) and `images` (§24) go out with the text; the images are seeded into the thumbnail cache.
    public func send(_ text: String, acceptPending: Bool = false, mentions: [String] = [], images: [ComposerImage] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // A normal message supersedes a plan (the engine clears `pendingPlan`), a refused answer included.
        planRefusal = nil
        answeredPlan = nil
        // wave1 mac-session (M7): request/reply — a `gate_closed:*` refusal puts the message back at the front of the queue.
        deliver(withNextMessageModel(QueuedMessage(text: trimmed, mentions: mentions, images: images)), acceptPending: acceptPending)   // wave5 w5-model
    }

    /// §28: `interrupt` also answers an open permission card (deny) — the card shows that right away.
    public func interrupt() {
        guard isRunning else { return }
        markPendingPermissionInterrupted()
        fire(.interrupt)
        armInterruptWatch()   // wave4 w4-safety (robustness-07): "Force restart" when the stop does not stop
    }

    /// §33.1 / §28: the interrupt answers every open request (deny), so every open card turns denied — not just one slot.
    private func markPendingPermissionInterrupted() {
        markOpenPermissionsDenied()   // wave1 mac-perms (AppState+Permissions.swift)
    }

    // MARK: - Composer queue and history

    /// The project's previous prompts, oldest first (the composer's ↑ history).
    /// MARK: wave7 w7-chat — §45.1: decoded once and kept until this window adds a prompt or opens another project.
    public var promptHistory: [String] {
        guard let url = projectURL else { return [] }
        let root = AppSettings.projectKey(url)
        if let cache = promptHistoryCache, cache.root == root { return cache.entries }
        let entries = AppSettings.promptHistory(root: root, defaults: defaults)
        promptHistoryCache = (root, entries)
        return entries
    }

    func recordPrompt(_ text: String) {
        guard let url = projectURL else { return }
        AppSettings.appendPromptHistory(text, root: AppSettings.projectKey(url), defaults: defaults)
        promptHistoryCache = nil   // MARK: wave7 w7-chat (§45.1)
        recordSlashUse(inPrompt: text)   // wave3 mac-session (§36.5): a typed-out command leads the palette next time
    }

    /// Why queued messages are held although nothing failed (a plan or question needs an answer first); nil = not held.
    public var queueHoldReason: String? {
        guard !queuedMessages.isEmpty || sendAfterInterrupt != nil else { return nil }
        if pendingPermission != nil { return String(localized: "Waiting for your permission decision", bundle: .module) }
        if pendingPlan != nil { return String(localized: "Answer the plan first — the queue continues after it", bundle: .module) }
        if let external = externalTurnQueueHold { return external }   // wave1 mac-session (§29)
        return nil
    }

    /// Queues `text`; it goes out (like a manual send) as soon as the session can take it.
    public func enqueue(_ text: String, mentions: [String] = [], images: [ComposerImage] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        queuedMessages.append(withNextMessageModel(QueuedMessage(text: trimmed, mentions: mentions, images: images)))   // wave5 w5-model
        drainQueue()
    }

    public func updateQueued(id: UUID, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let i = queuedMessages.firstIndex(where: { $0.id == id }) else { return }
        if trimmed.isEmpty { queuedMessages.remove(at: i) } else { queuedMessages[i].text = trimmed }
    }

    public func removeQueued(id: UUID) {
        queuedMessages.removeAll { $0.id == id }
        if queuedMessages.isEmpty { queuePausedReason = nil }
    }

    /// Moves a queued message `offset` places (negative = earlier), clamped.
    public func moveQueued(id: UUID, by offset: Int) {
        guard let i = queuedMessages.firstIndex(where: { $0.id == id }) else { return }
        let target = min(max(i + offset, 0), queuedMessages.count - 1)
        guard target != i else { return }
        let item = queuedMessages.remove(at: i)
        queuedMessages.insert(item, at: target)
    }

    public func clearQueue() {
        queuedMessages = []
        queuePausedReason = nil
    }

    /// Restarts auto-sending after an error stopped it.
    public func resumeQueue() {
        queuePausedReason = nil
        drainQueue()
    }

    /// "Stop and send" (§28): `interrupt`, then the `send` right behind it on the engine's main lane — the interrupt's
    /// reply waits for the turn's end and collection, so the send goes out instead of being refused. An older engine
    /// that still refuses it (`gate_closed:running`) gets the message again once the turn has ended (before the queue).
    public func interruptAndSend(_ text: String, mentions: [String] = [], images: [ComposerImage] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // wave5 w5-model (§43.4): the composer's one-message model goes with this message (`send` below takes it itself).
        let base = QueuedMessage(text: trimmed, mentions: mentions, images: images)
        let message = isRunning || !canSend || queuedSendInFlight ? withNextMessageModel(base) : base
        if isRunning {
            sendAfterInterrupt = trimmed
            pendingInterruptSend = message
            markPendingPermissionInterrupted()
            planRefusal = nil
            answeredPlan = nil
            recordPrompt(trimmed)
            seedAttachments(images)
            let send = message.sendCommand(acceptPending: false)   // wave5 w5-model (§43.4: `.send`, or with this message's model)
            if requestSink == nil, let commandSink {
                commandSink(.interrupt)
                commandSink(send)
                return
            }
            fire(.interrupt)
            Task { await sendBehindInterrupt(send, message: message) }
        } else if canSend, !queuedSendInFlight {
            send(trimmed, mentions: mentions, images: images)
        } else {
            queuedMessages.insert(message, at: 0)
            drainQueue()
        }
    }

    private func sendBehindInterrupt(_ command: EngineCommand, message: QueuedMessage) async {
        do {
            try await request(command)
            if pendingInterruptSend?.id == message.id { pendingInterruptSend = nil; sendAfterInterrupt = nil }
        } catch let error as EngineClientError where error.refusalCode == "gate_closed" {
            // Older engine: the interrupt replied before the turn ended — drained after it (`drainQueue`).
            if pendingInterruptSend?.id == message.id { interruptFallback = true }
            drainQueue()
        } catch {
            if pendingInterruptSend?.id == message.id { pendingInterruptSend = nil; sendAfterInterrupt = nil }
            queuedMessages.insert(message, at: 0)
            pauseQueue((error as? EngineClientError)?.userMessage ?? error.localizedDescription)
        }
    }

    /// Sends the next queued message when the session can take one: a pending review does not hold it (a send never
    /// changes the review, exactly like a manual send); a permission / plan waiting for an answer, an error, or the
    /// previous queued message still on its way do.
    func drainQueue() {
        guard canSend, !queuedSendInFlight, pendingPermission == nil, pendingPlan == nil, !isAnsweringPlan else { return }
        // wave1 mac-session (M7): after a `gate_closed:*` refusal, wait for a newer snapshot instead of resending into it.
        guard queueGateReopened() else { return }
        let next: QueuedMessage
        if let first = sendAfterInterrupt {
            // §28: with a current engine the send already went out behind the interrupt; only the fallback re-sends.
            if pendingInterruptSend != nil, !interruptFallback { return }
            sendAfterInterrupt = nil
            next = pendingInterruptSend ?? QueuedMessage(text: first)
            pendingInterruptSend = nil
            interruptFallback = false
        } else {
            guard queuePausedReason == nil, !queuedMessages.isEmpty else { return }
            next = queuedMessages.removeFirst()
        }
        queuedSendInFlight = true
        deliver(next, acceptPending: false)   // wave1 mac-session (M7): the same message (id) goes back to the queue if refused
    }

    /// Auto-sending stops on an error (the user sees why and resumes).
    func pauseQueue(_ reason: String) {
        queuedSendInFlight = false
        guard !queuedMessages.isEmpty || sendAfterInterrupt != nil else { return }
        if let pending = sendAfterInterrupt {
            if pendingInterruptSend == nil || interruptFallback {
                queuedMessages.insert(pendingInterruptSend ?? QueuedMessage(text: pending), at: 0)
            }
            sendAfterInterrupt = nil
            pendingInterruptSend = nil
            interruptFallback = false
        }
        queuePausedReason = reason
    }

    /// Attention bookkeeping + the queue after each snapshot.
    private func afterSnapshot(projectChanged: Bool) {
        if projectChanged {
            turnInFlight = false
            turnStopReason = nil   // wave4 w4-safety
            // Queued messages were written for the project that was open.
            queuedMessages = []
            sendAfterInterrupt = nil
            pendingInterruptSend = nil
            interruptFallback = false
            queuePausedReason = nil
            queuedSendInFlight = false
        }
        let phase = state.gate.phase
        if phase == .running || phase == .starting { queuedSendInFlight = false }
        if phase == .running { turnInFlight = true }
        if turnInFlight, phase == .reviewing || phase == .idle || phase == .collectFailed {
            turnInFlight = false
            let pending = state.gate.pendingCount + state.gate.changesRequestedCount
            // wave4 w4-safety (daily-14): says why the turn stopped (usage limit, login, error) when it did.
            if let event = turnFinishedAttention(pending: pending, key: "turn:\(state.seq)") { onAttention?(event) }
        }
        longWorkSnapshotApplied()   // wave4 w4-longwork (§38.2): "풀리면 이어서 하기" fires once the session is idle
        drainQueue()
    }

    // MARK: - Per-project allow patterns

    /// Patterns "Always allow in this project" saved for the open project.
    public var projectAllowPatterns: [String] {
        guard let url = projectURL else { return [] }
        return AppSettings.projectBashAllowPatterns(root: AppSettings.projectKey(url), defaults: defaults)
    }

    /// Saves `pattern` for the open project and pushes the merged list to the running engine.
    public func addProjectAllowPattern(_ pattern: String) {
        guard let url = projectURL else { return }
        let root = AppSettings.projectKey(url)
        var list = AppSettings.projectBashAllowPatterns(root: root, defaults: defaults)
        guard !list.contains(pattern) else { return }
        list.append(pattern)
        AppSettings.setProjectBashAllowPatterns(list, root: root, defaults: defaults)
        pushPermissionSettings()
    }

    public func removeProjectAllowPattern(_ pattern: String) {
        guard let url = projectURL else { return }
        let root = AppSettings.projectKey(url)
        AppSettings.setProjectBashAllowPatterns(AppSettings.projectBashAllowPatterns(root: root, defaults: defaults).filter { $0 != pattern },
                                                root: root, defaults: defaults)
        pushPermissionSettings()
    }

    /// `set_settings{autoAllowReadOnlyBash, bashAllowPatterns}` with the global + this project's patterns.
    public func pushPermissionSettings() {
        guard engineStarted || commandSink != nil else { return }
        let root = projectURL.map(AppSettings.projectKey)
        fire(.setSettings(EngineSettings(autoAllowReadOnlyBash: AppSettings.autoAllowReadOnlyBash(defaults: defaults),
                                         bashAllowPatterns: AppSettings.effectiveBashAllowPatterns(root: root, defaults: defaults))))
    }

    /// `remember` (M16): also auto-allow this tool + command prefix for the rest of the session.
    /// §33.1 (wave1 mac-perms): answers the shortcut target — the oldest open request that is not a question — by its own
    /// `requestId`; a card answers its own request with `respondPermission(requestId:…)`.
    public func respondPermission(allow: Bool, message: String? = nil, remember: Bool = false) {
        guard let req = shortcutPermission else { return }
        respondPermission(requestId: req.requestId, allow: allow, message: message, remember: remember)
    }

    // MARK: - Permission modes (docs/M20-MODES.md)

    /// `set_permission_mode{mode}`: switches the live session and remembers the choice for this project.
    /// No-op when the mode is unchanged or the engine would refuse it now (`session_busy`: plan mode during a turn, a start,
    /// a collection; §39.5 `canSetPermissionMode(to:)`).
    public func setPermissionMode(_ mode: PermissionMode) {
        guard mode != permissionMode, canSetPermissionMode(to: mode) else { return }
        state.session.permissionMode = mode
        rememberPermissionMode(mode)
        fire(.setPermissionMode(mode: mode))
    }

    /// `plan_response{approve:true, mode}`: leaves plan mode into `mode` and lets the engine queue the
    /// follow-up instruction (`message`, or the engine's default "Implement the approved plan at …").
    public func approvePlan(mode: PermissionMode = .default, message: String? = nil) {
        answerPlan(.planResponse(approve: true, mode: mode, message: trimmedOrNil(message)))
    }

    /// `plan_response{approve:false}`: stays in plan mode; `message` is the optional note for the revision.
    public func keepPlanning(message: String? = nil) {
        answerPlan(.planResponse(approve: false, message: trimmedOrNil(message)))
    }

    /// §19.5: `plan_response` as request/reply. The card hides right away; a refusal (`gate_closed:*`,
    /// `plan_followup_failed`, `no_plan`, …) brings it back with the reason instead of vanishing silently. While a turn
    /// runs / collects / reverts the answer waits (`isPlanLocked`) and the card says why.
    func answerPlan(_ command: EngineCommand) {
        guard let plan = pendingPlan else { return }
        if isPlanLocked {
            planRefusal = Self.sessionRefusalText(isReverting ? "reverting" : "session_running")
            answeredPlan = plan
            return
        }
        answeredPlan = plan
        planRefusal = nil
        state.session.pendingPlan = nil
        if requestSink == nil, let commandSink { commandSink(command); return }
        isAnsweringPlan = true
        Task {
            defer { isAnsweringPlan = false }
            do {
                try await request(command)
                answeredPlan = nil
            } catch let error as EngineClientError {
                // The engine restores `pendingPlan` itself for plan_followup_failed; the card shows `answeredPlan` until then.
                planRefusal = error.userMessage
                appendLog("[warn] plan_response: \(error.localizedDescription)")
            } catch {
                planRefusal = error.localizedDescription
            }
        }
    }

    public func dismissPlanRefusal() {
        planRefusal = nil
        answeredPlan = nil
    }

    private func trimmedOrNil(_ text: String?) -> String? {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Stores the mode for the open project (and as the last mode used anywhere, which seeds `hello`).
    func rememberPermissionMode(_ mode: PermissionMode) {
        AppSettings.setPermissionMode(mode, root: projectURL.map(AppSettings.projectKey), defaults: defaults)
    }

    /// M16: clears the session's remembered allows (`forget_allows`).
    public func forgetAllows() {
        guard !rememberedAllows.isEmpty else { return }
        state.session.rememberedAllows = []
        fire(.forgetAllows)
    }

    /// `set_settings{autoAllowReadOnlyBash, bashAllowPatterns}` (M16) on a running engine.
    public func updatePermissionSettings(autoAllowReadOnlyBash: Bool, bashAllowPatterns: [String]) {
        guard engineStarted else { return }
        fire(.setSettings(EngineSettings(autoAllowReadOnlyBash: autoAllowReadOnlyBash, bashAllowPatterns: bashAllowPatterns)))
    }

    /// M14: answers the pending `AskUserQuestion` request. Per the Agent SDK the reply is `allow` with
    /// `updatedInput = { questions: <original>, answers: { "<question text>": "<label>" } }` — multi-select labels
    /// joined with ", ", free text as typed. The transcript row keeps the `updatedInput` so it can show the answers.
    /// §33.1 (wave1 mac-perms): the oldest open `AskUserQuestion` request; a card answers its own with `requestId:`.
    public func answerQuestions(answers: [String: String]) {
        guard let req = pendingPermission, req.toolName == AskUserQuestions.toolName else { return }
        answerQuestions(requestId: req.requestId, answers: answers)
    }

    /// M14: declines the pending `AskUserQuestion` request; Claude is told the user skipped it.
    public func skipQuestions() {
        guard let req = pendingPermission, req.toolName == AskUserQuestions.toolName else { return }
        skipQuestions(requestId: req.requestId)
    }

    /// Applies live to the running session (`set_settings{budget}`).
    public func updateBudget(_ newBudget: Budget) {
        state.budget = newBudget
        fire(.setSettings(EngineSettings(budget: newBudget)))
    }

    /// `set_settings{worktreeRoot}` on a running engine; a stopped one re-reads the setting with its next `hello`.
    public func updateWorktreeRoot(_ path: String) {
        guard engineStarted else { return }
        fire(.setSettings(EngineSettings(worktreeRoot: path)))
    }

    /// `set_settings{commitPushByDefault, commitTrailer}` (M12) on a running engine.
    public func updateCommitSettings(pushByDefault: Bool, trailer: String) {
        guard engineStarted else { return }
        fire(.setSettings(EngineSettings(commitPushByDefault: pushByDefault, commitTrailer: trailer)))
    }

    /// `set_settings{autoRestartSession}` (M13) on a running engine.
    public func updateAutoRestartSession(_ enabled: Bool) {
        guard engineStarted else { return }
        fire(.setSettings(EngineSettings(autoRestartSession: enabled)))
    }

    /// Clears the error banner (the transcript row stays).
    public func dismissErrorBanner() {
        errorBanner = nil
    }

    /// `auth_required`: Terminal with `claude /login` (the engine's `claude`, else the Settings override, else PATH).
    public func openClaudeLogin() {
        let command = TerminalLauncher.claudeLoginCommand(claudePath: state.toolchain.claude ?? AppSettings.claudePathOverride(defaults: defaults))
        do {
            try TerminalLauncher.open(command, path: nodeToolchain?.loginPATH)
        } catch {
            fail(error.localizedDescription, fatal: false)
        }
    }

    /// The banner's "Restart session" (`session_crashed`, `cli_not_found`).
    public func restartSessionFromBanner() {
        errorBanner = nil
        if canRestartSession { fire(.restartSession) }
    }

    // MARK: - Review gate

    public func selectFile(_ file: ChangedFile?) {
        diffLoadTask?.cancel()
        diffLoadTask = nil
        if hunkRefusal?.path != file?.path { hunkRefusal = nil }
        selectedPathValue = file?.path
        selectedDiff = nil
        selectedDiffEndTree = nil
        selectedDiffTruncated = false
        selectedDiffInfo = FileDiffInfo()
        if file != nil { closeLiveDiff() }   // wave2 mac-flow: a review file replaces the live view
        guard let file else { return }
        // wave2 mac-flow (§34.1–34.2): its range, from the cache of (path, range, B), else select_file{since} — also
        // while a turn runs (read-only); without a B the diff shown before stays.
        loadSelectedDiff(file)
    }

    /// A `file_diff` reply for the selected `path`: cached with the tree it describes and shown. `since` / `tree`: the
    /// range and the B it was requested for (the cache key; default: the reply's range on the current B).
    func showDiff(_ diff: FileDiff, truncated: Bool, endTree: String?, for path: String, info: FileDiffInfo = FileDiffInfo(),
                  since: DiffSince? = nil, tree: String? = nil) {
        let range = since ?? info.since ?? .review
        let entry = ReviewDiffEntry(diff: diff, truncated: truncated, endTree: endTree, info: info)
        if let key = tree ?? reviewTree ?? endTree { reviewDiffs[ReviewDiffKey(path: path, since: range, tree: key)] = entry }
        present(entry, since: range)
    }

    public func accept(_ file: ChangedFile) {
        // wave2 mac-flow (§34.2): accept also applies while a turn runs on a standing review.
        guard changedFiles.contains(where: { $0.path == file.path && $0.state == .pending }), !acceptLockedNotice() else { return }
        fireReviewAction(.accept(paths: [file.path]))
        lastAcceptedPath = file.path
        // Selection is client state: move on to the next pending file on screen right away (comp-10: the list's order).
        if selectedPathValue == file.path, let next = pendingAfter(file.path) { selectFile(next) }
    }

    /// Undoes an accept: the file is pending again (refused by the engine while a turn runs or collects).
    public func unaccept(_ file: ChangedFile) {
        guard changedFiles.contains(where: { $0.path == file.path && $0.state == .accepted }) else { return }
        fireReviewAction(.unaccept(paths: [file.path]))
        if lastAcceptedPath == file.path { lastAcceptedPath = nil }
    }

    /// What Review › Undo Accept undoes: the selected file when it is accepted, else the file accepted last while it still is
    /// (after ⌘⇧A the selection is already on the next pending file).
    public var undoAcceptTarget: ChangedFile? {
        if let selected = selectedFile, selected.state == .accepted { return selected }
        guard let path = lastAcceptedPath else { return nil }
        return changedFiles.first { $0.path == path && $0.state == .accepted }
    }

    /// Review › Undo Accept (⌘⇧U): `undoAcceptTarget` is pending again and selected, so its diff is back on screen.
    public func undoAccept() {
        guard let file = undoAcceptTarget, !isReviewLocked else { return }
        unaccept(file)
        codeBrowser.close()   // code-browser (§47): as ⌘] — the file's diff is what it shows
        if selectedPathValue != file.path { selectFile(file) }
    }

    public func reject(_ file: ChangedFile) {
        guard changedFiles.contains(where: { $0.path == file.path && $0.state == .pending }), !rejectLockedNotice() else { return }
        // wave1 mac-review — §31 / §32: an uncaptured file cannot be reverted; an external one is confirmed first.
        if holdReject(of: file) { return }
        fireReject(.reject(paths: [file.path]))
        // Like accept (audit 1.11): move on to the next pending file right away.
        if selectedPathValue == file.path, let next = pendingAfter(file.path) { selectFile(next) }
    }

    /// ⌘] (audit 1.11): the pending file after the selection, wrapping around; nil-op without pending files.
    public func selectNextPending() {
        guard let next = neighbourPending(forward: true) else { return }
        codeBrowser.close()   // code-browser (§47)
        selectFile(next)
    }

    /// ⌘[ : the pending file before the selection, wrapping around.
    public func selectPreviousPending() {
        guard let previous = neighbourPending(forward: false) else { return }
        codeBrowser.close()   // code-browser (§47)
        selectFile(previous)
    }

    private func neighbourPending(forward: Bool) -> ChangedFile? {
        let files = displayOrderedFiles   // wave2 mac-flow (comp-10): the order on screen, risk first included
        let pending = files.indices.filter { files[$0].state == .pending }
        guard !pending.isEmpty else { return nil }
        let current = files.firstIndex { $0.path == selectedPathValue } ?? (forward ? -1 : files.count)
        if forward {
            return files[pending.first { $0 > current } ?? pending[0]]
        }
        return files[pending.last { $0 < current } ?? pending[pending.count - 1]]
    }

    // MARK: - Review comprehension (docs/PROTOCOL.md §12–13)

    /// Changed files that were shown in this review (`viewedPaths` ∩ `changedFiles`).
    public var viewedChangedCount: Int { changedFiles.filter { viewedPaths.contains($0.path) }.count }

    /// The changed file at `path` (repo-relative, or absolute inside the project — as plans and agents name files); nil when
    /// it is not in the review.
    public func changedFile(path: String) -> ChangedFile? {
        let rel = RepoPath.relative(path, root: projectInfo?.root ?? projectInfo?.path)
        return changedFiles.first { $0.path == rel }
    }

    /// Selects the changed file at `path` (repo-relative, or absolute inside the project); false when it is not in the review.
    @discardableResult
    public func selectFile(path: String) -> Bool {
        guard let file = changedFile(path: path) else { return false }
        codeBrowser.close()   // code-browser (§47): a link to a changed file shows its diff
        if selectedPathValue != file.path { selectFile(file) }
        return true
    }

    /// The kept full output of a Bash `tool_result` (`tool_output`); nil output when the engine has none
    /// (evicted, short, or before an engine restart) — the caller falls back to the preview.
    public func fetchToolOutput(toolUseId: String) async -> (output: String?, truncated: Bool) {
        do {
            let reply = try await client.request(.toolOutput(toolUseId: toolUseId))
            if case let .toolOutput(_, _, output, truncated) = reply { return (output, truncated) }
        } catch {
            appendLog("[warn] tool_output \(toolUseId): \(error.localizedDescription)")
        }
        return (nil, false)
    }

    /// Audit 1.9: paths whose edits deserve a second look before a bulk accept (agent config, workflows, secrets).
    nonisolated public static func isSensitivePath(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        if path.hasPrefix(".claude/") || path.contains("/.claude/") { return true }
        if path.hasPrefix(".github/workflows/") || path.contains("/.github/workflows/") { return true }
        if name == ".mcp.json" || name == "CLAUDE.md" { return true }
        if name.hasPrefix(".env") || name.contains(".env.") || name.hasSuffix(".env") { return true }
        return false
    }

    public func acceptAll() {
        guard !pendingFiles.isEmpty, !acceptLockedNotice() else { return }   // wave2 mac-flow: also during a turn (§34.2)
        fireReviewAction(.acceptAll)
    }

    /// §31: `includeExternal` also reverts the files nothing of Claude's explains — only after the user confirmed them.
    public func rejectAll(includeExternal: Bool = false) {
        guard !pendingFiles.isEmpty, !rejectLockedNotice() else { return }
        sendRejectAll(includeExternal: includeExternal)   // wave1 mac-review
    }

    /// §19.1: `reject` / `reject_all` as request/reply. Refused with `file_changed_since_review` (+ `paths`) — nothing
    /// was reverted — the window asks before re-sending it with `force: true`; other refusals become an error row.
    func fireReject(_ command: EngineCommand) {
        if requestSink == nil, let commandSink { commandSink(command); return }
        Task { await sendReject(command) }
    }

    func sendReject(_ command: EngineCommand) async {
        do {
            try await request(command)
        } catch let error as EngineClientError where error.refusalCode == "file_changed_since_review" {
            guard case let .refused(message, _, paths, _) = error else { return }
            let edited = paths.isEmpty ? Self.pathsOfRefusal(message) : paths
            forceRejectRequest = ForceRejectRequest(command: command, paths: edited)
        } catch let error as EngineClientError {
            fail(error.userMessage, fatal: false)
        } catch {
            fail(error.localizedDescription, fatal: false)
        }
    }

    /// Older engines without `paths`: `file_changed_since_review:<p1>, <p2>`.
    nonisolated static func pathsOfRefusal(_ message: String) -> [String] {
        EngineMessages.detail(of: message, code: "file_changed_since_review")
            .components(separatedBy: ", ").filter { !$0.isEmpty }
    }

    /// The alert's destructive "되돌리기": the same reject with `force: true` (the user's own edits are discarded).
    public func confirmForceReject() {
        guard let request = forceRejectRequest else { return }
        forceRejectRequest = nil
        let forced: EngineCommand
        switch request.command {
        case let .reject(paths, _): forced = .reject(paths: paths, force: true)
        case let .rejectAll(_, includeExternal): forced = .rejectAll(force: true, includeExternal: includeExternal)
        case let .rewind(toTurn, mode, editText, mentions, attachments, _):
            // §26: the same rewind again, overwriting the user's own edits of those files.
            Task { await sendRewind(.rewind(toTurn: toTurn, mode: mode, editText: editText, mentions: mentions, attachments: attachments, force: true)) }
            return
        default: return
        }
        fireReject(forced)
    }

    /// The alert's cancel: nothing is reverted, every file stays as it is.
    public func cancelForceReject() {
        forceRejectRequest = nil
    }

    /// §26: after a `rewind` the review was re-diffed by the engine — every cached diff is stale; the selected file reloads.
    /// The viewed marks stay: a rewound file's content changed, so it is "본 뒤 바뀜" by itself (§34.5).
    func reloadReviewAfterRewind() {
        reviewDiffs = [:]
        let current = changedFiles.first { $0.path == selectedPathValue }
        selectFile(current ?? firstFileOnScreen)
    }

    /// Re-runs the end-of-turn collection after `reviewCollectFailed`.
    public func retryCollectReview() {
        guard reviewCollectFailed != nil, !isSnapshotting else { return }
        fire(.retryCollect)
    }

    /// New content of `file` with the changed line numbers of its range (`full_file{since}`); answered from the held B
    /// while a turn runs (§34.2, `stale`).
    public func fullFile(for file: ChangedFile) async throws -> FullFileView {
        guard reviewTree != nil else { throw FullFileViewError.noReview }
        let reply = try await typedReply(.fullFile(path: file.path, since: diffSince(for: file).wire))
        guard case let .fullFileContent(_, view) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return view
    }

    // MARK: - Branches

    /// Reloads `state.branches` (and `projectInfo.branch`). Failures only go to `logs`.
    public func refreshBranches() async {
        guard projectInfo != nil else { return }
        do {
            _ = try await client.request(.branches)
            await settle()
        } catch {
            appendLog("[warn] refreshBranches: \(error.localizedDescription)")
        }
    }

    /// `git switch <name>`; errors go to the transcript (engine `error{scope:"git"}`).
    public func switchBranch(_ name: String) async {
        guard projectInfo != nil, branchSwitchBlocker() == nil else { return }
        await run(.switchBranch(name: name), reportFailure: false)
    }

    /// `git switch -c <name>` from HEAD; errors go to the transcript.
    public func createBranch(_ name: String) async {
        guard projectInfo != nil, branchSwitchBlocker() == nil else { return }
        await run(.createBranch(name: name), reportFailure: false)
    }

    // MARK: - Workbenches

    /// `workbench_list` → `state.workbenches`. Failures only go to `logs` (older engines refuse it).
    public func refreshWorkbenches() async {
        guard projectInfo != nil else { return }
        do {
            _ = try await client.request(.workbenchList)
            await settle()
        } catch {
            appendLog("[warn] refreshWorkbenches: \(error.localizedDescription)")
        }
    }

    /// `git worktree add` under the managed root; returns the new worktree's folder (from the refreshed list),
    /// nil on refusal with the engine's code (`branch_in_use:<path>`, `path_exists:<path>`, …) in `lastError`.
    public func createWorkbench(branch: String, from: String? = nil, options: WorkbenchCreateOptions = WorkbenchCreateOptions()) async -> URL? {
        guard projectInfo != nil else { return nil }
        flow.beginCreate(branch: branch)   // wave3 mac-flow (§36.12): its workbench_progress steps, with this project's setup
        defer { flow.endCreate() }
        await sendFlowSettings()
        do {
            _ = try await client.request(.workbenchCreate(branch: branch, from: from, options: options))
            await settle()
        } catch {
            appendLog("[warn] createWorkbench: \(error.localizedDescription)")
            lastError = error.localizedDescription
            return nil
        }
        if !workbenches.list.contains(where: { $0.branch == branch }) { await refreshWorkbenches() }
        return workbenches.list.first { $0.branch == branch }.map { URL(fileURLWithPath: $0.path) }
            ?? flow.createdPath.map { URL(fileURLWithPath: $0) }   // wave3 mac-flow
    }

    /// `git worktree remove [--force]`; returns the engine's refusal text (dirty / in use / main) or nil on success.
    @discardableResult
    public func removeWorkbench(path: String, force: Bool = false) async -> String? {
        guard projectInfo != nil else { return nil }
        do {
            _ = try await client.request(.workbenchRemove(path: path, force: force))
            await settle()
            return nil
        } catch {
            appendLog("[warn] removeWorkbench: \(error.localizedDescription)")
            return error.localizedDescription
        }
    }

    /// `git worktree prune`, then refreshes the list.
    public func pruneWorkbenches() async {
        guard projectInfo != nil else { return }
        await run(.workbenchPrune)
        await refreshWorkbenches()
    }

    /// `pr_create` for the current branch (M10.1); returns the PR URL from the `pr_created` reply (also mirrored in
    /// `state.pr.lastCreatedPR`) or nil on failure with the engine's code (`no_remote`, `detached_head`, …) in `lastError`.
    public func createPR(base: String, title: String?, body: String?, draft: Bool) async -> String? {
        guard projectInfo != nil else { return nil }
        do {
            let reply = try await client.request(.prCreate(base: base, title: title, body: body, draft: draft ? true : nil))
            engineStarted = true
            guard case let .prCreated(_, url, _) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            await settle()
            return url
        } catch {
            appendLog("[warn] createPR: \(error.localizedDescription)")
            lastError = error.localizedDescription
            return nil
        }
    }

    // MARK: - Commit

    /// `commit{message, paths, push}` (M12); returns the commit from the `committed` reply (also mirrored in
    /// `state.commit.lastCommit`) or nil on refusal with the engine's code (`nothing_to_commit`, `empty_message`,
    /// `git_identity_missing`, …) in `lastError`. `push_failed:<detail>` still returns the commit (it exists;
    /// `lastCommit.pushError` carries the detail).
    public func commitAccepted(message: String, paths: [String]? = nil, push: Bool? = nil) async -> LastCommit? {
        guard projectInfo != nil else { return nil }
        let before = lastCommit?.sha
        do {
            let reply = try await client.request(.commit(message: message, paths: paths, push: push))
            engineStarted = true
            guard case let .committed(_, sha, shortSha, pushed, branch) = reply else {
                throw EngineClientError.unexpectedReply(String(describing: reply))
            }
            await settle()
            return lastCommit.flatMap { $0.sha == sha ? $0 : nil }
                ?? LastCommit(sha: sha, shortSha: shortSha, message: message, branch: branch, pushed: pushed, files: paths ?? [])
        } catch EngineClientError.refused(let code, _, _, _) {
            engineStarted = true
            lastError = code
            await settle()
            // `push_failed:…` / `no_remote` after a successful commit: the commit exists (`lastCommit.pushError` set),
            // the banner offers "Push now".
            if let last = lastCommit, last.sha != before { return last }
            appendLog("[warn] commit: \(code)")
            return nil
        } catch {
            appendLog("[warn] commit: \(error.localizedDescription)")
            lastError = error.localizedDescription
            return nil
        }
    }

    /// `push{}`: retries the push of `lastCommit` after `push_failed`; the refusal code lands in `lastError`.
    public func pushNow() async {
        guard projectInfo != nil, lastCommit != nil else { return }
        do {
            _ = try await client.request(.push)
            engineStarted = true
            await settle()
        } catch {
            appendLog("[warn] push: \(error.localizedDescription)")
            lastError = error.localizedDescription
        }
    }

    // MARK: - Chat sessions

    /// `session_new`: stops the current Claude session and starts a fresh one; the transcript is cleared by the
    /// engine's `transcript_restore {items: []}`. Returns false on refusal (`chatSwitchBlocker` / `lastError`).
    @discardableResult
    public func newChat() async -> Bool {
        guard projectInfo != nil else { return false }
        return await switchSession(.sessionNew)
    }

    /// `session_open{id}`: resumes `id`; its rows replace the transcript. No-op for the current session.
    @discardableResult
    public func openChat(id: String) async -> Bool {
        guard projectInfo != nil, id != currentSessionId else { return false }
        return await switchSession(.sessionOpen(id: id))
    }

    private func switchSession(_ command: EngineCommand) async -> Bool {
        // MARK: wave4b w4b-side — §40.3: a running side answer ends with the switch — ask first.
        if let warning = SideTrust.switchWarning(runningCount: side.runningCount), let confirm = confirmSideSwitch, !confirm(warning) { return false }
        replaceTranscriptOnRestore = true
        if let commandSink { commandSink(command); return true }
        do {
            _ = try await client.request(command)
            engineStarted = true
            await settle()
            return true
        } catch {
            replaceTranscriptOnRestore = false
            appendLog("[warn] \(command.type): \(error.localizedDescription)")
            // A refusal (`session_busy`, `review_pending`, …) becomes a non-fatal error row so the user sees why.
            if case EngineClientError.refused(let code, _, _, _) = error { fail(Self.sessionRefusalText(code), fatal: false) }
            else { fail(error.localizedDescription, fatal: false) }
            return false
        }
    }

    /// Removes `id` from the open tabs (`tabs_set`); the session stays in the history. Closing the current chat's
    /// tab switches to its neighbour first, and is refused (false) while switching is blocked or it is the only tab.
    @discardableResult
    public func closeTab(id: String) async -> Bool {
        guard let info = state.sessions else { return false }
        var ids = info.openTabIds
        if let current = info.currentId, !ids.contains(current) { ids.append(current) }
        guard let index = ids.firstIndex(of: id) else { return false }
        ids.remove(at: index)
        if id == info.currentId {
            guard chatSwitchBlocker == nil, !ids.isEmpty else { return false }
            let neighbour = ids[min(index, ids.count - 1)]
            guard await openChat(id: neighbour) else { return false }
        }
        setTabs(ids)
        return true
    }

    /// `tabs_set{openTabIds}`; the engine stores the list per worktree.
    public func setTabs(_ ids: [String]) {
        guard state.sessions != nil, ids != lastTabsSent else { return }
        lastTabsSent = ids
        fire(.tabsSet(openTabIds: ids))
    }

    /// Moves a tab (drag / keyboard reorder) — same `tabs_set`.
    public func moveTab(id: String, to newIndex: Int) {
        var ids = openTabs.map(\.id)
        guard let from = ids.firstIndex(of: id) else { return }
        ids.remove(at: from)
        ids.insert(id, at: max(0, min(newIndex, ids.count)))
        setTabs(ids)
    }

    public func renameChat(id: String, title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, sessions.contains(where: { $0.id == id }) else { return }
        fire(.sessionRename(id: id, title: trimmed))
    }

    public func archiveChat(id: String, archived: Bool) {
        guard sessions.contains(where: { $0.id == id }) else { return }
        fire(.sessionArchive(id: id, archived: archived))
    }

    /// `session_delete`; refused by the engine for the current session (`session_current`, in `lastError`).
    @discardableResult
    public func deleteChat(id: String) async -> Bool {
        guard sessions.contains(where: { $0.id == id }), id != currentSessionId else { return false }
        if let commandSink { commandSink(.sessionDelete(id: id)); return true }
        do {
            _ = try await client.request(.sessionDelete(id: id))
            engineStarted = true
            await settle()
            return true
        } catch {
            if case EngineClientError.refused(let code, _, _, _) = error { lastError = Self.sessionRefusalText(code) } else { lastError = error.localizedDescription }
            appendLog("[warn] session_delete: \(error.localizedDescription)")
            return false
        }
    }

    /// `session_list` → `state.sessions` (older engines refuse it; only logged).
    public func refreshSessions() async {
        guard projectInfo != nil else { return }
        do {
            _ = try await client.request(.sessionList)
            await settle()
        } catch {
            appendLog("[warn] session_list: \(error.localizedDescription)")
        }
    }

    // MARK: - Refresh (docs/M15-POLISH.md)

    /// `refresh{scope}` (nil → everything applicable: a pending review is re-diffed against the working tree, then
    /// branches / workbenches / PRs / accounts). Engines without M15 refuse it: the PR list is refreshed the old way.
    public func refresh(scope: [RefreshScope]? = nil) async {
        guard projectInfo != nil || scope == [.pr] || scope == [.accounts], !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        if let commandSink { commandSink(.refresh(scope: scope)); return }
        do {
            _ = try await client.request(.refresh(scope: scope))
            engineStarted = true
            await settle()
        } catch {
            appendLog("[warn] refresh: \(error.localizedDescription)")
            if scope == nil || scope?.contains(.pr) == true { await pr.refresh() }
        }
    }

    // MARK: - Request changes

    public func addNote(path: String, line: Int?, side: DiffSide, excerpt: String, body: String) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        fireReviewAction(.addNote(path: path, line: line, side: side, excerpt: excerpt, body: text))
    }

    public func removeNote(id: String) {
        fireReviewAction(.removeNote(noteId: id))
    }

    /// Replaces an unsent note's text (the engine refuses a sent one).
    public func editNote(id: String, body: String) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        fireReviewAction(.editNote(noteId: id, body: text))
    }

    /// Sends the notes back to Claude as the next turn (engine builds the message). Bypasses `canSend`.
    public func requestChanges(extraMessage: String?, noteIds: [String]? = nil) {
        guard canRequestChanges else { return }
        fire(.requestChanges(extra: extraMessage, noteIds: noteIds))
    }

    // MARK: - Hunk-level reject (docs/PROTOCOL.md §17)

    /// `reject_hunks{path, hunks, expectedEndTree}`: reverts the selected hunks of the shown diff on disk. On success the
    /// engine re-snapshots B, so the diff is re-requested; a refusal is kept in `hunkRefusal` (localized, with a remedy).
    /// Returns true when the engine applied it.
    @discardableResult
    public func rejectHunks(_ file: ChangedFile, hunks: [Int]) async -> Bool {
        guard !hunks.isEmpty, changedFiles.contains(where: { $0.path == file.path && $0.state == .pending }) else { return false }
        if isReviewLocked {
            hunkRefusal = (file.path, HunkRefusal.from(isReverting ? "reverting" : "session_running"))
            return false
        }
        if collectFailedLockReason != nil {   // §37.1: the engine refuses it until the failed collection was retried
            hunkRefusal = (file.path, HunkRefusal.from("collect_failed"))
            return false
        }
        hunkRefusal = nil
        // wave2 mac-flow (§34.1): hunk ids are the whole review's; a range's ids are never sent.
        if selectedPathValue == file.path, selectedDiffSince != .review { return false }
        // The tree of the diff on screen, not the latest snapshot's B: if B moved since, the engine answers stale_diff;
        // its old side (`baseTree`, §34.1) must still be A.
        let shown = wholeReviewDiff(path: file.path)
        let command = EngineCommand.rejectHunks(path: file.path, hunks: hunks.sorted(), expectedEndTree: shown?.endTree ?? state.gate.turnEndTree,
                                                expectedBaseTree: shown?.info.baseTree)
        if let commandSink { commandSink(command); return true }
        isRejectingHunks = true
        defer { isRejectingHunks = false }
        do {
            try await request(command)
            await settle()
            return true
        } catch let EngineClientError.refused(code, errorCode, paths, _) {
            // Every hunk of the file = a whole-file reject: parity with the other client, ask before discarding the user's edit.
            let allHunks = Set(wholeReviewDiff(path: file.path)?.diff.hunks.map(\.id) ?? [])
            if (errorCode ?? HunkRefusal.from(code).code) == "file_changed_since_review", !allHunks.isEmpty, Set(hunks) == allHunks {
                forceRejectRequest = ForceRejectRequest(command: .reject(paths: [file.path]), paths: paths.isEmpty ? [file.path] : paths)
                appendLog("[warn] reject_hunks \(file.path): \(code) — asking to force")
                return false
            }
            hunkRefusal = (file.path, HunkRefusal.from(code))
            appendLog("[warn] reject_hunks \(file.path): \(code)")
            return false
        } catch {
            hunkRefusal = (file.path, HunkRefusal(code: "", message: error.localizedDescription, remedy: .none))
            return false
        }
    }

    /// The refusal's "Refresh": re-diffs the pending review against the working tree and reloads the shown diff.
    public func refreshReviewAfterRefusal() async {
        hunkRefusal = nil
        await refresh(scope: [.review])
        if let file = selectedFile {
            reviewDiffs = reviewDiffs.filter { $0.key.path != file.path }
            selectFile(file)
        }
    }

    public func dismissHunkRefusal() { hunkRefusal = nil }

    // MARK: - Review history (docs/PROTOCOL.md §14)

    /// `review_history` → `reviewHistory` (newest first): the current chat's rounds, or every session's with `allSessions`.
    public func loadReviewHistory(allSessions: Bool? = nil) async {
        guard projectInfo != nil else { return }
        if let allSessions { historyAllSessions = allSessions }
        let command = EngineCommand.reviewHistory(all: historyAllSessions)
        if let commandSink { commandSink(command); return }
        isLoadingHistory = true
        defer { isLoadingHistory = false }
        do {
            let reply = try await typedReply(command)
            guard case let .reviewHistory(_, _, entries, current) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            reviewHistory = entries
            currentReviewRound = current   // wave2 mac-flow (§34.4): the round in progress, on top of the list
            historyLoadError = nil
        } catch EngineClientError.refused(let code, _, _, _) {
            historyLoadError = ReviewHistoryText.refusal(code)
            appendLog("[warn] review_history: \(code)")
        } catch {
            historyLoadError = error.localizedDescription
            appendLog("[warn] review_history: \(error.localizedDescription)")
        }
    }

    public var historyEntry: ReviewHistoryEntry? {
        historySelection.flatMap { sel in
            reviewHistory.first { $0.id == sel.entryId } ?? currentReviewRound.flatMap { $0.id == sel.entryId ? $0 : nil }   // wave2 mac-flow
        }
    }
    public var historyFile: ReviewHistoryFile? {
        guard let sel = historySelection else { return nil }
        return historyEntry?.files.first { $0.path == sel.path }
    }

    /// `history_diff{entryId, path}`: shows that file of a past round read-only in the diff pane.
    public func openHistoryDiff(entryId: String, path: String) async {
        let selection = HistorySelection(entryId: entryId, path: path)
        historySelection = selection
        historyDiff = nil
        historyDiffTruncated = false
        historyDiffError = nil
        historyWhy = nil   // wave4 w4-history
        let command = EngineCommand.historyDiff(entryId: entryId, path: path)
        if let commandSink { commandSink(command); return }
        do {
            let reply = try await typedReply(command)
            guard case let .historyDiff(_, _, _, diff, truncated, why) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            guard historySelection == selection else { return }
            historyDiff = diff
            historyDiffTruncated = truncated
            historyWhy = why   // wave4 w4-history (§38.3)
        } catch EngineClientError.refused(let code, _, _, _) {
            guard historySelection == selection else { return }
            historyDiffError = ReviewHistoryText.refusal(code)
        } catch {
            guard historySelection == selection else { return }
            historyDiffError = error.localizedDescription
        }
    }

    /// Back to the current review in the diff pane.
    public func closeHistoryDiff() {
        historySelection = nil
        historyDiff = nil
        historyDiffTruncated = false
        historyDiffError = nil
    }

    // MARK: - User extensions (docs/PROTOCOL.md §16)

    /// `set_settings{disabledPlugins, disableUserHooks}` on a running engine; they apply at the next session start
    /// (`restartSession()`).
    public func updateExtensionSettings(disabledPlugins: [String], disableUserHooks: Bool) {
        guard engineStarted else { return }
        fire(.setSettings(EngineSettings(disabledPlugins: disabledPlugins, disableUserHooks: disableUserHooks)))
    }

    /// Hides the fallback banner (the session keeps running without user settings until the project is reopened).
    public func dismissExtensionsFallback() {
        guard let fallback = state.session.extensions?.fallback ?? fallbackFromEvent else { return }
        dismissedFallbackKey = Self.fallbackKey(fallback)
    }

    /// The banner's "Retry with extensions": the fallback sticks until the next `open_project`, so the project is
    /// reopened (the review list is restored from disk; the chat resumes).
    public func retryWithExtensions() async {
        guard let url = projectURL, !isRunning else { return }
        // wave3 mac-session (§36.7): `retry_extensions` restarts the session in place; an older engine reopens the project.
        guard await sessionTools.retryExtensions() == .unsupported else { return }
        await openProject(url)
    }

    private static func fallbackKey(_ fallback: ExtensionsFallback) -> String {
        fallback.at.isEmpty ? "timeout:\(fallback.timeoutMs)" : fallback.at
    }

    // MARK: - Engine plumbing

    /// Fire-and-forget command; a transport failure becomes an error row.
    func fire(_ command: EngineCommand) {
        if let commandSink { commandSink(command); return }
        Task {
            do {
                try await client.send(command)
                engineStarted = true
            } catch {
                pauseQueue(error.localizedDescription)
                fail(error.localizedDescription, fatal: false)
            }
        }
    }

    /// Review mutations (accept / reject / notes) as request/reply: the engine refuses them with `session_running`
    /// while a turn or its collection is in flight, and that refusal must reach the user as an error row instead of
    /// vanishing like a fire-and-forget `send`.
    func fireReviewAction(_ command: EngineCommand) {
        if let commandSink { commandSink(command); return }
        Task {
            do {
                _ = try await client.request(command)
                engineStarted = true
            } catch let error as EngineClientError {
                fail(error.userMessage, fatal: false)
            } catch {
                fail(error.localizedDescription, fatal: false)
            }
        }
    }

    /// Request/reply through the test seam or the engine; throws the engine's refusal.
    func request(_ command: EngineCommand) async throws {
        do {
            if let requestSink { try await requestSink(command); return }
            _ = try await client.request(command)
            engineStarted = true
        } catch let error as EngineClientError where error.refusalCode == "auto_mode_unavailable" {
            // wave6 w6-terminal (§44.1): any refusal saying auto mode cannot run here (a mode switch, a plan answer) is
            // remembered — ⇧⇥ skips auto and a plan is approved into the default mode.
            noteAutoModeUnavailable()
            throw error
        }
    }

    /// §21: the diff of a changed file if the client has it (the thread header's preview); nil = not loaded yet. Always
    /// the whole review's: side-question anchors name its hunks (wave2 mac-flow, §34.1).
    public func cachedDiff(path: String) -> FileDiff? {
        if selectedPathValue == path, selectedDiffSince == .review, let selectedDiff { return selectedDiff }
        return wholeReviewDiff(path: path)?.diff
    }

    /// §21: pushes the side-question settings to the engine (new side questions use them).
    public func updateSideSettings() {
        var side = EngineSettings(sideModel: AppSettings.sideModel(defaults: defaults),
                                  sideAllowWeb: AppSettings.sideWeb(defaults: defaults) == .on)   // MARK: wave4b w4b-side (§40.3)
        side.sideWeb = AppSettings.sideWeb(defaults: defaults).rawValue
        fire(.setSettings(side))
    }

    /// Request/reply for the §21 / §22 commands through the test seams or the engine. With only `commandSink` set (tests
    /// without replies) the command is recorded and the call fails as if the engine had stopped.
    func reply(_ command: EngineCommand) async throws -> EngineEvent {
        if let replySink { return try await replySink(command) }
        if let commandSink { commandSink(command); throw EngineClientError.stopped }
        return try await requestReply(command)
    }

    /// Request/reply for typed replies (`file_diff`, `full_file_content`).
    func requestReply(_ command: EngineCommand) async throws -> EngineEvent {
        let reply = try await client.request(command)
        engineStarted = true
        return reply
    }

    /// Request/reply, then wait (≤ 500 ms) for the snapshot the engine emits after the reply so the caller
    /// sees the mirrored result on return. `result{ok:false}` becomes an error row unless `reportFailure` is
    /// false (the engine already emitted an `error` event for those).
    @discardableResult
    func run(_ command: EngineCommand, fatal: Bool = false, reportFailure: Bool = true) async -> Bool {
        do {
            _ = try await client.request(command)
            engineStarted = true
            nodeToolchain = await client.toolchain
            await settle()
            return true
        } catch {
            if case EngineClientError.refused = error, !reportFailure { return false }
            fail((error as? EngineClientError)?.userMessage ?? error.localizedDescription, fatal: fatal)
            return false
        }
    }

    /// Waits for the next snapshot (the engine coalesces its `state` on the macrotask after the reply).
    func settle() async {
        let seq = state.seq
        let deadline = ContinuousClock.now + .milliseconds(500)
        while state.seq <= seq, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    // MARK: - Event handling

    /// Applies one engine event. Internal so tests can drive the mirror without an engine.
    func handle(_ event: EngineEvent) {
        switch event {
        case let .state(snapshot):
            apply(snapshot)
        case let .userMessage(text, turn, mentions, attachments, autoModel):
            finishStreamingAssistant()
            if pendingInterruptSend != nil, !interruptFallback { pendingInterruptSend = nil; sendAfterInterrupt = nil }
            transcript.append(.user(id: UUID(), text: text, meta: UserMessageMeta(turn: turn, mentions: mentions, attachments: attachments, autoModel: autoModel)))
        case let .textDelta(text, unprompted):
            if transientNotice != nil { transientNotice = nil }   // MARK: wave7 w7-chat — §45.1: a delta never redraws the HUD
            appendAssistantText(text, unprompted: unprompted)
        case let .toolUse(id, name, input, file, info):
            if transientNotice != nil { transientNotice = nil }
            finishStreamingAssistant()
            transcript.append(.toolUse(id: UUID(), toolUseId: id, name: name, file: file, input: input, info: info))
        case let .toolResult(toolUseId, isError, preview, info):
            transcript.append(.toolResult(id: UUID(), toolUseId: toolUseId, isError: isError, preview: preview, info: info))
            liveCallFinished(toolUseId: toolUseId, isError: isError)   // §34.6: the same file edited again moves the HUD's +/−
        case let .permissionRequest(req):
            finishStreamingAssistant()
            // §33.1 (wave1 mac-perms): appended to the queue (the snapshot follows), never over another open request.
            enqueuePermission(req)
            onAttention?(.permission(req))
        case let .permissionRules(reply):   // wave1 mac-perms: an unsolicited reply (a request's is consumed by it)
            permissionRules = reply
        case let .budgetEvent(kind, toolName, file, files, lines, budget):
            transcript.append(.budgetEvent(id: UUID(), kind: kind, toolName: toolName, file: file, files: files, lines: lines, budget: budget))
        case let .turnEnd(stopReason, usage, files, added, deleted, external, review):
            transientNotice = nil
            finishStreamingAssistant()
            // wave2 mac-flow (§34.3): this turn's numbers, plus the review's when the turn merged into one.
            let summary = TurnEndText.row(stopReason: stopReason, usage: usage, files: files, added: added, deleted: deleted,
                                          external: external, review: review)
            // MARK: wave4c w4c-commit — §41.1: "대화를 줄였어요" before the line of a turn that compacted the conversation.
            if let c = usage.compacted { transcript.append(.turnEnd(id: UUID(), summary: TeamFormat.compactedLine(c, postTokens: usage.contextTokens))) }
            transcript.append(.turnEnd(id: UUID(), summary: summary))
        case let .transcriptRestore(items):
            restoreTranscript(items)
            pagingRestored(items, paging: nil)   // MARK: wave4 w4-history (§38.3)
        case let .transcriptRestorePaged(items, paging):
            restoreTranscript(items)
            pagingRestored(items, paging: paging)
        case let .planProposed(path, plan):
            planRefusal = nil
            answeredPlan = nil
            finishStreamingAssistant()
            state.session.pendingPlan = PendingPlan(path: path, plan: plan)
            transcript.append(.plan(id: UUID(), path: path, plan: plan, approvedMode: nil))
            onAttention?(.plan(path: path, plan: plan))
        case let .planApproved(mode, path):
            state.session.pendingPlan = nil
            planRefusal = nil
            state.session.permissionMode = mode
            rememberPermissionMode(mode)
            transcript.append(.plan(id: UUID(), path: path, plan: "", approvedMode: mode))
        case let .turnSummary(summary):
            finishStreamingAssistant()
            // wave2 mac-flow (§34.3): a turn that changed nothing has no card.
            if !summary.files.isEmpty { transcript.append(.turnSummary(id: UUID(), summary: summary)) }
        // wave1 mac-review — §31–32: the banners render the `state.gate` mirror; the events only go to the log.
        case .headMoved, .concurrentClaude, .localSettingsChanged, .nestedChanges:
            if let line = ReviewProvenanceText.logLine(for: event) { appendLog(line) }
        case let .extensionsFallback(reason, timeoutMs, message):
            // The engine's `error{scope:"session"}` carries the same text; the dedicated banner replaces it.
            fallbackFromEvent = ExtensionsFallback(reason: reason, timeoutMs: timeoutMs)
            fallbackMessage = message
            dismissedFallbackKey = nil
            if errorBanner?.message == message { errorBanner = nil }
        case let .error(message, fatal, scope, detail):
            handleError(message: message, fatal: fatal, scope: scope, detail: detail)
        case let .log(level, message):
            ingestLog(level: level, message: message)   // wave1 mac-session: the stderr twin of a log event is dropped
        // MARK: wave1 mac-session (§29)
        case let .peerMessage(message):
            if message.state == .delivered || message.state == .dropped { finishStreamingAssistant() }
            handlePeerMessage(message)
        case let .autoTurn(turn, info):   // §52.1
            handleAutoTurn(turn: turn, info: info)
        case let .sideThread(_, thread):
            side.upsert(thread)
        case let .sideThreads(_, mainSessionId, threads):
            side.replace(mainSessionId: mainSessionId, threads: threads)
        case let .sideThreadClosed(threadId):
            side.remove(threadId)
        case let .sideTextDelta(threadId, text):
            side.appendDelta(threadId, text: text)
        case let .sideToolUse(threadId, id, name, input):
            side.toolUse(threadId, id: id, name: name, input: input)
        case let .sideToolResult(threadId, toolUseId, isError, preview, denied):
            side.toolResult(threadId, toolUseId: toolUseId, isError: isError, preview: preview, denied: denied)
        case let .sideTurnEnd(threadId, _, _, _):
            side.turnEnded(threadId)
        case let .sidePromoteDraft(_, threadId, text):
            side.unsolicitedDraft(threadId: threadId, text: text)
        // MARK: wave3 mac-flow — §36.12 steps, §36.13 runs (replies to a request are consumed by it)
        case .workbenchProgress, .prereview:
            handleFlowEvent(event)
        case .commitDraft, .workbenchPreview:
            break
        case let .mcpStatus(_, servers, restartRequired):
            mcp.apply(servers: servers, restartRequired: restartRequired)
        case let .contextWarning(warning):
            contextWarning = warning
        // MARK: wave3 mac-session — §36.8 / §36.9 replies nobody waited for (a request's reply is consumed by it)
        case let .cliVersions(reply):
            sessionTools.apply(versions: reply)
        case let .cliSessions(reply):
            sessionTools.apply(sessions: reply)
        // MARK: wave4 w4-history — §38.3 replies: only the request that asked uses them
        case .transcriptPage, .transcriptSearch:
            break
        case .historyCleanup:   // MARK: wave4b w4b-bigturn — §39.1: consumed by `historyCleanup(keep:apply:)`
            break
        case .commitFormat, .prDraft, .prAiDraft, .taskOutput, .taskBackground:   // MARK: wave4c w4c-commit — §41.1 (§51, §52): replies, consumed by their requests
            break
        case .commitHunks, .commitSplitDraft, .committedSeries:   // §53: replies, consumed by their requests
            break
        case .fileLines, .fileImage:   // MARK: wave4c w4c-review — §41.3 replies, consumed by the request that asked
            break
        case .claudeMd:   // MARK: wave4d w4d-config — §42.3: consumed by the instructions editor's request
            break
        // MARK: wave5 w5-brain — §43.2: a watched memory folder changed (a reply is consumed by the board's request)
        case let .brain(snapshot):
            if snapshot.id == nil { subBrain.apply(snapshot) }
        case .brainMemory:
            break
        case let .codeGraph(reply):   // MARK: wave5 w5-graph — §43.3: a build's progress / end (a request's reply is consumed by it)
            codeGraph.apply(reply)
        case let .statusLine(reply):   // MARK: wave6 w6-statusline — §44.2: new lines (a request's reply is consumed by it)
            statusLine.apply(reply)
        // MARK: wave4b w4b-follow — §39.4: the chat went to another worktree; the app opens / fronts its window
        case let .chatMoved(moved):
            handleChatMoved(moved)
        // MARK: wave4d w4d-plan — §42.1: the fresh chat / the plan handed to (received from) a workbench
        case let .planApprovedInto(info):
            if info.target == nil { rememberPermissionMode(info.mode) }   // the chat that implements takes the mode
            applyPlanApproved(info)
        case let .taskStarted(info):   // §49
            applyTaskStarted(info)
        case let .attachment(_, hash, _, dataBase64):
            if let data = Data(base64Encoded: dataBase64, options: .ignoreUnknownCharacters), !hash.isEmpty { attachmentData[hash] = data }
        case .activity, .ready, .result, .fileDiff, .fullFileContent, .prCreated, .committed, .toolOutput, .reviewHistory, .historyDiff,
             .files, .rewound, .liveChanges:
            break
        case .agentReport:   // wave3 mac-agents: a reply, consumed by `loadAgentReport(toolUseId:)`
            break
        case .projectFile, .projectSearch:   // MARK: code-browser — §47 replies, consumed by the request that asked
            break
        }
    }

    /// §19.6: an `error` event — localized on its `code` (unknown → the engine's text); `api_retrying` / `cli_start_slow`
    /// become the HUD's transient notice, everything else a transcript row plus the banner (with its actions).
    private func handleError(message: String, fatal: Bool, scope: ErrorScope, detail: EngineErrorDetail) {
        if fatal { finishStreamingAssistant() }
        noteLongWork(detail)   // wave4 w4-longwork (§38.2): the usage limit's reset ("풀리면 이어서 하기")
        let text = EngineMessages.error(message: message, detail: detail)
        // §21 / §22 run on their own lanes: they never add a row to the main conversation or pause its queue.
        if !fatal {
            switch detail.code {
            case "side_failed":
                side.failed(detail.threadId, message: text)
                return
            case "mcp_auth_required":
                mcp.authRequired(detail.server)
                errorBanner = ErrorBanner(message: text, scope: scope, fatal: false, code: detail.code,
                                          actions: EngineMessages.actions(for: detail.code))
                onAttention?(.actionNeeded(message: text, code: detail.code))
                return
            case "mcp_failed":
                errorBanner = ErrorBanner(message: text, scope: scope, fatal: false, code: detail.code)
                return
            default:
                break
            }
        }
        switch EngineMessages.presentation(for: detail, fatal: fatal) {
        case .retrying:
            transientNotice = TransientNotice(kind: .retrying, text: text)
            return
        case .slowStart:
            transientNotice = TransientNotice(kind: .slowStart, text: text)
            return
        case .banner:
            transientNotice = nil
        }
        // wave1 mac-session (M4 / §2.9): notices (resume, worktree, peer) neither stop the queue nor ask for action; the
        // row merges repeats (×N) and carries the CLI's words, the banner the code's actions.
        let notice = SessionNotices.isNotice(code: detail.code, fatal: fatal)
        if !notice {
            requeueFailedSend(code: detail.code)
            pauseQueue(text)
        }
        recordFailure(text, fatal: fatal, scope: scope, detail: detail, engineMessage: message)
        if !fatal, message == fallbackMessage || detail.code == "extensions_init_timeout" && fallbackMessage != nil {
            errorBanner = nil   // the extensions-fallback banner says it
        }
        // wave4 w4-safety (daily-14): a reason the running turn stopped is told by the turn's "finished" notification.
        let deferred = noteTurnStop(message: message, fatal: fatal, detail: detail)
        if !notice, !deferred, fatal || !EngineMessages.actions(for: detail.code).isEmpty {
            onAttention?(.actionNeeded(message: text, code: detail.code))
        }
        if detail.code == "plan_followup_failed" {
            // §19.5: the engine puts the plan back (`state.session.pendingPlan`); until that snapshot, re-show ours.
            planRefusal = text
        }
    }

    // MARK: wave7 w7-state — §45.2: the slices

    /// Keeps the whole snapshot and writes each slice that changed; `state`'s own readers are told when anything did.
    private func applySlices(_ snapshot: ReviewState) {
        let old = stateStore
        stateStore = snapshot
        var changed = assignSlices(snapshot)
        // What has no slice of its own here (the PR store mirrors `pr`; the engine's `lastError`) still tells `state`'s readers.
        if !changed { changed = snapshot.pr != old.pr || snapshot.lastError != old.lastError }
        if changed { withMutation(keyPath: \.state) {} }
    }

    /// Writes every slice whose value differs (an equal one is never written: its observers are not told); true if any.
    @discardableResult
    private func assignSlices(_ s: ReviewState) -> Bool {
        var changed = false
        func put<Value: Equatable>(_ key: ReferenceWritableKeyPath<AppState, Value>, _ value: Value) {
            guard self[keyPath: key] != value else { return }
            self[keyPath: key] = value
            changed = true
        }
        put(\.projectInfo, s.project)
        put(\.gitInitInfo, s.gitInit)
        put(\.projectURL, (s.project?.path ?? s.gitInit?.path).map { URL(fileURLWithPath: $0) })
        put(\.sessionInfo, s.session)
        put(\.engineToolchain, s.toolchain)
        put(\.gate, s.gate)
        put(\.gatePhase, s.gate.phase)
        put(\.changedFiles, s.changedFiles)
        put(\.reviewNotes, s.reviewNotes)
        put(\.budget, s.budget)
        put(\.budgetUsage, s.budgetUsage)
        if hudWire != s.hud {
            hudWire = s.hud
            changed = true
            put(\.hud, HUDState(s.hud))
            put(\.hudTurnCount, s.hud.turnCount)
            put(\.hudTurnFiles, s.hud.turnFiles)
            put(\.agents, s.hud.agents)
            put(\.liveAgentCount, s.hud.agents.filter { $0.status.isLive }.count)
        }
        put(\.branchesInfo, s.branches)
        put(\.workbenches, s.workbenches ?? .empty)
        put(\.engineLockConflict, s.lockConflict)
        put(\.commitState, s.commit ?? .empty)
        if sessionsInfo != s.sessions {
            sessionsInfo = s.sessions
            changed = true
            put(\.openTabs, Self.openTabs(s.sessions))
        }
        put(\.storage, s.storage)
        put(\.autoAcceptRules, s.autoAcceptRules ?? .none)
        return changed
    }

    /// The menus' slice: recomputed whenever what it reads changes (never the HUD), written only when it differs — so the
    /// menu bar (and AppKit's shortcut pass over it) re-evaluates only when what the menus show changed.
    func trackMenuState() {
        let next = withObservationTracking { MenuState(self) } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.trackMenuState() }
        }
        if next != menuState { menuState = next }
    }

    private func apply(_ snapshot: ReviewState) {
        // Out-of-order snapshots are dropped; seq 0 is the client's own reset after the engine exited.
        guard snapshot.seq > state.seq || snapshot.seq == 0 else { return }
        let previous = state
        state = snapshot
        reconcilePermissionQueue()   // wave1 mac-perms: answered cards stay answered; queued requests have a card
        if transientNotice != nil, !isRunning, !isStarting { transientNotice = nil }
        // The engine's restored plan (§19.5) replaces the copy the card kept.
        if snapshot.session.pendingPlan != nil { answeredPlan = snapshot.session.pendingPlan }
        if snapshot.seq == 0 {
            // Engine gone: keep the transcript (it ends with the exit error row), drop everything else. The window
            // falls back to the empty state, so the banner says the engine stopped and offers to reopen the project.
            let detail = errorBanner?.scope == .engine ? errorBanner?.message : nil
            let base = String(localized: "The engine has stopped.", bundle: .module)
            errorBanner = ErrorBanner(message: detail.map { "\(base) \($0)" } ?? base, scope: .engine, fatal: true,
                                      reopenProject: (previous.project?.path ?? previous.gitInit?.path).map { URL(fileURLWithPath: $0) })
            engineStarted = false
            enginePID = nil
            cachedCapabilities = nil
            selectedPathValue = nil
            selectedDiff = nil
            selectedDiffEndTree = nil
            diffLoadTask?.cancel()
            diffLoadTask = nil
            resetReviewRound()   // wave2 mac-flow
            pr.apply(snapshot.pr)
            turnInFlight = false
            pauseQueue(base)
            return
        }
        if let caps = snapshot.session.capabilities, previous.session.capabilities == nil {
            AppSettings.setCachedCapabilities(caps, defaults: defaults)
        }
        if let path = snapshot.project?.path, path != previous.project?.path {
            AppSettings.addRecentProject(URL(fileURLWithPath: path), defaults: defaults)
            // The hello carried only the global allow patterns; this project's own ones follow.
            if !AppSettings.projectBashAllowPatterns(root: AppSettings.projectKey(URL(fileURLWithPath: path)), defaults: defaults).isEmpty {
                pushPermissionSettings()
            }
        }
        // M20: the engine is the authority on the mode (it restores the project's own record on open) — mirror
        // whatever it reports into the per-project store. wave6 w6-terminal (§44.1): never plan mode — a pick of it stored
        // itself (`requestPermissionMode`), and plan mode Claude entered must not become this project's (or, as the last
        // mode used anywhere, every new project's) mode.
        if snapshot.project != nil, snapshot.session.permissionMode != .plan,
           snapshot.session.permissionMode != previous.session.permissionMode || snapshot.project?.path != previous.project?.path {
            rememberPermissionMode(snapshot.session.permissionMode)
        }
        applyScheduledPermissionMode(previousProject: previous.project?.path)   // wave4b w4b-auto (§39.5)
        refreshAutoModeAvailability(previous: previous)   // wave6 w6-terminal (§44.1)
        // wave2 mac-flow (§34.1–34.6): diffs are cached per (path, range, B) — reloaded when B moves, kept (read-only) while
        // a turn runs; "봤음" survives B moving; the live list follows the running turn.
        reviewSnapshotApplied(previous: previous)
        pr.apply(snapshot.pr)
        // M15: the live session always has a tab; persist it when the engine's list lacks it (new / opened session).
        if let sessions = snapshot.sessions, sessions != previous.sessions,
           let current = sessions.currentId, !sessions.openTabIds.contains(current) {
            setTabs(sessions.openTabIds + [current])
        }
        if snapshot.project?.path != previous.project?.path { lastTabsSent = nil }
        if snapshot.project?.path != previous.project?.path { mcp.reset() }
        if snapshot.project?.path != previous.project?.path { codeGraph.reset() }   // MARK: wave5 w5-graph (§43.3)
        if snapshot.project?.path != previous.project?.path { statusLine.reset() }   // MARK: wave6 w6-statusline (§44.2)
        if snapshot.project?.path != previous.project?.path { codeBrowser.reset() }   // MARK: code-browser (§47)
        flowSnapshotApplied(previous: previous)   // wave3 mac-flow (§36.11–36.13)
        if contextWarning != nil {
            // §27: the warning re-arms below 80 % (after `compact`) and belongs to one chat.
            let window = snapshot.hud.contextWindow ?? 0
            let below = window > 0 && Double(snapshot.hud.contextTokens) / Double(window) < 0.8
            if below || snapshot.sessions?.currentId != previous.sessions?.currentId || snapshot.project?.path != previous.project?.path {
                contextWarning = nil
            }
        }
        reloadSideThreadsIfNeeded()
        agentsSnapshotApplied(previous: previous)   // wave3 mac-agents (§36.2 stops settle, §36.4 "subagents finished")
        sessionSnapshotApplied(previous: previous)   // wave1 mac-session (§30 ready, §29 peer card)
        afterSnapshot(projectChanged: snapshot.project?.path != previous.project?.path)
    }

    /// §21: the side threads belong to one chat; a project open or chat switch loads the new chat's (`side_list`).
    private func reloadSideThreadsIfNeeded() {
        guard let path = state.project?.path else {
            if sideLoadedKey != nil { side.reset(mainSessionId: nil); sideLoadedKey = nil }
            return
        }
        let chat = state.sessions?.currentId ?? state.session.sessionId
        let key = "\(path)|\(chat ?? "")"
        guard key != sideLoadedKey, chat != nil else { return }
        sideLoadedKey = key
        side.reset(mainSessionId: chat)
        Task { await side.reload() }
    }

    /// Pre-fills the transcript with the persisted rows (audit 3.1); a fresh session's rows follow them. After
    /// `session_open` / `session_new` (M15) the rows replace the transcript instead — even an empty list.
    func restoreTranscript(_ items: [TranscriptItem]) {   // wave4 w4-history: also prepends a `transcript_page`
        let replace = replaceTranscriptOnRestore
        replaceTranscriptOnRestore = false
        if replace {
            transcript = []
            dropLiveText()   // MARK: wave7 w7-chat (§45.1)
            restoredTranscriptIDs = []
            lastError = nil
        }
        guard !items.isEmpty else { return }
        var rows: [ChatItem] = []
        for item in items {
            let id = UUID()
            switch item.kind {
            case let .userMessage(text, mentions, attachments, autoModel):
                rows.append(.user(id: id, text: text, meta: UserMessageMeta(turn: item.turn, mentions: mentions, attachments: attachments, autoModel: autoModel)))
            case let .assistantText(text, unprompted):
                rows.append(.assistant(id: id, text: text, streaming: false, unprompted: unprompted))
            case let .toolUse(toolUseId, name, input, file, info):
                rows.append(.toolUse(id: id, toolUseId: toolUseId, name: name, file: file, input: input, info: info))
            case let .toolResult(toolUseId, isError, preview, info):
                rows.append(.toolResult(id: id, toolUseId: toolUseId, isError: isError, preview: preview, info: info))
            case let .permission(requestId, toolName, allow, file):
                let request = PermissionRequest(requestId: requestId, toolName: toolName, input: .object([:]), file: file)
                rows.append(.permission(id: id, request: request, allowed: allow))
            case let .budgetEvent(kind, toolName, file, files, lines):
                rows.append(.budgetEvent(id: id, kind: kind, toolName: toolName, file: file, files: files, lines: lines, budget: state.budget))
            case let .turnEnd(stopReason, usage, files, added, deleted, _, external, review):
                // MARK: wave4c w4c-commit — §41.1: a restored compacted turn keeps its "대화를 줄였어요" line.
                if let c = usage.compacted { rows.append(.turnEnd(id: UUID(), summary: TeamFormat.compactedLine(c, postTokens: usage.contextTokens))) }
                // wave2 mac-flow (§34.3): the same line as a live turn end.
                rows.append(.turnEnd(id: id, summary: TurnEndText.row(stopReason: stopReason, usage: usage, files: files, added: added,
                                                                      deleted: deleted, external: external, review: review)))
            // MARK: wave1 mac-session (§30 error rows, merged like live ones; §29 peer rows)
            case let .error(message, fatal, scope, code, detail, facts):
                let restored = restoredError(message: message, scope: scope, code: code, detail: detail, at: item.at, facts: facts)
                SessionNotices.appendError(to: &rows, id: id, message: restored.text, fatal: fatal, info: restored.info)
            case let .peerMessage(message):
                rows.append(.peerMessage(id: id, message: message))
            case let .autoTurn(info):   // §52.1
                rows.append(.autoTurn(id: id, turn: item.turn, info: info))
            // MARK: wave4 w4-history — §38.3: the turn summary card comes back with the chat (as live: none without files).
            case let .turnSummary(summary):
                if !summary.files.isEmpty { rows.append(.turnSummary(id: id, summary: summary)) }
            case .other:
                continue
            }
        }
        restoredTranscriptIDs.formUnion(rows.map(\.id))
        transcript.insert(contentsOf: rows, at: 0)
    }

    func appendLog(_ line: String) {
        logs.append(line)
        if logs.count > 500 { logs.removeFirst(logs.count - 500) }
        writeLogFile(line)   // wave1 mac-session: ~/Library/Logs/ReviewGate (robustness-03)
    }

    /// Streams into the open assistant message; a change of the unprompted mark (§18) starts a new one.
    /// MARK: wave7 w7-chat — §45.1: the row is appended with its first delta; the next ones go to `liveText` only (no copy
    /// of the transcript, no rebuilt string) and its readers are told once per burst (`publishLiveText`).
    private func appendAssistantText(_ text: String, unprompted: Bool = false) {
        if let live = liveText.rowID, transcript.last?.id == live, liveText.unprompted == unprompted {
            liveText.append(text)
            scheduleLivePublish()
            return
        }
        finishStreamingAssistant()
        let id = UUID()
        liveText.start(rowID: id, text: text, unprompted: unprompted)
        transcript.append(.assistant(id: id, text: text, streaming: true, unprompted: unprompted))
    }

    /// The streaming row gets its whole text and is finished — also when a row was put after it (an error row, a lock
    /// notice): the next delta starts a new message anyway, and a row left streaming stays raw text without Copy.
    func finishStreamingAssistant() {
        if let live = liveText.rowID {
            let text = liveText.take()
            livePublishScheduled = false   // the row change below tells the readers
            if let i = transcript.lastIndex(where: { $0.id == live }), case let .assistant(id, _, _, mark) = transcript[i] {
                transcript[i] = .assistant(id: id, text: text, streaming: false, unprompted: mark)
            }
            return
        }
        if let last = transcript.indices.last, case .assistant(let id, let text, true, let mark) = transcript[last] {
            transcript[last] = .assistant(id: id, text: text, streaming: false, unprompted: mark)
        }
    }

    // MARK: wave7 w7-chat — §45.1

    private func transcriptChanged() {
        transcriptRevision &+= 1
        let shape = TranscriptShape(transcript)
        if shape != transcriptShape {
            transcriptShape = shape
            transcriptStructureRevision &+= 1
        }
    }

    /// The deltas already queued for the main actor are handled before this runs: they land as one change. At most one
    /// change per `livePublishInterval`: the CLI streams ~60 deltas a second, and each change lays the answer out again
    /// (a 20 KB answer kept the main thread at 80–100 % for as long as it streamed).
    private func scheduleLivePublish() {
        guard !livePublishScheduled else { return }
        livePublishScheduled = true
        let wait = lastLivePublish.map { Self.livePublishInterval - (ContinuousClock.now - $0) } ?? .zero
        Task { @MainActor [weak self] in
            if wait > .zero { try? await Task.sleep(for: wait) }
            self?.publishLiveText()
        }
    }

    /// Tells the streaming row and the follow scroll that the text grew (once per burst of deltas).
    func publishLiveText() {
        guard livePublishScheduled else { return }
        livePublishScheduled = false
        lastLivePublish = .now
        liveText.publish()
        transcriptRevision &+= 1
    }

    /// Nothing streams any more (the rows were replaced).
    private func dropLiveText() {
        liveText.reset()
        livePublishScheduled = false
    }

    /// The live transcript's tree, index and lookups, up to date with its rows (observes them; a delta never changes them).
    public var liveLookups: TranscriptLookups {
        transcriptLookups.update(transcript, key: transcriptStructureRevision)
        return transcriptLookups
    }

    /// The live transcript's row tree, folded runs, index and positions (`liveLookups.model`).
    public var transcriptModel: TranscriptModel { liveLookups.model }

    /// The live transcript's tool calls (one index for the chat, the diff's "Why it changed", the side panel, …).
    public var transcriptIndex: TranscriptIndex { liveLookups.model.index }

    /// An error row plus the banner (the row alone is invisible while the window shows the empty state).
    func fail(_ message: String, fatal: Bool, scope: ErrorScope = .session) {
        recordFailure(message, fatal: fatal, scope: scope, detail: nil)   // wave1 mac-session: merges repeats (×N)
    }
}

/// M13 (audit 4.2): the non-modal error banner's content — the last `error` event with its scope.
public struct ErrorBanner: Sendable, Equatable {
    public var message: String
    public var scope: ErrorScope
    public var fatal: Bool

    /// The project to reopen from the banner after the engine stopped or failed to start; nil = no "Reopen".
    public var reopenProject: URL?
    /// §19.6: the event's code (nil for client-side errors / older engines).
    public var code: String?
    /// What the banner offers besides Show log / Dismiss (`auth_required` → login, `session_crashed` → restart, …).
    public var actions: [EngineMessageAction]
    // MARK: wave1 mac-session (§30 / §33.4)
    /// The gray second line: the CLI's own words · exit code · signal.
    public var secondary: String?
    /// The same error (code + detail, else the text) reported this many times in a row.
    public var repeatCount = 1
    /// §30: the chat a `resume_*` notice is about; §33.4: the tool, folder and branch of a worktree notice.
    public var sessionId: String?
    public var toolName: String?
    public var path: String?
    public var branch: String?
    /// Info (blue), warning (orange) or error (red).
    public var style: NoticeStyle { SessionNotices.style(code: code, fatal: fatal) }

    public init(message: String, scope: ErrorScope, fatal: Bool, reopenProject: URL? = nil, code: String? = nil,
                actions: [EngineMessageAction] = []) {
        self.message = message
        self.scope = scope
        self.fatal = fatal
        self.reopenProject = reopenProject
        self.code = code
        self.actions = actions
    }
}

/// §19.6: the HUD's transient status for an `error` event that is not a failure of its own.
public struct TransientNotice: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        /// `api_retrying`: the CLI retries the API call by itself.
        case retrying
        /// `cli_start_slow`: the CLI has not initialized after ~8 s.
        case slowStart
    }

    public var kind: Kind
    public var text: String

    public init(kind: Kind, text: String) {
        self.kind = kind
        self.text = text
    }
}

/// §19.1: a refused whole-file reject waiting for the user's "revert anyway?".
public struct ForceRejectRequest: Sendable, Equatable {
    /// The refused `reject` / `reject_all` (without `force`).
    public var command: EngineCommand
    /// The files the user edited since the review, in batch order.
    public var paths: [String]

    public init(command: EngineCommand, paths: [String]) {
        self.command = command
        self.paths = paths
    }
}

/// M14: the `AskUserQuestion` tool's input (Agent SDK `AskUserQuestionInput`), decoded leniently from the permission
/// request so the chat can show a question card instead of the raw-JSON permission card.
public struct AskUserQuestions: Sendable, Equatable {
    public static let toolName = "AskUserQuestion"

    public struct Option: Sendable, Equatable, Hashable, Identifiable {
        public var label: String
        public var description: String
        public var preview: String?
        public var id: String { label }

        public init(label: String, description: String, preview: String? = nil) {
            self.label = label
            self.description = description
            self.preview = preview
        }
    }

    public struct Question: Sendable, Equatable, Identifiable {
        public var question: String
        public var header: String
        public var options: [Option]
        public var multiSelect: Bool
        public var id: String { question }

        public init(question: String, header: String, options: [Option], multiSelect: Bool = false) {
            self.question = question
            self.header = header
            self.options = options
            self.multiSelect = multiSelect
        }
    }

    public var questions: [Question]
    /// Answers already given (`updatedInput.answers`), keyed by question text; empty while pending.
    public var answers: [String: String]

    public init(questions: [Question], answers: [String: String] = [:]) {
        self.questions = questions
        self.answers = answers
    }

    /// nil unless `request` is an `AskUserQuestion` call with at least one well-formed question.
    public init?(request: PermissionRequest) {
        guard request.toolName == Self.toolName, case .array(let items)? = request.input["questions"] else { return nil }
        let questions: [Question] = items.compactMap { (item: JSONValue) -> Question? in
            guard let text = item["question"]?.stringValue else { return nil }
            let rawOptions: [JSONValue] = if case .array(let a)? = item["options"] { a } else { [] }
            let options: [Option] = rawOptions.compactMap { (opt: JSONValue) -> Option? in
                guard let label = opt["label"]?.stringValue else { return nil }
                return Option(label: label, description: opt["description"]?.stringValue ?? "", preview: opt["preview"]?.stringValue)
            }
            let multi: Bool = if case .bool(let b)? = item["multiSelect"] { b } else { false }
            return Question(question: text, header: item["header"]?.stringValue ?? "", options: options, multiSelect: multi)
        }
        guard !questions.isEmpty else { return nil }
        var answers: [String: String] = [:]
        for (k, v) in request.input["answers"]?.objectValue ?? [:] { if let s = v.stringValue { answers[k] = s } }
        self.init(questions: questions, answers: answers)
    }

    /// The `updatedInput` for the permission reply: the original `questions` array passed through plus `answers`.
    public static func updatedInput(for request: PermissionRequest, answers: [String: String]) -> JSONValue {
        .object([
            "questions": request.input["questions"] ?? .array([]),
            "answers": .object(answers.mapValues(JSONValue.string)),
        ])
    }

    /// One answer string for a question: the selected labels (in option order, then free text) joined with ", ".
    public static func answerText(selectedLabels: [String], other: String?) -> String {
        var parts = selectedLabels
        if let other = other?.trimmingCharacters(in: .whitespacesAndNewlines), !other.isEmpty { parts.append(other) }
        return parts.joined(separator: ", ")
    }
}

// MARK: wave2 check-clients
extension AppState {
    /// M7 / §2.9 for "Stop & send": a `send_failed` / `lfs_missing` while the send behind the interrupt has not been
    /// answered is that send's own failure (the interrupted turn ended before it ran, so `recentSend` is gone). The message
    /// goes back to the front of the queue, which the error stops — it was dropped. False when no such send is waiting.
    func requeueFailedSendBehindInterrupt() -> Bool {
        guard let pending = pendingInterruptSend, !interruptFallback else { return false }
        pendingInterruptSend = nil
        sendAfterInterrupt = nil
        requeueFront(pending)
        return true
    }
}
