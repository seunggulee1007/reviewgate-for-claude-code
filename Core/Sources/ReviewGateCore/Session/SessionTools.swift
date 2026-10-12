import Foundation
import Observation

// MARK: wave3 mac-session
// The client state of docs/PROTOCOL.md §36.7–36.9 that is not in the engine's snapshot: `retry_extensions` in flight and its
// refusal, the extensions banner closed for this project, the installed CLI versions (`cli_versions`), the user's other
// Claude sessions (`cli_sessions`) and an import in flight (`cli_session_import`). Owned by `AppState` (`store.sessionTools`).

/// What `retry_extensions` did.
public enum ExtensionsRetryOutcome: Sendable, Equatable {
    /// The session restarts with the user's extensions.
    case started
    /// Nothing to retry: the fallback was already over.
    case alreadyOn
    /// Refused (busy, …): `extensionsRetryError` says why.
    case refused
    /// An engine before §36 (or no session): the caller reopens the project instead, as before.
    case unsupported
}

@MainActor
@Observable
public final class SessionToolsStore {
    // §36.7
    public private(set) var isRetryingExtensions = false
    /// Why the last `retry_extensions` was refused, in the user's words; nil after a success / a new fallback.
    public private(set) var extensionsRetryError: String?
    /// The user closed the extensions banner: later fallbacks of this project (the engine's own retry) keep it closed —
    /// the HUD's "Extensions off" chip stays.
    public private(set) var fallbackBannerSilenced = false
    // §36.8
    public private(set) var versions: CliVersionsReply?
    public private(set) var versionsError: String?
    public private(set) var isLoadingVersions = false
    /// False once the engine answered `unknown_command`.
    public private(set) var versionsSupported = true
    // §36.9
    public private(set) var running: [CliRunningSession] = []
    public private(set) var resumable: [CliResumableSession] = []
    /// A `cli_sessions` reply arrived for this project.
    public private(set) var sessionsLoaded = false
    /// False once the engine answered `unknown_command` (no section, no import sheet).
    public private(set) var sessionsSupported = true
    public private(set) var sessionsError: String?
    public private(set) var isLoadingSessions = false
    /// The terminal session an import is running for.
    public private(set) var importingSessionId: String?
    // MARK: wave4d w4d-peers
    /// §42.2: how the user's other sessions see this window (`cli_sessions.self`); nil before its CLI registered / older engines.
    public private(set) var selfSession: PeerSelf?
    /// When `cli_sessions` was last asked (answered or failed): a window coming to the front asks again only after
    /// `sessionsRefreshInterval`.
    @ObservationIgnored private var sessionsAskedAt: Date?
    /// The shortest gap between two `cli_sessions` that nobody forced.
    public static let sessionsRefreshInterval: TimeInterval = 10
    @ObservationIgnored weak var app: AppState?

    public init() {}

    func attach(_ app: AppState) { self.app = app }

    /// What the window forgets when it opens / closes a project.
    func reset() {
        isRetryingExtensions = false
        extensionsRetryError = nil
        fallbackBannerSilenced = false
        running = []
        resumable = []
        sessionsLoaded = false
        sessionsError = nil
        isLoadingSessions = false
        importingSessionId = nil
        sessionsAskedAt = nil
        selfSession = nil // MARK: wave4d w4d-peers
    }

    // MARK: §36.7 Extensions

    /// The banner's ✕: the chip keeps saying it, the banner does not come back for this project.
    public func silenceFallbackBanner() { fallbackBannerSilenced = true }

    /// `retry_extensions`: restarts the session with the user's extensions (resumed, the review kept).
    @discardableResult
    public func retryExtensions() async -> ExtensionsRetryOutcome {
        guard let app, !isRetryingExtensions else { return .refused }
        isRetryingExtensions = true
        defer { isRetryingExtensions = false }
        extensionsRetryError = nil
        do {
            _ = try await app.reply(.retryExtensions)
            return .started
        } catch let error as EngineClientError {
            switch error.refusalCode {
            case "unknown_command", "no_session": return .unsupported
            case "extensions_on": return .alreadyOn
            default:
                extensionsRetryError = error.userMessage
                return .refused
            }
        } catch {
            extensionsRetryError = error.localizedDescription
            return .refused
        }
    }

    // MARK: §36.8 CLI versions

    /// `cli_versions`: the installed versions (newest first), the current one and the pinned path.
    public func refreshVersions() async {
        guard let app, !isLoadingVersions else { return }
        isLoadingVersions = true
        defer { isLoadingVersions = false }
        do {
            if case let .cliVersions(reply) = try await app.reply(.cliVersions) { apply(versions: reply) }
        } catch let error as EngineClientError where error.refusalCode == "unknown_command" {
            versionsSupported = false
        } catch {
            versionsError = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    func apply(versions reply: CliVersionsReply) {
        versions = reply
        versionsError = nil
        versionsSupported = true
    }

    // MARK: §36.9 Other sessions

    /// `cli_sessions` (never waits behind a turn): the other live Claude processes of this repository and the terminal
    /// conversations that can be imported. Skipped without a project or a running engine (it never starts one), after an
    /// engine answered `unknown_command`, and — unless `force` — within `sessionsRefreshInterval` of the last ask.
    public func refreshSessions(force: Bool = false, now: Date = Date()) async {
        guard let app, app.projectInfo != nil, app.isEngineRunning || app.replySink != nil else { return }
        guard sessionsSupported, !isLoadingSessions else { return }
        if !force, let at = sessionsAskedAt, now.timeIntervalSince(at) < Self.sessionsRefreshInterval { return }
        sessionsAskedAt = now
        isLoadingSessions = true
        defer { isLoadingSessions = false }
        do {
            if case let .cliSessions(reply) = try await app.reply(.cliSessions) { apply(sessions: reply) }
        } catch let error as EngineClientError where error.refusalCode == "unknown_command" {
            sessionsSupported = false
        } catch let error as EngineClientError where error.refusalCode == "no_project" {
            // The project closed while the request was out; `reset()` follows.
        } catch {
            // The last list stays; the section says why it may be stale.
            sessionsError = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    /// `cli_session_import`: the terminal conversation becomes a new chat of this window, made current by the engine (its
    /// rows stay in the CLI's file: the transcript starts empty, and the review gate applies from the next turn on). Nil
    /// when it was imported, else why not, in the user's words.
    public func importSession(_ sessionId: String) async -> String? {
        guard let app else { return nil }
        guard importingSessionId == nil else { return CliSessionText.importAlreadyRunning }
        importingSessionId = sessionId
        defer { importingSessionId = nil }
        app.replaceTranscriptOnRestore = true   // like `session_open`: the engine's empty transcript_restore replaces the rows
        do {
            _ = try await app.reply(.cliSessionImport(sessionId: sessionId))
            resumable.removeAll { $0.sessionId == sessionId }
            return nil
        } catch let error as EngineClientError {
            app.replaceTranscriptOnRestore = false
            return CliSessionText.importRefusal(code: error.refusalCode, fallback: error.userMessage)
        } catch {
            app.replaceTranscriptOnRestore = false
            return error.localizedDescription
        }
    }

    func apply(sessions reply: CliSessionsReply) {
        running = reply.running
        resumable = reply.resumable
        selfSession = reply.selfSession // MARK: wave4d w4d-peers
        sessionsLoaded = true
        sessionsError = nil
        sessionsSupported = true
    }
}
