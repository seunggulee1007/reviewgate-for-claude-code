import Foundation

// MARK: wave4b w4b-agents
// Subagents at a glance (docs/PROTOCOL.md §39.3) — the same rules as Electron's `agentGlance.ts` / `toolLabel.ts` and the
// engine's `session/toolLabel.ts`: how an MCP / Skill call reads, what an agent is doing now and its badges, the HUD's line
// while subagents run, a finished agent's numbers, the earlier turns, which agent changed a file, the isolation badge.

/// How a tool call reads: `mcp__<server>__<tool>` as server + readable tool + representative argument, Skill by its skill.
/// Checked against `engine/test/fixtures/toolLabels.json` (the engine and Electron read the same cases).
public struct ToolLabel: Sendable, Equatable {
    public enum Kind: String, Sendable { case mcp, skill, tool }
    public var kind: Kind
    /// mcp: the tool without the server's prefix, `_` / `-` as spaces; skill: the skill ("" when none); tool: the raw name.
    public var name: String
    public var server: String?
    /// mcp: the representative argument; skill: its `args`. One line, at most 60 characters + "…".
    public var arg: String?

    public init(kind: Kind, name: String, server: String? = nil, arg: String? = nil) {
        self.kind = kind
        self.name = name
        self.server = server
        self.arg = arg
    }

    /// The input keys that say what an MCP call is about, most telling first.
    static let representativeKeys = ["postNumber", "postId", "taskNumber", "issueNumber", "number", "query", "sql", "q", "index",
                                     "url", "path", "file_path", "name", "title", "id", "pattern", "command", "prompt"]

    /// Whitespace runs to one space, trimmed, cut at 60 UTF-16 units with "…" (as the engine's `activityDetail`).
    static func oneLine(_ raw: String) -> String {
        let s = raw.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        guard s.utf16.count > 60 else { return s }
        return (String(s.utf16.prefix(60)) ?? String(s.prefix(60))) + "…"
    }

    static func representativeArg(_ input: JSONValue?) -> String? {
        guard let input else { return nil }
        for key in representativeKeys {
            switch input[key] {
            case .string(let v)?:
                let s = oneLine(v)
                if !s.isEmpty { return s }
            case .number(let n)? where n.isFinite:
                return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
            default:
                continue
            }
        }
        return nil
    }

    public static func of(_ name: String, input: JSONValue? = nil) -> ToolLabel {
        if name == "Skill" {
            let skill = input?["skill"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let args = input?["args"]?.stringValue.map(oneLine) ?? ""
            return ToolLabel(kind: .skill, name: skill, arg: args.isEmpty ? nil : args)
        }
        if name.hasPrefix("mcp__") {
            let rest = String(name.dropFirst(5))
            if let range = rest.range(of: "__"), range.lowerBound > rest.startIndex {
                let server = String(rest[..<range.lowerBound])
                var tool = String(rest[range.upperBound...])
                if !tool.isEmpty {
                    if tool.hasPrefix(server + "_"), tool.count > server.count + 1 { tool = String(tool.dropFirst(server.count + 1)) }
                    let readable = tool.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
                        .trimmingCharacters(in: .whitespaces)
                    return ToolLabel(kind: .mcp, name: readable.isEmpty ? tool : readable, server: server, arg: representativeArg(input))
                }
            }
        }
        return ToolLabel(kind: .tool, name: name)
    }
}

public enum AgentGlance {
    /// No progress of a live agent for this long reads "응답 없음 N분".
    public static let staleAfterMs: Double = 120_000

    static func isLive(_ s: AgentStatus) -> Bool { s == .pending || s == .running || s == .paused }

    /// `oh-my-claudecode:executor` → `executor`.
    public static func typeLabel(_ type: String) -> String {
        guard let i = type.lastIndex(of: ":") else { return type }
        return String(type[type.index(after: i)...])
    }

    /// A tool by name and its detail: "Bash · ./gradlew test", "github · get issue · 4821", "스킬 acme-tools:smoke".
    public static func toolTitle(_ tool: String, detail: String?, separator: String = " · ") -> String {
        let d = detail.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        if tool == "Skill" {
            return d.map { String(localized: "Skill \($0)", bundle: .module) } ?? String(localized: "Skill", bundle: .module)
        }
        let l = ToolLabel.of(tool)
        let name = l.kind == .mcp ? "\(l.server ?? "") · \(l.name)" : l.name
        return d.map { "\(name)\(separator)\($0)" } ?? name
    }

    /// A call by name and input — the permission card's title: "github · get issue · 4821", "스킬 acme-tools:smoke".
    public static func callTitle(_ name: String, input: JSONValue?) -> String {
        let l = ToolLabel.of(name, input: input)
        switch l.kind {
        case .mcp: return ["\(l.server ?? "") · \(l.name)", l.arg].compactMap { $0 }.joined(separator: " · ")
        case .skill: return l.name.isEmpty ? String(localized: "Skill", bundle: .module) : String(localized: "Skill \(l.name)", bundle: .module)
        case .tool: return name
        }
    }

    /// "Bash · ./gradlew :acme-api:test · 4분 12초" (how long that call has run, or ran).
    public static func stepLine(_ step: AgentStep, nowMs: Double, language: String = ElapsedFormat.uiLanguage) -> String {
        let ms = max(0, (step.endedAt ?? nowMs) - step.since)
        return "\(toolTitle(step.tool, detail: step.detail)) · \(ElapsedFormat.text(seconds: ms / 1000, language: language))"
    }

    public struct Badge: Sendable, Equatable {
        public enum Kind: Sendable { case retry, stale }
        public var kind: Kind
        public var text: String
        public var help: String
    }

    /// A live agent's warnings: "재시도 3/10", "응답 없음 2분". None while it waits for a permission answer or is paused.
    public static func badges(_ a: AgentNode, nowMs: Double, awaitingPermission: Bool = false, language: String = ElapsedFormat.uiLanguage) -> [Badge] {
        guard isLive(a.status), a.status != .paused, !awaitingPermission else { return [] }
        var out: [Badge] = []
        if let r = a.retry {
            let why = r.status.map { String(localized: "API error \($0) — Claude Code is retrying", bundle: .module) }
                ?? String(localized: "Connection error — Claude Code is retrying", bundle: .module)
            out.append(Badge(kind: .retry, text: String(localized: "Retry \(r.attempt)/\(r.max)", bundle: .module), help: why))
        }
        if let at = a.activeAt, nowMs - at >= staleAfterMs {
            let minutes = max(1, Int((nowMs - at) / 60_000))
            let span = String(localized: "\(minutes) min", bundle: .module)
            out.append(Badge(kind: .stale, text: String(localized: "No response \(span)", bundle: .module),
                             help: String(localized: "Nothing heard from this agent for \(ElapsedFormat.text(seconds: (nowMs - at) / 1000, language: language))", bundle: .module)))
        }
        return out
    }

    /// The HUD while subagents run: "서브에이전트 3개 실행 중 — executor: Edit TenantService.java" (the agent whose call
    /// started last, one still running first); nil when none is live.
    public static func hudLine(_ agents: [AgentNode]) -> String? {
        let live = agents.filter { isLive($0.status) }
        guard !live.isEmpty else { return nil }
        var best: (AgentNode, AgentStep)?
        for a in live {
            guard let step = a.lastStep else { continue }
            if let (_, b) = best {
                let bRunning = b.endedAt == nil, sRunning = step.endedAt == nil
                if bRunning && !sRunning { continue }
                if bRunning == sRunning && step.since <= b.since { continue }
            }
            best = (a, step)
        }
        guard let (a, step) = best else { return String(localized: "\(live.count) subagents running", bundle: .module) }
        let what = "\(typeLabel(a.type)): \(toolTitle(step.tool, detail: step.detail, separator: " "))"
        return String(localized: "\(live.count) subagents running — \(what)", bundle: .module)
    }

    /// 950 → "950", 35_200 → "35.2k", 1_200_000 → "1.2M".
    public static func compactTokens(_ n: Int) -> String {
        func trim(_ v: Double) -> String {
            let s = String(format: "%.1f", v)
            return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
        }
        if n >= 1_000_000 { return trim(Double(n) / 1_000_000) + "M" }
        if n >= 1_000 { return trim(Double(n) / 1_000) + "k" }
        return String(n)
    }

    static func statusText(_ s: AgentStatus, stoppedByUser: Bool) -> String {
        switch s {
        case .completed: String(localized: "Completed", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .stopped: stoppedByUser ? String(localized: "Stopped by you", bundle: .module) : String(localized: "Stopped", bundle: .module)
        case .running: String(localized: "Running", bundle: .module)
        case .pending: String(localized: "Pending", bundle: .module)
        case .paused: String(localized: "Paused", bundle: .module)
        }
    }

    /// A finished agent's numbers: "✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2" (nil while it runs).
    public static func finishedLine(status: AgentStatus, tokens: Int?, durationMs: Int?, files: Int, stoppedByUser: Bool = false,
                                    language: String = ElapsedFormat.uiLanguage) -> String? {
        guard !isLive(status) else { return nil }
        let mark = status == .completed ? "✓" : status == .failed ? "✕" : "■"
        var parts = ["\(mark) \(statusText(status, stoppedByUser: stoppedByUser))"]
        if let durationMs { parts.append(ElapsedFormat.text(seconds: Double(durationMs) / 1000, language: language)) }
        if let tokens { parts.append(String(localized: "\(compactTokens(tokens)) tokens", bundle: .module)) }
        if files > 0 { parts.append(String(localized: "Files \(files)", bundle: .module)) }
        return parts.joined(separator: " · ")
    }

    /// The first line of a finished agent's report, without markdown marks ("## 결론" → "결론"), at most 200 characters.
    public static func conclusionLine(_ report: String?) -> String? {
        guard let report else { return nil }
        for raw in report.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: "^([#>*\\-]+\\s*)+", with: "", options: .regularExpression)
                .replacingOccurrences(of: "**", with: "")
                .trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            return line.count > 200 ? String(line.prefix(199)) + "…" : line
        }
        return nil
    }

    /// Distinct files the edit calls under the Agent call `toolUseId` named (any depth) — the rows survive a restart.
    public static func groupFiles(_ index: TranscriptIndex, under toolUseId: String) -> [String] {
        var out: [String] = []
        for call in index.calls.values where ToolCallRecord.editTools.contains(call.name) {
            guard let file = call.file, !out.contains(file) else { continue }
            if index.ancestors(of: call.toolUseId).contains(where: { $0.toolUseId == toolUseId }) { out.append(file) }
        }
        return out.sorted()
    }

    // MARK: earlier turns (agents-08)

    /// Earlier agents by turn, newest turn first (agents without a turn number last, as one group).
    public static func historyByTurn(_ history: [AgentNode]) -> [(turn: Int?, agents: [AgentNode])] {
        var order: [Int?] = []
        var groups: [Int?: [AgentNode]] = [:]
        for a in history {
            if groups[a.turn] == nil { order.append(a.turn) }
            groups[a.turn, default: []].append(a)
        }
        let sorted = order.sorted { x, y in
            switch (x, y) {
            case let (x?, y?): return x > y
            case (nil, _): return false
            case (_, nil): return true
            }
        }
        return sorted.map { (turn: $0, agents: groups[$0] ?? []) }
    }

    /// "executor · 배치 모듈 영향 확인 · ✓ 완료 · 1분 4초 · 35k 토큰 · 파일 2".
    public static func historyLine(_ a: AgentNode, language: String = ElapsedFormat.uiLanguage) -> String {
        let fin = finishedLine(status: a.status, tokens: a.tokens, durationMs: a.durationMs, files: a.files.count,
                               stoppedByUser: a.stoppedBy == .user, language: language)
        return [typeLabel(a.type), a.description.isEmpty ? nil : a.description, fin].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: who changed a file (agents-13)

    public struct FileAuthor: Sendable, Hashable, Identifiable {
        public var id: String { key }
        /// `main` or the Agent call's tool_use id.
        public var key: String
        public var label: String
        public var agentToolUseId: String?
    }

    public static let mainAuthor = "main"

    /// The authors of a changed file (`ChangedFile.toolUseIds`): the nearest subagent above each call, else the main agent.
    public static func fileAuthors(_ toolUseIds: [String], index: TranscriptIndex, agents: [AgentNode] = []) -> [FileAuthor] {
        var out: [FileAuthor] = []
        var seen: Set<String> = []
        for id in toolUseIds {
            var agentId: String?
            var cur = index.calls[id]?.info.parentToolUseId
            var visited: Set<String> = []
            while let c = cur, !visited.contains(c) {
                visited.insert(c)
                guard let call = index.calls[c] else { agentId = c; break }   // rows paged out: still a subagent
                if call.spawnsAgent { agentId = c; break }
                cur = call.info.parentToolUseId
            }
            let key = agentId ?? mainAuthor
            guard seen.insert(key).inserted else { continue }
            guard let agentId else {
                out.append(FileAuthor(key: key, label: String(localized: "Main", bundle: .module), agentToolUseId: nil))
                continue
            }
            let type = index.calls[agentId]?.input["subagent_type"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
                ?? agents.first(where: { $0.toolUseId == agentId })?.type ?? "agent"
            out.append(FileAuthor(key: key, label: typeLabel(type), agentToolUseId: agentId))
        }
        return out
    }

    /// The filter chips above the list — "전체 · 메인 · executor · test-engineer" — only with two or more authors.
    public static func authorFilters(_ perFile: [[FileAuthor]]) -> [FileAuthor] {
        var all: [FileAuthor] = []
        for list in perFile { for a in list where !all.contains(where: { $0.key == a.key }) { all.append(a) } }
        guard all.count >= 2 else { return [] }
        var count: [String: Int] = [:]
        let named = all.filter { $0.key != mainAuthor }.map { a -> FileAuthor in
            let n = (count[a.label] ?? 0) + 1
            count[a.label] = n
            var b = a
            if n > 1 { b.label = "\(a.label) \(n)" }
            return b
        }
        return all.filter { $0.key == mainAuthor } + named
    }

    /// The turn summary's "에이전트별 변경": each author with its files (none when only the main agent changed files).
    public static func changesByAgent(_ paths: [String], authors: (String) -> [FileAuthor]) -> [(author: FileAuthor, paths: [String])] {
        var order: [String] = []
        var by: [String: (author: FileAuthor, paths: [String])] = [:]
        for p in paths {
            for a in authors(p) {
                if by[a.key] == nil { order.append(a.key); by[a.key] = (a, []) }
                by[a.key]?.paths.append(p)
            }
        }
        guard order.contains(where: { $0 != mainAuthor }) else { return [] }
        return order.compactMap { by[$0] }
    }

    // MARK: isolation (agents-14)

    /// "격리 worktree · 리뷰 밖" for an agent that ran with `isolation` (not a call the hooks denied), else nil.
    public static func isolationBadge(_ a: AgentNode) -> (text: String, help: String)? {
        guard let iso = a.isolation, iso != "none" else { return nil }
        if a.status == .failed, a.worktreePath == nil { return nil }
        let text = iso == "worktree" ? String(localized: "Isolated worktree · outside the review", bundle: .module)
            : String(localized: "Isolated (\(iso)) · outside the review", bundle: .module)
        let whereText = [a.worktreePath, a.worktreeBranch].compactMap { $0 }.joined(separator: " · ")
        let help = whereText.isEmpty ? String(localized: "Its changes stay outside this folder; this window's review does not see them.", bundle: .module)
            : String(localized: "Its changes stay in \(whereText); this window's review does not see them.", bundle: .module)
        return (text, help)
    }
}
