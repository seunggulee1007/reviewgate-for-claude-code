import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-flow — the client side of docs/PROTOCOL.md §36.11–36.14: the commit template preview, which pre-review findings
/// show where (and dimmed), what "Send to Claude" puts in the composer, the PR workbench branch / side-question anchor, the
/// per-project settings, and the flow store (draft, preview, create steps, pre-review runs) against fake replies.
@Suite @MainActor struct WorkflowToolsTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "WorkflowToolsTests.\(UUID().uuidString)")! }
    private func makeState(_ defaults: UserDefaults? = nil) -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults ?? self.defaults())
    }

    private func snapshot(seq: Int, path: String = "/repo", branch: String = "feature/PAY-1502", reviewEndTree: String? = "b2",
                          prereviews: [PreReviewRun] = []) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: path, root: path, name: "repo", branch: branch, remoteURL: "git@ghe.example.com:acme/app.git")
        s.session = SessionInfo(open: true, starting: false, sessionId: "chat-1", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: .reviewing, canSend: true, canRequestChanges: false, blockedReason: nil, collectError: nil,
                          pendingCount: 1, changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: "a1",
                          turnEndTree: reviewEndTree, lastReviewSummary: nil)
        s.gate.reviewEndTree = reviewEndTree
        s.gate.prereviews = prereviews
        s.changedFiles = [ChangedFile(path: "api/Svc.java", oldPath: nil, status: .modified, added: 3, deleted: 1, isBinary: false,
                                      tools: ["Edit"], toolUseIds: [], state: .pending, noteCount: 0)]
        return s
    }

    /// The `set_settings` carrying the flow settings among `commands`.
    private func flowSettings(_ commands: [EngineCommand]) -> [EngineSettings] {
        commands.compactMap { command in
            if case let .setSettings(settings) = command, settings.commitTemplate != nil { return settings }
            return nil
        }
    }

    private func finding(_ id: String, _ file: String, line: Int? = nil, summary: String = "s") -> PreReviewFinding {
        PreReviewFinding(id: id, file: file, line: line, summary: summary, shortSummary: "short \(id)", failureScenario: "scenario \(id)")
    }

    private func run(_ id: String, status: PreReviewStatus = .done, source: PreReviewSource = .round, endTree: String? = "b2",
                     findings: [PreReviewFinding] = [], error: String? = nil) -> PreReviewRun {
        PreReviewRun(prereviewId: id, status: status, source: source, scope: source == .round ? .round : nil, effort: .medium,
                     endTree: endTree, startedAt: "2026-10-23T03:00:00.000Z", findings: findings, error: error)
    }

    private func comment(_ id: Int, author: String, body: String = "body", path: String = "api/Svc.java", line: Int? = 42,
                         replyTo: Int? = nil, minute: Int) -> PRComment {
        PRComment(id: id, path: path, line: line, side: "RIGHT", startLine: nil, body: body, author: author,
                  createdAt: Date(timeIntervalSince1970: TimeInterval(1_760_000_000 + minute * 60)), inReplyTo: replyTo, diffHunk: "@@")
    }

    // MARK: - §36.11 commit template

    @Test func templateTakesTheBranchsLastDigitRun() {
        #expect(CommitTemplate.issue(fromBranch: "feature/PAY-1502") == "1502")
        #expect(CommitTemplate.issue(fromBranch: "hotfix/2.1.3-fix12") == "12")
        #expect(CommitTemplate.issue(fromBranch: "main") == "")
        #expect(CommitTemplate.issue(fromBranch: nil) == "")
        #expect(CommitTemplate.render("PAY-{issue}: [{branch}]", branch: "feature/PAY-1502") == "PAY-1502: [feature/PAY-1502]")
        #expect(CommitTemplate.render("PAY-{issue}: ", branch: nil) == "PAY-: ")
    }

    @Test func perProjectSettingsAreKeptPerProject() {
        let d = defaults()
        AppSettings.setCommitTemplate("PAY-{issue}: ", root: "/a", defaults: d)
        AppSettings.setPRRespondCommand("  /acme-tools:review-reply {pr}  ", root: "/a", defaults: d)
        AppSettings.setWorkbenchSetup(WorkbenchSetup(copy: ["mvnw"], setupCommand: "make", location: .sibling), root: "/a", defaults: d)
        #expect(AppSettings.commitTemplate(root: "/a", defaults: d) == "PAY-{issue}: ")
        #expect(AppSettings.commitTemplate(root: "/b", defaults: d) == "")
        #expect(AppSettings.prRespondCommand(root: "/a", defaults: d) == "/acme-tools:review-reply {pr}")
        #expect(AppSettings.workbenchSetup(root: "/a", defaults: d).copy == ["mvnw"])
        #expect(AppSettings.workbenchSetup(root: "/b", defaults: d) == .default)
        AppSettings.setCommitTemplate("", root: "/a", defaults: d)
        #expect(AppSettings.commitTemplate(root: "/a", defaults: d) == "")
        #expect(AppSettings.preReviewEffort(defaults: d) == .medium)
        AppSettings.setPreReviewEffort(.high, defaults: d)
        #expect(AppSettings.preReviewEffort(defaults: d) == .high)
    }

    @Test func theEngineGetsTheSettingsBeforeTheCommandsThatReadThem() async {
        let d = defaults()
        AppSettings.setCommitTemplate("PAY-{issue}: ", root: "/repo", defaults: d)
        let app = makeState(d)
        var commands: [EngineCommand] = []
        app.commandSink = { commands.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        #expect(flowSettings(commands).isEmpty)   // opening a project sends nothing more (other tests count the commands)
        app.replySink = { _ in .workbenchPreview(WorkbenchPreviewReply(path: "/w")) }
        await app.flow.loadPreview(WorkbenchPreviewRequest(branch: "b"))
        guard let settings = flowSettings(commands).last else { Issue.record("no set_settings"); return }
        #expect(settings.commitTemplate == "PAY-{issue}: ")
        #expect(settings.workbenchSetup == .default)
        commands = []
        await app.flow.loadPreview(WorkbenchPreviewRequest(branch: "c"))
        #expect(flowSettings(commands).isEmpty)   // this engine has them
        app.handle(.state(snapshot(seq: 2, path: "/other")))
        await app.flow.loadPreview(WorkbenchPreviewRequest(branch: "b"))
        guard let other = flowSettings(commands).last else { Issue.record("no set_settings"); return }
        #expect(other.commitTemplate == "")   // clears the previous project's template in this engine
    }

    @Test func aWorkbenchSharesItsRepositorysSettings() {
        let d = defaults()
        AppSettings.setCommitTemplate("PAY-{issue}: ", root: "/repo", defaults: d)
        let app = makeState(d)
        var commands: [EngineCommand] = []
        app.commandSink = { commands.append($0) }
        var s = snapshot(seq: 1, path: "/w/acme-1600", branch: "feature/PAY-1600")
        s.workbenches = WorkbenchesInfo(list: [
            WorkbenchInfo(path: "/repo", branch: "develop", head: "a", isMain: true, isCurrent: false, locked: nil, dirty: nil),
            WorkbenchInfo(path: "/w/acme-1600", branch: "feature/PAY-1600", head: "b", isMain: false, isCurrent: true, locked: nil, dirty: nil),
        ], current: "/w/acme-1600", managedRoot: "/w")
        app.handle(.state(s))
        #expect(app.flowSettingsRoot == "/repo")
        #expect(app.commitTemplate == "PAY-{issue}: ")
        app.pushFlowSettings()
        #expect(flowSettings(commands).last?.commitTemplate == "PAY-{issue}: ")
        app.setPRRespondCommand("/acme-tools:review-reply {pr}")
        #expect(AppSettings.prRespondCommand(root: "/repo", defaults: d) == "/acme-tools:review-reply {pr}")
    }

    @Test func draftFillsTheFieldAfterSendingTheTemplate() async {
        let d = defaults()
        AppSettings.setCommitTemplate("PAY-{issue}: ", root: "/repo", defaults: d)
        let app = makeState(d)
        var commands: [EngineCommand] = []
        app.commandSink = { commands.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        app.pushFlowSettings()   // an editor closed: the engine has the template
        commands = []
        app.setCommitTemplate("PAY-{issue} ")   // edited since (the editor pushes when it closes)
        app.replySink = { command in
            commands.append(command)
            return .commitDraft(CommitDraftReply(id: "c1", message: "  PAY-1502: 중복 차감 방지\n\n- 조건 수정\n "))
        }
        let message = await app.flow.draftCommitMessage(paths: ["api/Svc.java"])
        #expect(message == "PAY-1502: 중복 차감 방지\n\n- 조건 수정")
        #expect(app.flow.commitDraftError == nil)
        #expect(!app.flow.isDraftingCommit)
        let relevant = { commands.filter { command in
            switch command {
            case .setSettings, .commitDraft: true
            default: false
            }
        } }
        #expect(relevant().count == 2)
        guard case let .setSettings(sent) = relevant().first, case let .commitDraft(paths) = relevant().last else { Issue.record("order"); return }
        #expect(sent.commitTemplate == "PAY-{issue} ")   // the template as it is now, before the fork reads it
        #expect(paths == ["api/Svc.java"])
        commands = []
        _ = await app.flow.draftCommitMessage(paths: nil)
        #expect(relevant().count == 1)   // the engine has it already: no repeat
        #expect(app.transcript.isEmpty)   // the main chat is untouched
    }

    @Test func draftRefusalsAreOneLineAndAnOlderEngineTurnsTheButtonOff() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        app.replySink = { _ in throw EngineClientError.refused("commit_draft_failed:the fork answered nothing", code: "commit_draft_failed") }
        #expect(await app.flow.draftCommitMessage(paths: nil) == nil)
        #expect(app.flow.commitDraftError?.contains("the fork answered nothing") == true)
        #expect(app.flow.commitDraftSupported)
        app.replySink = { _ in .commitDraft(CommitDraftReply(message: "   ")) }
        #expect(await app.flow.draftCommitMessage(paths: nil) == nil)
        #expect(app.flow.commitDraftError?.isEmpty == false)
        app.replySink = { _ in throw EngineClientError.refused("unknown command: commit_draft") }
        #expect(await app.flow.draftCommitMessage(paths: nil) == nil)
        #expect(!app.flow.commitDraftSupported)
        #expect(app.flow.commitDraftError == FlowText.updateReason)
        #expect(app.errorBanner == nil)
    }

    @Test func aDraftFinishingAfterAProjectSwitchIsDroppedAndLeavesTheNewDraftsFlag() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        // Each draft's reply waits until the test lets that call (1, 2) go.
        var calls = 0
        var released: Set<Int> = []
        app.replySink = { command in
            guard case .commitDraft = command else { throw EngineClientError.stopped }   // the project switch asks other things too
            calls += 1
            let call = calls
            for _ in 0..<1000 where !released.contains(call) { await Task.yield() }
            return .commitDraft(CommitDraftReply(message: "draft \(call)"))
        }
        func waitForCalls(_ n: Int) async { for _ in 0..<1000 where calls < n { await Task.yield() } }
        let old = Task { await app.flow.draftCommitMessage(paths: nil) }
        await waitForCalls(1)
        #expect(app.flow.isDraftingCommit)
        // Another worktree opens while it runs, and a draft is started there.
        app.handle(.state(snapshot(seq: 2, path: "/w/feature")))
        #expect(!app.flow.isDraftingCommit)
        let current = Task { await app.flow.draftCommitMessage(paths: nil) }
        await waitForCalls(2)
        #expect(app.flow.isDraftingCommit)
        // The old one finishes first: nothing of it lands, and the newer draft is still shown as running.
        released.insert(1)
        let oldResult = await old.value
        #expect(oldResult == nil)
        #expect(app.flow.finishedCommitDraft == nil && app.flow.commitDraftError == nil)
        #expect(app.flow.isDraftingCommit)
        released.insert(2)
        let currentResult = await current.value
        #expect(currentResult == "draft 2")
        #expect(app.flow.finishedCommitDraft == "draft 2" && !app.flow.isDraftingCommit)
    }

    // MARK: - §36.12 workbench setup

    @Test func previewAnswersOnlyTheRequestItWasAskedFor() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        app.replySink = { command in
            guard case let .workbenchPreview(branch, _, location) = command else { throw EngineClientError.stopped }
            return .workbenchPreview(WorkbenchPreviewReply(path: "/x/\(branch)-\(location?.rawValue ?? "")", copy: [WorkbenchCopyItem(path: "mvnw", bytes: 10)], totalBytes: 10))
        }
        let request = WorkbenchPreviewRequest(branch: "feature/PAY-1600", from: "origin/develop", location: .sibling)
        await app.flow.loadPreview(request)
        #expect(app.flow.preview(for: request)?.path == "/x/feature/PAY-1600-sibling")
        #expect(app.flow.preview(for: WorkbenchPreviewRequest(branch: "other")) == nil)
        #expect(!app.flow.isLoadingPreview)
        app.replySink = { _ in throw EngineClientError.refused("unknown command: workbench_preview") }
        await app.flow.loadPreview(WorkbenchPreviewRequest(branch: "b"))
        #expect(!app.flow.previewSupported)
        #expect(app.flow.previewError == nil)
    }

    @Test func createStepsCollectForTheBranchBeingCreated() {
        let app = makeState()
        app.flow.beginCreate(branch: "feature/PAY-1600")
        app.handle(.workbenchProgress(WorkbenchProgress(path: "/w/acme-1600", branch: "feature/PAY-1600", step: .create)))
        app.handle(.workbenchProgress(WorkbenchProgress(path: "/w/x", branch: "another", step: .create)))   // another window's
        app.handle(.workbenchProgress(WorkbenchProgress(path: "/w/acme-1600", branch: "feature/PAY-1600", step: .fetch, exit: .code(0))))
        app.handle(.workbenchProgress(WorkbenchProgress(path: "/w/acme-1600", branch: "feature/PAY-1600", step: .setup, logTail: "[ERROR] BUILD FAILURE", exit: .code(1))))
        #expect(app.flow.progress.map(\.step) == [.fetch, .create, .setup])
        #expect(app.flow.setupFailed)
        #expect(app.flow.createdPath == "/w/acme-1600")
        app.handle(.workbenchProgress(WorkbenchProgress(path: "/w/acme-1600", branch: "feature/PAY-1600", step: .setup, logTail: "ok", exit: .code(0))))
        #expect(app.flow.progress.count == 3)   // one entry per step: the latest
        #expect(!app.flow.setupFailed)
        app.flow.endCreate()
        app.handle(.workbenchProgress(WorkbenchProgress(path: "/w/late", branch: "feature/PAY-1600", step: .done)))
        #expect(app.flow.progress.count == 3)   // nothing in flight: ignored
        #expect(app.flow.createdPath == "/w/acme-1600")
    }

    @Test func theSheetStartsFromTheRemoteTwinOfTheMainBranch() {
        let remotes = ["upstream/develop", "origin/develop", "origin/feature/PAY-1502", "origin/main"]
        #expect(WorkbenchDefaults.base(current: "feature/PAY-1502", mainBranch: "develop", remotes: remotes, fetchBase: true, supportsSetup: true) == "origin/develop")
        #expect(WorkbenchDefaults.base(current: "feature/PAY-1502", mainBranch: nil, remotes: remotes, fetchBase: true, supportsSetup: true) == "origin/feature/PAY-1502")
        #expect(WorkbenchDefaults.base(current: "local-only", mainBranch: "release", remotes: remotes, fetchBase: true, supportsSetup: true) == "local-only")
        #expect(WorkbenchDefaults.base(current: "feature/PAY-1502", mainBranch: "develop", remotes: remotes, fetchBase: false, supportsSetup: true) == "feature/PAY-1502")
        #expect(WorkbenchDefaults.base(current: "feature/PAY-1502", mainBranch: "develop", remotes: remotes, fetchBase: true, supportsSetup: false) == "feature/PAY-1502")
        // "acme/1502" is not a twin of "origin/feature/PAY-1502".
        #expect(WorkbenchDefaults.base(current: "acme/1502", mainBranch: nil, remotes: remotes, fetchBase: true, supportsSetup: true) == "acme/1502")
    }

    @Test func workbenchSetupNeedsAnEngineThatListsRemotes() {
        let app = makeState()
        var s = snapshot(seq: 1)
        app.handle(.state(s))
        #expect(!app.supportsWorkbenchSetup)
        s.seq = 2
        s.branches.remotes = RemoteBranchList([BranchInfo(name: "origin/develop", isCurrent: false, upstream: nil, ahead: 0, behind: 0, lastCommitDate: nil)])
        app.handle(.state(s))
        #expect(app.supportsWorkbenchSetup)
        #expect(app.remoteBranches.map(\.name) == ["origin/develop"])
    }

    // MARK: - §36.13 pre-review display

    @Test func onlyTheNewestRoundRunAndTheMainChatsRunsShow() {
        let runs = [
            run("toolu_2", source: .main, findings: [finding("f1", "a.ts", line: 3)]),
            run("pr-2", findings: [finding("f1", "a.ts", line: 3), finding("f2", "b.ts")]),
            run("pr-1", findings: [finding("f9", "c.ts", line: 1)]),
        ]
        #expect(PreReviewDisplay.shownRuns(runs).map(\.prereviewId) == ["toolu_2", "pr-2"])
        #expect(PreReviewDisplay.counts(runs) == ["a.ts": 2, "b.ts": 1])
        #expect(PreReviewDisplay.findings(runs, path: "a.ts", line: 3).count == 2)
        #expect(PreReviewDisplay.findings(runs, path: "c.ts").isEmpty)
        // b.ts has a whole-file finding; a.ts:3 is placed when line 3 is on screen, unplaced otherwise.
        #expect(PreReviewDisplay.unplacedFindings(runs, path: "b.ts", newLines: [1, 2]).map(\.finding.id) == ["f2"])
        #expect(PreReviewDisplay.unplacedFindings(runs, path: "a.ts", newLines: [3]).isEmpty)
        #expect(PreReviewDisplay.unplacedFindings(runs, path: "a.ts", newLines: [10]).count == 2)
    }

    @Test func headStatusFollowsTheNewestRoundRun() {
        #expect(PreReviewDisplay.headStatus([], reviewEndTree: "b2") == .idle)
        #expect(PreReviewDisplay.headStatus([run("pr-1", status: .running)], reviewEndTree: "b2") == .running(prereviewId: "pr-1"))
        #expect(PreReviewDisplay.headStatus([run("pr-1", findings: [finding("f1", "a.ts")])], reviewEndTree: "b2") == .done(count: 1, stale: false))
        #expect(PreReviewDisplay.headStatus([run("pr-1", findings: [finding("f1", "a.ts")])], reviewEndTree: "b3") == .done(count: 1, stale: true))
        #expect(PreReviewDisplay.headStatus([run("pr-1", status: .cancelled)], reviewEndTree: "b2") == .idle)
        #expect(PreReviewDisplay.headStatus([run("toolu_1", source: .main, findings: [finding("f1", "a.ts")])], reviewEndTree: "b2")
            == .done(count: 1, stale: false))
        guard case let .failed(reason) = PreReviewDisplay.headStatus([run("pr-1", status: .failed, error: "side_limit")], reviewEndTree: "b2") else {
            Issue.record("not failed"); return
        }
        #expect(reason == FlowText.refusal(code: "side_limit", detail: ""))
        guard case let .failed(raw) = PreReviewDisplay.headStatus([run("pr-1", status: .failed, error: "the CLI exited with 1")], reviewEndTree: "b2") else {
            Issue.record("not failed"); return
        }
        #expect(raw == "the CLI exited with 1")
        #expect(FlowText.preReviewFailure("interrupted (ReviewGate was closed)") != "interrupted (ReviewGate was closed)")
    }

    @Test func aFindingBecomesANoteBodyAndASideQuestion() {
        let f = PreReviewFinding(id: "f1", file: "a.ts", line: 4, summary: " Off by one in the loop ", shortSummary: "off by one",
                                 failureScenario: "last item skipped ")
        #expect(PreReviewDisplay.noteBody(f) == "Off by one in the loop\nlast item skipped")
        #expect(PreReviewDisplay.noteBody(PreReviewFinding(id: "f2", file: "a.ts", summary: "", shortSummary: "short")) == "short")
        #expect(PreReviewDisplay.sideQuestion(f).contains("Off by one in the loop"))
    }

    // MARK: - §36.13 the store

    @Test func runsComeFromRepliesEventsAndTheSnapshot() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        app.replySink = { command in
            guard case let .prereviewStart(scope, _, effort) = command else { throw EngineClientError.stopped }
            #expect(scope == .round)
            #expect(effort == .low)
            return .prereview(PreReviewReply(id: "r1", run: self.run("pr-1", status: .running)))
        }
        #expect(await app.flow.startPreReview(scope: .round, effort: .low))
        #expect(app.preReviewStatus == .running(prereviewId: "pr-1"))
        #expect(app.preReviewBlocker != nil)   // one round run at a time
        app.handle(.prereview(PreReviewReply(run: run("pr-1", findings: [finding("f1", "api/Svc.java", line: 42)]))))
        #expect(app.preReviewStatus == .done(count: 1, stale: false))
        #expect(app.preReviewCounts == ["api/Svc.java": 1])
        app.handle(.prereview(PreReviewReply(run: run("toolu_7", source: .main, findings: [finding("f1", "api/Svc.java")]))))
        #expect(app.flow.runs.map(\.prereviewId) == ["toolu_7", "pr-1"])
        // The engine's list wins when it changes (a finished round drops the runs).
        app.handle(.state(snapshot(seq: 2, prereviews: [])))
        #expect(app.flow.runs.map(\.prereviewId) == ["toolu_7", "pr-1"])   // unchanged list ([] → []): events stay
        app.handle(.state(snapshot(seq: 3, prereviews: [run("pr-1", findings: [])])))
        #expect(app.flow.runs.map(\.prereviewId) == ["pr-1"])
        app.handle(.state(snapshot(seq: 4, prereviews: [])))
        #expect(app.flow.runs.isEmpty)
        #expect(app.transcript.isEmpty)
    }

    @Test func startRefusalsAndAnOlderEngine() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        app.replySink = { _ in throw EngineClientError.refused("side_limit", code: "side_limit") }
        #expect(!(await app.flow.startPreReview(scope: .round, effort: .medium)))
        #expect(app.flow.preReviewError == FlowText.refusal(code: "side_limit", detail: ""))
        app.replySink = { _ in throw EngineClientError.refused("unknown command: prereview_start") }
        #expect(!(await app.flow.startPreReview(scope: .round, effort: .medium)))
        #expect(!app.flow.preReviewSupported)
        #expect(app.preReviewBlocker == FlowText.updateReason)
    }

    @Test func dismissRemovesAtOnceAndARefusalBringsTheFindingBack() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, prereviews: [run("pr-1", findings: [finding("f1", "api/Svc.java", line: 42), finding("f2", "api/Svc.java")])])))
        var sent: [EngineCommand] = []
        app.replySink = { command in sent.append(command); return .result(id: "x", ok: true, error: nil) }
        await app.flow.dismiss(finding("f1", "api/Svc.java", line: 42), of: "pr-1")
        #expect(app.flow.runs.first?.findings.map(\.id) == ["f2"])
        let dismisses = sent.compactMap { command -> (String, String)? in
            if case let .prereviewDismiss(id, findingId) = command { return (id, findingId) }
            return nil
        }
        guard let (id, findingId) = dismisses.last else { Issue.record("no dismiss"); return }
        #expect(id == "pr-1" && findingId == "f1")
        app.replySink = { _ in throw EngineClientError.refused("session_running", code: "session_running") }
        await app.flow.dismiss(finding("f2", "api/Svc.java"), of: "pr-1")
        #expect(app.flow.runs.first?.findings.map(\.id) == ["f2"])
        #expect(app.flow.preReviewError != nil)
        app.replySink = { _ in throw EngineClientError.refused("unknown_finding", code: "unknown_finding") }
        await app.flow.dismiss(finding("f2", "api/Svc.java"), of: "pr-1")
        #expect(app.flow.runs.first?.findings.isEmpty == true)   // already gone in the engine: stays gone
    }

    @Test func addAsNoteSendsAnOrdinaryNoteThenDismisses() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, prereviews: [run("pr-1", findings: [finding("f1", "api/Svc.java", line: 42, summary: "NPE")])])))
        var requested: [EngineCommand] = []
        app.requestSink = { command in if case .addNote = command { requested.append(command) } }
        app.replySink = { _ in .result(id: "x", ok: true, error: nil) }
        let f = finding("f1", "api/Svc.java", line: 42, summary: "NPE")
        #expect(await app.flow.addAsNote(f, of: "pr-1", excerpt: "return cart.get();"))
        guard case let .addNote(path, line, side, excerpt, body)? = requested.first else { Issue.record("no add_note"); return }
        #expect(path == "api/Svc.java" && line == 42 && side == .new && excerpt == "return cart.get();")
        #expect(body == "NPE\nscenario f1")
        #expect(app.flow.runs.first?.findings.isEmpty == true)
        // A refused note keeps the finding.
        app.handle(.state(snapshot(seq: 2, prereviews: [run("pr-1", findings: [finding("f3", "api/Svc.java")])])))
        app.requestSink = { _ in throw EngineClientError.refused("session_running", code: "session_running") }
        #expect(!(await app.flow.addAsNote(finding("f3", "api/Svc.java"), of: "pr-1", excerpt: "")))
        #expect(app.flow.runs.first?.findings.map(\.id) == ["f3"])
        #expect(app.flow.preReviewError != nil)
    }

    @Test func aNewProjectForgetsTheFlowState() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, prereviews: [run("pr-1", findings: [finding("f1", "a.ts")])])))
        app.flow.beginCreate(branch: "b")
        app.handle(.workbenchProgress(WorkbenchProgress(path: "/w", branch: "b", step: .create)))
        app.handle(.state(snapshot(seq: 2, path: "/other")))
        #expect(app.flow.runs.isEmpty)
        #expect(app.flow.progress.isEmpty)
        #expect(app.flow.creatingBranch == nil)
    }

    // MARK: - §36.14 PRs and Claude

    @Test func threadsAndWhatIsStillUnresolved() {
        let comments = [
            comment(1, author: "review-bot[bot]", body: "NPE when cart is null", minute: 0),
            comment(2, author: "yoon", body: "고쳤어요", replyTo: 1, minute: 5),
            comment(3, author: "kim", body: "이 쿼리 인덱스 타나요?", path: "api/Repo.java", line: 10, minute: 1),
            comment(4, author: "kim", body: "그리고 이것도", replyTo: 3, minute: 2),
            comment(5, author: "park", body: "orphan reply", replyTo: 99, minute: 3),
        ]
        let threads = PRClaude.threads(comments)
        #expect(threads.map(\.id) == [1, 3, 5])
        #expect(threads[0].replies.map(\.id) == [2])
        #expect(threads[1].last.id == 4)
        #expect(PRClaude.unresolved(threads, me: "Yoon").map(\.id) == [3, 5])   // the user answered thread 1 last
        #expect(PRClaude.unresolved(threads, me: nil).count == 3)
        #expect(PRClaude.thread(of: comments[3], in: comments)?.id == 3)
    }

    @Test func theDraftStartsWithTheRespondCommandAndQuotesTheComments() throws {
        let threads = PRClaude.threads([
            comment(3, author: "kim", body: "이 쿼리 인덱스 타나요?\n확인 부탁", path: "api/Repo.java", line: 10, minute: 1),
            comment(4, author: "kim", body: "그리고 이것도", replyTo: 3, minute: 2),
        ])
        let command = PRClaude.respondCommand("/acme-tools:review-reply {pr}", number: 512)
        #expect(command == "/acme-tools:review-reply 512")
        #expect(PRClaude.respondCommand("  ", number: 1) == nil)
        let text = PRClaude.draft(prNumber: 512, prTitle: "장바구니 정리", threads: threads, command: command)
        let lines = text.components(separatedBy: "\n")
        #expect(lines.first == "/acme-tools:review-reply 512")
        #expect(lines[1] == "")
        #expect(text.contains("512"))
        #expect(text.contains("- api/Repo.java:10 — @kim:"))
        #expect(text.contains("  > 이 쿼리 인덱스 타나요?\n  > 확인 부탁"))
        #expect(text.contains("  ↳ @kim:\n  > 그리고 이것도"))
        let plain = PRClaude.draft(prNumber: 1, prTitle: "t", threads: [PRCommentThread(root: comment(9, author: "a", line: nil, minute: 0), replies: [])], command: nil)
        #expect(!plain.hasPrefix("/"))
        #expect(plain.contains("- api/Svc.java — @a:"))   // an outdated comment has no line
    }

    @Test func prWorkbenchBranchAndRepository() {
        #expect(PRClaude.workbenchBranch(number: 512, headRef: "feature/PAY-1600", baseRef: "develop") == "feature/PAY-1600")
        #expect(PRClaude.workbenchBranch(number: 512, headRef: "develop", baseRef: "develop") == "pr-512")
        #expect(PRClaude.workbenchBranch(number: 7, headRef: " ", baseRef: "main") == "pr-7")
        #expect(PRClaude.repoSlug(remote: "git@ghe.example.com:ACME/app.git") == "acme/app")
        #expect(PRClaude.repoSlug(remote: "https://ghe.example.com/acme/app") == "acme/app")
        #expect(PRClaude.repoSlug(remote: "ssh://git@ghe.example.com:22/acme/app.git/") == "acme/app")
        #expect(PRClaude.repoSlug(remote: "/local/path") == nil)
        #expect(PRClaude.repoSlug(remote: nil) == nil)
        #expect(PRClaude.isProjectRepo(prRepo: "acme/App", remote: "git@ghe.example.com:acme/app.git"))
        #expect(!PRClaude.isProjectRepo(prRepo: "acme/other", remote: "git@ghe.example.com:acme/app.git"))
        #expect(!PRClaude.isProjectRepo(prRepo: "acme/app", remote: nil))
    }

    @Test func aPRLineAnchorCarriesItsHunkAndSide() throws {
        let lines = [
            DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -10,3 +10,4 @@"),
            DiffLine(id: 1, kind: .context, oldNo: 10, newNo: 10, text: "a"),
            DiffLine(id: 2, kind: .del, oldNo: 11, newNo: nil, text: "b"),
            DiffLine(id: 3, kind: .add, oldNo: nil, newNo: 11, text: "c"),
        ]
        let other = [DiffLine(id: 4, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -50 +51 @@"),
                     DiffLine(id: 5, kind: .context, oldNo: 50, newNo: 51, text: "z")]
        let diff = FileDiff(oldPath: "x.ts", newPath: "x.ts", isBinary: false, hunks: [DiffHunk(id: 0, header: "@@", lines: lines), DiffHunk(id: 1, header: "@@", lines: other)])
        #expect(PRClaude.hunkText(diff, around: lines[3]) == "@@ -10,3 +10,4 @@\n a\n-b\n+c\n")
        let added = try #require(PRClaude.anchor(number: 7, path: "x.ts", line: lines[3], diff: diff, commitId: "abc"))
        #expect(added.side == "RIGHT" && added.line == 11 && added.commitId == "abc")
        let deleted = try #require(PRClaude.anchor(number: 7, path: "x.ts", line: lines[2], diff: diff, commitId: nil))
        #expect(deleted.side == "LEFT" && deleted.line == 11)
        #expect(PRClaude.anchor(number: 7, path: "x.ts", line: lines[0], diff: diff, commitId: nil) == nil)
        let long = (0..<500).map { DiffLine(id: $0 + 1, kind: .add, oldNo: nil, newNo: $0, text: String(repeating: "x", count: 40)) }
        let big = FileDiff(oldPath: "x.ts", newPath: "x.ts", isBinary: false, hunks: [DiffHunk(id: 0, header: "@@", lines: long)])
        #expect(PRClaude.hunkText(big, around: long[0]).count <= SidePrAnchor.maxHunkChars)
        // The chip names the PR, not "General"; the side question's preview reads the hunk back, numbered.
        #expect(SideQuestionText.chip(SideAnchor(pr: added)).contains("#7"))
        let preview = try #require(PRClaude.previewDiff(added))
        #expect(preview.allLines.map(\.kind) == [.hunkHeader, .context, .del, .add])
        #expect(preview.allLines[3].newNo == 11 && preview.allLines[2].oldNo == 11 && preview.allLines[1].newNo == 10)
        #expect(SideAnchors.previewLines(PRClaude.previewAnchor(added), in: preview).map(\.text) == ["a", "b", "c"])
        #expect(PRClaude.previewDiff(SidePrAnchor(number: 1, path: "a", line: 1, side: "RIGHT", hunk: "+x\n")) == nil)
    }
}
