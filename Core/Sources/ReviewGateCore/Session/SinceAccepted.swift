import Foundation

// accept-baseline — docs/PROTOCOL.md §66 on the Mac: a file the user accepted and a later turn changed again is reviewed
// since the accept. Its row and diff header say so ("수락 이후 변경") with the since-accepted status letter, the diff offers
// "수락 이후 / 라운드 전체", reject goes back to the accepted content (the way back to the round's start is a menu item with
// its own confirm), parts are reverted in the since-accepted view too, and the folded group counts the engine's
// "accepted, not committed yet".

/// `changedFiles[].acceptedBase` (§66): what the user accepted of a file a later turn changed again.
public struct AcceptedBase: Sendable, Hashable {
    /// The file's tree entry in the accepted tree; nil: it was deleted when accepted.
    public var blob: String?
    /// The accepted tree: the since-accepted diff's `baseTree` and `reject_hunks.expectedBaseTree`.
    public var tree: String
    /// ISO-8601 of the accept (nil: a review saved before §66).
    public var at: String?
    public var turn: Int?
    /// The change accepted → B (`A`: re-created after an accepted delete, `D`: deleted since).
    public var status: ChangeStatus
    /// The whole round's lines (A → B); the file's `added` / `deleted` are the since-accepted ones.
    public var roundAdded: Int
    public var roundDeleted: Int

    public init(blob: String?, tree: String, at: String? = nil, turn: Int? = nil, status: ChangeStatus = .modified,
                roundAdded: Int = 0, roundDeleted: Int = 0) {
        self.blob = blob
        self.tree = tree
        self.at = at
        self.turn = turn
        self.status = status
        self.roundAdded = roundAdded
        self.roundDeleted = roundDeleted
    }
}

/// `reject.to` (§66): the accepted content (the engine's default for a file with an `acceptedBase`) or the round's start.
public enum RejectTarget: String, Codable, Sendable { case accepted, round }

/// `acceptedBase` read leniently: a malformed one (no tree) is no base — the file then shows the whole round, as before §66.
enum AcceptedBaseWire {
    private enum FileKeys: String, CodingKey { case acceptedBase }
    private enum Keys: String, CodingKey { case blob, tree, at, turn, status, roundAdded, roundDeleted }

    static func acceptedBase(from decoder: Decoder) -> AcceptedBase? {
        guard let file = try? decoder.container(keyedBy: FileKeys.self),
              let c = try? file.nestedContainer(keyedBy: Keys.self, forKey: .acceptedBase),
              let tree = lenientValue(String.self, c, .tree), !tree.isEmpty else { return nil }
        return AcceptedBase(blob: lenientValue(String.self, c, .blob), tree: tree,
                            at: lenientValue(String.self, c, .at), turn: lenientValue(Int.self, c, .turn),
                            status: lenientValue(String.self, c, .status).flatMap(ChangeStatus.init(rawValue:)) ?? .modified,
                            roundAdded: lenientValue(Int.self, c, .roundAdded) ?? 0,
                            roundDeleted: lenientValue(Int.self, c, .roundDeleted) ?? 0)
    }
}

public extension ChangedFile {
    /// The row's and the diff header's status letter: the change since the accept for a file with an `acceptedBase` (a file
    /// Claude created, the user accepted and a later turn edited is `M`, not the round's `A`), else the round's.
    var badgeStatus: ChangeStatus { acceptedBase?.status ?? status }

    /// `reject_hunks` can take the ids of the diff shown in `since`: the whole review's (§17), or for a file with an
    /// `acceptedBase` the since-accepted diff's — judged by the change since the accept (a created, accepted, then edited
    /// file can be cut hunk by hunk there). Other ranges' ids are never `reject_hunks` ids (§34.1).
    func allowsHunkReject(in since: DiffSince) -> Bool {
        switch since {
        case .review: supportsHunkReject
        case .accepted: acceptedBase.map { state == .pending && $0.status == .modified && !isBinary && !uncaptured } ?? false
        case .turn, .request: false
        }
    }
}

/// §66 in the user's words (English keys, Korean in the catalog; Electron uses the same keys).
public enum SinceAcceptedText {
    /// The row's and the diff header's label: "수락 이후 변경".
    public static var label: String { String(localized: "Changed since accepted", bundle: .module) }

    public static var labelHelp: String {
        String(localized: "You accepted this file earlier and a later turn changed it again. The +/− and the status letter count what changed since your accept; “Whole round” shows the whole round", bundle: .module)
    }

    /// The range picker's "전체" for such a file: "라운드 전체".
    public static var wholeRound: String { String(localized: "Whole round", bundle: .module) }

    /// Reject's tooltip: it puts the accepted content back, it never deletes the file.
    public static var rejectHelp: String { String(localized: "Revert to the content you accepted (⌘⇧R)", bundle: .module) }

    /// The menu item: "라운드 시작으로 되돌리기".
    public static var roundReject: String { String(localized: "Revert to the start of the round", bundle: .module) }

    public static var roundRejectHelp: String {
        String(localized: "Undoes your accept too: the file goes back to how it was before this round and leaves the list", bundle: .module)
    }

    public static func roundRejectQuestion(_ path: String) -> String {
        let name = (path as NSString).lastPathComponent
        return String(localized: "Revert \(name) to the start of the round?", bundle: .module)
    }

    /// The confirm's message: a file this round created is deleted, any other goes back to the round's start.
    public static func roundRejectMessage(_ file: ChangedFile) -> String {
        file.status == .added
            ? String(localized: "The content you accepted goes too. The file did not exist before this round, so it is deleted from disk.", bundle: .module)
            : String(localized: "The content you accepted goes too. The file on disk goes back to how it was before this round and leaves the review list.", bundle: .module)
    }

    /// "Revert selected" in the since-accepted view.
    public static func revertPartsMessage(_ path: String) -> String {
        String(localized: "Those parts of \(path) go back to the content you accepted, on disk. The rest of the file stays under review.", bundle: .module)
    }
}

public extension DiffSince {
    /// The range picker's label for `file`: "라운드 전체" for the whole review of a file reviewed since its accept.
    func label(for file: ChangedFile) -> String {
        self == .review && file.acceptedBase != nil ? SinceAcceptedText.wholeRound : label
    }
}

public extension AcceptedGroup {
    /// "수락함 · 커밋 전 N": the engine's count (§66 `reviewSummary.acceptedUncommitted`), else (an older engine, or the author
    /// filter hiding some rows — the engine does not know it) the rows the group holds.
    static func count(summary: ReviewSummary?, shown: Int, filtered: Bool) -> Int {
        guard !filtered, let engine = summary?.acceptedUncommitted else { return shown }
        return max(engine, shown)   // never fewer than the rows the group lists
    }
}

extension AppState {
    /// Why "라운드 시작으로 되돌리기" is off for `file` (nil: on). It is offered only for a pending file with an `acceptedBase`,
    /// and only outside a turn — a reject scheduled during a turn always restores the accepted content (§66).
    public func roundRejectBlocker(_ file: ChangedFile) -> String? {
        if let reason = rejectLockReason { return reason }
        if isRunning || isSnapshotting { return String(localized: "Reject is available when this turn ends", bundle: .module) }
        if file.uncaptured { return ReviewProvenanceText.uncaptured }
        return nil
    }

    /// `reject {paths: [file], to: "round"}` after the user confirmed it: back to A, the file leaves the list. An external
    /// change is confirmed again as any reject of one (§31).
    public func rejectToRoundStart(_ file: ChangedFile) {
        guard let current = changedFiles.first(where: { $0.path == file.path && $0.state == .pending }), current.acceptedBase != nil else { return }
        if let reason = roundRejectBlocker(current) {
            fail(reason, fatal: false)
            return
        }
        if holdReject(of: current, to: .round) { return }
        fireReject(.reject(paths: [current.path], to: .round))
        if selectedPath == current.path, let next = pendingAfter(current.path) { selectFile(next) }
    }
}
