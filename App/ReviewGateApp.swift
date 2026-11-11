import SwiftUI
import AppKit
import ReviewGateCore

/// Stops every window's engine gracefully on Quit (⌘Q) so `node`/`claude` never outlive the app.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var terminationReplied = false

    // MARK: polish p-foundation (P1-chrome-17, P3-transcript-06)
    func applicationWillFinishLaunching(_ notification: Notification) {
        // Tooltips show after 0.4 s instead of macOS's 1 s and more, so one shows before the pointer moves on. In this app's
        // registration domain only: the user's own setting (`defaults write … NSInitialToolTipDelay`) still wins, and
        // nothing global or another app's changes.
        UserDefaults.standard.register(defaults: [Self.toolTipDelayKey: Self.toolTipDelayMs])
        AppQuit.restoresOnce = AppSettings.takeRestoreOnceAfterRelaunch()   // MARK: polish p-lifecycle (P5-sheets-48)
        #if DEBUG
        ScreenshotTour.quietIfRequested()   // the layout check runs without showing or taking the focus (scripts/screenshots.sh)
        #endif
    }

    static let toolTipDelayKey = "NSInitialToolTipDelay"
    static let toolTipDelayMs = 400

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
        // MARK: polish p-lifecycle — P1-chrome-01 / PX-14: ⌘Q and the Dock's Quit ask, with what each window would stop,
        // lose and keep (Core `QuitPrompt`; asked while "Ask before quitting" is on, or while work would stop and "Ask
        // before closing while Claude works" is). The last window's close asked already; an update's restart and the move to
        // Applications are the app's own; a logout, restart or shut down never waits on a question.
        if !AppQuit.withoutAsking, !SystemQuit.isSystemQuit(Self.currentQuitReason()),
           let prompt = WorkbenchRegistry.shared.quitPrompt(kind: .quit), !WorkSafetyAlerts.confirmQuit(prompt) {
            AppUpdateController.shared.quitWasCancelled()   // MARK: app-update (§48): an update's restart stops its helper
            return .terminateCancel
        }
        AppQuit.isQuitting = true
        // M19 (spec 5): the window list is written BEFORE any engine is disposed, and frozen afterwards so the
        // windows closing during Quit cannot shrink it.
        WorkbenchRegistry.shared.persistOpenWindowsForTermination()
        let running = WorkbenchRegistry.shared.allStores.filter(\.isEngineRunning)
        guard !running.isEmpty else { return .terminateNow }
        // P1-chrome-05: the windows go at once — the engines stop behind them (at most 6 s), so Quit never looks stuck.
        for window in NSApp.windows where window.isVisible { window.orderOut(nil) }
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

    /// polish P1-chrome-01: the last window's close quits (it asked first) — its engine stops with it, and an app with no
    /// window and no session has nothing to keep running for.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// PX-14: why the system asks the app to quit — the `kAEQuitReason` of the Quit Apple event (a logout, restart or shut
    /// down); nil for ⌘Q, the Dock and `NSApp.terminate`.
    private static func currentQuitReason() -> UInt32? {
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              let reason = event.attributeDescriptor(forKeyword: AEKeyword(SystemQuit.quitReasonKeyword)) else { return nil }
        return reason.enumCodeValue
    }

    private func replyToTermination() {
        guard !terminationReplied else { return }
        terminationReplied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    // MARK: polish p-lifecycle — P1-chrome-11: the Dock icon's right click — a new window, open a project, or one in a window
    // of its own (the recent projects are listed above them by macOS, NSDocumentController).
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        for (title, action) in [(String(localized: "New Window"), #selector(dockNewWindow)),
                                (String(localized: "Open Project…"), #selector(dockOpenProject)),
                                (String(localized: "Open in New Window…"), #selector(dockOpenInNewWindow))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        return menu
    }

    @objc private func dockNewWindow() {
        FolderHandoffRouter.shared.openWindow?(id: "workbench", value: ProjectOpener.newEmptyWindowValue())
        NSApp.activate(ignoringOtherApps: true)
    }

    /// As ⌘O: the window in front (its project switched, asked first — P1-chrome-03), else a new one.
    @objc private func dockOpenProject() {
        NSApp.activate(ignoringOtherApps: true)
        if let entry = WorkbenchRegistry.shared.focused {
            entry.focus()
            ProjectOpener.choose(store: entry.store)
        } else {
            dockOpenInNewWindow()
        }
    }

    @objc private func dockOpenInNewWindow() {
        NSApp.activate(ignoringOtherApps: true)
        guard let openWindow = FolderHandoffRouter.shared.openWindow else { return }
        ProjectOpener.chooseForNewWindow(openWindow: openWindow)
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
        guard let url = pick(panel) else { return }
        open(url, store: store)
    }

    /// Opens `url` in this window. MARK: polish p-lifecycle (P1-chrome-03): with a project open here it is a switch — ⌘O, the
    /// toolbar's folder, File › Open Recent, the recent list and a git candidate all ask what `requestSwitch` asks.
    static func open(_ url: URL, store: AppState) {
        if openElsewhereIfWindowGone(url, store: store) { return }
        if store.projectURL != nil {
            requestSwitch(to: url, store: store)
            return
        }
        Task { await store.openProject(url) }
    }

    /// Switch flow (header menu, ⌘⇧O, and `open` with a project open). The project already open here, or in another window,
    /// brings that window to the front, which says so (`sayAlreadyOpen`) — one in another window is not switched to (that
    /// would stop this session for a lock it cannot take). polish P1-chrome-03: a switch stops the session, so a turn
    /// running, a card waiting or work that would stop or be lost asks first (Core `QuitPrompt.projectChange`, "프로젝트를
    /// 바꾸면 이 턴이 멈춰요."); otherwise files still pending review ask "Switch project?"; otherwise the store swaps sessions
    /// right away. Both questions are AppKit sheets (`WorkSafetyAlerts`): the pending-review one was a SwiftUI `.alert`, whose
    /// sheet SwiftUI closed from inside a layout pass — its close animation's nested run loop crashed the app (UpdateCycle).
    static func requestSwitch(to url: URL, store: AppState) {
        if openElsewhereIfWindowGone(url, store: store) { return }
        let registry = WorkbenchRegistry.shared
        let target = AppSettings.projectKey(url)
        if store.projectURL.map(AppSettings.projectKey) == target {
            registry.entry(for: store)?.focus()
            sayAlreadyOpen(url)
            return
        }
        if let other = registry.entry(for: url), other.store !== store, other.focus() {
            sayAlreadyOpen(url)
            return
        }
        if let entry = registry.entry(for: store),
           let prompt = QuitPrompt.projectChange(entry.quitState, .switchProject,
                                                 confirmWhileWorking: AppSettings.confirmCloseWhileWorking()) {
            WorkSafetyAlerts.ask(prompt, in: entry.window) { suppress in
                if suppress { AppSettings.setConfirmCloseWhileWorking(false) }
                Task { await store.switchProject(to: url) }
            }
            return
        }
        if store.hasPendingReview {
            WorkSafetyAlerts.askSwitchWithPendingReview(files: store.pendingFiles.count, in: registry.entry(for: store)?.window) {
                Task { await store.switchProject(to: url) }
            }
        } else {
            Task { await store.switchProject(to: url) }
        }
    }

    // MARK: polish p-foundation / p-lifecycle (P1-chrome-03)
    /// "Close Project": every caller goes through here. Closing stops the session, so a turn running, a card waiting or work
    /// that would stop or be lost asks first ("프로젝트를 닫으면 이 턴이 멈춰요." [프로젝트 닫기] [취소]); the review itself is
    /// saved and comes back.
    static func requestClose(store: AppState) {
        if let entry = WorkbenchRegistry.shared.entry(for: store),
           let prompt = QuitPrompt.projectChange(entry.quitState, .closeProject,
                                                 confirmWhileWorking: AppSettings.confirmCloseWhileWorking()) {
            WorkSafetyAlerts.ask(prompt, in: entry.window) { suppress in
                if suppress { AppSettings.setConfirmCloseWhileWorking(false) }
                Task { await store.closeProject() }
            }
            return
        }
        Task { await store.closeProject() }
    }

    /// "Switch Project…": the same folder picker as `choose`, routed through the pending-review confirmation.
    static func chooseForSwitch(store: AppState) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "Switch")
        panel.message = String(localized: "Choose a project folder to switch to")
        guard let url = pick(panel) else { return }
        requestSwitch(to: url, store: store)
    }

    // MARK: Open in New Window (docs/M19-MULTIPROJECT.md)

    /// M19: `url` in a window of its own — or, when one of our windows already has it open, that window
    /// brought to the front (never a duplicate, never the takeover alert).
    static func openInNewWindow(_ url: URL, openWindow: OpenWindowAction) {
        let target = url.standardizedFileURL
        if WorkbenchRegistry.shared.focusWindow(for: target) {
            sayAlreadyOpen(target)
            return
        }
        openWindow(id: "workbench", value: newWindowValue(target))
    }

    /// The value a new window is opened with: `url` with a fragment of its own. SwiftUI brings forward the window it thinks
    /// shows a value — a window closed earlier (AppKit keeps it, hidden) still matched the folders it had shown, so no window
    /// came. The window reads the folder without the fragment (`folderOfWindowValue`); its own folder is kept in sync after.
    static func newWindowValue(_ url: URL) -> URL {
        var parts = URLComponents(url: url.standardizedFileURL, resolvingAgainstBaseURL: false)
        parts?.fragment = UUID().uuidString
        return parts?.url ?? url
    }

    /// The folder a window was opened for; nil for an empty window (`newEmptyWindowValue`).
    static func folderOfWindowValue(_ value: URL) -> URL? { value.isFileURL ? URL(fileURLWithPath: value.path).standardizedFileURL : nil }

    /// An empty window's value (New Window, the Dock's): one of its own. With no value SwiftUI brought forward the window
    /// that had been opened without one — the launch window, whatever it showed since — and no new window came.
    static func newEmptyWindowValue() -> URL { URL(string: "reviewgate-empty:\(UUID().uuidString)")! }

    /// A store whose window is gone (a menu that still names a closed window) would open the project where no one sees it,
    /// on an engine already stopped: `url` opens in a window of its own instead. False when the store's window is there.
    private static func openElsewhereIfWindowGone(_ url: URL, store: AppState) -> Bool {
        guard WorkbenchRegistry.shared.entry(for: store) == nil, let openWindow = FolderHandoffRouter.shared.openWindow else { return false }
        openInNewWindow(url, openWindow: openWindow)
        return true
    }

    /// An open that finds the project already open ends with its window in front saying so — the window may be the one in
    /// front already, where coming forward shows nothing (0.5.12 did nothing at all for the project open in this window).
    private static func sayAlreadyOpen(_ url: URL) {
        Toast.show(String(localized: "\(url.lastPathComponent) is already open in this window"), systemImage: "info.circle.fill")
    }

    /// "Open in New Window…" (⌘⇧N): the folder picker, then `openInNewWindow`.
    static func chooseForNewWindow(openWindow: OpenWindowAction) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "Open")
        panel.message = String(localized: "Choose a project folder to open in a new window")
        guard let url = pick(panel) else { return }
        openInNewWindow(url, openWindow: openWindow)
    }

    /// The folder picked in `panel`; nil on Cancel. DEBUG: `debugPick` (the open check, App/Debug/ScreenshotTour.swift)
    /// stands in for the user once, and no panel shows.
    private static func pick(_ panel: NSOpenPanel) -> URL? {
        #if DEBUG
        if let url = debugPick { debugPick = nil; return url }
        #endif
        return panel.runModal() == .OK ? panel.url : nil
    }
    #if DEBUG
    static var debugPick: URL?
    #endif

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
            // MARK: polish p-lifecycle (P1-chrome-06 / P1-chrome-07 / PX-16): File — a Commands of its own (§45.2).
            FileCommands(focused: focusedWindow, openWindow: openWindow, recentProjects: $recentProjects)
            // MARK: wave7 w7-state — §45.2: the menus read the window's `menuState` alone (one Equatable value, written only
            // when what they show changed), each menu a `Commands` of its own: a snapshot that leaves them alone re-evaluates
            // none of them, and AppKit does not walk the menu bar's shortcuts again.
            ViewMenuCommands(focused: focusedWindow)
            EditMenuFindCommands(focused: focusedWindow)
            ReviewCommands(focused: focusedWindow)
            WorkbenchCommands(focused: focusedWindow, openWindow: openWindow)
            // wave1 mac-session: 로그 폴더 열기 / 진단 정보 복사 (robustness-03); polish p-lifecycle (P1-chrome-08): the whole Help menu,
            // Keyboard Shortcuts (wave4d w4d-windows, polish-08) included.
            HelpCommands(focused: focusedWindow, openWindow: openWindow)
            ChatCommands(focused: focusedWindow)   // wave4 w4-input (polish-06): ⌘T 새 채팅, ⌘1…⌘9 채팅 탭
            // MARK: wave4d w4d-windows (polish-08): View › 사이드바 보기/숨기기 (⌃⌘S, Windows' Ctrl+B).
            SidebarCommands()
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

// MARK: polish p-lifecycle — P1-chrome-06 / P1-chrome-07 / PX-16
/// File: New Window (⌘N — an empty window of its own, which SwiftUI's own item was until `replacing: .newItem` took it),
/// Open Project… / Switch Project… (with no workbench window in front — none open, or Settings in front — they open a new
/// window), Open in New Window…, Open Recent by folder name with Clear Menu, and Close Project (it asks first —
/// P1-chrome-03). docs/PROTOCOL.md §55.8.
struct FileCommands: Commands {
    let focused: WorkbenchWindowEntry?
    let openWindow: OpenWindowAction
    @Binding var recentProjects: [URL]

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Window") { openWindow(id: "workbench", value: ProjectOpener.newEmptyWindowValue()) }
                .keyboardShortcut("n", modifiers: .command)
                .accessibilityIdentifier("New Window")
            Button("Open Project…") {
                if let focused { ProjectOpener.choose(store: focused.store) } else { ProjectOpener.chooseForNewWindow(openWindow: openWindow) }
            }
            .keyboardShortcut("o", modifiers: .command)
            Button("Switch Project…") {
                if let focused {
                    ProjectOpener.chooseForSwitch(store: focused.store)
                } else {
                    ProjectOpener.chooseForNewWindow(openWindow: openWindow)
                }
            }
            .keyboardShortcut("o", modifiers: [.command, .shift])
            // M19: a project of its own, in a window of its own (own engine, own lock). Never disabled —
            // it does not need a focused window to work.
            Button("Open in New Window…") { ProjectOpener.chooseForNewWindow(openWindow: openWindow) }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .accessibilityIdentifier("Open in New Window")
            Menu("Open Recent") { recentItems }
                .onAppear { recentProjects = RecentProjects.entries().map(\.url) }   // MARK: wave4 w4-install: no scratch / test folders
            Divider()
            Button("Close Project") { if let focused { ProjectOpener.requestClose(store: focused.store) } }
                .disabled(focused?.store.menuState.hasProject != true)
                .accessibilityIdentifier("File menu Close Project")
        }
    }

    /// A row per recent project by its folder's name (its parent too when two share it — Core `RecentMenu`), ⌥-click or no
    /// workbench window in front: a window of its own (M19); a folder that is gone: why, and Remove.
    @ViewBuilder private var recentItems: some View {
        if recentProjects.isEmpty {
            Text("No recent projects")
        } else {
            let alive = recentProjects.filter { RecentProjects.isDirectory($0.path) }   // MARK: wave4 w4-install (daily-17)
            let titles = Dictionary(zip(alive, RecentMenu.titles(alive)), uniquingKeysWith: { first, _ in first })
            ForEach(recentProjects, id: \.self) { url in
                if let title = titles[url] {
                    Button {
                        if ProjectOpener.optionKeyDown || focused == nil {
                            ProjectOpener.openInNewWindow(url, openWindow: openWindow)
                        } else if let focused {
                            ProjectOpener.open(url, store: focused.store)
                        }
                    } label: {
                        Label(title, systemImage: "folder")
                    }
                    .help(url.path)
                } else {
                    MissingRecentMenu(url: url) { recentProjects = RecentProjects.entries().map(\.url) }
                }
            }
            Divider()
            Menu("Open in New Window") {
                ForEach(alive, id: \.self) { url in
                    Button { ProjectOpener.openInNewWindow(url, openWindow: openWindow) } label: {
                        Label(titles[url] ?? url.lastPathComponent, systemImage: "macwindow.badge.plus")
                    }
                    .help(url.path)
                    .accessibilityIdentifier("Open in New Window \(url.lastPathComponent)")
                }
            }
            Divider()
            // The Mac's Clear Menu: the list here, the empty window's and the Dock's (NSDocumentController) are emptied.
            Button("Clear Menu") {
                AppSettings.clearRecentProjects()
                NSDocumentController.shared.clearRecentDocuments(nil)
                recentProjects = []
            }
            .accessibilityIdentifier("Clear recent projects")
        }
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
        MainWindow(tab: $model.tab)
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
                #if DEBUG
                if let tourLog = ScreenshotTour.logFile { entry.store.fileLog = tourLog }   // a tour's windows: its own folder
                #endif
                WorkbenchRegistry.shared.register(entry)
                AttentionCenter.shared.attach(entry)
                entry.store.confirmSideSwitch = SideSwitchAlert.confirm   // wave4b w4b-side (§40.3)
                // wave3 mac-session: hand-offs wait while this window opens its first project.
                let handoff = FolderHandoffRouter.shared
                handoff.openWindow = openWindow
                handoff.beganOpening()
                defer { handoff.finishedOpening() }
                if let url = url.flatMap(ProjectOpener.folderOfWindowValue) {
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
                // MARK: polish p-lifecycle (P1-chrome-07): the Dock's right click lists it among the recent projects too.
                if let new, !RecentProjects.isTransient(new.path) { NSDocumentController.shared.noteNewRecentDocumentURL(new) }
                WorkbenchRegistry.shared.persistOpenWindows()
                BoardWindows.shared.projectChanged(entry)   // MARK: wave5 w5-board (§43.1): the board follows / comes back
            }
            // MARK: polish p-lifecycle (P4-composer-07): the queue is kept per project as it changes, and comes back paused
            // when its project opens here again (Core `queueKeepChanged`).
            .onChange(of: entry.store.queueKeep) { old, new in entry.store.queueKeepChanged(from: old, to: new) }
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
        // polish P5-sheets-48: after an update's restart or the move to Applications too, whatever the setting says.
        guard AppSettings.reopenLastProjects() || AppQuit.restoresOnce else { return }
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
            openWindow(id: "workbench", value: ProjectOpener.newWindowValue(target))
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
