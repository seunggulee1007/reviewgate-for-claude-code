import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave3 mac-session
// Handing a folder to the running app (docs/PROTOCOL.md §36.9, client-only; the parsing is `FolderHandoff` in Core): `open -a
// ReviewGate <dir>`, Finder's "Open With" / a drop on the Dock icon, and `reviewgate://open?path=<dir>` (App/Info.plist
// declares the folder type and the scheme). The window that has the folder open comes to the front; otherwise the key window
// takes it when it is empty, or a new window opens. At launch the first window takes it instead of restoring the last
// session. A link to a folder never opened here asks first.

@MainActor
final class FolderHandoffRouter {
    static let shared = FolderHandoffRouter()

    /// Given by the first window (the action is app-wide): opens a workbench window for a folder.
    var openWindow: OpenWindowAction?
    private var queue: [FolderHandoff.Request] = []
    /// AppKit's `application(_:open:)` and SwiftUI's `onOpenURL` may both deliver one hand-off.
    private var gate = FolderHandoffGate()
    /// Windows opening their first project (the launch restore, a window opened for a folder, an empty window reused here):
    /// hand-offs wait meanwhile, so two opens never race in one window.
    private var opening = 0
    /// A window was just asked for; the next hand-off waits for it to start opening (at most 2 s).
    private var awaitingWindow = false
    /// The confirmation runs a modal loop: a hand-off arriving meanwhile only joins the queue.
    private var draining = false

    /// Every URL the app is asked to open.
    func handle(_ urls: [URL]) {
        let requests = FolderHandoff.requests(for: urls, isDirectory: FolderHandoff.isDirectory).filter { gate.admit($0.folder) }
        guard !requests.isEmpty else { return }
        queue += requests
        drain()
    }

    func beganOpening() {
        opening += 1
        awaitingWindow = false
    }

    func finishedOpening() {
        opening = max(0, opening - 1)
        drain()
    }

    /// A window without a folder of its own (the launch window, ⌘N) takes the first folder handed over — at launch instead of
    /// restoring the last session. A link to an unknown folder asks first.
    func takeFolderForNewWindow() -> URL? {
        while !queue.isEmpty {
            let request = queue.removeFirst()
            if WorkbenchRegistry.shared.focusWindow(for: request.folder) { continue }
            if confirmIfNeeded(request) { return request.folder }
        }
        return nil
    }

    private func drain() {
        guard !draining else { return }
        draining = true
        defer { draining = false }
        while opening == 0, !awaitingWindow, !queue.isEmpty {
            let request = queue.removeFirst()
            guard route(request) else {   // no window yet: the first one takes it
                queue.insert(request, at: 0)
                return
            }
        }
    }

    /// False when there is no window to open it in yet.
    private func route(_ request: FolderHandoff.Request) -> Bool {
        let registry = WorkbenchRegistry.shared
        if registry.focusWindow(for: request.folder) { return true }
        let empty = registry.focused.flatMap { entry in
            entry.window != nil && entry.store.projectURL == nil && entry.store.lockConflict == nil && !entry.store.needsGitInit ? entry : nil
        }
        guard empty != nil || openWindow != nil else { return false }
        guard confirmIfNeeded(request) else { return true }
        if let entry = empty {
            entry.focus()
            beganOpening()
            Task {
                entry.applySavedFrame(root: AppSettings.projectKey(request.folder))
                await entry.store.openProject(request.folder)
                finishedOpening()
            }
        } else if let openWindow {
            awaitingWindow = true
            openWindow(id: "workbench", value: request.folder)
            NSApp.activate(ignoringOtherApps: true)
            Task {
                try? await Task.sleep(for: .seconds(2))
                if awaitingWindow {
                    awaitingWindow = false
                    drain()
                }
            }
        }
        return true
    }

    /// A link to a folder that is neither open nor recent: "Open this folder in ReviewGate?" (Claude Code starts there with
    /// that folder's own project settings and hooks).
    private func confirmIfNeeded(_ request: FolderHandoff.Request) -> Bool {
        let known = AppSettings.recentProjects() + WorkbenchRegistry.shared.stores.compactMap(\.projectURL)
        guard FolderHandoff.needsConfirmation(request, known: known) else { return true }
        let alert = NSAlert()
        alert.messageText = String(localized: "Open this folder in ReviewGate?")
        alert.informativeText = String(localized: "A link asked ReviewGate to open \(SessionNotices.abbreviatingHome(request.folder.path)). Claude Code starts there with that folder's own project settings and hooks — open it only if you trust it.")
        alert.addButton(withTitle: String(localized: "Open"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }
}
