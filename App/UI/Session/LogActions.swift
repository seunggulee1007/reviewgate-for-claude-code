import SwiftUI
import AppKit
import ReviewGateCore

/// Audit robustness-03 / crash-6: the log folder (`~/Library/Logs/ReviewGate`) in Finder and the diagnostics on the
/// clipboard — from the error banner and the Help menu.
@MainActor
enum LogActions {
    static var folderHelp: String {
        String(localized: "Shows today's log in Finder (~/Library/Logs/ReviewGate, kept 7 days)")
    }

    /// "ReviewGate 0.2.0 (160)".
    static var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "ReviewGate \(short) (\(build))"
    }

    /// Today's file selected in Finder, else the folder.
    static func openLogFolder() {
        let log = EngineLogFile.shared
        log.flush()
        let today = log.file()
        if FileManager.default.fileExists(atPath: today.path) {
            NSWorkspace.shared.activateFileViewerSelecting([today])
        } else {
            try? FileManager.default.createDirectory(at: log.directory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(log.directory)
        }
    }

    /// Versions, the window's state, the last error and its recent log lines (masked) → the clipboard. Without a window,
    /// the versions and the end of today's file. MARK: polish p-lifecycle (P1-chrome-13): it says so — "진단 정보를 복사했어요 —
    /// 신고 글에 붙여 넣으세요" (`then`: what follows, once it is on the clipboard — Report an Issue… opens the page).
    static func copyDiagnostics(store: AppState?, then: (@MainActor () -> Void)? = nil) {
        Task { @MainActor in
            let text: String
            if let store {
                text = await store.diagnosticsReport(appVersion: appVersion)
            } else {
                text = EngineDiagnostics(app: appVersion, engine: nil, claude: nil, node: nil,
                                         os: ProcessInfo.processInfo.operatingSystemVersionString,
                                         logFolder: EngineLogFile.shared.directory.path, state: ["no window"], lastError: [],
                                         recentLog: EngineLogFile.shared.tail(200)).text()
            }
            Clipboard.copy(text, toast: String(localized: "Diagnostics copied — paste them into your report"))
            then?()
        }
    }

    /// The store diagnostics are taken from: the key window's, else any window's.
    static func diagnosticsStore(_ focused: WorkbenchWindowEntry?) -> AppState? {
        focused?.store ?? WorkbenchRegistry.shared.focused?.store ?? WorkbenchRegistry.shared.stores.first
    }
}

// MARK: polish p-lifecycle — P1-chrome-08 / P5-sheets-45
/// Where Help goes: the project's own pages (its public GitHub repository — Core `AppUpdateSource`).
enum HelpLinks {
    private static let base = "https://\(AppUpdateSource.host)/\(AppUpdateSource.repository)"

    /// The README in the app's language.
    static var help: URL {
        let korean = Bundle.main.preferredLocalizations.first?.hasPrefix("ko") == true
        return URL(string: korean ? "\(base)/blob/main/README.ko.md" : "\(base)#readme")!
    }

    static var releaseNotes: URL { URL(string: "\(base)/releases")! }
    static var newIssue: URL { URL(string: "\(base)/issues/new")! }
}

/// Help: MARK: polish p-lifecycle (P1-chrome-08 / P5-sheets-45) — SwiftUI's own "ReviewGate Help" only said "도움말을 사용할 수
/// 없습니다" (there is no help book): the group is replaced by how to use it (the README), the keyboard shortcuts, what
/// changed (the releases) and where to say what broke — the diagnostics go on the clipboard first —, then the log folder and
/// "진단 정보 복사" (the key window's, else any window's). The Help menu's search field stays macOS's.
struct HelpCommands: Commands {
    let focused: WorkbenchWindowEntry?
    let openWindow: OpenWindowAction

    var body: some Commands {
        CommandGroup(replacing: .help) {
            Button("ReviewGate Help") { NSWorkspace.shared.open(HelpLinks.help) }
                .help(HelpLinks.help.absoluteString)
                .accessibilityIdentifier("Help menu ReviewGate Help")
            Button("Keyboard Shortcuts") { openWindow(id: keyboardShortcutsWindowID) }
                .accessibilityIdentifier("Help menu Keyboard shortcuts")
            Button("Release Notes") { NSWorkspace.shared.open(HelpLinks.releaseNotes) }
                .help(HelpLinks.releaseNotes.absoluteString)
                .accessibilityIdentifier("Help menu Release notes")
            Button("Report an Issue…") {
                LogActions.copyDiagnostics(store: LogActions.diagnosticsStore(focused)) { NSWorkspace.shared.open(HelpLinks.newIssue) }
            }
            .help("Copies the diagnostics, then opens a new issue on GitHub — paste them into it")
            .accessibilityIdentifier("Help menu Report an issue")
            Divider()
            // r2-review-flow M27: the engine log is no line under every composer any more — shown in the key window from here
            // (or the error banner's Show log), × puts it away.
            Button("Show Engine Log") { focused?.model.showSidecarLog = true }
                .disabled(focused == nil)
                .accessibilityIdentifier("Help menu Show engine log")
            Button("Open Log Folder") { LogActions.openLogFolder() }
                .accessibilityIdentifier("Help menu Open log folder")
            Button("Copy Diagnostics") { LogActions.copyDiagnostics(store: LogActions.diagnosticsStore(focused)) }
                .accessibilityIdentifier("Help menu Copy diagnostics")
        }
    }
}
