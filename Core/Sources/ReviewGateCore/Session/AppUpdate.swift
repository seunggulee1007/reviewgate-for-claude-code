import Foundation

// MARK: app-update
// docs/PROTOCOL.md §48: the app notices a new release and offers to install it. Releases are GitHub releases of a private
// repository, so the app cannot ask the public API anonymously: it asks through the user's own `gh` (logged in to
// github.com) — the path the engine resolved (`state.toolchain.gh`), else the login shell's PATH. Checks at launch, every
// 6 hours and from "Check for Updates…"; a closed banner stays closed for that version. The install (download, checksum,
// signature, the restart helper) is `AppUpdateInstall.swift`. Every external program goes through an injected runner, so
// the tests never reach the network.

/// `x.y.z[-pre][+build]` compared as semver: numbers by value, a pre-release below its release, build metadata ignored.
public struct SemanticVersion: Comparable, Hashable, Sendable, CustomStringConvertible {
    public let major: Int
    public let minor: Int
    public let patch: Int
    /// Dot-separated pre-release identifiers (`["beta", "2"]`); empty for a release.
    public let prerelease: [String]

    public init(major: Int, minor: Int, patch: Int, prerelease: [String] = []) {
        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = prerelease
    }

    /// "0.5.5", "v0.5.5" (a tag), "1.0.0-beta.2", "1.0.0+42"; nil for anything else ("0.5", "latest").
    public init?(_ text: String) {
        var s = Substring(text.trimmingCharacters(in: .whitespacesAndNewlines))
        if s.first == "v" || s.first == "V" { s = s.dropFirst() }
        if let plus = s.firstIndex(of: "+") { s = s[..<plus] }
        var pre: [String] = []
        if let dash = s.firstIndex(of: "-") {
            pre = s[s.index(after: dash)...].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            guard !pre.isEmpty, pre.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" } }) else { return nil }
            s = s[..<dash]
        }
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
              let major = Int(parts[0]), let minor = Int(parts[1]), let patch = Int(parts[2]) else { return nil }
        self.init(major: major, minor: minor, patch: patch, prerelease: pre)
    }

    public var description: String {
        let core = "\(major).\(minor).\(patch)"
        return prerelease.isEmpty ? core : core + "-" + prerelease.joined(separator: ".")
    }

    public static func < (a: SemanticVersion, b: SemanticVersion) -> Bool {
        if a.major != b.major { return a.major < b.major }
        if a.minor != b.minor { return a.minor < b.minor }
        if a.patch != b.patch { return a.patch < b.patch }
        // A release ranks above its own pre-releases.
        switch (a.prerelease.isEmpty, b.prerelease.isEmpty) {
        case (true, true), (true, false): return false
        case (false, true): return true
        case (false, false): break
        }
        for (x, y) in zip(a.prerelease, b.prerelease) where x != y {
            switch (Int(x), Int(y)) {
            case let (nx?, ny?): return nx < ny
            case (.some, nil): return true    // numeric identifiers rank below alphanumeric ones
            case (nil, .some): return false
            case (nil, nil): return x < y
            }
        }
        return a.prerelease.count < b.prerelease.count
    }
}

/// Where releases come from, and the `gh` calls that read them.
public enum AppUpdateSource {
    public static let host = "github.com"
    public static let repository = "seunggulee1007/reviewgate-for-claude-code"
    /// The release assets the installer takes: `ReviewGate-0.5.5.dmg` and `ReviewGate-0.5.5.dmg.sha256`.
    public static let assetPattern = "ReviewGate-*.dmg*"

    /// `gh api … releases/latest` — the newest release that is neither a draft nor a pre-release.
    public static var latestReleaseArguments: [String] {
        ["api", "--hostname", host, "repos/\(repository)/releases/latest"]
    }

    public static func downloadArguments(tag: String, into directory: String) -> [String] {
        ["release", "download", tag, "--repo", "\(host)/\(repository)", "-p", assetPattern, "-D", directory]
    }

    public static var releasesPage: URL { URL(string: "https://\(host)/\(repository)/releases")! }
}

/// One GitHub release, from `releases/latest`.
public struct AppRelease: Equatable, Sendable {
    public struct Asset: Equatable, Sendable {
        public let name: String
        public let size: Int
        /// GitHub's own checksum of the upload (`"sha256:<hex>"` → the hex), when the API reports it.
        public let sha256: String?

        public init(name: String, size: Int, sha256: String? = nil) {
            self.name = name
            self.size = size
            self.sha256 = sha256
        }
    }

    /// "v0.5.5".
    public let tag: String
    public let version: SemanticVersion
    public let title: String?
    /// The release notes (Markdown).
    public let notes: String
    public let page: URL?
    public let publishedAt: Date?
    public let assets: [Asset]

    public init(tag: String, version: SemanticVersion, title: String? = nil, notes: String = "", page: URL? = nil,
                publishedAt: Date? = nil, assets: [Asset] = []) {
        self.tag = tag
        self.version = version
        self.title = title
        self.notes = notes
        self.page = page
        self.publishedAt = publishedAt
        self.assets = assets
    }

    /// `ReviewGate-<version>.dmg` (the version the tag names).
    public var dmg: Asset? { assets.first { $0.name == "ReviewGate-\(version).dmg" } }
    /// `ReviewGate-<version>.dmg.sha256` beside it.
    public var checksum: Asset? { dmg.flatMap { dmg in assets.first { $0.name == dmg.name + ".sha256" } } }
    /// Both assets are there: the release can be installed from the app.
    public var isInstallable: Bool { dmg != nil && checksum != nil }

    public enum ParseError: Error, Equatable, Sendable, CustomStringConvertible {
        case notJSON
        case missingTag
        case badTag(String)
        case notAPublishedRelease

        public var description: String {
            switch self {
            case .notJSON: "not a JSON object"
            case .missingTag: "no tag_name"
            case .badTag(let tag): "tag \(tag) is not vX.Y.Z"
            case .notAPublishedRelease: "a draft or a pre-release"
            }
        }
    }

    /// The `releases/latest` body. A tag that is not a version, a draft or a pre-release is refused (`latest` never returns
    /// those; an older GitHub Enterprise might).
    public static func parse(_ data: Data) throws -> AppRelease {
        guard let object = try? JSONSerialization.jsonObject(with: data), let json = object as? [String: Any] else {
            throw ParseError.notJSON
        }
        guard let tag = json["tag_name"] as? String, !tag.isEmpty else { throw ParseError.missingTag }
        guard let version = SemanticVersion(tag) else { throw ParseError.badTag(tag) }
        if json["draft"] as? Bool == true || json["prerelease"] as? Bool == true { throw ParseError.notAPublishedRelease }
        let assets = (json["assets"] as? [[String: Any]] ?? []).compactMap { asset -> Asset? in
            guard let name = asset["name"] as? String, !name.isEmpty else { return nil }
            let digest = (asset["digest"] as? String).flatMap { d -> String? in
                d.hasPrefix("sha256:") ? String(d.dropFirst("sha256:".count)).lowercased() : nil
            }
            return Asset(name: name, size: (asset["size"] as? NSNumber)?.intValue ?? 0, sha256: digest)
        }
        let title = (json["name"] as? String).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        return AppRelease(tag: tag, version: version, title: title, notes: json["body"] as? String ?? "",
                          page: (json["html_url"] as? String).flatMap(URL.init(string:)),
                          publishedAt: (json["published_at"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) },
                          assets: assets)
    }
}

/// Why a check found nothing to offer. An automatic check shows none of these (no banner); "Check for Updates…" says it.
public enum UpdateCheckProblem: Equatable, Sendable {
    /// No `gh` on this Mac.
    case ghMissing
    /// `gh` is not logged in to github.com (exit 4, "gh auth login").
    case notLoggedIn
    /// GitHub could not be reached (no network, DNS, a timeout).
    case offline
    /// 404: nothing published yet — or this account cannot see the private repository.
    case noRelease
    /// The reply is not a release this app can read.
    case badReply(String)
    case failed(String)

    /// From `gh`'s exit status and stderr.
    public static func classify(status: Int32, stderr: String) -> UpdateCheckProblem {
        let text = stderr.lowercased()
        if status == 4 || text.contains("gh auth login") || text.contains("authentication required") || text.contains("bad credentials")
            || text.contains("http 401") {
            return .notLoggedIn
        }
        if text.contains("http 404") || text.contains("not found") { return .noRelease }
        let offlineMarkers = ["error connecting to", "could not resolve", "no such host", "dial tcp", "network is unreachable",
                              "i/o timeout", "timeout", "connection refused", "connection reset", "tls handshake", "offline"]
        if offlineMarkers.contains(where: text.contains) { return .offline }
        // The runner's timeout ends gh with SIGTERM (then SIGKILL) before it prints anything.
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, status == SIGTERM || status == SIGKILL { return .offline }
        let line = stderr.split(whereSeparator: \.isNewline).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
        return .failed(line.isEmpty ? "gh exited with status \(status)" : line)
    }
}

public enum UpdateCheckOutcome: Equatable, Sendable {
    /// A newer release than the running app.
    case available(AppRelease)
    /// The running app is the latest (or newer than it: a local build).
    case upToDate(current: String, latest: String)
    case unavailable(UpdateCheckProblem)
}

/// Runs one external program (`gh`, `hdiutil`, `codesign`) — the live one is `CommandRunner.run` with `gh`'s environment;
/// tests give a fake.
public typealias UpdateRun = @Sendable (_ executable: String, _ arguments: [String], _ timeout: Duration) async throws -> CommandRunner.Output

public enum AppUpdateChecker {
    public static let interval: Duration = .seconds(6 * 60 * 60)
    static let checkTimeout: Duration = .seconds(30)

    /// `gh api …/releases/latest` compared with `currentVersion` (the running bundle's CFBundleShortVersionString).
    public static func check(currentVersion: String, ghPath: String?, run: UpdateRun) async -> UpdateCheckOutcome {
        guard let ghPath else { return .unavailable(.ghMissing) }
        let output: CommandRunner.Output
        do {
            output = try await run(ghPath, AppUpdateSource.latestReleaseArguments, checkTimeout)
        } catch {
            return .unavailable(.ghMissing)   // the file is gone or cannot be run
        }
        guard output.status == 0 else {
            // `gh api` prints GitHub's JSON error on stdout and its own line on stderr.
            return .unavailable(.classify(status: output.status, stderr: output.stderrText + "\n" + output.stdoutText))
        }
        return outcome(of: output.stdout, currentVersion: currentVersion)
    }

    /// The reply against the running version.
    public static func outcome(of reply: Data, currentVersion: String) -> UpdateCheckOutcome {
        let release: AppRelease
        do { release = try AppRelease.parse(reply) } catch {
            return .unavailable(.badReply(String(describing: error)))
        }
        guard let current = SemanticVersion(currentVersion) else {
            return .unavailable(.badReply("running version \(currentVersion) is not x.y.z"))
        }
        return release.version > current ? .available(release) : .upToDate(current: currentVersion, latest: release.version.description)
    }
}

/// Finds `gh` for the update check: the path the engine resolved first (any window's `state.toolchain.gh`), then each
/// directory of the login shell's PATH, then Homebrew's two prefixes.
public enum UpdateGHLocator {
    public static func resolve(engineGh: String?, loginPATH: String?,
                               isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> String? {
        var candidates: [String] = []
        if let engineGh, !engineGh.isEmpty { candidates.append(engineGh) }
        for dir in (loginPATH ?? "").split(separator: ":") where dir.hasPrefix("/") {
            candidates.append((String(dir) as NSString).appendingPathComponent("gh"))
        }
        candidates += ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
        return candidates.first(where: isExecutable)
    }

    /// The PATH `gh` runs with: the window's login PATH when one is known, else the login shell is asked once (the same
    /// probe that finds `node`).
    public static func loginPATH(known: String?) async -> String {
        if let known, !known.isEmpty { return known }
        if let probed = await ToolchainLocator.loginShellProbe()?.path, !probed.isEmpty { return probed }
        return ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    }

    /// `CommandRunner.run` with the app's environment, `PATH` set to `path` and gh kept quiet and non-interactive. `GH_HOST`
    /// / `GH_REPO` are dropped: every call names the host and the repository itself.
    public static func liveRun(path: String) -> UpdateRun {
        { executable, arguments, timeout in
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = path
            env["GH_PROMPT_DISABLED"] = "1"
            env["GH_NO_UPDATE_NOTIFIER"] = "1"
            env["GH_SPINNER_DISABLED"] = "1"
            env["NO_COLOR"] = "1"
            env.removeValue(forKey: "GH_HOST")
            env.removeValue(forKey: "GH_REPO")
            return try await CommandRunner.run(executable, arguments, env: env, timeout: timeout)
        }
    }
}

// MARK: - Settings: automatic checks, the closed banner

public extension AppSettings.Key {
    /// Check for updates at launch and every 6 hours (Bool, unset → on).
    static let checkForUpdatesAutomatically = "checkForUpdatesAutomatically"
    /// The highest release version whose banner was closed (String); a newer release shows again.
    static let dismissedUpdateVersion = "dismissedUpdateVersion"
}

public extension AppSettings {
    static func checkForUpdatesAutomatically(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.checkForUpdatesAutomatically) as? Bool ?? true
    }

    static func setCheckForUpdatesAutomatically(_ on: Bool, defaults: UserDefaults = .standard) {
        defaults.set(on, forKey: Key.checkForUpdatesAutomatically)
    }

    static func dismissedUpdateVersion(defaults: UserDefaults = .standard) -> SemanticVersion? {
        defaults.string(forKey: Key.dismissedUpdateVersion).flatMap(SemanticVersion.init)
    }

    /// Closes the banner of `version` for good; an older version closed before is replaced, a newer one is kept.
    static func dismissUpdate(_ version: SemanticVersion, defaults: UserDefaults = .standard) {
        if let closed = dismissedUpdateVersion(defaults: defaults), closed >= version { return }
        defaults.set(version.description, forKey: Key.dismissedUpdateVersion)
    }

    /// "Check for Updates…" found the closed version again: the user asked, so its banner comes back.
    static func clearDismissedUpdate(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: Key.dismissedUpdateVersion)
    }
}

public enum AppUpdateBanner {
    /// The banner offers `release` when it is newer than the running app and its version (or a newer one) was not closed.
    public static func shows(_ release: AppRelease?, currentVersion: String, dismissed: SemanticVersion?) -> Bool {
        guard let release, let current = SemanticVersion(currentVersion), release.version > current else { return false }
        if let dismissed, dismissed >= release.version { return false }
        return true
    }
}

// MARK: - Words

public enum AppUpdateText {
    /// The banner's title.
    public static func available(_ version: String) -> String {
        String(localized: "ReviewGate \(version) is available", bundle: .module)
    }

    /// The banner's second line.
    public static func youHave(_ current: String) -> String {
        String(localized: "You have \(current). Installing quits ReviewGate and opens the new version.", bundle: .module)
    }

    public static var installButton: String { String(localized: "Install and Restart", bundle: .module) }
    public static var whatsNewButton: String { String(localized: "What's New", bundle: .module) }

    public static func whatsNewTitle(_ version: String) -> String {
        String(localized: "What's new in ReviewGate \(version)", bundle: .module)
    }

    public static var noNotes: String { String(localized: "This release has no notes.", bundle: .module) }

    /// "Check for Updates…" when nothing is newer.
    public static var upToDateTitle: String { String(localized: "ReviewGate is up to date", bundle: .module) }

    public static func upToDate(current: String, latest: String) -> String {
        if current == latest { return String(localized: "\(current) is the latest release.", bundle: .module) }
        return String(localized: "This app is \(current); the latest release is \(latest).", bundle: .module)
    }

    public static var checkFailedTitle: String { String(localized: "Could not check for updates", bundle: .module) }

    public static var checking: String { String(localized: "Checking for updates…", bundle: .module) }

    /// Why a check found nothing (the on-demand check's alert, Settings' last result).
    public static func problem(_ problem: UpdateCheckProblem) -> String {
        switch problem {
        case .ghMissing:
            String(localized: "Updates are read with the GitHub CLI (gh), which was not found. Install it (brew install gh), log in with gh auth login, then check again.", bundle: .module)
        case .notLoggedIn:
            String(localized: "The GitHub CLI (gh) is not logged in to github.com. Run gh auth login in Terminal, then check again.", bundle: .module)
        case .offline:
            String(localized: "GitHub could not be reached. Check the network connection and try again.", bundle: .module)
        case .noRelease:
            String(localized: "No release was found — none is published yet, or this GitHub account cannot see \(AppUpdateSource.repository).", bundle: .module)
        case .badReply(let detail):
            String(localized: "GitHub's reply could not be read (\(detail)).", bundle: .module)
        case .failed(let message):
            String(localized: "The update check failed: \(message)", bundle: .module)
        }
    }

    /// Settings › General › Updates, under the toggle.
    public static var settingsNote: String {
        String(localized: "At launch and every 6 hours ReviewGate asks GitHub for the latest release through the GitHub CLI (gh). Nothing is installed until you click Install and Restart.", bundle: .module)
    }

    /// Settings: the last check's result.
    public static func lastResult(_ outcome: UpdateCheckOutcome) -> String {
        switch outcome {
        case .available(let release): available(release.version.description)
        case let .upToDate(current, latest): upToDate(current: current, latest: latest)
        case .unavailable(let problem): AppUpdateText.problem(problem)
        }
    }
}
