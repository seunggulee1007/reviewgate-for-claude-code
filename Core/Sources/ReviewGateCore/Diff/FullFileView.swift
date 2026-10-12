import Foundation

/// The whole new content of a changed file plus where this turn's diff touched it (`full_file_content`,
/// docs/PROTOCOL.md). Derived by the engine (`engine/src/diff/fullfile.ts`); line numbers are 1-based and
/// refer to `lines`.
public struct FullFileView: Sendable, Equatable {
    public let path: String
    /// Empty when `isBinary` or `isTooLarge`.
    public let lines: [String]
    public let changedNewLines: Set<Int>
    /// Deleted old lines, keyed by the new line number they follow (0 = before the first line).
    public let deletedAfterNewLine: [Int: [String]]
    public let isBinary: Bool
    /// More than `maxLines` lines or `maxBytes` bytes.
    public let isTooLarge: Bool
    // MARK: wave2 contract — docs/PROTOCOL.md §34.1–34.2
    /// The range `changedNewLines` / `deletedAfterNewLine` describe (nil = `review`).
    public var since: DiffSince?
    /// Served while a turn runs: the content is the held B's (read-only).
    public var stale = false
    /// The B the content and the changed lines belong to.
    public var endTree: String?

    public init(path: String, lines: [String], changedNewLines: Set<Int>, deletedAfterNewLine: [Int: [String]],
                isBinary: Bool, isTooLarge: Bool) {
        self.path = path
        self.lines = lines
        self.changedNewLines = changedNewLines
        self.deletedAfterNewLine = deletedAfterNewLine
        self.isBinary = isBinary
        self.isTooLarge = isTooLarge
    }
}

/// Wire form (`full_file_content`): `changedNewLines` as an array, `deletedAfterNewLine` keyed by strings.
extension FullFileView: Decodable {
    private enum CodingKeys: String, CodingKey { case path, lines, changedNewLines, deletedAfterNewLine, isBinary, isTooLarge, since, stale, endTree }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var deleted: [Int: [String]] = [:]
        for (key, lines) in try c.decodeIfPresent([String: [String]].self, forKey: .deletedAfterNewLine) ?? [:] {
            if let n = Int(key) { deleted[n] = lines }
        }
        self.init(path: try c.decode(String.self, forKey: .path),
                  lines: try c.decodeIfPresent([String].self, forKey: .lines) ?? [],
                  changedNewLines: Set(try c.decodeIfPresent([Int].self, forKey: .changedNewLines) ?? []),
                  deletedAfterNewLine: deleted,
                  isBinary: try c.decodeIfPresent(Bool.self, forKey: .isBinary) ?? false,
                  isTooLarge: try c.decodeIfPresent(Bool.self, forKey: .isTooLarge) ?? false)
        since = DiffSince(lenient: lenientValue(String.self, c, .since))   // wave2 contract
        stale = lenientValue(Bool.self, c, .stale) ?? false
        endTree = lenientValue(String.self, c, .endTree)
    }
}

// MARK: wave7 w7-state — §45.2: the full file's rows, one per List row

/// One row of the full-file view: a line of the file, or an old line deleted after new line `anchor` (0: before line 1).
public enum FullFileRow: Hashable, Sendable {
    case line(Int)
    case deleted(anchor: Int, offset: Int)
}

extension FullFileView {
    /// Every row in display order: the deleted lines before line 1, then each line followed by the ones deleted after it.
    public var rows: [FullFileRow] {
        var out: [FullFileRow] = []
        out.reserveCapacity(lines.count + deletedAfterNewLine.values.reduce(0) { $0 + $1.count })
        func deleted(_ anchor: Int) {
            for offset in (deletedAfterNewLine[anchor] ?? []).indices { out.append(.deleted(anchor: anchor, offset: offset)) }
        }
        deleted(0)
        for index in lines.indices {
            out.append(.line(index + 1))
            deleted(index + 1)
        }
        return out
    }
}

public enum FullFileViewError: Error, LocalizedError, Sendable {
    case noReview

    public var errorDescription: String? {
        String(localized: "No turn diff to show", bundle: .module)
    }
}
