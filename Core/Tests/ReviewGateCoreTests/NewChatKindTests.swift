import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §57.7: a new chat is a terminal chat unless Settings › "New chats open as" says Chat; both kinds keep an
/// item of their own; flows that send for the user never type into a terminal chat — they paste only on a click.
@Suite @MainActor struct NewChatKindTests {
    private func makeDefaults() -> UserDefaults {
        UserDefaults(suiteName: "NewChatKindTests.\(UUID().uuidString)")!
    }

    private func makeState(_ defaults: UserDefaults) -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
    }

    private func snapshot(seq: Int, phase: GatePhase = .idle, current: String = "c1") -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: current, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        let idle = phase == .idle
        s.gate = GateInfo(phase: phase, canSend: idle, canRequestChanges: false, blockedReason: idle ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil, changedOutside: [], ignoredTouched: [],
                          filteredByPattern: [], restored: false)
        var term = SessionMeta(id: "t1", title: "In the terminal")
        term.kind = .terminal
        s.sessions = SessionsInfo(list: [term, SessionMeta(id: "c1", title: "Chat")], currentId: current, openTabIds: ["t1", "c1"])
        return s
    }

    @Test func absentMeansTerminal() {
        let defaults = makeDefaults()
        #expect(AppSettings.newChatKind(defaults: defaults) == .terminal)
        defaults.set("bogus", forKey: AppSettings.Key.newChatKind)
        #expect(AppSettings.newChatKind(defaults: defaults) == .terminal)
        AppSettings.setNewChatKind(.chat, defaults: defaults)
        #expect(AppSettings.newChatKind(defaults: defaults) == .chat)
        #expect(defaults.string(forKey: "newChatKind") == "chat")
    }

    @Test func everyNewChatEntryUsesTheDefault() async {
        let defaults = makeDefaults()
        let app = makeState(defaults)
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        // ⌘T / [+] / the banner's 새 채팅 (all `newChat()`): a terminal chat by default.
        #expect(app.defaultChatKind == .terminal)
        #expect(await app.newChat())
        #expect(fired.last == .sessionNewTerminal)
        app.startNewChat()
        await eventually { fired.filter { $0 == .sessionNewTerminal }.count == 2 }
        #expect(fired.filter { $0 == .sessionNewTerminal }.count == 2)
        // The setting switches it.
        AppSettings.setNewChatKind(.chat, defaults: defaults)
        #expect(await app.newChat())
        #expect(fired.last == .sessionNew)
        // The explicit items ignore it.
        #expect(await app.newTerminalChat())
        #expect(fired.last == .sessionNewTerminal)
        AppSettings.setNewChatKind(.terminal, defaults: defaults)
        #expect(await app.newClassicChat())
        #expect(fired.last == .sessionNew)
    }

    @Test func whileClaudeWorksTheDefaultKindIsHeld() async {
        let defaults = makeDefaults()
        let app = makeState(defaults)
        app.commandSink = { _ in }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(await app.newChat())
        #expect(app.pendingChatSwitch == .newTerminalChat)
        AppSettings.setNewChatKind(.chat, defaults: defaults)
        #expect(await app.newChat())
        #expect(app.pendingChatSwitch == .newChat)
    }

    @Test func theEngineHearsTheDefault() throws {
        let defaults = makeDefaults()
        #expect(AppSettings.engineSettings(defaults: defaults).newChatKind == .terminal)
        let data = try JSONEncoder().encode(AppSettings.engineSettings(defaults: defaults))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["newChatKind"] as? String == "terminal")
        AppSettings.setNewChatKind(.chat, defaults: defaults)
        #expect(AppSettings.engineSettings(defaults: defaults).newChatKind == .chat)
        // A change goes to a running engine at once.
        let app = makeState(defaults)
        var fired: [EngineCommand] = []
        app.commandSink = { fired.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        app.pushNewChatKind()
        var expected = EngineSettings()
        expected.newChatKind = .chat
        #expect(fired.last == .setSettings(expected))
    }

    @Test func aPasteIsBracketedAndNeverEnter() throws {
        #expect(TerminalPaste.bytes("hi", bracketed: false) == nil)
        #expect(TerminalPaste.bytes("", bracketed: true) == nil)
        let bytes = try #require(TerminalPaste.bytes("fix it\nplease\r\n", bracketed: true))
        #expect(Array(bytes.prefix(6)) == TerminalPaste.start)
        #expect(Array(bytes.suffix(6)) == TerminalPaste.end)
        let body = String(decoding: bytes.dropFirst(6).dropLast(6), as: UTF8.self)
        #expect(body == "fix it\rplease\r")
        // A paste-end marker inside cannot end the paste early (the rest would be typed keys).
        let sneaky = try #require(TerminalPaste.bytes("a\u{1b}[201~\r", bracketed: true))
        #expect(String(decoding: sneaky.dropFirst(6).dropLast(6), as: UTF8.self) == "a\r")
    }

    @Test func flowsThatSendPasteOnlyIntoALiveTerminalChat() {
        let app = makeState(makeDefaults())
        app.commandSink = { _ in }
        // A chat: there is no terminal to paste into (its flows send as before).
        app.handle(.state(snapshot(seq: 1)))
        #expect(app.pasteIntoTerminal("x") == NewChatKindText.notTerminal)
        // A terminal chat whose terminal the App has not wired (not running).
        app.handle(.state(snapshot(seq: 2, current: "t1")))
        #expect(app.pasteIntoTerminal("x") == NewChatKindText.terminalNotRunning)
        var pasted: [String] = []
        app.onTerminalPaste = { pasted.append($0); return nil }
        #expect(app.pasteIntoTerminal("review the PR comments") == nil)
        #expect(pasted == ["review the PR comments"])
        // Accept & Continue sends for the user: never offered in a terminal chat.
        #expect(!app.canAcceptAndContinue)
    }
}
