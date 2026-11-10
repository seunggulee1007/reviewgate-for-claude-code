import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave5 w5-board
// docs/PROTOCOL.md §43.1 — the agent board's window: one per project window (Window › Agent Board, ⌥⌘B, or the agent
// panel's board button), showing that window's project. It comes back where it was (its frame is saved per project) on
// the tab it was on, and when it was open as the app quit (or its project window closed) it opens again with the project.
// Closing it yourself forgets that. The board reads the project's state; it never acts on its own.

@MainActor
final class BoardWindows: NSObject, NSWindowDelegate {
    static let shared = BoardWindows()

    private struct Board {
        weak var entry: WorkbenchWindowEntry?
        let window: NSWindow
        var project: String?
    }

    /// By the project window (`WorkbenchWindowEntry`).
    private var boards: [ObjectIdentifier: Board] = [:]
    /// Boards being closed because their project window went (the board was not closed by the user).
    private var closingQuietly: Set<ObjectIdentifier> = []

    /// Window › Agent Board (⌥⌘B): the key board closes; otherwise the focused project window's board opens (or comes
    /// forward, or closes when it already is in front).
    func toggle(focused: WorkbenchWindowEntry?) {
        if let key = NSApp.keyWindow, let id = boards.first(where: { $0.value.window === key })?.key, let entry = boards[id]?.entry {
            close(entry)
            return
        }
        guard let focused, focused.store.projectInfo != nil else { return }
        show(focused, activate: true)
    }

    /// Whether the key window is a board (its menu item closes it then).
    var isBoardKey: Bool {
        guard let key = NSApp.keyWindow else { return false }
        return boards.values.contains { $0.window === key }
    }

    func show(_ entry: WorkbenchWindowEntry, activate: Bool) {
        let id = ObjectIdentifier(entry)
        let project = entry.store.projectURL.map(AppSettings.projectKey)
        let window: NSWindow
        if let board = boards[id] {
            window = board.window
        } else {
            window = makeWindow(for: entry, project: project)
            boards[id] = Board(entry: entry, window: window, project: project)
        }
        retitle(window, entry: entry)
        if let project { BoardPrefs.setOpen(true, project: project) }
        if activate {
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else if let owner = entry.window {
            window.order(.below, relativeTo: owner.windowNumber)
        } else {
            window.orderFront(nil)
        }
    }

    /// Closed by the user (the menu item, ⌘W, the close button): it stays closed for this project.
    func close(_ entry: WorkbenchWindowEntry) {
        boards[ObjectIdentifier(entry)]?.window.performClose(nil)
    }

    /// The project window opened or changed its project: the board follows (title, frame name), opens when it was open the
    /// last time this project was, and closes with no project.
    func projectChanged(_ entry: WorkbenchWindowEntry) {
        let id = ObjectIdentifier(entry)
        guard let project = entry.store.projectURL.map(AppSettings.projectKey) else {
            if boards[id] != nil { closeQuietly(id) }
            return
        }
        if var board = boards[id] {
            if board.project != project {
                board.project = project
                boards[id] = board
                board.window.setFrameAutosaveName(BoardPrefs.frameName(project: project))
                BoardPrefs.setOpen(true, project: project)
            }
            retitle(board.window, entry: entry)
        } else if BoardPrefs.wasOpen(project: project) {
            show(entry, activate: false)
        }
    }

    /// The project window closed: its board goes with it but is remembered as open.
    func ownerClosed(_ entry: WorkbenchWindowEntry) {
        let id = ObjectIdentifier(entry)
        if boards[id] != nil { closeQuietly(id) }
    }

    /// A click on the board showed something in the chat (a group, a permission card, the details sheet): the project
    /// window comes forward — only when the board is the key window (the project window does it by itself otherwise).
    func bringOwnerForward(of model: WindowModel) {
        guard let key = NSApp.keyWindow, let board = boards.values.first(where: { $0.window === key }),
              let entry = board.entry, entry.model === model else { return }
        entry.focus()
    }

    private func closeQuietly(_ id: ObjectIdentifier) {
        guard let board = boards[id] else { return }
        closingQuietly.insert(id)
        board.window.close()
    }

    private func makeWindow(for entry: WorkbenchWindowEntry, project: String?) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenAuxiliary)
        window.contentMinSize = NSSize(width: 420, height: 420)
        let hosting = NSHostingController(rootView: BoardRoot(entry: entry))
        hosting.sizingOptions = []
        window.contentViewController = hosting
        window.setContentSize(NSSize(width: 600, height: 760))
        window.identifier = NSUserInterfaceItemIdentifier("ReviewGate.AgentBoard")
        window.setAccessibilityIdentifier("Agent board window")
        let name = project.map(BoardPrefs.frameName(project:))
        if let name, window.setFrameUsingName(name) {
            window.setFrame(WorkbenchRegistry.clamp(window.frame, to: window), display: false)
        } else if let owner = entry.window {
            // First time: beside the project window, on its right when there is room.
            let o = owner.frame
            var frame = window.frame
            frame.origin = NSPoint(x: o.maxX + 12, y: o.maxY - frame.height)
            window.setFrame(WorkbenchRegistry.clamp(frame, to: owner), display: false)
        } else {
            window.center()
        }
        if let name { window.setFrameAutosaveName(name) }
        window.delegate = self
        return window
    }

    private func retitle(_ window: NSWindow, entry: WorkbenchWindowEntry) {
        let board = String(localized: "Agent Board")
        window.title = entry.store.projectInfo.map { "\(board) — \($0.name)" } ?? board
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow,
              let (id, board) = boards.first(where: { $0.value.window === window }).map({ ($0.key, $0.value) }) else { return }
        boards[id] = nil
        let quiet = closingQuietly.remove(id) != nil || WorkbenchRegistry.shared.isTerminating
        if !quiet, let project = board.project { BoardPrefs.setOpen(false, project: project) }
        window.delegate = nil
    }
}

/// The board's root: the project window's store and view model, its appearance, and its menu-bar context.
private struct BoardRoot: View {
    let entry: WorkbenchWindowEntry

    var body: some View {
        BoardView()
            .environment(entry.store)
            .environment(entry.store.pr)
            .environment(entry.model)
            .focusedSceneValue(\.workbenchWindow, entry)
            .appAppearance()
    }
}

/// Window › Agent Board (⌥⌘B).
struct BoardCommands: Commands {
    let focused: WorkbenchWindowEntry?

    var body: some Commands {
        CommandGroup(after: .windowArrangement) {
            Divider()
            Button("Agent Board") { BoardWindows.shared.toggle(focused: focused) }
                .keyboardShortcut("b", modifiers: [.command, .option])
                .disabled(focused?.store.projectInfo == nil && !BoardWindows.shared.isBoardKey)
                .accessibilityIdentifier("Window menu Agent board")
        }
    }
}

/// The agent panel's way to the board (its header).
struct AgentBoardButton: View {
    @Environment(AppState.self) private var store

    var body: some View {
        Button {
            if let entry = WorkbenchRegistry.shared.entry(for: store) { BoardWindows.shared.show(entry, activate: true) }
        } label: {
            Image(systemName: "rectangle.3.group")
        }
        .buttonStyle(IconButtonStyle(padding: 2))
        .help("Open the agent board (⌥⌘B)")
        .accessibilityLabel(Text("Agent Board"))
        .accessibilityIdentifier("Open agent board")
    }
}
