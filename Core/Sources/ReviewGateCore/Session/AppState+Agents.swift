import Foundation

// MARK: wave3 mac-agents — docs/PROTOCOL.md §36.1–36.4 on the Mac: a subagent's whole report and details, stopping one
// subagent, and the main turn waiting on subagents (the "subagents finished" notification). The stored state lives in
// AppState.swift's `wave3 mac-agents` block; the words and the pure rules in AgentDetails.swift.

/// What the "Agent details" sheet got when it asked for the whole report (`agent_report`).
public enum AgentReportLoad: Sendable, Equatable {
    case loaded(AgentReportReply)
    /// Refused (`no_report`, `unknown_agent`) or failed — the reason; the sheet keeps the preview.
    case unavailable(String)
    /// The engine does not know `agent_report` (before §36): the preview is all there is.
    case unsupported
}

/// Whether a card or a chat group head offers "Stop this agent" (§36.2).
public enum AgentStopState: Sendable, Equatable {
    case available
    /// `stop_agent` went out; the snapshot will say `stopped`.
    case stopping
    /// Shown, off, with a one-line reason (no task id: this Claude Code cannot stop one agent by itself).
    case unavailable(String)
    /// Not offered: the agent is not live, or the engine has no `stop_agent` (an engine before §36).
    case hidden
}

extension AppState {
    /// §36.4: the main turn waits on foreground subagents; nil between turns and on older engines.
    public var waitingOnAgents: WaitingOnAgents? { hudWire.waitingOnAgents }

    /// §36.10: the current chat's finished turns (its record's `turns`, which outlives a session switch; else the HUD's).
    public var finishedTurnsInChat: Int {
        guard let id = currentSessionId, let meta = sessionsInfo?.list.first(where: { $0.id == id }) else { return hud.turnCount }
        return max(meta.turns, hud.turnCount)
    }

    /// The live node of an Agent call while the engine lists it (until the next user turn drops a finished one).
    public func agentNode(toolUseId: String) -> AgentNode? {
        agents.first { $0.toolUseId == toolUseId }
    }

    /// §36.1: what the "Agent details" sheet shows (`reply`: the whole report once `agent_report` answered).
    public func agentDetail(toolUseId: String, reply: AgentReportReply? = nil) -> AgentDetail? {
        AgentDetail.make(toolUseId: toolUseId, node: agentNode(toolUseId: toolUseId), items: transcript, reply: reply,
                         root: projectInfo?.root ?? projectInfo?.path, running: isRunning)
    }

    /// §36.1: "View full report" is offered once the engine sent the §36 fields for this call (its result's usage / agent
    /// id, or the node's report preview) and did not refuse `agent_report` as unknown. Without them the chat keeps the
    /// preview as before. `resultInfo`: the call's result when the caller has it (spares a pass over the transcript).
    public func offersFullReport(toolUseId: String, resultInfo: ToolResultInfo? = nil) -> Bool {
        guard !agentReportUnsupported else { return false }
        if let node = agentNode(toolUseId: toolUseId), node.reportPreview != nil || node.cliAgentId != nil { return true }
        guard let info = resultInfo ?? TranscriptIndex(transcript).calls[toolUseId]?.resultInfo else { return false }
        return info.agentUsage != nil || info.cliAgentId != nil
    }

    /// §36.1: the whole cleaned report, instructions, usage and model of a subagent (a pure read in the engine).
    public func loadAgentReport(toolUseId: String) async -> AgentReportLoad {
        guard !agentReportUnsupported else { return .unsupported }
        do {
            guard case let .agentReport(report) = try await reply(.agentReport(toolUseId: toolUseId)) else {
                return .unavailable(AgentText.reportRefusal(code: nil, fallback: ""))
            }
            return .loaded(report)
        } catch let error as EngineClientError {
            if error.refusalCode == "unknown_command" {
                agentReportUnsupported = true
                return .unsupported
            }
            return .unavailable(AgentText.reportRefusal(code: error.refusalCode, fallback: error.userMessage))
        } catch {
            return .unavailable(AgentText.reportRefusal(code: nil, fallback: error.localizedDescription))
        }
    }

    /// §36.2: whether to offer the stop control for `node` (hover ■, "Stop this agent").
    public func agentStopState(_ node: AgentNode) -> AgentStopState {
        guard node.status.isLive, !agentStopUnsupported else { return .hidden }
        if stoppingAgentIds.contains(node.toolUseId) { return .stopping }
        // No task id (a CLI without task messages, or before its task_started): the engine would refuse `not_supported`.
        if node.id == node.toolUseId { return .unavailable(AgentText.stopUnavailable) }
        return .available
    }

    /// §36.2: stops that one subagent — no confirmation; the main turn and the other agents go on. The node turns
    /// `stopped` / `stoppedBy: user` with the next snapshot; a refusal is kept in `agentStopRefusals` (an engine without
    /// `stop_agent` also hides the control from then on).
    public func stopAgent(toolUseId: String) async {
        guard !stoppingAgentIds.contains(toolUseId) else { return }
        stoppingAgentIds.insert(toolUseId)
        agentStopRefusals[toolUseId] = nil
        do {
            try await request(.stopAgent(toolUseId: toolUseId))
            if agentNode(toolUseId: toolUseId)?.status.isLive != true { stoppingAgentIds.remove(toolUseId) }
        } catch let error as EngineClientError {
            stoppingAgentIds.remove(toolUseId)
            if error.refusalCode == "unknown_command" { agentStopUnsupported = true }
            agentStopRefusals[toolUseId] = AgentText.stopRefusal(code: error.refusalCode, fallback: error.userMessage)
        } catch {
            stoppingAgentIds.remove(toolUseId)
            agentStopRefusals[toolUseId] = AgentText.stopRefusal(code: nil, fallback: error.localizedDescription)
        }
    }

    /// After every snapshot: stops that took effect settle, and "subagents finished" goes out once per turn when every
    /// foreground subagent ended while the turn goes on (the app posts it only for a window in the background).
    func agentsSnapshotApplied(previous: ReviewState) {
        let live = Set(state.hud.agents.filter { $0.status.isLive }.map(\.toolUseId))
        if !stoppingAgentIds.isSubset(of: live) { stoppingAgentIds.formIntersection(live) }
        if agentStopRefusals.keys.contains(where: { !live.contains($0) }) { agentStopRefusals = agentStopRefusals.filter { live.contains($0.key) } }
        guard previous.project?.path == state.project?.path,
              AgentWaitText.finishedWhileRunning(previous: previous.hud.waitingOnAgents, current: state.hud.waitingOnAgents, running: isRunning)
        else { return }
        let finished = previous.hud.agents.filter { $0.status.isLive && $0.depth <= 1 && !$0.isBackground && !live.contains($0.toolUseId) }
        let turn = state.hud.turnStartedAt.map { String(Int($0)) } ?? "#\(state.hud.turnCount)"
        onAttention?(.agentsFinished(types: finished.map(\.type), key: "agents:\(turn)"))
    }

    /// A project switch / close forgets what the old engine said.
    func resetAgentsView() {
        stoppingAgentIds = []
        agentStopRefusals = [:]
        agentStopUnsupported = false
        agentReportUnsupported = false
    }
}
