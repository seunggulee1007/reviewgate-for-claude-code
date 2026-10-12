import Foundation

/// Runs an external process, draining stdout and stderr concurrently so neither pipe can deadlock.
/// Used by `ToolchainLocator` (login-shell probe, `--version`); everything else runs inside the engine.
public enum CommandRunner {
    public struct Output: Sendable {
        public var stdout: Data
        public var stderr: Data
        public var status: Int32

        public var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
        public var stderrText: String { String(decoding: stderr, as: UTF8.self) }
    }

    public struct Failure: Error, Sendable, CustomStringConvertible {
        public var exe: String
        public var reason: String
        public var description: String { "\(exe): \(reason)" }
    }

    /// Process-wide SIGPIPE guard, evaluated once. Writing to a pipe whose reader died (a crashed
    /// sidecar, `gh` exiting early) otherwise kills the app with signal 141; with SIGPIPE ignored the
    /// write fails with EPIPE and the caller's catch path handles it. Every write handle additionally
    /// gets `F_SETNOSIGPIPE` (see `disableSIGPIPE`), so this is belt and braces.
    static let ignoreSIGPIPE: Void = { _ = signal(SIGPIPE, SIG_IGN) }()

    /// Marks a pipe write end so a dead reader yields EPIPE instead of SIGPIPE.
    static func disableSIGPIPE(_ handle: FileHandle) {
        _ = fcntl(handle.fileDescriptor, F_SETNOSIGPIPE, 1)
    }

    private final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var _stdout = Data()
        private var _stderr = Data()
        func set(stdout: Data) { lock.lock(); _stdout = stdout; lock.unlock() }
        func set(stderr: Data) { lock.lock(); _stderr = stderr; lock.unlock() }
        var stdout: Data { lock.lock(); defer { lock.unlock() }; return _stdout }
        var stderr: Data { lock.lock(); defer { lock.unlock() }; return _stderr }
    }

    /// - Parameters:
    ///   - timeout: when set, the process is terminated (SIGTERM) after this interval; the
    ///     returned status is then whatever the process exited with.
    public static func run(
        _ exe: String,
        _ args: [String],
        cwd: String? = nil,
        env: [String: String]? = nil,
        timeout: Duration? = nil
    ) async throws -> Output {
        _ = ignoreSIGPIPE
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Output, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: exe)
            process.arguments = args
            if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
            if let env { process.environment = env }

            let outPipe = Pipe()
            let errPipe = Pipe()
            process.standardOutput = outPipe
            process.standardError = errPipe
            let outHandle = outPipe.fileHandleForReading
            let errHandle = errPipe.fileHandleForReading

            process.standardInput = FileHandle.nullDevice

            let collector = Collector()
            let group = DispatchGroup()
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                collector.set(stdout: outHandle.readDataToEndOfFile())
                group.leave()
            }
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                collector.set(stderr: errHandle.readDataToEndOfFile())
                group.leave()
            }

            process.terminationHandler = { p in
                let status = p.terminationStatus
                group.notify(queue: .global(qos: .userInitiated)) {
                    cont.resume(returning: Output(stdout: collector.stdout, stderr: collector.stderr, status: status))
                }
            }

            do {
                try process.run()
            } catch {
                process.terminationHandler = nil
                try? outHandle.close()
                try? errHandle.close()
                cont.resume(throwing: Failure(exe: exe, reason: error.localizedDescription))
                return
            }

            if let timeout {
                let pid = process.processIdentifier
                DispatchQueue.global().asyncAfter(deadline: .now() + timeoutInterval(timeout)) {
                    if process.isRunning, process.processIdentifier == pid {
                        process.terminate()
                        DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
                            if process.isRunning { kill(pid, SIGKILL) }
                        }
                    }
                }
            }
        }
    }

    private static func timeoutInterval(_ d: Duration) -> TimeInterval {
        let c = d.components
        return TimeInterval(c.seconds) + TimeInterval(c.attoseconds) / 1e18
    }
}
