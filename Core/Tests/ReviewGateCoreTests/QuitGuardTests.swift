import Foundation
import Testing
@testable import ReviewGateCore

// MARK: polish p-lifecycle — P1-chrome-01 / P1-chrome-03 / P1-chrome-04 / P2-review-21 / P3-transcript-29 / P4-composer-07:
// what quitting, closing a window or switching its project stops, loses and keeps, and when the app asks (§55.7).
@Suite @MainActor struct QuitGuardTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "QuitGuardTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase, pending: Int = 0, tasks: Int = 0, notes: [Bool] = [], prDrafts: Int = 0) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme-api", root: "/work/acme-api", name: "acme-api", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: nil, canRestart: true)
        s.session.backgroundTasks = (0..<tasks).map { BackgroundTaskInfo(taskId: "b\($0)", description: "npm run dev") }
        let canSend = phase == .reviewing || phase == .idle
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: pending, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: pending > 0 ? "B\(seq)" : nil, lastReviewSummary: nil)
        s.changedFiles = (0..<pending).map {
            ChangedFile(path: "f\($0).txt", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .pending)
        }
        s.reviewNotes = notes.enumerated().map { i, sent in
            ReviewNote(id: "n\(i)", path: "f0.txt", line: 1, side: .new, excerpt: "x", body: "why?",
                       sent: sent ? NoteSent(at: "2026-11-01T00:00:00Z", turn: 1) : nil)
        }
        s.pr.draftComments = (0..<prDrafts).map { DraftComment(path: "f0.txt", line: $0 + 1, side: "RIGHT", body: "nit") }
        return s
    }

    @Test func aWindowSaysWhatStopsWhatIsLostAndWhatStays() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        #expect(app.quitReasons().isEmpty)
        app.handle(.state(snapshot(seq: 2, phase: .running, pending: 2, tasks: 1, notes: [false, true], prDrafts: 2)))
        let reasons = app.quitReasons(draft: true, draftImages: 2)
        #expect(reasons == [.working, .backgroundTasks(1), .images(2), .prDrafts(2), .pendingReview(2), .unsentNotes(1), .draft])
        #expect(reasons.filter(\.stops) == [.working, .backgroundTasks(1)])
        #expect(reasons.filter(\.loses) == [.images(2), .prDrafts(2)])
        #expect(app.quitDisplayName == "acme-api")
    }

    @Test func quittingAsksWhileTheSettingIsOnAndTheWorkingSwitchDecidesWhileWorkWouldStop() {
        let idle = [WindowQuitState(name: "acme-api", reasons: [])]
        // "Ask before quitting" (default on): asked even when nothing runs; "Don't ask again" is offered then.
        let asked = QuitPrompt.make(idle, kind: .quit, confirmQuit: true, confirmWhileWorking: true, reopenCount: 1)
        #expect(asked?.title == QuitText.title)
        #expect(asked?.offersSuppression == true)
        #expect(asked?.cancelIsDefault == false)
        #expect(asked?.message == [QuitText.sessionsEnd(1), QuitText.reopen(1)].joined(separator: "\n"))
        #expect(QuitPrompt.make(idle, kind: .quit, confirmQuit: false, confirmWhileWorking: true, reopenCount: 1) == nil)
        // Work that would stop: asked whatever "Ask before quitting" says — the working switch decides; no "Don't ask again".
        let busy = [WindowQuitState(name: "acme-api", reasons: [.working, .backgroundTasks(2)]), WindowQuitState(name: "acme-web", reasons: [])]
        let stop = QuitPrompt.make(busy, kind: .quit, confirmQuit: false, confirmWhileWorking: true, reopenCount: nil)
        #expect(stop?.offersSuppression == false)
        #expect(stop?.message == [QuitText.line(.working, window: "acme-api"), QuitText.line(.backgroundTasks(2), window: "acme-api")].joined(separator: "\n"))
        #expect(QuitText.line(.backgroundTasks(2), window: "acme-api") == "acme-api: " + QuitText.line(.backgroundTasks(2), window: nil))
        #expect(QuitPrompt.make(busy, kind: .quit, confirmQuit: true, confirmWhileWorking: false, reopenCount: nil) == nil)
    }

    @Test func theLastWindowSaysItQuitsWhatIsLostAndWhatComesBack() {
        let w = WindowQuitState(name: "acme-api", reasons: [.images(1), .queued(2), .pendingReview(3), .unsentNotes(1)],
                                unsavedLines: ["You are writing a review note."])
        let prompt = QuitPrompt.make([w], kind: .lastWindow, confirmQuit: true, confirmWhileWorking: true, reopenCount: 1)
        let paragraphs = prompt?.message.components(separatedBy: "\n\n") ?? []
        #expect(paragraphs.first == QuitText.lastWindowQuits)
        // What is lost, under the window's name: the registered lines, then the images.
        #expect(paragraphs.dropFirst().first == ["acme-api: You are writing a review note.", QuitText.line(.images(1), window: "acme-api")].joined(separator: "\n"))
        // What stays: the sessions end (nothing runs), the notes and pending files in one line, the queue, the typing, the reopen.
        let stays = paragraphs.last?.components(separatedBy: "\n") ?? []
        #expect(stays.count == 5)
        #expect(stays.first == QuitText.sessionsEnd(1))
        let notesAndFiles = stays.dropFirst().first ?? ""
        #expect(notesAndFiles.hasPrefix("acme-api: ") && notesAndFiles.contains("3") && notesAndFiles.contains("1"))
        #expect(notesAndFiles != QuitText.line(.pendingReview(3), window: "acme-api"))
        #expect(Array(stays.dropFirst(2)) == [QuitText.line(.queued(2), window: "acme-api"), QuitText.notesAndDraftStay, QuitText.reopen(1)])
        // Something would be lost: Cancel is the default button, and the working switch decides.
        #expect(prompt?.cancelIsDefault == true)
        #expect(prompt?.offersSuppression == false)
        #expect(QuitPrompt.make([w], kind: .lastWindow, confirmQuit: true, confirmWhileWorking: false, reopenCount: 1) == nil)
    }

    @Test func pendingFilesAloneAndTheQueueStayLineByLine() {
        let w = WindowQuitState(name: "acme-api", reasons: [.pendingReview(2), .queued(1), .draft])
        let prompt = QuitPrompt.make([w], kind: .quit, confirmQuit: true, confirmWhileWorking: true, reopenCount: nil)
        #expect(prompt?.message == [QuitText.sessionsEnd(1), QuitText.line(.pendingReview(2), window: "acme-api"),
                                    QuitText.line(.queued(1), window: "acme-api"), QuitText.notesAndDraftStay].joined(separator: "\n"))
        // Nothing stops or is lost: "Don't ask again" (it turns off "Ask before quitting" only).
        #expect(prompt?.offersSuppression == true)
    }

    @Test func closingOneWindowAsksOnlyForWorkAndNamesWhy() {
        #expect(QuitPrompt.close(WindowQuitState(name: "a", reasons: [.pendingReview(2), .draft]), confirmWhileWorking: true) == nil)
        let waiting = QuitPrompt.close(WindowQuitState(name: "a", reasons: [.waiting, .sideQuestions(1)]), confirmWhileWorking: true)
        #expect(waiting?.title == CloseGuardText.title(for: .waiting))
        #expect(waiting?.title != CloseGuardText.title(for: .working))
        #expect(waiting?.message == [CloseGuardText.message(.waiting), QuitText.line(.sideQuestions(1), window: nil), QuitText.whatStays].joined(separator: "\n\n"))
        #expect(waiting?.confirm == CloseGuardText.closeButton)
        let agents = QuitPrompt.close(WindowQuitState(name: "a", reasons: [.backgroundAgents(2)]), confirmWhileWorking: true)
        #expect(agents?.title == QuitText.closeWindowTitle)
        let note = QuitPrompt.close(WindowQuitState(name: "a", reasons: [], unsavedLines: ["You are writing a review note."]), confirmWhileWorking: true)
        #expect(note?.cancelIsDefault == true)
        #expect(QuitPrompt.close(WindowQuitState(name: "a", reasons: [.working]), confirmWhileWorking: false) == nil)
    }

    @Test func switchingOrClosingTheProjectStopsTheTurnAndSaysSo() {
        let working = WindowQuitState(name: "acme-api", reasons: [.working, .pendingReview(1)])
        let switching = QuitPrompt.projectChange(working, .switchProject, confirmWhileWorking: true)
        #expect(switching?.title == CloseGuardText.title(for: .working))
        #expect(switching?.message == [QuitText.switchStops, QuitText.whatStays].joined(separator: "\n\n"))
        #expect(switching?.confirm == QuitText.switchButton)
        let closing = QuitPrompt.projectChange(WindowQuitState(name: "acme-api", reasons: [.waiting]), .closeProject, confirmWhileWorking: true)
        #expect(closing?.title == CloseGuardText.title(for: .waiting))
        #expect(closing?.message.hasPrefix(QuitText.closeProjectStops) == true)
        #expect(closing?.confirm == QuitText.closeProjectButton)
        // Idle (the pending review has its own question), or the question turned off: no prompt.
        #expect(QuitPrompt.projectChange(WindowQuitState(name: "acme-api", reasons: [.pendingReview(1)]), .switchProject, confirmWhileWorking: true) == nil)
        #expect(QuitPrompt.projectChange(working, .switchProject, confirmWhileWorking: false) == nil)
    }
}

@Suite struct SystemQuitTests {
    @Test func aLogoutRestartOrShutDownQuitsWithoutTheQuestion() {
        #expect(SystemQuit.fourCharCode("logo") == 0x6C6F_676F)
        #expect(SystemQuit.quitReasonKeyword == 0x7768_793F)
        for code in ["logo", "rlgo", "rrst", "rest", "rsdn", "shut"] { #expect(SystemQuit.isSystemQuit(SystemQuit.fourCharCode(code))) }
        // ⌘Q, the Dock and NSApp.terminate carry no reason; the power key's own dialog ('pwrd') is not a quit.
        #expect(!SystemQuit.isSystemQuit(nil))
        #expect(!SystemQuit.isSystemQuit(SystemQuit.fourCharCode("pwrd")))
    }
}
