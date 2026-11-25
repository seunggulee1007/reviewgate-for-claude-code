import Foundation

// MARK: git-sync — docs/PROTOCOL.md §68: Fetch and Pull where the branch is shown (the branch menu and its chip),
// ahead / behind, why each is off, and what the last one came to. The automatic fetch (§68.4) runs when the project opens
// and when the window comes back to the front, unless turned off in Settings › Git.

/// What the last Fetch / Pull the user asked for came to: a line under the branch chip until dismissed or the next one.
public struct GitSyncNotice: Equatable, Sendable {
    public enum Kind: Sendable, Equatable { case success, info, error }

    public var kind: Kind
    public var text: String
    /// The files a refused pull would have replaced (`pull_would_overwrite`), or those a pull changed (≤ 200).
    public var paths: [String]

    public init(kind: Kind, text: String, paths: [String] = []) {
        self.kind = kind
        self.text = text
        self.paths = paths
    }
}

/// The words of §68: refusals, blockers and outcomes.
public enum GitSyncText {
    /// The §68 refusal codes (`EngineMessages.refusal` asks here first); nil for any other code.
    static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "pull_blocked": return blockedText(detail)
        case "pull_no_upstream":
            return detail.isEmpty ? String(localized: "This branch has no upstream — push it first (git push -u) to pull into it", bundle: .module)
                : String(localized: "\(detail) has no upstream — push it first (git push -u) to pull into it", bundle: .module)
        case "pull_in_progress":
            return String(localized: "A \(operationName(detail)) is in progress — finish or abort it in a terminal, then pull", bundle: .module)
        case "pull_diverged":
            let counts = detail.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
            if counts.count == 2 {
                return String(localized: "This branch and its upstream have diverged (\(counts[0]) local, \(counts[1]) incoming commits) — a fast-forward is not possible. Rebase onto the upstream, or merge in a terminal.", bundle: .module)
            }
            return String(localized: "This branch and its upstream have diverged — a fast-forward is not possible. Rebase onto the upstream, or merge in a terminal.", bundle: .module)
        case "pull_would_overwrite":
            let files = unbrokenPaths(detail)
            return String(localized: "Pull would overwrite your uncommitted changes: \(files) — commit them (or finish their review) first. Nothing was changed.", bundle: .module)
        case "pull_rebase_blocked":
            return detail == "review" ? String(localized: "Finish the review before rebasing — a rebase rewrites the files under review", bundle: .module)
                : String(localized: "Commit your changes before rebasing", bundle: .module)
        case "pull_rebase_failed":
            return String(localized: "The rebase stopped and was undone — nothing changed: \(detail)", bundle: .module)
        case "pull_failed": return String(localized: "Pull failed: \(detail)", bundle: .module)
        case "fetch_failed":
            return detail.isEmpty ? String(localized: "Fetch failed", bundle: .module) : String(localized: "Fetch failed: \(detail)", bundle: .module)
        case "invalid_extra":   // §68.5: a file outside the review that is not one any more (in the review now, or unchanged)
            return String(localized: "\(detail) is no longer a change outside the review — reopen the commit sheet", bundle: .module)
        default: return nil
        }
    }

    /// A list of paths ("src/cart.ts, README.md") whose names never break across lines: a word joiner (U+2060) after each
    /// "/", ".", "-" and "_" inside a path, so a line ends only between two paths ("src/cart.\nts" read as two names).
    public static func unbrokenPaths(_ list: String) -> String {
        list.components(separatedBy: ", ").map { path in
            var out = ""
            for (i, ch) in path.enumerated() {
                out.append(ch)
                if "/.-_".contains(ch), i < path.count - 1 { out.append("\u{2060}") }
            }
            return out
        }.joined(separator: ", ")
    }

    static func blockedText(_ kind: String) -> String {
        switch kind {
        case "running": String(localized: "Claude is working — pull when the turn ends", bundle: .module)
        case "busy": String(localized: "A fetch or pull is already running", bundle: .module)
        case "detached": String(localized: "Check out a branch first (HEAD is detached)", bundle: .module)
        default: String(localized: "Pull is not possible right now", bundle: .module)
        }
    }

    /// `merge` → "merge", `cherry-pick` → "cherry-pick": git's words, kept in English.
    static func operationName(_ raw: String) -> String {
        switch raw {
        case "rebase": "rebase"
        case "cherry-pick": "cherry-pick"
        case "revert": "revert"
        default: "merge"
        }
    }

    /// Why Pull is off (the menu item's tooltip).
    public static func pullBlocker(_ blocker: PullBlocker) -> String {
        switch blocker {
        case .running: blockedText("running")
        case .busy: blockedText("busy")
        case .detached: blockedText("detached")
        case .noUpstream: String(localized: "This branch has no upstream — push it first (git push -u) to pull into it", bundle: .module)
        case .operation(let op): String(localized: "A \(operationName(op.rawValue)) is in progress — finish or abort it in a terminal, then pull", bundle: .module)
        }
    }

    /// Why "Rebase onto <upstream>" is off for the same blockers as Pull — in its own words: the rebase is what waits.
    public static func rebaseBlocker(_ blocker: PullBlocker) -> String {
        switch blocker {
        case .running: String(localized: "Claude is working — rebase when the turn ends", bundle: .module)
        case .busy: blockedText("busy")
        case .detached: String(localized: "Check out a branch to rebase it (HEAD is detached)", bundle: .module)
        case .noUpstream: String(localized: "This branch has no upstream to rebase onto", bundle: .module)
        case .operation(let op): String(localized: "A \(operationName(op.rawValue)) is in progress — finish or abort it in a terminal, then rebase", bundle: .module)
        }
    }

    /// Why Fetch is off.
    public static func fetchBlocker(_ blocker: FetchBlocker) -> String {
        switch blocker {
        case .noRemote: String(localized: "The repository has no remote", bundle: .module)
        case .busy: blockedText("busy")
        }
    }

    /// "Pulled 3 commits from origin/main · 5 files" / "Already up to date with origin/main" / "Rebased onto origin/main".
    public static func pulled(_ reply: PulledReply) -> String {
        switch reply.mode {
        case .upToDate: return String(localized: "Already up to date with \(reply.upstream)", bundle: .module)
        case .fastForward:
            return String(localized: "Pulled \(reply.commits) commit(s) from \(reply.upstream) · \(reply.fileCount) file(s) changed", bundle: .module)
        case .rebase:
            return String(localized: "Rebased onto \(reply.upstream): \(reply.commits) incoming commit(s) · \(reply.fileCount) file(s) changed", bundle: .module)
        }
    }

    /// After a manual fetch: "Fetched origin — 2 incoming commits" / "Fetched origin — up to date".
    public static func fetched(_ reply: FetchedReply) -> String {
        let remotes = reply.remotes.joined(separator: ", ")
        if let behind = reply.behind, behind > 0 { return String(localized: "Fetched \(remotes) — \(behind) incoming commit(s) to pull", bundle: .module) }
        if reply.behind == nil { return String(localized: "Fetched \(remotes)", bundle: .module) }
        return String(localized: "Fetched \(remotes) — up to date", bundle: .module)
    }

    /// "Fetched 3 min ago" — the branch menu's quiet footer; nil before the first fetch.
    public static func lastFetched(_ iso: String?, now: Date = Date()) -> String? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let iso, let date = fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        if minutes < 1 { return String(localized: "Fetched just now", bundle: .module) }
        if minutes < 60 { return String(localized: "Fetched \(minutes) min ago", bundle: .module) }
        return String(localized: "Fetched \(minutes / 60) h ago", bundle: .module)
    }
}

/// Pure rules of the branch menu's sync items (testable without an engine).
public enum GitSyncRules {
    /// Why Pull is off: the engine's blocker, else nil. A folder without git / an older engine: nil (the item is hidden).
    public static func pullDisabledReason(sync: GitSyncState?) -> String? {
        guard let sync else { return nil }
        if sync.isBusy { return GitSyncText.pullBlocker(.busy) }
        return sync.pullBlocker.map(GitSyncText.pullBlocker)
    }

    public static func fetchDisabledReason(sync: GitSyncState?) -> String? {
        guard let sync else { return nil }
        if sync.isBusy { return GitSyncText.fetchBlocker(.busy) }
        return sync.fetchBlocker.map(GitSyncText.fetchBlocker)
    }

    /// The branch has commits the upstream lacks and the other way round: Pull refuses, "Rebase onto upstream" is offered.
    public static func isDiverged(_ branch: BranchInfo?) -> Bool {
        guard let branch, branch.upstream != nil else { return false }
        return branch.ahead > 0 && branch.behind > 0
    }

    /// Why "Rebase onto <upstream>" is off (§68.3): Pull's blockers in a rebase's words, then files under review, then
    /// uncommitted changes.
    public static func rebaseDisabledReason(sync: GitSyncState?, reviewFiles: Int, worktreeDirty: Bool) -> String? {
        if let sync {
            if sync.isBusy { return GitSyncText.rebaseBlocker(.busy) }
            if let blocker = sync.pullBlocker { return GitSyncText.rebaseBlocker(blocker) }
        }
        if reviewFiles > 0 { return String(localized: "Finish the review before rebasing — a rebase rewrites the files under review", bundle: .module) }
        if worktreeDirty { return String(localized: "Commit your changes before rebasing", bundle: .module) }
        return nil
    }

    /// The chip's badge: "↑2 ↓3" (empty when level or without an upstream).
    public static func badge(_ branch: BranchInfo?) -> String {
        guard let branch, branch.upstream != nil else { return "" }
        var parts: [String] = []
        if branch.ahead > 0 { parts.append("↑\(branch.ahead)") }
        if branch.behind > 0 { parts.append("↓\(branch.behind)") }
        return parts.joined(separator: " ")
    }

    /// The badge's tooltip: "2 commits to push · 3 commits to pull from origin/main".
    public static func badgeHelp(_ branch: BranchInfo?) -> String? {
        guard let branch, let upstream = branch.upstream, branch.ahead > 0 || branch.behind > 0 else { return nil }
        var parts: [String] = []
        if branch.ahead > 0 { parts.append(String(localized: "\(branch.ahead) commit(s) to push", bundle: .module)) }
        if branch.behind > 0 { parts.append(String(localized: "\(branch.behind) commit(s) to pull", bundle: .module)) }
        return parts.joined(separator: " · ") + " — " + upstream
    }
}

extension AppState {
    /// `state.branches.sync`; nil from an older engine or in a folder without git (Fetch / Pull hidden).
    public var gitSync: GitSyncState? { isShadowProject ? nil : branchesInfo.sync }
    /// The checked-out branch's entry (its upstream, ahead and behind).
    public var currentBranch: BranchInfo? { branchesInfo.list.first { $0.isCurrent } }
    public var pullDisabledReason: String? { GitSyncRules.pullDisabledReason(sync: gitSync) }
    public var fetchDisabledReason: String? { GitSyncRules.fetchDisabledReason(sync: gitSync) }
    public var isBranchDiverged: Bool { GitSyncRules.isDiverged(currentBranch) }
    public var rebaseDisabledReason: String? {
        GitSyncRules.rebaseDisabledReason(sync: gitSync, reviewFiles: changedFiles.count, worktreeDirty: branchesInfo.switchBlocker == .dirtyWorktree)
    }

    /// §68.1 Fetch (every remote with `all`); the outcome — or the reason — becomes `gitSyncNotice`.
    public func fetch(all: Bool = false) async {
        guard gitSync != nil, fetchDisabledReason == nil else { return }
        gitSyncNotice = nil
        do {
            let reply = try await typedReply(.gitFetch(all: all))
            await settle()
            guard case let .fetched(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            gitSyncNotice = GitSyncNotice(kind: .info, text: GitSyncText.fetched(r))
        } catch {
            await settle()
            gitSyncNotice = GitSyncNotice(kind: .error, text: syncErrorText(error))
        }
    }

    /// §68.2 Pull (§68.3 with `rebase`); the outcome — or the refusal with its files — becomes `gitSyncNotice`.
    public func pull(rebase: Bool = false) async {
        guard gitSync != nil, pullDisabledReason == nil else { return }
        gitSyncNotice = nil
        do {
            let reply = try await typedReply(.gitPull(rebase: rebase))
            await settle()
            guard case let .pulled(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            gitSyncNotice = GitSyncNotice(kind: r.mode == .upToDate ? .info : .success, text: GitSyncText.pulled(r), paths: r.files)
        } catch {
            await settle()
            let paths: [String]
            if case let .refused(_, _, refusedPaths, _)? = error as? EngineClientError { paths = refusedPaths } else { paths = [] }
            gitSyncNotice = GitSyncNotice(kind: .error, text: syncErrorText(error), paths: paths)
        }
    }

    /// §68.4: the quiet fetch on open / window focus — the engine throttles it; nothing is shown either way.
    public func autoFetch() async {
        guard gitSync != nil, AppSettings.autoFetch(defaults: defaults) else { return }
        _ = try? await typedReply(.gitFetch(auto: true))
    }

    public func dismissGitSyncNotice() { gitSyncNotice = nil }

    private func syncErrorText(_ error: Error) -> String {
        if case let .refused(message, code, paths, _)? = error as? EngineClientError {
            return EngineMessages.refusal(code: code, error: message, paths: paths)
        }
        return error.localizedDescription
    }
}

extension AppSettings {
    /// §68.4: the quiet fetch when a project opens and when its window comes to the front (default on).
    public static func autoFetch(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.autoFetch) == nil ? true : defaults.bool(forKey: Key.autoFetch)
    }
}
