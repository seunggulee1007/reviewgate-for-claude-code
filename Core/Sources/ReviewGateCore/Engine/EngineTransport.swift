import Foundation

/// What the transport needs from the outgoing message type: a `shutdown` to send on `stop()`.
public protocol TransportCommand: Encodable, Sendable {
    static var shutdown: Self { get }
}

/// What the transport needs from the incoming event type: how to synthesize its own log / exit rows.
public protocol TransportEvent: Decodable, Sendable {
    static func transportLog(level: LogLevel, message: String) -> Self
    /// Yielded once when the process exits unexpectedly (non-zero, or without `stop()`).
    static func transportExit(message: String) -> Self
    /// A fatal error reported by the process itself; suppresses the redundant exit row that follows it.
    var isFatalError: Bool { get }
}

/// Owns the `node sidecar.mjs` process and speaks NDJSON over its stdin/stdout. Generic over the message
/// types (`EngineClient` binds it to `EngineCommandEnvelope`/`EngineEvent`; tests use stand-ins).
public actor EngineTransport<Command: TransportCommand, Event: TransportEvent> {
    public struct StartError: Error, Sendable, CustomStringConvertible {
        public var description: String
    }

    /// Splits a pipe's output into lines as chunks arrive via `readabilityHandler`.
    ///
    /// `FileHandle.bytes.lines` is not used on purpose: with two concurrent iterators (stdout + stderr)
    /// stdout lines were held back until the sidecar exited.
    private final class LineReader: @unchecked Sendable {
        private let lock = NSLock()
        private var buffer: [UInt8] = []
        /// code-browser (§47): how much of `buffer` is known to hold no newline — a megabyte reply (`project_file`,
        /// `full_file_content`) arriving in 64 KB reads is scanned once, not again from its start on every read.
        private var scanned = 0
        private var finished = false
        private let handle: FileHandle
        private let onLine: @Sendable (String) -> Void
        private let onEOF: @Sendable () -> Void

        init(handle: FileHandle, onLine: @escaping @Sendable (String) -> Void, onEOF: @escaping @Sendable () -> Void) {
            self.handle = handle
            self.onLine = onLine
            self.onEOF = onEOF
        }

        func start() {
            handle.readabilityHandler = { [self] h in
                let data = h.availableData
                if data.isEmpty { finish() } else { append(data) }
            }
        }

        private func append(_ data: Data) {
            var lines: [String] = []
            lock.lock()
            buffer.append(contentsOf: data)
            // Every complete line from the bytes not scanned yet, then the consumed prefix dropped once.
            var start = 0
            var from = scanned
            while let nl = buffer[from...].firstIndex(of: UInt8(ascii: "\n")) {
                lines.append(String(decoding: buffer[start..<nl], as: UTF8.self))
                start = nl + 1
                from = start
            }
            if start > 0 { buffer.removeSubrange(..<start) }
            scanned = buffer.count
            lock.unlock()
            for line in lines where !line.isEmpty { onLine(line) }
        }

        private func finish() {
            lock.lock()
            if finished { lock.unlock(); return }
            finished = true
            let rest = buffer
            buffer = []
            scanned = 0
            lock.unlock()
            handle.readabilityHandler = nil
            if !rest.isEmpty { onLine(String(decoding: rest, as: UTF8.self)) }
            onEOF()
        }
    }

    public nonisolated let events: AsyncStream<Event>
    private let continuation: AsyncStream<Event>.Continuation

    private let nodePath: String
    private let scriptPath: String
    private let env: [String: String]

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var readers: [LineReader] = []
    private var readersAtEOF = 0
    private var exited = false
    private var exitStatus: Int32 = 0
    private var stopping = false
    private var finished = false
    /// Instant of the last fatal `error` line from the sidecar; used to drop the redundant
    /// "sidecar exited N" row that always follows a sidecar-reported fatal error.
    private let lastFatalError = FatalErrorClock()

    private final class FatalErrorClock: @unchecked Sendable {
        private let lock = NSLock()
        private var instant: ContinuousClock.Instant?
        func mark() { lock.lock(); instant = .now; lock.unlock() }
        var value: ContinuousClock.Instant? { lock.lock(); defer { lock.unlock() }; return instant }
    }

    public init(nodePath: String, scriptPath: String, env: [String: String]) {
        _ = CommandRunner.ignoreSIGPIPE
        self.nodePath = nodePath
        self.scriptPath = scriptPath
        self.env = env
        let (stream, cont) = AsyncStream.makeStream(of: Event.self, bufferingPolicy: .unbounded)
        self.events = stream
        self.continuation = cont
    }

    public var isRunning: Bool { process?.isRunning ?? false }

    /// M19: pid of the `node` sidecar — the identity it writes into `reviewgate.lock`, so a
    /// `locked_by_other_session:<pid>` refusal can be matched against our own windows.
    public var processIdentifier: Int32? {
        guard let process, process.isRunning else { return nil }
        return process.processIdentifier
    }

    public func start() throws {
        guard process == nil else { return }
        guard FileManager.default.fileExists(atPath: scriptPath) else {
            throw StartError(description: String(localized: "sidecar script not found at \(scriptPath)", bundle: .module))
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [scriptPath]
        p.currentDirectoryURL = URL(fileURLWithPath: (scriptPath as NSString).deletingLastPathComponent)
        var environment = ProcessInfo.processInfo.environment
        for (k, v) in env { environment[k] = v }
        p.environment = environment

        let inPipe = Pipe()
        CommandRunner.disableSIGPIPE(inPipe.fileHandleForWriting)
        let outPipe = Pipe()
        let errPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errPipe

        let cont = continuation
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            guard let self else { cont.finish(); return }
            Task { await self.handleExit(status: status) }
        }

        let onEOF: @Sendable () -> Void = { [weak self] in
            guard let self else { return }
            Task { await self.readerReachedEOF() }
        }
        let fatalClock = lastFatalError
        let stdoutReader = LineReader(handle: outPipe.fileHandleForReading, onLine: { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return }
            do {
                let message = try NDJSON.decode(Event.self, from: trimmed)
                if message.isFatalError { fatalClock.mark() }
                cont.yield(message)
            } catch {
                // MARK: wave6 w6-statusline — the type, the size and where it failed, never the line itself.
                cont.yield(Event.transportLog(level: .warn, message: NDJSON.undecodableSummary(trimmed, error: error)))
            }
        }, onEOF: onEOF)
        let stderrReader = LineReader(handle: errPipe.fileHandleForReading, onLine: { line in
            cont.yield(Event.transportLog(level: .debug, message: line))
        }, onEOF: onEOF)

        do {
            try p.run()
        } catch {
            throw StartError(description: String(localized: "failed to launch node: \(error.localizedDescription)", bundle: .module))
        }
        process = p
        stdinHandle = inPipe.fileHandleForWriting
        readers = [stdoutReader, stderrReader]
        stdoutReader.start()
        stderrReader.start()
    }

    public func send(_ message: Command) throws {
        guard let stdinHandle, let process, process.isRunning else {
            throw StartError(description: String(localized: "sidecar is not running", bundle: .module))
        }
        let data = try NDJSON.encodeLine(message)
        try stdinHandle.write(contentsOf: data)
    }

    /// Graceful shutdown: `shutdown` + stdin EOF, wait 3s, SIGTERM, wait 2s, SIGKILL.
    public func stop() async {
        guard let process else { return }
        stopping = true
        try? send(.shutdown)
        try? stdinHandle?.close()
        stdinHandle = nil

        if await waitForExit(seconds: 3) { return }
        if process.isRunning { process.terminate() }
        if await waitForExit(seconds: 2) { return }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        _ = await waitForExit(seconds: 1)
    }

    private func waitForExit(seconds: Double) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !exited, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        return exited
    }

    private func handleExit(status: Int32) {
        exited = true
        exitStatus = status
        try? stdinHandle?.close()
        stdinHandle = nil
        finishIfComplete()
    }

    private func readerReachedEOF() {
        readersAtEOF += 1
        finishIfComplete()
    }

    /// Closes the event stream once the process has exited and both pipes have been drained to EOF.
    /// The exit error is yielded here (after every stdout line) so a fatal error the sidecar itself
    /// reported just before exiting is not followed by a duplicate "sidecar exited 1" row.
    private func finishIfComplete() {
        guard exited, readersAtEOF >= readers.count, !finished else { return }
        finished = true
        readers = []
        if !stopping || exitStatus != 0 {
            let recentFatal = lastFatalError.value.map { .now - $0 < Self.fatalErrorExitWindow } ?? false
            if !recentFatal {
                continuation.yield(Event.transportExit(message: String(localized: "sidecar exited \(exitStatus)", bundle: .module)))
            }
        }
        continuation.finish()
    }

    /// The sidecar exits within ~2.5s of emitting a fatal error (its shutdown hard cap).
    private static var fatalErrorExitWindow: Duration { .seconds(3) }
}
