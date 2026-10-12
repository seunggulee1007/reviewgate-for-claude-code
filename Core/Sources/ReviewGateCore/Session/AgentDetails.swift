import Foundation

// wave3 mac-agents — docs/PROTOCOL.md §36.1–36.4 and §36.10 on the Mac: what the chat and the agent panel say about a
// subagent (its report, model, instructions, usage), stopping one, continuations, the main turn waiting on subagents, and
// what a side question knows of the main conversation. Pure functions; `AppState+Agents.swift` holds the state.

// MARK: - §36.1 the report

public enum AgentReportText {
    /// The marker the CLI starts an Agent result with (CLI 2.1.307: "[Subagent hand-back] The text below is …").
    static let handBackMarker = "[Subagent hand-back]"
    static let handBackEnd = "The report follows:"

    /// The report as the screens show it. An engine with §36 already cleaned it; the CLI's raw hand-back (an engine before
    /// §36, or a transcript row it wrote) is cleaned the same way here: the preamble through "The report follows:", the
    /// trailing `agentId: …` line and `<usage>` block, and the two spaces the CLI indents every line with. A preview that
    /// ends inside the preamble has no report yet (""). Text without the marker is returned as it came (another CLI).
    public static func displayText(_ text: String) -> String {
        let start = text.drop(while: \.isWhitespace)
        guard start.hasPrefix(handBackMarker) else { return text }
        guard let end = start.range(of: handBackEnd) else { return "" }
        var rest = start[end.upperBound...]
        guard let newline = rest.firstIndex(of: "\n") else { return "" }
        rest = rest[rest.index(after: newline)...]
        var lines = rest.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        // The trailer sits at column zero (the report itself is indented): `<usage>…</usage>`, then `agentId: …` above it.
        if let usage = lines.lastIndex(where: { $0.hasPrefix("<usage>") }) { lines.removeSubrange(usage...) }
        if let agentId = lines.lastIndex(where: { $0.hasPrefix("agentId:") }) { lines.removeSubrange(agentId...) }
        let filled = lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if !filled.isEmpty, filled.allSatisfy({ $0.hasPrefix("  ") }) {
            lines = lines.map { $0.hasPrefix("  ") ? String($0.dropFirst(2)) : $0 }
        }
        return trimBlankLines(lines).joined(separator: "\n")
    }

    /// The report's first `lines` non-empty lines (blank lines between them kept, an open code fence closed) for the chat
    /// group; `more` = something follows.
    public static func excerpt(_ text: String, lines count: Int = 3) -> (text: String, more: Bool) {
        let all = trimBlankLines(text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init))
        var taken: [String] = []
        var filled = 0
        var index = 0
        while index < all.count, filled < count {
            let line = all[index]
            if !line.trimmingCharacters(in: .whitespaces).isEmpty { filled += 1 }
            taken.append(line)
            index += 1
        }
        let more = all[index...].contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let fences = taken.filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
        if fences % 2 == 1 { taken.append("```") }
        return (taken.joined(separator: "\n"), more)
    }

    private static func trimBlankLines(_ lines: [String]) -> [String] {
        var out = lines[...]
        while let first = out.first, first.trimmingCharacters(in: .whitespaces).isEmpty { out = out.dropFirst() }
        while let last = out.last, last.trimmingCharacters(in: .whitespaces).isEmpty { out = out.dropLast() }
        return Array(out)
    }
}

// MARK: - Model chip

/// opus purple, sonnet blue, haiku green, anything else gray (the clients' shared rule).
public enum AgentModelFamily: String, Sendable, Equatable { case opus, sonnet, haiku, other }

public enum AgentModelText {
    public static func family(_ model: String) -> AgentModelFamily {
        let m = model.lowercased()
        if m.contains("opus") { return .opus }
        if m.contains("sonnet") { return .sonnet }
        if m.contains("haiku") { return .haiku }
        return .other
    }

    /// `opus` → "opus", `claude-opus-4-1-20250805` → "opus 4.1", `claude-3-5-haiku-20241022` → "haiku 3.5"; a name without a
    /// known family stays as it is.
    public static func label(_ model: String) -> String {
        var m = model.trimmingCharacters(in: .whitespaces).lowercased()
        if let bracket = m.firstIndex(of: "[") { m = String(m[..<bracket]) }   // claude-sonnet-4-5[1m]
        if m.hasPrefix("claude-") { m = String(m.dropFirst("claude-".count)) }
        var parts = m.split(separator: "-").map(String.init)
        if let last = parts.last, last.count == 8, last.allSatisfy(\.isNumber) { parts.removeLast() }   // -20250805
        guard let name = parts.first(where: { ["opus", "sonnet", "haiku"].contains($0) }) else { return model }
        let version = parts.filter { !$0.isEmpty && $0.allSatisfy(\.isNumber) }.joined(separator: ".")
        return version.isEmpty ? name : "\(name) \(version)"
    }
}

// MARK: - Status of an Agent row

public enum AgentRowStatus {
    /// The live node's status when the engine reports one; else the call's result (a stop by the user is `stopped`, not
    /// `failed`); else running while the turn runs and stopped after it.
    public static func resolve(node: AgentNode?, result: (isError: Bool, info: ToolResultInfo)?, running: Bool) -> AgentStatus {
        if let node { return node.status }
        if let result {
            if result.info.stoppedBy == .user { return .stopped }
            return result.isError ? .failed : .completed
        }
        return running ? .running : .stopped
    }

    /// "Stopped by you": the node says so, or (after the next turn dropped the node) the call's result does.
    public static func stoppedByUser(node: AgentNode?, resultInfo: ToolResultInfo?) -> Bool {
        node?.stoppedBy == .user || resultInfo?.stoppedBy == .user
    }
}

// MARK: - The "Agent details" sheet

/// One call the subagent made, for the details sheet (`depth` 1+ = inside a nested agent).
public struct AgentCallSummary: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var detail: String
    /// nil while the call has no result.
    public var isError: Bool?
    public var depth: Int
    public var isAgent: Bool { ToolCallRecord.isAgentTool(name) }
}

/// §36.1: what the "Agent details" sheet shows about one subagent — from the `agent_report` reply when it came, else the
/// chat's rows (the Agent call's input, its result), else the live node.
public struct AgentDetail: Sendable, Equatable {
    public var toolUseId: String
    public var type: String
    public var description: String
    public var status: AgentStatus
    public var stoppedByUser: Bool
    public var isBackground: Bool
    public var resumeCount: Int
    public var model: String?
    /// The whole instructions when the reply or the call's row has them (the node keeps the first 8 000 chars).
    public var instructions: String?
    public var report: String?
    /// `report` is a preview (the reply did not come — yet, or ever).
    public var reportIsPreview: Bool
    /// The engine kept only the first 50 000 chars of the report.
    public var reportTruncated: Bool
    public var usage: AgentUsage?
    public var calls: [AgentCallSummary]
    public var files: [String]
    public var startedAt: Double?
    public var endedAt: Double?
    public var error: String?

    /// nil when neither the chat nor the node knows the call. `running`: the main turn runs (a call without result or
    /// node is then still working).
    public static func make(toolUseId: String, node: AgentNode?, items: [ChatItem], reply: AgentReportReply?, root: String?,
                            running: Bool = false) -> AgentDetail? {
        let index = TranscriptIndex(items)
        let call = index.calls[toolUseId]
        guard node != nil || call != nil else { return nil }
        let input = call?.input
        let resultInfo = call?.resultInfo
        var result: (isError: Bool, info: ToolResultInfo)?
        if let isError = call?.isError { result = (isError, resultInfo ?? ToolResultInfo()) }
        let preview = call?.preview.map(AgentReportText.displayText).flatMap(nonEmpty)
        let nodeUsage: AgentUsage? = node.flatMap { n in
            n.tokens == nil && n.toolUses == nil && n.durationMs == nil ? nil
                : AgentUsage(tokens: n.tokens ?? 0, toolUses: n.toolUses ?? 0, durationMs: n.durationMs ?? 0)
        }
        return AgentDetail(
            toolUseId: toolUseId,
            type: input?["subagent_type"]?.stringValue.flatMap(nonEmpty) ?? node?.type ?? "general-purpose",
            description: input?["description"]?.stringValue ?? node?.description ?? "",
            status: AgentRowStatus.resolve(node: node, result: result, running: running),
            stoppedByUser: AgentRowStatus.stoppedByUser(node: node, resultInfo: resultInfo),
            isBackground: node?.isBackground ?? (input?["run_in_background"] == .bool(true)),
            resumeCount: node?.resumeCount ?? 0,
            model: node?.apiModel ?? reply?.model ?? node?.model ?? input?["model"]?.stringValue.flatMap(nonEmpty),   // wave4d: §42.4 first
            instructions: reply?.prompt.flatMap(nonEmpty) ?? input?["prompt"]?.stringValue.flatMap(nonEmpty) ?? node?.prompt,
            report: reply.map(\.text).flatMap(nonEmpty) ?? preview ?? node?.reportPreview,
            reportIsPreview: reply.map(\.text).flatMap(nonEmpty) == nil,
            reportTruncated: reply?.truncated ?? false,
            usage: reply?.usage ?? resultInfo?.agentUsage ?? nodeUsage,
            calls: calls(under: toolUseId, items: items, index: index, root: root),
            files: node?.files ?? [],
            startedAt: node?.startedAt,
            endedAt: node?.endedAt,
            error: node?.error)
    }

    /// The calls whose parent chain reaches `toolUseId`, in chat order.
    static func calls(under toolUseId: String, items: [ChatItem], index: TranscriptIndex, root: String?) -> [AgentCallSummary] {
        items.compactMap { item in
            guard case let .toolUse(_, id, name, _, _, _) = item, let record = index.calls[id] else { return nil }
            let chain = index.ancestors(of: id).map(\.toolUseId)
            guard let depth = chain.firstIndex(of: toolUseId) else { return nil }
            return AgentCallSummary(id: id, name: name, detail: record.shortInput(root: root), isError: record.isError, depth: depth)
        }
    }

    private static func nonEmpty(_ s: String) -> String? {
        s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : s
    }
}

// MARK: - §36.3 continuations

public enum AgentContinuationText {
    /// The SendMessage row: "executor에게 이어서: <the message's first line>" (a protocol message: its summary).
    public static func row(_ continues: AgentContinuation, input: JSONValue) -> String {
        let type = continues.agentType.isEmpty ? "general-purpose" : continues.agentType
        let message = input["message"]?.stringValue ?? input["content"]?.stringValue ?? input["summary"]?.stringValue ?? ""
        let line = message.split(whereSeparator: \.isNewline).lazy
            .map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? "…"
        let clipped = line.count > 120 ? String(line.prefix(119)) + "…" : line
        return String(localized: "Continue \(type): \(clipped)", bundle: .module)
    }

    /// The agents whose `resumeCount` went up since `previous` (toolUseId → count): their chat groups open.
    public static func newlyResumed(previous: [String: Int], agents: [AgentNode]) -> [String] {
        agents.filter { $0.resumeCount > (previous[$0.toolUseId] ?? 0) }.map(\.toolUseId)
    }
}

// MARK: - §36.4 waiting

public enum AgentWaitText {
    /// The composer's status line: "메인은 서브에이전트 2개를 기다리는 중 · executor 4m 12s".
    public static func statusLine(_ waiting: WaitingOnAgents, elapsed: String) -> String {
        guard let longest = waiting.longest else {
            return String(localized: "Main is waiting for \(waiting.count) subagents", bundle: .module)
        }
        let type = longest.type.isEmpty ? "general-purpose" : longest.type
        return String(localized: "Main is waiting for \(waiting.count) subagents · \(type) \(elapsed)", bundle: .module)
    }

    /// Every foreground subagent finished while the turn goes on (the turn's own end is the turn notification).
    public static func finishedWhileRunning(previous: WaitingOnAgents?, current: WaitingOnAgents?, running: Bool) -> Bool {
        previous != nil && current == nil && running
    }
}

// MARK: - Refusals

public enum AgentText {
    /// §36.2 `stop_agent` refused, in the user's words; nil = nothing worth saying (`not_running`: it ended meanwhile).
    public static func stopRefusal(code: String?, fallback: String) -> String? {
        switch code {
        case "not_running": return nil
        case "unknown_agent": return String(localized: "This agent is no longer known — it may have ended", bundle: .module)
        case "not_supported", "unknown_command": return stopUnavailable
        default: return fallback.isEmpty ? String(localized: "Could not stop this agent", bundle: .module) : fallback
        }
    }

    /// Why one agent cannot be stopped by itself (no task id from this Claude Code, or an engine before §36).
    public static var stopUnavailable: String {
        String(localized: "This agent cannot be stopped by itself — Stop (⌘.) ends the whole turn", bundle: .module)
    }

    /// §36.1 `agent_report` refused.
    public static func reportRefusal(code: String?, fallback: String) -> String {
        switch code {
        case "no_report": return String(localized: "No report yet — the agent is still running or returned no text", bundle: .module)
        case "unknown_agent": return String(localized: "This agent's report is no longer kept — showing the preview", bundle: .module)
        default: return fallback.isEmpty ? String(localized: "Could not load the report — showing the preview", bundle: .module) : fallback
        }
    }
}

// MARK: - §36.10 what a side question knows

public enum SideForkText {
    /// The new-question view's line (SME-02): what the fork will hold of the main conversation — never the review list,
    /// which no side prompt carries. `turnCount` = the main chat's finished turns (`hud.turnCount`).
    public static func newQuestionKnows(turnCount: Int, running: Bool) -> String {
        switch (turnCount > 0, running) {
        case (true, false): return String(localized: "Knows the conversation up to turn \(turnCount)", bundle: .module)
        case (true, true):
            return String(localized: "Knows the conversation up to turn \(turnCount), and turn \(turnCount + 1) in progress only as a summary",
                          bundle: .module)
        case (false, true): return String(localized: "Knows turn \(1) in progress only as a summary — no finished turn yet", bundle: .module)
        case (false, false): return String(localized: "Knows no conversation yet — only the code and what you anchor", bundle: .module)
        }
    }
}

// MARK: - Notification

public extension AttentionEvent {
    /// §36.4: every foreground subagent finished while the window was in the background and Claude goes on; one per turn
    /// (`key`). `types`: the agents that finished, named in the body.
    static func agentsFinished(types: [String], key: String) -> AttentionEvent {
        var seen: Set<String> = []
        let names = types.filter { !$0.isEmpty && seen.insert($0).inserted }
        let body = names.count > 3 ? names.prefix(3).joined(separator: ", ") + " +\(names.count - 3)" : names.joined(separator: ", ")
        return AttentionEvent(kind: .agentsFinished, title: String(localized: "Subagents finished — Claude is continuing", bundle: .module),
                              body: body, key: key)
    }
}
