import Foundation

public enum EngineClientError: Error, LocalizedError, Sendable, Equatable {
    /// `node` could not be located (login shell probe + fallbacks).
    case nodeNotFound
    /// `stop()` was called; the client does not respawn afterwards.
    case stopped
    /// The engine exited (or was stopped) while a reply was pending.
    case exited
    /// `result{ok:false, error, code?, paths?}` — `code` is the stable id (§19.6), `paths` the files it is about (§19.1).
    case refused(String, code: String? = nil, paths: [String] = [])
    /// A reply of a type the command does not produce.
    case unexpectedReply(String)

    /// A refusal's stable code: the wire's `code`, else the leading word of the text (older engines).
    public var refusalCode: String? {
        guard case let .refused(message, code, _) = self else { return nil }
        return code ?? EngineMessages.codeWord(message)
    }

    /// A refusal in the user's words (`EngineMessages.refusal`); other errors as `localizedDescription`.
    public var userMessage: String {
        if case let .refused(message, code, paths) = self { return EngineMessages.refusal(code: code, error: message, paths: paths) }
        return localizedDescription
    }

    public var errorDescription: String? {
        switch self {
        case .nodeNotFound: String(localized: "Node.js (node) was not found. Install Node.js, or set its path in Settings › General › Toolchain overrides › node path, then reopen the project.", bundle: .module)
        case .stopped: String(localized: "engine was stopped", bundle: .module)
        case .exited: String(localized: "engine exited before replying", bundle: .module)
        case .refused(let message, _, _): message
        case .unexpectedReply(let type): String(localized: "unexpected engine reply: \(type)", bundle: .module)
        }
    }
}

/// The app's connection to the engine process (protocol v2). Owns one `EngineTransport`, started lazily at
/// the first command: locates `node`, spawns `sidecar.mjs`, sends `hello` and waits for `ready`. Commands with
/// a reply (`request`) are correlated by a UUID `id`. When the engine exits, pending requests fail, the
/// transport's exit error is forwarded on `events` followed by an empty `state` (seq 0), and the next command
/// respawns the engine and replays `hello` (the project must be reopened by the user).
public actor EngineClient {
    public typealias Transport = EngineTransport<EngineCommandEnvelope, EngineEvent>

    /// Everything the engine emits except the replies consumed by `request`.
    public nonisolated let events: AsyncStream<EngineEvent>
    private let continuation: AsyncStream<EngineEvent>.Continuation

    private let scriptPath: String
    private let settings: @Sendable () -> EngineSettings
    private let nodePathOverride: @Sendable () -> String?

    private var transport: Transport?
    private var pump: Task<Void, Never>?
    private var starting: Task<Toolchain, any Error>?
    private var nodeToolchain: Toolchain?
    private var pending: [String: PendingReply] = [:]
    private var stopped = false

    /// A reply slot: the event may arrive before the requester suspends on its continuation.
    private final class PendingReply {
        var continuation: CheckedContinuation<EngineEvent, any Error>?
        var outcome: Result<EngineEvent, any Error>?

        func settle(_ result: Result<EngineEvent, any Error>) {
            if let continuation { self.continuation = nil; continuation.resume(with: result) } else { outcome = result }
        }
    }

    /// - Parameters:
    ///   - scriptPath: `sidecar.mjs` (bundle resource or `REVIEWGATE_SIDECAR`).
    ///   - settings: builds the `hello.settings` payload (re-read on every (re)spawn).
    ///   - nodePathOverride: Settings override for the `node` binary.
    public init(scriptPath: String,
                settings: @escaping @Sendable () -> EngineSettings,
                nodePathOverride: @escaping @Sendable () -> String? = { nil }) {
        self.scriptPath = scriptPath
        self.settings = settings
        self.nodePathOverride = nodePathOverride
        let (stream, cont) = AsyncStream.makeStream(of: EngineEvent.self, bufferingPolicy: .unbounded)
        self.events = stream
        self.continuation = cont
    }

    public var isRunning: Bool { transport != nil }

    /// `node` + login PATH used to spawn the engine; nil until the first start.
    public var toolchain: Toolchain? { nodeToolchain }

    /// The engine's version from its `ready` (diagnostics); nil until the first start.
    public private(set) var engineVersion: String?

    /// M19: pid of the running sidecar process (the worktree lock owner), nil when it is not running.
    public var enginePID: Int32? {
        get async {
            guard let transport else { return nil }
            return await transport.processIdentifier
        }
    }

    // MARK: - Lifecycle

    /// Spawns the engine if it is not running and completes the `hello`/`ready` handshake. Idempotent.
    @discardableResult
    public func start() async throws -> Toolchain {
        if let transport, await transport.isRunning, let nodeToolchain { return nodeToolchain }
        if let starting { return try await starting.value }
        guard !stopped else { throw EngineClientError.stopped }
        let task = Task { try await self.spawn() }
        starting = task
        defer { if starting == task { starting = nil } }
        return try await task.value
    }

    private func spawn() async throws -> Toolchain {
        let tc = await ToolchainLocator.locate(nodeOverride: nodePathOverride())
        guard let node = tc.nodePath else { throw EngineClientError.nodeNotFound }
        let transport = Transport(nodePath: node, scriptPath: scriptPath, env: ["PATH": tc.loginPATH])
        try await transport.start()
        self.transport = transport
        nodeToolchain = tc
        pump = Task { [weak self] in
            for await event in transport.events {
                guard let self else { return }
                await self.dispatch(event)
            }
            await self?.transportEnded(transport)
        }
        let reply = try await perform(.hello(client: "mac", env: ["PATH": tc.loginPATH], settings: settings()))
        guard case let .ready(_, version, _, _) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        engineVersion = version
        return tc
    }

    /// `shutdown` + graceful transport stop; no respawn afterwards.
    public func stop() async {
        stopped = true
        starting?.cancel()
        let transport = self.transport
        self.transport = nil
        if let transport { await transport.stop() }
        failPending(EngineClientError.stopped)
    }

    // MARK: - Commands

    /// Fire-and-forget (no `id`); state changes arrive via `events`.
    public func send(_ command: EngineCommand) async throws {
        try await start()
        guard let transport else { throw EngineClientError.exited }
        try await transport.send(EngineCommandEnvelope(command: command))
    }

    /// Sends with a UUID `id` and returns the matching reply (`ready`, `file_diff`, `full_file_content` or
    /// `result{ok:true}`); throws `refused` on `result{ok:false}` and `exited` if the engine dies first.
    public func request(_ command: EngineCommand) async throws -> EngineEvent {
        try await start()
        return try await perform(command)
    }

    private func perform(_ command: EngineCommand) async throws -> EngineEvent {
        guard let transport else { throw EngineClientError.exited }
        let id = UUID().uuidString
        let slot = PendingReply()
        pending[id] = slot
        do {
            try await transport.send(EngineCommandEnvelope(id: id, command: command))
        } catch {
            pending[id] = nil
            throw error
        }
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<EngineEvent, any Error>) in
            if let outcome = slot.outcome { cont.resume(with: outcome) } else { slot.continuation = cont }
        }
    }

    // MARK: - Event pump

    private func dispatch(_ event: EngineEvent) {
        if let id = event.replyId, let slot = pending.removeValue(forKey: id) {
            if case let .result(_, ok, error, code, paths) = event, !ok {
                slot.settle(.failure(EngineClientError.refused(error ?? code ?? "refused", code: code, paths: paths ?? [])))
            } else {
                slot.settle(.success(event))
            }
            return
        }
        continuation.yield(event)
    }

    private func transportEnded(_ ended: Transport) {
        guard transport === ended || transport == nil else { return }
        transport = nil
        pump = nil
        failPending(EngineClientError.exited)
        if !stopped {
            // The transport already yielded its exit error; the empty snapshot resets the mirror (seq 0).
            continuation.yield(.state(.empty))
        }
    }

    private func failPending(_ error: EngineClientError) {
        let slots = pending
        pending = [:]
        for slot in slots.values { slot.settle(.failure(error)) }
    }
}
