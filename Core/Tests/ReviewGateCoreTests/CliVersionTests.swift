import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-session: the CLI version on the Mac (docs/PROTOCOL.md §36.8) — the "not verified yet" banner once per version
/// with "Pin previous version", the cli_version_changed notice as a chat row only, pinning through claudePath and the
/// installed versions.
@Suite @MainActor struct CliVersionTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "CliVersionTests.\(UUID().uuidString)")! }
    private func makeStore(_ d: UserDefaults? = nil) -> AppState { AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d ?? defaults()) }

    private let previousPath = "/Users/me/.local/share/claude/versions/2.1.307"
    private var unverified: CliInfo {
        CliInfo(version: "2.1.308", verified: false, verifiedRange: CliVersionRange(min: "2.1.300", max: "2.1.307"),
                previous: CliPreviousVersion(version: "2.1.307", path: previousPath))
    }

    private func snapshot(seq: Int, cli: CliInfo?) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.session.cli = cli
        s.gate = GateInfo(phase: .idle, canSend: true, canRequestChanges: false, blockedReason: nil, collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    // MARK: - Words

    @Test func noticeWords() {
        #expect(CliVersionText.notice(CliVersionChange(from: "2.1.307", to: "2.1.308", verified: false), message: "x")
                == "Claude Code changed from 2.1.307 to 2.1.308 — not verified yet")
        #expect(CliVersionText.notice(CliVersionChange(from: "2.1.307", to: "2.1.308", verified: true), message: "x")
                == "Claude Code changed from 2.1.307 to 2.1.308")
        #expect(CliVersionText.notice(CliVersionChange(from: nil, to: "2.1.308", verified: false), message: "x")
                == "Claude Code is now 2.1.308 — not verified yet")
        // A restored row keeps only the engine's words (§35.3 rows have no `cli`).
        #expect(CliVersionText.notice(nil, message: "Claude Code changed from 2.1.307 to 2.1.308 (not verified yet).")
                == "Claude Code changed from 2.1.307 to 2.1.308 — not verified yet")
        #expect(CliVersionText.notice(nil, message: "Claude Code changed from 2.1.306 to 2.1.307.") == "Claude Code changed from 2.1.306 to 2.1.307")
        #expect(CliVersionText.notice(nil, message: "Something else") == "Something else")
        #expect(CliVersionText.banner("2.1.308") == "New CLI 2.1.308 — not verified yet")
    }

    // MARK: - Banner

    @Test func bannerOncePerVersionWithPinPrevious() {
        #expect(CliVersionBanner.state(cli: unverified, dismissed: [], pinnedPath: nil)
                == .unverified(version: "2.1.308", range: CliVersionRange(min: "2.1.300", max: "2.1.307"),
                               previous: CliPreviousVersion(version: "2.1.307", path: previousPath)))
        #expect(CliVersionBanner.state(cli: unverified, dismissed: ["2.1.308"], pinnedPath: nil) == nil)
        #expect(CliVersionBanner.state(cli: CliInfo(version: "2.1.307", verified: true), dismissed: [], pinnedPath: nil) == nil)
        #expect(CliVersionBanner.state(cli: nil, dismissed: [], pinnedPath: nil) == nil)
        // Pinned but still running the new one: restart to use it.
        #expect(CliVersionBanner.state(cli: unverified, dismissed: [], pinnedPath: previousPath)
                == .pinnedNeedsRestart(version: "2.1.307", running: "2.1.308"))
        // Another version pinned in Settings (a file of the versions folder) counts too; a hand-picked claude does not.
        #expect(CliVersionBanner.state(cli: unverified, dismissed: [], pinnedPath: "/Users/me/.local/share/claude/versions/2.1.305")
                == .pinnedNeedsRestart(version: "2.1.305", running: "2.1.308"))
        if case .unverified? = CliVersionBanner.state(cli: unverified, dismissed: [], pinnedPath: "/opt/homebrew/bin/claude") {} else {
            Issue.record("a hand-picked claude is not a version pin")
        }
        // The unverified version itself pinned on purpose: the plain banner.
        if case .unverified? = CliVersionBanner.state(cli: unverified, dismissed: [], pinnedPath: "/Users/me/.local/share/claude/versions/2.1.308") {} else {
            Issue.record("pinning the running version is not a pending pin")
        }
        // Closing applies to the pinned state too (the running version is the key).
        #expect(CliVersionBanner.state(cli: unverified, dismissed: ["2.1.308"], pinnedPath: previousPath) == nil)
        // No installed previous version: the banner without the pin button.
        var noPath = unverified
        noPath.previous = CliPreviousVersion(version: "2.1.307", path: nil)
        if case let .unverified(_, _, previous)? = CliVersionBanner.state(cli: noPath, dismissed: [], pinnedPath: nil) {
            #expect(previous?.path == nil)
        } else {
            Issue.record("expected the unverified banner")
        }
    }

    @Test func dismissedVersionsAreAppWide() {
        let d = defaults()
        #expect(AppSettings.dismissedCliVersions(defaults: d).isEmpty)
        AppSettings.dismissCliVersion("2.1.308", defaults: d)
        AppSettings.dismissCliVersion("2.1.308", defaults: d)
        AppSettings.dismissCliVersion("2.1.309", defaults: d)
        #expect(AppSettings.dismissedCliVersions(defaults: d) == ["2.1.308", "2.1.309"])
        let store = makeStore(d)
        store.handle(.state(snapshot(seq: 1, cli: unverified)))
        #expect(store.cliVersionBanner == nil)   // dismissed in any window
    }

    @Test func storeBannerAndPinning() {
        let d = defaults()
        let store = makeStore(d)
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1, cli: unverified)))
        #expect(store.cliVersionBanner != nil)
        store.pinClaude(path: previousPath)
        #expect(AppSettings.claudePathOverride(defaults: d) == previousPath)
        guard case let .setSettings(settings)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(settings.claudePath == previousPath)
        #expect(store.cliVersionBanner == .pinnedNeedsRestart(version: "2.1.307", running: "2.1.308"))
        // The restarted session runs the pinned version (verified): no banner.
        store.handle(.state(snapshot(seq: 2, cli: CliInfo(version: "2.1.307", verified: true))))
        #expect(store.cliVersionBanner == nil)
        store.unpinClaude()
        #expect(AppSettings.claudePathOverride(defaults: d) == nil)
        guard case let .setSettings(cleared)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(cleared.claudePath == "")   // "" unpins (nil would leave it as it is)
    }

    // MARK: - Notice row

    @Test func versionNoticeIsAChatRowOnly() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, cli: unverified)))
        var detail = EngineErrorDetail(code: "cli_version_changed")
        detail.cli = CliVersionChange(from: "2.1.307", to: "2.1.308", verified: false)
        store.handle(.error(message: "Claude Code changed from 2.1.307 to 2.1.308 (not verified yet).", fatal: false, scope: .session, detail: detail))
        #expect(store.errorBanner == nil)            // the banner comes from session.cli
        #expect(store.queuePausedReason == nil)      // a notice never stops the queue
        #expect(store.lastError == nil)
        let rows = store.transcript.compactMap { item -> String? in
            if case let .error(_, message, _, _) = item { return message }
            return nil
        }
        #expect(rows == ["Claude Code changed from 2.1.307 to 2.1.308 — not verified yet"])
        #expect(SessionNotices.style(code: "cli_version_changed", fatal: false) == .info)
    }

    // MARK: - Pins

    @Test func pinNamesAVersionOnlyInTheVersionsFolder() {
        #expect(CliVersionPin.version(ofPath: "/Users/me/.local/share/claude/versions/2.1.307") == "2.1.307")
        #expect(CliVersionPin.version(ofPath: " /Users/me/.local/share/claude/versions/2.1.307 ") == "2.1.307")
        #expect(CliVersionPin.version(ofPath: "/opt/homebrew/bin/claude") == nil)
        #expect(CliVersionPin.version(ofPath: "") == nil)
        #expect(CliVersionPin.version(ofPath: nil) == nil)
        #expect(CliVersionList.pinDiffersFromRunning(pinnedPath: "/v/versions/2.1.307", running: "2.1.308"))
        #expect(!CliVersionList.pinDiffersFromRunning(pinnedPath: "/v/versions/2.1.308", running: "2.1.308"))
        #expect(!CliVersionList.pinDiffersFromRunning(pinnedPath: nil, running: "2.1.308"))
        #expect(!CliVersionList.pinDiffersFromRunning(pinnedPath: "/v/versions/2.1.307", running: nil))
    }

    @Test func versionRowsMarkRunningAndPinned() {
        let reply = CliVersionsReply(versions: [CliVersionEntry(version: "2.1.308", path: "/v/versions/2.1.308", verified: false),
                                                CliVersionEntry(version: "2.1.307", path: "/v/versions/2.1.307", verified: true)],
                                     current: "2.1.308", pinnedPath: nil)
        let rows = CliVersionList.rows(reply, running: nil, pinnedPath: "/v/versions/2.1.307")
        #expect(rows.map(\.entry.version) == ["2.1.308", "2.1.307"])
        #expect(rows.map(\.isRunning) == [true, false])
        #expect(rows.map(\.isPinned) == [false, true])
        // The session's own version wins over the reply's `current`.
        #expect(CliVersionList.rows(reply, running: "2.1.307", pinnedPath: nil).map(\.isRunning) == [false, true])
    }

    // MARK: - Installed versions

    @Test func installedVersions() async {
        let store = makeStore()
        store.replySink = { command in
            #expect(command == .cliVersions)
            return .cliVersions(CliVersionsReply(versions: [CliVersionEntry(version: "2.1.308", path: "/v/2.1.308", verified: false),
                                                            CliVersionEntry(version: "2.1.307", path: "/v/2.1.307", verified: true)],
                                                 current: "2.1.308", pinnedPath: nil))
        }
        await store.sessionTools.refreshVersions()
        #expect(store.sessionTools.versions?.versions.map(\.version) == ["2.1.308", "2.1.307"])
        #expect(store.sessionTools.versionsSupported)
        store.replySink = { _ in throw EngineClientError.refused("unknown command: cli_versions", code: "unknown_command") }
        await store.sessionTools.refreshVersions()
        #expect(!store.sessionTools.versionsSupported)
    }
}
