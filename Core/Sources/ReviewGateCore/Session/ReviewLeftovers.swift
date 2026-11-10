import Foundation

// MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3 "Review leftovers", the client rules (the same as Electron
// `renderer/reviewLeftovers.ts`, tested with the same cases): which past / PR diffs offer "Show 20 more lines", the
// whitespace-ignoring view's words, the chat search's three lines per chat with "N건 더", which files get an image preview,
// and the full-file view's in-line change marks (the review diff's own segments, placed on the full file's rows).

public enum ReviewLeftovers {
    // MARK: "Show 20 more lines" in the history and PR diffs

    /// A history file (`M` / `R` …): only a modified or renamed text file has unchanged lines around its hunks.
    public static func historyOffersContext(status: ChangeStatus, isBinary: Bool) -> Bool {
        !isBinary && (status == .modified || status == .renamed)
    }

    /// A PR file's GitHub status: modified / renamed / changed (an added file is all diff, a removed one has no new side).
    public static func prOffersContext(status: String, isBinary: Bool) -> Bool {
        !isBinary && ["modified", "renamed", "changed"].contains(status)
    }

    /// Why `file_lines` gave no lines; nil when it did.
    public static func unavailable(_ reply: FileLinesReply) -> String? {
        if reply.isBinary || reply.isTooLarge { return String(localized: "More lines are not available: the file is too large or binary", bundle: .module) }
        return nil
    }

    // MARK: The whitespace-ignoring view

    /// What the view turns off, in one line (part revert, line / part side questions, notes).
    public static var whitespaceViewNote: String {
        String(localized: "Ignoring whitespace: reverting parts and side questions on lines work in the normal view", bundle: .module)
    }

    /// The body of a `-w` diff without hunks.
    public static func whitespaceEmptyText(whitespaceOnly: Bool) -> String {
        whitespaceOnly ? String(localized: "Only whitespace changed — ignoring it, nothing is left", bundle: .module)
            : String(localized: "No changes once whitespace is ignored", bundle: .module)
    }

    // MARK: The chat search

    /// Matches asked per chat (`transcript_search.perChat`).
    public static let searchPerChat = 3

    /// A chat's lines to show (its newest match first, at most three) and how many more matched ("N건 더").
    public static func matchHits(_ m: TranscriptSearchMatch) -> (hits: [TranscriptSearchHit], more: Int) {
        let first = TranscriptSearchHit(row: m.row, turn: m.turn, at: m.at, isUser: m.isUser, line: m.line)
        let hits = Array(([first] + m.more).prefix(searchPerChat))
        let total = m.total.map { max($0, hits.count) } ?? hits.count
        return (hits, total - hits.count)
    }

    // MARK: Grouping the list by cause

    /// The "원인별" section of a changed file (its header, also its key): the subagent that changed it ("◆ executor", the
    /// §39.3 author rule), else the Bash command whose post-Bash snapshot saw it ("Bash · ./gradlew spotlessApply"; "Bash"
    /// when the call is not in the rows), else the turn its reason is from ("턴 3"), else the main agent ("메인").
    public static func fileCause(_ file: ChangedFile, index: TranscriptIndex, agents: [AgentNode] = []) -> String {
        if let agent = AgentGlance.fileAuthors(file.toolUseIds, index: index, agents: agents).first(where: { $0.agentToolUseId != nil }) {
            return "◆ \(agent.label)"
        }
        if file.origin == .bash {
            for id in file.toolUseIds.reversed() {
                guard let call = index.calls[id], call.name == "Bash", let command = call.input["command"]?.stringValue else { continue }
                return "Bash · \(shortCommand(command))"
            }
            return "Bash"
        }
        // MARK: r2-skills-side — §31.1 (M35): a skill's own work — "/acme-verify" for a slash command's !`command` lines,
        // "Skill · acme-verify" for a Skill call ("Skill" when the call is not in the rows).
        if file.origin == .skill {
            for id in file.toolUseIds.reversed() {
                if let command = SkillCause.command(of: id), index.calls[id] == nil { return "/\(command)" }
                guard let call = index.calls[id], call.name == "Skill",
                      let name = call.input["skill"]?.stringValue ?? call.input["command"]?.stringValue, !name.isEmpty else { continue }
                return "Skill · \(name)"
            }
            return "Skill"
        }
        if let turn = file.why?.turn, turn > 0 { return String(localized: "Turn \(turn)", bundle: .module) }
        return String(localized: "Main", bundle: .module)
    }

    /// A command's first line, whitespace folded, 60 characters + "…".
    public static func shortCommand(_ command: String) -> String {
        let first = command.split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init) ?? ""
        let line = first.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return line.count > 60 ? "\(line.prefix(60))…" : line
    }

    // MARK: Image previews

    /// A png / jpg / gif path (`file_image` answers these).
    public static func isPreviewImage(_ path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif"].contains(ext)
    }
}

/// The changed parts of one full-file row (§34.7 segments of the review diff's line it shows).
public struct LineEmphasis: Sendable, Equatable {
    public var text: String
    public var segments: [DiffSegment]
    public var wsOnly: Bool

    public init(text: String, segments: [DiffSegment], wsOnly: Bool = false) {
        self.text = text
        self.segments = segments
        self.wsOnly = wsOnly
    }

    /// The row as a `DiffLine` with the marks — only when its text is still the diff line's (else plain).
    public func line(id: Int, kind: DiffLineKind, newNo: Int?, text shown: String) -> DiffLine {
        guard shown == text || shown == text.trimmingCharacters(in: CharacterSet(charactersIn: "\r")) else {
            return DiffLine(id: id, kind: kind, oldNo: nil, newNo: newNo, text: shown)
        }
        return DiffLine(id: id, kind: kind, oldNo: nil, newNo: newNo, text: shown, segments: segments, wsOnly: wsOnly)
    }
}

/// Where the review diff's in-line marks land in the full-file view: added lines by their new number, deleted lines by
/// the new line they follow (0 = before line 1) in order — the keys `full_file_content.deletedAfterNewLine` uses
/// (engine `deriveFullFile`).
public struct FullFileEmphasis: Sendable, Equatable {
    public var added: [Int: LineEmphasis] = [:]
    public var deleted: [Int: [LineEmphasis]] = [:]

    public init() {}

    public init(diff: FileDiff) {
        guard !diff.isBinary else { return }
        for hunk in diff.hunks {
            var lastNew = (HunkRange(header: hunk.header)?.newStart ?? 1) - 1
            for line in hunk.lines {
                switch line.kind {
                case .add:
                    if let n = line.newNo {
                        if !line.segments.isEmpty || line.wsOnly { added[n] = LineEmphasis(text: line.text, segments: line.segments, wsOnly: line.wsOnly) }
                        lastNew = n
                    }
                case .context:
                    if let n = line.newNo { lastNew = n }
                case .del:
                    deleted[max(0, lastNew), default: []].append(LineEmphasis(text: line.text, segments: line.segments, wsOnly: line.wsOnly))
                case .hunkHeader:
                    break
                }
            }
        }
    }

    /// The mark of the `offset`-th line deleted after new line `anchor` (nil: none, or no segments).
    public func deletedLine(anchor: Int, offset: Int) -> LineEmphasis? {
        guard let list = deleted[anchor], list.indices.contains(offset) else { return nil }
        let e = list[offset]
        return e.segments.isEmpty && !e.wsOnly ? nil : e
    }
}
