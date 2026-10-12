import Foundation

// MARK: wave4c w4c-review — docs/PROTOCOL.md §41.3 "Review leftovers": the requests the diff panes make. Pure reads — none
// changes the review, the selection or the cached diffs.

/// A `select_file {ignoreWhitespace}` reply: the `-w` diff of a range (read-only — its hunks are not the review's).
public struct WhitespaceIgnoredDiff: Sendable, Equatable {
    public var diff: FileDiff
    public var truncated: Bool
    /// The B it was computed for.
    public var endTree: String?

    public init(diff: FileDiff, truncated: Bool, endTree: String?) {
        self.diff = diff
        self.truncated = truncated
        self.endTree = endTree
    }
}

/// The engine answered a `-w` request with the normal diff (an engine before §41.3).
public struct WhitespaceUnsupported: LocalizedError {
    public var errorDescription: String? { String(localized: "This engine cannot ignore whitespace — update ReviewGate", bundle: .module) }
}

extension AppState {
    /// §41.3 "Show 20 more lines" in a past round's diff: the new side `history_diff` diffs to.
    public func historyFileLines(entryId: String, path: String) async throws -> FileLinesReply {
        let reply = try await typedReply(.historyFileLines(entryId: entryId, path: path))
        guard case let .fileLines(lines) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return lines
    }

    /// §41.3: `file`'s diff over its current range with whitespace ignored.
    public func whitespaceIgnoredDiff(for file: ChangedFile) async throws -> WhitespaceIgnoredDiff {
        let reply = try await typedReply(.selectFileIgnoringWhitespace(path: file.path, since: diffSince(for: file).wire))
        guard case let .fileDiff(_, _, _, diff, truncated, endTree, info) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        guard info.ignoreWhitespace else { throw WhitespaceUnsupported() }
        return WhitespaceIgnoredDiff(diff: diff, truncated: truncated, endTree: endTree)
    }

    /// §41.3: a changed image of the review before (A) and after (the review's B).
    public func fileImage(for file: ChangedFile) async throws -> FileImageReply {
        let reply = try await typedReply(.fileImage(path: file.path))
        guard case let .fileImage(image) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return image
    }
}
