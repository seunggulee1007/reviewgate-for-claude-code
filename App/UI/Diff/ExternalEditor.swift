import AppKit
import Foundation
import ReviewGateCore

/// Editors the DiffView "Open in Editor" menu can hand a file:line to. Only installed apps are listed
/// (detected via `NSWorkspace.urlForApplication(withBundleIdentifier:)`); the system's app and Finder are always available.
/// The last pick is remembered in UserDefaults `preferredEditor` (Settings › General › Open in) and becomes the primary
/// button. MARK: code-nav (§62): VS Code and IntelliJ IDEA open through their links (`IDELink`) at the line, Xcode with
/// `/usr/bin/xed --line`; with nothing picked a Java / Kotlin / JSP project opens in IntelliJ IDEA when it is installed.
enum ExternalEditor: String, CaseIterable, Identifiable {
    case vscode, intellij, xcode, systemDefault, finder

    static let defaultsKey = "preferredEditor"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .vscode: "VS Code"
        case .intellij: "IntelliJ IDEA"
        case .xcode: "Xcode"
        case .systemDefault: String(localized: "Default App")
        case .finder: String(localized: "Reveal in Finder")
        }
    }

    var systemImage: String {
        switch self {
        case .vscode, .intellij, .xcode, .systemDefault: "arrow.up.forward.app"
        case .finder: "folder"
        }
    }

    private var bundleIdentifiers: [String] {
        switch self {
        case .vscode: ["com.microsoft.VSCode"]
        case .intellij: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"]
        case .xcode: ["com.apple.dt.Xcode"]
        case .systemDefault, .finder: []
        }
    }

    /// The installed app bundle, or nil when not installed (the system's app and Finder have none and are always offered).
    var appURL: URL? {
        bundleIdentifiers.lazy.compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
    }

    var isInstalled: Bool { self == .finder || self == .systemDefault || appURL != nil }

    static var installed: [ExternalEditor] { allCases.filter(\.isInstalled) }

    static var preferred: ExternalEditor? {
        UserDefaults.standard.string(forKey: defaultsKey).flatMap(ExternalEditor.init(rawValue:))
            .flatMap { $0.isInstalled ? $0 : nil }
    }

    /// The editor for `store`'s project: the one picked (Settings › Open in, or the last one used), else IntelliJ IDEA for a
    /// Maven / Gradle / Java / Kotlin / JSP project when it is installed, else VS Code, else the system's app.
    @MainActor
    static func preferred(for store: AppState?) -> ExternalEditor {
        if let preferred { return preferred }
        return automatic(for: store)
    }

    /// What "Automatic" means for `store`'s project.
    @MainActor
    static func automatic(for store: AppState?) -> ExternalEditor {
        if let store, ExternalEditor.intellij.isInstalled, prefersJetBrains(store) { return .intellij }
        if ExternalEditor.vscode.isInstalled { return .vscode }
        if ExternalEditor.intellij.isInstalled { return .intellij }
        return .systemDefault
    }

    /// The root folder's entries, read once per root.
    @MainActor private static var rootEntries: [String: [String]] = [:]

    @MainActor
    private static func prefersJetBrains(_ store: AppState) -> Bool {
        guard let root = store.projectInfo?.root ?? store.projectURL?.path else { return false }
        let entries = rootEntries[root] ?? {
            let list = (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []
            rootEntries[root] = list
            return list
        }()
        let paths = store.changedFiles.prefix(500).map(\.path) + [store.codeBrowser.selection?.path].compactMap { $0 }
        return IDELink.prefersJetBrains(rootEntries: entries, paths: paths)
    }

    /// Opens `absolutePath` at `line` (and `column`) and remembers this editor as the preferred one.
    func open(_ absolutePath: String, line: Int, column: Int = 1) {
        UserDefaults.standard.set(rawValue, forKey: Self.defaultsKey)
        let url = URL(fileURLWithPath: absolutePath)
        switch self {
        case .finder:
            NSWorkspace.shared.activateFileViewerSelecting([url])
        case .systemDefault:
            NSWorkspace.shared.open(url)
        case .vscode:
            if let link = IDELink.vscode(path: absolutePath, line: line, column: column), Self.canOpen(link) {
                NSWorkspace.shared.open(link)
            } else if let cli = Self.cli("code") {
                Self.run(cli, ["-g", "\(absolutePath):\(line)"])
            } else if let app = appURL {
                Self.run("/usr/bin/open", ["-a", app.path, "--args", "-g", "\(absolutePath):\(line)"])
            }
        case .intellij:
            if let link = IDELink.intellij(path: absolutePath, line: line), Self.canOpen(link) {
                NSWorkspace.shared.open(link)
            } else if let app = appURL {
                Self.run("/usr/bin/open", ["-na", app.path, "--args", "--line", String(line), absolutePath])
            }
        case .xcode:
            if FileManager.default.isExecutableFile(atPath: "/usr/bin/xed") {
                Self.run("/usr/bin/xed", IDELink.xedArguments(path: absolutePath, line: line))
            } else if let app = appURL {
                Self.run("/usr/bin/open", ["-a", app.path, absolutePath])
            }
        }
    }

    /// An app is registered for the link's scheme (`vscode://`, `idea://`).
    private static func canOpen(_ link: URL) -> Bool {
        NSWorkspace.shared.urlForApplication(toOpen: link) != nil
    }

    /// A CLI shim on the common PATH locations (GUI apps don't inherit the shell PATH).
    private static func cli(_ name: String) -> String? {
        let dirs = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
            + ["/usr/local/bin", "/opt/homebrew/bin"]
        return dirs.map { "\($0)/\(name)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func run(_ executable: String, _ arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = nil
        process.standardError = nil
        try? process.run()
    }
}
