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
    /// the versions and the end of today's file.
    static func copyDiagnostics(store: AppState?) {
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
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }
}

/// Help › "로그 폴더 열기" / "진단 정보 복사" (the key window's, else any window's).
struct HelpCommands: Commands {
    let focused: WorkbenchWindowEntry?

    var body: some Commands {
        CommandGroup(after: .help) {
            Divider()
            Button("Open Log Folder") { LogActions.openLogFolder() }
                .accessibilityIdentifier("Help menu Open log folder")
            Button("Copy Diagnostics") {
                LogActions.copyDiagnostics(store: focused?.store ?? WorkbenchRegistry.shared.focused?.store ?? WorkbenchRegistry.shared.stores.first)
            }
            .accessibilityIdentifier("Help menu Copy diagnostics")
        }
    }
}
