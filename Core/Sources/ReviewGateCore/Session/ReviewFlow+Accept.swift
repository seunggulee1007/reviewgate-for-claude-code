import Foundation

// MARK: r2-review-flow — reviewing without extra clicks or modal stops (release 2) on the Mac: the rules both the views and
// the tests read.
// · M28: "Accept all" applies at once with an undo toast — the summary sheet only for files not looked at or sensitive; the
//   commit sheet takes pending files too ("검토 완료로 표시하고 커밋"); "push after commit" is kept per project.

// MARK: - M28 accept and commit in one action

public enum AcceptAllRules {
    /// The summary sheet opens only when a pending file was never looked at, changed since it was, or is sensitive (agent
    /// configuration, workflow, env); otherwise "Accept all" applies at once with an undo toast.
    public static func needsSheet(unviewed: Int, changedSinceViewed: Int, sensitive: Int) -> Bool {
        unviewed + changedSinceViewed + sensitive > 0
    }

    /// The toast after an accept that can be undone: "파일 3개를 수락했어요".
    public static func acceptedToast(_ count: Int) -> String {
        String(localized: "Accepted \(count) files", bundle: .module)
    }

    /// The toast's button.
    public static var undoTitle: String { String(localized: "Undo", bundle: .module) }
}

public enum CommitAcceptRules {
    /// The ticked files still pending: accepted first by "검토 완료로 표시하고 커밋" (accepting writes nothing).
    public static func toAccept(ticked: Set<String>, files: [ChangedFile]) -> [String] {
        files.filter { $0.state == .pending && ticked.contains($0.path) && $0.ignored == false && $0.tooLarge == false }.map(\.path)
    }

    /// The files the sheet lists: accepted (committable) first, then pending ones (gitignored and too-large ones never commit).
    public static func listed(committable: [String], files: [ChangedFile]) -> [String] {
        let pending = files.filter { $0.state == .pending && !$0.ignored && !$0.tooLarge }.map(\.path)
        return committable + pending.filter { !committable.contains($0) }
    }
}

extension AppSettings {
    /// M28: "push after commit", kept per project (the global `commitPushByDefault` until the user chose here).
    public static func commitPush(root: String, defaults: UserDefaults = .standard) -> Bool {
        let key = "commitPush.\(root)"
        return defaults.object(forKey: key) == nil ? commitPushByDefault(defaults: defaults) : defaults.bool(forKey: key)
    }

    public static func setCommitPush(_ on: Bool, root: String, defaults: UserDefaults = .standard) {
        defaults.set(on, forKey: "commitPush.\(root)")
    }
}

// MARK: - M28 accept all at once, undone from its toast

extension AppState {
    /// Whether "Accept all" opens its summary sheet first (a pending file not looked at, changed since, or sensitive).
    public var acceptAllNeedsSheet: Bool {
        AcceptAllRules.needsSheet(unviewed: neverViewedPendingFiles.count, changedSinceViewed: changedSinceViewedPendingFiles.count,
                                  sensitive: pendingFiles.filter { AppState.isSensitivePath($0.path) }.count)
    }

    /// "Accept all" at once: accepts every pending file and returns their paths — what the toast's undo puts back — or nil when
    /// nothing was accepted (no pending file, or accepting waits: the reason is an error row as before).
    @discardableResult
    public func acceptAllNow() -> [String]? {
        let paths = pendingFiles.map(\.path)
        guard !paths.isEmpty, !acceptLockedNotice() else { return nil }
        fireReviewAction(.acceptAll)
        return paths
    }

    /// The toast's undo: `paths` that are still accepted are pending again (the engine takes it during a turn on a standing
    /// review too, M28); nothing on disk changes.
    public func unaccept(paths: [String]) {
        let accepted = Set(changedFiles.filter { $0.state == .accepted }.map(\.path))
        let targets = paths.filter(accepted.contains)
        guard !targets.isEmpty else { return }
        fireReviewAction(.unaccept(paths: targets))
    }
}

// MARK: - M28 the commit sheet accepts as it commits

extension AppState {
    /// The commit sheet can open: something to commit — accepted files, or pending ones it accepts as it commits — and nothing
    /// holds a commit (a turn, its collection, a revert, a failed collection).
    public var canOpenCommitSheet: Bool {
        projectInfo != nil && commitLockReason == nil
            && (canCommit || !CommitAcceptRules.listed(committable: [], files: changedFiles).isEmpty)
    }

    /// "검토 완료로 표시하고 커밋": accepts `paths` (pending ticked files) and waits for the engine, so the commit that follows
    /// finds them accepted. False when the engine refused (the reason is in `lastError`).
    public func acceptForCommit(_ paths: [String]) async -> Bool {
        guard !paths.isEmpty else { return true }
        do {
            try await request(.accept(paths: paths))
            await settle()
            return true
        } catch {
            lastError = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
            return false
        }
    }
}
