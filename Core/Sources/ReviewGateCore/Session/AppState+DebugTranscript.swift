import Foundation

#if DEBUG
// The screenshot tour's transcript check (App/Debug/ScreenshotTour.swift): a turn's events as the engine sends them and the
// turn ending into a review, without a turn of the engine's.
public extension AppState {
    /// Engine events, handled as if the engine had sent them.
    func debugHandle(_ events: [EngineEvent]) { events.forEach(handle) }

    /// §72.1: what `/hooks` shows (nil: the engine's answer again).
    func debugShowHooks(_ list: HooksList?) { debugHooksList = list }

    /// §72.3: what `/plugin` lists (nil: the engine's answer again).
    func debugShowPlugins(_ list: PluginsList?) { debugPlugins = list }

    /// §72.2: what `/output-style` lists and the session's style as a snapshot reports it (nil: the engine's again).
    func debugShowOutputStyles(_ reply: OutputStylesReply?) {
        debugOutputStyles = reply
        var snapshot = state
        snapshot.session.outputStyle = reply?.current
        state = snapshot
    }

    /// The gate as a snapshot reports it: `.running` while the turn works, `.reviewing` with `files` pending after it. The
    /// engine's next snapshot puts its own back.
    func debugShowGate(_ phase: GatePhase, files: [ChangedFile] = []) {
        var snapshot = state
        snapshot.gate.phase = phase
        snapshot.gate.pendingCount = files.count
        snapshot.changedFiles = files
        state = snapshot
    }

    /// The HUD as a snapshot reports a running turn: started at `turnStartedAt` (nil: none), with `agents` (live ones pulse in
    /// the HUD and on their group rows).
    func debugShowHUD(turnStartedAt: Date?, agents: [AgentNode]) {
        var snapshot = state
        snapshot.hud.turnStartedAt = turnStartedAt.map { $0.timeIntervalSince1970 * 1000 }
        snapshot.hud.agents = agents
        state = snapshot
    }

    /// The HUD's numbers as a snapshot reports them after `turns` turns (the composer bar check, `SHOTS_LAYOUT=composerbar`).
    func debugShowHUDNumbers(contextTokens: Int, contextWindow: Int?, costUSD: Double, turns: Int, lastTurnMs: Int) {
        var snapshot = state
        snapshot.hud.contextTokens = contextTokens
        snapshot.hud.contextWindow = contextWindow
        snapshot.hud.sessionCostUSD = costUSD
        snapshot.hud.turnCount = turns
        snapshot.hud.lastTurnMs = lastTurnMs
        state = snapshot
    }

    /// §67 (the composer bar check): the chat's added directories, a `!` command running with its output so far (nil:
    /// none), and how many results wait for the next message — as a snapshot and `shell_output` report them.
    func debugShowAddDirShell(addedDirs: [String], shell: ShellRunInfo? = nil, output: String = "", shellPending: Int = 0) {
        var snapshot = state
        snapshot.session.addedDirs = addedDirs
        snapshot.session.shell = shell
        snapshot.session.shellPending = shellPending
        state = snapshot
        shellLive = shell.map { ShellLiveOutput(id: $0.id, output: output) }
    }

    /// §71.1 / §71.2 (the composer bar check): the usage sheet's numbers and Claude's checklist as a snapshot reports them.
    func debugShowUsage(models: [ModelCost], totals: SessionTotals?, rateLimits: [RateLimitWindow], sideCostUSD: Double = 0) {
        var snapshot = state
        snapshot.hud.sessionModels = models
        snapshot.hud.sessionTotals = totals
        snapshot.hud.rateLimits = rateLimits
        snapshot.hud.sideCostUSD = sideCostUSD
        state = snapshot
    }

    func debugShowTodos(_ todos: [TodoItem]?) {
        var snapshot = state
        snapshot.session.todos = todos
        state = snapshot
    }

    /// §70.4 (the composer bar check): the chat's extended thinking as a snapshot reports it.
    func debugShowThinking(_ thinking: ThinkingState?) {
        var snapshot = state
        snapshot.session.thinking = thinking
        state = snapshot
    }

    /// §68 (the composer bar check): the branches with their upstream counts, `branches.sync`, the remote the project
    /// header shows and the last Fetch / Pull outcome — as a snapshot and a reply report them.
    func debugShowGitSync(branches: [BranchInfo], sync: GitSyncState?, remoteURL: String?, notice: GitSyncNotice?) {
        var snapshot = state
        snapshot.branches.list = branches
        snapshot.branches.sync = sync
        snapshot.project?.remoteURL = remoteURL
        state = snapshot
        gitSyncNotice = notice
    }
}
#endif
