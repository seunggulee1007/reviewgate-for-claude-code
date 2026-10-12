import Foundation
import Observation

// MARK: wave3 mac-flow
// The client state of docs/PROTOCOL.md §36.11–36.14 that is not in the engine's snapshot — a commit draft in flight, the
// workbench preview and the steps of a create, the AI pre-review runs (snapshot + events) — and the per-project settings
// the app keeps for them (commit template, workbench setup, PR respond command). Owned by `AppState` (`store.flow`).

public extension AppSettings.Key {
    /// wave3 mac-flow (§36.11): JSON `[projectKey: String]`.
    static let projectCommitTemplate = "projectCommitTemplate"
    /// wave3 mac-flow (§36.12): JSON `[projectKey: WorkbenchSetup]`.
    static let projectWorkbenchSetup = "projectWorkbenchSetup"
    /// wave3 mac-flow (§36.14): JSON `[projectKey: String]` — client only, never sent to the engine.
    static let projectPRRespondCommand = "projectPRRespondCommand"
    /// wave3 mac-flow (§36.13): the effort the head button runs the pre-review with (`low` / `medium` / `high`).
    static let preReviewEffort = "preReviewEffort"
}

public extension AppSettings {
    /// §36.11: this project's commit message template ("" = none).
    static func commitTemplate(root: String, defaults: UserDefaults = .standard) -> String {
        flowTable(String.self, Key.projectCommitTemplate, defaults: defaults)[root] ?? ""
    }

    static func setCommitTemplate(_ template: String, root: String, defaults: UserDefaults = .standard) {
        setFlowValue(template.isEmpty ? nil : template, root: root, key: Key.projectCommitTemplate, defaults: defaults)
    }

    /// §36.12: this project's workbench setup (defaults: no copies, `.worktreeinclude` read, fetch, managed folder).
    static func workbenchSetup(root: String, defaults: UserDefaults = .standard) -> WorkbenchSetup {
        flowTable(WorkbenchSetup.self, Key.projectWorkbenchSetup, defaults: defaults)[root] ?? .default
    }

    static func setWorkbenchSetup(_ setup: WorkbenchSetup, root: String, defaults: UserDefaults = .standard) {
        setFlowValue(setup == .default ? nil : setup, root: root, key: Key.projectWorkbenchSetup, defaults: defaults)
    }

    /// §36.14: this project's command for PR comments (e.g. `/acme-tools:review-reply {pr}`; "" = none).
    static func prRespondCommand(root: String, defaults: UserDefaults = .standard) -> String {
        flowTable(String.self, Key.projectPRRespondCommand, defaults: defaults)[root] ?? ""
    }

    static func setPRRespondCommand(_ command: String, root: String, defaults: UserDefaults = .standard) {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        setFlowValue(trimmed.isEmpty ? nil : trimmed, root: root, key: Key.projectPRRespondCommand, defaults: defaults)
    }

    /// §36.13: the remembered effort (default medium).
    static func preReviewEffort(defaults: UserDefaults = .standard) -> PreReviewEffort {
        defaults.string(forKey: Key.preReviewEffort).flatMap(PreReviewEffort.init(rawValue:)) ?? .medium
    }

    static func setPreReviewEffort(_ effort: PreReviewEffort, defaults: UserDefaults = .standard) {
        defaults.set(effort.rawValue, forKey: Key.preReviewEffort)
    }

    private static func flowTable<T: Codable>(_ type: T.Type, _ key: String, defaults: UserDefaults) -> [String: T] {
        guard let data = defaults.data(forKey: key) else { return [:] }
        return (try? JSONDecoder().decode([String: T].self, from: data)) ?? [:]
    }

    private static func setFlowValue<T: Codable>(_ value: T?, root: String, key: String, defaults: UserDefaults) {
        var table = flowTable(T.self, key, defaults: defaults)
        table[root] = value
        if let data = try? JSONEncoder().encode(table) { defaults.set(data, forKey: key) }
    }
}

/// The `workbench_preview` request a reply belongs to.
public struct WorkbenchPreviewRequest: Sendable, Hashable {
    public var branch: String
    public var from: String?
    public var location: WorkbenchLocation?

    public init(branch: String, from: String? = nil, location: WorkbenchLocation? = nil) {
        self.branch = branch
        self.from = from
        self.location = location
    }
}

@MainActor
@Observable
public final class FlowToolsStore {
    // §36.11
    /// A `commit_draft` is in flight.
    public private(set) var isDraftingCommit = false
    /// Why the last draft failed, in the user's words; nil after a success.
    public private(set) var commitDraftError: String?
    /// False once the engine answered `unknown_command` (the button stays off with the reason).
    public private(set) var commitDraftSupported = true
    /// The commit sheet's message while the sheet is closed (Esc, Cancel, a look at a file): it opens with it again. nil:
    /// the engine's suggestion. Cleared by a commit and with the project.
    public var commitMessageDraft: String?
    /// A draft that finished — also after its sheet was closed — until a commit sheet takes it (`takeFinishedCommitDraft`).
    public private(set) var finishedCommitDraft: String?
    // §36.12
    public private(set) var preview: WorkbenchPreviewReply?
    /// What `preview` was asked for.
    public private(set) var previewRequest: WorkbenchPreviewRequest?
    public private(set) var isLoadingPreview = false
    public private(set) var previewError: String?
    /// False once the engine answered `unknown_command`.
    public private(set) var previewSupported = true
    /// The branch of the `workbench_create` in flight; its `workbench_progress` steps collect in `progress`.
    public private(set) var creatingBranch: String?
    /// The steps of the create in flight (or the last one), in order; one entry per step (the latest event).
    public private(set) var progress: [WorkbenchProgress] = []
    // §36.13
    /// The pre-reviews of the review in progress (snapshot `gate.prereviews` + `prereview` events), newest first.
    public private(set) var runs: [PreReviewRun] = []
    public private(set) var isStartingPreReview = false
    /// Why the last start / cancel / dismiss was refused, in the user's words; nil after a success.
    public private(set) var preReviewError: String?
    /// False once the engine answered `unknown_command`.
    public private(set) var preReviewSupported = true
    /// Findings whose dismiss / note is in flight (`<prereviewId>#<findingId>`).
    public private(set) var busyFindings: Set<String> = []
    @ObservationIgnored weak var app: AppState?
    /// The snapshot's list last applied (a snapshot repeating it never overrides a newer event).
    @ObservationIgnored private var lastSnapshotRuns: [PreReviewRun] = []
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    /// Bumped by `reset()`: a `commit_draft` that started in another project is dropped when it finishes.
    @ObservationIgnored private var draftGeneration = 0
    /// The flow settings this engine was last given for the open project (`sendFlowSettings` skips a repeat).
    @ObservationIgnored var sentSettings: EngineSettings?

    public init() {}

    func attach(_ app: AppState) { self.app = app }

    /// What the window forgets when it opens / closes / switches a project.
    func reset() {
        draftGeneration &+= 1
        isDraftingCommit = false
        commitDraftError = nil
        commitMessageDraft = nil
        finishedCommitDraft = nil
        preview = nil
        previewRequest = nil
        isLoadingPreview = false
        previewError = nil
        previewTask?.cancel()
        previewTask = nil
        creatingBranch = nil
        progress = []
        runs = []
        lastSnapshotRuns = []
        isStartingPreReview = false
        preReviewError = nil
        busyFindings = []
        sentSettings = nil
    }

    // MARK: §36.11 Commit message draft

    /// `commit_draft{paths}` (after giving the engine this project's template): the message for the sheet's field, or nil
    /// with `commitDraftError` set. Nothing is committed.
    public func draftCommitMessage(paths: [String]?) async -> String? {
        guard let app, !isDraftingCommit else { return nil }
        isDraftingCommit = true
        commitDraftError = nil
        // A project switch during the draft (tens of seconds) is a `reset()`: its result is not this project's, and its end
        // must not clear the flag of a draft started since.
        let generation = draftGeneration
        defer { if generation == draftGeneration { isDraftingCommit = false } }
        await app.sendFlowSettings()   // the template as it is now, before the fork reads it
        guard generation == draftGeneration else { return nil }
        do {
            let reply = try await app.reply(.commitDraft(paths: paths))
            guard generation == draftGeneration else { return nil }
            guard case let .commitDraft(draft) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
            let message = draft.message.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !message.isEmpty else {
                commitDraftError = FlowText.refusal(code: "commit_draft_failed", detail: "")
                return nil
            }
            commitDraftSupported = true
            finishedCommitDraft = message
            return message
        } catch {
            guard generation == draftGeneration else { return nil }
            if (error as? EngineClientError)?.refusalCode == "unknown_command" { commitDraftSupported = false }
            commitDraftError = FlowText.refusal(error)
            return nil
        }
    }

    /// The finished draft for the commit sheet's field, once (nil when there is none).
    public func takeFinishedCommitDraft() -> String? {
        defer { finishedCommitDraft = nil }
        return finishedCommitDraft
    }

    // MARK: §36.12 Workbench setup

    /// `workbench_preview`, debounced by `delay` (the sheet asks as the user types); an older answer never replaces a newer one.
    public func requestPreview(_ request: WorkbenchPreviewRequest, delay: Duration = .milliseconds(250)) {
        guard previewSupported, !request.branch.isEmpty else { return }
        previewTask?.cancel()
        isLoadingPreview = true
        previewTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.loadPreview(request)
        }
    }

    func loadPreview(_ request: WorkbenchPreviewRequest) async {
        guard let app else { return }
        isLoadingPreview = true
        await app.sendFlowSettings()   // the copy patterns as they are now
        let result: Result<EngineEvent, any Error>
        do {
            result = .success(try await app.reply(.workbenchPreview(branch: request.branch, from: request.from, location: request.location)))
        } catch {
            result = .failure(error)
        }
        guard !Task.isCancelled else { return }   // a newer request owns the state now
        isLoadingPreview = false
        previewRequest = request
        switch result {
        case let .success(.workbenchPreview(answer)):
            preview = answer
            previewError = nil
        case .success:
            preview = nil
        case let .failure(error):
            preview = nil
            if (error as? EngineClientError)?.refusalCode == "unknown_command" {
                previewSupported = false
                previewError = nil
            } else {
                previewError = FlowText.refusal(error)
            }
        }
    }

    /// The preview answers `request` (not an older branch / location).
    public func preview(for request: WorkbenchPreviewRequest) -> WorkbenchPreviewReply? {
        previewRequest == request ? preview : nil
    }

    /// A `workbench_create` for `branch` starts: its progress events collect from now on.
    func beginCreate(branch: String) {
        creatingBranch = branch
        progress = []
    }

    /// The create replied (or failed): no more steps; `progress` stays for the sheet / the new window.
    func endCreate() { creatingBranch = nil }

    /// `workbench_progress`: a step of the create in flight (another branch's — a second window's — is not ours).
    func apply(progress event: WorkbenchProgress) {
        guard let creatingBranch, event.branch == creatingBranch || event.branch.isEmpty else { return }
        if let index = progress.firstIndex(where: { $0.step == event.step }) {
            progress[index] = event
        } else {
            progress.append(event)
            progress.sort { $0.step < $1.step }
        }
    }

    /// The setup step ran and failed (non-zero exit, killed / timed out): the new window shows its log.
    public var setupFailed: Bool {
        progress.first { $0.step == .setup }?.exit.failed == true
            || progress.first { $0.step == .done }?.exit.failed == true
    }

    /// The new worktree's folder as the steps named it.
    public var createdPath: String? { progress.last { !$0.path.isEmpty }?.path }

    // MARK: §36.13 AI pre-review

    /// `prereview_start` (side lane): true when it started (its first run is in `runs`).
    @discardableResult
    public func startPreReview(scope: PreReviewScope, paths: [String]? = nil, effort: PreReviewEffort) async -> Bool {
        guard let app, !isStartingPreReview else { return false }
        isStartingPreReview = true
        preReviewError = nil
        defer { isStartingPreReview = false }
        do {
            let reply = try await app.reply(.prereviewStart(scope: scope, paths: paths, effort: effort))
            if case let .prereview(answer) = reply { apply(run: answer.run) }
            preReviewSupported = true
            return true
        } catch {
            if (error as? EngineClientError)?.refusalCode == "unknown_command" { preReviewSupported = false }
            preReviewError = FlowText.refusal(error)
            return false
        }
    }

    public func cancelPreReview(_ prereviewId: String) async {
        guard let app else { return }
        preReviewError = nil
        do {
            _ = try await app.reply(.prereviewCancel(prereviewId: prereviewId))
        } catch {
            // Ended meanwhile: the run's own end arrives (or already did) — not worth a message.
            if (error as? EngineClientError)?.refusalCode != "not_running" { preReviewError = FlowText.refusal(error) }
        }
    }

    /// `prereview_dismiss`: the finding goes away here at once and in the engine's list (an engine that refuses brings it back).
    public func dismiss(_ finding: PreReviewFinding, of prereviewId: String) async {
        guard let app else { return }
        let key = Self.key(prereviewId, finding.id)
        guard !busyFindings.contains(key) else { return }
        busyFindings.insert(key)
        defer { busyFindings.remove(key) }
        let before = runs
        removeFinding(finding.id, of: prereviewId)
        do {
            _ = try await app.reply(.prereviewDismiss(prereviewId: prereviewId, findingId: finding.id))
            preReviewError = nil
        } catch {
            if (error as? EngineClientError)?.refusalCode == "unknown_finding" { return }   // already gone
            runs = before
            preReviewError = FlowText.refusal(error)
        }
    }

    /// "Add as note": an ordinary review note on the finding's line (then `request_changes` as usual), and the finding
    /// leaves the list. False when the note was refused (`preReviewError` says why).
    @discardableResult
    public func addAsNote(_ finding: PreReviewFinding, of prereviewId: String, excerpt: String) async -> Bool {
        guard let app else { return false }
        let key = Self.key(prereviewId, finding.id)
        guard !busyFindings.contains(key) else { return false }
        busyFindings.insert(key)
        do {
            try await app.request(.addNote(path: finding.file, line: finding.line, side: .new, excerpt: excerpt,
                                           body: PreReviewDisplay.noteBody(finding)))
        } catch {
            busyFindings.remove(key)
            preReviewError = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
            return false
        }
        busyFindings.remove(key)
        await dismiss(finding, of: prereviewId)
        return true
    }

    public func isBusy(_ finding: PreReviewFinding, of prereviewId: String) -> Bool {
        busyFindings.contains(Self.key(prereviewId, finding.id))
    }

    public func clearPreReviewError() { preReviewError = nil }

    public func clearCommitDraftError() { if !isDraftingCommit { commitDraftError = nil } }

    /// A `prereview` event (or reply): the run replaces the one with its id; a new one goes first.
    func apply(run: PreReviewRun) {
        guard !run.prereviewId.isEmpty else { return }
        if let index = runs.firstIndex(where: { $0.prereviewId == run.prereviewId }) {
            runs[index] = run
        } else {
            runs.insert(run, at: 0)
        }
    }

    /// The snapshot's `gate.prereviews` when it changed: the engine's list wins (it also drops what a finished round or a
    /// dismiss removed).
    func applySnapshot(_ list: [PreReviewRun]) {
        guard list != lastSnapshotRuns else { return }
        lastSnapshotRuns = list
        runs = list
    }

    private func removeFinding(_ findingId: String, of prereviewId: String) {
        guard let index = runs.firstIndex(where: { $0.prereviewId == prereviewId }) else { return }
        runs[index].findings.removeAll { $0.id == findingId }
    }

    private static func key(_ prereviewId: String, _ findingId: String) -> String { "\(prereviewId)#\(findingId)" }
}

public extension AppState {
    // MARK: wave3 mac-flow — per-repository settings

    /// Where the flow settings are kept: the repository's main worktree (every workbench of it shares them), else the
    /// open folder; nil without a project.
    var flowSettingsRoot: String? { Self.flowSettingsRoot(projectPath: projectInfo?.path, workbenches: workbenches) }

    nonisolated static func flowSettingsRoot(_ state: ReviewState) -> String? {
        flowSettingsRoot(projectPath: state.project?.path, workbenches: state.workbenches)
    }

    nonisolated static func flowSettingsRoot(projectPath: String?, workbenches: WorkbenchesInfo?) -> String? {
        guard let path = projectPath else { return nil }
        let main = workbenches?.list.first(where: \.isMain)?.path
        return AppSettings.projectKey(URL(fileURLWithPath: main ?? path))
    }

    /// The repository's commit message template ("" without a project).
    var commitTemplate: String {
        guard let root = flowSettingsRoot else { return "" }
        return AppSettings.commitTemplate(root: root, defaults: settingsDefaults)
    }

    func setCommitTemplate(_ template: String) {
        guard let root = flowSettingsRoot else { return }
        AppSettings.setCommitTemplate(template, root: root, defaults: settingsDefaults)
    }

    var workbenchSetup: WorkbenchSetup {
        guard let root = flowSettingsRoot else { return .default }
        return AppSettings.workbenchSetup(root: root, defaults: settingsDefaults)
    }

    /// Saved as edited; the engine gets it when the editor closes and before every preview / create (`sendFlowSettings`).
    func setWorkbenchSetup(_ setup: WorkbenchSetup) {
        guard let root = flowSettingsRoot else { return }
        AppSettings.setWorkbenchSetup(setup, root: root, defaults: settingsDefaults)
    }

    var prRespondCommand: String {
        guard let root = flowSettingsRoot else { return "" }
        return AppSettings.prRespondCommand(root: root, defaults: settingsDefaults)
    }

    func setPRRespondCommand(_ command: String) {
        guard let root = flowSettingsRoot else { return }
        AppSettings.setPRRespondCommand(command, root: root, defaults: settingsDefaults)
    }

    /// `set_settings{commitTemplate, workbenchSetup}` with this repository's values (both live in the engine, read only by
    /// `commit_draft` / `workbench_preview` / `workbench_create`): when an editor closes — and, through `sendFlowSettings`,
    /// right before each of those commands. Skipped when this engine has them already.
    func pushFlowSettings() {
        guard projectURL != nil, isEngineRunning || commandSink != nil else { return }
        let settings = flowSettings
        guard settings != flow.sentSettings else { return }
        flow.sentSettings = settings
        fire(.setSettings(settings))
    }

    /// `pushFlowSettings`, awaited (the next command is sure to come after it) — skipped when this engine has them already.
    func sendFlowSettings() async {
        guard projectURL != nil else { return }
        let settings = flowSettings
        guard settings != flow.sentSettings else { return }
        if let commandSink { flow.sentSettings = settings; commandSink(.setSettings(settings)); return }
        guard isEngineRunning else { return }
        flow.sentSettings = settings
        try? await client.send(.setSettings(settings))
    }

    private var flowSettings: EngineSettings {
        var settings = EngineSettings()
        settings.commitTemplate = commitTemplate
        settings.workbenchSetup = workbenchSetup
        return settings
    }

    // MARK: wave3 mac-flow — §36.12 / §36.13 state

    /// The engine knows §36.12 (it lists remote branches, even none).
    var supportsWorkbenchSetup: Bool { branchesInfo.remotes != nil && flow.previewSupported }

    /// Remote-tracking branches offered as workbench bases (`origin/develop`), newest first as the engine sends them.
    var remoteBranches: [BranchInfo] { branchesInfo.remotes?.branches ?? [] }

    /// The Changes head's pre-review status.
    var preReviewStatus: PreReviewHeadStatus {
        PreReviewDisplay.headStatus(flow.runs, reviewEndTree: gate.reviewEndTree)
    }

    /// Why "AI pre-review" cannot start now; nil = it can.
    var preReviewBlocker: String? {
        if !flow.preReviewSupported { return FlowText.updateReason }
        if projectInfo == nil { return EngineMessages.refusal(error: "no_project") }
        if changedFiles.isEmpty || (gate.reviewEndTree == nil && gate.turnEndTree == nil) {
            return FlowText.refusal(code: "no_review", detail: "")
        }
        if case .running = preReviewStatus { return FlowText.refusal(code: "prereview_running", detail: "") }
        if flow.isStartingPreReview { return FlowText.refusal(code: "prereview_running", detail: "") }
        return nil
    }

    /// Findings on `path` per file, for the changed-files badges.
    var preReviewCounts: [String: Int] { PreReviewDisplay.counts(flow.runs) }

    /// The shown findings on the new-side line `line` of `path` (the diff's inline cards).
    func preReviewFindings(path: String, line: Int) -> [PreReviewItem] {
        PreReviewDisplay.findings(flow.runs, path: path, line: line)
    }

    /// wave7 w7-state (§45.2): `preReviewFindings` of every new-side line of `path`, once per change.
    func preReviewFindingsByLine(path: String) -> [Int: [PreReviewItem]] {
        PreReviewDisplay.findingsByLine(flow.runs, path: path)
    }

    /// The shown findings of `path` no diff line on screen carries (the whole file, a line outside the hunks).
    func preReviewUnplaced(path: String, newLines: Set<Int>) -> [PreReviewItem] {
        PreReviewDisplay.unplacedFindings(flow.runs, path: path, newLines: newLines)
    }

    /// The first changed file (in the list's order) with a shown finding — where "%d findings" leads.
    var firstPreReviewPath: String? {
        let counts = preReviewCounts
        return changedFiles.first { counts[$0.path] != nil }?.path ?? counts.keys.sorted().first
    }

    /// A shown run looked at an earlier B than the review shows now (its findings are dimmed).
    func isPreReviewStale(_ run: PreReviewRun) -> Bool {
        PreReviewDisplay.isStale(run, reviewEndTree: gate.reviewEndTree)
    }

    /// Wired from `apply(snapshot)`: a new project (or engine) forgets the old one's flow state — its settings go to the
    /// engine again before the next draft / preview / create; the engine's pre-review list is mirrored.
    internal func flowSnapshotApplied(previous: ReviewState) {
        if state.project?.path != previous.project?.path { flow.reset() }
        flow.applySnapshot(state.gate.prereviews)
    }

    /// Wired from `handle(_:)`: the §36.12 / §36.13 events nobody waited for (a request's own reply is consumed by it).
    internal func handleFlowEvent(_ event: EngineEvent) {
        switch event {
        case let .workbenchProgress(progress): flow.apply(progress: progress)
        case let .prereview(reply): flow.apply(run: reply.run)
        default: break
        }
    }
}
