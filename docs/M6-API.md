# M6 Core API contract (for the App UI agent)

> **Superseded (M9).** Historical contract kept for reference only; the live contract is `docs/PROTOCOL.md` (protocol v2) and `docs/M9-ENGINE.md`. The Swift types/APIs named below were deleted in M9 step 4.

```swift
// Session/SessionStore.swift (additions)
public var reviewCollectFailed: String?          // non-nil => gate stays closed; UI shows error + Retry
public func retryCollectReview()                  // re-runs finishTurn collection
public var projectInfo: ProjectInfo?              // set after openProject
public struct ProjectInfo: Sendable { public let root: String; public let branch: String?; public let remoteURL: String? }
public var gitCandidates: [URL]                   // when needsGitInit: immediate subfolders that are git repos (max depth 1, sorted), possibly empty
public var gitInitLooksUnsafe: Bool               // true when folder is $HOME, ~/Desktop, ~/Documents, ~/Downloads, "/" or has > 200 entries
public func openProject(_ url: URL)               // existing; now also records into AppSettings.recentProjects

// Session/AppSettings.swift (additions)
public static func recentProjects(defaults:) -> [URL]      // most recent first, max 10
public static func addRecentProject(_ url: URL, defaults:)
public static func removeRecentProject(_ url: URL, defaults:)

// PR/GHAuth.swift (new)
public struct GHAccount: Sendable, Identifiable { public var id: String { host }; public let host: String; public let login: String?; public let ok: Bool; public let detail: String }  // detail = raw status lines for that host
public enum GHAuth { public static func status(ghPath: String, env: [String:String]) async -> [GHAccount] }   // uses `gh auth status --json hosts` (supported in 2.92; see docs/gh-auth-status.json for the real shape) — never throws
public static func loginCommand(host: String) -> String     // "gh auth login --hostname H --web"

// PR/PRStore.swift (additions)
public var accounts: [GHAccount]; public func refreshAccounts() async
public var reviews: [PRReview]                    // loaded with detail/files/comments in open(); refreshed after submit
public var lastSubmitResult: SubmitResult?        // set after submit(); UI shows banner
public struct SubmitResult: Sendable { public let reviewURL: String; public let inlineCount: Int; public let event: ReviewEvent; public let submittedAt: Date }
public func openLoginInTerminal(host: String)     // runs `osascript` to open Terminal.app with the login command
```
