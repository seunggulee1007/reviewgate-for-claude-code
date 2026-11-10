import Foundation

// MARK: wave3 mac-session
// Handing a folder to the running app (docs/PROTOCOL.md §36.9: client-only): a folder opened with the app — `open -a
// ReviewGate <dir>` in a terminal, Finder's "Open With" or a drop on the Dock icon — or the link
// `reviewgate://open?path=<dir>`. The window that has it open comes to the front; otherwise it opens in an empty window or a
// new one. A link can come from anywhere (a web page), so a folder the user never opened here asks first: opening a project
// starts Claude Code with that folder's own settings and hooks.

public enum FolderHandoff {
    public enum Source: Sendable, Equatable {
        /// A folder opened with the app (terminal, Finder, Dock).
        case file
        /// `reviewgate://open?path=…`.
        case link
    }

    public struct Request: Sendable, Equatable {
        public var folder: URL
        public var source: Source

        public init(folder: URL, source: Source) {
            self.folder = folder
            self.source = source
        }
    }

    /// The app's URL scheme (CFBundleURLTypes in App/Info.plist).
    public static let scheme = "reviewgate"

    /// The folder `url` hands over, or nil: a file URL of a directory, or `reviewgate://open?path=<absolute or ~ path>` of
    /// one (also `reviewgate:///open?…`).
    public static func request(for url: URL, isDirectory: (String) -> Bool) -> Request? {
        if url.isFileURL {
            let path = url.standardizedFileURL.path
            return isDirectory(path) ? Request(folder: URL(fileURLWithPath: path), source: .file) : nil
        }
        guard url.scheme?.lowercased() == scheme, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let host = components.host ?? ""
        let action = (host.isEmpty ? components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) : host).lowercased()
        guard action == "open", let raw = components.queryItems?.first(where: { $0.name == "path" })?.value else { return nil }
        let expanded = (raw.trimmingCharacters(in: .whitespacesAndNewlines) as NSString).expandingTildeInPath
        guard expanded.hasPrefix("/") else { return nil }
        let path = URL(fileURLWithPath: expanded).standardizedFileURL.path
        return isDirectory(path) ? Request(folder: URL(fileURLWithPath: path), source: .link) : nil
    }

    /// Every folder `urls` hand over, each once (the first mention wins).
    public static func requests(for urls: [URL], isDirectory: (String) -> Bool) -> [Request] {
        var seen = Set<String>()
        return urls.compactMap { request(for: $0, isDirectory: isDirectory) }.filter { seen.insert(AppSettings.projectKey($0.folder)).inserted }
    }

    /// A link to a folder that is neither open nor among the recent projects asks before opening it.
    public static func needsConfirmation(_ request: Request, known: [URL]) -> Bool {
        guard request.source == .link else { return false }
        let key = AppSettings.projectKey(request.folder)
        return !known.contains { AppSettings.projectKey($0) == key }
    }

    /// `FileManager`'s answer: an existing directory.
    public static func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }
}

/// The same hand-off can reach the app twice — AppKit's `application(_:open:)` and SwiftUI's `onOpenURL` — so a folder is
/// admitted once per `window`.
public struct FolderHandoffGate: Sendable {
    public static let window: TimeInterval = 3
    private var recent: [String: Date] = [:]

    public init() {}

    public mutating func admit(_ folder: URL, now: Date = Date()) -> Bool {
        recent = recent.filter { now.timeIntervalSince($0.value) < Self.window }
        let key = AppSettings.projectKey(folder)
        guard recent[key] == nil else { return false }
        recent[key] = now
        return true
    }
}
