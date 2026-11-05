import SwiftUI
import AppKit
import ReviewGateCore

/// Stops every window's engine gracefully on Quit (⌘Q) so `node`/`claude` never outlive the app.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var terminationReplied = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        AttentionCenter.shared.start()
        ChatMoveActions.installRoute()   // wave4b w4b-follow (§39.4)
        AppUpdateController.shared.start()   // MARK: app-update (§48): at launch, then every 6 hours
    }

    // MARK: wave3 mac-session
    /// A folder opened with the app (`open -a ReviewGate <dir>`, Finder, the Dock) or `reviewgate://open?path=<dir>`.
    func application(_ application: NSApplication, open urls: [URL]) {
        FolderHandoffRouter.shared.handle(urls)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // MARK: wave4 w4-safety — daily-12: Claude working (or waiting) in any window asks once, with the count.
        let working = WorkbenchRegistry.shared.allStores.compactMap { $0.closeConfirmationReason() }
        if !WorkSafetyAlerts.confirmQuit(working) {
            AppUpdateController.shared.quitWasCancelled()   // MARK: app-update (§48): an update's restart stops its helper
            return .terminateCancel
        }
        // M19 (spec 5): the window list is written BEFORE any engine is disposed, and frozen afterwards so the
        // windows closing during Quit cannot shrink it.
        WorkbenchRegistry.shared.persistOpenWindowsForTermination()
        let running = WorkbenchRegistry.shared.allStores.filter(\.isEngineRunning)
        guard !running.isEmpty else { return .terminateNow }
        terminationReplied = false
        Task {
            // Every window's engine stops concurrently; `shutdown` is idempotent per store.
            let tasks = running.map { store in Task { await store.shutdown() } }
            for task in tasks { await task.value }
            replyToTermination()
        }
        // Cap: never hang Quit on a stuck sidecar.
        Task { try? await Task.sleep(for: .seconds(6)); replyToTermination() }
        return .terminateLater
    }

    private func replyToTermination() {
        guard !terminationReplied else { return }
        terminationReplied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppUpdateController.shared.appWillTerminate()   // MARK: app-update (§48): an update left waiting detaches its image
    }
}

/// The single "open a project" path shared by the File menu, the toolbar, the empty state and the
/// recent-projects list: every entry point ends in `AppState.openProject(_:)`.
@MainActor
enum ProjectOpener {
    /// Shows the folder picker and opens the chosen directory (no-op on Cancel).
    static func choose(store: AppState) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "Open")
        panel.message = String(localized: "Choose a project folder")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        open(url, store: store)
    }

    static func open(_ url: URL, store: AppState) {
        Task { await store.openProject(url) }
    }

    /// Switch flow (header menu, ⌘⇧O): with files still pending review the caller's alert confirms first,
    /// via `pending`; otherwise the store swaps sessions right away.
    static func requestSwitch(to url: URL, store: AppState, pending: Binding<URL?>) {
        if store.hasPendingReview {
            pending.wrappedValue = url
        } else {
            Task { await store.switchProject(to: url) }
        }
    }

    /// "Switch Project…": the same folder picker as `choose`, routed through the pending-review confirmation.
    static func chooseForSwitch(store: AppState, pending: Binding<URL?>) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "Switch")
        panel.message = String(localized: "Choose a project folder to switch to")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        requestSwitch(to: url, store: store, pending: pending)
    }

    // MARK: Open in New Window (docs/M19-MULTIPROJECT.md)

    /// M19: `url` in a window of its own — or, when one of our windows already has it open, that window
    /// brought to the front (never a duplicate, never the takeover alert).
    static func openInNewWindow(_ url: URL, openWindow: OpenWindowAction) {
        let target = url.standardizedFileURL
        if WorkbenchRegistry.shared.focusWindow(for: target) { return }
        openWindow(id: "workbench", value: target)
    }

    /// "Open in New Window…" (⌘⇧N): the folder picker, then `openInNewWindow`.
    static func chooseForNewWindow(openWindow: OpenWindowAction) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "Open")
        panel.message = String(localized: "Choose a project folder to open in a new window")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        openInNewWindow(url, openWindow: openWindow)
    }

    /// ⌥-click on a project row opens it in a new window instead of switching this one.
    static var optionKeyDown: Bool { NSEvent.modifierFlags.contains(.option) }
}

@main
struct ReviewGateApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @FocusedValue(\.workbenchWindow) private var focusedWindow
    @Environment(\.openWindow) private var openWindow
    @State private var recentProjects: [URL] = AppSettings.recentProjects()
    @State private var registry = WorkbenchRegistry.shared

    init() {
        AppSettings.forgetLegacySystemPromptAppend()   // §54: an earlier built-in append stored by "Reset to default"
    }

    var body: some Scene {
        // One window per workbench (docs/M10-WORKBENCHES.md): the value is the worktree folder the window was
        // opened for (nil for the initial / ⌘N window, which shows the empty state).
        WindowGroup(id: "workbench", for: URL.self) { $url in
            WorkbenchWindow(url: $url)
                .appAppearance()
        }
        .defaultSize(width: 1400, height: 900)
        // Restored windows come back without their value (empty duplicates); workbenches are reopened from the switcher.
        .restorationBehavior(.disabled)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open Project…") { if let focusedWindow { ProjectOpener.choose(store: focusedWindow.store) } }
                    .keyboardShortcut("o", modifiers: .command)
                    .disabled(focusedWindow == nil)
                Button("Switch Project…") {
                    if let focusedWindow {
                        ProjectOpener.chooseForSwitch(store: focusedWindow.store, pending: Bindable(focusedWindow.model).pendingSwitch)
                    }
                }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(focusedWindow == nil)
                // M19: a project of its own, in a window of its own (own engine, own lock). Never disabled —
                // it does not need a focused window to work.
                Button("Open in New Window…") { ProjectOpener.chooseForNewWindow(openWindow: openWindow) }
                    .keyboardShortcut("n", modifiers: [.command, .shift])
                    .accessibilityIdentifier("Open in New Window")
                Menu("Open Recent") {
                    if recentProjects.isEmpty {
                        Text("No recent projects")
                    } else {
                        ForEach(recentProjects, id: \.self) { url in
                            if RecentProjects.isDirectory(url.path) {   // MARK: wave4 w4-install (daily-17): a gone folder never opens
                            // ⌥-click opens the row in a new window instead of this one (M19).
                            Button(url.path) {
                                if ProjectOpener.optionKeyDown {
                                    ProjectOpener.openInNewWindow(url, openWindow: openWindow)
                                } else if let focusedWindow {
                                    ProjectOpener.open(url, store: focusedWindow.store)
                                }
                            }
                            .disabled(focusedWindow == nil && !ProjectOpener.optionKeyDown)
                            } else {
                                MissingRecentMenu(url: url) { recentProjects = RecentProjects.entries().map(\.url) }
                            }
                        }
                        Divider()
                        Menu("Open in New Window") {
                            ForEach(recentProjects.filter { RecentProjects.isDirectory($0.path) }, id: \.self) { url in   // MARK: wave4 w4-install
                                Button(url.path) { ProjectOpener.openInNewWindow(url, openWindow: openWindow) }
                                    .accessibilityIdentifier("Open in New Window \(url.lastPathComponent)")
                            }
                        }
                    }
                }
                .onAppear { recentProjects = RecentProjects.entries().map(\.url) }   // MARK: wave4 w4-install: no scratch / test folders
            }
            // MARK: wave7 w7-state — §45.2: the menus read the window's `menuState` alone (one Equatable value, written only
            // when what they show changed), each menu a `Commands` of its own: a snapshot that leaves them alone re-evaluates
            // none of them, and AppKit does not walk the menu bar's shortcuts again.
            ViewMenuCommands(focused: focusedWindow)
            EditMenuFindCommands(focused: focusedWindow)
            ReviewCommands(focused: focusedWindow)
            WorkbenchCommands(focused: focusedWindow, openWindow: openWindow)
            HelpCommands(focused: focusedWindow)   // wave1 mac-session: 로그 폴더 열기 / 진단 정보 복사 (robustness-03)
            ChatCommands(focused: focusedWindow)   // wave4 w4-input (polish-06): ⌘T 새 채팅, ⌘1…⌘9 채팅 탭
            // MARK: wave4d w4d-windows (polish-08): View › 사이드바 보기/숨기기 (⌃⌘S, Windows' Ctrl+B) and Help › 키보드 단축키.
            SidebarCommands()
            ShortcutHelpCommands(openWindow: openWindow)
            // The builder takes at most ten: the last ones share a Group.
            Group {
                BoardCommands(focused: focusedWindow)   // MARK: wave5 w5-board (§43.1): Window › Agent Board (⌥⌘B)
                UpdateCommands()   // MARK: app-update (§48): ReviewGate › Check for Updates…
            }
        }
        Settings {
            let store = registry.settingsStore
            SettingsView()
                .environment(store)
                .environment(store.pr)
                .appAppearance()
        }
        // MARK: wave4d w4d-windows (polish-08): Help › Keyboard Shortcuts — docs/SHORTCUTS.md's table, one window.
        Window("Keyboard Shortcuts", id: keyboardShortcutsWindowID) {
            ShortcutsView()
                .appAppearance()
        }
        .defaultSize(width: 680, height: 720)
        .restorationBehavior(.disabled)
    }

    /// `REVIEWGATE_SIDECAR` (dev override, e.g. `$SRCROOT/sidecar/dist/sidecar.mjs`) wins over the bundled copy.
    static func resolveSidecarScript() -> String {
        if let override = ProcessInfo.processInfo.environment["REVIEWGATE_SIDECAR"], !override.isEmpty {
            return override
        }
        if let url = Bundle.main.resourceURL?.appendingPathComponent("dist/sidecar.mjs") {
            return url.path
        }
        return "sidecar.mjs"
    }
}

/// Root of one workbench window: owns its `AppState` (own engine process) and registers with `WorkbenchRegistry`.
private struct WorkbenchWindow: View {
    @Binding var url: URL?
    @Environment(\.openWindow) private var openWindow
    @State private var entry = WorkbenchWindowEntry(
        store: AppState(engineScript: ReviewGateApp.resolveSidecarScript()), model: WindowModel())

    var body: some View {
        @Bindable var model = entry.model
        MainWindow(tab: $model.tab, pendingSwitch: $model.pendingSwitch)
            .environment(entry.store)
            .environment(entry.store.pr)
            .environment(entry.model)
            .frame(minWidth: 900, minHeight: 460)   // §49.2: fits a small screen — a window the screen makes smaller than this is clipped
            .background(WindowAttacher(entry: entry))
            .focusedSceneValue(\.workbenchWindow, entry)
            // wave3 mac-session: a folder handed to the app reaches an open window instead of a new empty one (also when
            // SwiftUI rather than AppKit delivers it — the router admits one hand-off once).
            .onOpenURL { handed in FolderHandoffRouter.shared.handle([handed]) }
            .handlesExternalEvents(preferring: ["*"], allowing: ["*"])
            .task {
                entry.store.fileLog = EngineLogFile.shared   // wave1 mac-session: ~/Library/Logs/ReviewGate (robustness-03)
                WorkbenchRegistry.shared.register(entry)
                AttentionCenter.shared.attach(entry)
                entry.store.confirmSideSwitch = SideSwitchAlert.confirm   // wave4b w4b-side (§40.3)
                // wave3 mac-session: hand-offs wait while this window opens its first project.
                let handoff = FolderHandoffRouter.shared
                handoff.openWindow = openWindow
                handoff.beganOpening()
                defer { handoff.finishedOpening() }
                if let url {
                    // M19: the window comes back where this project was last seen.
                    entry.applySavedFrame(root: AppSettings.projectKey(url))
                    await entry.store.openProject(url)
                } else if let handed = handoff.takeFolderForNewWindow() {
                    // wave3 mac-session: a folder handed over at launch (or waiting for a window) wins over the launch restore.
                    WorkbenchRegistry.shared.restoreAttempted = true
                    entry.applySavedFrame(root: AppSettings.projectKey(handed))
                    await entry.store.openProject(handed)
                } else if await openProjectFromEnvironment() {
                    // `REVIEWGATE_PROJECT` wins: no launch restore (docs/M19-MULTIPROJECT.md).
                } else {
                    await restoreOpenWindows()
                }
            }
            .onChange(of: entry.store.projectURL) { _, new in
                // Keep the window's value in sync so `openWindow(value:)` for this folder focuses this window.
                url = new?.standardizedFileURL
                // M19: a window that opened / changed / closed its project rewrites the restore list.
                if let new { entry.applySavedFrame(root: AppSettings.projectKey(new)) } else { entry.frameRoot = nil }
                WorkbenchRegistry.shared.persistOpenWindows()
                BoardWindows.shared.projectChanged(entry)   // MARK: wave5 w5-board (§43.1): the board follows / comes back
            }
            .onDisappear {
                BoardWindows.shared.ownerClosed(entry)   // MARK: wave5 w5-board (§43.1)
                entry.rememberFrame()
                WorkbenchRegistry.shared.unregister(entry)
                WorkbenchRegistry.shared.persistOpenWindows()
                let store = entry.store
                Task { await store.shutdown() }
            }
    }

    /// `REVIEWGATE_PROJECT=<dir>` opens that project in the first window so the app can be driven headlessly.
    /// Returns true when it claimed this window (so the launch restore stands down).
    private func openProjectFromEnvironment() async -> Bool {
        let registry = WorkbenchRegistry.shared
        guard !registry.environmentProjectConsumed else { return false }
        registry.environmentProjectConsumed = true
        guard let path = ProcessInfo.processInfo.environment["REVIEWGATE_PROJECT"], !path.isEmpty else { return false }
        guard Self.isDirectory(path) else { return false }
        registry.restoreAttempted = true
        entry.applySavedFrame(root: AppSettings.projectKey(URL(fileURLWithPath: path)))
        #if DEBUG
        ScreenshotTour.startIfRequested(entry)   // REVIEWGATE_SCREENSHOT_TOUR (App/Debug/ScreenshotTour.swift)
        #endif
        await entry.store.openProject(URL(fileURLWithPath: path))
        return true
    }

    /// M19 (spec 2): reopens the windows of the last session — this window takes the first entry, the rest get
    /// their own. Paths that no longer exist are skipped and pruned; at most `maxRestoredWindows` come back.
    private func restoreOpenWindows() async {
        let registry = WorkbenchRegistry.shared
        guard !registry.restoreAttempted else { return }
        registry.restoreAttempted = true
        guard AppSettings.reopenLastProjects() else { return }
        let saved = AppSettings.openWindows()
        guard !saved.isEmpty else { return }
        let alive = saved.filter { Self.isDirectory($0.path) }
        if alive.count != saved.count { AppSettings.setOpenWindows(alive) }
        let restore = Array(alive.prefix(AppSettings.maxRestoredWindows))
        guard let first = restore.first else { return }

        entry.applySavedFrame(root: first.path, preferred: first.frame)
        await entry.store.openProject(URL(fileURLWithPath: first.path))

        for item in restore.dropFirst() {
            let target = URL(fileURLWithPath: item.path).standardizedFileURL
            guard registry.entry(for: target) == nil else { continue }
            openWindow(id: "workbench", value: target)
            // Sequentially: two windows must never race for one worktree lock.
            await Self.waitForProject(at: target)
        }
        entry.focus()
    }

    /// Waits for the window just opened to have `url` open, giving up after 1.5 s.
    private static func waitForProject(at url: URL) async {
        let deadline = ContinuousClock.now + .milliseconds(1500)
        while ContinuousClock.now < deadline {
            if WorkbenchRegistry.shared.entry(for: url) != nil { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private static func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }
}
