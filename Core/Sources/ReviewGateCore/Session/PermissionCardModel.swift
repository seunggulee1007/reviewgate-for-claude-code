import Foundation

// wave1 mac-perms — what a permission card shows and offers (docs/PROTOCOL.md §33, client handoff §2.1 / §2.8), as pure
// functions the views and the tests share.

// MARK: - Which answers a card offers

/// The controls a permission card offers for `request`.
public struct PermissionCardOptions: Sendable, Equatable {
    public enum Layout: Sendable, Equatable {
        case standard
        /// §33.2: SendMessage — the receiving session, the summary and the body; only [보내기] / [거절].
        case sendMessage
    }

    public var layout: Layout
    /// "세션 동안 허용" (⌥⌘↩): never for a request with a `reason`, SendMessage or a question.
    public var allowsRemember: Bool
    /// What "이 프로젝트에서 항상 허용" can store, most specific first: the engine's `allowPatterns`, or for Bash the
    /// program + subcommand pattern the client derives (`Bash(npm test:*)`). Empty for a request with a `reason`.
    public var alwaysAllowPatterns: [String]
    /// The "always allow" control is shown: Bash (disabled with the reason when no safe pattern exists) or any request
    /// with patterns. Hidden for a request with a `reason`.
    public var showsAlwaysAllow: Bool

    public init(request: PermissionRequest) {
        if request.toolName == "SendMessage" {
            layout = .sendMessage
            allowsRemember = false
            alwaysAllowPatterns = []
            showsAlwaysAllow = false
            return
        }
        layout = .standard
        guard request.reason == nil, request.toolName != AskUserQuestions.toolName else {
            allowsRemember = false
            alwaysAllowPatterns = []
            showsAlwaysAllow = false
            return
        }
        allowsRemember = true
        let isBash = request.toolName == "Bash"
        if !request.allowPatterns.isEmpty {
            alwaysAllowPatterns = request.allowPatterns
        } else if isBash, let pattern = request.input["command"]?.stringValue.flatMap(BashAllowPattern.derive) {
            alwaysAllowPatterns = [pattern]
        } else {
            alwaysAllowPatterns = []
        }
        showsAlwaysAllow = isBash || !alwaysAllowPatterns.isEmpty
    }
}

// MARK: wave2 check-clients
extension PermissionCardOptions {
    /// The risk line under the call: never on a SendMessage card, and next to a §33.3 `reason` only with a real risk — an
    /// all-clear line under "outside this window's review" would say the opposite of the warning above it.
    public static func showsRiskLine(_ request: PermissionRequest, risk: CommandRisk) -> Bool {
        guard request.toolName != "SendMessage" else { return false }
        return request.reason == nil || !risk.isEmpty
    }
}

/// §33.2: what a SendMessage card shows.
public struct SendMessageCardContent: Sendable, Equatable {
    /// The receiving session / agent name (`input.to`, older shapes `recipient`).
    public var to: String?
    public var summary: String?
    public var message: String
    /// wave2 check-clients: `message` is a protocol message (an object), shown as JSON.
    public var isStructured = false
    // MARK: wave4d w4d-peers
    /// §42.2: the live session `to` names (the engine's registry lookup); nil for an agent / teammate name or an older engine.
    public var toSession: PeerSessionInfo?

    public init(request: PermissionRequest) {
        toSession = request.toSession // MARK: wave4d w4d-peers
        func text(_ key: String) -> String? {
            guard let value = request.input[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return value
        }
        to = text("to") ?? text("recipient")
        summary = text("summary")
        if let plain = request.input["message"]?.stringValue ?? request.input["content"]?.stringValue {
            message = plain
        } else if let value = request.input["message"], value != .null {
            // A protocol message (a teammate's shutdown / plan approval, …): what goes out, as JSON.
            message = value.prettyPrinted
            isStructured = true
        } else {
            message = ""
        }
    }
}

// MARK: - Words

/// "이 프로젝트에서 항상 허용 ▾" entries: `mcp__a__b` → "이 도구만 (b)", `mcp__a__*` / `mcp__a` → "a 서버 전체",
/// `WebFetch(domain:x)` → "이 도메인 (x)"; any other pattern as written.
public enum AllowPatternLabel {
    public enum Kind: Sendable, Equatable {
        case bash, mcpTool, mcpServer, webFetchDomain, other
    }

    public static func kind(_ pattern: String) -> Kind {
        if pattern == "Bash" || pattern.hasPrefix("Bash(") { return .bash }
        if let mcp = mcpParts(pattern) { return mcp.tool == nil ? .mcpServer : .mcpTool }
        if domain(pattern) != nil { return .webFetchDomain }
        return .other
    }

    public static func text(_ pattern: String) -> String {
        if let mcp = mcpParts(pattern) {
            guard let tool = mcp.tool else { return String(localized: "The whole \(mcp.server) server", bundle: .module) }
            return String(localized: "Only this tool (\(tool))", bundle: .module)
        }
        if let host = domain(pattern) { return String(localized: "This domain (\(host))", bundle: .module) }
        return pattern
    }

    /// `mcp__<server>__<tool>` (the CLI's naming; the server part may hold `_` / `-` but not `__`); `tool` nil for the
    /// whole server (`mcp__srv`, `mcp__srv__*`).
    static func mcpParts(_ pattern: String) -> (server: String, tool: String?)? {
        guard pattern.hasPrefix("mcp__") else { return nil }
        let rest = String(pattern.dropFirst(5))
        guard !rest.isEmpty else { return nil }
        guard let sep = rest.range(of: "__") else { return (rest, nil) }
        let server = String(rest[..<sep.lowerBound])
        let tool = String(rest[sep.upperBound...])
        guard !server.isEmpty else { return nil }
        return (server, tool.isEmpty || tool == "*" ? nil : tool)
    }

    static func domain(_ pattern: String) -> String? {
        let prefix = "WebFetch(domain:"
        guard pattern.hasPrefix(prefix), pattern.hasSuffix(")") else { return nil }
        let host = String(pattern.dropFirst(prefix.count).dropLast())
        return host.isEmpty ? nil : host
    }
}

/// How strongly a card's reason line warns.
public enum PermissionWarningLevel: Sendable, Equatable {
    /// Orange: a location this window's review does not see.
    case caution
    /// Red: work leaves this window's review for good (a new worktree, an isolated agent) or cannot be reverted
    /// (Claude Code's settings files, a git commit or merge).
    case danger
}

/// §33.3 / §33.4: the card's warning line for `PermissionRequest.reason`; `{path}` is cut to its last two components.
public enum PermissionReasonText {
    public static func line(_ reason: PermissionReason) -> String {
        let path = reason.path.map(shortPath).flatMap { $0.isEmpty ? nil : $0 }
        switch reason.code {
        case .outsideProject:
            return String(localized: "Outside the project — the review does not see this file", bundle: .module)
        case .nestedRepository:
            if let path {
                return String(localized: "Inside a nested repository (submodule · worktree · clone) — the review does not see it (\(path))", bundle: .module)
            }
            return String(localized: "Inside a nested repository (submodule · worktree · clone) — the review does not see it", bundle: .module)
        case .otherWorktree:
            if let path { return String(localized: "Works in another worktree (\(path)) — this window's review does not see it", bundle: .module) }
            return String(localized: "Works in another worktree — this window's review does not see it", bundle: .module)
        case .worktreeCommand where reason.otherRepository:
            // §39.4: another repository's worktree — this chat cannot follow it there.
            if let path { return String(localized: "Creates a git worktree of another repository (\(path)) — this chat cannot move there; open that folder in ReviewGate to work there with a review", bundle: .module) }
            return String(localized: "Creates a git worktree of another repository — this chat cannot move there; open that folder in ReviewGate to work there with a review", bundle: .module)
        case .worktreeCommand:
            if let path { return String(localized: "Creates a new git worktree (\(path)) — work inside it is outside this window's review", bundle: .module) }
            return String(localized: "Creates a new git worktree — work inside it is outside this window's review", bundle: .module)
        case .worktreeIsolation:
            return String(localized: "This agent works outside this folder (an isolated worktree or similar) — its changes are not in this window's review", bundle: .module)
        case .claudeConfig:
            if let path {
                return String(localized: "Changes a Claude Code settings file (\(path)) — hooks, permissions and MCP settings change; settings.local.json is not kept in the review and cannot be reverted", bundle: .module)
            }
            return String(localized: "Changes a Claude Code settings file — hooks, permissions and MCP settings change; settings.local.json is not kept in the review and cannot be reverted", bundle: .module)
        case .gitCommand:
            return String(localized: "A git command that changes the repository (commit · merge · checkout · reset …) — what it brings in is not counted as Claude's edits, and a commit cannot be reverted from the review", bundle: .module)
        case .other:
            let message = reason.message.trimmingCharacters(in: .whitespacesAndNewlines)
            return message.isEmpty ? String(localized: "Works somewhere this window's review does not see", bundle: .module) : message
        }
    }

    public static func level(_ reason: PermissionReason) -> PermissionWarningLevel {
        switch reason.code {
        case .worktreeCommand, .worktreeIsolation, .claudeConfig, .gitCommand: .danger
        case .outsideProject, .nestedRepository, .otherWorktree, .other: .caution
        }
    }

    /// `/Users/me/repo/.claude/worktrees/wt1` → `worktrees/wt1`; a path of two components or fewer stays as it is.
    public static func shortPath(_ path: String) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count > 2 else { return parts.isEmpty ? path : parts.joined(separator: "/") }
        return parts.suffix(2).joined(separator: "/")
    }
}

/// The card's head chip: "🧩 executor · compile" for a subagent, "메인 에이전트" for the main agent.
public enum PermissionAgentLabel {
    public static func text(_ agent: PermissionAgent?) -> String {
        guard let agent else { return String(localized: "Main agent", bundle: .module) }
        let type = agent.subagentType?.trimmingCharacters(in: .whitespacesAndNewlines).permsNonEmpty
        let description = agent.description?.trimmingCharacters(in: .whitespacesAndNewlines).permsNonEmpty
        switch (type, description) {
        case let (type?, description?): return "🧩 \(type) · \(description)"
        case let (type?, nil): return "🧩 \(type)"
        case let (nil, description?): return "🧩 \(description)"
        case (nil, nil): return "🧩 " + String(localized: "Subagent", bundle: .module)
        }
    }
}

/// §29: "{fromNames} 요청" on the permission card and the HUD while an accepted peer message runs.
public enum PeerTurnText {
    public static func badge(_ turn: PeerTurnInfo) -> String {
        let names = turn.fromNames.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !names.isEmpty else { return String(localized: "Requested by another session", bundle: .module) }
        return String(localized: "Requested by \(names.joined(separator: ", "))", bundle: .module)
    }
}

/// `state.session.rememberedAllows` keys in the user's words: `Bash:npm test` → `Bash · npm test`, `WebFetch:WebFetch` → `WebFetch`.
public enum RememberedAllowText {
    public static func text(_ key: String) -> String {
        guard let colon = key.firstIndex(of: ":") else { return key }
        let tool = String(key[..<colon])
        let rest = String(key[key.index(after: colon)...])
        if rest.isEmpty || rest == tool { return tool }
        return "\(tool) · \(rest)"
    }
}

// MARK: - permission_rules (§33.8)

extension PermissionRuleScope {
    /// "사용자" / "프로젝트" / "로컬".
    public var displayName: String {
        switch self {
        case .user: String(localized: "User", bundle: .module)
        case .project: String(localized: "Project", bundle: .module)
        case .local: String(localized: "Local", bundle: .module)
        case let .other(raw): raw
        }
    }
}

extension PermissionRuleSource {
    /// "없음", "읽기 오류: …", or nil when the file was read.
    public var problemText: String? {
        if let error, !error.isEmpty { return String(localized: "Read error: \(error)", bundle: .module) }
        return exists ? nil : String(localized: "Missing", bundle: .module)
    }
}

extension UserPermissionRule {
    public var isApplied: Bool { status == .applied }

    /// "적용 중" / "적용 안 함".
    public var statusText: String {
        switch status {
        case .applied: String(localized: "Applied", bundle: .module)
        case .ignored: String(localized: "Not applied", bundle: .module)
        case let .other(raw): raw
        }
    }

    /// The why of §33.8 in the user's words.
    public var whyText: String {
        switch why {
        case .nonMutatingTool: String(localized: "Applied — a tool that cannot change files", bundle: .module)
        case .readMcpTool: String(localized: "Applied — a read-only MCP tool", bundle: .module)
        case .readMcpTools: String(localized: "Applied to its read tools only", bundle: .module)
        case .alreadyAllowed: String(localized: "Never asks anyway", bundle: .module)
        case .mutatingMcpTool: String(localized: "Not applied — an MCP tool that writes", bundle: .module)
        case .bash: String(localized: "Commands go through the review gate first — importing adds it as an app allow pattern", bundle: .module)
        case .editTool: String(localized: "Edits are always reviewed", bundle: .module)
        case .sendMessage: String(localized: "Messages to other sessions always ask", bundle: .module)
        case .unsupported: String(localized: "Not a supported form", bundle: .module)
        case .invalid: String(localized: "Not a valid rule", bundle: .module)
        case .rulesOff: String(localized: "Applying the terminal's rules is off", bundle: .module)
        case .userSettingsOff: String(localized: "Loading user settings is off", bundle: .module)
        case .localSettingsOff: String(localized: "Loading local settings is off", bundle: .module)
        case let .other(raw): raw
        }
    }

    /// A rule to look at twice before importing it (the warning icon): see `PermissionRuleRisk`.
    public var importIsRisky: Bool { importAs.map(PermissionRuleRisk.isRisky) ?? false }
}

/// Bash allow rules worth a second look before they become app patterns: commands that delete, rewrite git history,
/// reach the network or run other commands, and whole-program wildcards over powerful tools (`Bash(git:*)`, bare `Bash`).
public enum PermissionRuleRisk {
    static let powerful: Set<String> = ["git", "docker", "podman", "kubectl", "helm", "gh", "aws", "gcloud", "az", "terraform",
                                        "mv", "cp", "chmod", "chown", "dd", "rsync", "scp"]

    public static func isRisky(_ pattern: String) -> Bool {
        let trimmed = pattern.trimmingCharacters(in: .whitespaces)
        if trimmed == "Bash" || trimmed == "Bash(*)" || trimmed == "Bash(:*)" { return true }
        guard trimmed.hasPrefix("Bash("), trimmed.hasSuffix(")") else { return false }
        var inner = String(trimmed.dropFirst(5).dropLast()).trimmingCharacters(in: .whitespaces)
        var wildcard = false
        if inner.hasSuffix(":*") {
            inner = String(inner.dropLast(2))
            wildcard = true
        } else if inner.hasSuffix(" *") || inner.hasSuffix("*") {
            inner = String(inner.dropLast()).trimmingCharacters(in: .whitespaces)
            wildcard = true
        }
        let words = inner.split(separator: " ").map(String.init)
        guard let first = words.first else { return true }
        let program = (first as NSString).lastPathComponent
        if BashAllowPattern.refused.contains(program) { return true }
        if !CommandRisk.assessBash(inner, projectRoot: nil).isEmpty { return true }
        return wildcard && words.count == 1 && powerful.contains(program)
    }
}

private extension String {
    var permsNonEmpty: String? { isEmpty ? nil : self }
}
