import Foundation

// MARK: polish p-lifecycle — P1-chrome-07: File › Open Recent names a project by its folder, as the project menu does (it
// showed the whole path); two rows with the same folder name say their parent too ("api — acme", "api — beta"). Clear
// Menu forgets the list. docs/PROTOCOL.md §55.8.

public enum RecentMenu {
    /// Each url's row title, in order: the folder's name; " — <parent>" when another row has the same name; the parent's
    /// path (with ~) when the parents' names are the same too.
    public static func titles(_ urls: [URL], home: String = NSHomeDirectory()) -> [String] {
        let names = urls.map(\.lastPathComponent)
        let parents = urls.map { $0.deletingLastPathComponent().lastPathComponent }
        return urls.indices.map { i in
            let name = names[i]
            guard names.indices.contains(where: { $0 != i && names[$0] == name }) else { return name }
            let parentClashes = names.indices.contains { $0 != i && names[$0] == name && parents[$0] == parents[i] }
            guard parentClashes else { return "\(name) — \(parents[i])" }
            return "\(name) — \(abbreviatingHome(urls[i].deletingLastPathComponent().path, home: home))"
        }
    }

    static func abbreviatingHome(_ path: String, home: String) -> String {
        guard !home.isEmpty, path == home || path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }
}

public extension AppSettings {
    /// File › Open Recent › Clear Menu: forgets every recent project (the windows to reopen — `openWindows` — stay).
    static func clearRecentProjects(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: Key.recentProjects)
    }
}
