import Foundation

// Wire types of docs/PROTOCOL.md §36.1–36.4 (a subagent's details and report, stopping one, SendMessage continuations,
// the main turn waiting on subagents) and §36.10 (a side question's running-turn block); engine/src/protocol.ts, block
// "§36 wave 3". Every field is lenient: an engine before §36 sends none of them and a value of another type reads as
// absent, so the screens behave exactly as before.

// MARK: wave3 mac-agents

/// §36.1: a subagent's usage — the `<usage>` block of its result (`subagent_tokens`, `tool_uses`, `duration_ms`).
public struct AgentUsage: Sendable, Equatable, Decodable {
    public var tokens: Int
    public var toolUses: Int
    public var durationMs: Int

    public init(tokens: Int, toolUses: Int, durationMs: Int) {
        self.tokens = tokens
        self.toolUses = toolUses
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey { case tokens, toolUses, durationMs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let tokens = AgentWire.int(c, .tokens), uses = AgentWire.int(c, .toolUses), ms = AgentWire.int(c, .durationMs)
        guard tokens != nil || uses != nil || ms != nil else {
            throw DecodingError.dataCorruptedError(forKey: .tokens, in: c, debugDescription: "usage without numbers")
        }
        self.init(tokens: tokens ?? 0, toolUses: uses ?? 0, durationMs: ms ?? 0)
    }
}

/// §36.2: who stopped an agent; only `user` (`stop_agent`) exists. An unknown value reads as absent.
public enum AgentStoppedBy: String, Sendable, Equatable { case user }

/// §36.3: `tool_use.continues` — a SendMessage call that continues a subagent the engine knows.
public struct AgentContinuation: Sendable, Equatable, Decodable {
    /// The Agent / Task call that started it (`AgentNode.toolUseId`): its group in the chat.
    public var agentToolUseId: String
    /// Its `subagent_type` ("" when the engine did not say).
    public var agentType: String

    public init(agentToolUseId: String, agentType: String) {
        self.agentToolUseId = agentToolUseId
        self.agentType = agentType
    }

    private enum CodingKeys: String, CodingKey { case agentToolUseId, agentType }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = lenientValue(String.self, c, .agentToolUseId), !id.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .agentToolUseId, in: c, debugDescription: "continuation without a call")
        }
        self.init(agentToolUseId: id, agentType: lenientValue(String.self, c, .agentType) ?? "")
    }
}

/// §36.4: `hud.waitingOnAgents` — the main turn is blocked on foreground subagents.
public struct WaitingOnAgents: Sendable, Equatable, Decodable {
    /// The one running longest. `startedAt`: epoch ms (of its current run when it was continued).
    public struct Longest: Sendable, Equatable, Decodable {
        public var toolUseId: String
        public var type: String
        public var startedAt: Double

        public init(toolUseId: String, type: String, startedAt: Double) {
            self.toolUseId = toolUseId
            self.type = type
            self.startedAt = startedAt
        }

        private enum CodingKeys: String, CodingKey { case toolUseId, type, startedAt }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(toolUseId: lenientValue(String.self, c, .toolUseId) ?? "",
                      type: lenientValue(String.self, c, .type) ?? "",
                      startedAt: lenientValue(Double.self, c, .startedAt) ?? 0)
        }
    }

    /// Live foreground top-level subagents (a blocking continuation included).
    public var count: Int
    /// nil when the engine sent none (or something unreadable).
    public var longest: Longest?

    public init(count: Int, longest: Longest?) {
        self.count = count
        self.longest = longest
    }

    private enum CodingKeys: String, CodingKey { case count, longest }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(count: AgentWire.int(c, .count) ?? 0, longest: lenientValue(Longest.self, c, .longest))
    }
}

/// §36.1: reply to `agent_report` — the subagent's whole report, cleaned by the engine (≤ 50 000 chars; `truncated`
/// beyond), the instructions it was given (≤ 50 000 chars; nil when unknown), its usage and model.
public struct AgentReportReply: Sendable, Equatable {
    public var id: String?
    public var toolUseId: String
    public var text: String
    public var truncated: Bool
    public var usage: AgentUsage?
    public var model: String?
    public var prompt: String?

    public init(id: String? = nil, toolUseId: String, text: String, truncated: Bool = false, usage: AgentUsage? = nil,
                model: String? = nil, prompt: String? = nil) {
        self.id = id
        self.toolUseId = toolUseId
        self.text = text
        self.truncated = truncated
        self.usage = usage
        self.model = model
        self.prompt = prompt
    }
}

extension AgentReportReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, toolUseId, text, truncated, usage, model, prompt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id),
                  toolUseId: lenientValue(String.self, c, .toolUseId) ?? "",
                  text: lenientValue(String.self, c, .text) ?? "",
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false,
                  usage: lenientValue(AgentUsage.self, c, .usage),
                  model: AgentWire.nonEmpty(lenientValue(String.self, c, .model)),
                  prompt: lenientValue(String.self, c, .prompt))
    }
}

// MARK: - The fields §36 adds to existing objects (read from the same JSON object)

extension AgentNode {
    private enum DetailKeys: String, CodingKey { case prompt, model, reportPreview, cliAgentId, stoppedBy, resumeCount, resumedBy }

    /// §36.1–36.3: `prompt`, `model`, `reportPreview`, `cliAgentId`, `stoppedBy`, `resumeCount`, `resumedBy`.
    mutating func decodeAgentDetailFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: DetailKeys.self) else { return }
        prompt = AgentWire.nonEmpty(lenientValue(String.self, c, .prompt))
        model = AgentWire.nonEmpty(lenientValue(String.self, c, .model))
        reportPreview = AgentWire.nonEmpty(lenientValue(String.self, c, .reportPreview))
        cliAgentId = AgentWire.nonEmpty(lenientValue(String.self, c, .cliAgentId))
        stoppedBy = lenientValue(String.self, c, .stoppedBy).flatMap(AgentStoppedBy.init(rawValue:))
        resumeCount = max(0, AgentWire.int(c, .resumeCount) ?? 0)
        resumedBy = AgentWire.nonEmpty(lenientValue(String.self, c, .resumedBy))
    }
}

extension ToolResultInfo {
    private enum AgentKeys: String, CodingKey { case agentUsage, cliAgentId, stoppedBy }

    /// §36.1–36.2: the Agent / Task fields of a `tool_result` (event and transcript row) on top of the existing ones.
    func withAgentFields(from decoder: Decoder) -> ToolResultInfo {
        guard let c = try? decoder.container(keyedBy: AgentKeys.self) else { return self }
        var info = self
        info.agentUsage = lenientValue(AgentUsage.self, c, .agentUsage)
        info.cliAgentId = AgentWire.nonEmpty(lenientValue(String.self, c, .cliAgentId))
        info.stoppedBy = lenientValue(String.self, c, .stoppedBy).flatMap(AgentStoppedBy.init(rawValue:))
        return info
    }
}

/// Lenient readers shared by the §36.1–36.4 fields.
enum AgentWire {
    private enum ContinuationKeys: String, CodingKey { case continues }
    private enum WaitingKeys: String, CodingKey { case waitingOnAgents }
    private enum ForkKeys: String, CodingKey { case atTurn, runningTurn }

    /// §36.3: `tool_use.continues` (event and row).
    static func continuation(from decoder: Decoder) -> AgentContinuation? {
        guard let c = try? decoder.container(keyedBy: ContinuationKeys.self) else { return nil }
        return lenientValue(AgentContinuation.self, c, .continues)
    }

    /// §36.4: `hud.waitingOnAgents`; a count below one reads as "not waiting".
    static func waiting(from decoder: Decoder) -> WaitingOnAgents? {
        guard let c = try? decoder.container(keyedBy: WaitingKeys.self),
              let waiting = lenientValue(WaitingOnAgents.self, c, .waitingOnAgents), waiting.count > 0 else { return nil }
        return waiting
    }

    /// §36.10: `fork.atTurn` / `fork.runningTurn` (null and odd values read as absent).
    static func forkTurns(from decoder: Decoder) -> (atTurn: Int?, runningTurn: Int?) {
        guard let c = try? decoder.container(keyedBy: ForkKeys.self) else { return (nil, nil) }
        return (int(c, .atTurn), int(c, .runningTurn))
    }

    /// An integer that may arrive as a JSON double (`12.0`); anything else → nil.
    static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Int? {
        if let value = lenientValue(Int.self, c, key) { return value }
        guard let value = lenientValue(Double.self, c, key), value.isFinite, abs(value) < 1e15 else { return nil }
        return Int(value.rounded())
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }
}
