import Foundation

// MARK: git-sync — docs/PROTOCOL.md §68.5 on the wire: the changed files outside the review the commit sheet offers
// (`commit_others` → `commit_others`), `commit.extraPaths` and `state.commit.otherChanges`. Read leniently: an older engine
// sends none of it and refuses `commit_others` `unknown_command` (the sheet then shows no second group).

/// `state.commit.otherChanges` (§68.5): `git status` entries outside the review.
public struct OtherChangeCounts: Codable, Sendable, Equatable {
    public var tracked: Int
    public var untracked: Int

    public init(tracked: Int = 0, untracked: Int = 0) {
        self.tracked = tracked
        self.untracked = untracked
    }

    public var total: Int { tracked + untracked }

    private enum CodingKeys: String, CodingKey { case tracked, untracked }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(tracked: lenientValue(Int.self, c, .tracked) ?? 0, untracked: lenientValue(Int.self, c, .untracked) ?? 0)
    }
}

/// §68.5: a changed file outside the review. `status` as `git status` (`?` untracked); `hidden`: an app ignore pattern
/// matches it (still the user's to commit).
public struct OtherChange: Sendable, Equatable, Hashable, Identifiable {
    public var path: String
    public var oldPath: String?
    public var status: String
    public var untracked: Bool
    public var hidden: Bool

    public var id: String { path }

    public init(path: String, oldPath: String? = nil, status: String = "M", untracked: Bool = false, hidden: Bool = false) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.untracked = untracked
        self.hidden = hidden
    }
}

extension OtherChange: Decodable {
    private enum CodingKeys: String, CodingKey { case path, oldPath, status, untracked, hidden }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let path = lenientValue(String.self, c, .path), !path.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .path, in: c, debugDescription: "a change without a path")
        }
        let untracked = lenientValue(Bool.self, c, .untracked) ?? false
        self.init(path: path, oldPath: lenientValue(String.self, c, .oldPath), status: lenientValue(String.self, c, .status) ?? (untracked ? "?" : "M"),
                  untracked: untracked, hidden: lenientValue(Bool.self, c, .hidden) ?? false)
    }
}

/// Reply to `commit_others`.
public struct CommitOthersReply: Sendable, Equatable {
    public var id: String?
    public var files: [OtherChange]
    public var truncated: Bool

    public init(id: String? = nil, files: [OtherChange] = [], truncated: Bool = false) {
        self.id = id
        self.files = files
        self.truncated = truncated
    }
}

extension CommitOthersReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, files, truncated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), files: lenientElements(OtherChange.self, c, .files),
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false)
    }
}

// MARK: - Commands

extension EngineCommand {
    private enum CommitOthersKeys: String, CodingKey { case message, paths, extraPaths, push }

    /// `commit` with `extraPaths` (`commit_others` has no field; `type` is written by the caller).
    func encodeCommitOthersFields(to encoder: Encoder) throws {
        guard case let .commitWithOthers(message, paths, extraPaths, push) = self else { return }
        var c = encoder.container(keyedBy: CommitOthersKeys.self)
        try c.encode(message, forKey: .message)
        try c.encodeIfPresent(paths, forKey: .paths)
        if !extraPaths.isEmpty { try c.encode(extraPaths, forKey: .extraPaths) }
        try c.encodeIfPresent(push, forKey: .push)
    }
}

// MARK: - The commit sheet's second group

/// §68.5: what the commit sheet does with the changes outside the review — none ticked at first, untracked ones listed only
/// when asked for, and what the Commit button may do.
public enum CommitOthersRules {
    /// The rows shown: tracked changes always, untracked ones with `showUntracked`.
    public static func visible(_ files: [OtherChange], showUntracked: Bool) -> [OtherChange] {
        showUntracked ? files : files.filter { !$0.untracked }
    }

    /// The ticked paths that are still offered (an untracked one hidden again is not committed).
    public static func extraPaths(ticked: Set<String>, files: [OtherChange], showUntracked: Bool) -> [String] {
        visible(files, showUntracked: showUntracked).map(\.path).filter { ticked.contains($0) }
    }

    /// The sheet can commit: a review file or a change outside it is ticked.
    public static func canCommit(reviewTicked: Int, extras: Int) -> Bool { reviewTicked + extras > 0 }

    /// The sheet holds only changes outside the review (no review file to list): it is titled "Commit changes" and shows
    /// no empty "No accepted files" list above them.
    public static func othersOnly(reviewListed: Int, others: Int, truncated: Bool) -> Bool {
        reviewListed == 0 && (others > 0 || truncated)
    }
}

extension AppState {
    /// `state.commit.otherChanges` — nil from an older engine.
    public var otherChangeCounts: OtherChangeCounts? { commitState.otherChanges }

    /// §68.5 `commit_others`: the changed files outside the review (nil: an older engine, or it failed — logged).
    public func loadOtherChanges() async -> CommitOthersReply? {
        guard projectInfo != nil, !isShadowProject else { return nil }
        do {
            let reply = try await typedReply(.commitOthers)
            guard case let .commitOthers(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            return r
        } catch {
            appendLog("[warn] commit_others: \(error.localizedDescription)")
            return nil
        }
    }
}
