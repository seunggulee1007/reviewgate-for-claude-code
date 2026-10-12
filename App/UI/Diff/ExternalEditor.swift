import AppKit
import Foundation

/// Editors the DiffView "Open in Editor" menu can hand a file:line to. Only installed apps are listed
/// (detected via `NSWorkspace.urlForApplication(withBundleIdentifier:)`); Finder is always available.
/// The last pick is remembered in UserDefaults `preferredEditor` and becomes the primary button.
enum ExternalEditor: String, CaseIterable, Identifiable {
    case vscode, intellij, xcode, finder

    static let defaultsKey = "preferredEditor"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .vscode: "VS Code"
        case .intellij: "IntelliJ IDEA"
        case .xcode: "Xcode"
        case .finder: String(localized: "Reveal in Finder")
        }
    }

    var systemImage: String {
        switch self {
        case .vscode, .intellij, .xcode: "arrow.up.forward.app"
        case .finder: "folder"
        }
    }

    private var bundleIdentifiers: [String] {
        switch self {
        case .vscode: ["com.microsoft.VSCode"]
        case .intellij: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"]
        case .xcode: ["com.apple.dt.Xcode"]
        case .finder: []
        }
    }

    /// The installed app bundle, or nil when not installed (Finder has none and is always offered).
    var appURL: URL? {
        bundleIdentifiers.lazy.compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
    }

    var isInstalled: Bool { self == .finder || appURL != nil }

    static var installed: [ExternalEditor] { allCases.filter(\.isInstalled) }

    static var preferred: ExternalEditor? {
        UserDefaults.standard.string(forKey: defaultsKey).flatMap(ExternalEditor.init(rawValue:))
            .flatMap { $0.isInstalled ? $0 : nil }
    }

    /// Opens `absolutePath` at `line` and remembers this editor as the preferred one.
    func open(_ absolutePath: String, line: Int) {
        UserDefaults.standard.set(rawValue, forKey: Self.defaultsKey)
        let url = URL(fileURLWithPath: absolutePath)
        switch self {
        case .finder:
            NSWorkspace.shared.activateFileViewerSelecting([url])
        case .vscode:
            if let cli = Self.cli("code") {
                Self.run(cli, ["-g", "\(absolutePath):\(line)"])
            } else if let app = appURL {
                Self.run("/usr/bin/open", ["-a", app.path, "--args", "-g", "\(absolutePath):\(line)"])
            }
        case .intellij:
            if let app = appURL {
                Self.run("/usr/bin/open", ["-na", app.path, "--args", "--line", String(line), absolutePath])
            }
        case .xcode:
            Self.run("/usr/bin/xed", ["-l", String(line), absolutePath])
        }
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
