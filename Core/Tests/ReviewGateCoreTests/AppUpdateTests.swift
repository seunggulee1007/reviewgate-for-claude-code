import Foundation
import Testing
@testable import ReviewGateCore

/// app-update (docs/PROTOCOL.md §48): the version compare, the `releases/latest` reply, the check's outcomes, the closed
/// banner, the checksum, the signature / team / version gate, the "Claude is working → do not restart" decision, the
/// install pipeline and the restart helper. Every program is a fake (or a stub in a temporary folder): no network, nothing
/// outside the test's own folders.
@Suite struct AppUpdateTests {
    private func v(_ s: String) -> SemanticVersion { SemanticVersion(s)! }

    // MARK: - Versions

    @Test func parsesVersionsAndTags() {
        #expect(SemanticVersion("0.5.5") == SemanticVersion(major: 0, minor: 5, patch: 5))
        #expect(SemanticVersion("v0.5.5") == SemanticVersion(major: 0, minor: 5, patch: 5))
        #expect(SemanticVersion(" 1.2.3\n") == SemanticVersion(major: 1, minor: 2, patch: 3))
        #expect(SemanticVersion("1.0.0-beta.2")?.prerelease == ["beta", "2"])
        #expect(SemanticVersion("1.0.0+42") == SemanticVersion(major: 1, minor: 0, patch: 0))   // build metadata ignored
        #expect(SemanticVersion("1.0.0-beta.2")?.description == "1.0.0-beta.2")
        for bad in ["", "0.5", "0.5.5.1", "latest", "v", "1.x.0", "1.0.0-", "1.0.0-a..b", "-1.0.0", "１.0.0"] {
            #expect(SemanticVersion(bad) == nil, "\(bad)")
        }
    }

    @Test func comparesSemantically() {
        #expect(v("0.5.10") > v("0.5.9"))   // by number, not by text
        #expect(v("0.10.0") > v("0.9.99"))
        #expect(v("1.0.0") > v("0.99.99"))
        #expect(v("v0.5.5") == v("0.5.5"))
        #expect(!(v("0.5.5") < v("0.5.5")))
        // pre-releases: below their release, numeric below alphanumeric, a longer list above its prefix
        #expect(v("1.0.0-alpha") < v("1.0.0"))
        #expect(v("1.0.0-alpha") < v("1.0.0-alpha.1"))
        #expect(v("1.0.0-alpha.1") < v("1.0.0-alpha.beta"))
        #expect(v("1.0.0-beta.2") < v("1.0.0-beta.11"))
        #expect(v("1.0.0-rc.1") < v("1.0.0"))
        #expect(v("1.0.0") > v("1.0.0-rc.1"))
        #expect(v("0.9.0") < v("1.0.0-alpha"))
    }

    // MARK: - The release reply

    static let releaseJSON = """
    {
      "url": "https://api.github.com/repos/seunggulee1007/reviewgate-for-claude-code/releases/1",
      "html_url": "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/tag/v0.5.5",
      "tag_name": "v0.5.5",
      "name": "ReviewGate 0.5.5",
      "draft": false,
      "prerelease": false,
      "published_at": "2026-11-02T09:30:00Z",
      "body": "- fix(app): one\\n- feat(engine): two",
      "assets": [
        {"name": "ReviewGate-0.5.5.dmg", "size": 31457280, "digest": "sha256:ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
         "browser_download_url": "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/download/v0.5.5/ReviewGate-0.5.5.dmg"},
        {"name": "ReviewGate-0.5.5.dmg.sha256", "size": 87, "digest": null},
        {"name": "notes.txt", "size": 3}
      ]
    }
    """

    @Test func parsesTheLatestRelease() throws {
        let release = try AppRelease.parse(Data(Self.releaseJSON.utf8))
        #expect(release.tag == "v0.5.5")
        #expect(release.version == v("0.5.5"))
        #expect(release.title == "ReviewGate 0.5.5")
        #expect(release.notes == "- fix(app): one\n- feat(engine): two")
        #expect(release.page?.absoluteString == "https://github.com/seunggulee1007/reviewgate-for-claude-code/releases/tag/v0.5.5")
        #expect(release.publishedAt == ISO8601DateFormatter().date(from: "2026-11-02T09:30:00Z"))
        #expect(release.assets.count == 3)
        #expect(release.dmg == AppRelease.Asset(name: "ReviewGate-0.5.5.dmg", size: 31457280,
                                                sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"))
        #expect(release.checksum?.name == "ReviewGate-0.5.5.dmg.sha256")
        #expect(release.checksum?.sha256 == nil)
        #expect(release.isInstallable)
    }

    @Test func refusesWhatIsNotAPublishedVersion() {
        func parse(_ json: String) -> AppRelease.ParseError? {
            do { _ = try AppRelease.parse(Data(json.utf8)); return nil } catch { return error as? AppRelease.ParseError }
        }
        #expect(parse("not json") == .notJSON)
        #expect(parse("[1, 2]") == .notJSON)
        #expect(parse(#"{"name": "x"}"#) == .missingTag)
        #expect(parse(#"{"tag_name": "nightly"}"#) == .badTag("nightly"))
        #expect(parse(#"{"tag_name": "v0.6.0", "draft": true}"#) == .notAPublishedRelease)
        #expect(parse(#"{"tag_name": "v0.6.0-beta.1", "prerelease": true}"#) == .notAPublishedRelease)
        // no assets: readable, but not installable from the app
        let bare = try? AppRelease.parse(Data(#"{"tag_name": "v0.6.0", "body": null}"#.utf8))
        #expect(bare?.version == v("0.6.0"))
        #expect(bare?.notes == "")
        #expect(bare?.isInstallable == false)
        // a DMG of another version is not this release's
        let other = AppRelease(tag: "v0.6.0", version: v("0.6.0"), assets: [.init(name: "ReviewGate-0.5.9.dmg", size: 1),
                                                                         .init(name: "ReviewGate-0.5.9.dmg.sha256", size: 1)])
        #expect(other.dmg == nil)
        #expect(!other.isInstallable)
    }

    // MARK: - The check

    final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [[String]] = []
        func add(_ exe: String, _ args: [String]) { lock.lock(); list.append([exe] + args); lock.unlock() }
        var all: [[String]] { lock.lock(); defer { lock.unlock() }; return list }
    }

    private func output(_ stdout: String = "", stderr: String = "", status: Int32 = 0) -> CommandRunner.Output {
        CommandRunner.Output(stdout: Data(stdout.utf8), stderr: Data(stderr.utf8), status: status)
    }

    @Test func checkComparesWithTheRunningVersion() async {
        let calls = Calls()
        let reply = output(Self.releaseJSON)
        let run: UpdateRun = { exe, args, _ in calls.add(exe, args); return reply }
        let newer = await AppUpdateChecker.check(currentVersion: "0.5.4", ghPath: "/opt/homebrew/bin/gh", run: run)
        guard case .available(let release) = newer else { Issue.record("expected available, got \(newer)"); return }
        #expect(release.tag == "v0.5.5")
        #expect(calls.all.first == ["/opt/homebrew/bin/gh", "api", "--hostname", "github.com", "repos/seunggulee1007/reviewgate-for-claude-code/releases/latest"])
        #expect(await AppUpdateChecker.check(currentVersion: "0.5.5", ghPath: "/gh", run: run) == .upToDate(current: "0.5.5", latest: "0.5.5"))
        // a local build ahead of the release is "up to date" too
        #expect(await AppUpdateChecker.check(currentVersion: "0.6.0", ghPath: "/gh", run: run) == .upToDate(current: "0.6.0", latest: "0.5.5"))
        #expect(await AppUpdateChecker.check(currentVersion: "dev", ghPath: "/gh", run: run)
                == .unavailable(.badReply("running version dev is not x.y.z")))
    }

    @Test func checkSaysWhyItFoundNothing() async {
        func check(_ out: CommandRunner.Output) async -> UpdateCheckOutcome {
            await AppUpdateChecker.check(currentVersion: "0.5.4", ghPath: "/gh", run: { _, _, _ in out })
        }
        #expect(await AppUpdateChecker.check(currentVersion: "0.5.4", ghPath: nil, run: { _, _, _ in self.output() })
                == .unavailable(.ghMissing))
        #expect(await AppUpdateChecker.check(currentVersion: "0.5.4", ghPath: "/gone/gh", run: { exe, _, _ in
            throw CommandRunner.Failure(exe: exe, reason: "No such file")
        }) == .unavailable(.ghMissing))
        #expect(await check(output(stderr: "To get started with GitHub CLI, please run:  gh auth login\n", status: 4)) == .unavailable(.notLoggedIn))
        #expect(await check(output(#"{"message":"Not Found","status":"404"}"#, stderr: "gh: Not Found (HTTP 404)\n", status: 1))
                == .unavailable(.noRelease))
        #expect(await check(output(stderr: "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n", status: 1))
                == .unavailable(.offline))
        #expect(await check(output(status: SIGTERM)) == .unavailable(.offline))   // the runner's timeout
        #expect(await check(output(stderr: "gh: Server Error (HTTP 502)\n", status: 1)) == .unavailable(.failed("gh: Server Error (HTTP 502)")))
        #expect(await check(output("<html>", status: 0)) == .unavailable(.badReply("not a JSON object")))
    }

    @Test func classifiesGhFailures() {
        #expect(UpdateCheckProblem.classify(status: 1, stderr: "gh: Bad credentials (HTTP 401)") == .notLoggedIn)
        #expect(UpdateCheckProblem.classify(status: 1, stderr: "dial tcp: lookup api.github.com: no such host") == .offline)
        #expect(UpdateCheckProblem.classify(status: 1, stderr: "Post \"https://api.github.com/graphql\": net/http: TLS handshake timeout") == .offline)
        #expect(UpdateCheckProblem.classify(status: 7, stderr: "") == .failed("gh exited with status 7"))
    }

    @Test func findsGh() {
        let present: Set<String> = ["/engine/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/custom/bin/gh"]
        let exists = { (p: String) in present.contains(p) }
        #expect(UpdateGHLocator.resolve(engineGh: "/engine/gh", loginPATH: "/custom/bin", isExecutable: exists) == "/engine/gh")
        #expect(UpdateGHLocator.resolve(engineGh: nil, loginPATH: "relative:/custom/bin:/usr/bin", isExecutable: exists) == "/custom/bin/gh")
        #expect(UpdateGHLocator.resolve(engineGh: "/stale/gh", loginPATH: "/usr/bin", isExecutable: exists) == "/opt/homebrew/bin/gh")
        #expect(UpdateGHLocator.resolve(engineGh: nil, loginPATH: nil, isExecutable: { _ in false }) == nil)
    }

    // MARK: - The closed banner

    private func defaults() -> UserDefaults { UserDefaults(suiteName: "AppUpdateTests.\(UUID().uuidString)")! }

    @Test func aClosedVersionStaysClosed() {
        let d = defaults()
        let release = AppRelease(tag: "v0.5.5", version: v("0.5.5"))
        #expect(AppSettings.checkForUpdatesAutomatically(defaults: d))   // unset → on
        AppSettings.setCheckForUpdatesAutomatically(false, defaults: d)
        #expect(!AppSettings.checkForUpdatesAutomatically(defaults: d))

        #expect(AppUpdateBanner.shows(release, currentVersion: "0.5.4", dismissed: AppSettings.dismissedUpdateVersion(defaults: d)))
        AppSettings.dismissUpdate(v("0.5.5"), defaults: d)
        #expect(AppSettings.dismissedUpdateVersion(defaults: d) == v("0.5.5"))
        #expect(!AppUpdateBanner.shows(release, currentVersion: "0.5.4", dismissed: AppSettings.dismissedUpdateVersion(defaults: d)))
        // a newer release shows again
        let next = AppRelease(tag: "v0.5.6", version: v("0.5.6"))
        #expect(AppUpdateBanner.shows(next, currentVersion: "0.5.4", dismissed: AppSettings.dismissedUpdateVersion(defaults: d)))
        // closing an older one never lowers the mark
        AppSettings.dismissUpdate(v("0.5.3"), defaults: d)
        #expect(AppSettings.dismissedUpdateVersion(defaults: d) == v("0.5.5"))
        // "Check for Updates…" brings it back
        AppSettings.clearDismissedUpdate(defaults: d)
        #expect(AppUpdateBanner.shows(release, currentVersion: "0.5.4", dismissed: AppSettings.dismissedUpdateVersion(defaults: d)))
        // never for the running version or older, nor without a release
        #expect(!AppUpdateBanner.shows(release, currentVersion: "0.5.5", dismissed: nil))
        #expect(!AppUpdateBanner.shows(nil, currentVersion: "0.5.4", dismissed: nil))
    }

    // MARK: - Checksum

    private func tempDir() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("AppUpdateTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private static let helloSHA = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"   // sha256("hello\n")

    @Test func checksTheDownloadAgainstItsChecksum() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("ReviewGate-0.5.5.dmg")
        try Data("hello\n".utf8).write(to: file)
        let actual = try UpdateChecksum.sha256(of: file)
        #expect(actual == Self.helloSHA)

        let name = "ReviewGate-0.5.5.dmg"
        #expect(UpdateChecksum.expected(in: "\(Self.helloSHA)  ReviewGate-0.5.5.dmg\n", for: name) == Self.helloSHA)
        #expect(UpdateChecksum.expected(in: Self.helloSHA.uppercased(), for: name) == Self.helloSHA)
        #expect(UpdateChecksum.expected(in: "\(Self.helloSHA) *build/dist/ReviewGate-0.5.5.dmg", for: name) == Self.helloSHA)
        #expect(UpdateChecksum.expected(in: "\(Self.helloSHA)  ReviewGate-0.5.4.dmg", for: name) == nil)   // another file's
        #expect(UpdateChecksum.expected(in: "deadbeef  ReviewGate-0.5.5.dmg", for: name) == nil)
        #expect(UpdateChecksum.expected(in: "", for: name) == nil)

        #expect(UpdateChecksum.check(actual: actual, checksumFile: "\(Self.helloSHA)  \(name)\n", fileName: name, assetDigest: nil) == nil)
        #expect(UpdateChecksum.check(actual: actual, checksumFile: "\(Self.helloSHA)  \(name)\n", fileName: name, assetDigest: Self.helloSHA) == nil)
        let other = String(repeating: "0", count: 64)
        #expect(UpdateChecksum.check(actual: actual, checksumFile: "\(other)  \(name)\n", fileName: name, assetDigest: nil) == .checksumMismatch)
        #expect(UpdateChecksum.check(actual: actual, checksumFile: "\(Self.helloSHA)  \(name)\n", fileName: name, assetDigest: other) == .checksumMismatch)
        #expect(UpdateChecksum.check(actual: actual, checksumFile: nil, fileName: name, assetDigest: Self.helloSHA) == .checksumMissing)
        #expect(UpdateChecksum.check(actual: actual, checksumFile: "garbage", fileName: name, assetDigest: nil) == .checksumMissing)
    }

    // MARK: - Signature, team, version

    @Test func readsTheTeamIdentifier() {
        let signed = """
        Executable=/Volumes/ReviewGate 0.5.5/ReviewGate.app/Contents/MacOS/ReviewGate
        Identifier=io.github.seunggulee1007.reviewgate
        Authority=Apple Development: Someone (ABCDE12345)
        TeamIdentifier=QW7DJ7FBDT
        """
        #expect(UpdateCodeSign.teamIdentifier(fromDisplayOutput: signed) == "QW7DJ7FBDT")
        #expect(UpdateCodeSign.teamIdentifier(fromDisplayOutput: "Signature=adhoc\nTeamIdentifier=not set\n") == nil)
        #expect(UpdateCodeSign.teamIdentifier(fromDisplayOutput: "code object is not signed at all") == nil)
    }

    @Test func gatesTheNewApp() {
        let good = UpdateAppFacts(signatureValid: true, teamIdentifier: "QW7DJ7FBDT", shortVersion: "0.5.5",
                                  bundleIdentifier: "io.github.seunggulee1007.reviewgate")
        func gate(_ facts: UpdateAppFacts, running: String? = "QW7DJ7FBDT", expected: String = "0.5.5") -> UpdateRefusal? {
            UpdateCodeSign.gate(new: facts, runningTeam: running, runningBundleID: "io.github.seunggulee1007.reviewgate", expected: v(expected))
        }
        #expect(gate(good) == nil)
        var broken = good
        broken.signatureValid = false
        broken.signatureMessage = "a sealed resource is missing or invalid"
        #expect(gate(broken) == .signatureInvalid("a sealed resource is missing or invalid"))
        #expect(gate(good, running: nil) == .runningAppUnsigned)
        var stranger = good
        stranger.teamIdentifier = "ZZZZZZZZZZ"
        #expect(gate(stranger) == .teamMismatch(running: "QW7DJ7FBDT", new: "ZZZZZZZZZZ"))
        var adhoc = good
        adhoc.teamIdentifier = nil
        #expect(gate(adhoc) == .teamMismatch(running: "QW7DJ7FBDT", new: nil))
        // a DMG packaged from a stale build says another version than its tag
        #expect(gate(good, expected: "0.5.6") == .versionMismatch(expected: "0.5.6", found: "0.5.5"))
        var unversioned = good
        unversioned.shortVersion = nil
        #expect(gate(unversioned) == .versionMismatch(expected: "0.5.5", found: nil))
        var otherApp = good
        otherApp.bundleIdentifier = "com.example.Other"
        #expect(gate(otherApp) == .bundleMismatch(expected: "io.github.seunggulee1007.reviewgate", found: "com.example.Other"))
    }

    @Test func replacesOnlyALastingWritableBundle() {
        let notBoot: (String) -> Bool = { _ in false }
        #expect(UpdateLocation.check(bundlePath: "/Applications/ReviewGate.app", isWritable: { _ in true }, isBootVolume: notBoot) == nil)
        #expect(UpdateLocation.check(bundlePath: "/Applications/ReviewGate.app", isWritable: { _ in false }, isBootVolume: notBoot)
                == .folderNotWritable("/Applications"))
        #expect(UpdateLocation.check(bundlePath: "/Volumes/ReviewGate 0.5.4/ReviewGate.app", isWritable: { _ in true }, isBootVolume: notBoot)
                == .runsFromDiskImage)
        #expect(UpdateLocation.check(bundlePath: "/private/var/folders/x/T/AppTranslocation/1/d/ReviewGate.app", isWritable: { _ in true },
                                     isBootVolume: notBoot) == .runsFromDiskImage)
    }

    // MARK: - Claude working → no restart

    @Test func neverRestartsWhileClaudeWorksOrWaits() {
        #expect(UpdateRestartGate.decide([]) == .restartNow)   // no window at all
        #expect(UpdateRestartGate.decide([nil, nil]) == .restartNow)
        #expect(UpdateRestartGate.decide([nil, .working]) == .wait(windows: 1))
        #expect(UpdateRestartGate.decide([.waiting, nil, .working]) == .wait(windows: 2))
        #expect(AppUpdateText.waitingForClaude(version: "0.5.5", windows: 2)
                == "ReviewGate 0.5.5 is ready. Claude is working in 2 windows — ReviewGate restarts when they finish.")
        #expect(AppUpdateText.waitingForClaude(version: "0.5.5", windows: 1)
                == "ReviewGate 0.5.5 is ready. Claude is working — ReviewGate restarts when the turn finishes.")
    }

    // MARK: - The pipeline (fake gh / hdiutil / codesign)

    /// Plays gh (writes the assets), hdiutil (makes the mounted app) and codesign (the answers given) in a temporary folder.
    final class FakeTools: @unchecked Sendable {
        let calls = Calls()
        var dmgBytes = Data("hello\n".utf8)
        var checksumText = "\(AppUpdateTests.helloSHA)  ReviewGate-0.5.5.dmg\n"
        var downloadStatus: Int32 = 0
        var appVersion = "0.5.5"
        var newTeam = "QW7DJ7FBDT"
        var verifyStatus: Int32 = 0

        var run: UpdateRun {
            { [self] exe, args, _ in
                calls.add(exe, args)
                switch (exe as NSString).lastPathComponent {
                case "gh":
                    guard downloadStatus == 0, let dir = args.firstIndex(of: "-D").map({ args[$0 + 1] }) else {
                        return CommandRunner.Output(stdout: Data(), stderr: Data("HTTP 404: Not Found\n".utf8), status: downloadStatus)
                    }
                    try dmgBytes.write(to: URL(fileURLWithPath: dir).appendingPathComponent("ReviewGate-0.5.5.dmg"))
                    try Data(checksumText.utf8).write(to: URL(fileURLWithPath: dir).appendingPathComponent("ReviewGate-0.5.5.dmg.sha256"))
                    return CommandRunner.Output(stdout: Data(), stderr: Data(), status: 0)
                case "hdiutil" where args.first == "attach":
                    let mount = URL(fileURLWithPath: args[args.firstIndex(of: "-mountpoint")! + 1])
                    let contents = mount.appendingPathComponent("ReviewGate.app/Contents", isDirectory: true)
                    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
                    let info: [String: Any] = ["CFBundleShortVersionString": appVersion, "CFBundleIdentifier": "io.github.seunggulee1007.reviewgate"]
                    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
                        .write(to: contents.appendingPathComponent("Info.plist"))
                    return CommandRunner.Output(stdout: Data(), stderr: Data(), status: 0)
                case "codesign" where args.first == "--verify":
                    return CommandRunner.Output(stdout: Data(), stderr: Data("invalid signature\n".utf8), status: verifyStatus)
                case "codesign":
                    let team = args.last?.hasPrefix("/Applications") == true ? "QW7DJ7FBDT" : newTeam
                    return CommandRunner.Output(stdout: Data(), stderr: Data("Identifier=x\nTeamIdentifier=\(team)\n".utf8), status: 0)
                default:
                    return CommandRunner.Output(stdout: Data(), stderr: Data(), status: 0)
                }
            }
        }

        var programs: [String] { calls.all.map { ($0[0] as NSString).lastPathComponent + " " + $0[1] } }
    }

    private let release = AppRelease(tag: "v0.5.5", version: SemanticVersion("0.5.5")!, assets: [
        .init(name: "ReviewGate-0.5.5.dmg", size: 6), .init(name: "ReviewGate-0.5.5.dmg.sha256", size: 87),
    ])

    private func context(_ tools: FakeTools, temp: URL) -> AppUpdateContext {
        AppUpdateContext(ghPath: "/opt/homebrew/bin/gh", run: tools.run, bundlePath: "/Applications/ReviewGate.app",
                         bundleIdentifier: "io.github.seunggulee1007.reviewgate", temporaryDirectory: temp,
                         isWritable: { _ in true }, isBootVolume: { _ in false })
    }

    final class Steps: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [AppUpdateStep] = []
        func add(_ s: AppUpdateStep) { lock.lock(); list.append(s); lock.unlock() }
        var all: [AppUpdateStep] { lock.lock(); defer { lock.unlock() }; return list }
    }

    @Test func preparesAVerifiedImage() async throws {
        let temp = try tempDir()
        defer { try? FileManager.default.removeItem(at: temp) }
        let tools = FakeTools()
        let steps = Steps()
        let result = await AppUpdateInstaller.prepare(release, context: context(tools, temp: temp)) { steps.add($0) }
        guard case .success(let prepared) = result else { Issue.record("expected success, got \(result)"); return }
        #expect(steps.all == [.downloading, .verifyingDownload, .mounting, .verifyingApp])
        #expect(prepared.version == v("0.5.5"))
        #expect(prepared.newApp == prepared.mountPoint.appendingPathComponent("ReviewGate.app"))
        #expect(prepared.workDirectory.deletingLastPathComponent().standardizedFileURL == temp.standardizedFileURL)
        let download = tools.calls.all[0]
        #expect(Array(download.dropFirst().prefix(7)) == ["release", "download", "v0.5.5", "--repo", "github.com/seunggulee1007/reviewgate-for-claude-code",
                                                          "-p", "ReviewGate-*.dmg*"])
        #expect(tools.calls.all[1].contains("-readonly") && tools.calls.all[1].contains("-nobrowse"))
        #expect(tools.programs == ["gh release", "hdiutil attach", "codesign --verify", "codesign -dv", "codesign -dv"])

        await AppUpdateInstaller.discard(prepared, context: context(tools, temp: temp))
        #expect(tools.programs.last == "hdiutil detach")
        #expect(!FileManager.default.fileExists(atPath: prepared.workDirectory.path))
    }

    @Test func aBadChecksumNeverMounts() async throws {
        let temp = try tempDir()
        defer { try? FileManager.default.removeItem(at: temp) }
        let tools = FakeTools()
        tools.dmgBytes = Data("tampered\n".utf8)
        let result = await AppUpdateInstaller.prepare(release, context: context(tools, temp: temp)) { _ in }
        #expect(result == .failure(.checksumMismatch))
        #expect(tools.programs == ["gh release"])
        #expect(try FileManager.default.contentsOfDirectory(atPath: temp.path).isEmpty)   // the work folder is gone
    }

    @Test func aRefusedAppIsDetachedAndRemoved() async throws {
        for (setup, expected) in [
            ({ (t: FakeTools) in t.newTeam = "ZZZZZZZZZZ" }, UpdateRefusal.teamMismatch(running: "QW7DJ7FBDT", new: "ZZZZZZZZZZ")),
            ({ (t: FakeTools) in t.appVersion = "0.5.4" }, UpdateRefusal.versionMismatch(expected: "0.5.5", found: "0.5.4")),
            ({ (t: FakeTools) in t.verifyStatus = 1 }, UpdateRefusal.signatureInvalid("invalid signature")),
        ] {
            let temp = try tempDir()
            defer { try? FileManager.default.removeItem(at: temp) }
            let tools = FakeTools()
            setup(tools)
            let result = await AppUpdateInstaller.prepare(release, context: context(tools, temp: temp)) { _ in }
            #expect(result == .failure(expected))
            #expect(tools.programs.last == "hdiutil detach")
            #expect(try FileManager.default.contentsOfDirectory(atPath: temp.path).isEmpty)
        }
    }

    @Test func refusesBeforeDownloading() async throws {
        let temp = try tempDir()
        defer { try? FileManager.default.removeItem(at: temp) }
        let tools = FakeTools()
        let bare = AppRelease(tag: "v0.5.5", version: v("0.5.5"))
        #expect(await AppUpdateInstaller.prepare(bare, context: context(tools, temp: temp)) { _ in } == .failure(.notInstallable))
        var fromImage = context(tools, temp: temp)
        fromImage.bundlePath = "/Volumes/ReviewGate 0.5.4/ReviewGate.app"
        #expect(await AppUpdateInstaller.prepare(release, context: fromImage) { _ in } == .failure(.runsFromDiskImage))
        tools.downloadStatus = 1
        #expect(await AppUpdateInstaller.prepare(release, context: context(tools, temp: temp)) { _ in } == .failure(.downloadFailed("HTTP 404: Not Found")))
        #expect(tools.programs == ["gh release"])
    }

    // MARK: - The restart helper (run for real with stub tools, in a temporary folder)

    /// A process that has exited: the helper finds no pid to wait for.
    private func deadPid() throws -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try p.run()
        p.waitUntilExit()
        return p.processIdentifier
    }

    private func runHelper(src: URL, dest: URL, root: URL) throws -> (opened: String, log: String) {
        let fm = FileManager.default
        let work = root.appendingPathComponent("work", isDirectory: true)
        let mount = root.appendingPathComponent("mnt", isDirectory: true)
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        let openLog = root.appendingPathComponent("opened.txt")
        let openStub = root.appendingPathComponent("open-stub.sh")
        try "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '\(openLog.path)'\n".write(to: openStub, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: openStub.path)
        var tools = AppUpdateHelper.Tools()
        tools.hdiutil = "/usr/bin/true"
        tools.xattr = "/usr/bin/true"
        tools.open = openStub.path
        let script = work.appendingPathComponent("install-update.sh")
        try AppUpdateHelper.script(tools: tools, waitSeconds: 5).write(to: script, atomically: true, encoding: .utf8)
        let prepared = PreparedUpdate(version: v("0.5.5"), workDirectory: work, mountPoint: mount, newApp: src)
        let log = root.appendingPathComponent("update.log")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [script.path] + AppUpdateHelper.arguments(pid: try deadPid(), prepared: prepared, bundlePath: dest.path, log: log)
        try p.run()
        p.waitUntilExit()
        #expect(p.terminationStatus == 0)
        #expect(!fm.fileExists(atPath: work.path))   // the work folder (and the script) removed
        return ((try? String(contentsOf: openLog, encoding: .utf8)) ?? "", (try? String(contentsOf: log, encoding: .utf8)) ?? "")
    }

    @Test func theHelperSwapsTheBundleAndReopensIt() throws {
        let fm = FileManager.default
        let root = try tempDir()
        defer { try? fm.removeItem(at: root) }
        let apps = root.appendingPathComponent("Applications", isDirectory: true)
        let dest = apps.appendingPathComponent("ReviewGate.app", isDirectory: true)
        let src = root.appendingPathComponent("mnt/ReviewGate.app", isDirectory: true)
        try fm.createDirectory(at: dest.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        try Data("old".utf8).write(to: dest.appendingPathComponent("Contents/old-only"))
        try fm.createDirectory(at: src.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        try Data("new".utf8).write(to: src.appendingPathComponent("Contents/new-only"))

        let (opened, log) = try runHelper(src: src, dest: dest, root: root)
        #expect(fm.fileExists(atPath: dest.appendingPathComponent("Contents/new-only").path))
        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("Contents/old-only").path))   // replaced, not merged
        #expect(try fm.contentsOfDirectory(atPath: apps.path) == ["ReviewGate.app"])   // no staging / old copy left
        #expect(opened == dest.path + "\n")
        #expect(log.contains("installed"))
    }

    @Test func aFailedSwapKeepsTheOldBundleAndReopensIt() throws {
        let fm = FileManager.default
        let root = try tempDir()
        defer { try? fm.removeItem(at: root) }
        let apps = root.appendingPathComponent("Applications", isDirectory: true)
        let dest = apps.appendingPathComponent("ReviewGate.app", isDirectory: true)
        try fm.createDirectory(at: dest.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        try Data("old".utf8).write(to: dest.appendingPathComponent("Contents/old-only"))

        let missing = root.appendingPathComponent("mnt/ReviewGate.app")   // ditto has nothing to copy
        let (opened, log) = try runHelper(src: missing, dest: dest, root: root)
        #expect(fm.fileExists(atPath: dest.appendingPathComponent("Contents/old-only").path))
        #expect(try fm.contentsOfDirectory(atPath: apps.path) == ["ReviewGate.app"])
        #expect(opened == dest.path + "\n")
        #expect(log.contains("reopening the previous version"))
    }

    /// Opt-in, local only: a DMG made by `scripts/release.sh` (its `.sha256` beside it) through the real hdiutil, codesign
    /// and ditto — only `gh` is played (it copies the two files) and `open` is a stub. The running app compared with is
    /// `RG_UPDATE_RUNNING_APP` (a signed build). `RG_UPDATE_DMG=build/dist/ReviewGate-X.Y.Z.dmg
    /// RG_UPDATE_RUNNING_APP=build/Build/Products/Release/ReviewGate.app swift test --filter realImage`.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["RG_UPDATE_DMG"] != nil))
    func realImagePassesTheGatesAndTheHelperInstallsIt() async throws {
        let env = ProcessInfo.processInfo.environment
        let dmg = URL(fileURLWithPath: try #require(env["RG_UPDATE_DMG"]))
        let running = try #require(env["RG_UPDATE_RUNNING_APP"])
        let name = dmg.lastPathComponent
        let version = try #require(SemanticVersion(String(name.dropFirst("ReviewGate-".count).dropLast(".dmg".count))))
        let release = AppRelease(tag: "v\(version)", version: version, assets: [.init(name: name, size: 0), .init(name: name + ".sha256", size: 0)])
        let fm = FileManager.default
        let root = try tempDir()
        defer { try? fm.removeItem(at: root) }
        let run: UpdateRun = { exe, args, timeout in
            if (exe as NSString).lastPathComponent == "gh" {
                let dir = URL(fileURLWithPath: args[args.firstIndex(of: "-D")! + 1])
                try FileManager.default.copyItem(at: dmg, to: dir.appendingPathComponent(name))
                try FileManager.default.copyItem(at: URL(fileURLWithPath: dmg.path + ".sha256"), to: dir.appendingPathComponent(name + ".sha256"))
                return CommandRunner.Output(stdout: Data(), stderr: Data(), status: 0)
            }
            return try await CommandRunner.run(exe, args, timeout: timeout)
        }
        let apps = root.appendingPathComponent("Applications", isDirectory: true)
        let dest = apps.appendingPathComponent("ReviewGate.app", isDirectory: true)
        try fm.createDirectory(at: dest.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        try Data("old".utf8).write(to: dest.appendingPathComponent("Contents/old-only"))
        let context = AppUpdateContext(ghPath: "/fake/gh", run: run, bundlePath: running,
                                       bundleIdentifier: Bundle(path: running)?.bundleIdentifier, temporaryDirectory: root,
                                       isWritable: { _ in true }, isBootVolume: { _ in false })
        let result = await AppUpdateInstaller.prepare(release, context: context) { _ in }
        guard case .success(let prepared) = result else { Issue.record("expected success, got \(result)"); return }

        // The helper, for real except `open`: ditto from the mounted image, the swap, hdiutil detach.
        let openLog = root.appendingPathComponent("opened.txt")
        let openStub = root.appendingPathComponent("open-stub.sh")
        try "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '\(openLog.path)'\n".write(to: openStub, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: openStub.path)
        var tools = AppUpdateHelper.Tools()
        tools.open = openStub.path
        let script = prepared.workDirectory.appendingPathComponent("install-update.sh")
        try AppUpdateHelper.script(tools: tools, waitSeconds: 5).write(to: script, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [script.path] + AppUpdateHelper.arguments(pid: try deadPid(), prepared: prepared, bundlePath: dest.path,
                                                                 log: root.appendingPathComponent("update.log"))
        try p.run()
        p.waitUntilExit()
        #expect(!fm.fileExists(atPath: dest.appendingPathComponent("Contents/old-only").path))
        let info = try #require(NSDictionary(contentsOf: dest.appendingPathComponent("Contents/Info.plist")))
        #expect(info["CFBundleShortVersionString"] as? String == version.description)
        let verify = try await CommandRunner.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", dest.path])
        #expect(verify.status == 0, "\(verify.stderrText)")   // the ditto copy keeps the signature whole
        #expect((try? String(contentsOf: openLog, encoding: .utf8)) == dest.path + "\n")
        #expect(!fm.fileExists(atPath: prepared.workDirectory.path))
        let mounts = try await CommandRunner.run("/sbin/mount", [])
        #expect(!mounts.stdoutText.contains(prepared.mountPoint.path))   // detached
    }

    @Test func theHelperWaitsForOnePidAndKillsNothing() {
        let script = AppUpdateHelper.script()
        #expect(script.contains("/bin/kill -0 \"$pid\""))
        for forbidden in ["pkill", "killall", "kill -9", "kill -TERM"] {
            #expect(!script.contains(forbidden), "\(forbidden)")
        }
        #expect(script.contains("/usr/bin/ditto \"$src\" \"$staging\""))
        #expect(script.contains("/usr/bin/open \"$dest\""))
    }
}
