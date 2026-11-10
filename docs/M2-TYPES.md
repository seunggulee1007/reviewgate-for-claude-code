# M2 shared types (Core/Sources/ReviewGateCore) — contract between Git/Diff logic and UI

> **Superseded (M9).** Historical contract kept for reference only; the live contract is `docs/PROTOCOL.md` (protocol v2) and `docs/M9-ENGINE.md`. The Swift types/APIs named below were deleted in M9 step 4.

```swift
// Diff/DiffModels.swift
public enum DiffLineKind: Sendable { case context, add, del, hunkHeader }
public struct DiffLine: Identifiable, Sendable, Hashable {
    public let id: Int              // index within FileDiff.allLines
    public let kind: DiffLineKind
    public let oldNo: Int?          // nil for add / hunkHeader
    public let newNo: Int?          // nil for del / hunkHeader
    public let text: String         // without leading +/-/space
}
public struct DiffHunk: Identifiable, Sendable { public let id: Int; public let header: String; public let lines: [DiffLine] }
public struct FileDiff: Sendable {
    public let oldPath: String?; public let newPath: String?
    public let isBinary: Bool
    public let hunks: [DiffHunk]
    public var allLines: [DiffLine] { hunks.flatMap(\.lines) }   // hunkHeader lines included
}
// Diff/UnifiedDiffParser.swift
public enum UnifiedDiffParser { public static func parse(_ patch: String) -> FileDiff }   // single-file patch (from diff-tree -p -- path or gh pulls/N/files[].patch)

// Git/GitCheckpoint.swift
public enum ChangeStatus: String, Sendable { case added = "A", modified = "M", deleted = "D", renamed = "R", other = "X" }
public enum ReviewState: Sendable { case pending, accepted, rejected }
public struct ChangedFile: Identifiable, Sendable, Hashable {
    public var id: String { path }
    public let path: String          // repo-root-relative (new path for renames)
    public let oldPath: String?      // renames
    public let status: ChangeStatus
    public let added: Int, deleted: Int
    public let isBinary: Bool
    public var tools: [String]       // from turn_end.toolFiles; empty => "via Bash"
    public var state: ReviewState
}
public struct GitCheckpoint: Sendable {
    public let root: String                                   // git toplevel
    public static func open(directory: String) async throws -> GitCheckpoint   // throws GitError.notARepository
    public static func initRepository(at: String) async throws
    public func snapshot() async throws -> String             // tree SHA via temp index
    public func changes(from a: String, to b: String) async throws -> [ChangedFile]
    public func patch(from a: String, to b: String, path: String) async throws -> String   // single-file unified patch
    public func revert(_ file: ChangedFile, to a: String) async throws
}
```

SessionStore additions (M2):
- `checkpoint: GitCheckpoint?`, `turnStartTree: String?`, `turnEndTree: String?`
- `changedFiles: [ChangedFile]`, `selectedFile: ChangedFile?`, `selectedDiff: FileDiff?` (lazy loaded on selection)
- `pendingFiles: [ChangedFile]` (state == .pending); `canSend = session open && !isRunning && pendingFiles.isEmpty`
- `accept(_:)`, `reject(_:)` (revert on disk, re-snapshot turnEndTree, drop from list), `acceptAll()`, `rejectAll()`
- Next `send(text)` prefixes `[Review gate] Accepted: a, b. Rejected (reverted on disk, do not redo unless asked): c.\n\n` when lastReviewSummary exists, then clears it.
