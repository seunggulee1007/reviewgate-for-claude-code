# M8 contract — branches, full-file view, syntax highlighting

> **Superseded (M9).** Historical contract kept for reference only; the live contract is `docs/PROTOCOL.md` (protocol v2) and `docs/M9-ENGINE.md`. The Swift types/APIs named below were deleted in M9 step 4.

## Core additions
```swift
// Git/GitBranches.swift
public struct BranchInfo: Sendable, Identifiable, Hashable { public var id: String { name }; public let name: String; public let isCurrent: Bool; public let upstream: String?; public let ahead: Int; public let behind: Int; public let lastCommitDate: Date? }
public extension GitCheckpoint {
    func branches() async throws -> [BranchInfo]                 // local branches, current first then by lastCommitDate desc
    func isWorktreeDirty() async throws -> Bool                   // git status --porcelain non-empty (respecting ignore patterns is NOT needed)
    func switchBranch(_ name: String) async throws                // git switch <name>
    func createBranch(_ name: String, from: String? = nil, checkout: Bool = true) async throws   // git switch -c <name> [from]
    func fileContent(at path: String, tree: String?) async throws -> Data   // tree nil => worktree file; else git cat-file -p <tree>:<path>
}
public enum BranchSwitchBlocker: Sendable { case pendingReview(Int), dirtyWorktree, running }

// Session/SessionStore.swift additions
public var branches: [BranchInfo]
public func refreshBranches() async
public func branchSwitchBlocker() -> BranchSwitchBlocker?       // nil => allowed
public func switchBranch(_ name: String) async                  // sets projectInfo.branch, refreshes, errors to transcript
public func createBranch(_ name: String) async
public func fullFile(for file: ChangedFile) async throws -> FullFileView   // new content (worktree) with changed line numbers

// Diff/FullFileView.swift
public struct FullFileView: Sendable { public let path: String; public let lines: [String]; public let changedNewLines: Set<Int>; public let deletedAfterNewLine: [Int: [String]] /* deleted old lines anchored after a new line no */ ; public let isBinary: Bool; public let isTooLarge: Bool /* > 20k lines or > 2MB */ }

// Diff/SyntaxHighlighter.swift (Highlightr dependency in Core/Package.swift: https://github.com/raspu/Highlightr, exact version)
public actor SyntaxHighlighter {
    public static let shared: SyntaxHighlighter
    public func language(forPath: String) -> String?              // by extension; nil => plain
    public func highlightLines(_ lines: [String], language: String?, dark: Bool) async -> [AttributedString]   // per-line highlight; falls back to plain; cached by (language, line) LRU
    public func highlightDocument(_ text: String, language: String?, dark: Bool) async -> [AttributedString]   // whole-document highlight split to lines (keeps multi-line tokens right)
}
```
Themes: light "xcode", dark "atom-one-dark" (Highlightr theme names). Font: monospaced system 12.

## App
- `App/UI/Diff/DiffRow.swift`: accepts an optional `AttributedString` for the code column (falls back to plain `Text`).
- `App/UI/Diff/DiffView.swift`: highlights `selectedDiff.allLines` via `highlightLines` off-main (Task, cancel on file change); header gains "Full file" toggle (AX id "Full file") and "Open in Editor" menu (AX id "Open in Editor": VS Code `code -g path:line`, IntelliJ IDEA `idea --line N path`, Xcode `xed -l N path`, Finder reveal; detect installed apps via `NSWorkspace.shared.urlForApplication(withBundleIdentifier:)` for com.microsoft.VSCode, com.jetbrains.intellij, com.apple.dt.Xcode; remember choice in UserDefaults `preferredEditor`).
- New `App/UI/Diff/FullFileView.swift`: read-only List of all lines with gutter, changed lines tinted green, deleted lines shown inline in red (from `deletedAfterNewLine`), auto-scroll to first change, uses `highlightDocument`.
- `App/UI/MainWindow.swift`: branch chip in the project header becomes a Menu (AX id "Branch switcher"): current ✓, other local branches (with ahead/behind), divider, "New Branch…" (sheet: name field, validation `git check-ref-format --branch`), "Refresh". Disabled items with reason when `branchSwitchBlocker()` != nil ("Review N pending files first", "Working tree has uncommitted changes", "Claude is working").
- PR diff pane (`PRDiffPane`) also uses `highlightLines` (language from `PRFile.filename`).

## Request-changes flow (turn review)
```swift
// Session/SessionStore.swift additions
public struct ReviewNote: Sendable, Identifiable, Hashable { public let id: UUID; public let path: String; public let line: Int?; public let side: DiffSide /* .old/.new */; public let excerpt: String /* the line text */; public var body: String }
public var reviewNotes: [ReviewNote]                 // notes on the CURRENT turn's diff
public func addNote(path:line:side:excerpt:body:) ; public func removeNote(id:)
public var canRequestChanges: Bool                  // !reviewNotes.isEmpty && !isRunning
public func requestChanges(extraMessage: String?)   // builds a message and sends it as the next turn:
//   "[Review gate] Requested changes on this turn's diff. Keep the other changes as they are.\n
//    - README.md:12 (new) `if (x == null)` — 여기 null 체크 빠짐\n - ...\n\n<extraMessage>"
//   Files with notes are marked .changesRequested (new ReviewState case) and are NOT reverted; after the next turn_end the review list is rebuilt from a fresh diff vs the ORIGINAL turnStartTree (so the combined result is reviewed), notes cleared.
```
- `ReviewState` gains `.changesRequested`. Gate: `canSend` stays false while pending or changesRequested files exist; `requestChanges` is the only way to send in that state (it bypasses canSend intentionally). Files accepted before requesting changes stay accepted (they're re-listed but pre-marked accepted if their diff is unchanged — compare patch hash).
- Keep `turnStartTree` across the request-changes turn (do NOT re-snapshot A), so the follow-up diff is cumulative.

## App
- `DiffView` rows: hover `+` gutter (AX "Add note") → reuse `CommentComposer` (title "Add note") → note bubble under the line (orange, delete button). Header shows note count. Sidebar row shows a note badge and "수정 요청" state glyph.
- Chat composer while gated: button "Request changes (N)" (AX "Request changes") next to Send, enabled when `canRequestChanges`; the composer text (optional) is passed as `extraMessage`.
