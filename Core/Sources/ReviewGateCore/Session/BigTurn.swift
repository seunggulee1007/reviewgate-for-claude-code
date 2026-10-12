import Foundation

// MARK: wave4b w4b-bigturn
// docs/PROTOCOL.md §39.1 (robustness-10 / robustness-11): what the clients show for big turns and a full disk — the
// save-failure banner (one per run of failures), the disk chip and its one critical banner, the large files left out of
// the review, the bulk list folded by folder, and the cleanup's confirmation. Pure: the views only draw these.

public extension AppSettings {
    /// §39.1 `settings.largeFileMB`: untracked files at least this large are stubs in snapshots (engine default 50; live).
    static let largeFileMBKey = "largeFileMB"
    static let defaultLargeFileMB = 50
    static let largeFileMBRange = 1...100_000
    /// §39.1 `history_cleanup.keep`: the review rounds and checkpoints per chat a cleanup keeps.
    static let defaultCleanupKeep = 20

    /// Unset / out of range → 50.
    static func largeFileMB(defaults: UserDefaults = .standard) -> Int {
        let raw = defaults.integer(forKey: largeFileMBKey)
        return largeFileMBRange.contains(raw) ? raw : defaultLargeFileMB
    }

    static func setLargeFileMB(_ n: Int, defaults: UserDefaults = .standard) {
        defaults.set(min(max(n, largeFileMBRange.lowerBound), largeFileMBRange.upperBound), forKey: largeFileMBKey)
    }
}

/// Which storage notices to show (§39.1). Decisions only; the window keeps what the user closed.
public enum StorageNotices {
    /// The save-failure banner: shown until closed — and never again for the same run of failures (`since`).
    public static func saveFailure(_ storage: StorageState?, dismissedSince: String?) -> SaveFailure? {
        guard let failure = storage?.saveFailed, failure.since != dismissedSince else { return nil }
        return failure
    }

    /// The HUD's disk chip: only below the low mark (2 GB), so a Mac that lives at 3–8 GB free never sees it.
    public static func diskChip(_ storage: StorageState?) -> DiskSpace? {
        guard let disk = storage?.disk, disk.level != .ok else { return nil }
        return disk
    }

    /// The one critical banner (below 1 GB) — once per window until closed.
    public static func diskCritical(_ storage: StorageState?, dismissed: Bool) -> DiskSpace? {
        guard !dismissed, let disk = storage?.disk, disk.level == .critical else { return nil }
        return disk
    }
}

public enum StorageText {
    /// "1.2 GB", "380 MB" (file-size style, the system's locale).
    public static func bytes(_ n: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: max(0, n), countStyle: .file)
    }

    /// The banner's line: what could not be saved, and why when the disk is full.
    public static func saveFailed(_ f: SaveFailure) -> String {
        if f.diskFull {
            if f.what.contains("review") { return String(localized: "The disk is full, so the review could not be saved — free some space and retry.", bundle: .module) }
            if f.what.contains("history") { return String(localized: "The disk is full, so the review history could not be saved — free some space and retry.", bundle: .module) }
            if f.what.contains("checkpoints") { return String(localized: "The disk is full, so the checkpoints could not be saved — free some space and retry.", bundle: .module) }
            return String(localized: "The disk is full, so the chat could not be saved — free some space and retry.", bundle: .module)
        }
        let code = f.code ?? "?"
        return String(localized: "Could not save the review (\(code)).", bundle: .module)
    }

    /// The HUD chip: "디스크 여유 1.2 GB".
    public static func diskChip(_ d: DiskSpace) -> String {
        String(localized: "Disk \(bytes(d.freeBytes)) free", bundle: .module)
    }

    public static func diskCritical(_ d: DiskSpace) -> String {
        String(localized: "Only \(bytes(d.freeBytes)) left on the disk — the review and its history may fail to save.", bundle: .module)
    }

    /// Above the review list.
    public static func largeFiles(_ count: Int) -> String {
        String(localized: "\(count) large file(s) kept out of snapshots (cannot be reverted)", bundle: .module)
    }

    public static func largeFileRow(_ f: ChangedFile) -> String {
        f.largeBytes.map { "\(f.path) · \(bytes($0))" } ?? f.path
    }

    public static func bulk(_ count: Int) -> String {
        String(localized: "Bulk change: \(count) files", bundle: .module)
    }

    /// The cleanup's confirmation (`apply: false` reply).
    public static func cleanupConfirm(_ r: HistoryCleanupReply) -> String {
        guard let freed = r.bytes.map(bytes) else {
            return String(localized: "Removes \(r.rounds) review round(s) and \(r.checkpoints) checkpoint(s), keeping the newest \(r.keep).", bundle: .module)
        }
        return String(localized: "Removes \(r.rounds) review round(s) and \(r.checkpoints) checkpoint(s), keeping the newest \(r.keep) — about \(freed) freed.", bundle: .module)
    }

    public static func cleanupNothing(_ r: HistoryCleanupReply) -> String {
        String(localized: "Nothing to clean up — \(r.kept) review round(s), all among the newest \(r.keep).", bundle: .module)
    }

    public static func cleanupDone(_ r: HistoryCleanupReply) -> String {
        String(localized: "Removed \(r.rounds) review round(s) and \(r.checkpoints) checkpoint(s).", bundle: .module)
    }
}

/// §39.1 (robustness-10 ②): a list of hundreds of files folds by folder. Pure, so the files pane and its "묶기 › 폴더"
/// menu use the same rule.
public enum FolderFold {
    /// More changed files than this make a bulk change: the list folds by folder.
    public static let bulkThreshold = 300
    /// At most this many folders: deeper folders are merged into their parents until it fits.
    public static let maxGroups = 40

    public static func isBulk(_ count: Int) -> Bool { count > bulkThreshold }

    public struct Group: Identifiable, Equatable, Sendable {
        /// Repo-relative folder ("" = the repository root).
        public var folder: String
        public var paths: [String]
        public var id: String { folder }
    }

    /// The folder of `path` cut to its first `depth` components ("" for a file at the root).
    public static func folder(of path: String, depth: Int) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).dropLast()
        return parts.prefix(depth).joined(separator: "/")
    }

    /// Groups by each file's own folder (`depth` = ∞).
    public static func byParent(_ paths: [String]) -> [Group] { groups(paths, depth: Int.max) }

    /// The deepest grouping (by the first d folder levels) with at most `maxGroups` groups; one level at least.
    /// Groups and their paths sorted; every path in exactly one group.
    public static func fold(_ paths: [String], maxGroups: Int = maxGroups) -> [Group] {
        let deepest = paths.map { $0.split(separator: "/").count - 1 }.max() ?? 0
        var best = groups(paths, depth: 1)
        guard deepest > 1 else { return best }
        for depth in 2...deepest {
            let g = groups(paths, depth: depth)
            if g.count > maxGroups { break }
            best = g
        }
        return best
    }

    static func groups(_ paths: [String], depth: Int) -> [Group] {
        var byFolder: [String: [String]] = [:]
        for p in paths { byFolder[folder(of: p, depth: depth), default: []].append(p) }
        return byFolder.keys.sorted().map { Group(folder: $0, paths: byFolder[$0]!.sorted()) }
    }
}
