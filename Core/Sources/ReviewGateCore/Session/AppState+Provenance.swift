import Foundation

// wave1 mac-review — docs/PROTOCOL.md §31–§32 on the window's store: "Reject all" leaves the changes from outside the
// app alone and asks before reverting them, uncaptured files are never sent to a revert, the stale-review sheet and
// "Finish review", the banners' dismissal and "Add to ignore patterns".

extension AppState {
    // MARK: Counts

    /// `gate.externalPendingCount`: pending files nothing of Claude's explains — what "Reject all" leaves alone.
    public var externalPendingCount: Int { gate.externalPendingCount }

    /// The dock badge's number: the files waiting for the user minus the external ones (not Claude's work to review).
    public var dockBadgeCount: Int { max(0, pendingFiles.count + changesRequestedFiles.count - externalPendingCount) }

    /// The review list in its groups: the mods files, Claude's changes, the changes from outside the app.
    public func changedFileSections(riskOrder: Bool) -> [ChangedFileSection] {
        ChangedFileSection.build(changedFiles, riskOrder: riskOrder)
    }

    /// What "Reject all" reverts and what it leaves (the confirmation's numbers).
    public var rejectAllPlan: RejectAllPlan { RejectAllPlan(pending: pendingFiles, externalCount: externalPendingCount) }

    /// §32: accepted gitignored mods files — reviewed and accepted like any file, but not committable.
    public var ignoredAcceptedPaths: [String] { changedFiles.filter { $0.ignored && $0.state == .accepted }.map(\.path) }

    /// What the commit sheet offers: the accepted paths without the gitignored ones (the engine leaves those out of
    /// `commit.acceptedPaths` too; filtered here as well so a lagging snapshot never offers them).
    public var committablePaths: [String] {
        let ignored = Set(ignoredAcceptedPaths)
        return acceptedPaths.filter { !ignored.contains($0) }
    }

    // MARK: Reject (§31 / §32)

    /// The files `reject_all` would revert, without the uncaptured ones: those make the engine refuse the whole batch
    /// (`not_captured`), so a mix goes out as `reject {paths}` of the revertible files; nothing revertible → the refusal's
    /// text, nothing sent.
    func sendRejectAll(includeExternal: Bool) {
        let targets = pendingFiles.filter { includeExternal || !$0.isExternal }
        guard !targets.isEmpty else { return }
        let uncaptured = targets.filter(\.uncaptured)
        if uncaptured.isEmpty {
            fireReject(.rejectAll(includeExternal: includeExternal))
        } else if uncaptured.count == targets.count {
            fail(EngineMessages.refusal(code: "not_captured", error: "not_captured", paths: uncaptured.map(\.path)), fatal: false)
        } else {
            fireReject(.reject(paths: targets.filter { !$0.uncaptured }.map(\.path)))
        }
    }

    /// True when `reject(file)` must not go out now: the file was not captured (it cannot be reverted — the refusal's
    /// text is shown), or it is external (the user confirms it first, `externalRejectRequest`).
    func holdReject(of file: ChangedFile) -> Bool {
        let current = changedFiles.first { $0.path == file.path } ?? file
        if current.uncaptured {
            fail(EngineMessages.refusal(code: "not_captured", error: "not_captured", paths: [current.path]), fatal: false)
            return true
        }
        if current.isExternal {
            externalRejectRequest = ExternalRejectRequest(command: .reject(paths: [current.path]), paths: [current.path])
            return true
        }
        return false
    }

    /// The reject-all dialog's "앱 밖 변경도 되돌리기": the second confirmation with the external files listed.
    public func requestRejectAllIncludingExternal() {
        let paths = rejectAllPlan.external
        guard !paths.isEmpty else { return }
        externalRejectRequest = ExternalRejectRequest(command: .rejectAll(includeExternal: true), paths: paths)
    }

    /// The second confirmation's "되돌리기": the external file(s) are reverted too — only while they are exactly what the
    /// user was shown (another project opened or a newer snapshot meanwhile: nothing is reverted, and the user is told).
    public func confirmExternalReject() {
        guard let request = externalRejectRequest else { return }
        externalRejectRequest = nil
        let pendingExternal = Set(pendingFiles.filter(\.isExternal).map(\.path))
        let unchanged: Bool
        if case .rejectAll = request.command {
            unchanged = Set(request.paths) == pendingExternal
        } else {
            unchanged = request.paths.allSatisfy(pendingExternal.contains)
        }
        guard unchanged else {
            fail(String(localized: "The files changed meanwhile, so nothing was reverted — check the list again", bundle: .module), fatal: false)
            return
        }
        switch request.command {
        case .rejectAll:
            rejectAll(includeExternal: true)
        case let .reject(paths, _):
            if rejectLockedNotice() { return }   // wave2 mac-flow: with the turn's reason
            fireReject(.reject(paths: paths))
            // Like a plain reject: move on to the next pending file on screen right away (wave2 mac-flow, comp-10).
            if let path = paths.first, selectedPath == path, let next = pendingAfter(path) { selectFile(next) }
        default:
            break
        }
    }

    /// The second confirmation's cancel: nothing is reverted.
    public func cancelExternalReject() {
        externalRejectRequest = nil
    }

    // MARK: Finish review (§31.5)

    /// Why "Finish review" is unavailable right now; nil when it can be sent.
    public var finishReviewBlocker: String? {
        guard projectInfo != nil else { return EngineMessages.refusal(error: "no_project") }
        return FinishReviewRules.blocker(phase: gatePhase, collectError: gate.collectError,
                                         files: changedFiles.count, notes: reviewNotes.count, stale: gate.stale != nil)
    }

    public var canFinishReview: Bool { finishReviewBlocker == nil }

    /// `finish_review`: the review list and its notes go, the files stay on disk as they are (the next turn's baseline).
    /// Returns nil on success, else the refusal in the user's words (also an error row when `reportFailure`).
    @discardableResult
    public func finishReview(reportFailure: Bool = true) async -> String? {
        if let blocker = finishReviewBlocker {
            if reportFailure { fail(blocker, fatal: false) }
            return blocker
        }
        let command = EngineCommand.finishReview
        if requestSink == nil, let commandSink { commandSink(command); return nil }
        do {
            try await request(command)
            if requestSink == nil { await settle() }
            return nil
        } catch {
            let text = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
            if reportFailure { fail(text, fatal: false) }
            return text
        }
    }

    /// The stale restored review the sheet asks about ("오래된 리뷰입니다"); nil once the user chose "이어서 리뷰" for it
    /// (a snapshot still carrying the flag before the engine processed `keep_review` does not bring the sheet back).
    public var staleReview: StaleReview? {
        guard projectInfo != nil, let stale = gate.stale, !dismissedReviewNotices.contains(staleKey(stale)) else { return nil }
        return stale
    }

    private func staleKey(_ stale: StaleReview) -> String { "stale|\(noticeScope.project)|\(stale.savedAt)" }

    /// `keep_review` ("이어서 리뷰"): the stale flag goes; the review stays as it is.
    public func keepReview() {
        guard let stale = staleReview else { return }
        dismissedReviewNotices.insert(staleKey(stale))
        fire(.keepReview)
    }

    // MARK: Banners (§31–32)

    /// The project and the turn the per-turn signals belong to.
    var noticeScope: ReviewNotices.Scope {
        ReviewNotices.Scope(project: projectInfo?.root ?? projectURL?.path ?? "",
                            turn: "\(currentSessionId ?? "")#\(hudTurnCount)")
    }

    /// The banners to show: HEAD moves, other Claude sessions, settings.local.json, nested repositories, skipped files —
    /// minus the ones the user closed.
    public var reviewNotices: [ReviewNotice] {
        guard projectInfo != nil else { return [] }
        return ReviewNotices.build(gate: gate, scope: noticeScope, dismissed: dismissedReviewNotices)
    }

    public func dismissReviewNotice(_ notice: ReviewNotice) {
        dismissedReviewNotices.formUnion(notice.dismissKeys)
    }

    /// The "review restored" banner while `gate.restored` holds and the user has not closed it.
    public var restoredBanner: RestoredReviewBanner? {
        guard gate.restored, projectInfo != nil else { return nil }
        let banner = RestoredReviewBanner(id: "restored|\(noticeScope.project)|\(gate.turnEndTree ?? "")",
                                          externalCount: externalPendingCount, stale: gate.stale != nil)
        return dismissedReviewNotices.contains(banner.id) ? nil : banner
    }

    public func dismissRestoredBanner() {
        if let id = restoredBanner?.id { dismissedReviewNotices.insert(id) }
    }

    // MARK: Ignore patterns (§32 skipped files)

    /// Appends `paths` to the checkpoint ignore patterns (Settings) and pushes them to this window's engine; the caller
    /// pushes them to the other windows (`pushIgnorePatterns()`). No-op when they are all listed already.
    public func addIgnorePatterns(_ paths: [String]) {
        let key = AppSettings.Key.checkpointIgnorePatterns
        guard let text = ReviewNotices.ignorePatterns(adding: paths, to: settingsDefaults.string(forKey: key),
                                                      defaults: AppSettings.defaultIgnorePatterns) else { return }
        settingsDefaults.set(text, forKey: key)
        pushIgnorePatterns()
    }

    /// `set_settings{ignorePatterns}` with the stored list (applies from the next snapshot).
    public func pushIgnorePatterns() {
        guard isEngineRunning || commandSink != nil else { return }
        let patterns = AppSettings.ignorePatterns(defaults: settingsDefaults)
        engineIgnorePatterns = patterns   // wave2 mac-flow: what `commitIgnorePatterns()` compares with
        fire(.setSettings(EngineSettings(ignorePatterns: patterns)))
    }
}
