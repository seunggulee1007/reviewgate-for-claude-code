import Foundation
import Observation

// MARK: §53 commits in meaningful units
// docs/PROTOCOL.md §53: the requests behind the commit sheet's "나눠서 커밋" mode, and the mode's state while the sheet is
// open (`CommitSplitSession`: the hunks, the cards, Claude's split in flight, the series and how it ended).

/// Why a §53 request failed, in the user's words; `made` = the commits a stopped series made (oldest first).
public struct CommitSeriesFailure: Error, Equatable {
    public let text: String
    /// The engine does not know the command (`unknown_command`).
    public let unsupported: Bool
    public let made: [SeriesCommit]

    public init(text: String, unsupported: Bool = false, made: [SeriesCommit] = []) {
        self.text = text
        self.unsupported = unsupported
        self.made = made
    }

    init(_ error: Error, made: [SeriesCommit] = []) {
        let unsupported = (error as? EngineClientError)?.refusalCode == "unknown_command"
        self.init(text: unsupported ? FlowText.updateReason : made.isEmpty ? CommitSplitText.refusal(error) : CommitSplitText.failure(error, made: made),
                  unsupported: unsupported, made: made)
    }
}

public extension AppState {
    /// `commit_hunks {paths}`: the accepted files as hunks of `git diff HEAD`, in file order. Reads only.
    func loadCommitHunks(paths: [String]?) async -> Result<[CommitFile], CommitSeriesFailure> {
        guard projectInfo != nil else { return .failure(CommitSeriesFailure(EngineClientError.refused("no_project"))) }
        do {
            let reply = try await reply(.commitHunks(paths: paths))
            guard case let .commitHunks(hunks) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            return .success(hunks.files)
        } catch {
            appendLog("[warn] commit_hunks: \(error.localizedDescription)")
            return .failure(CommitSeriesFailure(error))
        }
    }

    /// `commit_split_draft {paths}` (after giving the engine this project's commit template): Claude's proposal of the
    /// split, from a read-only fork in the side lane. Nothing is committed.
    func splitCommitWithClaude(paths: [String]?) async -> Result<CommitSplitDraftReply, CommitSeriesFailure> {
        guard projectInfo != nil else { return .failure(CommitSeriesFailure(EngineClientError.refused("no_project"))) }
        await sendFlowSettings()   // the template as it is now, before the fork reads it
        do {
            let reply = try await reply(.commitSplitDraft(paths: paths))
            guard case let .commitSplitDraft(draft) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            return .success(draft)
        } catch {
            appendLog("[warn] commit_split_draft: \(error.localizedDescription)")
            return .failure(CommitSeriesFailure(error))
        }
    }

    /// `commit_series {commits, push}`: the commits in order, then one push. A series that stopped after a commit fails with
    /// what it made (`result.partial`). A refused push after every commit is a success: the commits exist and the Changes
    /// banner offers "Push now" (`lastCommit.pushError`), as after `commit`.
    func commitSeries(_ commits: [CommitPlan], push: Bool?) async -> Result<CommittedSeries, CommitSeriesFailure> {
        guard projectInfo != nil else { return .failure(CommitSeriesFailure(EngineClientError.refused("no_project"))) }
        let before = lastCommit?.sha
        do {
            let reply = try await reply(.commitSeries(commits: commits, push: push))
            guard case let .committedSeries(series) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            await settle()
            flow.commitMessageDraft = nil   // committed: the next sheet starts from the next suggestion
            flow.lastSeries = series
            return .success(series)
        } catch {
            appendLog("[warn] commit_series: \(error.localizedDescription)")
            await settle()
            let made = (error as? EngineClientError)?.partialSeries?.commits ?? []
            if made.isEmpty, let last = lastCommit, last.sha != before {
                flow.commitMessageDraft = nil
                flow.lastSeries = nil
                return .success(CommittedSeries(branch: last.branch, pushed: false))
            }
            return .failure(CommitSeriesFailure(error, made: made))
        }
    }
}

/// The "나눠서 커밋" mode while the commit sheet is open: the accepted files' hunks, the cards, Claude's split in flight and
/// the series. The sheet owns one per opening; the screenshot tour and the tests build one with its files already loaded.
@MainActor
@Observable
public final class CommitSplitSession {
    /// The sheet's ticked accepted files (fixed while the mode is open).
    public let paths: [String]
    /// nil while `commit_hunks` loads.
    public private(set) var files: [CommitFile]?
    public var state: CommitSplitState
    /// Why the hunks could not be loaded.
    public private(set) var loadError: String?
    public private(set) var isSplitting = false
    /// Why "AI로 나누기" failed (or is off: an engine before §53).
    public private(set) var splitError: String?
    public private(set) var isCommitting = false
    /// Why the series failed — after the commits it made, if any.
    public private(set) var commitError: String?
    /// The commits a stopped series made: making it again would repeat them, so the sheet can only be closed.
    public private(set) var made: [SeriesCommit] = []
    /// Hunks whose text is shown (`<place>:<part key>`).
    public var expanded: Set<String> = []
    @ObservationIgnored private let message: String

    public init(paths: [String], message: String = "") {
        self.paths = paths
        self.message = message
        state = CommitSplitState(message: message)
    }

    /// The files already loaded (the screenshot tour, tests); `state` nil = one card with everything.
    public init(paths: [String], files: [CommitFile], state: CommitSplitState? = nil, message: String = "") {
        self.paths = paths
        self.message = message
        self.files = files
        self.state = state ?? CommitSplitState(files: files, message: message)
    }

    public var stopped: Bool { !made.isEmpty }
    public var list: [CommitFile] { files ?? [] }

    public func file(_ path: String) -> CommitFile? {
        files?.first { $0.path == path }
    }

    /// Why "커밋 N개 만들기" is off; nil = it can run.
    public var blocker: String? {
        if files == nil { return loadError ?? CommitSplitText.loading }
        if stopped { return CommitSplitText.stopped }
        return state.blocker(splitting: isSplitting, committing: isCommitting)
    }

    /// "AI로 나누기" can start.
    public var canSplit: Bool { files != nil && !isSplitting && !isCommitting && !stopped }

    /// `commit_hunks`; the state becomes one card with everything (the message the sheet had).
    public func load(_ app: AppState) async {
        guard files == nil else { return }
        loadError = nil
        switch await app.loadCommitHunks(paths: paths) {
        case let .success(loaded):
            files = loaded
            state = CommitSplitState(files: loaded, message: message)
        case let .failure(failure):
            loadError = failure.text
        }
    }

    /// "AI로 나누기": Claude's proposal replaces the cards (the arrangement before it can be restored).
    public func splitWithClaude(_ app: AppState) async {
        guard canSplit else { return }
        isSplitting = true
        splitError = nil
        defer { isSplitting = false }
        switch await app.splitCommitWithClaude(paths: paths) {
        case let .success(draft):
            state.propose(files: list, commits: draft.commits, unassigned: draft.unassigned)
        case let .failure(failure):
            splitError = failure.text
        }
    }

    /// "커밋 N개 만들기": the series; nil when it failed (`commitError`, and `made` when it stopped after a commit).
    public func commit(_ app: AppState, push: Bool) async -> CommittedSeries? {
        guard blocker == nil else { return nil }
        isCommitting = true
        commitError = nil
        defer { isCommitting = false }
        switch await app.commitSeries(state.series(), push: push) {
        case let .success(series):
            return series
        case let .failure(failure):
            made = failure.made
            commitError = failure.text
            return nil
        }
    }

    // MARK: Edits (the cards and "커밋하지 않음")

    public func moveFile(_ path: String, from: SplitTarget, to: SplitTarget) {
        state.moveFile(path, from: from, to: to, files: list)
    }

    public func movePart(_ part: SplitPart, from: SplitTarget, to: SplitTarget) {
        state.movePart(part, from: from, to: to, files: list)
    }

    public func deleteCard(_ id: Int) {
        state.deleteCard(id, files: list)
    }

    public func toggleExpanded(_ part: SplitPart, in place: SplitTarget) {
        let key = Self.expandKey(part, in: place)
        if expanded.remove(key) == nil { expanded.insert(key) }
    }

    public func isExpanded(_ part: SplitPart, in place: SplitTarget) -> Bool {
        expanded.contains(Self.expandKey(part, in: place))
    }

    private static func expandKey(_ part: SplitPart, in place: SplitTarget) -> String {
        switch place {
        case let .card(id): "\(id):\(part.key)"
        case .notCommitted: "none:\(part.key)"
        }
    }

    #if DEBUG
    /// The screenshot tour: a series that stopped, or Claude's failure, without an engine.
    public func debugShow(made: [SeriesCommit] = [], commitError: String? = nil, splitError: String? = nil) {
        self.made = made
        self.commitError = commitError
        self.splitError = splitError
    }
    #endif
}
