import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §55.11: Settings' panes, the search across them and when each change applies.
@MainActor
@Suite struct SettingsCatalogTests {
    private let korean = [
        "Auto-allow Bash": "Bash 자동 허용",
        "Permissions": "권한",
        "Return sends the message": "↩로 메시지 보내기",
        "System prompt append": "시스템 프롬프트 추가문",
        "Session": "세션",
    ]

    private func ids(_ query: String) -> [String] {
        SettingsCatalog.search(query, localize: { korean[$0] ?? $0 }).map(\.id)
    }

    private func makeStore(_ defaults: UserDefaults) -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
    }

    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "SettingsCatalogTests.\(UUID().uuidString)")!
    }

    private func state(seq: Int, open: Bool, starting: Bool) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.session = SessionInfo(open: open, starting: starting, sessionId: open ? "chat-1" : nil, model: nil, capabilities: nil,
                                pendingPermission: nil, canRestart: open && !starting)
        return s
    }

    // MARK: Search

    @Test func findsByTitleInEitherLanguageAnyCaseAndEveryWord() {
        #expect(ids("bash").contains("autoAllowBash"))
        #expect(ids("BASH").contains("autoAllowReadOnlyBash"))
        #expect(ids("자동 허용").contains("autoAllowBash"))
        #expect(ids("허용 Bash") == ids("Bash 허용"))
        #expect(ids("↩로").contains("returnSends"))
        // Every word has to be there: "bash" alone finds more than "bash read-only".
        #expect(ids("bash read-only") == ["autoAllowReadOnlyBash"])
    }

    @Test func findsByExplanationSectionAndPaneName() {
        #expect(ids("{maxFiles}") == ["systemPromptAppend"])   // only in its explanation
        #expect(ids("heap dump") == ["largeFileMB"])
        #expect(ids("Closing and quitting").contains("confirmQuit"))   // the section
        let byPane = ids("권한")   // the pane's Korean name finds its rows
        #expect(byPane.contains("bashAllowPatterns") && byPane.contains("allowWorktreeIsolation"))
        #expect(!byPane.contains("returnSends"))
    }

    @Test func anEmptyQueryFindsNothingAndANonsenseOneToo() {
        #expect(ids("").isEmpty)
        #expect(ids("   ").isEmpty)
        #expect(ids("zzz-nothing").isEmpty)
    }

    @Test func resultsKeepThePaneOrder() {
        let panes = SettingsCatalog.search("a").map(\.pane)
        let order = SettingsPane.allCases
        #expect(panes == panes.sorted { order.firstIndex(of: $0)! < order.firstIndex(of: $1)! })
    }

    // MARK: The index

    @Test func idsAreUniqueAndEveryPaneHasRows() {
        let all = SettingsCatalog.entries.map(\.id)
        #expect(Set(all).count == all.count)
        for pane in SettingsPane.allCases {
            #expect(SettingsCatalog.entries.contains { $0.pane == pane }, "no rows in \(pane)")
        }
    }

    @Test func aStoredTabFromBeforeTheSplitStillOpensThere() {
        #expect(SettingsPane(stored: "general") == .general)
        #expect(SettingsPane(stored: "extensions") == .extensions)
        #expect(SettingsPane(stored: "project") == .project)
        #expect(SettingsPane(stored: "accounts") == .accounts)
        #expect(SettingsPane(stored: "gone") == .general)
        #expect(SettingsPane(stored: nil) == .general)
    }

    // MARK: When a change applies

    @Test func whenEachSettingApplies() {
        // What the engine reads when a session starts.
        for id in ["autoAllowBash", "loadUserSettings", "systemPromptAppend", "backgroundWork", "subagentsInTurn",
                   "allowWorktreeIsolation", "maxTurns", "claudePath", "cliPin", "disabledPlugins", "disableUserHooks"] {
            #expect(SettingsCatalog.applies(id) == .nextSession, "\(id)")
        }
        // Pushed to every open window at once.
        for id in ["returnSends", "appearance", "autoAllowReadOnlyBash", "bashAllowPatterns", "applyUserAllowRules",
                   "applyUserBashRules", "budgetEnabled", "autoRestartSession", "checkpointIgnorePatterns", "sideModel",
                   "peerInbound", "newChatKind", "terminalPermissionBridge", "worktreeRoot", "commitTrailer"] {
            #expect(SettingsCatalog.applies(id) == .immediately, "\(id)")
        }
        #expect(SettingsCatalog.applies("nodePath") == .newWindow)   // the engine process is started with it
        #expect(SettingsCatalog.applies("startPermissionMode") == .newProject)
        #expect(SettingsCatalog.applies("no-such-setting") == .immediately)
        #expect(SettingApplies.immediately.badge == nil)
        #expect(SettingApplies.nextSession.badge == "Next session")
    }

    @Test func everySettingTheBannerNamesIsANextSessionRow() {
        var start = SessionStartSettings()
        var now = start
        now.autoAllowBash = true
        now.loadUserSettings = false
        now.systemPromptAppend = "Be brief."
        now.backgroundWork = false
        now.subagentsInTurn = true
        now.allowWorktreeIsolation = false
        now.maxTurns = 120
        now.claudePath = "/opt/claude"
        let changed = now.changed(since: start)
        #expect(changed.count == 8)
        for id in changed { #expect(SettingsCatalog.applies(id) == .nextSession, "\(id)") }
        start.disableUserHooks = true   // plugins and hooks: the Extensions pane compares with what the session applied
        #expect(now.changed(since: start) == changed)
        #expect(now.changed(since: now).isEmpty)
    }

    // MARK: The window's session

    @Test func theWaitingListFollowsTheSessionStartAndARestartClearsIt() {
        let defaults = freshDefaults()
        let store = makeStore(defaults)
        #expect(store.settingsWaitingForRestart.isEmpty)   // no session
        store.handle(.state(state(seq: 1, open: true, starting: true)))
        store.handle(.state(state(seq: 2, open: true, starting: false)))
        #expect(store.settingsWaitingForRestart.isEmpty)
        defaults.set(true, forKey: AppSettings.Key.autoAllowBash)
        defaults.set("Keep it short.", forKey: AppSettings.Key.systemPromptAppend)
        #expect(store.settingsWaitingForRestart == ["autoAllowBash", "systemPromptAppend"])
        defaults.set(false, forKey: AppSettings.Key.autoAllowBash)   // changed back: nothing waits for it
        #expect(store.settingsWaitingForRestart == ["systemPromptAppend"])
        store.handle(.state(state(seq: 3, open: true, starting: true)))   // restart_session: the new session reads them
        store.handle(.state(state(seq: 4, open: true, starting: false)))
        #expect(store.settingsWaitingForRestart.isEmpty)
        defaults.set(true, forKey: AppSettings.Key.autoAllowBash)
        store.handle(.state(state(seq: 5, open: false, starting: false)))   // the project closed
        #expect(store.settingsWaitingForRestart.isEmpty)
        #expect(store.settingsAtSessionStart == nil)
    }

    @Test func theSessionStartSettingsGoToTheEngineSoARestartTakesThem() {
        let defaults = freshDefaults()
        defaults.set(true, forKey: AppSettings.Key.autoAllowBash)
        defaults.set(false, forKey: AppSettings.Key.loadUserSettings)
        defaults.set("Mind {maxFiles} files.", forKey: AppSettings.Key.systemPromptAppend)
        let store = makeStore(defaults)
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.pushSessionStartSettings()
        guard case let .setSettings(settings)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(settings.autoAllowTools == ["Bash"])
        #expect(settings.loadUserSettings == false)
        #expect(settings.systemPromptAppend == AppSettings.renderedSystemPromptAppend(defaults: defaults))
        #expect(settings.budget == nil && settings.claudePath == nil)   // nothing else rides along
    }
}
