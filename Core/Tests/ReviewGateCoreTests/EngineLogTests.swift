import Foundation
import Testing
@testable import ReviewGateCore

/// wave1 mac-session: audit robustness-03 ①② / crash-6 — the masked daily log file, the dropped stderr twins of `log`
/// events and the diagnostics text.
@Suite @MainActor struct EngineLogTests {
    private func tempDir() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("EngineLogTests-\(UUID().uuidString)", isDirectory: true)
        return url
    }

    // MARK: - Masking

    @Test func redactsSecretsButKeepsWhatHelps() {
        let home = "/Users/me"
        #expect(LogRedactor.redact("open /Users/me/work/repo", home: home) == "open ~/work/repo")
        #expect(LogRedactor.redact("cd /Users/me; ls /Users/meme/x", home: home) == "cd ~; ls /Users/meme/x")
        #expect(LogRedactor.redact("key sk-ant-api03-AbC_def-123 used", home: home) == "key sk-ant-*** used")
        #expect(LogRedactor.redact("Authorization: Bearer abc.def.ghi", home: home) == "Authorization: Bearer ***")
        #expect(LogRedactor.redact("GITHUB_TOKEN=ghp_123 run", home: home) == "GITHUB_TOKEN=*** run")
        #expect(LogRedactor.redact("password: hunter2", home: home) == "password: ***")
        #expect(LogRedactor.redact("blob QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890abcdefXYZ end", home: home) == "blob *** end")
        // Ids, paths and git object ids stay readable.
        let uuid = "123e4567-e89b-12d3-a456-426614174000"
        #expect(LogRedactor.redact("session \(uuid)", home: home) == "session \(uuid)")
        let sha = String(repeating: "a1b2c3d4e5", count: 4)
        #expect(LogRedactor.redact("tree \(sha)", home: home) == "tree \(sha)")
        #expect(LogRedactor.redact("/opt/some/very/long/path/that/goes/on/and/on/forever.txt", home: home)
                == "/opt/some/very/long/path/that/goes/on/and/on/forever.txt")
    }

    // MARK: - stderr twins

    @Test func dropsTheStderrTwinOfALogEventInEitherOrder() {
        var d = SidecarLogDeduper(window: 1.5)
        let t0 = Date(timeIntervalSince1970: 100)
        // Event first, then its stderr copy.
        #expect(d.ingest(level: .info, message: "session started", now: t0) == ["[info] session started"])
        #expect(d.ingest(level: .debug, message: "[sidecar:info] session started", now: t0) == [])
        // stderr copy first, then the event.
        #expect(d.ingest(level: .debug, message: "[sidecar:warn] claude exited", now: t0) == [])
        #expect(d.hasPending)
        #expect(d.ingest(level: .warn, message: "claude exited", now: t0.addingTimeInterval(0.2)) == ["[warn] claude exited"])
        #expect(!d.hasPending)
        #expect(d.flush(now: t0.addingTimeInterval(5)) == [])
    }

    @Test func keepsTheSidecarsOwnLinesAndContinuations() {
        var d = SidecarLogDeduper(window: 1.5)
        let t0 = Date(timeIntervalSince1970: 100)
        #expect(d.ingest(level: .debug, message: "[sidecar:info] protocol v2", now: t0) == [])
        #expect(d.flush(now: t0.addingTimeInterval(1)) == [])
        #expect(d.flush(now: t0.addingTimeInterval(2)) == ["[debug] [sidecar:info] protocol v2"])
        // A multi-line event: the stderr copy of its first line and its plain continuation lines are dropped.
        let out = d.ingest(level: .warn, message: "claude exited (code=1): Error: boom\n    at x.js:1", now: t0.addingTimeInterval(3))
        #expect(out == ["[warn] claude exited (code=1): Error: boom\n    at x.js:1"])
        #expect(d.ingest(level: .debug, message: "[sidecar:warn] claude exited (code=1): Error: boom", now: t0.addingTimeInterval(3)) == [])
        #expect(d.ingest(level: .debug, message: "    at x.js:1", now: t0.addingTimeInterval(3)) == [])
        // Node's own stderr (not a twin) is logged as it always was.
        #expect(d.ingest(level: .debug, message: "(node:1) Warning: something", now: t0.addingTimeInterval(4)) == ["[debug] (node:1) Warning: something"])
    }

    @Test func appStateLogsOneCopy() {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "EngineLogTests.\(UUID().uuidString)")!)
        app.handle(.log(level: .info, message: "open_project /repo"))
        app.handle(.log(level: .debug, message: "[sidecar:info] open_project /repo"))
        #expect(app.logs == ["[info] open_project /repo"])
    }

    // MARK: - File

    @Test func writesMaskedDailyFilesAndPrunesOldOnes() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = EngineLogFile(directory: dir, retentionDays: 7, home: "/Users/me")
        let calendar = Calendar.current
        let now = Date()
        // An old file (8 days) goes, a recent one (6 days) stays.
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let old = log.file(for: calendar.date(byAdding: .day, value: -8, to: now)!)
        let recent = log.file(for: calendar.date(byAdding: .day, value: -6, to: now)!)
        let stranger = dir.appendingPathComponent("notes.txt")
        for url in [old, recent, stranger] { try "x\n".write(to: url, atomically: true, encoding: .utf8) }

        log.write("[error] session_start_failed: boom in /Users/me/repo with sk-ant-xyz", tag: "repo", at: now)
        log.flush()
        let today = try String(contentsOf: log.file(for: now), encoding: .utf8)
        #expect(today.contains("[repo] [error] session_start_failed: boom in ~/repo with sk-ant-***"))
        #expect(!today.contains("/Users/me"))
        #expect(log.file(for: now).lastPathComponent.hasPrefix("engine-") && log.file(for: now).pathExtension == "log")
        #expect(!FileManager.default.fileExists(atPath: old.path))
        #expect(FileManager.default.fileExists(atPath: recent.path))
        #expect(FileManager.default.fileExists(atPath: stranger.path))
        #expect(log.tail(5, at: now).last?.contains("session_start_failed") == true)
    }

    @Test func appStateWritesItsLinesToTheFile() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "EngineLogTests.\(UUID().uuidString)")!)
        let log = EngineLogFile(directory: dir)
        app.fileLog = log
        app.handle(.log(level: .warn, message: "claude exited (code=1 signal=null): Error: Session ID abc is already in use."))
        app.handle(.error(message: "Claude Code exited while starting.", fatal: true, scope: .session,
                          detail: EngineErrorDetail(code: "session_start_failed", detail: "Error: Session ID abc is already in use.", exitCode: 1)))
        log.flush()
        let text = try String(contentsOf: log.file(), encoding: .utf8)
        #expect(text.contains("[app] [warn] claude exited"))
        #expect(text.contains("[error] session_start_failed: Claude Code exited while starting. — Error: Session ID abc is already in use. · Exit code 1"))
    }

    // MARK: - Diagnostics

    @Test func diagnosticsCarryVersionsStateAndTheLastError() async {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "EngineLogTests.\(UUID().uuidString)")!)
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: NSHomeDirectory() + "/work/repo", root: NSHomeDirectory() + "/work/repo", name: "repo", branch: "main", remoteURL: nil)
        s.toolchain = EngineToolchain(claude: "/usr/local/bin/claude", gh: nil, git: nil, claudeVersion: "2.1.308", ghVersion: nil)
        app.handle(.state(s))
        app.handle(.log(level: .info, message: "token=supersecretvalue"))
        app.handle(.error(message: "query loop threw", fatal: true, scope: .session,
                          detail: EngineErrorDetail(code: "session_crashed", detail: "boom", exitCode: 1)))
        let text = await app.diagnosticsReport(appVersion: "ReviewGate 0.2.0 (160)", osVersion: "macOS 15")
        #expect(text.contains("app: ReviewGate 0.2.0 (160)"))
        #expect(text.contains("claude: 2.1.308 (/usr/local/bin/claude)"))
        #expect(text.contains("project: ~/work/repo"))
        #expect(text.contains("code: session_crashed"))
        #expect(text.contains("detail: boom · Exit code 1"))
        #expect(text.contains("token=***"))
        #expect(!text.contains("supersecretvalue"))
    }
}
