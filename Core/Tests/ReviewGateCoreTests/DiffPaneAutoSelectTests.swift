import Foundation
import Testing
@testable import ReviewGateCore

/// The diff pane never sits on "Select a file" while files wait: the first pending file on screen opens by itself — never
/// over the user's own pick, never while another file is read in the pane.
@Suite @MainActor struct DiffPaneAutoSelectTests {
    private func makeState(riskOrder: Bool = true) -> AppState {
        let defaults = UserDefaults(suiteName: "DiffPaneAutoSelectTests.\(UUID().uuidString)")!
        defaults.set(riskOrder, forKey: AppSettings.Key.changedFilesRiskOrder)
        return AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
    }

    /// No review tree (an engine before §34, or a turn on a fresh review): the snapshot itself selects nothing.
    private func snapshot(seq: Int, files: [ChangedFile], start: String = "A1") -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: .reviewing, canSend: true, canRequestChanges: true, blockedReason: nil, collectError: nil,
                          pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: start, turnEndTree: nil, lastReviewSummary: nil)
        s.changedFiles = files
        return s
    }

    private let files: [ChangedFile] = [
        ChangedFile(path: "a.ts", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .accepted),
        ChangedFile(path: "b.ts", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .pending),
        ChangedFile(path: ".github/workflows/ci.yml", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .pending),
    ]

    @Test func nothingSelectedOpensTheFirstPendingFileInTheListsOrder() {
        let risk = makeState()
        risk.handle(.state(snapshot(seq: 1, files: files)))
        #expect(risk.selectedPath == nil)
        #expect(risk.selectFirstPendingIfNoneSelected())
        #expect(risk.selectedPath == ".github/workflows/ci.yml")   // risk first: the workflow is the first row on screen

        let plain = makeState(riskOrder: false)
        plain.handle(.state(snapshot(seq: 1, files: files)))
        #expect(plain.selectFirstPendingIfNoneSelected())
        #expect(plain.selectedPath == "b.ts")   // git order: a.ts is accepted, b.ts the first pending one
    }

    @Test func theUsersPickStays() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, files: files)))
        app.selectedPath = "a.ts"   // an accepted file the user reads
        #expect(!app.selectFirstPendingIfNoneSelected())
        #expect(app.selectedPath == "a.ts")

        // A selection the user cleared stays cleared — until a new review.
        app.selectedPath = nil
        #expect(!app.selectFirstPendingIfNoneSelected())
        #expect(app.selectedPath == nil)
        app.handle(.state(snapshot(seq: 2, files: files, start: "A2")))
        #expect(app.selectFirstPendingIfNoneSelected())
        #expect(app.selectedPath == ".github/workflows/ci.yml")
    }

    @Test func neverWhileAnotherFileIsReadOrNothingWaits() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, files: files)))
        app.liveSelection = "b.ts"   // the running turn's change on screen
        #expect(!app.selectFirstPendingIfNoneSelected())
        #expect(app.selectedPath == nil)
        app.liveSelection = nil

        let done = makeState()
        done.handle(.state(snapshot(seq: 1, files: [file("a.ts", .accepted), file("b.ts", .rejected)])))
        #expect(!done.selectFirstPendingIfNoneSelected())
        #expect(done.selectedPath == nil)
    }
}
