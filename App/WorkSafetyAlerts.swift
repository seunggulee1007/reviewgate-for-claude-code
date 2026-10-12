import AppKit
import ReviewGateCore

// MARK: wave4 w4-safety

/// Audit daily-12: a window's close (⌘W, the close button) asks first while Claude works or waits for the user
/// (`AppState.closeConfirmationReason`). SwiftUI owns the window's delegate, so this one sits in front of it: it answers
/// `windowShouldClose(_:)` and hands every other delegate message to SwiftUI's delegate untouched.
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
        guard let store = entry?.store, let reason = store.closeConfirmationReason() else { return proceed() }
        guard !asking else { return false }
        asking = true
        let alert = WorkSafetyAlerts.stopAlert(message: CloseGuardText.message(reason), confirm: CloseGuardText.closeButton)
        alert.beginSheetModal(for: sender) { [weak self] response in
            guard let self else { return }
            self.asking = false
            guard response == .alertFirstButtonReturn else { return }
            if alert.suppressionButton?.state == .on { AppSettings.setConfirmCloseWhileWorking(false) }
            self.confirmed = true
            sender.performClose(nil)
        }
        return false
    }
}

@MainActor
enum WorkSafetyAlerts {
    /// "Claude is working" with [Close / Quit] [Cancel] and "Don't ask again".
    static func stopAlert(message: String, confirm: String) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = CloseGuardText.title
        alert.informativeText = message
        alert.addButton(withTitle: confirm)
        alert.addButton(withTitle: CloseGuardText.cancelButton)
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = CloseGuardText.dontAskAgain
        return alert
    }

    /// Quit (⌘Q): one question for every window that would stop (their count when more than one). True = quit.
    static func confirmQuit(_ reasons: [CloseGuardReason]) -> Bool {
        guard !reasons.isEmpty else { return true }
        let alert = stopAlert(message: CloseGuardText.quitMessage(reasons), confirm: CloseGuardText.quitButton)
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        if alert.suppressionButton?.state == .on { AppSettings.setConfirmCloseWhileWorking(false) }
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
