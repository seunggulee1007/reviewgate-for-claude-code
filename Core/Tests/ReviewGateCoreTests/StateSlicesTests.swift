import Foundation
import Observation
import Testing
@testable import ReviewGateCore

/// wave7 w7-state — docs/PROTOCOL.md §45.2: what views observe is one stored slice per part of the snapshot, written only
/// when it changed; the menus read one Equatable value; the diff's rows look their notes and findings up by line.
@Suite @MainActor struct StateSlicesTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "StateSlicesTests.\(UUID().uuidString)")!)
    }

    private func file(_ path: String, state: FileReviewState = .pending) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 2, deleted: 1, isBinary: false, tools: ["Edit"], state: state)
    }

    private func snapshot(seq: Int, phase: GatePhase = .reviewing, files: [ChangedFile]? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "c1", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: phase, canSend: phase != .running, canRequestChanges: false, blockedReason: nil, collectError: nil,
                          pendingCount: 1, changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: "a1",
                          turnEndTree: "b1", lastReviewSummary: nil)
        s.changedFiles = files ?? [file("src/a.ts"), file("src/b.ts", state: .accepted)]
        s.sessions = SessionsInfo(list: [SessionMeta(id: "c1", title: "first"), SessionMeta(id: "c2", title: "second")],
                                  currentId: "c1", openTabIds: ["c2"])
        s.workbenches = WorkbenchesInfo(list: [
            WorkbenchInfo(path: "/repo", branch: "main", head: "h", isMain: true, isCurrent: true, locked: nil, dirty: false),
            WorkbenchInfo(path: "/w/feature", branch: "feature", head: "f", isMain: false, isCurrent: false, locked: nil, dirty: true),
        ], current: "/repo", managedRoot: "/w")
        return s
    }

    /// A one-shot observation: `fired` turns true when anything `read` touched is about to change.
    private final class Watch: @unchecked Sendable {
        var fired = false
    }

    private func watch(_ read: () -> Void) -> Watch {
        let w = Watch()
        withObservationTracking(read) { w.fired = true }
        return w
    }

    /// Lets the menu slice's main-actor recompute run, until `until` holds.
    private func settle(sourceLocation: SourceLocation = #_sourceLocation, _ until: () -> Bool) async {
        await eventually(sourceLocation: sourceLocation, until)
    }

    /// For a check that nothing changed: 200 turns of the main actor, for a recompute that would come.
    private func letRecomputesRun() async {
        for _ in 0..<200 { await Task.yield() }
    }

    // MARK: - Slices

    @Test func aSnapshotThatChangesOnlyTheHUDTellsOnlyItsReaders() {
        let store = makeStore()
        let first = snapshot(seq: 1, phase: .running)
        store.handle(.state(first))
        var next = first
        next.seq = 2
        next.hud.activity = HUDActivity(kind: .tool, toolName: "Read", detail: "a.ts")
        next.hud.contextTokens = 1234
        let files = watch { _ = store.changedFiles }
        let selected = watch { _ = store.selectedFile }
        let running = watch { _ = store.isRunning }
        let locks = watch { _ = store.isAcceptLocked; _ = store.isRejectLocked; _ = store.isNoteLocked }
        let project = watch { _ = store.projectInfo; _ = store.projectURL; _ = store.windowTitle }
        let tabs = watch { _ = store.openTabs; _ = store.workbenches }
        let menus = watch { _ = store.menuState }
        let banners = watch { _ = store.reviewNotices; _ = store.liveChip }
        let hud = watch { _ = store.hud }
        let whole = watch { _ = store.state }
        store.handle(.state(next))
        #expect(!files.fired)
        #expect(!selected.fired)
        #expect(!running.fired)
        #expect(!locks.fired)
        #expect(!project.fired)
        #expect(!tabs.fired)
        #expect(!menus.fired)
        #expect(!banners.fired)
        #expect(hud.fired)
        #expect(whole.fired)
        #expect(store.hud.contextTokens == 1234)
        #expect(store.hud.activeTool == "Read")
        #expect(store.state.seq == 2)
    }

    @Test func aSnapshotThatChangesNothingButItsSeqTellsNobody() {
        let store = makeStore()
        let first = snapshot(seq: 1)
        store.handle(.state(first))
        var same = first
        same.seq = 2
        let hud = watch { _ = store.hud }
        let files = watch { _ = store.changedFiles }
        let whole = watch { _ = store.state }
        store.handle(.state(same))
        #expect(!hud.fired)
        #expect(!files.fired)
        #expect(!whole.fired)
        #expect(store.state.seq == 2)   // still kept: the next snapshot is compared with it
    }

    @Test func aChangedReviewTellsTheListAndNotTheHUD() {
        let store = makeStore()
        let first = snapshot(seq: 1)
        store.handle(.state(first))
        var next = first
        next.seq = 2
        next.changedFiles[0].state = .accepted
        let files = watch { _ = store.changedFiles }
        let hud = watch { _ = store.hud }
        let running = watch { _ = store.isRunning }
        store.handle(.state(next))
        #expect(files.fired)
        #expect(!hud.fired)
        #expect(!running.fired)
        #expect(store.pendingFiles.isEmpty)
    }

    @Test func theSlicesMirrorTheSnapshotAndInPlaceWritesReachThem() {
        let store = makeStore()
        let s = snapshot(seq: 1)
        store.handle(.state(s))
        #expect(store.changedFiles == s.changedFiles)
        #expect(store.projectInfo == s.project)
        #expect(store.projectURL == URL(fileURLWithPath: "/repo"))
        #expect(store.gate == s.gate)
        #expect(store.gatePhase == .reviewing)
        #expect(store.sessionInfo == s.session)
        #expect(store.workbenches == s.workbenches)
        #expect(store.commitState == .empty)
        #expect(store.openTabs.map(\.id) == ["c2", "c1"])   // the current chat always has a tab
        #expect(store.hud == HUDState(s.hud))
        // Code that writes the snapshot in place (an optimistic mode switch) reaches the slices too.
        store.state.session.permissionMode = .plan
        #expect(store.permissionMode == .plan)
        #expect(store.sessionInfo.permissionMode == .plan)
        store.state.budget = Budget(maxFiles: 3, maxLines: 30)
        #expect(store.budget == Budget(maxFiles: 3, maxLines: 30))
    }

    @Test func theProjectURLIsStoredAndChangesWithTheProjectOnly() {
        let store = makeStore()
        #expect(store.projectURL == nil)
        store.handle(.state(snapshot(seq: 1)))
        let url = store.projectURL
        var other = snapshot(seq: 2)
        other.hud.turnCount = 3
        let watcher = watch { _ = store.projectURL }
        store.handle(.state(other))
        #expect(!watcher.fired)
        #expect(store.projectURL == url)
        #expect(store.hudTurnCount == 3)
        var gitInit = ReviewState.empty
        gitInit.seq = 3
        gitInit.gitInit = GitInitInfo(path: "/not-a-repo", candidates: [], looksUnsafe: false)
        store.handle(.state(gitInit))
        #expect(store.projectURL == URL(fileURLWithPath: "/not-a-repo"))
        #expect(store.needsGitInit)
    }

    // MARK: - The menus' slice

    @Test func theMenuSliceFollowsWhatTheMenusShowAndNothingElse() async {
        let store = makeStore()
        #expect(store.menuState == MenuState())
        store.handle(.state(snapshot(seq: 1)))
        await settle { store.menuState.hasProject }
        var menu = store.menuState
        #expect(menu.hasProject)
        #expect(menu.hasPending && menu.canAcceptAll && menu.canRejectAll)
        #expect(menu.workbenches.map(\.path) == ["/repo", "/w/feature"])
        #expect(menu.workbenches.map(\.isCurrent) == [true, false])
        #expect(menu.workbenches[1].dirty == true)
        #expect(menu.chatTabs.map(\.id) == ["c2", "c1"])
        #expect(menu.chatTabs.map(\.isCurrent) == [false, true])
        #expect(!menu.chatSwitchBlocked)
        // A selection is client state: the menu follows it too.
        store.selectedPath = "src/a.ts"
        await settle { store.menuState.canAcceptSelected }
        menu = store.menuState
        #expect(menu.canAcceptSelected && menu.canRejectSelected)
        // The HUD moving (a running turn's activity) leaves the menus alone.
        let watcher = watch { _ = store.menuState }
        var hudOnly = snapshot(seq: 2)
        hudOnly.hud.activity = HUDActivity(kind: .thinking, toolName: nil, detail: nil)
        store.handle(.state(hudOnly))
        await letRecomputesRun()
        #expect(!watcher.fired)
        #expect(store.menuState == menu)
        // A running turn locks reject and the chat switch: the menus say so.
        store.handle(.state(snapshot(seq: 3, phase: .running)))
        await settle { store.menuState.chatSwitchBlocked }
        #expect(store.menuState.chatSwitchBlocked)
        #expect(!store.menuState.canRejectAll)
        #expect(!store.menuState.canRejectSelected)
    }

    @Test func acceptAndRejectSelectedWaitWhileAnotherFileCoversTheDiff() async {
        let store = makeStore()
        store.replySink = { command in
            guard case let .projectFile(path) = command else { throw EngineClientError.refused("unknown command", code: "unknown_command") }
            return .projectFile(ProjectFileReply(path: path, lines: ["one"], size: 3))
        }
        store.commandSink = { _ in }
        store.handle(.state(snapshot(seq: 1)))
        store.selectedPath = "src/a.ts"
        await settle { store.menuState.canAcceptSelected }
        #expect(store.menuState.canAcceptSelected && store.menuState.canRejectSelected)
        // ⌘P over the diff: ⌘⇧A / ⌘⇧R would act on a file the user cannot see.
        #expect(store.openProjectFile(path: "src/other.ts"))
        await settle { !store.menuState.canAcceptSelected }
        #expect(!store.menuState.canAcceptSelected && !store.menuState.canRejectSelected)
        store.closeProjectFile()
        await settle { store.menuState.canAcceptSelected }
        #expect(store.menuState.canAcceptSelected && store.menuState.canRejectSelected)
        // A past round's file, and the running turn's file, cover it the same way.
        await store.openHistoryDiff(entryId: "e1", path: "src/a.ts")
        await settle { !store.menuState.canAcceptSelected }
        #expect(!store.menuState.canAcceptSelected && !store.menuState.canRejectSelected)
        store.closeHistoryDiff()
        await settle { store.menuState.canAcceptSelected }
        store.liveSelection = "src/a.ts"
        await settle { !store.menuState.canAcceptSelected }
        #expect(!store.menuState.canAcceptSelected && !store.menuState.canRejectSelected)
        store.closeLiveDiff()
        await settle { store.menuState.canAcceptSelected }
        #expect(store.menuState.canAcceptSelected && store.menuState.canRejectSelected)
    }

    // MARK: - Notes and findings by line

    @Test func notesByLineAreTheInlineNotesOfEveryLine() {
        let notes = [
            ReviewNote(id: "n1", path: "a.ts", line: 3, side: .new, excerpt: "x", body: "one"),
            ReviewNote(id: "n2", path: "a.ts", line: 3, side: .new, excerpt: "x", body: "two"),
            ReviewNote(id: "n3", path: "a.ts", line: 3, side: .old, excerpt: "y", body: "old side"),
            ReviewNote(id: "n4", path: "a.ts", line: 7, side: .new, excerpt: "z", body: "gone", anchor: .gone),
            ReviewNote(id: "n5", path: "b.ts", line: 3, side: .new, excerpt: "x", body: "other file"),
            ReviewNote(id: "n6", path: "a.ts", line: nil, side: .new, excerpt: "", body: "whole file"),
        ]
        for since in [DiffSince.review, .turn] {
            let byLine = NotePlacement.inlineByLine(notes, path: "a.ts", since: since)
            for side in [DiffSide.new, .old] {
                for line in 0...8 {
                    let expected = NotePlacement.inline(notes, path: "a.ts", side: side, line: line, since: since)
                    #expect((byLine[NotePlacement.LineKey(side: side, line: line)] ?? []) == expected)
                }
            }
        }
        #expect(NotePlacement.inlineByLine(notes, path: "a.ts", since: .review)[.init(side: .new, line: 3)]?.map(\.id) == ["n1", "n2"])
    }

    @Test func findingsByLineAreTheFindingsOfEveryLine() {
        let findings = [
            PreReviewFinding(id: "f1", file: "a.ts", line: 4, summary: "s", shortSummary: "s1", failureScenario: "x"),
            PreReviewFinding(id: "f2", file: "a.ts", line: 4, summary: "s", shortSummary: "s2", failureScenario: "x"),
            PreReviewFinding(id: "f3", file: "a.ts", line: nil, summary: "s", shortSummary: "s3", failureScenario: "x"),
            PreReviewFinding(id: "f4", file: "b.ts", line: 4, summary: "s", shortSummary: "s4", failureScenario: "x"),
        ]
        let runs = [PreReviewRun(prereviewId: "r1", status: .done, source: .round, scope: .round, effort: .medium, endTree: "b1",
                                 startedAt: "2026-10-27T00:00:00.000Z", findings: findings, error: nil)]
        let byLine = PreReviewDisplay.findingsByLine(runs, path: "a.ts")
        for line in 0...6 {
            #expect((byLine[line] ?? []) == PreReviewDisplay.findings(runs, path: "a.ts", line: line))
        }
        #expect(byLine[4]?.map(\.finding.id) == ["f1", "f2"])
        #expect(byLine.count == 1)
    }

    // MARK: - The full file's rows (one List row each)

    @Test func theFullFileRowsAreItsLinesWithTheDeletedOnesAfterThem() {
        let view = FullFileView(path: "a.ts", lines: ["a", "b", "c"], changedNewLines: [2], deletedAfterNewLine: [0: ["x"], 2: ["y", "z"]],
                                isBinary: false, isTooLarge: false)
        #expect(view.rows == [.deleted(anchor: 0, offset: 0), .line(1), .line(2), .deleted(anchor: 2, offset: 0),
                              .deleted(anchor: 2, offset: 1), .line(3)])
        let emptied = FullFileView(path: "e.ts", lines: [], changedNewLines: [], deletedAfterNewLine: [0: ["gone"]], isBinary: false, isTooLarge: false)
        #expect(emptied.rows == [.deleted(anchor: 0, offset: 0)])
    }
}
