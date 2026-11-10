import Foundation

// MARK: wave4c w4c-commit
// docs/PROTOCOL.md §41.1 on the Mac (the same rules as Electron's `commitFormat.ts`): the commit sheet's "팀 형식: …" line
// from `commit_format`, the PR sheet's metadata kept per repository and `gh`'s readiness in words, the chat's "대화를
// 줄였어요" line of a compacted turn and /clear's meaning in the palette. Kept free of SwiftUI so they are tested.

public enum TeamFormat {
    /// `{issue}`: the reply's issue when it is for this branch, else the branch's longest run of digits (the engine's rule
    /// without the subjects; `feature/PAY-1800-2` → `1800`).
    public static func issue(branch: String?, reply: CommitFormatReply?) -> String {
        if let reply, reply.branch == branch { return reply.issue }
        return CommitTemplate.issue(fromBranch: branch)
    }

    /// What the draft follows: the project's template, else the learned format (first line, `{issue}` / `{branch}` filled
    /// in); nil when neither. `learned` true for the learned one.
    public static func line(template: String, branch: String?, reply: CommitFormatReply?) -> (text: String, learned: Bool)? {
        let own = template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : template
        guard let raw = own ?? reply?.learned else { return nil }
        let text = raw.replacingOccurrences(of: "{issue}", with: issue(branch: branch, reply: reply))
            .replacingOccurrences(of: "{branch}", with: branch ?? "")
        let first = text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? text
        return (first, own == nil)
    }

    /// The learned format offered in the template editor — only when it is not what is typed.
    public static func suggestion(template: String, reply: CommitFormatReply?) -> String? {
        guard let learned = reply?.learned, learned != template.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return learned
    }

    /// Why [PR 만들기] is off for `gh`; nil when it can run.
    public static func ghBlocker(_ gh: GHReadiness?, host: String?) -> String? {
        switch gh {
        case .notFound: String(localized: "GitHub CLI (gh) is not installed — install it or set its path in Settings", bundle: .module)
        case .notLoggedIn:
            if let host { String(localized: "gh is not logged in to \(host) — log in on the PR tab", bundle: .module) }
            else { String(localized: "gh is not logged in — log in on the PR tab", bundle: .module) }
        case .ok, nil: nil
        }
    }

    /// "Compacted the conversation · 16.3k → 3.7k tokens — Claude remembers what came before as a summary".
    public static func compactedLine(_ c: TurnCompaction, postTokens: Int) -> String {
        let head = c.trigger == "auto"
            ? String(localized: "The conversation got long and was compacted", bundle: .module)
            : String(localized: "Compacted the conversation", bundle: .module)
        var tokens = ""
        if let pre = c.preTokens, postTokens > 0 {
            tokens = " · " + String(localized: "\(kTokens(pre)) → \(kTokens(postTokens)) tokens", bundle: .module)
        }
        return "\(head)\(tokens) — " + String(localized: "Claude remembers what came before as a summary", bundle: .module)
    }

    static func kTokens(_ n: Int) -> String {
        n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : String(n)
    }

    /// The palette's description of /clear: the engine opens a new chat for it (§41.1).
    public static var clearDescription: String {
        String(localized: "Opens a new chat in the app — this chat stays in the list", bundle: .module)
    }
}

// MARK: - The PR sheet's metadata, per repository

/// The PR sheet's metadata as typed (comma-separated lists).
public struct PRMetaText: Codable, Sendable, Equatable {
    public var assignees: String
    public var labels: String
    public var reviewers: String
    public var projects: String

    /// The first PR of a repository is assigned to the user (`@me`).
    public static let `default` = PRMetaText(assignees: "@me", labels: "", reviewers: "", projects: "")

    public init(assignees: String, labels: String, reviewers: String, projects: String) {
        self.assignees = assignees
        self.labels = labels
        self.reviewers = reviewers
        self.projects = projects
    }

    public static func list(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// `pr_create`'s metadata.
    public var meta: PRCreateMeta {
        PRCreateMeta(assignees: Self.list(assignees), labels: Self.list(labels), reviewers: Self.list(reviewers), projects: Self.list(projects))
    }
}

public extension AppSettings.Key {
    /// wave4c w4c-commit (§41.1): JSON `[projectKey: PRMetaText]` — the metadata the last PR of the repository used.
    static let projectPRMeta = "projectPRMeta"
}

public extension AppSettings {
    static func prMeta(root: String, defaults: UserDefaults = .standard) -> PRMetaText {
        guard let data = defaults.data(forKey: Key.projectPRMeta),
              let table = try? JSONDecoder().decode([String: PRMetaText].self, from: data) else { return .default }
        return table[root] ?? .default
    }

    static func setPRMeta(_ meta: PRMetaText, root: String, defaults: UserDefaults = .standard) {
        var table = (defaults.data(forKey: Key.projectPRMeta).flatMap { try? JSONDecoder().decode([String: PRMetaText].self, from: $0) }) ?? [:]
        table[root] = meta
        if let data = try? JSONEncoder().encode(table) { defaults.set(data, forKey: Key.projectPRMeta) }
    }
}
