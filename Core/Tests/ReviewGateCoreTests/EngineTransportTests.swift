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
        for await e in client.events {
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

        let start = ContinuousClock.now
        await client.stop()
        #expect(ContinuousClock.now - start < .seconds(3))
        #expect(await client.isRunning == false)
    }

    /// Lines must be delivered as they are written, not buffered until the process exits.
    /// The engine always writes to stderr too; with `FileHandle.bytes.lines` a concurrent stderr
    /// reader stalled stdout delivery until EOF (second line arrived at ~7s instead of ~2s).
    @Test func deliversLinesWithoutWaitingForEOF() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("slow.sh")
        let body = """
        #!/bin/sh
        echo 'stderr noise' >&2
        sleep 1
        echo '{"type":"session_info","sessionId":"s1"}'
        sleep 1
        echo '{"type":"text_delta","text":"early"}'
        sleep 5
        printf '%s' '{"type":"text_delta","text":"trailing-no-newline"}'
        exit 0
        """
        try body.write(to: script, atomically: true, encoding: .utf8)

        let client = TestTransport(nodePath: "/bin/sh", scriptPath: script.path, env: ["PATH": "/usr/bin:/bin"])
        let start = ContinuousClock.now
        try await client.start()

        var arrivals: [(message: TestEvent, at: Duration)] = []
        for await e in client.events {
            arrivals.append((e, ContinuousClock.now - start))
        }
        let received = arrivals.map(\.message)
        func arrival(of m: TestEvent) -> Duration { arrivals.first { $0.message == m }?.at ?? .seconds(99) }
        let info = TestEvent.sessionInfo(sessionId: "s1")
        let early = TestEvent.textDelta(text: "early")
        let firstStdout = received.first { if case .log = $0 { return false } else { return true } }
        #expect(firstStdout == info)
        #expect(arrival(of: info) < .seconds(2), "session_info arrived at \(arrival(of: info))")
        #expect(arrival(of: early) < .seconds(3.5), "second line arrived at \(arrival(of: early))")
        // A trailing partial line (no newline) is flushed at EOF, and the stream closes only after it.
        #expect(received.contains(.textDelta(text: "trailing-no-newline")))
        #expect(ContinuousClock.now - start >= .seconds(7))
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
    /// with SIGPIPE (exit 141). The script closes its stdin and lingers, so `process.isRunning` stays
    /// true and the write itself is exercised.
    @Test func sendAfterReaderClosedThrowsInsteadOfSIGPIPE() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-fake-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let script = dir.appendingPathComponent("closestdin.sh")
        try "#!/bin/sh\nexec 0<&-\necho '{\"type\":\"log\",\"level\":\"info\",\"message\":\"stdin closed\"}'\nsleep 5\nexit 0\n"
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
