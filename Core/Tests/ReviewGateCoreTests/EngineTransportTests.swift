import Foundation
import Testing
@testable import ReviewGateCore

/// Minimal wire types for exercising `EngineTransport` against shell-script stand-ins for the engine.
private struct TestCommand: TransportCommand, Equatable {
    var type: String
    var text: String?
    static var shutdown: TestCommand { TestCommand(type: "shutdown") }
    static func userMessage(text: String) -> TestCommand { TestCommand(type: "user_message", text: text) }
}

private enum TestEvent: TransportEvent, Equatable {
    case sessionInfo(sessionId: String)
    case textDelta(text: String)
    case turnEnd
    case log(level: LogLevel, message: String)
    case error(message: String, fatal: Bool)

    private enum CodingKeys: String, CodingKey { case type, sessionId, text, level, message, fatal }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "session_info": self = .sessionInfo(sessionId: try c.decode(String.self, forKey: .sessionId))
        case "text_delta": self = .textDelta(text: try c.decode(String.self, forKey: .text))
        case "turn_end": self = .turnEnd
        case "log": self = .log(level: try c.decode(LogLevel.self, forKey: .level), message: try c.decode(String.self, forKey: .message))
        case "error": self = .error(message: try c.decode(String.self, forKey: .message), fatal: try c.decodeIfPresent(Bool.self, forKey: .fatal) ?? false)
        case let t: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown \(t)")
        }
    }

    static func transportLog(level: LogLevel, message: String) -> TestEvent { .log(level: level, message: message) }
    static func transportExit(message: String) -> TestEvent { .error(message: message, fatal: true) }
    var isFatalError: Bool {
        if case .error(_, fatal: true) = self { return true }
        return false
    }
}

private typealias TestTransport = EngineTransport<TestCommand, TestEvent>

@Suite struct EngineTransportTests {
    /// A shell line that waits until `file` exists — the test creates it once it has received what the script wrote
    /// before, or wants the script to go on — and gives up after 60 s, so a transport that holds lines back fails the test
    /// instead of hanging it. The scripts never rely on a `sleep` lasting long enough: a busy runner stretches every gap.
    private func waitFor(_ file: URL) -> String {
        "i=0; while [ ! -e '\(file.path)' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done"
    }

    private func touch(_ file: URL) {
        FileManager.default.createFile(atPath: file.path, contents: nil)
    }

    /// A fake engine: prints session_info, echoes a turn_end for each user_message, exits on shutdown.
    private func makeFakeEngine() throws -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("sidecar.sh")
        let body = """
        #!/bin/sh
        echo '{"type":"session_info","sessionId":"s1"}'
        echo 'stderr noise' >&2
        echo 'not json'
        while IFS= read -r line; do
          case "$line" in
            *user_message*) echo '{"type":"text_delta","text":"pong"}'; echo '{"type":"turn_end"}' ;;
            *shutdown*) exit 0 ;;
          esac
        done
        exit 0
        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        return script.path
    }

    @Test func streamsEventsAndStopsGracefully() async throws {
        let script = try makeFakeEngine()
        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script, env: ["PATH": "/usr/bin:/bin"])
        try await client.start()
        try await client.send(.userMessage(text: "ping"))

        var received: [TestEvent] = []
        // stdout and stderr are read on separate threads, so the stderr line may be yielded after turn_end.
        var sawTurnEnd = false, sawStderr = false
        var events = client.events.makeAsyncIterator()   // kept: what comes after the stop is read below
        while let e = await events.next() {
            received.append(e)
            if case .turnEnd = e { sawTurnEnd = true }
            if case .log(.debug, "stderr noise") = e { sawStderr = true }
            if sawTurnEnd && sawStderr { break }
        }
        #expect(received.contains(.sessionInfo(sessionId: "s1")))
        // wave6 w6-statusline: an undecodable line is logged by its type and size, never by its content.
        #expect(received.contains { if case .log(.warn, let m) = $0 { return m.hasPrefix("undecodable sidecar line (?, 8 bytes)") && !m.contains("not json") } else { return false } })
        #expect(received.contains { if case .log(.debug, "stderr noise") = $0 { return true } else { return false } })
        #expect(received.contains(.textDelta(text: "pong")))

        await client.stop()
        #expect(await client.isRunning == false)
        // The script exits 0 on `shutdown` (or the stdin EOF behind it). A stop that fell back to SIGTERM (after its 3 s
        // wait) would end it with 15, and the transport would yield "sidecar exited 15": no exit row says the graceful
        // path did it, however long the runner took (a "stop returns within 3 s" bound measured the runner too).
        var afterStop: [TestEvent] = []
        while let e = await events.next() { afterStop.append(e) }
        #expect(!afterStop.contains { $0.isFatalError }, "\(afterStop)")
    }

    /// Lines must be delivered as they are written, not buffered until the process exits.
    /// The engine always writes to stderr too; with `FileHandle.bytes.lines` a concurrent stderr
    /// reader stalled stdout delivery until EOF (second line arrived at ~7s instead of ~2s).
    /// The script writes each next line only once the test has received the one before (the test creates the file the
    /// script waits for), so a reader holding lines until EOF never gets the second one. No gaps are measured: CI's
    /// runner started the script late and bunched the lines (1.86 s where more than 3 s was expected).
    @Test func deliversLinesWithoutWaitingForEOF() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("slow.sh")
        let gotInfo = dir.appendingPathComponent("got-info")
        let gotEarly = dir.appendingPathComponent("got-early")
        // A line whose go-ahead never came (the wait gave up) is not written: the test sees it missing.
        let body = """
        #!/bin/sh
        echo 'stderr noise' >&2
        echo '{"type":"session_info","sessionId":"s1"}'
        \(waitFor(gotInfo))
        [ -e '\(gotInfo.path)' ] && echo '{"type":"text_delta","text":"early"}'
        \(waitFor(gotEarly))
        [ -e '\(gotEarly.path)' ] && printf '%s' '{"type":"text_delta","text":"trailing-no-newline"}'
        exit 0
        """
        try body.write(to: script, atomically: true, encoding: .utf8)

        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script.path, env: ["PATH": "/usr/bin:/bin"])
        try await client.start()

        let info = TestEvent.sessionInfo(sessionId: "s1")
        let early = TestEvent.textDelta(text: "early")
        let trailing = TestEvent.textDelta(text: "trailing-no-newline")
        var received: [TestEvent] = []
        for await e in client.events {
            received.append(e)
            // Its arrival, while the script still runs (stderr open too), lets the script write the next line.
            if e == info { touch(gotInfo) }
            if e == early { touch(gotEarly) }
        }
        let firstStdout = received.first { if case .log = $0 { return false } else { return true } }
        #expect(firstStdout == info)
        #expect(received.contains(early), "written only after session_info arrived before EOF: \(received)")
        // A trailing partial line (no newline) is flushed at EOF, and the stream closes only after it.
        #expect(received.contains(trailing), "written only after the second line arrived before EOF: \(received)")
    }

    @Test func reportsUnexpectedExit() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("crash.sh")
        try "#!/bin/sh\nexit 7\n".write(to: script, atomically: true, encoding: .utf8)

        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script.path, env: [:])
        try await client.start()
        var last: TestEvent? = nil
        for await e in client.events { if case .error = e { last = e } }
        #expect(last == .error(message: "sidecar exited 7", fatal: true))
    }

    /// Writing to a process whose stdin reader is gone must throw (EPIPE), not kill the test process
    /// with SIGPIPE (exit 141). The script closes its stdin and lingers until the test is done with it (not for a fixed
    /// 5 s, which CI's runner used up before the check), so `process.isRunning` stays true and the write itself is exercised.
    @Test func sendAfterReaderClosedThrowsInsteadOfSIGPIPE() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("closestdin.sh")
        let done = dir.appendingPathComponent("done")
        try "#!/bin/sh\nexec 0<&-\necho '{\"type\":\"log\",\"level\":\"info\",\"message\":\"stdin closed\"}'\n\(waitFor(done))\nexit 0\n"
            .write(to: script, atomically: true, encoding: .utf8)

        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script.path, env: [:])
        try await client.start()
        for await e in client.events {
            if case .log(.info, "stdin closed") = e { break }
        }
        try? await Task.sleep(for: .milliseconds(100))
        #expect(await client.isRunning)
        // one write may still land in the kernel pipe buffer before the reader is observed closed; the
        // next write past that is guaranteed EPIPE. Neither may crash the process.
        var threw = false
        for _ in 0..<3 {
            do { try await client.send(.userMessage(text: String(repeating: "x", count: 70_000))) } catch { threw = true; break }
        }
        #expect(threw, "send() must throw once the process's stdin reader is gone")
        touch(done)
        await client.stop()
    }

    /// Process that exits immediately: `send()` after the exit throws instead of crashing.
    @Test func sendAfterImmediateExitThrows() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("quit.sh")
        try "#!/bin/sh\nexit 0\n".write(to: script, atomically: true, encoding: .utf8)

        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script.path, env: [:])
        try await client.start()
        for await _ in client.events {}
        await #expect(throws: (any Error).self) {
            try await client.send(.userMessage(text: "ping"))
        }
    }

    /// A process-reported fatal error followed by its exit yields one error row, not two.
    @Test func fatalErrorBeforeExitIsNotDuplicated() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("fatal.sh")
        try "#!/bin/sh\necho '{\"type\":\"error\",\"message\":\"boom\",\"fatal\":true}'\nexit 1\n"
            .write(to: script, atomically: true, encoding: .utf8)

        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script.path, env: [:])
        try await client.start()
        var errors: [TestEvent] = []
        for await e in client.events { if case .error = e { errors.append(e) } }
        #expect(errors == [.error(message: "boom", fatal: true)])
    }

    /// A fatal error long before the exit (a session's: the Claude CLI failed, the sidecar ran on) keeps the exit row.
    /// "Long" is more than the transport's 3 s window. The script exits only once the test says so, 3.5 s after the test
    /// received the error — which the transport stamped when it read it, before that — so the gap is at least 3.5 s
    /// however slowly the runner reads (a script's `sleep 5` left 2 s for a stalled reader).
    @Test func fatalErrorLongBeforeExitKeepsTheExitRow() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("late.sh")
        let exitNow = dir.appendingPathComponent("exit-now")
        try "#!/bin/sh\necho '{\"type\":\"error\",\"message\":\"cli failed\",\"fatal\":true}'\n\(waitFor(exitNow))\nexit 1\n"
            .write(to: script, atomically: true, encoding: .utf8)

        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script.path, env: ["PATH": "/usr/bin:/bin"])
        try await client.start()
        var errors: [TestEvent] = []
        for await e in client.events {
            guard case .error = e else { continue }
            errors.append(e)
            if errors.count == 1 {
                try await Task.sleep(for: .milliseconds(3500))
                touch(exitNow)
            }
        }
        #expect(errors == [.error(message: "cli failed", fatal: true), .error(message: "sidecar exited 1", fatal: true)])
    }

    /// code-browser (§47): a multi-megabyte line (a `project_file` reply) arrives over many reads and is delivered whole,
    /// and the short lines after it each once.
    @Test func aHugeLineAndManyShortOnesArriveWhole() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("big.sh")
        let body = """
        #!/bin/sh
        printf '{"type":"text_delta","text":"'
        head -c 3000000 /dev/zero | tr '\\0' 'a'
        printf '"}\\n'
        i=0
        while [ $i -lt 300 ]; do echo '{"type":"turn_end"}'; i=$((i+1)); done
        exit 0
        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script.path, env: ["PATH": "/usr/bin:/bin"])
        try await client.start()
        var bigLength = 0, turnEnds = 0
        for await e in client.events {
            if case let .textDelta(text) = e { bigLength = text.utf8.count }
            if case .turnEnd = e { turnEnds += 1 }
        }
        #expect(bigLength == 3_000_000)
        #expect(turnEnds == 300)
    }
}
