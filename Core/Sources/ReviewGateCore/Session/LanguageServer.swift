import Foundation

// MARK: lsp — docs/PROTOCOL.md §73.5 on the Mac: the language server for JS / TS / Vue — the setting, whether this build has
// it, and the words for "exact" / "estimated" next to a definition or references answer. Tested in `LanguageServerTests`.

/// Settings › Review › Diff "Use the language server for JS/TS/Vue" (user defaults `languageServer`, on by default).
public enum LanguageServerSetting {
    public static let defaultsKey = "languageServer"

    public static func isOn(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) == nil ? true : defaults.bool(forKey: defaultsKey)
    }

    /// Whether the build carries the server: `lsp/` next to `sidecar.mjs` (`Contents/Resources/dist/lsp`), as the engine looks.
    public static func bundled(sidecarPath: String, fileManager: FileManager = .default) -> Bool {
        let dir = (sidecarPath as NSString).deletingLastPathComponent
        return fileManager.fileExists(atPath: (dir as NSString).appendingPathComponent("lsp/node_modules/typescript/lib/tsserver.js"))
    }
}

public enum NavSourceText {
    /// The small label: "Exact" for the language server's answer, "Estimated" for the search's (an older engine's too).
    public static func label(_ source: NavSource?) -> String {
        source == .lsp ? String(localized: "Exact", bundle: .module) : String(localized: "Estimated", bundle: .module)
    }

    /// The label's tooltip: who answered, and why the search did when the language server could not.
    public static func help(_ source: NavSource?, fallback: LspFallback?) -> String {
        if source == .lsp { return String(localized: "Found by the language server (TypeScript)", bundle: .module) }
        switch fallback {
        case .starting: return String(localized: "The language server is still starting, so this was found by searching", bundle: .module)
        case .timeout: return String(localized: "The language server did not answer in time, so this was found by searching", bundle: .module)
        case .failed, .unavailable: return String(localized: "The language server is not available, so this was found by searching", bundle: .module)
        case .noResult: return String(localized: "The language server found nothing inside the project, so this was found by searching", bundle: .module)
        case .off: return String(localized: "The language server is off in Settings — found by searching", bundle: .module)
        case nil: return String(localized: "Found by searching — other things with the same name may be listed", bundle: .module)
        }
    }

    /// While `state.nav.lsp` is starting: said next to "Looking for X…".
    public static var starting: String { String(localized: "Starting the language server…", bundle: .module) }
}
