import Foundation

// MARK: wave4 w4-install
// Audit robustness-13 / daily-15 / polish-13: an app run straight from a disk image (`/Volumes/…`) or from App
// Translocation loses its sidecar when the image is ejected — the engine can no longer restart. The window says so once
// per launch and offers "Move to Applications": copy → reopen from the new place → quit this one. The decisions and the
// order live here; the file operations are injected (`AppMoveOps`), so tests never touch the real /Applications.

/// Where the running app bundle lives.
public enum AppInstallLocation: Equatable, Sendable {
    /// Anywhere that stays put (Applications, ~/Applications, a build folder).
    case regular
    /// A mounted volume under `/Volumes` — a disk image (or an external disk) that can be ejected under the running app.
    case diskImage(volume: String)
    /// macOS runs a quarantined app from a random read-only copy (`…/AppTranslocation/<id>/d/ReviewGate.app`).
    case translocated

    /// `isBootVolume`: `/Volumes/Macintosh HD` is a link to `/` — not removable.
    public static func classify(bundlePath: String, isBootVolume: (String) -> Bool = AppInstallLocation.isBootVolume) -> AppInstallLocation {
        if bundlePath.contains("/AppTranslocation/") { return .translocated }
        let parts = bundlePath.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count >= 3, parts[0] == "Volumes" else { return .regular }
        let volume = String(parts[1])
        return isBootVolume("/Volumes/\(volume)") ? .regular : .diskImage(volume: volume)
    }

    public static func isBootVolume(_ volumePath: String) -> Bool {
        URL(fileURLWithPath: volumePath).resolvingSymlinksInPath().path == "/"
    }

    /// The banner shows (until "Later") when the app should be moved.
    public var shouldOfferMove: Bool { self != .regular }
}

/// `CFBundleShortVersionString` + `CFBundleVersion`, shown as "0.2.3 (610)".
public struct AppBundleVersion: Equatable, Sendable, CustomStringConvertible {
    public let short: String
    public let build: String

    public init(short: String, build: String) {
        self.short = short
        self.build = build
    }

    /// From an Info.plist dictionary; nil without a short version.
    public init?(info: [String: Any]) {
        guard let short = info["CFBundleShortVersionString"] as? String, !short.isEmpty else { return nil }
        self.init(short: short, build: info["CFBundleVersion"] as? String ?? "")
    }

    public var description: String { build.isEmpty ? short : "\(short) (\(build))" }

    /// Dotted version compared number by number ("0.2.10" > "0.2.9"), then the build number.
    public static func compare(_ a: AppBundleVersion, _ b: AppBundleVersion) -> ComparisonResult {
        let byShort = a.short.compare(b.short, options: .numeric)
        if byShort != .orderedSame { return byShort }
        return a.build.compare(b.build, options: .numeric)
    }
}

/// How the copy already in the destination relates to the running one.
public enum AppVersionOrder: Equatable, Sendable {
    case runningIsNewer, same, installedIsNewer, unknown

    public static func of(running: AppBundleVersion?, installed: AppBundleVersion?) -> AppVersionOrder {
        guard let running, let installed else { return .unknown }
        switch AppBundleVersion.compare(running, installed) {
        case .orderedDescending: return .runningIsNewer
        case .orderedSame: return .same
        case .orderedAscending: return .installedIsNewer
        }
    }
}

/// What "Move to Applications" does before touching anything.
public enum AppMovePlan: Equatable, Sendable {
    /// Nothing there yet: copy straight in.
    case copy(destination: String)
    /// The same app is already there: the user decides (versions shown) — replacing trashes the installed copy.
    case askReplace(destination: String, installed: AppBundleVersion?, running: AppBundleVersion?, order: AppVersionOrder)
}

/// The file operations, injected (the real ones in the app; recorders in tests).
public struct AppMoveOps: Sendable {
    public var exists: @Sendable (String) -> Bool
    public var version: @Sendable (String) -> AppBundleVersion?
    public var copy: @Sendable (_ from: String, _ to: String) throws -> Void
    /// Moves the installed copy to the Trash (recoverable).
    public var trash: @Sendable (String) throws -> Void
    /// A rename within the destination folder.
    public var move: @Sendable (_ from: String, _ to: String) throws -> Void
    /// Best-effort clean-up of a partial copy.
    public var remove: @Sendable (String) -> Void
    /// Opens `path` once this process has quit (never two copies holding the same projects at once).
    public var reopenAfterQuit: @Sendable (String) throws -> Void
    public var quit: @Sendable () -> Void

    public init(exists: @escaping @Sendable (String) -> Bool, version: @escaping @Sendable (String) -> AppBundleVersion?,
                copy: @escaping @Sendable (String, String) throws -> Void, trash: @escaping @Sendable (String) throws -> Void,
                move: @escaping @Sendable (String, String) throws -> Void, remove: @escaping @Sendable (String) -> Void,
                reopenAfterQuit: @escaping @Sendable (String) throws -> Void, quit: @escaping @Sendable () -> Void) {
        self.exists = exists
        self.version = version
        self.copy = copy
        self.trash = trash
        self.move = move
        self.remove = remove
        self.reopenAfterQuit = reopenAfterQuit
        self.quit = quit
    }
}

public enum AppMoveOutcome: Equatable, Sendable {
    /// Copied; the new copy opens when this one has quit (already asked to quit).
    case reopening(destination: String)
    /// Nothing was quit. `copied`: the app is in the destination already (only reopening failed).
    case failed(step: Step, message: String, copied: Bool)

    public enum Step: Equatable, Sendable { case copy, replace, reopen }
}

public enum AppMover {
    public static let applicationsFolder = "/Applications"

    public static func destination(for source: String, in folder: String = applicationsFolder) -> String {
        (folder as NSString).appendingPathComponent((source as NSString).lastPathComponent)
    }

    public static func plan(source: String, folder: String = applicationsFolder, ops: AppMoveOps) -> AppMovePlan {
        let destination = destination(for: source, in: folder)
        guard ops.exists(destination) else { return .copy(destination: destination) }
        let installed = ops.version(destination)
        let running = ops.version(source)
        return .askReplace(destination: destination, installed: installed, running: running,
                           order: .of(running: running, installed: installed))
    }

    /// Copy → (replace: copy beside it, trash the installed one, rename) → reopen after quit → quit. Any failure stops
    /// before the quit, so the running app is never lost; a partial copy is removed.
    public static func perform(source: String, destination: String, replace: Bool, ops: AppMoveOps,
                               stagingSuffix: String = UUID().uuidString) -> AppMoveOutcome {
        if replace {
            let folder = (destination as NSString).deletingLastPathComponent
            let staging = (folder as NSString).appendingPathComponent(".\((destination as NSString).lastPathComponent).moving-\(stagingSuffix)")
            do { try ops.copy(source, staging) } catch {
                ops.remove(staging)
                return .failed(step: .copy, message: error.localizedDescription, copied: false)
            }
            do {
                try ops.trash(destination)
                try ops.move(staging, destination)
            } catch {
                ops.remove(staging)
                return .failed(step: .replace, message: error.localizedDescription, copied: false)
            }
        } else {
            do { try ops.copy(source, destination) } catch {
                ops.remove(destination)
                return .failed(step: .copy, message: error.localizedDescription, copied: false)
            }
        }
        do { try ops.reopenAfterQuit(destination) } catch {
            return .failed(step: .reopen, message: error.localizedDescription, copied: true)
        }
        ops.quit()
        return .reopening(destination: destination)
    }

    /// Why the button is disabled right now (nil: enabled). A running turn would be cut off by the quit.
    public enum Block: Equatable, Sendable { case turnRunning, moving }

    public static func block(anyTurnRunning: Bool, moving: Bool) -> Block? {
        if moving { return .moving }
        return anyTurnRunning ? .turnRunning : nil
    }
}

/// Audit daily-17: the recent list without temporary / test folders, each row knowing whether its folder still exists.
public enum RecentProjects {
    /// Temporary and test locations (scratch runs, demos, the test suites) never enter the list. Same list as Electron's.
    public static let transientPrefixes = ["/private/tmp/", "/tmp/", "/private/var/folders/", "/var/folders/"]

    public static func isTransient(_ path: String) -> Bool {
        let p = path.hasSuffix("/") ? path : path + "/"
        return transientPrefixes.contains { p.hasPrefix($0) }
    }

    public struct Entry: Hashable, Sendable {
        public let url: URL
        /// False: shown dimmed with "Not found"; opening it is refused.
        public let exists: Bool
        public init(url: URL, exists: Bool) {
            self.url = url
            self.exists = exists
        }
    }

    public static func entries(_ urls: [URL], isDirectory: (String) -> Bool = RecentProjects.isDirectory) -> [Entry] {
        urls.filter { !isTransient($0.path) }.map { Entry(url: $0, exists: isDirectory($0.path)) }
    }

    public static func entries(defaults: UserDefaults = .standard, isDirectory: (String) -> Bool = RecentProjects.isDirectory) -> [Entry] {
        entries(AppSettings.recentProjects(defaults: defaults), isDirectory: isDirectory)
    }

    /// Drops every recent whose folder is gone; returns how many.
    @discardableResult
    public static func removeMissing(defaults: UserDefaults = .standard, isDirectory: (String) -> Bool = RecentProjects.isDirectory) -> Int {
        let missing = entries(defaults: defaults, isDirectory: isDirectory).filter { !$0.exists }
        for entry in missing { AppSettings.removeRecentProject(entry.url, defaults: defaults) }
        return missing.count
    }

    public static func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }
}
