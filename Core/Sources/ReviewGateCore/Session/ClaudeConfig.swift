import Foundation
import Observation

// MARK: wave4d w4d-config — docs/PROTOCOL.md §42.3: MCP servers (which file defines them, a choice for every worktree,
// the login) and Claude's instructions (CLAUDE.md, memory, subagents): the wire types, their words and the CLAUDE.md
// editor's logic. The engine decides (origin, kind, what may be saved); this file only words and drives it.

// MARK: - Wire types

/// `McpServerInfo.origin`: the file that defines a server and whether ReviewGate can remove it there.
public struct McpServerOrigin: Sendable, Equatable, Decodable {
    public enum Place: String, Sendable, Equatable { case project, parent, home }

    /// Absolute: a `.mcp.json` of the project or of a folder above it, or the user's `.claude.json`.
    public var file: String?
    public var place: Place?
    public var removable: Bool
    /// plugin / claude_ai / managed / not_found / read_only / unknown.
    public var reason: String?
    /// What removes it in a terminal when ReviewGate cannot.
    public var command: String?

    public init(file: String? = nil, place: Place? = nil, removable: Bool = true, reason: String? = nil, command: String? = nil) {
        self.file = file
        self.place = place
        self.removable = removable
        self.reason = reason
        self.command = command
    }

    private enum CodingKeys: String, CodingKey { case file, place, removable, reason, command }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(file: lenientValue(String.self, c, .file),
                  place: lenientValue(String.self, c, .place).flatMap(Place.init(rawValue:)),
                  removable: lenientValue(Bool.self, c, .removable) ?? false,
                  reason: lenientValue(String.self, c, .reason),
                  command: lenientValue(String.self, c, .command))
    }
}

extension McpServerInfo {
    private enum OriginKeys: String, CodingKey { case origin, disabledIn, authWaiting }

    /// Called at the end of `init(from:)`.
    mutating func decodeOriginFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: OriginKeys.self) else { return }
        origin = lenientValue(McpServerOrigin.self, c, .origin)
        disabledIn = lenientValue(String.self, c, .disabledIn)
        authWaiting = lenientValue(Bool.self, c, .authWaiting) ?? false
    }

    /// The scope `mcp_remove` takes; nil when the engine says it cannot be removed where it is defined, or its source never can.
    public var removeScope: McpScope? {
        if let origin, !origin.removable { return nil }
        return source.removableScope
    }

    /// Defined in a `.mcp.json` above the project (every project under that folder uses it).
    public var isFromParentFolder: Bool { origin?.place == .parent && origin?.file != nil }

    /// Off by the repository's choice (every worktree), not this worktree's.
    public var isOffForRepository: Bool { isOff && disabledIn == "repository" }
}

/// `SessionExtensions.projectInstructions`: the project's CLAUDE.md / CLAUDE.local.md, existing or not.
public struct ProjectInstructionFile: Sendable, Equatable, Decodable, Identifiable {
    public var id: String { path }
    public var path: String
    public var relPath: String
    /// "project" / "local".
    public var kind: String
    public var exists: Bool

    public init(path: String, relPath: String, kind: String, exists: Bool) {
        self.path = path
        self.relPath = relPath
        self.kind = kind
        self.exists = exists
    }
}

/// `SessionExtensions.agents`: a subagent Claude can start.
public struct SubagentInfo: Sendable, Equatable, Decodable, Identifiable {
    public var id: String { name }
    public var name: String
    public var description: String
    public var model: String?
    /// "project" / "user" / "plugin"; nil = built in or defined elsewhere.
    public var source: String?
    /// Its definition file when found.
    public var path: String?

    public init(name: String, description: String = "", model: String? = nil, source: String? = nil, path: String? = nil) {
        self.name = name
        self.description = description
        self.model = model
        self.source = source
        self.path = path
    }

    private enum CodingKeys: String, CodingKey { case name, description, model, source, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(name: try c.decode(String.self, forKey: .name),
                  description: lenientValue(String.self, c, .description) ?? "",
                  model: lenientValue(String.self, c, .model),
                  source: lenientValue(String.self, c, .source),
                  path: lenientValue(String.self, c, .path))
    }
}

extension SessionExtensions {
    private enum InstructionKeys: String, CodingKey { case projectInstructions, agents }

    /// Called at the end of `init(from:)`.
    mutating func decodeInstructionFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: InstructionKeys.self) else { return }
        if c.contains(.projectInstructions) { projectInstructions = lenientElements(ProjectInstructionFile.self, c, .projectInstructions) }
        if c.contains(.agents) { agents = lenientElements(SubagentInfo.self, c, .agents).filter { !$0.name.isEmpty } }
    }
}

/// Reply to `claude_md_read` / `claude_md_write`: the file as it is on disk now.
public struct ClaudeMdReply: Sendable, Equatable, Decodable {
    public var id: String?
    public var path: String
    public var relPath: String
    public var kind: String
    public var text: String
    /// nil = the file does not exist yet.
    public var sha: String?
    public var exists: Bool
    public var saved: Bool

    public init(id: String? = nil, path: String, relPath: String, kind: String = "project", text: String = "", sha: String? = nil, exists: Bool = false, saved: Bool = false) {
        self.id = id
        self.path = path
        self.relPath = relPath
        self.kind = kind
        self.text = text
        self.sha = sha
        self.exists = exists
        self.saved = saved
    }

    private enum CodingKeys: String, CodingKey { case id, path, relPath, kind, text, sha, exists, saved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id),
                  path: lenientValue(String.self, c, .path) ?? "",
                  relPath: lenientValue(String.self, c, .relPath) ?? "",
                  kind: lenientValue(String.self, c, .kind) ?? "project",
                  text: lenientValue(String.self, c, .text) ?? "",
                  sha: lenientValue(String.self, c, .sha),
                  exists: lenientValue(Bool.self, c, .exists) ?? false,
                  saved: lenientValue(Bool.self, c, .saved) ?? false)
    }
}

/// What an instruction file is (`MemoryFile.kind`), and so when Claude reads it.
public enum InstructionKind: String, Sendable, Equatable, CaseIterable {
    case user, project, local, parent, nested, rules, autoMemory = "auto_memory", managed, other

    public init(lenient raw: String?) {
        self = raw.flatMap(InstructionKind.init(rawValue:)) ?? .other
    }
}

// MARK: - Words

public enum InstructionText {
    public static func title(_ kind: InstructionKind) -> String {
        switch kind {
        case .user: String(localized: "User", bundle: .module)
        case .project: String(localized: "Project", bundle: .module)
        case .local: String(localized: "Local (only me)", bundle: .module)
        case .parent: String(localized: "Parent folder", bundle: .module)
        case .nested: String(localized: "Subfolder", bundle: .module)
        case .rules: String(localized: "Rules", bundle: .module)
        case .autoMemory: String(localized: "Auto memory", bundle: .module)
        case .managed: String(localized: "Managed", bundle: .module)
        case .other: String(localized: "Other", bundle: .module)
        }
    }

    /// When Claude reads a file of this kind.
    public static func whenRead(_ kind: InstructionKind) -> String {
        switch kind {
        case .user: String(localized: "Read at the start of every conversation, in every project", bundle: .module)
        case .project: String(localized: "Read at the start of every conversation in this project — shared through git", bundle: .module)
        case .local: String(localized: "Read at the start of every conversation in this project — only you, not in git", bundle: .module)
        case .parent: String(localized: "Read at the start of every conversation in the projects under that folder", bundle: .module)
        case .nested: String(localized: "Read when Claude works with files in that folder", bundle: .module)
        case .rules: String(localized: "Read at the start of a conversation — a rule with paths when Claude works with those files", bundle: .module)
        case .autoMemory: String(localized: "Claude's own notes for this project — read at the start of every conversation", bundle: .module)
        case .managed: String(localized: "Set by your organization — read in every conversation", bundle: .module)
        case .other: String(localized: "Loaded by Claude Code", bundle: .module)
        }
    }

    /// The editor's note on when a saved change takes effect.
    public static var appliesNextSession: String {
        String(localized: "Claude reads the change from the next session — restart to use it now", bundle: .module)
    }

    /// Opened in the system's default app: only Markdown files that exist (never something that would run).
    public static func canOpen(_ path: String?) -> Bool {
        guard let path, !path.isEmpty else { return false }
        let ext = (path as NSString).pathExtension.lowercased()
        guard ext == "md" || ext == "markdown" else { return false }
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
    }

    /// A refusal of `claude_md_read` / `claude_md_write` in the user's words.
    public static func refusal(code: String?, fallback: String) -> String {
        switch code {
        case "claude_md_changed": String(localized: "The file changed since you opened it (in an editor or by Claude) — reload it and make your change again", bundle: .module)
        case "session_busy": String(localized: "Claude is working — save once the turn has ended", bundle: .module)
        case "in_review": String(localized: "This file is in the open review — finish its review first", bundle: .module)
        case "collect_failed": String(localized: "Collecting this turn's changes failed. Retry it first.", bundle: .module)
        case "too_large": String(localized: "The file is too large to edit here — open it in an editor", bundle: .module)
        case "invalid_path": String(localized: "Only this project's CLAUDE.md files can be edited here", bundle: .module)
        case "unknown_command": SessionToolsSupport.updateReason
        default: fallback
        }
    }

    /// The subagent's source in words.
    public static func agentSource(_ source: String?) -> String {
        switch source {
        case "project": String(localized: "Project", bundle: .module)
        case "user": String(localized: "User", bundle: .module)
        case "plugin": String(localized: "Plugin", bundle: .module)
        default: String(localized: "Built in", bundle: .module)
        }
    }
}

public enum McpOriginText {
    /// `~/…` for a path in the home folder.
    public static func abbreviate(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    /// The row's "defined in" line; nil without an origin file.
    public static func line(_ server: McpServerInfo) -> String? {
        guard let origin = server.origin, let file = origin.file else { return nil }
        let shown = abbreviate(file)
        switch origin.place {
        case .parent: return String(localized: "Defined in \(shown) — a folder above this project; every project under it uses it", bundle: .module)
        default: return String(localized: "Defined in \(shown)", bundle: .module)
        }
    }

    /// Removing a parent folder's server: what it changes. nil for the other servers (McpText's words).
    public static func removeExplanation(_ server: McpServerInfo) -> String? {
        guard server.isFromParentFolder, server.removeScope != nil, let file = server.origin?.file else { return nil }
        return String(localized: "Removes “\(server.name)” from \(abbreviate(file)) — a folder above this project, so every project and workbench under it loses it.", bundle: .module)
    }

    /// Why ReviewGate cannot remove it; nil when it can.
    public static func notRemovable(_ server: McpServerInfo) -> String? {
        guard let origin = server.origin, !origin.removable else { return nil }
        switch origin.reason {
        case "plugin": return String(localized: "It comes from a plugin — turn the plugin off in Plugins instead", bundle: .module)
        case "claude_ai": return String(localized: "It comes from your claude.ai connectors — change it on claude.ai", bundle: .module)
        case "managed": return String(localized: "Your organization manages it — it cannot be removed", bundle: .module)
        case "not_found": return String(localized: "ReviewGate could not find which .mcp.json defines it", bundle: .module)
        case "read_only": return String(localized: "ReviewGate cannot change \(abbreviate(origin.file ?? ""))", bundle: .module)
        default: return String(localized: "ReviewGate does not know where it is defined", bundle: .module)
        }
    }

    /// The terminal command, when there is one.
    public static func terminalHint(_ server: McpServerInfo) -> String? {
        guard let command = server.origin?.command, !command.isEmpty, !(server.origin?.removable ?? true) else { return nil }
        return String(localized: "In Terminal: \(command)", bundle: .module)
    }

    /// The off chip of a server the repository's choice turned off.
    public static var offEverywhere: String { String(localized: "Off in every workbench", bundle: .module) }

    /// The login banner once the terminal is open.
    public static var waitingForLogin: String {
        String(localized: "Log in in Terminal — ReviewGate reconnects the server once the login took. Not yet? Reconnect.", bundle: .module)
    }
}

// MARK: - The CLAUDE.md editor

/// One row of the save confirmation's diff: unchanged context, a removed / added line, or a fold of unchanged lines.
public struct InstructionDiffLine: Sendable, Equatable, Identifiable {
    public var id: Int
    public var kind: DiffLineKind
    public var text: String
    /// `.hunkHeader` rows: how many unchanged lines it folds.
    public var folded: Int
}

public enum InstructionDiff {
    static func split(_ s: String) -> [String] {
        guard !s.isEmpty else { return [] }
        var lines = s.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    /// old → new by line (Myers via `CollectionDifference`), `context` unchanged lines kept around each change and longer
    /// unchanged runs folded into one row.
    public static func lines(old: String, new: String, context: Int = 3) -> [InstructionDiffLine] {
        let a = split(old), b = split(new)
        var removed = Set<Int>(), inserted = Set<Int>()
        for change in b.difference(from: a) {
            switch change {
            case let .remove(offset, _, _): removed.insert(offset)
            case let .insert(offset, _, _): inserted.insert(offset)
            }
        }
        var rows: [(DiffLineKind, String)] = []
        var i = 0, j = 0
        while i < a.count || j < b.count {
            if i < a.count, removed.contains(i) {
                rows.append((.del, a[i])); i += 1
            } else if j < b.count, inserted.contains(j) {
                rows.append((.add, b[j])); j += 1
            } else if i < a.count, j < b.count {
                rows.append((.context, a[i])); i += 1; j += 1
            } else {
                break
            }
        }
        let changed = rows.indices.filter { rows[$0].0 != .context }
        guard !changed.isEmpty else { return [] }
        var keep = Set<Int>()
        for k in changed { for n in max(0, k - context)...min(rows.count - 1, k + context) { keep.insert(n) } }
        var out: [InstructionDiffLine] = []
        var run = 0
        func flush() {
            if run > 0 { out.append(InstructionDiffLine(id: out.count, kind: .hunkHeader, text: "", folded: run)) }
            run = 0
        }
        for (n, row) in rows.enumerated() {
            if keep.contains(n) {
                flush()
                out.append(InstructionDiffLine(id: out.count, kind: row.0, text: row.1, folded: 0))
            } else {
                run += 1
            }
        }
        flush()
        return out
    }

    public static func counts(_ lines: [InstructionDiffLine]) -> (added: Int, removed: Int) {
        (lines.filter { $0.kind == .add }.count, lines.filter { $0.kind == .del }.count)
    }
}

/// The in-app CLAUDE.md editor: read, edit, confirm the diff, save over what was read. Owned by the sheet.
@MainActor
@Observable
public final class InstructionEditor {
    public enum Phase: Equatable, Sendable { case loading, editing, confirming, saving, saved, failed }

    /// The request path (project-relative or absolute).
    public let path: String
    public private(set) var file: ClaudeMdReply?
    public var text = ""
    public private(set) var phase: Phase = .loading
    public private(set) var errorText: String?
    /// The file changed since it was read: the editor offers to reload.
    public private(set) var stale = false
    @ObservationIgnored private weak var app: AppState?
    /// Test seam: answers the requests instead of the engine.
    @ObservationIgnored var send: ((EngineCommand) async throws -> EngineEvent)?

    public init(app: AppState?, path: String) {
        self.app = app
        self.path = path
    }

    public var hasChanges: Bool { file.map { $0.text != text } ?? false }
    public var diff: [InstructionDiffLine] { InstructionDiff.lines(old: file?.text ?? "", new: text) }
    /// The file that is edited (absolute) once read.
    public var displayPath: String { file.map { McpOriginText.abbreviate($0.path) } ?? path }

    private func request(_ command: EngineCommand) async throws -> EngineEvent {
        if let send { return try await send(command) }
        guard let app else { throw EngineClientError.stopped }
        return try await app.reply(command)
    }

    public func load() async {
        phase = .loading
        errorText = nil
        stale = false
        do {
            guard case let .claudeMd(reply) = try await request(.claudeMdRead(path: path)) else { throw EngineClientError.stopped }
            file = reply
            text = reply.text
            phase = .editing
        } catch {
            errorText = message(error)
            phase = .failed
        }
    }

    /// Editing → the diff to confirm (nothing to confirm without a change).
    public func confirm() {
        guard phase == .editing, hasChanges else { return }
        phase = .confirming
    }

    public func backToEditing() {
        if phase == .confirming || phase == .failed, file != nil { phase = .editing }
    }

    /// Saves the confirmed text; true when it was written.
    @discardableResult
    public func save() async -> Bool {
        guard phase == .confirming, let file else { return false }
        phase = .saving
        errorText = nil
        do {
            guard case let .claudeMd(reply) = try await request(.claudeMdWrite(path: file.relPath.isEmpty ? path : file.relPath, text: text, baseSha: file.sha)) else {
                throw EngineClientError.stopped
            }
            self.file = reply
            text = reply.text
            phase = .saved
            return true
        } catch {
            stale = (error as? EngineClientError)?.refusalCode == "claude_md_changed"
            errorText = message(error)
            phase = .confirming
            return false
        }
    }

    private func message(_ error: Error) -> String {
        let fallback = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        return InstructionText.refusal(code: (error as? EngineClientError)?.refusalCode, fallback: fallback)
    }
}
