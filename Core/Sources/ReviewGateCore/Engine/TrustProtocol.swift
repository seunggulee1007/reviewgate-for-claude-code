import Foundation

// MARK: wave4c w4c-trust
// docs/PROTOCOL.md §41.2: trusted auto-accept and undoing a reject on the wire — `changedFiles[].autoAccepted`,
// `turn_summary.autoAccepted`, `gate.rejectUndo`, `state.autoAcceptRules`, `ReviewHistoryFile.autoAccepted` and the
// commands `set_auto_accept` / `auto_accept_undo` / `reject_undo`. Every field is lenient: an older engine sends none
// (nothing is auto-accepted, no undo banner) and a malformed one is dropped instead of failing the snapshot.

/// §41.2: the rules a repository turned on (each off unless `true`).
public struct AutoAcceptRules: Codable, Sendable, Hashable {
    public var whitespace: Bool
    public var lockfile: Bool
    public var tests: Bool

    public init(whitespace: Bool = false, lockfile: Bool = false, tests: Bool = false) {
        self.whitespace = whitespace
        self.lockfile = lockfile
        self.tests = tests
    }

    public static let none = AutoAcceptRules()

    public func isOn(_ rule: AutoAcceptRule) -> Bool {
        switch rule {
        case .whitespace: whitespace
        case .lockfile: lockfile
        case .tests: tests
        }
    }

    public func with(_ rule: AutoAcceptRule, on: Bool) -> AutoAcceptRules {
        var next = self
        switch rule {
        case .whitespace: next.whitespace = on
        case .lockfile: next.lockfile = on
        case .tests: next.tests = on
        }
        return next
    }

    private enum CodingKeys: String, CodingKey { case whitespace, lockfile, tests }

    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        whitespace = (try? c?.decodeIfPresent(Bool.self, forKey: .whitespace)) == true
        lockfile = (try? c?.decodeIfPresent(Bool.self, forKey: .lockfile)) == true
        tests = (try? c?.decodeIfPresent(Bool.self, forKey: .tests)) == true
    }

    /// Only the rules that are on (`set_auto_accept {rules}`: a rule left out is off).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if whitespace { try c.encode(true, forKey: .whitespace) }
        if lockfile { try c.encode(true, forKey: .lockfile) }
        if tests { try c.encode(true, forKey: .tests) }
    }
}

/// §41.2: the rule names (settings order). A rule a newer engine names that this client does not know stays a raw string.
public enum AutoAcceptRule: String, Sendable, CaseIterable, Hashable {
    case whitespace, lockfile, tests
}

/// §41.2 `turn_summary.autoAccepted[]`.
public struct AutoAcceptedFile: Sendable, Hashable, Decodable {
    public var path: String
    public var rule: String

    public init(path: String, rule: String) {
        self.path = path
        self.rule = rule
    }
}

/// §41.2 `state.gate.rejectUndo`: the last single-file reject while [거절 취소] can put it back.
public struct RejectUndoInfo: Codable, Sendable, Hashable {
    public var path: String
    public var oldPath: String?
    public var status: String
    public var available: Bool
    /// `changed_on_disk` / `review_changed` (an unknown one reads as "the review changed").
    public var reason: String?

    public init(path: String, oldPath: String? = nil, status: String = "M", available: Bool = true, reason: String? = nil) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.available = available
        self.reason = reason
    }
}

enum TrustWire {
    private enum FileKeys: String, CodingKey { case autoAccepted }
    private enum GateKeys: String, CodingKey { case rejectUndo }

    /// `changedFiles[].autoAccepted` / `ReviewHistoryFile.autoAccepted` (nil: accepted by the user, or an older engine).
    static func autoAccepted(from decoder: Decoder) -> String? {
        guard let c = try? decoder.container(keyedBy: FileKeys.self) else { return nil }
        let rule = (try? c.decodeIfPresent(String.self, forKey: .autoAccepted)) ?? nil
        return rule?.isEmpty == false ? rule : nil
    }

    /// `turn_summary.autoAccepted` (entries without a path dropped).
    static func summaryAutoAccepted(from decoder: Decoder) -> [AutoAcceptedFile] {
        guard let c = try? decoder.container(keyedBy: FileKeys.self),
              let list = (try? c.decodeIfPresent([LenientAutoAccepted].self, forKey: .autoAccepted)) ?? nil else { return [] }
        return list.compactMap(\.value)
    }

    static func rejectUndo(from decoder: Decoder) -> RejectUndoInfo? {
        guard let c = try? decoder.container(keyedBy: GateKeys.self) else { return nil }
        return (try? c.decodeIfPresent(RejectUndoInfo.self, forKey: .rejectUndo)) ?? nil
    }

    private struct LenientAutoAccepted: Decodable {
        var value: AutoAcceptedFile?
        private enum Keys: String, CodingKey { case path, rule }
        init(from decoder: Decoder) throws {
            let c = try? decoder.container(keyedBy: Keys.self)
            let path = (try? c?.decodeIfPresent(String.self, forKey: .path)) ?? nil
            let rule = (try? c?.decodeIfPresent(String.self, forKey: .rule)) ?? nil
            value = path.flatMap { $0.isEmpty ? nil : AutoAcceptedFile(path: $0, rule: rule ?? "") }
        }
    }
}
