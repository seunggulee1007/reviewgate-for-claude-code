import Foundation

// MARK: wave4b w4b-agents
// Wire types of docs/PROTOCOL.md §39.3 (subagents at a glance): what an agent is doing now (`lastStep`), the CLI retrying
// its API request (`retry`), when anything was last heard from it (`activeAt`), the user turn it started in (`turn`), an
// isolated agent's worktree, and the finished agents of earlier turns (`hud.agentHistory`); engine/src/protocol.ts,
// "MARK: wave4b w4b-agents". Every field is lenient: an engine before §39.3 sends none of them and a value of another type
// reads as absent, so the screens behave exactly as before.

/// §39.3: a subagent's latest tool call. `detail` is the HUD's (file name, command start, skill, query) or an MCP call's
/// representative argument; `since` / `endedAt`: epoch ms (no `endedAt` while the call runs).
public struct AgentStep: Sendable, Equatable, Decodable {
    public var tool: String
    public var detail: String?
    public var since: Double
    public var endedAt: Double?

    public init(tool: String, detail: String? = nil, since: Double, endedAt: Double? = nil) {
        self.tool = tool
        self.detail = detail
        self.since = since
        self.endedAt = endedAt
    }

    private enum CodingKeys: String, CodingKey { case tool, detail, since, endedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let tool = lenientValue(String.self, c, .tool), !tool.isEmpty,
              let since = lenientValue(Double.self, c, .since), since.isFinite else {
            throw DecodingError.dataCorruptedError(forKey: .tool, in: c, debugDescription: "step without a tool / start")
        }
        self.init(tool: tool, detail: AgentWire.nonEmpty(lenientValue(String.self, c, .detail)), since: since,
                  endedAt: lenientValue(Double.self, c, .endedAt).flatMap { $0.isFinite ? $0 : nil })
    }
}

/// §39.3: `tool_progress.subagent_retry` — attempt N of `max`; `status`: the HTTP status (nil for a connection error).
public struct AgentRetry: Sendable, Equatable, Decodable {
    public var attempt: Int
    public var max: Int
    public var at: Double
    public var status: Int?

    public init(attempt: Int, max: Int, at: Double = 0, status: Int? = nil) {
        self.attempt = attempt
        self.max = max
        self.at = at
        self.status = status
    }

    private enum CodingKeys: String, CodingKey { case attempt, max, at, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let attempt = AgentWire.int(c, .attempt), let max = AgentWire.int(c, .max) else {
            throw DecodingError.dataCorruptedError(forKey: .attempt, in: c, debugDescription: "retry without numbers")
        }
        self.init(attempt: attempt, max: max, at: lenientValue(Double.self, c, .at) ?? 0, status: AgentWire.int(c, .status))
    }
}

extension AgentNode {
    private enum GlanceKeys: String, CodingKey { case lastStep, retry, activeAt, turn, isolation, worktreePath, worktreeBranch }

    /// §39.3 fields on top of the §13 / §36 ones.
    mutating func decodeAgentGlanceFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: GlanceKeys.self) else { return }
        lastStep = lenientValue(AgentStep.self, c, .lastStep)
        retry = lenientValue(AgentRetry.self, c, .retry)
        activeAt = lenientValue(Double.self, c, .activeAt).flatMap { $0.isFinite ? $0 : nil }
        turn = AgentWire.int(c, .turn)
        isolation = AgentWire.nonEmpty(lenientValue(String.self, c, .isolation))
        worktreePath = AgentWire.nonEmpty(lenientValue(String.self, c, .worktreePath))
        worktreeBranch = AgentWire.nonEmpty(lenientValue(String.self, c, .worktreeBranch))
    }
}

enum AgentGlanceWire {
    private enum HistoryKeys: String, CodingKey { case agentHistory }

    /// §39.3 `hud.agentHistory`: the nodes that decode (newest first); [] from older engines.
    static func history(from decoder: Decoder) -> [AgentNode] {
        guard let c = try? decoder.container(keyedBy: HistoryKeys.self) else { return [] }
        return lenientElements(AgentNode.self, c, .agentHistory)
    }
}
