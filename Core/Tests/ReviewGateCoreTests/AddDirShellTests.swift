import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §67 on the Mac: `/add-dir` (the chat's directories beyond the project) and `!` (the user's shell command
/// between turns) — the wire, the state, the rows, the composer's shell mode and the words.
@Suite @MainActor struct AddDirShellTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "AddDirShellTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase = .idle, starting: Bool = false, shell: ShellRunInfo? = nil,
                          addedDirs: [String] = [], pending: Int = 0) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: starting, sessionId: "s1", model: nil, capabilities: nil, pendingPermission: nil,
                                canRestart: true)
        s.session.addedDirs = addedDirs
        s.session.shell = shell
        s.session.shellPending = pending
        let blocked: BlockedReason? = shell != nil ? .shellRunning : phase == .running ? .running : nil
        s.gate = GateInfo(phase: phase, canSend: blocked == nil && phase == .idle, canRequestChanges: false, blockedReason: blocked,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil,
                          turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    private func event(_ json: String) throws -> EngineEvent { try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8)) }

    private func sent(_ command: EngineCommand) throws -> [String: Any] {
        let data = try JSONEncoder().encode(EngineCommandEnvelope(id: "c1", command: command))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: The wire

    @Test func theCommands() throws {
        let add = try sent(.addDir(path: "../shared"))
        #expect(add["type"] as? String == "add_dir")
        #expect(add["path"] as? String == "../shared")
        let remove = try sent(.removeDir(path: "/work/shared"))
        #expect(remove["type"] as? String == "remove_dir")
        #expect(remove["path"] as? String == "/work/shared")
        let run = try sent(.shellRun(command: "git status"))
        #expect(run["type"] as? String == "shell_run")
        #expect(run["command"] as? String == "git status")
        let cancel = try sent(.shellCancel)
        #expect(cancel["type"] as? String == "shell_cancel")
        #expect(cancel.keys.sorted() == ["id", "type"])
    }

    @Test func theSessionState() throws {
        let json = #"""
        {"open":true,"starting":false,"addedDirs":["/work/shared","/Users/dev/lib"],
         "shell":{"id":"sh1","command":"npm test","cwd":"/work/acme","startedAt":"2026-11-24T12:00:00.000Z"},"shellPending":2}
        """#
        let session = try JSONDecoder().decode(SessionInfo.self, from: Data(json.utf8))
        #expect(session.addedDirs == ["/work/shared", "/Users/dev/lib"])
        #expect(session.shell == ShellRunInfo(id: "sh1", command: "npm test", cwd: "/work/acme", startedAt: "2026-11-24T12:00:00.000Z"))
        #expect(session.shellPending == 2)
        // An older engine (none of them) and odd values read as none.
        let old = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false}"#.utf8))
        #expect(old.addedDirs.isEmpty && old.shell == nil && old.shellPending == 0)
        let odd = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false,"addedDirs":"x","shell":{"command":"ls"},"shellPending":"2"}"#.utf8))
        #expect(odd.addedDirs.isEmpty && odd.shell == nil && odd.shellPending == 0)
    }

    @Test func shellRunningClosesTheGateAndAnUnknownReasonDoesNotBreakTheSnapshot() throws {
        let gate = try JSONDecoder().decode(GateInfo.self, from: Data(#"{"phase":"idle","canSend":false,"blockedReason":"shell_running"}"#.utf8))
        #expect(gate.blockedReason == .shellRunning)
        let newer = try JSONDecoder().decode(GateInfo.self, from: Data(#"{"phase":"idle","canSend":false,"blockedReason":"something_new"}"#.utf8))
        #expect(newer.blockedReason == nil)
        #expect(!newer.canSend)
    }

    @Test func theEventsAndTheRow() throws {
        #expect(try event(#"{"type":"shell_output","id":"sh1","output":"line 1\n"}"#) == .shellOutput(id: "sh1", output: "line 1\n"))
        let ended = try event(#"""
        {"type":"shell_result","turn":3,"at":"2026-11-24T12:00:05.000Z","id":"sh1","command":"npm test","cwd":"/work/acme",
         "output":"ok","truncated":true,"exitCode":1,"durationMs":5100,"files":["src/a.ts"],"filesTruncated":true}
        """#)
        let result = ShellResult(id: "sh1", command: "npm test", cwd: "/work/acme", output: "ok", truncated: true, exitCode: 1,
                                 durationMs: 5100, files: ["src/a.ts"], filesTruncated: true)
        #expect(ended == .shellResult(turn: 3, at: "2026-11-24T12:00:05.000Z", result: result))
        let row = try JSONDecoder().decode(TranscriptItem.self, from: Data(#"""
        {"at":"2026-11-24T12:00:05.000Z","turn":3,"kind":"shell","id":"sh2","command":"ls","cwd":"/work/acme","output":"",
         "exitCode":null,"cancelled":true,"durationMs":40}
        """#.utf8))
        #expect(row.kind == .shell(ShellResult(id: "sh2", command: "ls", cwd: "/work/acme", exitCode: nil, cancelled: true, durationMs: 40)))
        // A shell row without its command is not a row this client can show.
        let broken = try JSONDecoder().decode(TranscriptItem.self, from: Data(#"{"kind":"shell","id":"x"}"#.utf8))
        #expect(broken.kind == .other(kind: "shell"))
    }

    // MARK: The app

    @Test func liveOutputThenTheRowOnceAndRestored() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, shell: ShellRunInfo(id: "sh1", command: "npm test"))))
        #expect(app.shellRun?.id == "sh1")
        #expect(app.cannotSendReason == String(localized: "Running a shell command", bundle: .module))
        #expect(app.shellRunOutput == "")
        app.handle(.shellOutput(id: "sh1", output: "PASS a\n"))
        #expect(app.shellRunOutput == "PASS a\n")
        app.handle(.shellOutput(id: "other", output: "x"))
        #expect(app.shellRunOutput == "")   // another command's output is not this one's
        let result = ShellResult(id: "sh1", command: "npm test", output: "PASS a\n", exitCode: 0, durationMs: 1200)
        app.handle(.shellResult(turn: 0, at: "2026-11-24T12:00:05.000Z", result: result))
        app.handle(.shellResult(turn: 0, at: "2026-11-24T12:00:05.000Z", result: result))
        app.handle(.state(snapshot(seq: 2, pending: 1)))
        let rows = app.transcript.filter { if case .shell = $0 { true } else { false } }
        #expect(rows.count == 1)
        #expect(app.shellRun == nil)
        #expect(app.shellPending == 1)
        #expect(ShellMode.pendingCaption(app.shellPending) != nil)
        // A restored chat brings its rows back.
        app.restoreTranscript([TranscriptItem(at: "2026-11-24T12:01:00.000Z", turn: 1, kind: .shell(result))])
        #expect(app.transcript.contains { if case let .shell(_, r) = $0 { r == result } else { false } })
    }

    @Test func runShellSendsTheCommandAndKeepsItInTheHistory() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        #expect(await app.runShell("!  git status  ") == nil)
        #expect(sent == [.shellRun(command: "git status")])
        #expect(app.promptHistory.last == "!  git status")
        #expect(await app.runShell("!   ") == AddDirShellText.refusal(code: "empty_command", detail: ""))
        #expect(sent.count == 1)
        app.requestSink = { _ in throw EngineClientError.refused("turn_running", code: "turn_running") }
        #expect(await app.runShell("!ls") == AddDirShellText.refusal(code: "turn_running", detail: ""))
    }

    @Test func cancelOnlyWhileOneRuns() {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.cancelShell()
        #expect(fired.isEmpty)
        app.handle(.state(snapshot(seq: 1, shell: ShellRunInfo(id: "sh1", command: "sleep 9"))))
        app.cancelShell()
        #expect(fired == [.shellCancel])
    }

    @Test func stopAlsoStopsARunningShellCommand() {
        let app = makeState()
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.interrupt()
        #expect(fired.isEmpty)   // nothing runs: nothing to stop
        app.handle(.state(snapshot(seq: 1, shell: ShellRunInfo(id: "sh1", command: "sleep 9"))))
        #expect(!app.isRunning)
        app.interrupt()
        #expect(fired == [.shellCancel])
    }

    @Test func rejectWaitsForARunningShellCommand() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        #expect(app.rejectLockReason == nil)
        app.handle(.state(snapshot(seq: 2, shell: ShellRunInfo(id: "sh1", command: "sleep 9"))))
        let why = String(localized: "Reject is available when the shell command ends", bundle: .module)
        #expect(app.rejectLockReason == why)
        #expect(app.isRejectLocked)
        #expect(AddDirShellText.refusal(code: "shell_running", detail: "") == why)
        #expect(HunkRefusal.from("shell_running").message == why)
    }

    @Test func addDirSaysWhyItWasRefused() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        #expect(await app.addDir("../shared") == nil)
        #expect(await app.removeDir("/work/shared") == nil)
        #expect(sent == [.addDir(path: "../shared"), .removeDir(path: "/work/shared")])
        app.requestSink = { _ in throw EngineClientError.refused("dir_not_found:/work/nope", code: "dir_not_found", paths: ["/work/nope"]) }
        #expect(await app.addDir("/work/nope") == AddDirShellText.refusal(code: "dir_not_found", detail: "/work/nope"))
    }

    @Test func theChipIsOffWhileWorkRuns() {
        let app = makeState()
        #expect(app.addedDirsBlocker != nil)   // no project
        app.handle(.state(snapshot(seq: 1, addedDirs: ["/work/shared"])))
        #expect(app.addedDirs == ["/work/shared"])
        #expect(app.addedDirsBlocker == nil)
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        #expect(app.addedDirsBlocker == AddDirShellText.refusal(code: "dir_busy", detail: ""))
        app.handle(.state(snapshot(seq: 3, starting: true)))
        #expect(app.addedDirsBlocker == AddDirShellText.refusal(code: "dir_busy", detail: ""))
    }

    // MARK: Shell mode and the words

    @Test func shellDrafts() {
        #expect(ShellMode.isShellDraft("!ls"))
        #expect(ShellMode.isShellDraft("!"))
        #expect(!ShellMode.isShellDraft(" !ls"))
        #expect(!ShellMode.isShellDraft("ls !"))
        #expect(ShellMode.command(in: "! git log -3 \n") == "git log -3")
        #expect(ShellMode.command(in: "!") == "")
        #expect(ShellMode.command(in: "hello") == nil)
    }

    @Test func howItEnded() {
        func end(_ code: Int?, cancelled: Bool = false, timedOut: Bool = false) -> ShellEnd {
            ShellEnd(ShellResult(id: "x", command: "c", exitCode: code, timedOut: timedOut, cancelled: cancelled))
        }
        #expect(end(0) == .succeeded)
        #expect(end(2) == .failed(exitCode: 2))
        #expect(end(nil, cancelled: true) == .cancelled)
        #expect(end(nil, timedOut: true) == .timedOut)
        #expect(end(nil) == .notStarted)
        #expect(ShellEnd.succeeded.text == "✓ 0")
        #expect(ShellEnd.failed(exitCode: 2).text.hasPrefix("✗ "))
        #expect(ShellMode.summary(ShellResult(id: "x", command: "c", exitCode: 0, durationMs: 1200), language: "en") == "✓ 0 · 1.2s")
    }

    @Test func longOutputFoldsToItsLastLines() {
        let output = (1...20).map { "line \($0)" }.joined(separator: "\n") + "\n"
        let folded = ShellMode.folded(output, lines: 5)
        #expect(folded.hidden == 15)
        #expect(folded.text == "line 16\nline 17\nline 18\nline 19\nline 20")
        let short = ShellMode.folded("a\nb", lines: 5)
        #expect(short.text == "a\nb" && short.hidden == 0)
        #expect(ShellMode.folded("", lines: 5).hidden == 0)
    }

    @Test func theFilesLine() {
        #expect(ShellMode.filesLine(ShellResult(id: "x", command: "c", exitCode: 0)) == nil)
        let some = ShellResult(id: "x", command: "c", exitCode: 0, files: ["a.ts", "b.ts"])
        #expect(ShellMode.filesLine(some) != nil)
        #expect(ShellMode.filesTooltip(some) == "a.ts\nb.ts")
        #expect(ShellMode.filesTooltip(ShellResult(id: "x", command: "c", exitCode: 0, files: ["a.ts"], filesTruncated: true)) == "a.ts\n…")
        #expect(ShellMode.pendingCaption(0) == nil)
    }

    @Test func elapsedSinceTheStart() {
        let now = ISO8601DateFormatter().date(from: "2026-11-24T12:00:10Z")!
        #expect(ShellMode.elapsed(since: "2026-11-24T12:00:00.000Z", now: now) == 10)
        #expect(ShellMode.elapsed(since: "2026-11-24T12:00:04Z", now: now) == 6)
        #expect(ShellMode.elapsed(since: "", now: now) == 0)
    }

    @Test func everyRefusalHasItsWords() {
        let codes = ["dir_empty_path", "dir_path_too_long", "dir_not_found", "dir_not_directory", "dir_is_project", "dir_already_added",
                     "dir_too_many", "dir_busy", "dir_not_added", "empty_command", "command_too_long", "shell_busy", "turn_running",
                     "no_shell_running"]
        for code in codes {
            let text = EngineMessages.refusal(code: code, error: code)
            #expect(text != code, "\(code)")
            #expect(text == AddDirShellText.refusal(code: code, detail: ""), "\(code)")
        }
        #expect(EngineMessages.refusal(code: "terminal_chat", error: "terminal_chat") != "terminal_chat")
        #expect(EngineMessages.refusal(error: "dir_already_added:\(NSHomeDirectory())/lib").contains("~/lib"))
        #expect(EngineMessages.refusal(error: "gate_closed:shell_running") != EngineMessages.refusal(error: "gate_closed:x"))
    }

    @Test func theCardSaysWhyAnAddedDirectoryEditAsks() {
        let reason = PermissionReason(code: PermissionReason.Code(rawValue: "added_directory"), path: "/work/shared")
        #expect(reason.code == .addedDirectory)
        #expect(reason.code.rawValue == "added_directory")
        #expect(PermissionReasonText.line(reason) != PermissionReasonText.line(PermissionReason(code: .outsideProject)))
        #expect(PermissionReasonText.level(reason) == .caution)
    }
}
