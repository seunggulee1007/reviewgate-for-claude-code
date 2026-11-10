import Foundation

// MARK: polish p-foundation — P2-review-19 / P2-review-22: the diff's view switches, kept across files, tabs and launches
// like "줄바꿈" already was, and shared by the View menu and the diff header.
//
//   @AppStorage(DiffPrefsKeys.showFullFile) private var showFullFile = false
//   @AppStorage(DiffPrefsKeys.ignoreWhitespace) private var ignoreWhitespace = false

enum DiffPrefsKeys {
    /// "전체 파일 보기" (Bool, default off).
    static let showFullFile = "diffShowFullFile"
    /// "공백 무시" (Bool, default off).
    static let ignoreWhitespace = "diffIgnoreWhitespace"
    /// "줄바꿈" (Bool, default on) — the key the diff already uses.
    static let wrapLines = DiffCodeMetrics.wrapLinesKey
}
