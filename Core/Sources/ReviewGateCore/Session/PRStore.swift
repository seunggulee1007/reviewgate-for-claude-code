import Foundation
import Observation

/// PR browsing mirror of `state.pr` (protocol v2): lists (mine / review requested), the opened PR with its
/// files, comments and reviews, the draft comments collected for one submission, and the `gh` accounts.
/// Owned by `AppState` (`store.pr`), which forwards every snapshot via `apply(_:)`; the public API is the
/// one the PR views and the Accounts settings already use. The selected file and its diff are client state
/// (`pr_select_file` returns the parsed patch).
@MainActor
@Observable
public final class PRStore {
    public nonisolated static let hostDefaultsKey = "ghHost"
    public nonisolated static let defaultHost = "github.com"

    public typealias SubmitResult = ReviewGateCore.SubmitResult

    /// Stored host (UserDefaults) or the default.
    public nonisolated static func storedHost(defaults: UserDefaults = .standard) -> String {
        let stored = defaults.string(forKey: hostDefaultsKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (stored?.isEmpty == false) ? stored! : defaultHost
    }

    private(set) var state: PRState
    /// The host the user just typed, shown until the engine's snapshot confirms it.
    private var hostOverride: String?
    /// `errorText` set from the client (nil clears the engine's text until it changes).
    private var localError: String?
    private var clearedError: String?
    private var diffTask: Task<Void, Never>?
    private let defaults: UserDefaults
    private weak var app: AppState?

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.state = .empty(host: Self.storedHost(defaults: defaults))
    }

    func attach(_ app: AppState) { self.app = app }

    // MARK: - Mirrored properties

    /// PR browser host; setting it persists to UserDefaults and switches the engine's store (`set_settings{ghHost}`).
    public var host: String {
        get { hostOverride ?? state.host }
        set {
            let value = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, value != host else { return }
            hostOverride = value
            defaults.set(value, forKey: Self.hostDefaultsKey)
            app?.fire(.setSettings(EngineSettings(ghHost: value)))
        }
    }
    public var mine: [PRSummary] { state.mine }
    public var reviewRequested: [PRSummary] { state.reviewRequested }
    public var selectedSummary: PRSummary? { state.selectedSummary }
    public var selected: PRDetail? { state.selected }
    /// Files of the opened PR (`patch` is nil: patches stay in the engine).
    public var files: [PRFile] { state.files }
    public var comments: [PRComment] { state.comments }
    /// Reviews of the opened PR (`pulls/N/reviews`); loaded with detail/files/comments, refreshed after submit.
    public var reviews: [PRReview] { state.reviews }
    public private(set) var selectedFile: PRFile?
    public private(set) var selectedDiff: FileDiff?
    /// M13 (audit 1.10): the engine cut `selectedDiff` at its line cap.
    public private(set) var selectedDiffTruncated = false
    public var isLoading: Bool { state.isLoading }
    public var isSubmitting: Bool { state.isSubmitting }
    /// `gh` stderr verbatim (or a decoding error) from the last failed call; nil after a success.
    public var errorText: String? {
        get {
            if let localError { return localError }
            return state.errorText == clearedError ? nil : state.errorText
        }
        set {
            localError = newValue
            if newValue == nil { clearedError = state.errorText }
        }
    }
    public var draftComments: [DraftComment] { state.draftComments }
    /// `gh auth status` per known host; filled by `refreshAccounts()`.
    public var accounts: [GHAccount] { state.accounts }
    /// Set after a successful `submit()`; the UI shows it as a banner.
    public var lastSubmitResult: SubmitResult? { state.lastSubmitResult }

    // MARK: Typed, not sent yet — the review sheet and the inline composers come and go (Cancel, another file, another tab)

    /// The review sheet's summary and event: kept on Cancel, cleared once the review went out or another PR opens.
    public var reviewSummaryDraft = ""
    public var reviewEventDraft: ReviewEvent = .comment
    /// An inline comment or reply being written, by `commentDraftKey`; cleared when it is added / sent / cancelled or
    /// another PR opens. Not observed: a composer reads it when it opens, and a keystroke must not redraw the diff.
    @ObservationIgnored public var commentDrafts: [String: String] = [:]

    /// The composer on `path`'s `side` `line`, or the reply to `replyTo` there.
    public nonisolated static func commentDraftKey(path: String, side: String, line: Int, replyTo: Int? = nil) -> String {
        "\(path)|\(side)|\(line)" + (replyTo.map { "|\($0)" } ?? "")
    }

    // MARK: - Snapshot

    func apply(_ new: PRState) {
        let old = state
        if state != new { state = new }   // wave7 w7-state (§45.2): an unchanged PR slice tells no PR view
        if let hostOverride, new.host == hostOverride { self.hostOverride = nil }
        if new.errorText != old.errorText { localError = nil; clearedError = nil }
        if new.selectedSummary?.id != old.selectedSummary?.id {   // another PR: what was typed for the old one goes
            if !reviewSummaryDraft.isEmpty { reviewSummaryDraft = "" }
            if reviewEventDraft != .comment { reviewEventDraft = .comment }
            if !commentDrafts.isEmpty { commentDrafts = [:] }
        }
        let openedAnother = new.selectedSummary?.id != old.selectedSummary?.id || (old.selected == nil && new.selected != nil)
        if openedAnother || (selectedFile.map { sel in !new.files.contains { $0.id == sel.id } } ?? false) {
            diffTask?.cancel()
            selectedFile = nil
            selectedDiff = nil
        }
        if selectedFile == nil, new.selected != nil, let first = new.files.first { selectFile(first) }
    }

    // MARK: - Lists

    public func refresh() async {
        await app?.run(.prList)
    }

    // MARK: - One PR

    public func open(_ summary: PRSummary) async {
        diffTask?.cancel()
        selectedFile = nil
        selectedDiff = nil
        await app?.run(.prOpen(summaryId: summary.id))
    }

    public func selectFile(_ file: PRFile) {
        selectedFile = file
        selectedDiff = nil
        selectedDiffTruncated = false
        diffTask?.cancel()
        guard let app else { return }
        diffTask = Task { [weak self] in
            do {
                let reply = try await app.requestReply(.prSelectFile(filename: file.filename))
                guard case let .fileDiff(_, _, _, diff, truncated, _, _) = reply else { return }
                guard !Task.isCancelled, let self, self.selectedFile?.id == file.id else { return }
                self.selectedDiff = diff
                self.selectedDiffTruncated = truncated
            } catch {
                guard !Task.isCancelled, let self, self.selectedFile?.id == file.id else { return }
                self.localError = error.localizedDescription
            }
        }
    }

    public func reloadComments() async {
        guard selectedSummary != nil else { return }
        await app?.run(.prReloadComments)
    }

    // MARK: wave4c w4c-review — §41.3 "Show 20 more lines" in a PR's diff

    /// The open PR's `filename` at its head commit (`pr_file_lines`).
    public func fileLines(filename: String) async throws -> FileLinesReply {
        guard let app else { throw EngineClientError.stopped }
        let reply = try await app.requestReply(.prFileLines(filename: filename))
        guard case let .fileLines(lines) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return lines
    }

    /// v2 has no separate reviews reload: the engine refreshes reviews with `pr_open` and after `pr_submit`;
    /// this reloads the inline comments, which is what the PR views poll.
    public func reloadReviews() async {
        await reloadComments()
    }

    // MARK: - Drafts & submission

    public func addDraft(_ draft: DraftComment) {
        app?.fire(.prAddDraft(path: draft.path, line: draft.line, side: draft.side, startLine: draft.startLine, body: draft.body))
    }

    public func removeDraft(id: DraftComment.ID) {
        app?.fire(.prRemoveDraft(draftId: id))
    }

    /// Submits the collected drafts as one review; drafts are cleared on success.
    public func submit(event: ReviewEvent, body: String) async {
        guard selectedSummary != nil, selected != nil else { return }
        await app?.run(.prSubmit(event: event, body: body))
    }

    public func reply(to comment: PRComment, body: String) async {
        guard selectedSummary != nil else { return }
        // Replies must target the thread root; replying to a reply is rejected by GitHub.
        await app?.run(.prReply(commentId: comment.inReplyTo ?? comment.id, body: body))
    }

    // MARK: - Accounts

    /// `gh auth status` for every known host (engine, concurrent, 8s each). Never throws.
    public func refreshAccounts() async {
        await app?.run(.accounts)
    }

    /// Opens Terminal.app running `gh auth login --hostname H --web --git-protocol https`.
    public func openLoginInTerminal(host: String) {
        app?.fire(.loginInTerminal(host: host))
    }

    /// The command `login_in_terminal` runs, for the Settings hint; nil if `host` is not a bare
    /// `host[:port]` (same validation as `engine/src/pr/auth.ts` `loginCommand`).
    public static func loginCommand(host: String) -> String? {
        guard host.range(of: "^[A-Za-z0-9.-]+(:[0-9]+)?$", options: .regularExpression) != nil else { return nil }
        return "gh auth login --hostname '\(host)' --web --git-protocol https"
    }
}
