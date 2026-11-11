import AppKit
import ReviewGateCore

// MARK: wave4 w4-safety

/// Audit daily-12: a window's close (⌘W, the close button) asks first while Claude works or waits for the user, and —
/// polish P1-chrome-01 / P5-sheets-51 — the last window's close asks like a quit and then quits (its engine stops with it,
/// so the app has nothing left to do). The words are Core `QuitPrompt`. SwiftUI owns the window's delegate, so this one sits
/// in front of it: it answers `windowShouldClose(_:)` and hands every other delegate message to SwiftUI's delegate untouched.
@MainActor
final class CloseGuardDelegate: NSObject, NSWindowDelegate {
    /// Read by the NSObject overrides below (nonisolated by signature); AppKit calls them on the main thread only.
    nonisolated(unsafe) private let original: NSWindowDelegate?
    private weak var entry: WorkbenchWindowEntry?
    /// The user answered "Close": the next `windowShouldClose` goes through.
    private var confirmed = false
    private var asking = false

    private init(original: NSWindowDelegate?, entry: WorkbenchWindowEntry) {
        self.original = original
        self.entry = entry
    }

    /// Puts a guard in front of `window`'s delegate (once; again if SwiftUI replaced it). The window holds its delegate
    /// weakly, so the entry keeps the guard alive.
    static func install(on window: NSWindow, entry: WorkbenchWindowEntry) {
        if let current = window.delegate as? CloseGuardDelegate, current.entry === entry { return }
        let guardDelegate = CloseGuardDelegate(original: window.delegate, entry: entry)
        entry.closeGuard = guardDelegate
        window.delegate = guardDelegate
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (original?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let original, original.responds(to: aSelector) { return original }
        return super.forwardingTarget(for: aSelector)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        let proceed = { self.original?.windowShouldClose?(sender) ?? true }
        if confirmed { confirmed = false; return proceed() }
        guard let entry else { return proceed() }
        guard !asking else { return false }
        let registry = WorkbenchRegistry.shared
        // The last workbench window: its close is a quit — asked as one, then the app quits with the window list intact.
        if registry.entries.count == 1, registry.entries.first === entry {
            guard !AppQuit.isQuitting else { return proceed() }
            guard let prompt = registry.quitPrompt(kind: .lastWindow) else {
                AppQuit.terminate()
                return false
            }
            ask(prompt, in: sender) { suppress in
                if suppress { AppSettings.setConfirmQuit(false) }
                AppQuit.terminate()
            }
            return false
        }
        guard let prompt = QuitPrompt.close(entry.quitState, confirmWhileWorking: AppSettings.confirmCloseWhileWorking()) else {
            return proceed()
        }
        ask(prompt, in: sender) { [weak self] suppress in
            if suppress { AppSettings.setConfirmCloseWhileWorking(false) }
            self?.confirmed = true
            sender.performClose(nil)
        }
        return false
    }

    private func ask(_ prompt: QuitPrompt, in window: NSWindow, then go: @escaping @MainActor (_ suppress: Bool) -> Void) {
        asking = true
        let alert = WorkSafetyAlerts.alert(for: prompt)
        alert.beginSheetModal(for: window) { [weak self] response in
            self?.asking = false
            guard response == .alertFirstButtonReturn else { return }
            go(alert.suppressionButton?.state == .on)
        }
    }
}

/// polish p-lifecycle — P1-chrome-01 / P5-sheets-48 / PX-14: who is quitting. The last window's close and an update's or a
/// move's restart answered (or need) no question; `applicationShouldTerminate` asks only the others.
@MainActor
enum AppQuit {
    /// The quit was already asked about (the last window's close) or is the app's own (an update's restart, the move to
    /// Applications): `applicationShouldTerminate` does not ask again.
    static var withoutAsking = false
    /// `applicationShouldTerminate` went ahead: the windows closing meanwhile ask nothing.
    static var isQuitting = false
    /// P5-sheets-48: this launch follows an update's restart or the move to Applications — the last windows come back
    /// whatever "Reopen last projects" says (read once, at launch).
    static var restoresOnce = false

    /// Quits without asking again — from the run loop, not from this main-queue job: Quit's `.terminateLater` waits for
    /// engine shutdown tasks that need the main queue (the hang 0.5.6–0.5.8 had).
    static func terminate() {
        withoutAsking = true
        RunLoop.main.perform { NSApp.terminate(nil) }
    }
}

@MainActor
enum WorkSafetyAlerts {
    /// A `QuitPrompt` as an alert: [Quit / Close / Switch …] [Cancel], "Don't ask again" when it offers it, Cancel the
    /// default button (Return) when something would be lost.
    static func alert(for prompt: QuitPrompt) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = prompt.title
        alert.informativeText = prompt.message
        let confirm = alert.addButton(withTitle: prompt.confirm)
        let cancel = alert.addButton(withTitle: prompt.cancel)
        cancel.keyEquivalent = "\u{1b}"
        if prompt.cancelIsDefault {
            confirm.keyEquivalent = ""
            confirm.hasDestructiveAction = true
            cancel.keyEquivalent = "\r"
        }
        if prompt.offersSuppression {
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = CloseGuardText.dontAskAgain
        }
        return alert
    }

    /// polish P1-chrome-03: a window's question (a project switch or close) as a sheet on `window` — app-modal without one.
    /// `go` runs when the user goes ahead, with "Don't ask again"'s state.
    static func ask(_ prompt: QuitPrompt, in window: NSWindow?, then go: @escaping @MainActor (_ suppress: Bool) -> Void) {
        let alert = alert(for: prompt)
        guard let window, window.isVisible else {
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn { go(alert.suppressionButton?.state == .on) }
            return
        }
        alert.beginSheetModal(for: window) { response in
            guard response == .alertFirstButtonReturn else { return }
            go(alert.suppressionButton?.state == .on)
        }
    }

    /// "Switch project?" with files still pending review (P1-chrome-03, after `QuitPrompt.projectChange` did not ask): a sheet on
    /// `window` (app-modal without one), Cancel on Esc. §8 / §31.5: the review is saved and comes back on reopen. `go` runs on
    /// Switch. An AppKit sheet like the other project questions — the SwiftUI `.alert` it was crashed the app when SwiftUI
    /// closed its sheet from inside a layout pass.
    static func askSwitchWithPendingReview(files: Int, in window: NSWindow?, then go: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(localized: "Switch project?")
        alert.informativeText = String(localized: "\(files) files pending review. The review is saved and comes back when you reopen this project; the files stay on disk as they are.")
        alert.addButton(withTitle: String(localized: "Switch"))
        alert.addButton(withTitle: String(localized: "Cancel")).keyEquivalent = "\u{1b}"
        guard let window, window.isVisible else {
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn { go() }
            return
        }
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { go() }
        }
    }

    /// Quit (⌘Q, the Dock): the question for every window, app-modal. True = quit; "Don't ask again" turns off
    /// `confirmQuit`.
    static func confirmQuit(_ prompt: QuitPrompt) -> Bool {
        let alert = alert(for: prompt)
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        if alert.suppressionButton?.state == .on { AppSettings.setConfirmQuit(false) }
        return true
    }

    /// Audit daily-11: Review → Reject (⌘⇧R) asks first — what happens to the file in one line. `run` reverts it.
    static func confirmReject(_ file: ChangedFile, window: NSWindow?, run: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = RejectConfirm.title
        alert.informativeText = RejectConfirm.message(for: file)
        alert.addButton(withTitle: RejectConfirm.rejectButton)
        alert.addButton(withTitle: CloseGuardText.cancelButton)
        if let window {
            alert.beginSheetModal(for: window) { response in
                if response == .alertFirstButtonReturn { run() }
            }
        } else if alert.runModal() == .alertFirstButtonReturn {
            run()
        }
    }
}
