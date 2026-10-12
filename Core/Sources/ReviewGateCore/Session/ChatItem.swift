import Foundation

public enum ChatItem: Identifiable, Sendable, Equatable {
    /// `meta`: the turn number plus the mentions / image refs it went out with (§23 / §24 / §26).
    case user(id: UUID, text: String, meta: UserMessageMeta = UserMessageMeta())
    /// `unprompted`: written in a turn Claude Code ran on its own, outside any request (docs/PROTOCOL.md §18).
    case assistant(id: UUID, text: String, streaming: Bool, unprompted: Bool = false)
    /// `info`: subagent parent + rationale (docs/PROTOCOL.md §12).
    case toolUse(id: UUID, toolUseId: String, name: String, file: String?, input: JSONValue, info: ToolUseInfo = ToolUseInfo())
    /// `info`: subagent parent, `truncated` (full Bash output via `tool_output`), `testOutcome`.
    case toolResult(id: UUID, toolUseId: String, isError: Bool, preview: String, info: ToolResultInfo = ToolResultInfo())
    case permission(id: UUID, request: PermissionRequest, allowed: Bool?)
    case budgetEvent(id: UUID, kind: BudgetEventKind, toolName: String, file: String?, files: Int, lines: Int, budget: Budget)
    /// `info` (wave1 mac-session): the code, the CLI's words, how often it repeated (×N) and how it reads (§30).
    case error(id: UUID, message: String, fatal: Bool, info: ErrorRowInfo = ErrorRowInfo())
    case turnEnd(id: UUID, summary: String)
    /// M20: a plan-mode proposal (`approvedMode == nil`, `plan` carries the markdown) or its approval
    /// (`approvedMode` set) — kept in the transcript so the plan stays in the history after the card is gone.
    case plan(id: UUID, path: String?, plan: String, approvedMode: PermissionMode?)
    /// §15: the card after a turn that left files to review (files + why, commands, plan vs actual).
    case turnSummary(id: UUID, summary: TurnSummary)
    /// §29 (wave1 mac-session): a message from another Claude session — delivered (its turn's first row), dropped, or
    /// read by the CLI without being held (`unprompted`).
    case peerMessage(id: UUID, message: PeerMessage)

    public var id: UUID {
        switch self {
        case .user(let id, _, _), .assistant(let id, _, _, _), .toolUse(let id, _, _, _, _, _),
             .toolResult(let id, _, _, _, _), .permission(let id, _, _),
             .budgetEvent(let id, _, _, _, _, _, _), .error(let id, _, _, _), .turnEnd(let id, _),
             .plan(let id, _, _, _), .turnSummary(let id, _), .peerMessage(let id, _):
            return id
        }
    }
}

public struct TouchedFile: Identifiable, Sendable, Equatable, Hashable {
    public var path: String
    public var tools: [String]
    public var count: Int

    public var id: String { path }

    public init(path: String, tools: [String], count: Int) {
        self.path = path
        self.tools = tools
        self.count = count
    }

    public func relativePath(to root: URL?) -> String {
        guard let root else { return path }
        let rootPath = root.standardizedFileURL.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
    }
}
