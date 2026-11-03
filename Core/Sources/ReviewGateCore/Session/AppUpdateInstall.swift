import Foundation
import CryptoKit

// MARK: app-update
// docs/PROTOCOL.md §48, the install half. `gh release download` (no quarantine: releases before 0.5.7 were not notarized,
// and Gatekeeper refuses a browser download of those) → the sha256 against the `.sha256` asset → `hdiutil attach -readonly`
// → the new app's signature (`codesign --verify --deep --strict`), team (the running app's) and version (the tag's) → no
// window has Claude working or waiting → a detached helper waits for this pid to exit, swaps the bundle at
// `Bundle.main.bundleURL` for a `ditto` copy of the image's, detaches the image and reopens the app. Nothing is replaced
// before every check passed, and a failed swap reopens the previous version. Never `pkill` / `killall`: the helper waits
// for one pid, this app's.

/// Why an install stopped (nothing was replaced).
public enum UpdateRefusal: Equatable, Sendable, Error {
    /// The release has no `ReviewGate-<v>.dmg` with its `.sha256`.
    case notInstallable
    /// The app runs from a disk image or a translocated copy: there is no lasting place to replace.
    case runsFromDiskImage
    /// The folder holding the app cannot be written.
    case folderNotWritable(String)
    case downloadFailed(String)
    case checksumMissing
    case checksumMismatch
    case mountFailed(String)
    case appMissing
    case signatureInvalid(String)
    /// The running app has no team identifier (ad-hoc signed): nothing to compare the new one with.
    case runningAppUnsigned
    case teamMismatch(running: String, new: String?)
    case versionMismatch(expected: String, found: String?)
    case bundleMismatch(expected: String, found: String?)
    case helperFailed(String)
}

/// The sha256 of the downloaded DMG against its `.sha256` asset (`shasum -a 256` output: `<hex>  ReviewGate-0.5.5.dmg`).
public enum UpdateChecksum {
    /// The hex digest in a `.sha256` file; nil when the first word is not 64 hex digits or the file names another file.
    public static func expected(in text: String, for fileName: String) -> String? {
        let words = text.split(whereSeparator: { $0 == " " || $0 == "\t" || $0.isNewline })
        guard let first = words.first, first.count == 64, first.allSatisfy(\.isHexDigit) else { return nil }
        if words.count > 1 {
            // `shasum -b` marks binary mode with `*`; a path is compared by its last component.
            let named = String(words[1]).replacingOccurrences(of: "*", with: "")
            guard (named as NSString).lastPathComponent == fileName else { return nil }
        }
        return first.lowercased()
    }

    /// The file's sha256, read in 1 MB pieces.
    public static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// nil = the download is the file published. GitHub's own digest of the asset, when it reports one, must agree too.
    public static func check(actual: String, checksumFile: String?, fileName: String, assetDigest: String?) -> UpdateRefusal? {
        guard let checksumFile, let expected = expected(in: checksumFile, for: fileName) else { return .checksumMissing }
        let actual = actual.lowercased()
        guard actual == expected else { return .checksumMismatch }
        if let assetDigest, assetDigest.lowercased() != actual { return .checksumMismatch }
        return nil
    }
}

/// What the checks read from an app bundle.
public struct UpdateAppFacts: Equatable, Sendable {
    /// `codesign --verify --deep --strict` exited 0.
    public var signatureValid: Bool
    /// `codesign`'s complaint when it is not.
    public var signatureMessage: String
    public var teamIdentifier: String?
    public var shortVersion: String?
    public var bundleIdentifier: String?

    public init(signatureValid: Bool, signatureMessage: String = "", teamIdentifier: String?, shortVersion: String?, bundleIdentifier: String?) {
        self.signatureValid = signatureValid
        self.signatureMessage = signatureMessage
        self.teamIdentifier = teamIdentifier
        self.shortVersion = shortVersion
        self.bundleIdentifier = bundleIdentifier
    }
}

public enum UpdateCodeSign {
    /// `TeamIdentifier=QW7DJ7FBDT` in `codesign -dv` output (stderr); nil for "not set" (ad-hoc) or none.
    public static func teamIdentifier(fromDisplayOutput text: String) -> String? {
        for line in text.split(whereSeparator: \.isNewline) where line.hasPrefix("TeamIdentifier=") {
            let value = line.dropFirst("TeamIdentifier=".count).trimmingCharacters(in: .whitespaces)
            return value.isEmpty || value == "not set" ? nil : value
        }
        return nil
    }

    /// The new app may replace the running one: a valid signature, the running app's team and bundle id, the tag's version.
    public static func gate(new: UpdateAppFacts, runningTeam: String?, runningBundleID: String?, expected: SemanticVersion) -> UpdateRefusal? {
        guard new.signatureValid else { return .signatureInvalid(new.signatureMessage) }
        guard let runningTeam else { return .runningAppUnsigned }
        guard new.teamIdentifier == runningTeam else { return .teamMismatch(running: runningTeam, new: new.teamIdentifier) }
        if let runningBundleID, new.bundleIdentifier != runningBundleID {
            return .bundleMismatch(expected: runningBundleID, found: new.bundleIdentifier)
        }
        guard let found = new.shortVersion.flatMap(SemanticVersion.init), found == expected else {
            return .versionMismatch(expected: expected.description, found: new.shortVersion)
        }
        return nil
    }
}

/// Whether the bundle at `Bundle.main.bundleURL` can be replaced where it is.
public enum UpdateLocation {
    public static func check(bundlePath: String, isWritable: (String) -> Bool,
                             isBootVolume: (String) -> Bool = AppInstallLocation.isBootVolume) -> UpdateRefusal? {
        guard AppInstallLocation.classify(bundlePath: bundlePath, isBootVolume: isBootVolume) == .regular else { return .runsFromDiskImage }
        let folder = (bundlePath as NSString).deletingLastPathComponent
        return isWritable(folder) ? nil : .folderNotWritable(folder)
    }
}

/// Restarting quits every window: never while Claude works or waits for an answer in one of them.
public enum UpdateRestartGate {
    public enum Decision: Equatable, Sendable {
        case restartNow
        /// Wait — `windows` windows have a turn running or a card waiting.
        case wait(windows: Int)
    }

    /// Every window's `closeGuardReason` (nil = idle). The "ask before closing" setting does not matter here.
    public static func decide(_ reasons: [CloseGuardReason?]) -> Decision {
        let busy = reasons.compactMap { $0 }.count
        return busy == 0 ? .restartNow : .wait(windows: busy)
    }
}

/// The image is downloaded, checked and mounted; the helper can take it from here.
public struct PreparedUpdate: Equatable, Sendable {
    public let version: SemanticVersion
    /// The temporary folder holding the download, the mount point and the helper (removed by the helper or `discard`).
    public let workDirectory: URL
    public let mountPoint: URL
    /// `ReviewGate.app` inside the mounted image.
    public let newApp: URL

    public init(version: SemanticVersion, workDirectory: URL, mountPoint: URL, newApp: URL) {
        self.version = version
        self.workDirectory = workDirectory
        self.mountPoint = mountPoint
        self.newApp = newApp
    }
}

public enum AppUpdateStep: Equatable, Sendable {
    case downloading, verifyingDownload, mounting, verifyingApp
}

/// What the installer needs from the running app; the tests give a temporary folder and a fake runner.
public struct AppUpdateContext: Sendable {
    public var ghPath: String
    public var run: UpdateRun
    /// `Bundle.main.bundlePath`.
    public var bundlePath: String
    public var bundleIdentifier: String?
    /// Where the work folder is made (`FileManager.default.temporaryDirectory`).
    public var temporaryDirectory: URL
    public var isWritable: @Sendable (String) -> Bool
    public var isBootVolume: @Sendable (String) -> Bool
    public var hdiutil = "/usr/bin/hdiutil"
    public var codesign = "/usr/bin/codesign"

    public init(ghPath: String, run: @escaping UpdateRun, bundlePath: String, bundleIdentifier: String?,
                temporaryDirectory: URL = FileManager.default.temporaryDirectory,
                isWritable: @escaping @Sendable (String) -> Bool = { FileManager.default.isWritableFile(atPath: $0) },
                isBootVolume: @escaping @Sendable (String) -> Bool = AppInstallLocation.isBootVolume) {
        self.ghPath = ghPath
        self.run = run
        self.bundlePath = bundlePath
        self.bundleIdentifier = bundleIdentifier
        self.temporaryDirectory = temporaryDirectory
        self.isWritable = isWritable
        self.isBootVolume = isBootVolume
    }
}

public enum AppUpdateInstaller {
    static let downloadTimeout: Duration = .seconds(15 * 60)
    static let toolTimeout: Duration = .seconds(120)

    /// Download → checksum → mount → signature / team / version. Any failure removes what was made (the image detached)
    /// and nothing of the installed app is touched.
    public static func prepare(_ release: AppRelease, context: AppUpdateContext,
                               step: @Sendable (AppUpdateStep) async -> Void) async -> Result<PreparedUpdate, UpdateRefusal> {
        if let refusal = UpdateLocation.check(bundlePath: context.bundlePath, isWritable: context.isWritable,
                                              isBootVolume: context.isBootVolume) {
            return .failure(refusal)
        }
        guard let dmg = release.dmg, let checksum = release.checksum else { return .failure(.notInstallable) }

        let fm = FileManager.default
        let work = context.temporaryDirectory.appendingPathComponent("ReviewGate-update-\(UUID().uuidString)", isDirectory: true)
        let downloads = work.appendingPathComponent("download", isDirectory: true)
        let mount = work.appendingPathComponent("mnt", isDirectory: true)
        do {
            try fm.createDirectory(at: downloads, withIntermediateDirectories: true)
            try fm.createDirectory(at: mount, withIntermediateDirectories: true)
        } catch {
            return .failure(.downloadFailed(error.localizedDescription))
        }
        var mounted = false
        func fail(_ refusal: UpdateRefusal) async -> Result<PreparedUpdate, UpdateRefusal> {
            if mounted { await detach(mount, context: context) }
            try? fm.removeItem(at: work)
            return .failure(refusal)
        }

        await step(.downloading)
        let download: CommandRunner.Output
        do {
            download = try await context.run(context.ghPath, AppUpdateSource.downloadArguments(tag: release.tag, into: downloads.path),
                                             downloadTimeout)
        } catch {
            return await fail(.downloadFailed(error.localizedDescription))
        }
        guard download.status == 0 else { return await fail(.downloadFailed(firstLine(download.stderrText, status: download.status))) }

        await step(.verifyingDownload)
        let dmgURL = downloads.appendingPathComponent(dmg.name)
        guard fm.fileExists(atPath: dmgURL.path) else { return await fail(.downloadFailed("\(dmg.name) was not downloaded")) }
        let checksumText = try? String(contentsOf: downloads.appendingPathComponent(checksum.name), encoding: .utf8)
        let actual: String
        do { actual = try UpdateChecksum.sha256(of: dmgURL) } catch { return await fail(.downloadFailed(error.localizedDescription)) }
        if let refusal = UpdateChecksum.check(actual: actual, checksumFile: checksumText, fileName: dmg.name, assetDigest: dmg.sha256) {
            return await fail(refusal)
        }

        await step(.mounting)
        let attach: CommandRunner.Output
        do {
            attach = try await context.run(context.hdiutil, ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount.path,
                                                             dmgURL.path], toolTimeout)
        } catch {
            return await fail(.mountFailed(error.localizedDescription))
        }
        guard attach.status == 0 else { return await fail(.mountFailed(firstLine(attach.stderrText, status: attach.status))) }
        mounted = true

        await step(.verifyingApp)
        let appName = (context.bundlePath as NSString).lastPathComponent
        guard let newApp = appInImage(mount, preferred: appName) else { return await fail(.appMissing) }
        let facts = await facts(of: newApp.path, context: context)
        let runningTeam = await teamIdentifier(of: context.bundlePath, context: context)
        if let refusal = UpdateCodeSign.gate(new: facts, runningTeam: runningTeam, runningBundleID: context.bundleIdentifier,
                                             expected: release.version) {
            return await fail(refusal)
        }
        return .success(PreparedUpdate(version: release.version, workDirectory: work, mountPoint: mount, newApp: newApp))
    }

    /// Cancelled before the restart (or the helper could not start): the image is detached and the work folder removed.
    public static func discard(_ prepared: PreparedUpdate, context: AppUpdateContext) async {
        await detach(prepared.mountPoint, context: context)
        try? FileManager.default.removeItem(at: prepared.workDirectory)
    }

    // MARK: Helpers

    /// `ReviewGate.app` (the running bundle's name) in the image, else its only app.
    static func appInImage(_ mount: URL, preferred: String) -> URL? {
        let fm = FileManager.default
        let named = mount.appendingPathComponent(preferred)
        if preferred.hasSuffix(".app"), fm.fileExists(atPath: named.path) { return named }
        let apps = ((try? fm.contentsOfDirectory(atPath: mount.path)) ?? []).filter { $0.hasSuffix(".app") }
        return apps.count == 1 ? mount.appendingPathComponent(apps[0]) : nil
    }

    static func facts(of appPath: String, context: AppUpdateContext) async -> UpdateAppFacts {
        let verify = try? await context.run(context.codesign, ["--verify", "--deep", "--strict", appPath], toolTimeout)
        let info = (try? Data(contentsOf: URL(fileURLWithPath: appPath).appendingPathComponent("Contents/Info.plist")))
            .flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any] }
        return UpdateAppFacts(signatureValid: verify?.status == 0,
                              signatureMessage: verify.map { firstLine($0.stderrText, status: $0.status) } ?? "codesign could not run",
                              teamIdentifier: await teamIdentifier(of: appPath, context: context),
                              shortVersion: info?["CFBundleShortVersionString"] as? String,
                              bundleIdentifier: info?["CFBundleIdentifier"] as? String)
    }

    static func teamIdentifier(of appPath: String, context: AppUpdateContext) async -> String? {
        guard let out = try? await context.run(context.codesign, ["-dv", "--verbose=2", appPath], toolTimeout), out.status == 0 else { return nil }
        return UpdateCodeSign.teamIdentifier(fromDisplayOutput: out.stderrText + "\n" + out.stdoutText)
    }

    static func detach(_ mount: URL, context: AppUpdateContext) async {
        let out = try? await context.run(context.hdiutil, ["detach", mount.path, "-quiet"], toolTimeout)
        if out?.status != 0 { _ = try? await context.run(context.hdiutil, ["detach", mount.path, "-force", "-quiet"], toolTimeout) }
    }

    static func firstLine(_ text: String, status: Int32) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
        return line.isEmpty ? "exit status \(status)" : line
    }
}

/// The detached helper that swaps the bundle once this app has quit. A file in the work folder, run by `/bin/sh` with its
/// arguments: nothing user-typed is spliced into the script, and the tool paths are fixed (the tests swap them for stubs).
public enum AppUpdateHelper {
    public struct Tools: Equatable, Sendable {
        public var ditto = "/usr/bin/ditto"
        public var hdiutil = "/usr/bin/hdiutil"
        public var open = "/usr/bin/open"
        public var xattr = "/usr/bin/xattr"
        public init() {}
    }

    /// `$1` pid to wait for · `$2` the new app (inside the image) · `$3` the bundle to replace · `$4` the mount point · `$5` the
    /// work folder (removed last) · `$6` the log file. Waits at most `waitSeconds` for the pid; the swap is a sibling copy
    /// then two renames, so the old bundle is back in place if anything fails, and the app is reopened either way.
    public static func script(tools: Tools = Tools(), waitSeconds: Int = 600) -> String {
        """
        #!/bin/sh
        # ReviewGate update helper — written by the app (Core AppUpdateHelper, docs/PROTOCOL.md §48), run once, detached.
        trap '' HUP INT
        pid="$1"; src="$2"; dest="$3"; mnt="$4"; work="$5"; log="$6"
        say() { printf '%s update: %s\\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log" 2>/dev/null; }
        detach() { \(tools.hdiutil) detach "$mnt" -quiet >> "$log" 2>&1 || \(tools.hdiutil) detach "$mnt" -force -quiet >> "$log" 2>&1; }
        say "waiting for ReviewGate (pid $pid) to quit"
        i=0
        while /bin/kill -0 "$pid" 2>/dev/null; do
          i=$((i + 1))
          if [ "$i" -gt \(waitSeconds * 5) ]; then
            say "pid $pid still running after \(waitSeconds) s — nothing replaced"
            detach; /bin/rm -rf "$work"; exit 1
          fi
          /bin/sleep 0.2
        done
        parent="$(/usr/bin/dirname "$dest")"; name="$(/usr/bin/basename "$dest")"
        staging="$parent/.$name.update-$$"; old="$parent/.$name.old-$$"
        ok=0
        if \(tools.ditto) "$src" "$staging" >> "$log" 2>&1; then
          if /bin/mv "$dest" "$old" >> "$log" 2>&1; then
            if /bin/mv "$staging" "$dest" >> "$log" 2>&1; then
              ok=1
              /bin/rm -rf "$old"
            else
              /bin/mv "$old" "$dest" >> "$log" 2>&1
            fi
          fi
        fi
        [ -e "$staging" ] && /bin/rm -rf "$staging"
        detach
        if [ "$ok" = 1 ]; then
          \(tools.xattr) -dr com.apple.quarantine "$dest" >> "$log" 2>&1
          say "installed $dest"
        else
          say "could not replace $dest — reopening the previous version"
        fi
        \(tools.open) "$dest" >> "$log" 2>&1
        /bin/rm -rf "$work"
        exit 0
        """
    }

    public static func arguments(pid: Int32, prepared: PreparedUpdate, bundlePath: String, log: URL) -> [String] {
        [String(pid), prepared.newApp.path, bundlePath, prepared.mountPoint.path, prepared.workDirectory.path, log.path]
    }

    /// Writes the script into the work folder and starts it (`/bin/sh <script> <arguments>`), not waiting for it. The
    /// returned process is the helper: the app terminates it if the quit is cancelled.
    public static func launch(_ prepared: PreparedUpdate, bundlePath: String, log: URL, tools: Tools = Tools(),
                              pid: Int32 = ProcessInfo.processInfo.processIdentifier) throws -> Process {
        let file = prepared.workDirectory.appendingPathComponent("install-update.sh")
        try script(tools: tools).write(to: file, atomically: true, encoding: .utf8)
        try? FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sh")
        helper.arguments = [file.path] + arguments(pid: pid, prepared: prepared, bundlePath: bundlePath, log: log)
        helper.standardInput = FileHandle.nullDevice
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = FileHandle.nullDevice
        try helper.run()
        return helper
    }
}

// MARK: - Words

public extension AppUpdateText {
    static func step(_ step: AppUpdateStep, version: String) -> String {
        switch step {
        case .downloading: String(localized: "Downloading ReviewGate \(version)…", bundle: .module)
        case .verifyingDownload: String(localized: "Checking the download's checksum…", bundle: .module)
        case .mounting: String(localized: "Opening the disk image…", bundle: .module)
        case .verifyingApp: String(localized: "Checking the new app's signature and version…", bundle: .module)
        }
    }

    static func waitingForClaude(version: String, windows: Int) -> String {
        if windows > 1 {
            return String(localized: "ReviewGate \(version) is ready. Claude is working in \(windows) windows — ReviewGate restarts when they finish.", bundle: .module)
        }
        return String(localized: "ReviewGate \(version) is ready. Claude is working — ReviewGate restarts when the turn finishes.", bundle: .module)
    }

    static func restarting(_ version: String) -> String {
        String(localized: "Restarting into ReviewGate \(version)…", bundle: .module)
    }

    static func installFailedTitle(_ version: String) -> String {
        String(localized: "Could not install ReviewGate \(version)", bundle: .module)
    }

    static var restartCancelled: String {
        String(localized: "The restart was cancelled, so nothing was installed.", bundle: .module)
    }

    static func refusal(_ refusal: UpdateRefusal) -> String {
        switch refusal {
        case .notInstallable:
            String(localized: "The release has no ReviewGate DMG with its checksum to install.", bundle: .module)
        case .runsFromDiskImage:
            String(localized: "ReviewGate runs from a disk image or a temporary copy. Move it to the Applications folder first — the update replaces the app where it is.", bundle: .module)
        case .folderNotWritable(let folder):
            String(localized: "ReviewGate cannot write to \(folder). Install the update by hand.", bundle: .module)
        case .downloadFailed(let message):
            String(localized: "The download failed: \(message)", bundle: .module)
        case .checksumMissing:
            String(localized: "The release's checksum file is missing or unreadable — nothing was installed.", bundle: .module)
        case .checksumMismatch:
            String(localized: "The download does not match its checksum — nothing was installed.", bundle: .module)
        case .mountFailed(let message):
            String(localized: "The disk image could not be opened: \(message)", bundle: .module)
        case .appMissing:
            String(localized: "The disk image has no ReviewGate app — nothing was installed.", bundle: .module)
        case .signatureInvalid(let message):
            String(localized: "The new app's signature is not valid (\(message)) — nothing was installed.", bundle: .module)
        case .runningAppUnsigned:
            String(localized: "This copy of ReviewGate has no team signature, so the new one cannot be checked against it. Install the update by hand.", bundle: .module)
        case let .teamMismatch(running, new):
            String(localized: "The new app is signed by another team (\(new ?? "none")) than this one (\(running)) — nothing was installed.", bundle: .module)
        case let .versionMismatch(expected, found):
            String(localized: "The new app says it is \(found ?? "?"), not \(expected) — nothing was installed.", bundle: .module)
        case let .bundleMismatch(expected, found):
            String(localized: "The disk image holds another app (\(found ?? "?")) than \(expected) — nothing was installed.", bundle: .module)
        case .helperFailed(let message):
            String(localized: "The installer could not start: \(message)", bundle: .module)
        }
    }
}
