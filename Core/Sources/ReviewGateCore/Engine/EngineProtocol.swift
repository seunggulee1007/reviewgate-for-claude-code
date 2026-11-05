import Foundation

// Protocol v2 wire types (docs/PROTOCOL.md; TypeScript source of truth: engine/src/protocol.ts).
// `EngineCommand` is what the app sends, `EngineEvent` what it receives; `ReviewState` is the snapshot
// the engine emits after every mutation. Field names match the TypeScript types one to one.

// MARK: - Shared types

public struct Budget: Codable, Sendable, Equatable {
    public var maxFiles: Int
    public var maxLines: Int
    public var hardMultiplier: Double?

    public init(maxFiles: Int, maxLines: Int, hardMultiplier: Double? = nil) {
        self.maxFiles = maxFiles
        self.maxLines = maxLines
        self.hardMultiplier = hardMultiplier
    }
}

/// `TurnUsage` on the wire.
public struct Usage: Codable, Sendable, Equatable {
    public var inputTokens: Int
    public var outputTokens: Int
    /// Cost of this turn only (the engine differences the SDK's cumulative total).
    public var costUsd: Double
    public var durationMs: Int
    // M7 (all optional on the wire; 0 / nil when absent)
    public var cacheReadTokens: Int
    public var cacheCreationTokens: Int
    /// input + cacheRead + cacheCreation of the turn's last assistant message = current context size.
    public var contextTokens: Int
    public var contextWindow: Int?
    // MARK: wave4c w4c-commit
    /// §41.1: this turn compacted the conversation (nil on older engines and for every other turn).
    public var compacted: TurnCompaction?
    // MARK: wave4d w4d-agents2
    /// §42.4: what each model cost this turn, most expensive first; empty on older engines / CLIs.
    public var models: [ModelCost] = []

    public init(inputTokens: Int, outputTokens: Int, costUsd: Double, durationMs: Int,
                cacheReadTokens: Int = 0, cacheCreationTokens: Int = 0, contextTokens: Int = 0, contextWindow: Int? = nil,
                compacted: TurnCompaction? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.costUsd = costUsd
        self.durationMs = durationMs
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.compacted = compacted
    }

    private enum CodingKeys: String, CodingKey {
        case inputTokens, outputTokens, costUsd, durationMs, cacheReadTokens, cacheCreationTokens, contextTokens, contextWindow
        case compacted   // wave4c w4c-commit
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            inputTokens: try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0,
            outputTokens: try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0,
            costUsd: try c.decodeIfPresent(Double.self, forKey: .costUsd) ?? 0,
            durationMs: try c.decodeIfPresent(Int.self, forKey: .durationMs) ?? 0,
            cacheReadTokens: try c.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0,
            cacheCreationTokens: try c.decodeIfPresent(Int.self, forKey: .cacheCreationTokens) ?? 0,
            contextTokens: try c.decodeIfPresent(Int.self, forKey: .contextTokens) ?? 0,
            contextWindow: try c.decodeIfPresent(Int.self, forKey: .contextWindow),
            compacted: lenientValue(TurnCompaction.self, c, .compacted))   // wave4c w4c-commit
        models = AgentCostWire.models(from: decoder)   // wave4d w4d-agents2 (§42.4)
    }
}

public typealias TurnUsage = Usage

/// What the CLI reported in `system/init` (docs/M7-API.md): user + project skills, slash commands, plugins, MCP servers.
public struct SessionCapabilities: Sendable {
    public let slashCommands: [String]
    public let skills: [String]
    /// Plugin names.
    public let plugins: [String]
    public let mcpServers: [(name: String, status: String)]
    /// §16: the plugins with install path and `name@marketplace` id; empty on older engines / caches.
    public let pluginDetails: [PluginDetail]
    // MARK: wave3 mac-session
    /// §36.5: the commands with description, argument hint and source; empty on older engines / caches.
    public var commands: [SlashCommandInfo] = []
    /// §36.5: `starting` until the CLI answered initialize; nil (= ready) on older engines.
    public var state: CapabilitiesState?

    public init(slashCommands: [String], skills: [String], plugins: [String], mcpServers: [(name: String, status: String)],
                pluginDetails: [PluginDetail] = []) {
        self.slashCommands = slashCommands
        self.skills = skills
        self.plugins = plugins
        self.mcpServers = mcpServers
        self.pluginDetails = pluginDetails
    }

    public static let empty = SessionCapabilities(slashCommands: [], skills: [], plugins: [], mcpServers: [])
}

extension SessionCapabilities: Equatable {
    public static func == (lhs: SessionCapabilities, rhs: SessionCapabilities) -> Bool {
        lhs.slashCommands == rhs.slashCommands && lhs.skills == rhs.skills && lhs.plugins == rhs.plugins
            && lhs.mcpServers.map(\.name) == rhs.mcpServers.map(\.name)
            && lhs.mcpServers.map(\.status) == rhs.mcpServers.map(\.status)
            && lhs.pluginDetails == rhs.pluginDetails
            && lhs.commands == rhs.commands && lhs.state == rhs.state   // wave3 mac-session
    }
}

/// Wire form (`state.session.capabilities`) and the UserDefaults cache (`AppSettings.Key.cachedCapabilities`);
/// `mcpServers` as `[{name, status}]`.
extension SessionCapabilities: Codable {
    private enum CodingKeys: String, CodingKey { case slashCommands, skills, plugins, mcpServers, pluginDetails }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let servers = try c.decodeIfPresent([NamedEntry].self, forKey: .mcpServers) ?? []
        self.init(
            slashCommands: try c.decodeIfPresent([String].self, forKey: .slashCommands) ?? [],
            skills: try c.decodeIfPresent([String].self, forKey: .skills) ?? [],
            plugins: try c.decodeIfPresent([String].self, forKey: .plugins) ?? [],
            mcpServers: servers.map { (name: $0.name, status: $0.status ?? "") },
            pluginDetails: (try? c.decodeIfPresent([PluginDetail].self, forKey: .pluginDetails)) ?? [])
        decodeCommandFields(from: decoder)   // wave3 mac-session: commands, state
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(slashCommands, forKey: .slashCommands)
        try c.encode(skills, forKey: .skills)
        try c.encode(plugins, forKey: .plugins)
        try c.encode(mcpServers.map { NamedEntry(name: $0.name, status: $0.status, path: nil) }, forKey: .mcpServers)
        if !pluginDetails.isEmpty { try c.encode(pluginDetails, forKey: .pluginDetails) }
        try encodeCommandFields(to: encoder)   // wave3 mac-session
    }
}

/// Wire shape of `mcpServers` (`{name, status}`) and `session_info.plugins` (`{name, path}`).
struct NamedEntry: Codable {
    var name: String
    var status: String?
    var path: String?
}

/// `activity` event kinds (docs/M7-API.md). Cheap, best-effort HUD signal.
public enum ActivityKind: String, Codable, Sendable {
    case toolStart = "tool_start"
    case toolEnd = "tool_end"
    case subagentStart = "subagent_start"
    case subagentEnd = "subagent_end"
    case thinking
    case idle
}

public struct BudgetUsage: Codable, Sendable, Equatable {
    public var files: Int
    public var lines: Int
    public var denied: Bool

    public init(files: Int, lines: Int, denied: Bool) {
        self.files = files
        self.lines = lines
        self.denied = denied
    }
}

public enum BudgetEventKind: String, Codable, Sendable {
    case warn, deny
}

public enum LogLevel: String, Codable, Sendable {
    case debug, info, warn, error
}

public struct PermissionRequest: Codable, Sendable, Equatable, Identifiable {
    public var requestId: String
    public var toolName: String
    public var input: JSONValue
    public var file: String?
    // MARK: wave1 mac-perms
    /// §33.1: the call's own tool_use id (the id of its `tool_use` event, which arrives first).
    public var toolUseId: String?
    /// §33.1: set when a subagent asks; nil for the main agent.
    public var agent: PermissionAgent?
    /// §33.3 / §33.4: the call works somewhere this window's review does not see (the card says why).
    public var reason: PermissionReason?
    /// §33.6: what "이 프로젝트에서 항상 허용" may store for this call, most specific first; empty for Bash (the client
    /// derives `Bash(prog sub:*)` itself), edit tools, SendMessage and requests with a `reason`.
    public var allowPatterns: [String] = []
    // MARK: wave4d w4d-peers
    /// §42.2: a SendMessage to another session's address — the live session it reaches; nil when the engine knows none.
    public var toSession: PeerSessionInfo?

    public var id: String { requestId }

    public init(requestId: String, toolName: String, input: JSONValue, file: String? = nil) {
        self.requestId = requestId
        self.toolName = toolName
        self.input = input
        self.file = file
    }
}

/// Which side of the diff a review note points at.
public enum DiffSide: String, Sendable, Hashable, Codable { case old, new }

/// M20 (docs/M20-MODES.md, PROTOCOL.md §11): the four permission modes we expose. The SDK's
/// `bypassPermissions` / `dontAsk` are deliberately not exposed — they would defeat the review gate.
/// Case order is the order the mode picker offers them in.
public enum PermissionMode: String, Codable, Sendable, CaseIterable, Identifiable {
    case `default`, auto, plan, acceptEdits

    public var id: String { rawValue }

    /// Localized name for the composer's mode picker and the HUD badge.
    public var displayName: String {
        switch self {
        case .default: String(localized: "Default", bundle: .module)
        case .auto: String(localized: "Auto", bundle: .module)
        case .plan: String(localized: "Plan", bundle: .module)
        case .acceptEdits: String(localized: "Accept edits", bundle: .module)
        }
    }

    /// One-line explanation shown next to the name.
    public var helpText: String {
        switch self {
        case .default: String(localized: "Ask before every tool that is not read-only", bundle: .module)
        case .auto: AutoModeText.helpText   // wave4b w4b-auto (§39.5)
        case .plan: String(localized: "Read-only: Claude writes a plan and waits for your approval", bundle: .module)
        case .acceptEdits: String(localized: "Edits are approved automatically; Bash and friends still ask", bundle: .module)
        }
    }
}

/// `state.session.pendingPlan` / `plan_proposed`: the plan a plan-mode turn wrote, waiting for `plan_response`.
/// `path` is null when the plan only came through `ExitPlanMode`.
public struct PendingPlan: Codable, Sendable, Equatable {
    public var path: String?
    public var plan: String
    /// ISO-8601 as written by the engine.
    public var at: String
    // MARK: wave4d w4d-plan
    /// §42.1: the plan's steps for per-step notes (nil: an older engine — the card keeps its one note field).
    public var steps: [PlanStepBrief]?

    public init(path: String?, plan: String, at: String = "", steps: [PlanStepBrief]? = nil) {
        self.path = path
        self.plan = plan
        self.at = at
        self.steps = steps
    }

    private enum CodingKeys: String, CodingKey { case path, plan, at, steps }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            path: try c.decodeIfPresent(String.self, forKey: .path),
            plan: try c.decodeIfPresent(String.self, forKey: .plan) ?? "",
            at: try c.decodeIfPresent(String.self, forKey: .at) ?? "",
            steps: Self.decodeSteps(from: decoder))   // MARK: wave4d w4d-plan (lenient)
    }
}

// MARK: - Settings (`hello.settings` / `set_settings.settings`)

/// `Settings` on the wire. `hello` sends every field; `set_settings` sends only the fields to change
/// (`nil` fields are omitted, i.e. `Partial<Settings>`).
public struct EngineSettings: Encodable, Sendable, Equatable {
    public var budget: Budget?
    /// Parsed, one entry per pattern.
    public var ignorePatterns: [String]?
    /// e.g. ["Bash"]; edit tools are always auto-allowed.
    public var autoAllowTools: [String]?
    public var loadUserSettings: Bool?
    /// Already rendered (`{maxFiles}`/`{maxLines}` substituted).
    public var systemPromptAppend: String?
    public var claudePath: String?
    public var ghPath: String?
    public var gitPath: String?
    /// PR browser host.
    public var ghHost: String?
    public var model: String?
    /// Managed folder for new workbenches (M10); nil → engine default.
    public var worktreeRoot: String?
    /// M12: the commit sheet's "Push to origin" default and the trailer line appended to every message.
    public var commitPushByDefault: Bool?
    public var commitTrailer: String?
    // MARK: wave3 mac-flow
    /// §36.11: the format `commit_draft` asks for, kept per project in the app ("" clears it; live).
    public var commitTemplate: String?
    /// §36.12: how `workbench_create` prepares a new workbench, kept per project in the app (live).
    public var workbenchSetup: WorkbenchSetup?
    /// M13 (audit 1.4): restart the Claude session once when it dies unexpectedly (engine default true).
    public var autoRestartSession: Bool?
    /// M16: read-only Bash commands (`git status`, `ls`, …) are auto-allowed (engine default true).
    public var autoAllowReadOnlyBash: Bool?
    /// M16: Claude-style allow rules (`Bash(npm test:*)`, `Bash(git *)`) evaluated before the permission card.
    public var bashAllowPatterns: [String]?
    // MARK: wave1 mac-perms
    /// §33.4: the Workflow tool and isolated agents get a card (with the warning) instead of a deny; next session start.
    public var allowWorktreeIsolation: Bool?
    /// §33.5: the user's Claude Code `permissions.allow` rules apply to tools that cannot change files (engine default true; live).
    public var applyUserAllowRules: Bool?
    /// §33.7: "세션 동안 허용" answers are kept per worktree and restored when the project opens (engine default false).
    public var persistSessionAllows: Bool?
    /// M20: the mode a NEW session starts in; a live session only changes through `set_permission_mode` (§11).
    public var permissionMode: PermissionMode?
    /// §16: with user settings loaded, restart without them when the CLI has not initialized after this many ms
    /// (engine default 20 000; 0 = off).
    public var extensionsInitTimeoutMs: Int?
    /// §16: plugins to keep off (`name@marketplace`, or a bare name); next session start.
    public var disabledPlugins: [String]?
    /// §16: turn off every settings-file and plugin hook (ReviewGate's own hooks keep running); next session start.
    public var disableUserHooks: Bool?
    /// §21: model of side-question sessions (nil = `model`).
    public var sideModel: String?
    /// §21: side sessions may use WebFetch / WebSearch (nil = engine default, true).
    public var sideAllowWeb: Bool?
    // MARK: wave1 mac-session
    /// §29: what happens to messages from the user's other Claude sessions (a project's `peer_set` wins; engine default `ask`).
    public var peerInbound: PeerInboundMode?
    // MARK: wave2 contract (§34.9)
    /// Extra test commands (`*` any run, `?` one char) matched against every simple command of a Bash call; live.
    public var testCommandPatterns: [String]?
    // MARK: wave3 mac-session
    /// §36.6: also load `.claude/settings.local.json` and the local-scope MCP servers (kept per project, sent before
    /// `open_project`; engine default true; next session start).
    public var loadLocalSettings: Bool?
    // MARK: wave4 w4-longwork
    /// §38.2: the tool-call limit of one message (engine default 200, 10–1000; next session start).
    public var maxTurns: Int?
    /// §52: background commands, Ctrl+B and turns Claude starts itself as review turns (engine default true; next session start).
    public var backgroundWork: Bool?
    // MARK: wave4b w4b-bigturn
    /// §39.1: an untracked file at least this large (MB) is a stub in snapshots (engine default 50; live).
    public var largeFileMB: Int?
    // MARK: wave4b w4b-side
    /// §40.3: side questions on the web — `off` (engine default), `rules`, `on` (`SideWebMode` raw value; live).
    public var sideWeb: String?
    // MARK: wave5 w5-model
    /// §43.4: `auto` picks the model of every message (`ModelMode` raw value; engine default `manual`; live).
    public var modelMode: String?
    /// §43.4: `cost` / `balanced` / `quality` (`AutoModelPolicy` raw value; engine default `balanced`; live).
    public var modelAutoPolicy: String?
    // MARK: wave6 w6-statusline
    /// §44.2: run the user's Claude Code status line for the chat to show (engine default true; live).
    public var showStatusLine: Bool?
    /// §44.2: the sha256 of the project's own `statusLine` command (`.claude/settings(.local).json` — code from the
    /// repository) the user allowed for this project: it runs only while its command hashes to this ("" none; per
    /// project, sent before each `open_project` as `loadLocalSettings`; live).
    public var allowedProjectStatusLine: String?

    public init(budget: Budget? = nil, ignorePatterns: [String]? = nil, autoAllowTools: [String]? = nil,
                loadUserSettings: Bool? = nil, systemPromptAppend: String? = nil, claudePath: String? = nil,
                ghPath: String? = nil, gitPath: String? = nil, ghHost: String? = nil, model: String? = nil,
                worktreeRoot: String? = nil, commitPushByDefault: Bool? = nil, commitTrailer: String? = nil,
                autoRestartSession: Bool? = nil, autoAllowReadOnlyBash: Bool? = nil, bashAllowPatterns: [String]? = nil,
                permissionMode: PermissionMode? = nil, extensionsInitTimeoutMs: Int? = nil, disabledPlugins: [String]? = nil,
                disableUserHooks: Bool? = nil, sideModel: String? = nil, sideAllowWeb: Bool? = nil) {
        self.budget = budget
        self.ignorePatterns = ignorePatterns
        self.autoAllowTools = autoAllowTools
        self.loadUserSettings = loadUserSettings
        self.systemPromptAppend = systemPromptAppend
        self.claudePath = claudePath
        self.ghPath = ghPath
        self.gitPath = gitPath
        self.ghHost = ghHost
        self.model = model
        self.worktreeRoot = worktreeRoot
        self.commitPushByDefault = commitPushByDefault
        self.commitTrailer = commitTrailer
        self.autoRestartSession = autoRestartSession
        self.autoAllowReadOnlyBash = autoAllowReadOnlyBash
        self.bashAllowPatterns = bashAllowPatterns
        self.permissionMode = permissionMode
        self.extensionsInitTimeoutMs = extensionsInitTimeoutMs
        self.disabledPlugins = disabledPlugins
        self.disableUserHooks = disableUserHooks
        self.sideModel = sideModel
        self.sideAllowWeb = sideAllowWeb
    }
}

// MARK: - App → Engine

public enum EngineCommand: Sendable, Equatable {
    case hello(client: String = "mac", env: [String: String]? = nil, settings: EngineSettings)
    case setSettings(EngineSettings)
    /// `takeover: true` overrides another live session's lock on the worktree (M10).
    case openProject(path: String, takeover: Bool = false)
    case switchProject(path: String)
    case closeProject
    case initRepo
    case cancelGitInit
    /// M13 (audit 1.4): a fresh Claude session for the open project without resetting the gate.
    case restartSession
    // MARK: wave1 mac-session (§29 peer messages)
    /// Runs every held peer message as one review turn (the `send` gate); `ids` = the held ids the user saw.
    case peerAccept(ids: [String]?)
    /// Refuses every held peer message (the senders get a "not delivered" receipt); `ids` as for `peerAccept`.
    case peerDismiss(ids: [String]?)
    /// This project's peer mode, live and persisted (`settings.peerInbound` is the default).
    case peerSet(mode: PeerInboundMode)
    /// M16: `acceptPending` accepts every pending (not changes-requested) file before sending.
    /// §23 / §24: `mentions` = repo-relative paths (≤ 20), `attachments` = images (≤ 5 × 5 MiB).
    case send(text: String, acceptPending: Bool = false, mentions: [String] = [], attachments: [SendAttachment] = [])
    /// §50: a message into the turn that runs (as typing while Claude works in the terminal); refused
    /// `steer_unavailable:<why>` when no turn of ours runs.
    case steer(text: String, mentions: [String] = [])
    // MARK: wave5 w5-model
    /// §43.4: `send` with `model` — this message only goes out on that model (wins over auto).
    case sendWithModel(text: String, acceptPending: Bool = false, mentions: [String] = [], attachments: [SendAttachment] = [], model: String)
    /// `noteIds`: only these unsent notes (a note's "send only this"); nil sends every unsent note.
    case requestChanges(extra: String? = nil, noteIds: [String]? = nil)
    case interrupt
    /// M16: `remember` auto-allows the same tool + command prefix for the rest of the session.
    case permissionResponse(requestId: String, allow: Bool, message: String? = nil, updatedInput: JSONValue? = nil, remember: Bool = false)
    /// M16: clears `state.session.rememberedAllows`.
    case forgetAllows
    // MARK: wave1 mac-perms
    /// §33.8: the user's Claude Code allow rules and what ReviewGate does with each (query lane) → `.permissionRules`.
    case permissionRules
    /// M20: switches the live session's permission mode (§11); refused with `session_busy` while a turn runs.
    case setPermissionMode(mode: PermissionMode)
    /// M20: answers `state.session.pendingPlan` — approve into `mode` (default `.default`) or keep planning.
    case planResponse(approve: Bool, mode: PermissionMode? = nil, message: String? = nil)
    case accept(paths: [String])
    /// Accepted → pending again; nothing on disk changes.
    case unaccept(paths: [String])
    case acceptAll
    /// §19.1: `force` reverts even files the user edited after the review (refused `file_changed_since_review` otherwise).
    case reject(paths: [String], force: Bool = false)
    /// §31: without `includeExternal` only the pending files Claude changed (origin tool / bash) are reverted; the
    /// client sends it only after the user confirmed the list of external files.
    case rejectAll(force: Bool = false, includeExternal: Bool = false)
    // MARK: wave1 mac-review — §31.5
    /// `finish_review`: empties the review list and its notes; no file is touched (the pending ones become the next
    /// turn's baseline). Refused `session_running` / `reverting` / `collect_failed`.
    case finishReview
    /// `keep_review`: dismisses `state.gate.stale` ("이어서 리뷰"); nothing else changes.
    case keepReview
    /// §17: reverts only these hunks (`FileDiff.hunks[].id` of the file's current diff) of a pending modified file;
    /// `expectedEndTree` = the `gate.turnEndTree` that diff was computed for (refused with `stale_diff` otherwise).
    /// §34.1 `expectedBaseTree`: the `file_diff.baseTree` the ids came from (anything but A refuses `stale_diff`).
    case rejectHunks(path: String, hunks: [Int], expectedEndTree: String? = nil, expectedBaseTree: String? = nil)
    case retryCollect
    case addNote(path: String, line: Int?, side: DiffSide, excerpt: String, body: String)
    case removeNote(noteId: String)
    case editNote(noteId: String, body: String)
    /// §34.1 `since`: which part of the change (nil = `review`, A → B); also answered while a turn runs (§34.2, `stale`).
    case selectFile(path: String, since: DiffSince? = nil)
    case fullFile(path: String, since: DiffSince? = nil)
    // MARK: wave2 contract (§34.6)
    /// The running turn's changes so far (read-only) → `.liveChanges`.
    case liveChanges
    /// One file of `live_changes` → `.fileDiff` with scope `.live`.
    case liveDiff(path: String)
    /// The kept output of a Bash `tool_result` (≤ ~20k chars); replies `.toolOutput`.
    case toolOutput(toolUseId: String)
    // MARK: wave3 mac-agents
    /// §36.1: a subagent's whole cleaned report, instructions, usage and model (a pure read) → `.agentReport`.
    case agentReport(toolUseId: String)
    /// §36.2: stops that one subagent (`result`); the main turn and the other agents go on.
    case stopAgent(toolUseId: String)
    // MARK: §52 background work
    /// Stops a background task (`result`).
    case taskStop(taskId: String)
    /// Ctrl+B: the running call (all foreground tasks with nil) goes on in the background → `.taskBackground`.
    case taskBackground(toolUseId: String?)
    /// The end of a background task's output → `.taskOutput`.
    case taskOutput(taskId: String)
    case branches
    case switchBranch(name: String)
    case createBranch(name: String, from: String? = nil)
    case prList
    case prOpen(summaryId: String)
    case prClose
    case prSelectFile(filename: String)
    case prAddDraft(path: String, line: Int, side: String, startLine: Int? = nil, body: String)
    case prRemoveDraft(draftId: String)
    case prSubmit(event: ReviewEvent, body: String)
    case prReply(commentId: Int, body: String)
    case prReloadComments
    case accounts
    case loginInTerminal(host: String)
    // M10 workbenches (docs/M10-WORKBENCHES.md)
    case workbenchList
    /// wave3 mac-flow: `options` = §36.12 fetch / setup / location and §36.14 fromPr (nil fields = the engine's defaults).
    case workbenchCreate(branch: String, from: String? = nil, path: String? = nil, options: WorkbenchCreateOptions = WorkbenchCreateOptions())
    case workbenchRemove(path: String, force: Bool = false)
    case workbenchPrune
    case prCreate(base: String, title: String? = nil, body: String? = nil, draft: Bool? = nil)
    // M12 commit (docs/M12-COMMIT.md): `paths` nil → every accepted file; `push` nil → engine default (false).
    case commit(message: String, paths: [String]? = nil, push: Bool? = nil)
    /// Retries the push of `state.commit.lastCommit` after `push_failed`.
    case push
    // MARK: wave3 mac-flow
    /// §36.11: a commit message drafted by a read-only fork → `.commitDraft` (nothing is committed). `paths` as `commit`.
    case commitDraft(paths: [String]? = nil)
    /// §36.12: where `workbench_create` would put the workbench and what it would copy → `.workbenchPreview`.
    case workbenchPreview(branch: String, from: String? = nil, location: WorkbenchLocation? = nil)
    /// §36.13: AI pre-review of the round in a read-only fork → `.prereview` (status running).
    case prereviewStart(scope: PreReviewScope, paths: [String]? = nil, effort: PreReviewEffort)
    case prereviewCancel(prereviewId: String)
    case prereviewDismiss(prereviewId: String, findingId: String)
    // M15 (docs/M15-POLISH.md): `refresh` re-reads what `scope` names (nil → everything applicable, incl. a re-diff
    // of the pending review); chat sessions (history + tabs).
    case refresh(scope: [RefreshScope]? = nil)
    case sessionList
    case sessionNew
    case sessionOpen(id: String)
    case sessionRename(id: String, title: String)
    case sessionArchive(id: String, archived: Bool)
    case sessionDelete(id: String)
    case tabsSet(openTabIds: [String])
    /// §14: past review rounds — the given session's (nil → the current one), or every session's with `all`.
    case reviewHistory(sessionId: String? = nil, all: Bool = false)
    /// §14: one file's diff of a history entry; replies `.historyDiff`.
    case historyDiff(entryId: String, path: String)
    // §21 side questions
    case sideAsk(threadId: String? = nil, anchor: SideAnchor? = nil, question: String)
    case sideList
    case sideClose(threadId: String)
    case sideCancel(threadId: String)
    case sidePromoteDraft(threadId: String)
    /// `text` nil → the engine answers with a draft and promotes nothing.
    case sidePromote(threadId: String, target: SidePromoteTarget, text: String?, acceptPending: Bool = false)
    // §22 MCP servers
    case mcpStatus
    case mcpReconnect(name: String)
    case mcpToggle(name: String, enabled: Bool)
    case mcpAdd(name: String, scope: McpScope, config: McpAddConfig)
    case mcpRemove(name: String, scope: McpScope)
    case mcpAuth(name: String)
    // §23–27
    /// Fuzzy file search for @-mentions → `files`.
    case listFiles(query: String, limit: Int? = nil)
    /// An image a transcript row references → `attachment`.
    case attachmentGet(hash: String)
    /// The model / effort of the session from its next request on (persisted per project).
    case setModel(model: String, effort: EffortUpdate = .unchanged)
    /// Edit & retry / "이 시점으로 되돌리기" → `rewound`.
    case rewind(toTurn: Int, mode: RewindMode, editText: String? = nil, mentions: [String] = [], attachments: [SendAttachment] = [], force: Bool = false)
    /// The CLI's `/compact [focus]` as a turn.
    case compact(focus: String? = nil)
    // MARK: wave3 mac-session
    /// §36.7: after the init-timeout fallback, restart the session with the user's extensions (`result`).
    case retryExtensions
    /// §36.8: the installed CLI versions → `.cliVersions`.
    case cliVersions
    /// §36.9: the user's other Claude sessions of this repository → `.cliSessions`.
    case cliSessions
    /// §36.9: resume a terminal session as a new chat of this window (`result`); the review gate applies from then on.
    case cliSessionImport(sessionId: String)
    // MARK: wave4 w4-history
    /// §38.3: the rows of a chat (nil: the current one) before row `before` → `.transcriptPage`.
    case transcriptPage(sessionId: String?, before: Int, beforeAt: String?, limit: Int? = nil)
    /// §38.3: every chat's user messages and Claude answers containing `query` → `.transcriptSearch`.
    case transcriptSearch(query: String)
    // MARK: wave4b w4b-bigturn
    /// §39.1: save the review, its history and the chat's checkpoints again (refused `save_failed` while one fails).
    case retrySave
    /// §39.1: count (`apply` false) or remove the review rounds / checkpoints beyond the newest `keep` → `.historyCleanup`.
    case historyCleanup(keep: Int?, apply: Bool)
    // MARK: wave4b w4b-follow
    /// §39.4: hands this chat to another worktree of the repository (`interrupt`: stop the running turn first) → `.chatMoved`.
    case chatMove(path: String, interrupt: Bool, followUp: String?)
    /// §39.4: takes the chats handed to this worktree and opens the newest one.
    case chatReceive
    /// §39.4 "허용하고 따라가기": `permission_response {allow: true, follow: true}` — the chat moves once the worktree command ran.
    case permissionFollow(requestId: String, followUp: String?)
    // MARK: wave4d w4d-config
    /// §42.3: `mcp_toggle` kept for every worktree of the repository (`repository`) or this worktree.
    case mcpToggleScoped(name: String, enabled: Bool, repository: Bool)
    /// §42.3: `mcp_remove` from the file the user confirmed (`origin.file`, a parent folder's `.mcp.json`).
    case mcpRemoveFile(name: String, scope: McpScope, file: String)
    /// §42.3: a CLAUDE.md / CLAUDE.local.md of the project → `.claudeMd`.
    case claudeMdRead(path: String)
    /// §42.3: saves it over what was read (`baseSha` nil = create) → `.claudeMd`.
    case claudeMdWrite(path: String, text: String, baseSha: String?)
    // MARK: wave5 w5-brain
    /// §43.2: the sub-brain (auto memory); `watch` true / false starts / stops the engine's 4 s re-read → `.brain`.
    case brain(watch: Bool?)
    /// §43.2: one memory's text (read only) → `.brainMemory`.
    case brainRead(name: String)
    // MARK: wave4b w4b-side
    /// §40.3 [최신 대화로 다시 묻기]: `side_ask {threadId, question, refork: true}` — the latest main conversation, with the thread's Q&A.
    case sideRefork(threadId: String, question: String)
    /// §40.3: `side_promote {threadId, as: "message", text, queued: true}` — the conclusion went to the composer queue (only recorded).
    case sidePromoteQueued(threadId: String, text: String)
    // MARK: wave4c w4c-trust — §41.2
    /// This repository's auto-accept rules (every worktree of it); applies from the next collection.
    case setAutoAccept(rules: AutoAcceptRules)
    /// Files a rule accepted go back to pending (`paths` nil: all of them); nothing on disk changes.
    case autoAcceptUndo(paths: [String]?)
    /// Puts the last single-file reject back (`state.gate.rejectUndo`).
    case rejectUndo(path: String)
    // MARK: wave4c w4c-commit
    /// §41.1: the team's commit format learned from the recent subjects → `.commitFormat`.
    case commitFormat
    /// §41.1: the PR sheet's title / body from the branch's commits since `base`, the push and `gh` readiness → `.prDraft`.
    case prDraft(base: String)
    /// §51: the PR sheet's title / description written by a read-only fork from the branch's commits and diff since `base`,
    /// the repository's PR template and the sheet's `title` / `body` → `.prAiDraft` (nothing is pushed or created).
    case prAiDraft(base: String, title: String, body: String)
    // MARK: §53 commits in meaningful units
    /// §53: the accepted files as hunks of `git diff HEAD` → `.commitHunks`. `paths` as `commit`.
    case commitHunks(paths: [String]? = nil)
    /// §53: Claude's proposal of the split, in a read-only fork (side lane) → `.commitSplitDraft`. `paths` as `commit`.
    case commitSplitDraft(paths: [String]? = nil)
    /// §53: the commits in order (the hooks run, the worktree untouched), then one push when `push` (nil: the engine's
    /// default) → `.committedSeries`.
    case commitSeries(commits: [CommitPlan], push: Bool? = nil)
    /// §41.1: `pr_create` with the assignee / labels / reviewers / projects (→ `.prCreated`).
    case prCreateMeta(base: String, title: String?, body: String?, draft: Bool?, meta: PRCreateMeta)
    // MARK: wave4c w4c-review
    /// §41.3: the new side of a history file's diff ("Show 20 more lines") → `.fileLines`.
    case historyFileLines(entryId: String, path: String)
    /// §41.3: the open PR's file at its head commit ("Show 20 more lines") → `.fileLines`.
    case prFileLines(filename: String)
    /// §41.3: both sides of a changed png / jpg / gif → `.fileImage`.
    case fileImage(path: String)
    /// §41.3: `select_file {path, since?, ignoreWhitespace: true}` — the `-w` diff (read-only: its hunks are not A's) → `.fileDiff`.
    case selectFileIgnoringWhitespace(path: String, since: DiffSince? = nil)
    /// §41.3: `transcript_search {query, perChat}` — up to `perChat` matches per chat with `more` / `total` → `.transcriptSearch`.
    case transcriptSearchPerChat(query: String, perChat: Int)
    // MARK: wave4d w4d-plan
    /// §42.1: `plan_response {approve: true, mode, into, path?}` — implement in a fresh chat here, or hand the plan to the workbench at `path`.
    case planImplement(mode: PermissionMode, into: PlanInto, path: String?)
    /// §42.1: `plan_follow {path}` — the plan file this chat's "plan vs actual" follows (nil: the automatic sources).
    case planFollow(path: String?)
    // MARK: wave5 w5-graph
    /// §43.3: the code graph's summary and freshness → `.codeGraph`.
    case codeGraph
    /// §43.3: `graphify update .` in the background → `.codeGraph` (then unsolicited `.codeGraph` while it runs and when it ends).
    case codeGraphBuild
    // MARK: wave6 w6-statusline
    /// §44.2: the user's status line — the width the chat draws it in (columns) and whether it is on screen → `.statusLine`
    /// (then unsolicited `.statusLine` whenever it changes).
    case statusLine(columns: Int?, visible: Bool?)
    // MARK: code-browser
    /// §47: any file of the project, read-only (repo-relative) → `.projectFile`.
    case projectFile(path: String)
    /// §47: `git grep` over the project's files (a fixed string; case ignored unless `caseSensitive`) → `.projectSearch`.
    case projectSearch(query: String, caseSensitive: Bool = false, wholeWord: Bool = false, limit: Int? = nil)
    case shutdown

    /// The wire `type` discriminator.
    public var type: String {
        switch self {
        case .hello: "hello"
        case .setSettings: "set_settings"
        case .openProject: "open_project"
        case .switchProject: "switch_project"
        case .closeProject: "close_project"
        case .initRepo: "init_repo"
        case .cancelGitInit: "cancel_git_init"
        case .restartSession: "restart_session"
        case .peerAccept: "peer_accept"
        case .peerDismiss: "peer_dismiss"
        case .peerSet: "peer_set"
        case .send: "send"
        case .sendWithModel: "send"   // wave5 w5-model (§43.4)
        case .steer: "steer"   // §50
        case .requestChanges: "request_changes"
        case .interrupt: "interrupt"
        case .permissionResponse: "permission_response"
        case .forgetAllows: "forget_allows"
        case .permissionRules: "permission_rules"   // wave1 mac-perms
        case .setPermissionMode: "set_permission_mode"
        case .planResponse: "plan_response"
        case .accept: "accept"
        case .unaccept: "unaccept"
        case .acceptAll: "accept_all"
        case .reject: "reject"
        case .rejectAll: "reject_all"
        // wave1 mac-review
        case .finishReview: "finish_review"
        case .keepReview: "keep_review"
        case .rejectHunks: "reject_hunks"
        case .retryCollect: "retry_collect"
        case .addNote: "add_note"
        case .removeNote: "remove_note"
        case .editNote: "edit_note"
        case .selectFile: "select_file"
        case .fullFile: "full_file"
        case .liveChanges: "live_changes"   // wave2 contract
        case .liveDiff: "live_diff"
        case .toolOutput: "tool_output"
        case .agentReport: "agent_report"   // wave3 mac-agents
        case .stopAgent: "stop_agent"
        case .taskStop: "task_stop"   // §52
        case .taskBackground: "task_background"
        case .taskOutput: "task_output"
        case .branches: "branches"
        case .switchBranch: "switch_branch"
        case .createBranch: "create_branch"
        case .prList: "pr_list"
        case .prOpen: "pr_open"
        case .prClose: "pr_close"
        case .prSelectFile: "pr_select_file"
        case .prAddDraft: "pr_add_draft"
        case .prRemoveDraft: "pr_remove_draft"
        case .prSubmit: "pr_submit"
        case .prReply: "pr_reply"
        case .prReloadComments: "pr_reload_comments"
        case .accounts: "accounts"
        case .loginInTerminal: "login_in_terminal"
        case .workbenchList: "workbench_list"
        case .workbenchCreate: "workbench_create"
        case .workbenchRemove: "workbench_remove"
        case .workbenchPrune: "workbench_prune"
        case .prCreate: "pr_create"
        case .commit: "commit"
        case .push: "push"
        case .commitDraft: "commit_draft"   // wave3 mac-flow
        case .workbenchPreview: "workbench_preview"
        case .prereviewStart: "prereview_start"
        case .prereviewCancel: "prereview_cancel"
        case .prereviewDismiss: "prereview_dismiss"
        case .refresh: "refresh"
        case .sessionList: "session_list"
        case .sessionNew: "session_new"
        case .sessionOpen: "session_open"
        case .sessionRename: "session_rename"
        case .sessionArchive: "session_archive"
        case .sessionDelete: "session_delete"
        case .tabsSet: "tabs_set"
        case .reviewHistory: "review_history"
        case .historyDiff: "history_diff"
        case .sideAsk: "side_ask"
        case .sideList: "side_list"
        case .sideClose: "side_close"
        case .sideCancel: "side_cancel"
        case .sidePromoteDraft: "side_promote_draft"
        case .sidePromote: "side_promote"
        case .mcpStatus: "mcp_status"
        case .mcpReconnect: "mcp_reconnect"
        case .mcpToggle: "mcp_toggle"
        case .mcpAdd: "mcp_add"
        case .mcpRemove: "mcp_remove"
        case .mcpAuth: "mcp_auth"
        case .listFiles: "list_files"
        case .attachmentGet: "attachment_get"
        case .setModel: "set_model"
        case .rewind: "rewind"
        case .compact: "compact"
        case .retryExtensions: "retry_extensions"   // wave3 mac-session
        case .cliVersions: "cli_versions"
        case .cliSessions: "cli_sessions"
        case .cliSessionImport: "cli_session_import"
        case .transcriptPage: "transcript_page"   // wave4 w4-history
        case .transcriptSearch: "transcript_search"
        case .sideRefork: "side_ask"   // wave4b w4b-side
        case .sidePromoteQueued: "side_promote"   // wave4b w4b-side
        case .setAutoAccept: "set_auto_accept"   // wave4c w4c-trust
        case .autoAcceptUndo: "auto_accept_undo"
        case .rejectUndo: "reject_undo"
        case .retrySave: "retry_save"   // wave4b w4b-bigturn
        case .historyCleanup: "history_cleanup"
        case .chatMove: "chat_move"   // wave4b w4b-follow
        case .chatReceive: "chat_receive"
        case .permissionFollow: "permission_response"
        case .commitFormat: "commit_format"   // wave4c w4c-commit
        case .prDraft: "pr_draft"
        case .prAiDraft: "pr_ai_draft"   // §51
        case .commitHunks: "commit_hunks"   // §53
        case .commitSplitDraft: "commit_split_draft"
        case .commitSeries: "commit_series"
        case .prCreateMeta: "pr_create"
        case .historyFileLines: "history_file_lines"   // wave4c w4c-review
        case .prFileLines: "pr_file_lines"
        case .fileImage: "file_image"
        case .selectFileIgnoringWhitespace: "select_file"
        case .transcriptSearchPerChat: "transcript_search"
        case .mcpToggleScoped: "mcp_toggle"   // wave4d w4d-config
        case .mcpRemoveFile: "mcp_remove"
        case .claudeMdRead: "claude_md_read"
        case .claudeMdWrite: "claude_md_write"
        case .brain: "brain"   // MARK: wave5 w5-brain
        case .brainRead: "brain_read"
        case .planImplement: "plan_response"   // MARK: wave4d w4d-plan
        case .planFollow: "plan_follow"
        case .codeGraph: "code_graph"   // MARK: wave5 w5-graph
        case .codeGraphBuild: "code_graph_build"
        case .statusLine: "status_line"   // MARK: wave6 w6-statusline
        case .projectFile: "project_file"   // MARK: code-browser
        case .projectSearch: "project_search"
        case .shutdown: "shutdown"
        }
    }
}

/// `refresh.scope` entries (M15).
public enum RefreshScope: String, Codable, Sendable, CaseIterable {
    case review, branches, workbenches, pr, accounts
}

extension EngineCommand: Encodable {
    private enum CodingKeys: String, CodingKey {
        case type, protocolVersion, client, env, settings
        case path, text, extra
        case requestId, allow, message, updatedInput
        case paths, line, side, excerpt, body, noteId, noteIds
        case name, from
        case summaryId, filename, startLine, draftId, event, commentId, host
        case takeover, branch, force, base, title, draft
        case push
        case scope, sessionId, archived, openTabIds
        case acceptPending, remember
        case includeExternal   // wave1 mac-review
        case toolUseId
        case mode, approve
        case hunks, expectedEndTree, all, entryId
        case since, expectedBaseTree   // wave2 contract
        case threadId, anchor, question, target = "as", enabled, config
        case query, limit, hash, model, effort, toTurn, editText, mentions, attachments, focus
        case ids   // wave1 mac-session
        case before, beforeAt   // wave4 w4-history
        case keep, apply   // wave4b w4b-bigturn
        case interrupt, follow, followUp   // wave4b w4b-follow
        case refork, queued   // wave4b w4b-side
        case rules   // wave4c w4c-trust
        case ignoreWhitespace, perChat   // wave4c w4c-review
        case file, baseSha   // wave4d w4d-config
        case into   // wave4d w4d-plan
        case watch   // wave5 w5-brain
        case columns, visible   // wave6 w6-statusline
        case caseSensitive, wholeWord   // code-browser
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        switch self {
        // MARK: wave1 mac-session (§29)
        case let .peerAccept(ids), let .peerDismiss(ids):
            try c.encodeIfPresent(ids, forKey: .ids)
        case let .peerSet(mode):
            try c.encode(mode, forKey: .mode)
        case let .hello(client, env, settings):
            try c.encode(PROTOCOL_VERSION, forKey: .protocolVersion)
            try c.encode(client, forKey: .client)
            try c.encodeIfPresent(env, forKey: .env)
            try c.encode(settings, forKey: .settings)
        case let .setSettings(settings):
            try c.encode(settings, forKey: .settings)
        case let .openProject(path, takeover):
            try c.encode(path, forKey: .path)
            if takeover { try c.encode(true, forKey: .takeover) }
        case let .switchProject(path), let .liveDiff(path):
            try c.encode(path, forKey: .path)
        case let .selectFile(path, since), let .fullFile(path, since):
            try c.encode(path, forKey: .path)
            try c.encodeIfPresent(since, forKey: .since)
        case let .toolOutput(toolUseId):
            try c.encode(toolUseId, forKey: .toolUseId)
        case let .agentReport(toolUseId), let .stopAgent(toolUseId):   // wave3 mac-agents
            try c.encode(toolUseId, forKey: .toolUseId)
        case .taskStop, .taskBackground, .taskOutput:   // §52
            try encodeBackgroundFields(to: encoder)
        case .closeProject, .initRepo, .cancelGitInit, .restartSession, .interrupt, .acceptAll, .retryCollect, .branches,
             .prList, .prClose, .prReloadComments, .accounts, .workbenchList, .workbenchPrune, .push, .sessionList, .sessionNew,
             .forgetAllows, .shutdown, .sideList, .mcpStatus, .liveChanges:
            break
        case let .sideAsk(threadId, anchor, question):
            try c.encodeIfPresent(threadId, forKey: .threadId)
            if let anchor, !anchor.isEmpty { try c.encode(anchor, forKey: .anchor) }
            try c.encode(question, forKey: .question)
        case let .sideClose(threadId), let .sideCancel(threadId), let .sidePromoteDraft(threadId):
            try c.encode(threadId, forKey: .threadId)
        case let .sidePromote(threadId, target, text, acceptPending):
            try c.encode(threadId, forKey: .threadId)
            try c.encode(target, forKey: .target)
            try c.encodeIfPresent(text, forKey: .text)
            if acceptPending { try c.encode(true, forKey: .acceptPending) }
        case let .mcpReconnect(name), let .mcpAuth(name):
            try c.encode(name, forKey: .name)
        case let .mcpToggle(name, enabled):
            try c.encode(name, forKey: .name)
            try c.encode(enabled, forKey: .enabled)
        case let .mcpAdd(name, scope, config):
            try c.encode(name, forKey: .name)
            try c.encode(scope, forKey: .scope)
            try c.encode(config, forKey: .config)
        case let .mcpRemove(name, scope):
            try c.encode(name, forKey: .name)
            try c.encode(scope, forKey: .scope)
        case let .rejectAll(force, includeExternal):
            if force { try c.encode(true, forKey: .force) }
            if includeExternal { try c.encode(true, forKey: .includeExternal) }
        case .finishReview, .keepReview:
            break
        case let .refresh(scope):
            try c.encodeIfPresent(scope, forKey: .scope)
        case let .setPermissionMode(mode):
            try c.encode(mode, forKey: .mode)
        case let .planResponse(approve, mode, message):
            try c.encode(approve, forKey: .approve)
            try c.encodeIfPresent(mode, forKey: .mode)
            try c.encodeIfPresent(message, forKey: .message)
        // The session id travels as `sessionId`: `id` is the envelope's correlation id.
        case let .sessionOpen(id), let .sessionDelete(id):
            try c.encode(id, forKey: .sessionId)
        case let .sessionRename(id, title):
            try c.encode(id, forKey: .sessionId)
            try c.encode(title, forKey: .title)
        case let .sessionArchive(id, archived):
            try c.encode(id, forKey: .sessionId)
            try c.encode(archived, forKey: .archived)
        case let .tabsSet(openTabIds):
            try c.encode(openTabIds, forKey: .openTabIds)
        case let .rejectHunks(path, hunks, expectedEndTree, expectedBaseTree):
            try c.encode(path, forKey: .path)
            try c.encode(hunks, forKey: .hunks)
            try c.encodeIfPresent(expectedEndTree, forKey: .expectedEndTree)
            try c.encodeIfPresent(expectedBaseTree, forKey: .expectedBaseTree)
        case let .reviewHistory(sessionId, all):
            try c.encodeIfPresent(sessionId, forKey: .sessionId)
            if all { try c.encode(true, forKey: .all) }
        case let .historyDiff(entryId, path):
            try c.encode(entryId, forKey: .entryId)
            try c.encode(path, forKey: .path)
        case let .commit(message, paths, push):
            try c.encode(message, forKey: .message)
            try c.encodeIfPresent(paths, forKey: .paths)
            try c.encodeIfPresent(push, forKey: .push)
        case let .workbenchCreate(branch, from, path, options):
            try c.encode(branch, forKey: .branch)
            try c.encodeIfPresent(from, forKey: .from)
            try c.encodeIfPresent(path, forKey: .path)
            try options.encode(to: encoder)   // wave3 mac-flow
        // MARK: wave3 mac-flow
        case .commitDraft, .workbenchPreview, .prereviewStart, .prereviewCancel, .prereviewDismiss:
            try encodeFlowFields(to: encoder)
        case let .workbenchRemove(path, force):
            try c.encode(path, forKey: .path)
            if force { try c.encode(true, forKey: .force) }
        case let .prCreate(base, title, body, draft):
            try c.encode(base, forKey: .base)
            try c.encodeIfPresent(title, forKey: .title)
            try c.encodeIfPresent(body, forKey: .body)
            try c.encodeIfPresent(draft, forKey: .draft)
        case let .send(text, acceptPending, mentions, attachments):
            try c.encode(text, forKey: .text)
            if acceptPending { try c.encode(true, forKey: .acceptPending) }
            if !mentions.isEmpty { try c.encode(mentions, forKey: .mentions) }
            if !attachments.isEmpty { try c.encode(attachments, forKey: .attachments) }
        case let .steer(text, mentions):   // §50
            try c.encode(text, forKey: .text)
            if !mentions.isEmpty { try c.encode(mentions, forKey: .mentions) }
        case let .sendWithModel(text, acceptPending, mentions, attachments, model):   // wave5 w5-model (§43.4)
            try c.encode(text, forKey: .text)
            if acceptPending { try c.encode(true, forKey: .acceptPending) }
            if !mentions.isEmpty { try c.encode(mentions, forKey: .mentions) }
            if !attachments.isEmpty { try c.encode(attachments, forKey: .attachments) }
            try c.encode(model, forKey: .model)
        case let .listFiles(query, limit):
            try c.encode(query, forKey: .query)
            try c.encodeIfPresent(limit, forKey: .limit)
        case let .attachmentGet(hash):
            try c.encode(hash, forKey: .hash)
        case let .setModel(model, effort):
            try c.encode(model, forKey: .model)
            switch effort {
            case .unchanged: break
            case .modelDefault: try c.encodeNil(forKey: .effort)
            case let .level(level): try c.encode(level, forKey: .effort)
            }
        case let .rewind(toTurn, mode, editText, mentions, attachments, force):
            try c.encode(toTurn, forKey: .toTurn)
            try c.encode(mode, forKey: .mode)
            try c.encodeIfPresent(editText, forKey: .editText)
            if editText != nil, !mentions.isEmpty { try c.encode(mentions, forKey: .mentions) }
            if editText != nil, !attachments.isEmpty { try c.encode(attachments, forKey: .attachments) }
            if force { try c.encode(true, forKey: .force) }
        case let .compact(focus):
            try c.encodeIfPresent(focus, forKey: .focus)
        // MARK: wave3 mac-session
        case .retryExtensions, .cliVersions, .cliSessions:
            break
        case let .cliSessionImport(sessionId):
            try c.encode(sessionId, forKey: .sessionId)
        // MARK: wave4 w4-history (§38.3)
        case let .transcriptPage(sessionId, before, beforeAt, limit):
            try c.encodeIfPresent(sessionId, forKey: .sessionId)
            try c.encode(before, forKey: .before)
            try c.encodeIfPresent(beforeAt, forKey: .beforeAt)
            try c.encodeIfPresent(limit, forKey: .limit)
        case let .transcriptSearch(query):
            try c.encode(query, forKey: .query)
        // MARK: wave4c w4c-review (§41.3)
        case let .historyFileLines(entryId, path):
            try c.encode(entryId, forKey: .entryId)
            try c.encode(path, forKey: .path)
        case let .prFileLines(filename):
            try c.encode(filename, forKey: .filename)
        case let .fileImage(path):
            try c.encode(path, forKey: .path)
        case let .selectFileIgnoringWhitespace(path, since):
            try c.encode(path, forKey: .path)
            try c.encodeIfPresent(since, forKey: .since)
            try c.encode(true, forKey: .ignoreWhitespace)
        case let .transcriptSearchPerChat(query, perChat):
            try c.encode(query, forKey: .query)
            try c.encode(perChat, forKey: .perChat)
        // MARK: wave4b w4b-side (§40.3)
        case let .sideRefork(threadId, question):
            try c.encode(threadId, forKey: .threadId)
            try c.encode(question, forKey: .question)
            try c.encode(true, forKey: .refork)
        case let .sidePromoteQueued(threadId, text):
            try c.encode(threadId, forKey: .threadId)
            try c.encode(SidePromoteTarget.message, forKey: .target)
            try c.encode(text, forKey: .text)
            try c.encode(true, forKey: .queued)
        // MARK: wave4c w4c-trust (§41.2)
        case let .setAutoAccept(rules):
            try c.encode(rules, forKey: .rules)
        case let .autoAcceptUndo(paths):
            try c.encodeIfPresent(paths, forKey: .paths)
        case let .rejectUndo(path):
            try c.encode(path, forKey: .path)
        // MARK: wave4b w4b-bigturn (§39.1)
        case .retrySave:
            break
        case let .historyCleanup(keep, apply):
            try c.encodeIfPresent(keep, forKey: .keep)
            try c.encode(apply, forKey: .apply)
        // MARK: wave4b w4b-follow (§39.4)
        case let .chatMove(path, interrupt, followUp):
            try c.encode(path, forKey: .path)
            if interrupt { try c.encode(true, forKey: .interrupt) }
            try c.encodeIfPresent(followUp, forKey: .followUp)
        // MARK: wave4d w4d-plan (§42.1)
        case let .planImplement(mode, into, path):
            try c.encode(true, forKey: .approve)
            try c.encode(mode, forKey: .mode)
            try c.encode(into, forKey: .into)
            try c.encodeIfPresent(path, forKey: .path)
        case let .planFollow(path):
            if let path { try c.encode(path, forKey: .path) } else { try c.encodeNil(forKey: .path) }
        case .chatReceive:
            break
        case .codeGraph, .codeGraphBuild:   // MARK: wave5 w5-graph — no payload
            break
        case let .permissionFollow(requestId, followUp):
            try c.encode(requestId, forKey: .requestId)
            try c.encode(true, forKey: .allow)
            try c.encode(true, forKey: .follow)
            try c.encodeIfPresent(followUp, forKey: .followUp)
        // MARK: wave4d w4d-config (§42.3)
        case let .mcpToggleScoped(name, enabled, repository):
            try c.encode(name, forKey: .name)
            try c.encode(enabled, forKey: .enabled)
            try c.encode(repository ? "repository" : "worktree", forKey: .scope)
        case let .mcpRemoveFile(name, scope, file):
            try c.encode(name, forKey: .name)
            try c.encode(scope, forKey: .scope)
            try c.encode(file, forKey: .file)
        case let .claudeMdRead(path):
            try c.encode(path, forKey: .path)
        case let .claudeMdWrite(path, text, baseSha):
            try c.encode(path, forKey: .path)
            try c.encode(text, forKey: .text)
            if let baseSha { try c.encode(baseSha, forKey: .baseSha) } else { try c.encodeNil(forKey: .baseSha) }
        // MARK: wave5 w5-brain (§43.2)
        case let .brain(watch):
            try c.encodeIfPresent(watch, forKey: .watch)
        case let .statusLine(columns, visible):   // MARK: wave6 w6-statusline
            try c.encodeIfPresent(columns, forKey: .columns)
            try c.encodeIfPresent(visible, forKey: .visible)
        case let .brainRead(name):
            try c.encode(name, forKey: .name)
        // MARK: code-browser (§47)
        case let .projectFile(path):
            try c.encode(path, forKey: .path)
        case let .projectSearch(query, caseSensitive, wholeWord, limit):
            try c.encode(query, forKey: .query)
            if caseSensitive { try c.encode(true, forKey: .caseSensitive) }
            if wholeWord { try c.encode(true, forKey: .wholeWord) }
            try c.encodeIfPresent(limit, forKey: .limit)
        case let .requestChanges(extra, noteIds):
            try c.encodeIfPresent(extra, forKey: .extra)
            try c.encodeIfPresent(noteIds, forKey: .noteIds)
        case let .permissionResponse(requestId, allow, message, updatedInput, remember):
            try c.encode(requestId, forKey: .requestId)
            try c.encode(allow, forKey: .allow)
            try c.encodeIfPresent(message, forKey: .message)
            try c.encodeIfPresent(updatedInput, forKey: .updatedInput)
            if remember { try c.encode(true, forKey: .remember) }
        case .permissionRules:   // wave1 mac-perms: no payload
            break
        // MARK: wave4c w4c-commit (§41.1)
        case .commitFormat, .prDraft, .prCreateMeta, .prAiDraft:
            try encodeTeamFormatFields(to: encoder)
        case .commitHunks, .commitSplitDraft, .commitSeries:   // §53
            try encodeCommitSeriesFields(to: encoder)
        case let .accept(paths), let .unaccept(paths):
            try c.encode(paths, forKey: .paths)
        case let .reject(paths, force):
            try c.encode(paths, forKey: .paths)
            if force { try c.encode(true, forKey: .force) }
        case let .addNote(path, line, side, excerpt, body):
            try c.encode(path, forKey: .path)
            try c.encode(line, forKey: .line)   // explicit null for whole-file notes
            try c.encode(side, forKey: .side)
            try c.encode(excerpt, forKey: .excerpt)
            try c.encode(body, forKey: .body)
        case let .removeNote(noteId):
            try c.encode(noteId, forKey: .noteId)
        case let .editNote(noteId, body):
            try c.encode(noteId, forKey: .noteId)
            try c.encode(body, forKey: .body)
        case let .switchBranch(name):
            try c.encode(name, forKey: .name)
        case let .createBranch(name, from):
            try c.encode(name, forKey: .name)
            try c.encodeIfPresent(from, forKey: .from)
        case let .prOpen(summaryId):
            try c.encode(summaryId, forKey: .summaryId)
        case let .prSelectFile(filename):
            try c.encode(filename, forKey: .filename)
        case let .prAddDraft(path, line, side, startLine, body):
            try c.encode(path, forKey: .path)
            try c.encode(line, forKey: .line)
            try c.encode(side, forKey: .side)
            try c.encodeIfPresent(startLine, forKey: .startLine)
            try c.encode(body, forKey: .body)
        case let .prRemoveDraft(draftId):
            try c.encode(draftId, forKey: .draftId)
        case let .prSubmit(event, body):
            try c.encode(event, forKey: .event)
            try c.encode(body, forKey: .body)
        case let .prReply(commentId, body):
            try c.encode(commentId, forKey: .commentId)
            try c.encode(body, forKey: .body)
        case let .loginInTerminal(host):
            try c.encode(host, forKey: .host)
        }
    }
}

public let PROTOCOL_VERSION = 2

/// A command plus its optional correlation `id` — the line actually written to the engine.
public struct EngineCommandEnvelope: Encodable, Sendable, Equatable, TransportCommand {
    public var id: String?
    public var command: EngineCommand

    public init(id: String? = nil, command: EngineCommand) {
        self.id = id
        self.command = command
    }

    public static var shutdown: EngineCommandEnvelope { EngineCommandEnvelope(command: .shutdown) }

    private enum CodingKeys: String, CodingKey { case id }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        try command.encode(to: encoder)   // same keyed container: `type` + payload next to `id`
    }
}

// MARK: - Engine → App: the state snapshot

public enum GatePhase: String, Codable, Sendable {
    case idle, starting, running, collecting, reverting, reviewing
    case collectFailed = "collect_failed"
}

public enum BlockedReason: String, Codable, Sendable {
    case gitInitNeeded = "git_init_needed"
    case noSession = "no_session"
    case starting, running, collecting, reverting
    case awaitingPermission = "awaiting_permission"
    case collectFailed = "collect_failed"
    case pendingReview = "pending_review"
    case changesRequested = "changes_requested"
}

/// Repository facts shown in the window title / sidebar header (`state.project`).
public struct ProjectInfo: Codable, Sendable, Hashable {
    /// The folder the user opened.
    public var path: String
    /// Git toplevel.
    public var root: String
    public var name: String
    public var branch: String?
    public var remoteURL: String?

    public init(path: String, root: String, name: String, branch: String?, remoteURL: String?) {
        self.path = path
        self.root = root
        self.name = name
        self.branch = branch
        self.remoteURL = remoteURL
    }
}

/// `state.gitInit`: the opened folder is not a repository; the UI offers `init_repo`.
public struct GitInitInfo: Codable, Sendable, Hashable {
    public var path: String
    /// Immediate subfolders containing `.git`, sorted.
    public var candidates: [String]
    /// `/`, `$HOME`, ~/Desktop/Documents/Downloads or > 200 entries.
    public var looksUnsafe: Bool
}

public struct SessionInfo: Codable, Sendable, Equatable {
    public var open: Bool
    public var starting: Bool
    public var sessionId: String?
    public var model: String?
    public var capabilities: SessionCapabilities?
    public var pendingPermission: PermissionRequest?
    // MARK: wave1 mac-perms
    /// §33.1: every open permission request, oldest first (`pendingPermission` is always the first). Filled from
    /// `pendingPermission` when an older engine sends only that; see `permissionQueue`.
    public var pendingPermissions: [PermissionRequest] = []
    /// §29: the running review turn is accepted peer messages — the permission card and the HUD name the senders.
    public var peerTurn: PeerTurnInfo?
    /// M13 (audit 1.4): `restart_session` is available (a project is open and no start is in flight); false on older engines.
    public var canRestart: Bool
    /// M16: tool + command prefixes auto-allowed for this session by "Allow for session" (`permission_response{remember}`).
    public var rememberedAllows: [String]
    /// M20: mode of the running session (§11); `.default` on older engines and for unknown values.
    public var permissionMode: PermissionMode
    /// M20: the plan the last plan-mode turn proposed, waiting for `plan_response`; a plain `send` clears it.
    public var pendingPlan: PendingPlan?
    /// §16: what the session applied from the user's extensions; nil without a session start / on older engines.
    public var extensions: SessionExtensions?
    /// §25: the model `set_model` / `settings.model` asked for (alias or id); nil = the CLI default. `model` is what the CLI reports.
    public var selectedModel: String?
    /// §25: the effort the session runs with; nil = the model's default.
    public var effort: EffortLevel?
    /// §25: what `set_model.model` offers (the CLI's `supportedModels()`, else a static list); empty on older engines.
    public var availableModels: [ModelOption]
    /// §26: the current chat's user turns, oldest first (≤ 50); empty on older engines.
    public var checkpoints: [TurnCheckpoint]
    // MARK: wave1 mac-session (§29 / §30)
    /// §30: the CLI answered initialize (it accepted the start); false while starting and after a death, nil on older engines.
    public var ready: Bool?
    /// §29: the effective peer mode of this project; nil on older engines / for an unknown value.
    public var peerInbound: PeerInboundMode?
    /// §29: peer messages waiting for the user (`held`) or running (`delivering`), oldest first.
    public var peerInbox: [PeerMessage] = []
    /// §29: a turn the CLI runs that is not ours; `canSend` is false meanwhile.
    public var externalTurn: ExternalTurn?
    /// §52: the background tasks running now, oldest first (empty on older engines).
    public var backgroundTasks: [BackgroundTaskInfo] = []
    // MARK: wave3 mac-session
    /// §36.8: the CLI this session runs and whether ReviewGate verified it; nil without a session start / on older engines.
    public var cli: CliInfo?
    /// §36.7: what the starting CLI waits for (a hook, an MCP server, a plugin); nil once it initialized.
    public var extensionsWaitingOn: ExtensionsWaitingOn?
    // MARK: wave4d w4d-plan
    /// §42.1: what the next summary's "plan vs actual" follows (nil on older engines / without a chat).
    public var planSource: PlanSourceState?
    // MARK: wave5 w5-model
    /// §43.4: the model the running / last turn was given (nil on older engines, before one, in plain manual mode).
    public var autoModel: AutoModelChoice?
    // MARK: wave6 w6-terminal
    /// §44.1: while `permissionMode` is `.plan`, the mode before it (Claude's EnterPlanMode or the mode menu); nil otherwise
    /// and on older engines. Approving the plan goes back to `.auto` when it is `.auto` (`AppState.planApproveMode`).
    public var prePlanMode: PermissionMode?
    /// `capabilities` is the engine's cache of an earlier session (M16), not this session's yet.
    public var capabilitiesCached = false

    public init(open: Bool, starting: Bool, sessionId: String?, model: String?, capabilities: SessionCapabilities?,
                pendingPermission: PermissionRequest?, canRestart: Bool = false, rememberedAllows: [String] = [],
                permissionMode: PermissionMode = .default, pendingPlan: PendingPlan? = nil, extensions: SessionExtensions? = nil,
                selectedModel: String? = nil, effort: EffortLevel? = nil, availableModels: [ModelOption] = [],
                checkpoints: [TurnCheckpoint] = []) {
        self.open = open
        self.starting = starting
        self.sessionId = sessionId
        self.model = model
        self.capabilities = capabilities
        self.pendingPermission = pendingPermission
        self.canRestart = canRestart
        self.rememberedAllows = rememberedAllows
        self.permissionMode = permissionMode
        self.pendingPlan = pendingPlan
        self.extensions = extensions
        self.selectedModel = selectedModel
        self.effort = effort
        self.availableModels = availableModels
        self.checkpoints = checkpoints
    }

    private enum CodingKeys: String, CodingKey {
        case open, starting, sessionId, model, capabilities, pendingPermission, canRestart, rememberedAllows
        case permissionMode, pendingPlan, extensions
        case selectedModel, effort, availableModels, checkpoints
        case ready, peerInbound, peerInbox, externalTurn   // wave1 mac-session
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            open: try c.decodeIfPresent(Bool.self, forKey: .open) ?? false,
            starting: try c.decodeIfPresent(Bool.self, forKey: .starting) ?? false,
            sessionId: try c.decodeIfPresent(String.self, forKey: .sessionId),
            model: try c.decodeIfPresent(String.self, forKey: .model),
            capabilities: try c.decodeIfPresent(SessionCapabilities.self, forKey: .capabilities),
            pendingPermission: try c.decodeIfPresent(PermissionRequest.self, forKey: .pendingPermission),
            canRestart: try c.decodeIfPresent(Bool.self, forKey: .canRestart) ?? false,
            rememberedAllows: try c.decodeIfPresent([String].self, forKey: .rememberedAllows) ?? [],
            // A mode we do not know (a newer engine, `bypassPermissions`) reads as `.default` rather than failing.
            permissionMode: (try? c.decode(PermissionMode.self, forKey: .permissionMode)) ?? .default,
            pendingPlan: try? c.decodeIfPresent(PendingPlan.self, forKey: .pendingPlan),
            extensions: try? c.decodeIfPresent(SessionExtensions.self, forKey: .extensions),
            selectedModel: try? c.decodeIfPresent(String.self, forKey: .selectedModel),
            effort: try? c.decodeIfPresent(EffortLevel.self, forKey: .effort),
            availableModels: Self.lenientList(ModelOption.self, c, .availableModels),
            checkpoints: Self.lenientList(TurnCheckpoint.self, c, .checkpoints))
        // MARK: wave1 mac-session (§29 / §30): lenient — an unknown mode reads as nil, a malformed message is skipped.
        ready = try? c.decodeIfPresent(Bool.self, forKey: .ready)
        peerInbound = PeerInboundMode(wire: try? c.decodeIfPresent(String.self, forKey: .peerInbound))
        peerInbox = Self.lenientList(PeerMessage.self, c, .peerInbox).filter { !$0.id.isEmpty }
        externalTurn = try? c.decodeIfPresent(ExternalTurn.self, forKey: .externalTurn)
        decodePermissionFields(from: decoder)   // wave1 mac-perms: pendingPermissions, peerTurn
        decodeSessionToolsFields(from: decoder)   // wave3 mac-session: cli, extensionsWaitingOn, capabilitiesCached
        decodePlanReviewFields(from: decoder)   // wave4d w4d-plan: planSource
        autoModel = AutoModelWire.choice(from: decoder)   // wave5 w5-model (§43.4)
        prePlanMode = TerminalModeWire.prePlanMode(from: decoder)   // wave6 w6-terminal (§44.1)
        backgroundTasks = BackgroundWire.tasks(from: decoder)   // §52
    }

    /// Element by element: one entry a newer engine shapes differently never hides the rest.
    private static func lenientList<T: Decodable>(_ type: T.Type, _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [T] {
        guard var list = try? c.nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [T] = []
        while !list.isAtEnd {
            if let item = try? list.decode(T.self) { out.append(item) } else if (try? list.decode(JSONValue.self)) == nil { break }
        }
        return out
    }
}

/// `state.toolchain`: what the engine located (`claude`, `gh`, `git`).
public struct EngineToolchain: Codable, Sendable, Equatable {
    public var claude: String?
    public var gh: String?
    public var git: String?
    public var claudeVersion: String?
    public var ghVersion: String?
}

/// M16: `state.gate.reviewSummary` — the pending review's size for the "Accept N & Send" label.
public struct ReviewSummary: Codable, Sendable, Equatable {
    public var files: Int
    public var added: Int
    public var deleted: Int

    public init(files: Int, added: Int, deleted: Int) {
        self.files = files
        self.added = added
        self.deleted = deleted
    }

    private enum CodingKeys: String, CodingKey { case files, added, deleted }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(files: try c.decodeIfPresent(Int.self, forKey: .files) ?? 0,
                  added: try c.decodeIfPresent(Int.self, forKey: .added) ?? 0,
                  deleted: try c.decodeIfPresent(Int.self, forKey: .deleted) ?? 0)
    }
}

public struct GateInfo: Codable, Sendable, Equatable {
    public var phase: GatePhase
    public var canSend: Bool
    public var canRequestChanges: Bool
    public var blockedReason: BlockedReason?
    public var collectError: String?
    public var pendingCount: Int
    public var changesRequestedCount: Int
    public var isRequestingChanges: Bool
    /// Snapshot A / B (git tree SHAs).
    public var turnStartTree: String?
    public var turnEndTree: String?
    /// The "[Review gate] Accepted: …" prefix that the next send will use.
    public var lastReviewSummary: String?
    // M13 review-integrity signals (audit 1.1 / 1.2 / 1.3); empty / false on older engines.
    /// Absolute paths of edits outside the checkpoint root the user approved this turn (not in the review).
    public var changedOutside: [String]
    /// Repo-relative paths the turn's edit tools touched that are gitignored (written but invisible to the review).
    public var ignoredTouched: [String]
    /// Repo-relative changed paths hidden from `changedFiles` by `settings.ignorePatterns`.
    public var filteredByPattern: [String]
    /// True after `open_project` restored a persisted review; cleared on the next turn.
    public var restored: Bool
    /// M16: size of the pending review (files / +added / −deleted); nil on older engines.
    public var reviewSummary: ReviewSummary?
    // MARK: wave1 mac-review — §31–32 (always sent by this engine; 0 / nil / empty on older ones)
    /// Pending files with origin `external` — what "Reject all" leaves alone unless `includeExternal`.
    public var externalPendingCount = 0
    /// HEAD moved while the last turn ran (a commit, pull or checkout outside the app); cleared when the next turn starts.
    public var headMoved: HeadMove?
    /// Other Claude Code processes working in this worktree, as found at open / the last send.
    public var concurrentClaude: [ConcurrentClaude] = []
    /// The review `open_project` restored is stale (HEAD moved / older than 12 h): "정리 / 이어서 리뷰".
    public var stale: StaleReview?
    /// `.claude/settings.local.json` changed during the last turn (by hash; never captured). Cleared at the next turn.
    public var localSettingsChanged: LocalSettingsChange?
    /// Nested repositories the last turn changed — outside this review. Cleared at the next turn.
    public var nestedChanges: [NestedChange] = []
    /// Files the turn's snapshots had to leave out (git could not read them). Cleared at the next turn.
    public var snapshotSkipped: [SkippedPath] = []
    // MARK: wave2 contract — §34 (nil / empty on older engines)
    /// The B the review list and its diffs refer to: `turnEndTree`, or while a turn runs on a standing review the B it
    /// started from (read-only). Diff caches key on this, so a send no longer drops the diff being read.
    public var reviewEndTree: String?
    /// Transcript turns the review in progress spans.
    public var reviewTurns: [Int] = []
    /// What the last collected turn itself changed.
    public var lastTurnChanges: LastTurnChanges?
    /// The last request_changes of this review (`since: .request` applies).
    public var lastRequest: ReviewRequestInfo?
    // MARK: wave3 mac-flow
    /// §36.13: the AI pre-reviews of the review in progress (round runs and the main chat's ReportFindings), newest first;
    /// empty on older engines.
    public var prereviews: [PreReviewRun] = []
    // MARK: wave4c w4c-trust
    /// §41.2: the last single-file reject while [거절 취소] can put it back (nil otherwise, and on older engines).
    public var rejectUndo: RejectUndoInfo?

    public init(phase: GatePhase, canSend: Bool, canRequestChanges: Bool, blockedReason: BlockedReason?, collectError: String?,
                pendingCount: Int, changesRequestedCount: Int, isRequestingChanges: Bool, turnStartTree: String?,
                turnEndTree: String?, lastReviewSummary: String?, changedOutside: [String] = [], ignoredTouched: [String] = [],
                filteredByPattern: [String] = [], restored: Bool = false, reviewSummary: ReviewSummary? = nil) {
        self.phase = phase
        self.canSend = canSend
        self.canRequestChanges = canRequestChanges
        self.blockedReason = blockedReason
        self.collectError = collectError
        self.pendingCount = pendingCount
        self.changesRequestedCount = changesRequestedCount
        self.isRequestingChanges = isRequestingChanges
        self.turnStartTree = turnStartTree
        self.turnEndTree = turnEndTree
        self.lastReviewSummary = lastReviewSummary
        self.changedOutside = changedOutside
        self.ignoredTouched = ignoredTouched
        self.filteredByPattern = filteredByPattern
        self.restored = restored
        self.reviewSummary = reviewSummary
    }

    private enum CodingKeys: String, CodingKey {
        case phase, canSend, canRequestChanges, blockedReason, collectError, pendingCount, changesRequestedCount
        case isRequestingChanges, turnStartTree, turnEndTree, lastReviewSummary
        case changedOutside, ignoredTouched, filteredByPattern, restored, reviewSummary
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            phase: try c.decodeIfPresent(GatePhase.self, forKey: .phase) ?? .idle,
            canSend: try c.decodeIfPresent(Bool.self, forKey: .canSend) ?? false,
            canRequestChanges: try c.decodeIfPresent(Bool.self, forKey: .canRequestChanges) ?? false,
            blockedReason: try c.decodeIfPresent(BlockedReason.self, forKey: .blockedReason),
            collectError: try c.decodeIfPresent(String.self, forKey: .collectError),
            pendingCount: try c.decodeIfPresent(Int.self, forKey: .pendingCount) ?? 0,
            changesRequestedCount: try c.decodeIfPresent(Int.self, forKey: .changesRequestedCount) ?? 0,
            isRequestingChanges: try c.decodeIfPresent(Bool.self, forKey: .isRequestingChanges) ?? false,
            turnStartTree: try c.decodeIfPresent(String.self, forKey: .turnStartTree),
            turnEndTree: try c.decodeIfPresent(String.self, forKey: .turnEndTree),
            lastReviewSummary: try c.decodeIfPresent(String.self, forKey: .lastReviewSummary),
            changedOutside: try c.decodeIfPresent([String].self, forKey: .changedOutside) ?? [],
            ignoredTouched: try c.decodeIfPresent([String].self, forKey: .ignoredTouched) ?? [],
            filteredByPattern: try c.decodeIfPresent([String].self, forKey: .filteredByPattern) ?? [],
            restored: try c.decodeIfPresent(Bool.self, forKey: .restored) ?? false,
            reviewSummary: try? c.decodeIfPresent(ReviewSummary.self, forKey: .reviewSummary))
        // MARK: wave1 mac-review
        let provenance = GateProvenance.lenient(from: decoder)
        externalPendingCount = provenance.externalPendingCount
        headMoved = provenance.headMoved
        concurrentClaude = provenance.concurrentClaude
        stale = provenance.stale
        localSettingsChanged = provenance.localSettingsChanged
        nestedChanges = provenance.nestedChanges
        snapshotSkipped = provenance.snapshotSkipped
        // MARK: wave2 contract
        let round2 = GateReviewFields.lenient(from: decoder)
        reviewEndTree = round2.reviewEndTree
        reviewTurns = round2.reviewTurns
        lastTurnChanges = round2.lastTurnChanges
        lastRequest = round2.lastRequest
        prereviews = Self.decodePreReviews(from: decoder)   // wave3 mac-flow (§36.13)
        rejectUndo = TrustWire.rejectUndo(from: decoder)   // MARK: wave4c w4c-trust (§41.2)
    }
}

public enum ChangeStatus: String, Codable, Sendable { case added = "A", modified = "M", deleted = "D", renamed = "R", other = "X" }

/// Per-file review state. `.changesRequested`: the user left notes and sent them back to Claude (docs/M8-API.md);
/// the file is not reverted and the gate stays closed until the follow-up turn ends and the list is rebuilt.
public enum FileReviewState: String, Codable, Sendable { case pending, accepted, rejected, changesRequested }

public struct ChangedFile: Codable, Identifiable, Sendable, Hashable {
    public var id: String { path }
    public let path: String          // repo-root-relative (new path for renames)
    public let oldPath: String?      // renames
    public let status: ChangeStatus
    public let added: Int, deleted: Int
    public let isBinary: Bool
    /// The tools that touched the file; who changed it is `origin` (§31), not whether this is empty.
    public var tools: [String]
    /// The tool_use ids that touched the file (edit tools, and the Bash call a post-Bash snapshot attributed it to).
    public var toolUseIds: [String]
    public var state: FileReviewState
    /// Review notes on this file (`state.reviewNotes` filtered by path).
    public var noteCount: Int
    /// §17: some hunks were reverted with `reject_hunks`; the rest is still under review (`state` stays `.pending`).
    public var partial: Bool
    /// §17: running count of the hunks reverted so far.
    public var rejectedHunks: Int
    // MARK: wave1 mac-review — §31–32
    /// Who changed it (nil: an older engine / an unknown value — shown like an ordinary Claude change).
    public var origin: FileOrigin?
    /// `.mods`: `.claude/**`, `.mcp.json`, `CLAUDE*.md` — the files that change how Claude Code behaves.
    public var group: ChangedFileGroup?
    /// Mods files only: what the change makes run or lets through.
    public var risk: [ModsRisk] = []
    /// The content was not captured (a large / binary mods file, a file the snapshot skipped): it cannot be reverted.
    public var uncaptured = false
    /// Gitignored (a force-captured mods file): reviewed like any other file but not committable.
    public var ignored = false
    // MARK: wave2 contract — §34 (false / nil on older engines)
    /// The last collected turn changed this file ("이번 턴"); `turnAdded` / `turnDeleted` are that turn's own +/-.
    public var changedThisTurn = false
    public var turnAdded: Int?
    public var turnDeleted: Int?
    /// The tree entry id of `path` in B (nil for a deleted file): "봤음" is (path, blob).
    public var blob: String?
    /// Accepted earlier in this review, then changed by a later turn (pending again): `since: .accepted` applies.
    public var changedSinceAccepted = false
    /// Changed since the last request_changes of this review: `since: .request` shows it.
    public var changedSinceRequest = false
    /// Folded by default (lockfile / generated / minified).
    public var generated: GeneratedKind?
    /// Every changed line differs only in whitespace.
    public var whitespaceOnly = false
    /// Notes already sent with request_changes (`noteCount` counts the unsent ones).
    public var sentNoteCount = 0
    /// The engine's best explanation of the change.
    public var why: FileWhy?
    // MARK: wave4b w4b-bigturn — §39.1 (false / nil on older engines)
    /// An untracked file over the large-file limit: its content never reached a snapshot (`uncaptured` too, not committed).
    public var tooLarge = false
    /// With `tooLarge`: its size in bytes.
    public var largeBytes: Int64?
    // MARK: wave4b w4b-files — §40.2 (nil on older engines: the client's own rules decide, `FileRisk.risks(for:)`)
    /// The engine's badge kinds, most serious first (unknown kinds of a newer engine are dropped when shown).
    public var engineRisks: [String]?
    /// The engine's "risky first" weight (a test file is below 0).
    public var riskScore: Int?
    /// File modes when they changed (`100644` → `100755`; a new executable file: `newMode` alone).
    public var oldMode: String?
    public var newMode: String?
    /// A rename's similarity in percent (100: moved without a content change).
    public var similarity: Int?
    // MARK: wave4c w4c-trust — §41.2 (nil: accepted by the user, pending, or an older engine)
    /// The rule that accepted the file (`whitespace` / `lockfile` / `tests`; a newer engine's name kept as is).
    public var autoAccepted: String?

    public init(path: String, oldPath: String?, status: ChangeStatus, added: Int, deleted: Int,
                isBinary: Bool, tools: [String] = [], toolUseIds: [String] = [], state: FileReviewState = .pending, noteCount: Int = 0,
                partial: Bool = false, rejectedHunks: Int = 0) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.added = added
        self.deleted = deleted
        self.isBinary = isBinary
        self.tools = tools
        self.toolUseIds = toolUseIds
        self.state = state
        self.noteCount = noteCount
        self.partial = partial
        self.rejectedHunks = rejectedHunks
    }

    private enum CodingKeys: String, CodingKey {
        case path, oldPath, status, added, deleted, isBinary, tools, toolUseIds, state, noteCount, partial, rejectedHunks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            path: try c.decode(String.self, forKey: .path),
            oldPath: try c.decodeIfPresent(String.self, forKey: .oldPath),
            // Unknown status letters / review states (a newer engine) fall back instead of failing the whole snapshot.
            status: (try? c.decodeIfPresent(String.self, forKey: .status)).flatMap { $0.flatMap(ChangeStatus.init(rawValue:)) } ?? .other,
            added: try c.decodeIfPresent(Int.self, forKey: .added) ?? 0,
            deleted: try c.decodeIfPresent(Int.self, forKey: .deleted) ?? 0,
            isBinary: try c.decodeIfPresent(Bool.self, forKey: .isBinary) ?? false,
            tools: try c.decodeIfPresent([String].self, forKey: .tools) ?? [],
            toolUseIds: try c.decodeIfPresent([String].self, forKey: .toolUseIds) ?? [],
            state: FileReviewState(lenient: try? c.decodeIfPresent(String.self, forKey: .state)),
            noteCount: try c.decodeIfPresent(Int.self, forKey: .noteCount) ?? 0,
            partial: try c.decodeIfPresent(Bool.self, forKey: .partial) ?? false,
            rejectedHunks: try c.decodeIfPresent(Int.self, forKey: .rejectedHunks) ?? 0)
        // MARK: wave1 mac-review
        let provenance = ChangedFileProvenance.lenient(from: decoder)
        origin = provenance.origin
        group = provenance.group
        risk = provenance.risk
        uncaptured = provenance.uncaptured
        ignored = provenance.ignored
        // MARK: wave2 contract
        let round2 = ChangedFileReviewFields.lenient(from: decoder)
        changedThisTurn = round2.changedThisTurn
        turnAdded = round2.turnAdded
        turnDeleted = round2.turnDeleted
        blob = round2.blob
        changedSinceAccepted = round2.changedSinceAccepted
        changedSinceRequest = round2.changedSinceRequest
        generated = round2.generated
        whitespaceOnly = round2.whitespaceOnly
        sentNoteCount = round2.sentNoteCount
        why = round2.why
        // MARK: wave4b w4b-bigturn (§39.1)
        let large = BigTurnWire.largeFile(from: decoder)
        tooLarge = large.tooLarge
        largeBytes = large.largeBytes
        // MARK: wave4b w4b-files (§40.2)
        let list = FileListWire.changedFile(from: decoder)
        engineRisks = list.risks
        riskScore = list.riskScore
        oldMode = list.oldMode
        newMode = list.newMode
        similarity = list.similarity
        autoAccepted = TrustWire.autoAccepted(from: decoder)   // MARK: wave4c w4c-trust (§41.2)
    }
}

/// One inline note on the current turn's diff (docs/M8-API.md request-changes flow). Ids are engine-generated.
public struct ReviewNote: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let path: String
    public let line: Int?
    public let side: DiffSide
    /// The line text the note was left on.
    public let excerpt: String
    public var body: String
    // MARK: wave2 contract — §34.4
    /// Sent with request_changes ("요청함 — 반영 확인"); never sent again, not counted by `canRequestChanges` / `noteCount`.
    public var sent: NoteSent?
    /// `.moved`: `line` was remapped after B changed; `.gone`: the line no longer exists ("위치 사라짐").
    public var anchor: NoteAnchor?

    public init(id: String, path: String, line: Int?, side: DiffSide, excerpt: String, body: String,
                sent: NoteSent? = nil, anchor: NoteAnchor? = nil) {
        self.id = id
        self.path = path
        self.line = line
        self.side = side
        self.excerpt = excerpt
        self.body = body
        self.sent = sent
        self.anchor = anchor
    }

    private enum CodingKeys: String, CodingKey { case id, path, line, side, excerpt, body, sent, anchor }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id),
                  path: try c.decode(String.self, forKey: .path),
                  line: try c.decodeIfPresent(Int.self, forKey: .line),
                  side: try c.decode(DiffSide.self, forKey: .side),
                  excerpt: try c.decodeIfPresent(String.self, forKey: .excerpt) ?? "",
                  body: try c.decodeIfPresent(String.self, forKey: .body) ?? "",
                  sent: lenientValue(NoteSent.self, c, .sent),
                  anchor: lenientValue(NoteAnchor.self, c, .anchor))
    }
}

public enum HUDActivityKind: String, Codable, Sendable { case idle, working, thinking, tool, subagent }

/// `state.hud.activity`: the folded activity the client localizes.
public struct HUDActivity: Codable, Sendable, Equatable {
    public var kind: HUDActivityKind
    public var toolName: String?
    public var detail: String?
}

/// `AgentNode.status` (docs/PROTOCOL.md §13); unknown values decode as `.running`.
public enum AgentStatus: String, Codable, Sendable { case pending, running, paused, completed, failed, stopped }

/// One subagent in `state.hud.agents` (docs/PROTOCOL.md §13). Key on `toolUseId`: `id` switches from the tool_use id
/// to the SDK task id once the task is reported.
public struct AgentNode: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var toolUseId: String
    public var parentToolUseId: String?
    public var type: String
    public var description: String
    public var status: AgentStatus
    public var isBackground: Bool
    public var depth: Int
    public var lastTool: String?
    public var summary: String?
    public var tokens: Int?
    public var toolUses: Int?
    public var durationMs: Int?
    /// Epoch milliseconds.
    public var startedAt: Double
    public var endedAt: Double?
    public var error: String?
    /// Repo-relative inside the repository, absolute outside it.
    public var files: [String]
    // MARK: wave3 mac-agents
    /// §36.1: the instructions (the Agent call's `prompt`, first 8 000 chars); nil on older engines.
    public var prompt: String?
    /// §36.1: the model the Agent call named; nil when none was named (or an older engine).
    public var model: String?
    /// §36.1: the cleaned report's first 600 chars, once the Agent call's result arrived.
    public var reportPreview: String?
    /// §36.1: the CLI's own agent id (the result's `agentId: …`) — what SendMessage `to` names.
    public var cliAgentId: String?
    /// §36.2: set with `status: .stopped` when `stop_agent` stopped it.
    public var stoppedBy: AgentStoppedBy?
    /// §36.3: how many times SendMessage continued it after it had finished (0: never).
    public var resumeCount = 0
    /// §36.3: the SendMessage tool_use of the latest continuation.
    public var resumedBy: String?
    // MARK: wave4b w4b-agents
    /// §39.3: its latest tool call while it runs (nil before the first one, once it finished, and on older engines).
    public var lastStep: AgentStep?
    /// §39.3: the CLI is retrying its API request (cleared by its next call).
    public var retry: AgentRetry?
    /// §39.3: epoch ms anything was last heard from it while it runs.
    public var activeAt: Double?
    /// §39.3: the user turn it started in.
    public var turn: Int?
    /// §39.3: the Agent call's `isolation` ("worktree", "remote", …) and where it worked.
    public var isolation: String?
    public var worktreePath: String?
    public var worktreeBranch: String?
    // MARK: wave4d w4d-agents2
    /// §42.4: the model its API answers came from (`claude-sonnet-4-5-20250929`); nil until it answered / on older engines.
    public var apiModel: String?

    public init(id: String, toolUseId: String, parentToolUseId: String? = nil, type: String = "general-purpose", description: String = "",
                status: AgentStatus = .running, isBackground: Bool = false, depth: Int = 1, lastTool: String? = nil, summary: String? = nil,
                tokens: Int? = nil, toolUses: Int? = nil, durationMs: Int? = nil, startedAt: Double = 0, endedAt: Double? = nil,
                error: String? = nil, files: [String] = []) {
        self.id = id
        self.toolUseId = toolUseId
        self.parentToolUseId = parentToolUseId
        self.type = type
        self.description = description
        self.status = status
        self.isBackground = isBackground
        self.depth = depth
        self.lastTool = lastTool
        self.summary = summary
        self.tokens = tokens
        self.toolUses = toolUses
        self.durationMs = durationMs
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.error = error
        self.files = files
    }

    private enum CodingKeys: String, CodingKey {
        case id, toolUseId, parentToolUseId, type, description, status, isBackground, depth, lastTool, summary, tokens, toolUses
        case durationMs, startedAt, endedAt, error, files
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        self.init(
            id: id,
            toolUseId: try c.decodeIfPresent(String.self, forKey: .toolUseId) ?? id,
            parentToolUseId: try c.decodeIfPresent(String.self, forKey: .parentToolUseId),
            type: try c.decodeIfPresent(String.self, forKey: .type) ?? "general-purpose",
            description: try c.decodeIfPresent(String.self, forKey: .description) ?? "",
            status: (try? c.decode(AgentStatus.self, forKey: .status)) ?? .running,
            isBackground: try c.decodeIfPresent(Bool.self, forKey: .isBackground) ?? false,
            depth: try c.decodeIfPresent(Int.self, forKey: .depth) ?? 1,
            lastTool: try c.decodeIfPresent(String.self, forKey: .lastTool),
            summary: try c.decodeIfPresent(String.self, forKey: .summary),
            tokens: try c.decodeIfPresent(Int.self, forKey: .tokens),
            toolUses: try c.decodeIfPresent(Int.self, forKey: .toolUses),
            durationMs: try c.decodeIfPresent(Int.self, forKey: .durationMs),
            startedAt: try c.decodeIfPresent(Double.self, forKey: .startedAt) ?? 0,
            endedAt: try c.decodeIfPresent(Double.self, forKey: .endedAt),
            error: try c.decodeIfPresent(String.self, forKey: .error),
            files: try c.decodeIfPresent([String].self, forKey: .files) ?? [])
        decodeAgentDetailFields(from: decoder)   // wave3 mac-agents: prompt, model, reportPreview, cliAgentId, stoppedBy, resume*
        decodeAgentGlanceFields(from: decoder)   // wave4b w4b-agents: lastStep, retry, activeAt, turn, isolation, worktree*
        apiModel = AgentCostWire.apiModel(from: decoder)   // wave4d w4d-agents2 (§42.4)
    }
}

/// `state.hud` as sent by the engine; `HUDState` is the localized view form.
public struct HUDWire: Codable, Sendable, Equatable {
    public var contextTokens: Int
    public var contextWindow: Int?
    public var sessionCostUSD: Double
    public var turnCount: Int
    public var lastTurnMs: Int
    public var activity: HUDActivity
    /// Foreground subagents still running (derived from `agents` on newer engines).
    public var subagentDepth: Int
    /// Epoch milliseconds.
    public var turnStartedAt: Double?
    /// Subagents of the session (docs/PROTOCOL.md §13); empty on older engines.
    public var agents: [AgentNode]
    /// §21: side-question sessions since this session started; never part of `sessionCostUSD`.
    public var sideCostUSD: Double
    /// §34.6 (wave2 contract): distinct files the running turn changed so far (0 between turns / on older engines).
    public var turnFiles = 0
    // MARK: wave3 mac-agents
    /// §36.4: the main turn is blocked on foreground subagents; nil otherwise (between turns, older engines).
    public var waitingOnAgents: WaitingOnAgents?
    // MARK: wave4 w4-longwork
    /// §38.2: the subscription's usage windows; empty before the first `rate_limit_event` and on older engines.
    public var rateLimits: [RateLimitWindow] = []
    // MARK: wave4b w4b-agents
    /// §39.3: finished subagents of this chat's earlier turns, newest first; empty on older engines.
    public var agentHistory: [AgentNode] = []
    // MARK: wave4d w4d-agents2
    /// §42.4: the last finished turn's per-model cost, and their sum over this chat since the engine opened it.
    public var turnModels: [ModelCost] = []
    public var sessionModels: [ModelCost] = []
    // MARK: wave5 w5-model
    /// §43.4: messages auto sent to each family in this chat, most first; empty on older engines / without auto.
    public var autoModelCounts: [AutoModelCount] = []

    public init(contextTokens: Int, contextWindow: Int?, sessionCostUSD: Double, turnCount: Int, lastTurnMs: Int,
                activity: HUDActivity, subagentDepth: Int, turnStartedAt: Double?, agents: [AgentNode] = [], sideCostUSD: Double = 0) {
        self.sideCostUSD = sideCostUSD
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.sessionCostUSD = sessionCostUSD
        self.turnCount = turnCount
        self.lastTurnMs = lastTurnMs
        self.activity = activity
        self.subagentDepth = subagentDepth
        self.turnStartedAt = turnStartedAt
        self.agents = agents
    }

    private enum CodingKeys: String, CodingKey {
        case contextTokens, contextWindow, sessionCostUSD, turnCount, lastTurnMs, activity, subagentDepth, turnStartedAt, agents
        case sideCostUSD
        case turnFiles   // wave2 contract
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            contextTokens: try c.decode(Int.self, forKey: .contextTokens),
            contextWindow: try c.decodeIfPresent(Int.self, forKey: .contextWindow),
            sessionCostUSD: try c.decode(Double.self, forKey: .sessionCostUSD),
            turnCount: try c.decode(Int.self, forKey: .turnCount),
            lastTurnMs: try c.decode(Int.self, forKey: .lastTurnMs),
            activity: try c.decode(HUDActivity.self, forKey: .activity),
            subagentDepth: try c.decode(Int.self, forKey: .subagentDepth),
            turnStartedAt: try c.decodeIfPresent(Double.self, forKey: .turnStartedAt),
            agents: (try? c.decodeIfPresent([AgentNode].self, forKey: .agents)) ?? [],
            sideCostUSD: (try? c.decodeIfPresent(Double.self, forKey: .sideCostUSD)).flatMap { $0 } ?? 0)
        turnFiles = lenientValue(Int.self, c, .turnFiles) ?? 0   // wave2 contract
        waitingOnAgents = AgentWire.waiting(from: decoder)   // wave3 mac-agents
        rateLimits = LongWorkWire.rateLimits(from: decoder)   // wave4 w4-longwork (§38.2)
        agentHistory = AgentGlanceWire.history(from: decoder)   // wave4b w4b-agents (§39.3)
        (turnModels, sessionModels) = AgentCostWire.hud(from: decoder)   // wave4d w4d-agents2 (§42.4)
        autoModelCounts = AutoModelWire.counts(from: decoder)   // wave5 w5-model (§43.4)
    }
}

/// One local branch as listed by `git for-each-ref refs/heads` (docs/M8-API.md).
public struct BranchInfo: Sendable, Identifiable, Hashable {
    public var id: String { name }
    public let name: String
    public let isCurrent: Bool
    public let upstream: String?
    public let ahead: Int
    public let behind: Int
    public let lastCommitDate: Date?

    public init(name: String, isCurrent: Bool, upstream: String?, ahead: Int, behind: Int, lastCommitDate: Date?) {
        self.name = name
        self.isCurrent = isCurrent
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
        self.lastCommitDate = lastCommitDate
    }
}

/// `lastCommitDate` travels as epoch seconds (or null).
extension BranchInfo: Codable {
    private enum CodingKeys: String, CodingKey { case name, isCurrent, upstream, ahead, behind, lastCommitDate }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(String.self, forKey: .name),
            isCurrent: try c.decodeIfPresent(Bool.self, forKey: .isCurrent) ?? false,
            upstream: try c.decodeIfPresent(String.self, forKey: .upstream),
            ahead: try c.decodeIfPresent(Int.self, forKey: .ahead) ?? 0,
            behind: try c.decodeIfPresent(Int.self, forKey: .behind) ?? 0,
            lastCommitDate: try c.decodeIfPresent(Double.self, forKey: .lastCommitDate).map { Date(timeIntervalSince1970: $0) })
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(isCurrent, forKey: .isCurrent)
        try c.encode(upstream, forKey: .upstream)
        try c.encode(ahead, forKey: .ahead)
        try c.encode(behind, forKey: .behind)
        try c.encode(lastCommitDate.map { Int($0.timeIntervalSince1970) }, forKey: .lastCommitDate)
    }
}

/// Why the branch switcher is disabled right now; nil means switching is allowed.
public enum BranchSwitchBlocker: Sendable, Hashable {
    case pendingReview(Int)
    case dirtyWorktree
    case running

    public var localizedDescription: String {
        switch self {
        case .pendingReview(let n): return String(localized: "Review \(n) pending file(s) first", bundle: .module)
        case .dirtyWorktree: return String(localized: "Working tree has uncommitted changes", bundle: .module)
        case .running: return String(localized: "Claude is working", bundle: .module)
        }
    }
}

/// `{kind: "pendingReview", count}` | `{kind: "dirtyWorktree"}` | `{kind: "running"}`
extension BranchSwitchBlocker: Codable {
    private enum CodingKeys: String, CodingKey { case kind, count }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "pendingReview": self = .pendingReview(try c.decodeIfPresent(Int.self, forKey: .count) ?? 0)
        case "dirtyWorktree": self = .dirtyWorktree
        case "running": self = .running
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown switch blocker \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .pendingReview(let n):
            try c.encode("pendingReview", forKey: .kind)
            try c.encode(n, forKey: .count)
        case .dirtyWorktree: try c.encode("dirtyWorktree", forKey: .kind)
        case .running: try c.encode("running", forKey: .kind)
        }
    }
}

public struct BranchesInfo: Codable, Sendable, Equatable {
    public var list: [BranchInfo]
    /// `git status --porcelain` was non-empty at the last refresh.
    public var isWorktreeDirty: Bool
    public var switchBlocker: BranchSwitchBlocker?
    // MARK: wave3 mac-flow
    /// §36.12: remote-tracking branches (`origin/develop`) as workbench bases — never offered for switching; nil from
    /// engines before §36.12 (the workbench sheet then hides remote bases, fetch, copy and setup).
    public var remotes: RemoteBranchList? = nil
}

/// `state.pr`: the engine's PR store (`PRFile.patch` is never on the wire; see `pr_select_file`).
public struct PRState: Codable, Sendable, Equatable {
    public var host: String
    public var mine: [PRSummary]
    public var reviewRequested: [PRSummary]
    public var selectedSummary: PRSummary?
    public var selected: PRDetail?
    public var files: [PRFile]
    public var comments: [PRComment]
    public var reviews: [PRReview]
    public var draftComments: [DraftComment]
    public var accounts: [GHAccount]
    public var isLoading: Bool
    public var isSubmitting: Bool
    public var errorText: String?
    public var lastSubmitResult: SubmitResult?
    /// Set after a successful `pr_create` (M10.1); absent on older engines.
    public var lastCreatedPR: CreatedPR?

    static func empty(host: String) -> PRState {
        PRState(host: host, mine: [], reviewRequested: [], selectedSummary: nil, selected: nil, files: [], comments: [],
                reviews: [], draftComments: [], accounts: [], isLoading: false, isSubmitting: false, errorText: nil,
                lastSubmitResult: nil, lastCreatedPR: nil)
    }
}

/// `state.pr.lastCreatedPR` (`{url, branch}`): the PR `pr_create` opened. Tolerant: a bare URL string is accepted too.
public struct CreatedPR: Codable, Sendable, Equatable {
    public var url: String
    /// The head branch the PR was created from.
    public var branch: String?

    public init(url: String, branch: String? = nil) {
        self.url = url
        self.branch = branch
    }

    private enum CodingKeys: String, CodingKey { case url, branch }

    public init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let url = try? single.decode(String.self) {
            self.init(url: url)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(url: try c.decode(String.self, forKey: .url), branch: try c.decodeIfPresent(String.self, forKey: .branch))
    }
}

// MARK: - Workbenches (docs/M10-WORKBENCHES.md)

/// `<gitdir>/reviewgate.lock` contents: which engine holds a worktree. Also `state.lockConflict` when
/// `open_project` was refused with `locked_by_other_session:<pid>`.
public struct WorkbenchLock: Codable, Sendable, Hashable {
    public var pid: Int
    /// ISO-8601 as written by the engine; see `sinceDate`.
    public var since: String
    public var client: String
    /// `state.lockConflict` only: the worktree root the refused `open_project` targeted.
    public var path: String?

    public init(pid: Int, since: String, client: String, path: String? = nil) {
        self.pid = pid
        self.since = since
        self.client = client
        self.path = path
    }

    public var sinceDate: Date? {
        if let d = try? Date(since, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(since, strategy: Date.ISO8601FormatStyle())
    }

    private enum CodingKeys: String, CodingKey { case pid, since, client, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            pid: try c.decodeIfPresent(Int.self, forKey: .pid) ?? 0,
            since: try c.decodeIfPresent(String.self, forKey: .since) ?? "",
            client: try c.decodeIfPresent(String.self, forKey: .client) ?? "",
            path: try c.decodeIfPresent(String.self, forKey: .path))
    }
}

public typealias LockConflict = WorkbenchLock

/// One git worktree of the project's main repository (`git worktree list --porcelain` + our lock file).
public struct WorkbenchInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String { path }
    public var path: String
    public var branch: String?
    public var head: String
    public var isMain: Bool
    /// This engine's own worktree.
    public var isCurrent: Bool
    /// Live lock of another (or this) engine; nil when free.
    public var locked: WorkbenchLock?
    /// `git status --porcelain` non-empty; nil when unknown (timed out).
    public var dirty: Bool?

    public init(path: String, branch: String?, head: String, isMain: Bool, isCurrent: Bool, locked: WorkbenchLock?, dirty: Bool?) {
        self.path = path
        self.branch = branch
        self.head = head
        self.isMain = isMain
        self.isCurrent = isCurrent
        self.locked = locked
        self.dirty = dirty
    }

    private enum CodingKeys: String, CodingKey { case path, branch, head, isMain, isCurrent, locked, dirty }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            path: try c.decode(String.self, forKey: .path),
            branch: try c.decodeIfPresent(String.self, forKey: .branch),
            head: try c.decodeIfPresent(String.self, forKey: .head) ?? "",
            isMain: try c.decodeIfPresent(Bool.self, forKey: .isMain) ?? false,
            isCurrent: try c.decodeIfPresent(Bool.self, forKey: .isCurrent) ?? false,
            locked: try c.decodeIfPresent(WorkbenchLock.self, forKey: .locked),
            dirty: try c.decodeIfPresent(Bool.self, forKey: .dirty))
    }
}

/// `state.workbenches`.
public struct WorkbenchesInfo: Codable, Sendable, Equatable {
    public var list: [WorkbenchInfo]
    /// Path of this engine's worktree.
    public var current: String
    /// Where new workbenches are created (`Settings.worktreeRoot/<repo>-<hash8>`).
    public var managedRoot: String

    public init(list: [WorkbenchInfo], current: String, managedRoot: String) {
        self.list = list
        self.current = current
        self.managedRoot = managedRoot
    }

    public static let empty = WorkbenchesInfo(list: [], current: "", managedRoot: "")

    private enum CodingKeys: String, CodingKey { case list, current, managedRoot }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            list: try c.decodeIfPresent([WorkbenchInfo].self, forKey: .list) ?? [],
            current: try c.decodeIfPresent(String.self, forKey: .current) ?? "",
            managedRoot: try c.decodeIfPresent(String.self, forKey: .managedRoot) ?? "")
    }
}

// MARK: - Commit (docs/M12-COMMIT.md)

/// `state.commit.identity`: `user.name` / `user.email` as read at `open_project`; nil when unset.
public struct CommitIdentity: Codable, Sendable, Equatable {
    public var name: String?
    public var email: String?

    public init(name: String? = nil, email: String? = nil) {
        self.name = name
        self.email = email
    }

    /// Both set → `git commit` will not refuse with `git_identity_missing`.
    public var isComplete: Bool { !(name ?? "").isEmpty && !(email ?? "").isEmpty }
}

/// `state.commit.lastCommit`: the commit the engine made last (this engine only). `pushError` is set when the
/// commit succeeded but its push failed; `push {}` retries.
public struct LastCommit: Codable, Sendable, Equatable {
    public var sha: String
    public var shortSha: String
    public var message: String
    public var branch: String
    public var pushed: Bool
    public var pushError: String?
    public var files: [String]
    /// ISO-8601 as written by the engine.
    public var at: String

    public init(sha: String, shortSha: String, message: String = "", branch: String = "", pushed: Bool = false,
                pushError: String? = nil, files: [String] = [], at: String = "") {
        self.sha = sha
        self.shortSha = shortSha
        self.message = message
        self.branch = branch
        self.pushed = pushed
        self.pushError = pushError
        self.files = files
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case sha, shortSha, message, branch, pushed, pushError, files, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let sha = try c.decodeIfPresent(String.self, forKey: .sha) ?? ""
        self.init(
            sha: sha,
            shortSha: try c.decodeIfPresent(String.self, forKey: .shortSha) ?? String(sha.prefix(7)),
            message: try c.decodeIfPresent(String.self, forKey: .message) ?? "",
            branch: try c.decodeIfPresent(String.self, forKey: .branch) ?? "",
            pushed: try c.decodeIfPresent(Bool.self, forKey: .pushed) ?? false,
            pushError: try c.decodeIfPresent(String.self, forKey: .pushError),
            files: try c.decodeIfPresent([String].self, forKey: .files) ?? [],
            at: try c.decodeIfPresent(String.self, forKey: .at) ?? "")
    }
}

/// `state.commit` (absent on engines without M12 → nil in `ReviewState`).
public struct CommitState: Codable, Sendable, Equatable {
    public var lastCommit: LastCommit?
    /// Accepted files exist and the gate is not running.
    public var canCommit: Bool
    public var acceptedPaths: [String]
    public var identity: CommitIdentity
    /// The engine's `suggestCommitMessage()`: first line of the last instruction + `Files:` list.
    public var suggestedMessage: String

    public init(lastCommit: LastCommit? = nil, canCommit: Bool = false, acceptedPaths: [String] = [],
                identity: CommitIdentity = CommitIdentity(), suggestedMessage: String = "") {
        self.lastCommit = lastCommit
        self.canCommit = canCommit
        self.acceptedPaths = acceptedPaths
        self.identity = identity
        self.suggestedMessage = suggestedMessage
    }

    public static let empty = CommitState()

    private enum CodingKeys: String, CodingKey { case lastCommit, canCommit, acceptedPaths, identity, suggestedMessage }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            lastCommit: try c.decodeIfPresent(LastCommit.self, forKey: .lastCommit),
            canCommit: try c.decodeIfPresent(Bool.self, forKey: .canCommit) ?? false,
            acceptedPaths: try c.decodeIfPresent([String].self, forKey: .acceptedPaths) ?? [],
            identity: try c.decodeIfPresent(CommitIdentity.self, forKey: .identity) ?? CommitIdentity(),
            suggestedMessage: try c.decodeIfPresent(String.self, forKey: .suggestedMessage) ?? "")
    }
}

// MARK: - Chat sessions (docs/M15-POLISH.md)

/// One chat session in `state.sessions.list` (`<gitDir>/reviewgate/sessions/index.json`). `id` is the Claude session id.
public struct SessionMeta: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    /// ISO-8601 as written by the engine.
    public var createdAt: String
    public var updatedAt: String
    public var turns: Int
    public var costUSD: Double
    public var lastUserText: String
    public var archived: Bool
    /// The CLI could not resume this session; the engine fell back to a fresh one (the transcript stays readable).
    public var resumeFailed: Bool
    // MARK: wave1 mac-session
    /// §30: the CLI has a record of this conversation (it reported the id), so it is always resumed.
    public var cliKnown = false
    // MARK: wave3 mac-session
    /// §36.9: made by `cli_session_import` from a terminal session (the review gate applies from `at` on).
    public var imported: ImportedSession?
    // MARK: wave4b w4b-follow
    /// §39.4: handed to another worktree — a record here, the conversation goes on there.
    public var movedTo: ChatMoveRef?
    /// §39.4: came from another worktree — reviewed here from the move on.
    public var movedFrom: ChatMoveRef?

    public init(id: String, title: String, createdAt: String = "", updatedAt: String = "", turns: Int = 0, costUSD: Double = 0,
                lastUserText: String = "", archived: Bool = false, resumeFailed: Bool = false) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.turns = turns
        self.costUSD = costUSD
        self.lastUserText = lastUserText
        self.archived = archived
        self.resumeFailed = resumeFailed
    }

    public var updatedDate: Date? { Self.date(updatedAt) ?? Self.date(createdAt) }
    public var createdDate: Date? { Self.date(createdAt) }

    private static func date(_ s: String) -> Date? {
        if let d = try? Date(s, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(s, strategy: Date.ISO8601FormatStyle())
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, createdAt, updatedAt, turns, costUSD, costUsd, lastUserText, archived, resumeFailed
        case cliKnown   // wave1 mac-session
        case imported   // wave3 mac-session
        case movedTo, movedFrom   // wave4b w4b-follow
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            title: try c.decodeIfPresent(String.self, forKey: .title) ?? "",
            createdAt: try c.decodeIfPresent(String.self, forKey: .createdAt) ?? "",
            updatedAt: try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? "",
            turns: try c.decodeIfPresent(Int.self, forKey: .turns) ?? 0,
            costUSD: try c.decodeIfPresent(Double.self, forKey: .costUSD) ?? c.decodeIfPresent(Double.self, forKey: .costUsd) ?? 0,
            lastUserText: try c.decodeIfPresent(String.self, forKey: .lastUserText) ?? "",
            archived: try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false,
            resumeFailed: try c.decodeIfPresent(Bool.self, forKey: .resumeFailed) ?? false)
        cliKnown = (try? c.decodeIfPresent(Bool.self, forKey: .cliKnown)) ?? false   // wave1 mac-session
        imported = (try? c.decodeIfPresent(ImportedSession.self, forKey: .imported)) ?? nil   // wave3 mac-session
        movedTo = (try? c.decodeIfPresent(ChatMoveRef.self, forKey: .movedTo)) ?? nil   // wave4b w4b-follow
        movedFrom = (try? c.decodeIfPresent(ChatMoveRef.self, forKey: .movedFrom)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(turns, forKey: .turns)
        try c.encode(costUSD, forKey: .costUSD)
        try c.encode(lastUserText, forKey: .lastUserText)
        if archived { try c.encode(true, forKey: .archived) }
        if resumeFailed { try c.encode(true, forKey: .resumeFailed) }
        if cliKnown { try c.encode(true, forKey: .cliKnown) }   // wave1 mac-session
        try c.encodeIfPresent(imported, forKey: .imported)   // wave3 mac-session
        try c.encodeIfPresent(movedTo, forKey: .movedTo)   // wave4b w4b-follow
        try c.encodeIfPresent(movedFrom, forKey: .movedFrom)
    }
}

/// `state.sessions`: every chat session of the worktree (newest first), the live one and the client's open tabs.
public struct SessionsInfo: Codable, Sendable, Equatable {
    public var list: [SessionMeta]
    public var currentId: String?
    public var openTabIds: [String]

    public init(list: [SessionMeta], currentId: String?, openTabIds: [String]) {
        self.list = list
        self.currentId = currentId
        self.openTabIds = openTabIds
    }

    public static let empty = SessionsInfo(list: [], currentId: nil, openTabIds: [])

    private enum CodingKeys: String, CodingKey { case list, currentId, openTabIds }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            list: try c.decodeIfPresent([SessionMeta].self, forKey: .list) ?? [],
            currentId: try c.decodeIfPresent(String.self, forKey: .currentId),
            openTabIds: try c.decodeIfPresent([String].self, forKey: .openTabIds) ?? [])
    }
}

/// The snapshot the engine emits after every mutation (`state` event).
public struct ReviewState: Codable, Sendable, Equatable {
    /// Monotonic; clients drop out-of-order snapshots.
    public var seq: Int
    public var project: ProjectInfo?
    public var gitInit: GitInitInfo?
    public var session: SessionInfo
    public var toolchain: EngineToolchain
    public var gate: GateInfo
    public var changedFiles: [ChangedFile]
    public var reviewNotes: [ReviewNote]
    public var budget: Budget
    public var budgetUsage: BudgetUsage
    public var hud: HUDWire
    public var branches: BranchesInfo
    public var pr: PRState
    public var lastError: String?
    // M10 (absent on older engines → nil)
    public var workbenches: WorkbenchesInfo?
    /// Set when `open_project` was refused because another live engine holds the worktree.
    public var lockConflict: LockConflict?
    // M12 (absent on older engines → nil)
    public var commit: CommitState?
    // M15 (absent on older engines → nil)
    public var sessions: SessionsInfo?
    // MARK: wave4b w4b-bigturn — §39.1 (absent on older engines → nil)
    public var storage: StorageState? = nil
    // MARK: wave4c w4c-trust — §41.2: the open repository's auto-accept rules (absent: every rule off / an older engine)
    public var autoAcceptRules: AutoAcceptRules? = nil

    /// What a client shows before the engine's first snapshot (and after the engine exited).
    public static let empty = ReviewState(
        seq: 0, project: nil, gitInit: nil,
        session: SessionInfo(open: false, starting: false, sessionId: nil, model: nil, capabilities: nil, pendingPermission: nil),
        toolchain: EngineToolchain(claude: nil, gh: nil, git: nil, claudeVersion: nil, ghVersion: nil),
        gate: GateInfo(phase: .idle, canSend: false, canRequestChanges: false, blockedReason: .noSession, collectError: nil,
                       pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil,
                       turnEndTree: nil, lastReviewSummary: nil),
        changedFiles: [], reviewNotes: [],
        budget: Budget(maxFiles: 5, maxLines: 200), budgetUsage: BudgetUsage(files: 0, lines: 0, denied: false),
        hud: HUDWire(contextTokens: 0, contextWindow: nil, sessionCostUSD: 0, turnCount: 0, lastTurnMs: 0,
                     activity: HUDActivity(kind: .idle, toolName: nil, detail: nil), subagentDepth: 0, turnStartedAt: nil),
        branches: BranchesInfo(list: [], isWorktreeDirty: false, switchBlocker: nil),
        pr: .empty(host: "github.com"), lastError: nil, workbenches: nil, lockConflict: nil, commit: nil, sessions: nil)
}

// MARK: - Engine → App: events

/// `file_diff.scope`; `.live` (§34.6): a `live_diff` reply — the running turn's change, never reviewable.
public enum DiffScope: String, Codable, Sendable { case turn, pr, live }

public enum ErrorScope: String, Codable, Sendable { case engine, session, git, pr }

/// §19.6: the optional detail of an `error` event. Every field is optional on the wire; an unknown `code` is kept
/// as is (clients fall back to `message`). A `resetAt` that is not ISO-8601 is kept as text and simply not shown.
public struct EngineErrorDetail: Sendable, Equatable {
    /// `auth_required`, `usage_limit`, `rate_limited`, `api_error`, `api_retrying`, `cli_start_slow`, `session_crashed`, …
    public var code: String?
    /// `usage_limit` (and `rate_limited` when reported): when the limit resets, ISO-8601.
    public var resetAt: String?
    /// `api_retrying`: this attempt (1-based) of `maxRetries`, the wait before it.
    public var attempt: Int?
    public var maxRetries: Int?
    public var retryDelayMs: Int?
    /// The HTTP status (`api_error`, `rate_limited`, `auth_required`, `api_retrying`); nil = none / no HTTP response.
    public var status: Int?
    /// §21: the side thread a `side_failed` belongs to.
    public var threadId: String?
    /// §22: the MCP server of `mcp_auth_required` / `mcp_failed`.
    public var server: String?
    // MARK: wave1 mac-session (§30 / §33.4)
    /// §30: the CLI's first stderr line (home as `~`, tokens masked, ≤ 300 chars); the same failure gives the same text.
    public var detail: String?
    /// §30: how the CLI process ended (fatal session errors).
    public var exitCode: Int?
    public var signal: String?
    /// §30: the chat a `resume_not_found` / `resume_failed` notice is about (the one that could not be continued).
    public var sessionId: String?
    /// §33.4: the tool, the worktree / folder and the branch of a `worktree_blocked` / `worktree_outside_review` notice.
    public var toolName: String?
    public var path: String?
    public var branch: String?
    // MARK: wave3 mac-session
    /// §36.8: the versions of a `cli_version_changed` notice.
    public var cli: CliVersionChange?
    // MARK: wave4 w4-longwork
    /// §38.2 `max_turns`: the tool-call limit the turn hit.
    public var maxTurns: Int?
    /// §38.2 `hook_failed`: the hook's name (`PostToolUse:Bash`, its event when it has none).
    public var hookName: String?

    public init(code: String? = nil, resetAt: String? = nil, attempt: Int? = nil, maxRetries: Int? = nil,
                retryDelayMs: Int? = nil, status: Int? = nil, threadId: String? = nil, server: String? = nil) {
        self.threadId = threadId
        self.server = server
        self.code = code
        self.resetAt = resetAt
        self.attempt = attempt
        self.maxRetries = maxRetries
        self.retryDelayMs = retryDelayMs
        self.status = status
    }

    /// `resetAt` as a date (with or without fractional seconds); nil when absent or unparsable.
    public var resetDate: Date? {
        guard let resetAt else { return nil }
        if let d = try? Date(resetAt, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(resetAt, strategy: Date.ISO8601FormatStyle())
    }
}

/// `tool_result.testOutcome`: a recognizable test runner's verdict.
public enum TestOutcome: String, Codable, Sendable { case pass, fail }

/// The cause-linkage fields of a `tool_use` (event and transcript row); empty on older engines.
public struct ToolUseInfo: Sendable, Equatable {
    /// The Agent/Task tool_use this call runs under (a subagent's inner call); nil at top level.
    public var parentToolUseId: String?
    /// Assistant text right before the call in the same API message (≤ 400 chars).
    public var rationale: String?
    // MARK: wave2 contract — §34.8
    /// Where `rationale` came from: this API message, or the same agent's latest earlier text ("앞선 설명").
    public var rationaleSource: RationaleSource?
    /// The agent's tool calls between that text and this call (0 = the first call after it).
    public var rationaleAge: Int?
    // MARK: wave3 mac-agents
    /// §36.3: a SendMessage call that continues a subagent the engine knows (its Agent call and type).
    public var continues: AgentContinuation?
    // MARK: wave4b w4b-tabs
    /// §39.2: the call only reads or searches (the engine's `explore: true`); a run of them folds into one row.
    public var explore = false

    public init(parentToolUseId: String? = nil, rationale: String? = nil, rationaleSource: RationaleSource? = nil, rationaleAge: Int? = nil) {
        self.parentToolUseId = parentToolUseId
        self.rationale = rationale
        self.rationaleSource = rationaleSource
        self.rationaleAge = rationaleAge
    }

    /// The §34.8 fields read from the same `tool_use` object.
    static func decoding(parentToolUseId: String?, rationale: String?, from decoder: Decoder) -> ToolUseInfo {
        let extra = ToolUseReviewFields.lenient(from: decoder)
        var info = ToolUseInfo(parentToolUseId: parentToolUseId, rationale: rationale, rationaleSource: extra.source, rationaleAge: extra.age)
        info.continues = AgentWire.continuation(from: decoder)   // wave3 mac-agents (§36.3)
        info.explore = ExploreFold.flag(from: decoder)   // MARK: wave4b w4b-tabs (§39.2)
        return info
    }
}

/// The extra fields of a `tool_result` (event and transcript row); empty on older engines.
public struct ToolResultInfo: Sendable, Equatable {
    public var parentToolUseId: String?
    /// The result is longer than `preview`; for Bash `tool_output` returns up to ~20k chars.
    public var truncated: Bool
    public var testOutcome: TestOutcome?
    // MARK: wave3 mac-agents
    /// §36.1 (Agent / Task results): the parsed `<usage>` block; `preview` / `truncated` are then about the cleaned report.
    public var agentUsage: AgentUsage?
    /// §36.1: the result's `agentId: …` line — what SendMessage `to` names.
    public var cliAgentId: String?
    /// §36.2: the agent was stopped with `stop_agent` (the result reads "[Request interrupted by user for tool use]").
    public var stoppedBy: AgentStoppedBy?

    public init(parentToolUseId: String? = nil, truncated: Bool = false, testOutcome: TestOutcome? = nil) {
        self.parentToolUseId = parentToolUseId
        self.truncated = truncated
        self.testOutcome = testOutcome
    }
}

/// One persisted transcript row replayed by `transcript_restore` after `open_project` (M13, audit 3.1).
/// Unknown kinds decode as `.other` so a newer engine never breaks the restore.
public struct TranscriptItem: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        /// §23 / §24: the mentions and image refs the message went out with.
        /// wave5 w5-model — §43.4 `autoModel`: the model the turn was given (nil before §43.4 / when auto did not touch it).
        case userMessage(text: String, mentions: [String] = [], attachments: [AttachmentRef] = [], autoModel: AutoModelChoice? = nil)
        /// `unprompted`: the text of a turn Claude Code ran on its own (§18).
        case assistantText(text: String, unprompted: Bool = false)
        case toolUse(id: String, name: String, input: JSONValue, file: String?, info: ToolUseInfo = ToolUseInfo())
        case toolResult(toolUseId: String, isError: Bool, preview: String, info: ToolResultInfo = ToolResultInfo())
        case permission(requestId: String, toolName: String, allow: Bool, file: String?)
        case budgetEvent(kind: BudgetEventKind, toolName: String, file: String?, files: Int, lines: Int)
        /// `external` (§31): how many of `files` nothing of Claude's explains.
        case turnEnd(stopReason: String, usage: Usage, files: Int, added: Int, deleted: Int, changedOutside: [String], external: Int = 0,
                     review: TurnEndReview = TurnEndReview())
        // MARK: wave1 mac-session
        /// §30: an `error` event the user saw (scopes session / git / engine), kept in the chat's transcript. `facts` (§35.3):
        /// what else the event carried — tool / folder / branch, exit code / signal, the chat, reset time, HTTP status.
        case error(message: String, fatal: Bool, scope: ErrorScope, code: String?, detail: String?, facts: EngineErrorDetail = EngineErrorDetail())
        /// §29: a peer message once it was delivered (its turn's first row) or dropped.
        case peerMessage(PeerMessage)
        /// §52.1: a turn Claude started itself (its first row).
        case autoTurn(AutoTurnInfo)
        // MARK: wave4 w4-history
        /// §38.3: the turn's summary card, kept as a row (a row that does not read stays `.other`).
        case turnSummary(TurnSummary)
        case other(kind: String)
    }

    /// ISO-8601 as written by the engine.
    public var at: String
    public var turn: Int
    public var kind: Kind

    public init(at: String, turn: Int, kind: Kind) {
        self.at = at
        self.turn = turn
        self.kind = kind
    }
}

extension TranscriptItem: Decodable {
    private enum CodingKeys: String, CodingKey {
        case at, turn, kind, text, id, name, input, file, toolUseId, isError, preview, requestId, toolName, allow
        case event, files, lines, stopReason, usage, added, deleted, changedOutside
        case parentToolUseId, rationale, truncated, testOutcome, unprompted, mentions, attachments
        case message, fatal, scope, code, detail   // wave1 mac-session
        case path, branch, exitCode, signal, sessionId, resetAt, status   // §35.3 error rows
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kindName = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        let kind: Kind
        switch kindName {
        // MARK: wave1 mac-session (§29 / §30)
        case "error":
            // §35.3: the event's details, each lenient (null and odd values read as absent).
            var facts = EngineErrorDetail()
            facts.toolName = (try? c.decodeIfPresent(String.self, forKey: .toolName)) ?? nil
            facts.path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? nil
            facts.branch = (try? c.decodeIfPresent(String.self, forKey: .branch)) ?? nil
            facts.exitCode = (try? c.decodeIfPresent(Int.self, forKey: .exitCode)) ?? nil
            facts.signal = (try? c.decodeIfPresent(String.self, forKey: .signal)) ?? nil
            facts.sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil
            facts.resetAt = (try? c.decodeIfPresent(String.self, forKey: .resetAt)) ?? nil
            facts.status = (try? c.decodeIfPresent(Int.self, forKey: .status)) ?? nil
            LongWorkWire.applyErrorFacts(from: decoder, to: &facts)   // wave4 w4-longwork (§38.2)
            kind = .error(message: (try? c.decodeIfPresent(String.self, forKey: .message)) ?? "",
                          fatal: (try? c.decodeIfPresent(Bool.self, forKey: .fatal)) ?? false,
                          scope: (try? c.decodeIfPresent(ErrorScope.self, forKey: .scope)) ?? .session,
                          code: try? c.decodeIfPresent(String.self, forKey: .code),
                          detail: try? c.decodeIfPresent(String.self, forKey: .detail),
                          facts: facts)
        case "auto_turn":   // §52.1
            kind = .autoTurn(try AutoTurnInfo(from: decoder))
        case "peer_message":
            var message = try PeerMessage(from: decoder)
            if message.receivedAt.isEmpty { message.receivedAt = (try? c.decodeIfPresent(String.self, forKey: .at)) ?? "" }
            kind = .peerMessage(message)
        case "user_message":
            kind = .userMessage(text: try c.decodeIfPresent(String.self, forKey: .text) ?? "",
                                mentions: (try? c.decodeIfPresent([String].self, forKey: .mentions)) ?? [],
                                attachments: (try? c.decodeIfPresent([AttachmentRef].self, forKey: .attachments)) ?? [],
                                autoModel: AutoModelWire.choice(from: decoder))   // wave5 w5-model (§43.4)
        case "assistant_text":
            kind = .assistantText(text: try c.decodeIfPresent(String.self, forKey: .text) ?? "",
                                  unprompted: try c.decodeIfPresent(Bool.self, forKey: .unprompted) ?? false)
        case "tool_use":
            kind = .toolUse(
                id: try c.decodeIfPresent(String.self, forKey: .id) ?? "",
                name: try c.decodeIfPresent(String.self, forKey: .name) ?? "",
                input: try c.decodeIfPresent(JSONValue.self, forKey: .input) ?? .object([:]),
                file: try c.decodeIfPresent(String.self, forKey: .file),
                info: ToolUseInfo.decoding(parentToolUseId: try c.decodeIfPresent(String.self, forKey: .parentToolUseId),
                                           rationale: try c.decodeIfPresent(String.self, forKey: .rationale), from: decoder))
        case "tool_result":
            kind = .toolResult(
                toolUseId: try c.decodeIfPresent(String.self, forKey: .toolUseId) ?? "",
                isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false,
                preview: try c.decodeIfPresent(String.self, forKey: .preview) ?? "",
                info: ToolResultInfo(parentToolUseId: try c.decodeIfPresent(String.self, forKey: .parentToolUseId),
                                     truncated: try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false,
                                     testOutcome: try? c.decodeIfPresent(TestOutcome.self, forKey: .testOutcome))
                    .withAgentFields(from: decoder))   // wave3 mac-agents (§36.1–36.2)
        case "permission":
            kind = .permission(
                requestId: try c.decodeIfPresent(String.self, forKey: .requestId) ?? "",
                toolName: try c.decodeIfPresent(String.self, forKey: .toolName) ?? "",
                allow: try c.decodeIfPresent(Bool.self, forKey: .allow) ?? false,
                file: try c.decodeIfPresent(String.self, forKey: .file))
        case "budget_event":
            kind = .budgetEvent(
                kind: try c.decodeIfPresent(BudgetEventKind.self, forKey: .event) ?? .warn,
                toolName: try c.decodeIfPresent(String.self, forKey: .toolName) ?? "",
                file: try c.decodeIfPresent(String.self, forKey: .file),
                files: try c.decodeIfPresent(Int.self, forKey: .files) ?? 0,
                lines: try c.decodeIfPresent(Int.self, forKey: .lines) ?? 0)
        case "turn_end":
            kind = .turnEnd(
                stopReason: try c.decodeIfPresent(String.self, forKey: .stopReason) ?? "",
                usage: try c.decodeIfPresent(Usage.self, forKey: .usage) ?? Usage(inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0),
                files: try c.decodeIfPresent(Int.self, forKey: .files) ?? 0,
                added: try c.decodeIfPresent(Int.self, forKey: .added) ?? 0,
                deleted: try c.decodeIfPresent(Int.self, forKey: .deleted) ?? 0,
                changedOutside: try c.decodeIfPresent([String].self, forKey: .changedOutside) ?? [],
                external: ProvenanceEvents.external(decoder),
                review: TurnEndReview.lenient(from: decoder))   // wave2 contract
        // MARK: wave4 w4-history (§38.3)
        case "turn_summary":
            if let summary = try? TurnSummary(from: decoder) { kind = .turnSummary(summary) } else { kind = .other(kind: kindName) }
        default:
            kind = .other(kind: kindName)
        }
        self.init(at: try c.decodeIfPresent(String.self, forKey: .at) ?? "",
                  turn: try c.decodeIfPresent(Int.self, forKey: .turn) ?? 0, kind: kind)
    }
}

public enum EngineEvent: Sendable, Equatable {
    case ready(id: String?, engineVersion: String, platform: String, protocolVersion: Int)
    case state(ReviewState)
    /// §19.6: `code` is the refusal's stable id (older engines omit it); `paths` the files it is about
    /// (`file_changed_since_review`, §19.1); `partial` the commits a `commit_series` made before it failed (§53).
    case result(id: String, ok: Bool, error: String?, code: String? = nil, paths: [String]? = nil, partial: CommittedSeries? = nil)
    /// `endTree` (scope `.turn`): the `gate.turnEndTree` the diff was computed for — `reject_hunks.expectedEndTree` (§17).
    /// §34 `info`: the range shown, its old side and whether it was served while a turn runs (read-only).
    case fileDiff(id: String?, scope: DiffScope, path: String, diff: FileDiff, truncated: Bool, endTree: String? = nil, info: FileDiffInfo = FileDiffInfo())
    case fullFileContent(id: String?, view: FullFileView)
    /// Typed reply to `pr_create` (M10.1); also mirrored in `state.pr.lastCreatedPR`.
    case prCreated(id: String?, url: String, branch: String)
    /// Typed reply to `commit` (M12); also mirrored in `state.commit.lastCommit`.
    case committed(id: String?, sha: String, shortSha: String, pushed: Bool, branch: String)
    // MARK: wave3 mac-flow
    /// §36.11: reply to `commit_draft`.
    case commitDraft(CommitDraftReply)
    /// §36.12: reply to `workbench_preview`.
    case workbenchPreview(WorkbenchPreviewReply)
    /// §36.12: a step of a running `workbench_create` (never a reply).
    case workbenchProgress(WorkbenchProgress)
    /// §36.13: a pre-review started / progressed / ended (also the reply to `prereview_start`; mirrored in `gate.prereviews`).
    case prereview(PreReviewReply)
    /// What the engine actually queued: the trimmed user text for `send`, the generated message for `request_changes`.
    /// wave5 w5-model — §43.4 `autoModel`: the model the turn was given (nil before §43.4 / when auto did not touch it).
    case userMessage(text: String, turn: Int, mentions: [String] = [], attachments: [AttachmentRef] = [], autoModel: AutoModelChoice? = nil)
    /// `unprompted`: Claude Code wrote it in a turn it ran on its own, outside any request (§18).
    case textDelta(text: String, unprompted: Bool = false)
    case toolUse(id: String, name: String, input: JSONValue, file: String?, info: ToolUseInfo = ToolUseInfo())
    case toolResult(toolUseId: String, isError: Bool, preview: String, info: ToolResultInfo = ToolResultInfo())
    /// Typed reply to `tool_output`: `output` is nil when the engine kept nothing for that id.
    case toolOutput(id: String?, toolUseId: String, output: String?, truncated: Bool)
    // MARK: wave3 mac-agents
    /// §36.1: reply to `agent_report`.
    case agentReport(AgentReportReply)
    case permissionRequest(PermissionRequest)
    // MARK: wave1 mac-perms
    /// §33.8: reply to `permission_rules`.
    case permissionRules(PermissionRulesReply)
    case budgetEvent(kind: BudgetEventKind, toolName: String, file: String?, files: Int, lines: Int, budget: Budget)
    case activity(kind: ActivityKind, toolName: String?, detail: String?)
    /// `external` (§31): how many of `files` nothing of Claude's explains (another writer during the turn).
    /// §34.3: `files` / `added` / `deleted` count THIS turn's changes; `review` has the whole review's totals.
    case turnEnd(stopReason: String, usage: Usage, files: Int, added: Int, deleted: Int, external: Int = 0, review: TurnEndReview = TurnEndReview())
    /// M13 (audit 3.1): the tail of the persisted transcript, emitted after `open_project`.
    case transcriptRestore(items: [TranscriptItem])
    /// M20: a plan-mode turn proposed a plan (also mirrored in `state.session.pendingPlan`).
    case planProposed(path: String?, plan: String)
    /// M20: `plan_response{approve:true}` switched the mode; the follow-up `send` is issued right after.
    case planApproved(mode: PermissionMode, path: String?)
    /// §14: reply to `review_history` — newest first; `sessionId` nil for `all`.
    /// §34.4 `current`: the round in progress (`inProgress`), never in `entries`.
    case reviewHistory(id: String?, sessionId: String?, entries: [ReviewHistoryEntry], current: ReviewHistoryEntry? = nil)
    /// §14: reply to `history_diff` (a separate type so it is never mistaken for the current review's diff).
    case historyDiff(id: String?, entryId: String, path: String, diff: FileDiff, truncated: Bool, why: FileWhy? = nil)   // why: wave4 w4-history (§38.3)
    /// §15: after a collection that left files to review.
    case turnSummary(TurnSummary)
    // MARK: wave1 mac-review — §31–32 (each also mirrored in `state.gate`, which the UI renders)
    /// HEAD moved during a turn (after its `turn_end`).
    case headMoved(HeadMovedEvent)
    /// Other Claude processes in this worktree (at open and on every send while there are any).
    case concurrentClaude(ConcurrentClaudeEvent)
    /// `.claude/settings.local.json` changed during a turn.
    case localSettingsChanged(LocalSettingsChangedEvent)
    /// A turn changed nested repositories (outside the review).
    case nestedChanges(NestedChangesEvent)
    /// §16: the session was restarted without user settings (also `state.session.extensions.fallback`).
    case extensionsFallback(reason: String, timeoutMs: Int, message: String)
    /// §21: a thread snapshot (after every change; also the reply to `side_ask`).
    case sideThread(id: String?, thread: SideThread)
    /// §21: reply to `side_list` — the current chat's threads, newest first.
    case sideThreads(id: String?, mainSessionId: String?, threads: [SideThread])
    case sideThreadClosed(threadId: String)
    case sideTextDelta(threadId: String, text: String)
    case sideToolUse(threadId: String, id: String, name: String, input: JSONValue)
    case sideToolResult(threadId: String, toolUseId: String, isError: Bool, preview: String, denied: Bool)
    case sideTurnEnd(threadId: String, costUSD: Double, durationMs: Int, stopReason: String)
    /// §21: reply to `side_promote_draft` (and `side_promote` without text).
    case sidePromoteDraft(id: String?, threadId: String, text: String)
    /// §22: the live MCP server list (reply to every `mcp_*` but `mcp_auth`; also emitted when it changes).
    case mcpStatus(id: String?, servers: [McpServerInfo], restartRequired: Bool)
    /// §19.6: `detail.code` (+ `resetAt`, retry counters, HTTP status) when the engine knows one.
    /// §23 reply to `list_files`.
    case files(id: String?, query: String, items: [FileItem])
    /// §24 reply to `attachment_get`.
    case attachment(id: String?, hash: String, mediaType: String, dataBase64: String)
    /// §26 reply to `rewind`. `keptFiles` (§35.11): what a file rewind left as it was — nothing of Claude's changed it then.
    case rewound(id: String?, toTurn: Int, mode: RewindMode, restoredFiles: [String], sessionId: String?, keptFiles: [String] = [])
    /// §27: the context crossed 80 % at a turn end.
    case contextWarning(ContextWarning)
    /// §29 (wave1 mac-session): a peer message arrived or changed state (held → delivering → delivered, or dropped).
    case peerMessage(PeerMessage)
    // MARK: wave2 contract
    /// §34.6: reply to `live_changes`.
    case liveChanges(LiveChanges)
    // MARK: wave3 mac-session
    /// §36.8: reply to `cli_versions`.
    case cliVersions(CliVersionsReply)
    /// §36.9: reply to `cli_sessions`.
    case cliSessions(CliSessionsReply)
    // MARK: wave4 w4-history
    /// §38.3: `transcript_restore` that says where its rows start (`.transcriptRestore` when it does not: an older engine).
    case transcriptRestorePaged(items: [TranscriptItem], paging: TranscriptRestorePaging)
    /// §38.3: reply to `transcript_page`.
    case transcriptPage(TranscriptPageReply)
    /// §38.3: reply to `transcript_search`.
    case transcriptSearch(TranscriptSearchReply)
    // MARK: wave4b w4b-bigturn
    /// §39.1: reply to `history_cleanup`.
    case historyCleanup(HistoryCleanupReply)
    // MARK: wave4b w4b-follow
    /// §39.4: this window handed its chat to another worktree; the app opens / fronts that worktree's window.
    case chatMoved(ChatMovedEvent)
    // MARK: wave4c w4c-commit
    /// §41.1: reply to `commit_format`.
    case commitFormat(CommitFormatReply)
    /// §41.1: reply to `pr_draft`.
    case prDraft(PRDraftReply)
    /// §51: reply to `pr_ai_draft`.
    case prAiDraft(PRAiDraftReply)
    // MARK: §53 commits in meaningful units
    /// Reply to `commit_hunks`.
    case commitHunks(CommitHunksReply)
    /// Reply to `commit_split_draft`.
    case commitSplitDraft(CommitSplitDraftReply)
    /// Reply to `commit_series`.
    case committedSeries(CommittedSeries)
    // MARK: §52 background work
    /// A turn Claude started itself (`turn` is its number); its row opens the turn.
    case autoTurn(turn: Int, info: AutoTurnInfo)
    /// Reply to `task_output`.
    case taskOutput(TaskOutputReply)
    /// Reply to `task_background`.
    case taskBackground(TaskBackgroundReply)
    // MARK: wave4c w4c-review
    /// §41.3: reply to `history_file_lines` / `pr_file_lines`.
    case fileLines(FileLinesReply)
    /// §41.3: reply to `file_image`.
    case fileImage(FileImageReply)
    // MARK: wave4d w4d-config
    /// §42.3: reply to `claude_md_read` / `claude_md_write`.
    case claudeMd(ClaudeMdReply)
    // MARK: wave5 w5-brain
    /// §43.2: reply to `brain`, and each change of a watched memory folder (no id).
    case brain(BrainSnapshot)
    /// §43.2: reply to `brain_read`.
    case brainMemory(BrainMemoryText)
    // MARK: wave5 w5-graph
    /// §43.3: reply to `code_graph` / `code_graph_build`, also emitted while a build runs and when it ends.
    case codeGraph(CodeGraphReply)
    // MARK: wave6 w6-statusline
    /// §44.2: reply to `status_line`, and whenever what the user's status line shows changes (no id).
    case statusLine(StatusLineReply)
    // MARK: code-browser
    /// §47: reply to `project_file`.
    case projectFile(ProjectFileReply)
    /// §47: reply to `project_search`.
    case projectSearch(ProjectSearchReply)
    // MARK: wave4d w4d-plan
    /// §42.1: `plan_approved` with `into` — the fresh chat, the plan handed to a workbench, or received from one.
    case planApprovedInto(PlanApprovedInfo)
    /// §49: a task handed to this worktree by another window was sent (or comes back for the composer).
    case taskStarted(TaskStartedInfo)
    case error(message: String, fatal: Bool, scope: ErrorScope, detail: EngineErrorDetail = EngineErrorDetail())
    case log(level: LogLevel, message: String)

    /// The correlation id when this event is the reply to a command.
    public var replyId: String? {
        switch self {
        case let .ready(id, _, _, _), let .fileDiff(id, _, _, _, _, _, _), let .fullFileContent(id, _), let .prCreated(id, _, _),
             let .committed(id, _, _, _, _), let .toolOutput(id, _, _, _), let .reviewHistory(id, _, _, _),
             let .historyDiff(id, _, _, _, _, _), let .sideThread(id, _), let .sideThreads(id, _, _), let .sidePromoteDraft(id, _, _),
             let .mcpStatus(id, _, _), let .files(id, _, _), let .attachment(id, _, _, _), let .rewound(id, _, _, _, _, _): id
        case let .result(id, _, _, _, _, _): id
        case let .agentReport(reply): reply.id   // wave3 mac-agents
        case let .commitDraft(reply): reply.id   // wave3 mac-flow
        case let .workbenchPreview(reply): reply.id
        case let .prereview(reply): reply.id
        case let .permissionRules(reply): reply.id   // wave1 mac-perms
        case let .liveChanges(reply): reply.id   // wave2 contract
        case let .cliVersions(reply): reply.id   // wave3 mac-session
        case let .cliSessions(reply): reply.id
        case let .transcriptPage(reply): reply.id   // wave4 w4-history
        case let .transcriptSearch(reply): reply.id
        case let .historyCleanup(reply): reply.id   // wave4b w4b-bigturn
        case let .commitFormat(reply): reply.id   // wave4c w4c-commit
        case let .prDraft(reply): reply.id
        case let .prAiDraft(reply): reply.id   // §51
        case let .commitHunks(reply): reply.id   // §53
        case let .commitSplitDraft(reply): reply.id
        case let .committedSeries(reply): reply.id
        case let .taskOutput(reply): reply.id   // §52
        case let .taskBackground(reply): reply.id
        case let .fileLines(reply): reply.id   // wave4c w4c-review
        case let .fileImage(reply): reply.id
        case let .claudeMd(reply): reply.id   // wave4d w4d-config
        case let .brain(reply): reply.id   // wave5 w5-brain
        case let .brainMemory(reply): reply.id
        case let .codeGraph(reply): reply.id   // MARK: wave5 w5-graph
        case let .statusLine(reply): reply.id   // MARK: wave6 w6-statusline
        case let .projectFile(reply): reply.id   // MARK: code-browser
        case let .projectSearch(reply): reply.id
        default: nil
        }
    }
}

extension EngineEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, id, engineVersion, platform, protocolVersion
        case state, ok, error
        case scope, path, diff, truncated
        case text, turn
        case name, input, file
        case toolUseId, isError, preview
        case parentToolUseId, rationale, testOutcome, output
        case requestId, toolName
        case kind, files, lines, budget
        case detail
        case stopReason, usage, added, deleted
        case message, fatal
        case code, paths, resetAt, attempt, maxRetries, retryDelayMs, status
        case level
        case url, branch
        case sha, shortSha, pushed
        case items
        case plan, mode
        case sessionId, entries, entryId, reason, timeoutMs
        case endTree, unprompted
        case thread, threads, mainSessionId, threadId, costUSD, durationMs, denied, servers, restartRequired, server
        case mentions, attachments, query, hash, mediaType, dataBase64, toTurn, restoredFiles, keptFiles, percent, contextTokens, contextWindow
        case exitCode, signal   // wave1 mac-session
        case current   // wave2 contract
        case cli   // wave3 mac-session
        case start, why   // wave4 w4-history
        case partial   // §53
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        // MARK: wave1 mac-session (§29)
        case "peer_message":
            self = .peerMessage(try c.decode(PeerMessage.self, forKey: .message))
        case "ready":
            self = .ready(
                id: try c.decodeIfPresent(String.self, forKey: .id),
                engineVersion: try c.decodeIfPresent(String.self, forKey: .engineVersion) ?? "",
                platform: try c.decodeIfPresent(String.self, forKey: .platform) ?? "",
                protocolVersion: try c.decodeIfPresent(Int.self, forKey: .protocolVersion) ?? 0)
        case "state":
            self = .state(try c.decode(ReviewState.self, forKey: .state))
        case "result":
            self = .result(
                id: try c.decode(String.self, forKey: .id),
                ok: try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false,
                error: try c.decodeIfPresent(String.self, forKey: .error),
                code: try? c.decodeIfPresent(String.self, forKey: .code),
                paths: try? c.decodeIfPresent([String].self, forKey: .paths),
                partial: try? c.decodeIfPresent(CommittedSeries.self, forKey: .partial))
        case "file_diff":
            self = .fileDiff(
                id: try c.decodeIfPresent(String.self, forKey: .id),
                scope: (try? c.decodeIfPresent(DiffScope.self, forKey: .scope)) ?? .turn,
                path: try c.decode(String.self, forKey: .path),
                diff: try c.decode(FileDiff.self, forKey: .diff),
                truncated: try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false,
                endTree: try c.decodeIfPresent(String.self, forKey: .endTree),
                info: FileDiffInfo.lenient(from: decoder))   // wave2 contract
        case "live_changes":   // wave2 contract
            self = .liveChanges(try LiveChanges(from: decoder))
        // MARK: wave3 mac-session
        case "cli_versions":
            self = .cliVersions(try CliVersionsReply(from: decoder))
        case "cli_sessions":
            self = .cliSessions(try CliSessionsReply(from: decoder))
        case "full_file_content":
            self = .fullFileContent(id: try c.decodeIfPresent(String.self, forKey: .id), view: try FullFileView(from: decoder))
        case "pr_created":
            self = .prCreated(
                id: try c.decodeIfPresent(String.self, forKey: .id),
                url: try c.decode(String.self, forKey: .url),
                branch: try c.decodeIfPresent(String.self, forKey: .branch) ?? "")
        case "committed":
            let sha = try c.decodeIfPresent(String.self, forKey: .sha) ?? ""
            self = .committed(
                id: try c.decodeIfPresent(String.self, forKey: .id),
                sha: sha,
                shortSha: try c.decodeIfPresent(String.self, forKey: .shortSha) ?? String(sha.prefix(7)),
                pushed: try c.decodeIfPresent(Bool.self, forKey: .pushed) ?? false,
                branch: try c.decodeIfPresent(String.self, forKey: .branch) ?? "")
        // MARK: wave3 mac-flow
        case "commit_draft":
            self = .commitDraft(try CommitDraftReply(from: decoder))
        case "workbench_preview":
            self = .workbenchPreview(try WorkbenchPreviewReply(from: decoder))
        case "workbench_progress":
            self = .workbenchProgress(try WorkbenchProgress(from: decoder))
        case "prereview":
            self = .prereview(try PreReviewReply(from: decoder))
        case "user_message":
            self = .userMessage(text: try c.decode(String.self, forKey: .text), turn: try c.decodeIfPresent(Int.self, forKey: .turn) ?? 0,
                                mentions: Self.lenient([String].self, c, .mentions) ?? [],
                                attachments: Self.lenientList(AttachmentRef.self, c, .attachments),
                                autoModel: AutoModelWire.choice(from: decoder))   // wave5 w5-model (§43.4)
        case "files":
            self = .files(id: try c.decodeIfPresent(String.self, forKey: .id),
                          query: Self.lenient(String.self, c, .query) ?? "",
                          items: Self.lenientList(FileItem.self, c, .items))
        case "attachment":
            self = .attachment(id: try c.decodeIfPresent(String.self, forKey: .id),
                               hash: Self.lenient(String.self, c, .hash) ?? "",
                               mediaType: Self.lenient(String.self, c, .mediaType) ?? "image/png",
                               dataBase64: Self.lenient(String.self, c, .dataBase64) ?? "")
        case "rewound":
            self = .rewound(id: try c.decodeIfPresent(String.self, forKey: .id),
                            toTurn: Self.lenient(Int.self, c, .toTurn) ?? 0,
                            mode: Self.lenient(RewindMode.self, c, .mode) ?? .both,
                            restoredFiles: Self.lenient([String].self, c, .restoredFiles) ?? [],
                            sessionId: Self.lenient(String.self, c, .sessionId),
                            keptFiles: Self.lenient([String].self, c, .keptFiles) ?? [])
        case "context_warning":
            self = .contextWarning(ContextWarning(percent: Self.lenient(Double.self, c, .percent) ?? 0,
                                                  contextTokens: Self.lenient(Int.self, c, .contextTokens) ?? 0,
                                                  contextWindow: Self.lenient(Int.self, c, .contextWindow) ?? 0))
        case "text_delta":
            self = .textDelta(text: try c.decode(String.self, forKey: .text),
                              unprompted: try c.decodeIfPresent(Bool.self, forKey: .unprompted) ?? false)
        case "tool_use":
            self = .toolUse(
                id: try c.decode(String.self, forKey: .id),
                name: try c.decode(String.self, forKey: .name),
                input: try c.decodeIfPresent(JSONValue.self, forKey: .input) ?? .object([:]),
                file: try c.decodeIfPresent(String.self, forKey: .file),
                info: ToolUseInfo.decoding(parentToolUseId: try c.decodeIfPresent(String.self, forKey: .parentToolUseId),
                                           rationale: try c.decodeIfPresent(String.self, forKey: .rationale), from: decoder))
        case "tool_result":
            self = .toolResult(
                toolUseId: try c.decode(String.self, forKey: .toolUseId),
                isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false,
                preview: try c.decodeIfPresent(String.self, forKey: .preview) ?? "",
                info: ToolResultInfo(parentToolUseId: try c.decodeIfPresent(String.self, forKey: .parentToolUseId),
                                     truncated: try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false,
                                     testOutcome: try? c.decodeIfPresent(TestOutcome.self, forKey: .testOutcome))
                    .withAgentFields(from: decoder))   // wave3 mac-agents (§36.1–36.2)
        case "tool_output":
            self = .toolOutput(
                id: try c.decodeIfPresent(String.self, forKey: .id),
                toolUseId: try c.decodeIfPresent(String.self, forKey: .toolUseId) ?? "",
                output: try c.decodeIfPresent(String.self, forKey: .output),
                truncated: try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false)
        case "agent_report":   // wave3 mac-agents (§36.1)
            self = .agentReport(try AgentReportReply(from: decoder))
        case "permission_request":
            // wave1 mac-perms: the request's own decoder also reads §33 toolUseId / agent / reason / allowPatterns.
            self = .permissionRequest(try PermissionRequest(from: decoder))
        case "permission_rules":   // wave1 mac-perms
            self = .permissionRules(try PermissionRulesReply(from: decoder))
        case "budget_event":
            self = .budgetEvent(
                kind: try c.decode(BudgetEventKind.self, forKey: .kind),
                toolName: try c.decodeIfPresent(String.self, forKey: .toolName) ?? "",
                file: try c.decodeIfPresent(String.self, forKey: .file),
                files: try c.decodeIfPresent(Int.self, forKey: .files) ?? 0,
                lines: try c.decodeIfPresent(Int.self, forKey: .lines) ?? 0,
                budget: try c.decode(Budget.self, forKey: .budget))
        case "activity":
            self = .activity(
                kind: try c.decode(ActivityKind.self, forKey: .kind),
                toolName: try c.decodeIfPresent(String.self, forKey: .toolName),
                detail: try c.decodeIfPresent(String.self, forKey: .detail))
        case "turn_end":
            self = .turnEnd(
                stopReason: try c.decodeIfPresent(String.self, forKey: .stopReason) ?? "",
                usage: try c.decodeIfPresent(Usage.self, forKey: .usage) ?? Usage(inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0),
                files: try c.decodeIfPresent(Int.self, forKey: .files) ?? 0,
                added: try c.decodeIfPresent(Int.self, forKey: .added) ?? 0,
                deleted: try c.decodeIfPresent(Int.self, forKey: .deleted) ?? 0,
                external: ProvenanceEvents.external(decoder),
                review: TurnEndReview.lenient(from: decoder))   // wave2 contract
        case "transcript_restore":
            let items = try c.decodeIfPresent([TranscriptItem].self, forKey: .items) ?? []
            // MARK: wave4 w4-history — §38.3: where the rows start; without it (an older engine) the event is as before.
            if !items.isEmpty, let start = (try? c.decodeIfPresent(Int.self, forKey: .start)) ?? nil,
               let sessionId = (try? c.decodeIfPresent(String.self, forKey: .sessionId)) ?? nil {
                self = .transcriptRestorePaged(items: items, paging: TranscriptRestorePaging(start: start, sessionId: sessionId))
            } else {
                self = .transcriptRestore(items: items)
            }
        case "transcript_page":   // wave4 w4-history (§38.3)
            self = .transcriptPage(try TranscriptPageReply(from: decoder))
        case "transcript_search":
            self = .transcriptSearch(try TranscriptSearchReply(from: decoder))
        case "history_cleanup":   // wave4b w4b-bigturn (§39.1)
            self = .historyCleanup(try HistoryCleanupReply(from: decoder))
        case "chat_moved":   // wave4b w4b-follow (§39.4)
            self = .chatMoved(try ChatMovedEvent(from: decoder))
        case "task_started":   // §49
            self = .taskStarted(try TaskStartedInfo(from: decoder))
        case "commit_format":   // wave4c w4c-commit (§41.1)
            self = .commitFormat(try CommitFormatReply(from: decoder))
        case "pr_draft":
            self = .prDraft(try PRDraftReply(from: decoder))
        case "pr_ai_draft":   // §51
            self = .prAiDraft(try PRAiDraftReply(from: decoder))
        case "commit_hunks":   // §53
            self = .commitHunks(try CommitHunksReply(from: decoder))
        case "commit_split_draft":
            self = .commitSplitDraft(try CommitSplitDraftReply(from: decoder))
        case "committed_series":
            self = .committedSeries(try CommittedSeries(from: decoder))
        case "auto_turn":   // §52
            self = .autoTurn(turn: (try? c.decodeIfPresent(Int.self, forKey: .turn)) ?? 0, info: try AutoTurnInfo(from: decoder))
        case "task_output":
            self = .taskOutput(try TaskOutputReply(from: decoder))
        case "task_background":
            self = .taskBackground(try TaskBackgroundReply(from: decoder))
        case "file_lines":   // wave4c w4c-review (§41.3)
            self = .fileLines(try FileLinesReply(from: decoder))
        case "file_image":
            self = .fileImage(try FileImageReply(from: decoder))
        case "claude_md":   // wave4d w4d-config (§42.3)
            self = .claudeMd(try ClaudeMdReply(from: decoder))
        case "brain":   // wave5 w5-brain (§43.2)
            self = .brain(try BrainSnapshot(from: decoder))
        case "brain_memory":
            self = .brainMemory(try BrainMemoryText(from: decoder))
        case "code_graph":   // MARK: wave5 w5-graph (§43.3)
            self = .codeGraph(try CodeGraphReply(from: decoder))
        case "status_line":   // MARK: wave6 w6-statusline (§44.2)
            self = .statusLine(try StatusLineReply(from: decoder))
        case "project_file":   // MARK: code-browser (§47)
            self = .projectFile(try ProjectFileReply(from: decoder))
        case "project_search":
            self = .projectSearch(try ProjectSearchReply(from: decoder))
        case "plan_proposed":
            self = .planProposed(
                path: try c.decodeIfPresent(String.self, forKey: .path),
                plan: try c.decodeIfPresent(String.self, forKey: .plan) ?? "")
        case "plan_approved" where PlanApprovedInfo.decode(from: decoder) != nil:   // MARK: wave4d w4d-plan (§42.1)
            self = .planApprovedInto(PlanApprovedInfo.decode(from: decoder)!)
        case "plan_approved":
            self = .planApproved(
                mode: (try? c.decode(PermissionMode.self, forKey: .mode)) ?? .default,
                path: try c.decodeIfPresent(String.self, forKey: .path))
        case "review_history":
            self = .reviewHistory(
                id: try c.decodeIfPresent(String.self, forKey: .id),
                sessionId: try c.decodeIfPresent(String.self, forKey: .sessionId),
                entries: try c.decodeIfPresent([ReviewHistoryEntry].self, forKey: .entries) ?? [],
                current: Self.lenient(ReviewHistoryEntry.self, c, .current))   // wave2 contract
        case "history_diff":
            self = .historyDiff(
                id: try c.decodeIfPresent(String.self, forKey: .id),
                entryId: try c.decodeIfPresent(String.self, forKey: .entryId) ?? "",
                path: try c.decodeIfPresent(String.self, forKey: .path) ?? "",
                diff: try c.decode(FileDiff.self, forKey: .diff),
                truncated: try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false,
                why: (try? c.decodeIfPresent(FileWhy.self, forKey: .why)) ?? nil)   // wave4 w4-history (§38.3)
        case "turn_summary":
            self = .turnSummary(try TurnSummary(from: decoder))
        // wave1 mac-review — §31–32
        case "head_moved":
            self = .headMoved(try ProvenanceEvents.headMoved(decoder))
        case "concurrent_claude":
            self = .concurrentClaude(try ProvenanceEvents.concurrentClaude(decoder))
        case "local_settings_changed":
            self = .localSettingsChanged(try ProvenanceEvents.localSettingsChanged(decoder))
        case "nested_changes":
            self = .nestedChanges(try ProvenanceEvents.nestedChanges(decoder))
        case "extensions_fallback":
            self = .extensionsFallback(
                reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "init_timeout",
                timeoutMs: try c.decodeIfPresent(Int.self, forKey: .timeoutMs) ?? 0,
                message: try c.decodeIfPresent(String.self, forKey: .message) ?? "")
        case "side_thread":
            self = .sideThread(id: try c.decodeIfPresent(String.self, forKey: .id), thread: try c.decode(SideThread.self, forKey: .thread))
        case "side_threads":
            let main: String? = Self.lenient(String.self, c, .mainSessionId)
            self = .sideThreads(id: try c.decodeIfPresent(String.self, forKey: .id), mainSessionId: main,
                                threads: Self.lenientList(SideThread.self, c, .threads))
        case "side_thread_closed":
            self = .sideThreadClosed(threadId: try c.decode(String.self, forKey: .threadId))
        case "side_text_delta":
            let text: String = Self.lenient(String.self, c, .text) ?? ""
            self = .sideTextDelta(threadId: try c.decode(String.self, forKey: .threadId), text: text)
        case "side_tool_use":
            let threadId = try c.decode(String.self, forKey: .threadId)
            let id: String = Self.lenient(String.self, c, .id) ?? UUID().uuidString
            let name: String = Self.lenient(String.self, c, .name) ?? ""
            let input: JSONValue = Self.lenient(JSONValue.self, c, .input) ?? .object([:])
            self = .sideToolUse(threadId: threadId, id: id, name: name, input: input)
        case "side_tool_result":
            let threadId = try c.decode(String.self, forKey: .threadId)
            let toolUseId: String = Self.lenient(String.self, c, .toolUseId) ?? ""
            let isError: Bool = Self.lenient(Bool.self, c, .isError) ?? false
            let preview: String = Self.lenient(String.self, c, .preview) ?? ""
            let denied: Bool = Self.lenient(Bool.self, c, .denied) ?? false
            self = .sideToolResult(threadId: threadId, toolUseId: toolUseId, isError: isError, preview: preview, denied: denied)
        case "side_turn_end":
            let threadId = try c.decode(String.self, forKey: .threadId)
            let cost: Double = Self.lenient(Double.self, c, .costUSD) ?? 0
            let duration: Int = Self.lenient(Int.self, c, .durationMs) ?? 0
            let stop: String = Self.lenient(String.self, c, .stopReason) ?? ""
            self = .sideTurnEnd(threadId: threadId, costUSD: cost, durationMs: duration, stopReason: stop)
        case "side_promote_draft":
            let threadId = try c.decode(String.self, forKey: .threadId)
            let text: String = Self.lenient(String.self, c, .text) ?? ""
            self = .sidePromoteDraft(id: try c.decodeIfPresent(String.self, forKey: .id), threadId: threadId, text: text)
        case "mcp_status":
            let servers = Self.lenientList(McpServerInfo.self, c, .servers).filter { !$0.name.isEmpty }
            let restart: Bool = Self.lenient(Bool.self, c, .restartRequired) ?? false
            self = .mcpStatus(id: try c.decodeIfPresent(String.self, forKey: .id), servers: servers, restartRequired: restart)
        case "error":
            var detail = EngineErrorDetail(
                code: try? c.decodeIfPresent(String.self, forKey: .code),
                resetAt: try? c.decodeIfPresent(String.self, forKey: .resetAt),
                attempt: try? c.decodeIfPresent(Int.self, forKey: .attempt),
                maxRetries: try? c.decodeIfPresent(Int.self, forKey: .maxRetries),
                retryDelayMs: try? c.decodeIfPresent(Int.self, forKey: .retryDelayMs),
                status: try? c.decodeIfPresent(Int.self, forKey: .status),
                threadId: try? c.decodeIfPresent(String.self, forKey: .threadId),
                server: try? c.decodeIfPresent(String.self, forKey: .server))
            // MARK: wave1 mac-session (§30 / §33.4)
            detail.detail = Self.lenient(String.self, c, .detail)
            detail.exitCode = Self.lenient(Int.self, c, .exitCode)
            detail.signal = Self.lenient(String.self, c, .signal)
            detail.sessionId = Self.lenient(String.self, c, .sessionId)
            detail.toolName = Self.lenient(String.self, c, .toolName)
            detail.path = Self.lenient(String.self, c, .path)
            detail.branch = Self.lenient(String.self, c, .branch)
            detail.cli = Self.lenient(CliVersionChange.self, c, .cli)   // wave3 mac-session (§36.8)
            LongWorkWire.applyErrorFacts(from: decoder, to: &detail)   // wave4 w4-longwork (§38.2)
            self = .error(
                message: try c.decode(String.self, forKey: .message),
                fatal: try c.decodeIfPresent(Bool.self, forKey: .fatal) ?? false,
                scope: (try? c.decodeIfPresent(ErrorScope.self, forKey: .scope)) ?? .engine,
                detail: detail)
        case "log":
            self = .log(
                level: try c.decodeIfPresent(LogLevel.self, forKey: .level) ?? .info,
                message: try c.decode(String.self, forKey: .message))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unknown engine event type \(type)")
        }
    }

    /// A field that may be missing, null or of another type (→ nil).
    private static func lenient<T: Decodable>(_ type: T.Type, _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> T? {
        guard let value = try? c.decodeIfPresent(T.self, forKey: key) else { return nil }
        return value
    }

    /// Decodes `[T]` element by element, dropping the elements that do not decode (one bad thread never hides the rest).
    private static func lenientList<T: Decodable>(_ type: T.Type, _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [T] {
        guard var list = try? c.nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [T] = []
        while !list.isAtEnd {
            if let item = try? list.decode(T.self) {
                out.append(item)
            } else if (try? list.decode(JSONValue.self)) == nil {
                break
            }
        }
        return out
    }
}

extension EngineEvent: TransportEvent {
    public static func transportLog(level: LogLevel, message: String) -> EngineEvent { .log(level: level, message: message) }
    public static func transportExit(message: String) -> EngineEvent { .error(message: message, fatal: true, scope: .engine) }
    public var isFatalError: Bool {
        if case .error(_, fatal: true, _, _) = self { return true }
        return false
    }
}

// MARK: - NDJSON helpers

public enum NDJSON {
    public static func encodeLine<T: Encodable>(_ value: T) throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        var data = try enc.encode(value)
        data.append(0x0A)
        return data
    }

    public static func decode<T: Decodable>(_ type: T.Type, from line: String) throws -> T {
        try decoder.decode(type, from: Data(line.utf8))
    }

    /// MARK: wave6 w6-statusline — what the log says about a line that did not decode: its `type`, its size and where
    /// decoding stopped — never its content (a settings file's command, a file's text, a token in either).
    public static func undecodableSummary(_ line: String, error: Error) -> String {
        let type = line.prefix(400).firstMatch(of: /"type"\s*:\s*"([A-Za-z0-9_]{1,64})"/).map { String($0.1) } ?? "?"
        let at: String
        func path(_ c: DecodingError.Context) -> String {
            let p = c.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
            return p.isEmpty ? "the top" : p
        }
        switch error as? DecodingError {
        case let .typeMismatch(_, c)?: at = "typeMismatch at \(path(c))"
        case let .valueNotFound(_, c)?: at = "valueNotFound at \(path(c))"
        case let .keyNotFound(key, c)?: at = "keyNotFound \(key.stringValue) at \(path(c))"
        case let .dataCorrupted(c)?: at = "dataCorrupted at \(path(c))"
        default: at = String(describing: Swift.type(of: error))
        }
        return "undecodable sidecar line (\(type), \(line.utf8.count) bytes): \(at)"
    }

    /// Wire dates are ISO-8601 strings, with (`new Date().toISOString()`) or without (GitHub) fractional seconds.
    public static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date(s, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
            if let date = try? Date(s, strategy: Date.ISO8601FormatStyle()) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an ISO-8601 date: \(s)"))
        }
        return d
    }
}
