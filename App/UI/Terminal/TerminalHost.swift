import AppKit
import Observation
import ReviewGateCore
@preconcurrency import SwiftTerm

// MARK: terminal-chat (§57.5)
/// One terminal view and the PTY it runs. The host owns the view, so re-renders, the PRs tab or a closed panel never end
/// the process; `TerminalContainer` only shows it. A restart makes a fresh view (a clean screen and scrollback).
@MainActor @Observable
final class TerminalHost: LocalProcessTerminalViewDelegate {
    enum State: Equatable {
        case idle
        case starting
        case running(pid: Int32)
        /// `quickNoHooks`: it ended within 10 s and no hook ever came (Claude Code's trust question answered "No", a CLI
        /// that failed at once) — the chat's overlay explains.
        case exited(code: Int32?, quickNoHooks: Bool)
        case failed(String)

        var isRunning: Bool {
            switch self {
            case .starting, .running: true
            case .idle, .exited, .failed: false
            }
        }
    }

    private(set) var state: State = .idle
    /// Bumped for each new view (`TerminalContainer` re-attaches; delayed focus calls of an older start do nothing).
    private(set) var generation = 0
    /// What the program set with OSC 0/2 (the shell panel's tab title).
    private(set) var title = ""
    /// The engine restarted while this PTY ran (its hooks now fail closed): the chat offers Restart.
    var disconnected = false
    private(set) var view: ReviewTerminalView
    @ObservationIgnored private var startedAt: Date?
    @ObservationIgnored private var exitWaiters: [CheckedContinuation<Void, Never>] = []
    /// Asked when the PTY ends: did any hook arrive for this spawn (`quickNoHooks`)?
    @ObservationIgnored var hooksSeen: (() -> Bool)?
    /// The PTY ended (after `state` changed); not called for a `stop()` of the host's own.
    @ObservationIgnored var onExit: ((Int32?) -> Void)?
    @ObservationIgnored private var stopping = false

    /// `size`: the view's size before it is laid out — near the real one, so the first lines a program prints are not
    /// pushed out of sight when the view shrinks to its place.
    init(size: NSSize = NSSize(width: 800, height: 480)) {
        view = ReviewTerminalView(frame: NSRect(origin: .zero, size: size))
        configure(view)
    }

    /// Starts `launch` in a fresh view; returns the child's pid (nil when it could not start).
    @discardableResult
    func start(launch: TerminalLaunch) -> Int32? {
        // Who has the keyboard now: the delayed focus below only moves it when nobody took it meanwhile.
        let window = view.window
        let atSpawn = window.map { Self.keyHolder($0.firstResponder) } ?? nil
        let old = view
        let fresh = ReviewTerminalView(frame: view.frame)
        configure(fresh)
        view.processDelegate = nil
        view.stopCaretObservation()
        if view.process.running { terminate() }
        view = fresh
        generation += 1
        disconnected = false
        state = .starting
        startedAt = Date()
        fresh.startProcess(executable: launch.executable, args: launch.args, environment: launch.env,
                           execName: launch.execName, currentDirectory: launch.cwd)
        let pid = fresh.process.shellPid
        guard pid > 0 else {
            state = .failed(String(localized: "The terminal could not start \(launch.executable)"))
            return nil
        }
        fresh.enableUTF8LineEditing()
        state = .running(pid: pid)
        let gen = generation
        // Once it is on screen: the keyboard goes to the new terminal (never NSApp.activate — only this window's responder)
        // — unless the user put it somewhere else meanwhile (a field they clicked: Return would otherwise go to the TUI).
        for delay in [0.3, 1.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self, weak atSpawn, weak old] in
                MainActor.assumeIsolated {
                    guard let self, gen == self.generation, let w = self.view.window else { return }
                    let now = Self.keyHolder(w.firstResponder)
                    guard now == nil || now === w || now === w.contentView || now === atSpawn || now === old || now === self.view else { return }
                    self.focus()
                }
            }
        }
        return pid
    }

    /// Ends the PTY: SIGTERM, then SIGKILL after 3 s — to its whole process group (what claude or the shell started in it:
    /// tools, MCP servers). Returns once it is reaped (or at once when nothing runs).
    func stop() async {
        guard view.process.running else { return }
        stopping = true
        defer { stopping = false }
        let group = processGroup()
        terminate()
        let ended = await waitForExit(seconds: 3)
        if !ended, let group {
            kill(-group, SIGKILL)
            _ = await waitForExit(seconds: 2)
        } else if !ended, view.process.shellPid > 0 {
            kill(view.process.shellPid, SIGKILL)
            _ = await waitForExit(seconds: 2)
        }
    }

    /// SIGTERM to the PTY's process group (and its child, through SwiftTerm) without waiting.
    func terminate() {
        let group = processGroup()
        view.terminate()
        if let group { kill(-group, SIGTERM) }
    }

    /// The PTY child's process group — its own (forkpty makes it a session leader), never the app's; nil when it is gone.
    private func processGroup() -> pid_t? {
        let pid = view.process.shellPid
        guard pid > 0 else { return nil }
        let group = getpgid(pid)
        return group > 1 && group != getpgrp() ? group : nil
    }

    /// `stop()` and `start(launch:)`.
    @discardableResult
    func restart(launch: TerminalLaunch) async -> Int32? {
        await stop()
        return start(launch: launch)
    }

    /// Types `text` into the PTY (the screenshot tour's fake claude only; the user types themselves).
    func send(text: String) {
        view.send(data: ArraySlice(Array(text.utf8)))
    }

    /// §57.7: `text` as one bracketed paste (`TerminalPaste`) — only when the program turned bracketed paste on, so a line
    /// break never acts as Enter. False: nothing was written.
    func paste(_ text: String) -> Bool {
        guard let bytes = TerminalPaste.bytes(text, bracketed: view.terminalStateSnapshot().bracketedPasteMode) else { return false }
        view.send(data: ArraySlice(bytes))
        return true
    }

    /// Esc into the PTY: Stop (⌘.) on a terminal chat — the TUI stops Claude as in any terminal.
    func sendEscape() {
        view.send(data: [0x1b])
    }

    // MARK: terminal-friction (§58, §57.4, §57.5)

    /// §58: "Accept N & Continue" — `text` as one bracketed paste, then Enter a moment later (its own write, so the TUI
    /// reads it as the key, not as part of the paste). The user's click only; nothing automatic presses Enter.
    func submit(_ text: String) -> Bool {
        guard paste(text) else { return false }
        let gen = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, gen == self.generation, self.state.isRunning else { return }
                self.view.send(data: [0x0d])
            }
        }
        return true
    }

    /// The program turned bracketed paste on: a paste can go in now.
    var acceptsPaste: Bool { view.terminalStateSnapshot().bracketedPasteMode }

    /// §57.4: the user pressed Esc in this terminal (when); set for a terminal chat's host only.
    @ObservationIgnored var onEscape: ((Date) -> Void)?
    @ObservationIgnored private var escapeFilter = EscapeKeyFilter()

    private func noteInput(_ data: ArraySlice<UInt8>) {
        guard let onEscape else { return }
        if let at = escapeFilter.input(data, at: Date()) { onEscape(at) }
        guard data.count == 1, TerminalEscapeKey.isEscape(data) else { return }
        // A lone ESC is the Esc key once nothing follows it (⌥Return and the like send ESC, then the key).
        DispatchQueue.main.asyncAfter(deadline: .now() + EscapeKeyFilter.metaWindow + 0.02) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let at = self.escapeFilter.flush(now: Date()) else { return }
                self.onEscape?(at)
            }
        }
    }

    /// §57.5: a terminal chat's host takes files dropped on it (read when a start makes its view).
    @ObservationIgnored var takesFileDrops = false

    /// §57.5: files dropped on the terminal — their shell-escaped paths, as Terminal.app writes them, one bracketed paste
    /// and no Enter; the terminal takes the keyboard. Refused (with a toast saying why) while nothing runs or the program
    /// has no bracketed paste.
    private func dropFiles(_ urls: [URL]) -> Bool {
        guard state.isRunning, !disconnected else {
            Toast.show(NewChatKindText.terminalNotRunning, systemImage: "exclamationmark.triangle.fill")
            return false
        }
        guard paste(TerminalPathText.dropText(urls.map(\.path))) else {
            Toast.show(NewChatKindText.terminalNotReady, systemImage: "exclamationmark.triangle.fill")
            return false
        }
        focus()
        return true
    }

    /// The keyboard goes to the terminal when its window shows it (`makeFirstResponder` only; the app is never activated).
    func focus() {
        guard let window = view.window, window.firstResponder !== view else { return }
        window.makeFirstResponder(view)
    }

    /// Who holds the keyboard: a text field's shared field editor stands for the field it edits.
    private static func keyHolder(_ responder: NSResponder?) -> NSResponder? {
        if let text = responder as? NSText, text.isFieldEditor, let field = text.delegate as? NSResponder { return field }
        return responder
    }

    /// The terminal has the keyboard.
    var isFocused: Bool { view.window?.firstResponder === view }

    /// The visible screen's text, one line per row (the tour's checks).
    func screenLines(scrollback: Int = 500) -> [String] {
        view.terminalContentSnapshot(region: .history(maximumScrollbackRows: scrollback))?.rows.map(\.text) ?? []
    }

    /// The screen's rows joined without breaks, so a line the terminal wrapped reads whole (the tour's checks).
    func screenText() -> String { screenLines().joined() }

    /// Every terminal's font (the chat's and the shell panel's).
    static let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)

    /// §57.5: the width in points a terminal needs for `columns` cells of `font` — SwiftTerm's cell is the advance of "W"
    /// snapped to the pixel grid, plus a legacy scroller's width when scroll bars always show.
    static func width(columns: Int) -> CGFloat {
        var unit: UniChar = 0x57
        var glyph: CGGlyph = 0
        let advance = CTFontGetGlyphsForCharacters(font, &unit, &glyph, 1) ? font.advancement(forGlyph: NSGlyph(glyph)).width : 8
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let cell = (advance * scale).rounded() / scale
        let scroller = NSScroller.preferredScrollerStyle == .legacy ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0
        return ceil(cell * CGFloat(columns) + scroller)
    }

    private func configure(_ v: ReviewTerminalView) {
        v.processDelegate = self
        v.font = Self.font
        v.nativeBackgroundColor = NSColor(calibratedRed: 0.08, green: 0.08, blue: 0.09, alpha: 1)
        v.nativeForegroundColor = NSColor(calibratedWhite: 0.9, alpha: 1)
        v.caretColor = NSColor.systemTeal
        // ⌥ is Meta only on Enter / Esc / Tab / Backspace and arrows outside a composition, so ⌥Return during 한 reaches
        // the input method (Hanja) and ⌥-letters type their characters.
        v.optionAsMetaKey = false
        v.optionAsMetaKeyForFunctionalKeys = true
        v.onInput = { [weak self] data in
            MainActor.assumeIsolated { self?.noteInput(data) }
        }
        if takesFileDrops {
            v.onDropFiles = { [weak self] urls in
                MainActor.assumeIsolated { self?.dropFiles(urls) ?? false }
            }
        }
    }

    private func waitForExit(seconds: Double) async -> Bool {
        guard view.process.running else { return true }
        let gen = generation
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            self?.resumeWaiters()
        }
        await withCheckedContinuation { exitWaiters.append($0) }
        timeout.cancel()
        return gen != generation || !view.process.running
    }

    private func resumeWaiters() {
        let waiters = exitWaiters
        exitWaiters = []
        waiters.forEach { $0.resume() }
    }

    // MARK: LocalProcessTerminalViewDelegate

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}

    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        guard source === view else { return }
        self.title = title
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func processFailedToStart(source: TerminalView, error: LocalProcessError) {
        guard source === view else { return }
        state = .failed(String(localized: "The terminal could not start: \(String(describing: error))"))
        resumeWaiters()
    }

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        guard source === view else { return }
        let quick = startedAt.map { Date().timeIntervalSince($0) < 10 } ?? false
        state = .exited(code: exitCode, quickNoHooks: quick && hooksSeen?() != true)
        resumeWaiters()
        if !stopping { onExit?(exitCode) }
    }
}
