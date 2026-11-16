import AppKit
import Observation
import ReviewGateCore

// MARK: terminal-chat (§57.5)
/// One window's terminal chats (`WindowModel.terminals`): the host of each terminal chat by chat id. The live chat's host
/// starts when that chat is the live, shown one (`terminal_spec` → PTY → `terminal_started`); a switch to another chat ends
/// it (the engine retired its hook token with the switch). After an engine restart (its hook port changed) a running host
/// is marked disconnected and offers Restart — it is never killed by itself.
@MainActor @Observable
final class TerminalHub {
    /// The terminal chats' hosts by chat id (at most the live chat's, plus one that is being stopped).
    private(set) var chatHosts: [String: TerminalHost] = [:]
    /// Why the chat's terminal could not start (the engine's refusal in the user's words); Try Again clears it.
    private(set) var specErrors: [String: String] = [:]
    /// Chats whose spec is being asked for now.
    private(set) var spawning: Set<String> = []
    /// The last time the live terminal chat's state changed (a hook, a turn) — "Review now" after 60 s without one.
    private(set) var lastActivity = Date()
    @ObservationIgnored private weak var store: AppState?
    @ObservationIgnored private var enginePIDAtSpawn: [String: Int32] = [:]
    @ObservationIgnored private var keyMonitor: Any?

    /// Wires the window's store: Stop (⌘.) on a terminal chat becomes Esc in its PTY; the hub follows the live chat.
    func attach(store: AppState) {
        guard self.store !== store else { return }
        self.store = store
        store.onTerminalInterrupt = { [weak self, weak store] in
            guard let self, let id = store?.currentSessionId else { return }
            self.chatHosts[id]?.sendEscape()
        }
        observe()
    }

    /// The live terminal chat's host (nil for a chat-kind chat or before it starts).
    func host(for chatId: String?) -> TerminalHost? {
        chatId.flatMap { chatHosts[$0] }
    }

    /// The terminal of `chatId` takes the keyboard (a notification's click, the chat shown again).
    func focus(chatId: String?) {
        host(for: chatId)?.focus()
    }

    /// Restart in the chat's terminal (an exit, a disconnect, the strip's button): the PTY ends, the engine hears it, a
    /// fresh spec (a new hook token, `--resume` once the conversation exists) starts it again.
    func restart(chatId: String) async {
        guard let store, chatId == store.currentSessionId, store.isTerminalChat else { return }
        specErrors[chatId] = nil
        if let host = chatHosts[chatId], host.state.isRunning {
            await host.stop()
            store.terminalExited(sessionId: chatId, exitCode: nil)
        }
        await spawn(chatId)
    }

    /// Every PTY of the window ends (the window closes).
    func stopAll() async {
        let hosts = Array(chatHosts.values)
        chatHosts = [:]
        for host in hosts { await host.stop() }
    }

    /// Quit: SIGTERM to every PTY without waiting (the app is going away).
    func terminateAll() {
        for host in chatHosts.values where host.view.process.running { host.view.terminate() }
    }

    /// §57.6: ⌃` in `window()` toggles the terminal panel whatever has the keyboard. SwiftTerm hands only ⌘ keys to the
    /// menu, so inside a terminal ⌃` would reach the program as NUL; this monitor takes it first (keyCode 50, the key left
    /// of 1 on any layout, with exactly ⌃).
    func installShellToggle(window: @escaping @MainActor () -> NSWindow?, toggle: @escaping @MainActor () -> Void) {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let handled = MainActor.assumeIsolated { () -> Bool in
                guard event.keyCode == 50,
                      event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .function, .numericPad]) == .control,
                      let mine = window(), event.window === mine else { return false }
                toggle()
                return true
            }
            return handled ? nil : event
        }
    }

    /// The window is gone: its key monitor goes with it.
    func removeShellToggle() {
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
    }

    // MARK: Following the live chat

    private func observe() {
        guard let store else { return }
        withObservationTracking {
            _ = store.currentSessionId
            _ = store.isTerminalChat
            _ = store.shownChatId
            _ = store.enginePID
            _ = store.projectURL
            _ = store.sessionInfo.starting
            _ = store.sessionInfo.terminal
            _ = store.gatePhase
            _ = store.errorBanner
        } onChange: {
            Task { @MainActor [weak self] in
                self?.sync()
                self?.observe()
            }
        }
        sync()
    }

    private func sync() {
        guard let store else { return }
        lastActivity = Date()
        // The engine stopped (its window offers to reopen the project): the PTYs stay — their hooks now fail closed, so
        // they are disconnected and offer Restart once the project is open again.
        if store.projectURL == nil, store.errorBanner?.scope == .engine {
            for host in chatHosts.values where host.state.isRunning { host.disconnected = true }
            return
        }
        let current = store.projectURL == nil ? nil : store.currentSessionId
        // A switch away: the old terminal ends (any unsent TUI input is lost — the engine already retired its token).
        for (id, host) in chatHosts where id != current || !store.isTerminalChat {
            chatHosts[id] = nil
            enginePIDAtSpawn[id] = nil
            Task { await host.stop() }
        }
        specErrors = specErrors.filter { $0.key == current }
        guard let current, store.isTerminalChat else { return }
        if let host = chatHosts[current] {
            if host.state.isRunning, let spawned = enginePIDAtSpawn[current], let now = store.enginePID, now != spawned {
                host.disconnected = true
            }
            return
        }
        // Start once the engine runs this chat's session and it is the chat on screen.
        guard store.shownChatId == current, store.sessionInfo.sessionId == current, !store.sessionInfo.starting,
              !spawning.contains(current), specErrors[current] == nil else { return }
        Task { await spawn(current) }
    }

    private func spawn(_ chatId: String) async {
        guard let store, !spawning.contains(chatId) else { return }
        spawning.insert(chatId)
        defer { spawning.remove(chatId) }
        let spec: TerminalSpec
        do {
            spec = try await store.terminalSpec(sessionId: chatId)
        } catch {
            if chatId == store.currentSessionId { specErrors[chatId] = FlowText.refusal(error) }
            return
        }
        guard chatId == store.currentSessionId, store.isTerminalChat else { return }
        let host = chatHosts[chatId] ?? TerminalHost()
        chatHosts[chatId] = host
        host.hooksSeen = { [weak store] in store?.sessionInfo.terminal?.hooksSeen == true }
        host.onExit = { [weak store] code in store?.terminalExited(sessionId: chatId, exitCode: code) }
        let launch = TerminalLaunch.claude(spec: spec, parentEnv: ProcessInfo.processInfo.environment,
                                           loginShell: TerminalLaunch.userLoginShell(), appVersion: Self.appVersion,
                                           debugShell: Self.debugShell)
        guard let pid = host.start(launch: launch) else { return }
        enginePIDAtSpawn[chatId] = store.enginePID
        store.terminalStarted(sessionId: chatId, pid: pid)
    }

    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    /// The screenshot tour's plain `/bin/sh` (no dotfiles); never in a release build.
    static var debugShell: String? {
        #if DEBUG
        TerminalLaunch.debugShell(environment: ProcessInfo.processInfo.environment, bundleIdentifier: Bundle.main.bundleIdentifier)
        #else
        nil
        #endif
    }
}
