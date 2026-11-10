import Foundation

// MARK: wave4b w4b-bigturn
// docs/PROTOCOL.md §39.1: the storage notices of this window, retry_save, history_cleanup and settings.largeFileMB.

public extension AppState {
    /// The save-failure banner (nil: nothing failing, or closed for this run of failures).
    var saveFailureNotice: SaveFailure? { StorageNotices.saveFailure(storage, dismissedSince: dismissedSaveFailureSince) }

    /// The HUD's disk chip (below 2 GB free).
    var diskChip: DiskSpace? { StorageNotices.diskChip(storage) }

    /// The one critical-disk banner (below 1 GB free).
    var diskCriticalNotice: DiskSpace? { StorageNotices.diskCritical(storage, dismissed: diskCriticalDismissed) }

    /// §39.1: the files of the review whose content was never captured because of their size.
    var largeFiles: [ChangedFile] { changedFiles.filter(\.tooLarge) }

    /// §39.1 (robustness-10 ②): more than `FolderFold.bulkThreshold` files make a bulk change.
    var isBulkChange: Bool { FolderFold.isBulk(changedFiles.count) }

    /// The review list's sections: as `changedFileSections`, and for a bulk change each one split by folder
    /// (`FolderFold.fold` of its paths; a section keeps its order inside each folder).
    /// `keep` (wave4b integration: the §39.3 author filter) narrows a bulk list before it folds, so each folder's
    /// "<folder>/ N" counts the files it opens to and a folder with none of them is not listed; the ordinary sections stay
    /// whole (the list filters their rows, the header keeps the group's count — as Electron's group header).
    func listSections(riskOrder: Bool, keep: ((ChangedFile) -> Bool)? = nil) -> [ChangedFileSection] {
        let sections = changedFileSections(riskOrder: riskOrder)
        guard isBulkChange else { return sections }
        return sections.flatMap { section -> [ChangedFileSection] in
            let files = keep.map { section.files.filter($0) } ?? section.files
            var folderOf: [String: String] = [:]
            let groups = FolderFold.fold(files.map(\.path))
            for g in groups { for p in g.paths { folderOf[p] = g.folder } }
            return groups.map { g in
                var s = ChangedFileSection(kind: section.kind, files: files.filter { folderOf[$0.path] == g.folder })
                s.folder = g.folder
                return s
            }
        }
    }

    func dismissSaveFailure() {
        dismissedSaveFailureSince = state.storage?.saveFailed?.since
    }

    func dismissDiskCritical() {
        diskCriticalDismissed = true
    }

    /// [다시 시도]: the engine saves again; the banner goes with the failure (or stays when it still fails).
    func retrySave() {
        guard !isRetryingSave else { return }
        isRetryingSave = true
        Task {
            defer { isRetryingSave = false }
            try? await request(.retrySave)
        }
    }

    /// §39.1 Settings › [오래된 리뷰 기록 정리]: counts first (`apply` false), removes with `apply`.
    func historyCleanup(keep: Int = AppSettings.defaultCleanupKeep, apply: Bool) async throws -> HistoryCleanupReply {
        let reply = try await reply(.historyCleanup(keep: keep, apply: apply))
        guard case let .historyCleanup(result) = reply else { throw EngineClientError.stopped }
        return result
    }

    /// Settings › the large-file limit: `set_settings {largeFileMB}` (live: the next snapshot uses it).
    func pushLargeFileMB() {
        guard state.seq > 0 || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.largeFileMB = AppSettings.largeFileMB(defaults: settingsDefaults)
        fire(.setSettings(settings))
    }
}
