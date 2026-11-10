import Foundation

// MARK: wave4b w4b-bigturn
// docs/PROTOCOL.md §39.1 on the wire: `state.storage` (failing saves, the volume's free space), `changedFiles[].tooLarge`
// / `largeBytes`, the `history_cleanup` reply. Every field is lenient — an older engine sends none of them.

/// §39.1 `state.storage.saveFailed`: saves failing right now.
public struct SaveFailure: Codable, Sendable, Equatable {
    /// `review`, `history`, `checkpoints`, `transcript` (unknown kinds kept as sent).
    public var what: [String]
    /// `ENOSPC`, `EDQUOT`, `EROFS`, `EACCES`, … (nil: unknown).
    public var code: String?
    public var diskFull: Bool
    public var detail: String
    /// When this run of failures began: one banner per `since`.
    public var since: String
    public var at: String

    public init(what: [String], code: String? = nil, diskFull: Bool = false, detail: String = "", since: String, at: String = "") {
        self.what = what
        self.code = code
        self.diskFull = diskFull
        self.detail = detail
        self.since = since
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case what, code, diskFull, detail, since, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        what = lenientValue([String].self, c, .what) ?? []
        code = lenientValue(String.self, c, .code)
        diskFull = lenientValue(Bool.self, c, .diskFull) ?? false
        detail = lenientValue(String.self, c, .detail) ?? ""
        since = lenientValue(String.self, c, .since) ?? ""
        at = lenientValue(String.self, c, .at) ?? ""
    }
}

/// §39.1 `state.storage.disk`: free space of the repository's volume.
public struct DiskSpace: Codable, Sendable, Equatable {
    public enum Level: String, Codable, Sendable { case ok, low, critical }
    public var freeBytes: Int64
    public var totalBytes: Int64
    public var level: Level

    public init(freeBytes: Int64, totalBytes: Int64 = 0, level: Level) {
        self.freeBytes = freeBytes
        self.totalBytes = totalBytes
        self.level = level
    }

    private enum CodingKeys: String, CodingKey { case freeBytes, totalBytes, level }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        freeBytes = lenientValue(Int64.self, c, .freeBytes) ?? lenientValue(Double.self, c, .freeBytes).map { Int64($0) } ?? 0
        totalBytes = lenientValue(Int64.self, c, .totalBytes) ?? lenientValue(Double.self, c, .totalBytes).map { Int64($0) } ?? 0
        level = lenientValue(String.self, c, .level).flatMap(Level.init(rawValue:)) ?? .ok
    }
}

/// §39.1 `state.storage`.
public struct StorageState: Codable, Sendable, Equatable {
    public var saveFailed: SaveFailure?
    public var disk: DiskSpace?

    public init(saveFailed: SaveFailure? = nil, disk: DiskSpace? = nil) {
        self.saveFailed = saveFailed
        self.disk = disk
    }

    private enum CodingKeys: String, CodingKey { case saveFailed, disk }

    /// Never fails the snapshot: a malformed part is nil.
    public init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        saveFailed = lenientValue(SaveFailure.self, c, .saveFailed).flatMap { $0.since.isEmpty ? nil : $0 }
        disk = lenientValue(DiskSpace.self, c, .disk)
    }
}

/// §39.1: reply to `history_cleanup` — what goes (went, with `applied`).
public struct HistoryCleanupReply: Decodable, Sendable, Equatable {
    public var id: String?
    public var keep: Int
    public var rounds: Int
    public var checkpoints: Int
    public var refs: Int
    /// Loose objects only those refs keep (about what `git prune` frees); nil: not measured.
    public var bytes: Int64?
    public var kept: Int
    public var applied: Bool

    public init(id: String? = nil, keep: Int, rounds: Int, checkpoints: Int, refs: Int, bytes: Int64?, kept: Int, applied: Bool) {
        self.id = id
        self.keep = keep
        self.rounds = rounds
        self.checkpoints = checkpoints
        self.refs = refs
        self.bytes = bytes
        self.kept = kept
        self.applied = applied
    }

    private enum CodingKeys: String, CodingKey { case id, keep, rounds, checkpoints, refs, bytes, kept, applied }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = lenientValue(String.self, c, .id)
        keep = lenientValue(Int.self, c, .keep) ?? 20
        rounds = lenientValue(Int.self, c, .rounds) ?? 0
        checkpoints = lenientValue(Int.self, c, .checkpoints) ?? 0
        refs = lenientValue(Int.self, c, .refs) ?? 0
        bytes = lenientValue(Int64.self, c, .bytes) ?? lenientValue(Double.self, c, .bytes).map { Int64($0) }
        kept = lenientValue(Int.self, c, .kept) ?? 0
        applied = lenientValue(Bool.self, c, .applied) ?? false
    }

    /// Nothing to remove.
    public var isEmpty: Bool { rounds == 0 && checkpoints == 0 && refs == 0 }
}

enum BigTurnWire {
    private enum FileKeys: String, CodingKey { case tooLarge, largeBytes }

    /// `changedFiles[].tooLarge` / `largeBytes` (false / nil on an older engine).
    static func largeFile(from decoder: Decoder) -> (tooLarge: Bool, largeBytes: Int64?) {
        guard let c = try? decoder.container(keyedBy: FileKeys.self) else { return (false, nil) }
        let bytes = lenientValue(Int64.self, c, .largeBytes) ?? lenientValue(Double.self, c, .largeBytes).map { Int64($0) }
        return (lenientValue(Bool.self, c, .tooLarge) ?? false, bytes)
    }
}
