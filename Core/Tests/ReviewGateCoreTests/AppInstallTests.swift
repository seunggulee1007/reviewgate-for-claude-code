import Foundation
import Testing
@testable import ReviewGateCore

/// wave4 w4-install: "Move to Applications" (audit robustness-13 / daily-15 / polish-13) and the recent-projects clean-up
/// (daily-17). The file operations are recorders — nothing here writes to the real /Applications.
@Suite struct AppInstallTests {
    @Test func classifiesWhereTheAppRuns() {
        let notBoot: (String) -> Bool = { _ in false }
        #expect(AppInstallLocation.classify(bundlePath: "/Volumes/ReviewGate 0.2.0 1/ReviewGate.app", isBootVolume: notBoot)
                == .diskImage(volume: "ReviewGate 0.2.0 1"))
        #expect(AppInstallLocation.classify(
            bundlePath: "/private/var/folders/x1/T/AppTranslocation/7A0B-11/d/ReviewGate.app", isBootVolume: notBoot) == .translocated)
        #expect(AppInstallLocation.classify(bundlePath: "/Applications/ReviewGate.app", isBootVolume: notBoot) == .regular)
        #expect(AppInstallLocation.classify(bundlePath: "/Users/me/Applications/ReviewGate.app", isBootVolume: notBoot) == .regular)
        #expect(AppInstallLocation.classify(bundlePath: "/Users/me/dev/build/Build/Products/Debug/ReviewGate.app", isBootVolume: notBoot) == .regular)
        // `/Volumes/Macintosh HD` is the boot disk itself — nothing to eject.
        #expect(AppInstallLocation.classify(bundlePath: "/Volumes/Macintosh HD/Applications/ReviewGate.app",
                                            isBootVolume: { $0 == "/Volumes/Macintosh HD" }) == .regular)
        #expect(AppInstallLocation.diskImage(volume: "x").shouldOfferMove)
        #expect(AppInstallLocation.translocated.shouldOfferMove)
        #expect(!AppInstallLocation.regular.shouldOfferMove)
    }

    @Test func comparesVersionsNumerically() {
        let v = { (s: String, b: String) in AppBundleVersion(short: s, build: b) }
        #expect(AppBundleVersion.compare(v("0.2.10", "700"), v("0.2.9", "800")) == .orderedDescending)
        #expect(AppBundleVersion.compare(v("0.2.3", "610"), v("0.2.3", "610")) == .orderedSame)
        #expect(AppBundleVersion.compare(v("0.2.3", "610"), v("0.2.3", "1000")) == .orderedAscending)
        #expect(AppVersionOrder.of(running: v("0.2.3", "610"), installed: v("0.2.0", "160")) == .runningIsNewer)
        #expect(AppVersionOrder.of(running: v("0.2.0", "160"), installed: v("0.2.3", "610")) == .installedIsNewer)
        #expect(AppVersionOrder.of(running: v("0.2.3", "610"), installed: nil) == .unknown)
        #expect(v("0.2.3", "610").description == "0.2.3 (610)")
        #expect(AppBundleVersion(info: ["CFBundleShortVersionString": "0.2.3", "CFBundleVersion": "610"]) == v("0.2.3", "610"))
        #expect(AppBundleVersion(info: [:]) == nil)
    }

    /// The order of the file operations and what a failure leaves behind.
    final class Recorder: @unchecked Sendable {
        var calls: [String] = []
        var existing: Set<String> = []
        var failing: Set<String> = []
        let lock = NSLock()

        func record(_ call: String) throws {
            lock.lock(); defer { lock.unlock() }
            calls.append(call)
            if failing.contains(where: { call.hasPrefix($0) }) { throw CocoaError(.fileWriteNoPermission) }
        }

        var ops: AppMoveOps {
            AppMoveOps(
                exists: { [self] in existing.contains($0) },
                version: { $0.hasPrefix("/Applications") ? AppBundleVersion(short: "0.2.0", build: "160") : AppBundleVersion(short: "0.2.3", build: "610") },
                copy: { [self] in try record("copy \($0) → \($1)") },
                trash: { [self] in try record("trash \($0)") },
                move: { [self] in try record("move \($0) → \($1)") },
                remove: { [self] in try? record("remove \($0)") },
                reopenAfterQuit: { [self] in try record("reopen \($0)") },
                quit: { [self] in try? record("quit") })
        }
    }

    private let source = "/Volumes/ReviewGate 0.2.3/ReviewGate.app"

    @Test func plansACopyOrAsksToReplace() {
        let r = Recorder()
        #expect(AppMover.plan(source: source, ops: r.ops) == .copy(destination: "/Applications/ReviewGate.app"))
        r.existing = ["/Applications/ReviewGate.app"]
        #expect(AppMover.plan(source: source, ops: r.ops) == .askReplace(
            destination: "/Applications/ReviewGate.app", installed: AppBundleVersion(short: "0.2.0", build: "160"),
            running: AppBundleVersion(short: "0.2.3", build: "610"), order: .runningIsNewer))
        #expect(r.calls.isEmpty)   // planning touches nothing
    }

    @Test func copiesThenReopensThenQuits() {
        let r = Recorder()
        let outcome = AppMover.perform(source: source, destination: "/Applications/ReviewGate.app", replace: false, ops: r.ops)
        #expect(outcome == .reopening(destination: "/Applications/ReviewGate.app"))
        #expect(r.calls == ["copy \(source) → /Applications/ReviewGate.app", "reopen /Applications/ReviewGate.app", "quit"])
    }

    @Test func replacingCopiesBesideTheInstalledAppFirst() {
        let r = Recorder()
        let outcome = AppMover.perform(source: source, destination: "/Applications/ReviewGate.app", replace: true, ops: r.ops, stagingSuffix: "S")
        #expect(outcome == .reopening(destination: "/Applications/ReviewGate.app"))
        #expect(r.calls == [
            "copy \(source) → /Applications/.ReviewGate.app.moving-S",
            "trash /Applications/ReviewGate.app",
            "move /Applications/.ReviewGate.app.moving-S → /Applications/ReviewGate.app",
            "reopen /Applications/ReviewGate.app",
            "quit",
        ])
    }

    @Test func aFailedCopyNeverQuits() {
        let r = Recorder()
        r.failing = ["copy"]
        guard case .failed(.copy, _, false) = AppMover.perform(source: source, destination: "/Applications/ReviewGate.app", replace: false, ops: r.ops) else {
            Issue.record("expected a copy failure"); return
        }
        #expect(r.calls == ["copy \(source) → /Applications/ReviewGate.app", "remove /Applications/ReviewGate.app"])

        // Replacing: the installed copy stays when the new one could not be copied; the partial copy is removed.
        let r2 = Recorder()
        r2.failing = ["copy"]
        _ = AppMover.perform(source: source, destination: "/Applications/ReviewGate.app", replace: true, ops: r2.ops, stagingSuffix: "S")
        #expect(!r2.calls.contains { $0.hasPrefix("trash") || $0 == "quit" })
        #expect(r2.calls.last == "remove /Applications/.ReviewGate.app.moving-S")

        // The installed copy could not be trashed: nothing quits, the staging copy goes.
        let r3 = Recorder()
        r3.failing = ["trash"]
        guard case .failed(.replace, _, false) = AppMover.perform(source: source, destination: "/Applications/ReviewGate.app", replace: true, ops: r3.ops, stagingSuffix: "S") else {
            Issue.record("expected a replace failure"); return
        }
        #expect(r3.calls.last == "remove /Applications/.ReviewGate.app.moving-S")

        // Copied but could not reopen: this app keeps running.
        let r4 = Recorder()
        r4.failing = ["reopen"]
        guard case .failed(.reopen, _, true) = AppMover.perform(source: source, destination: "/Applications/ReviewGate.app", replace: false, ops: r4.ops) else {
            Issue.record("expected a reopen failure"); return
        }
        #expect(!r4.calls.contains("quit"))
    }

    @Test func aRunningTurnBlocksTheMove() {
        #expect(AppMover.block(anyTurnRunning: true, moving: false) == .turnRunning)
        #expect(AppMover.block(anyTurnRunning: false, moving: true) == .moving)
        #expect(AppMover.block(anyTurnRunning: false, moving: false) == nil)
    }

    // MARK: daily-17

    @Test func temporaryFoldersNeverEnterTheRecentList() {
        for path in ["/tmp/demo", "/private/tmp/rg-scratch", "/var/folders/x1/T/proj", "/private/var/folders/x1/T/proj", "/tmp"] {
            #expect(RecentProjects.isTransient(path), "\(path)")
        }
        for path in ["/Users/me/acme", "/Users/me/tmp/x", "/tmpfoo/x", "/Volumes/work/repo"] {
            #expect(!RecentProjects.isTransient(path), "\(path)")
        }
        let d = UserDefaults(suiteName: "AppInstallTests.\(UUID().uuidString)")!
        AppSettings.addRecentProject(URL(fileURLWithPath: "/Users/me/acme"), defaults: d)
        AppSettings.addRecentProject(URL(fileURLWithPath: "/tmp/demo"), defaults: d)
        AppSettings.addRecentProject(URL(fileURLWithPath: "/private/var/folders/x1/T/proj"), defaults: d)
        #expect(AppSettings.recentProjects(defaults: d).map(\.path) == ["/Users/me/acme"])
    }

    @Test func missingFoldersAreMarkedAndRemovable() {
        let d = UserDefaults(suiteName: "AppInstallTests.\(UUID().uuidString)")!
        // An older build stored scratch paths: they are hidden, not shown as missing.
        d.set(["/Users/me/gone", "/tmp/demo", "/Users/me/acme"], forKey: AppSettings.Key.recentProjects)
        let exists: (String) -> Bool = { $0 == "/Users/me/acme" }
        #expect(RecentProjects.entries(defaults: d, isDirectory: exists) == [
            RecentProjects.Entry(url: URL(fileURLWithPath: "/Users/me/gone"), exists: false),
            RecentProjects.Entry(url: URL(fileURLWithPath: "/Users/me/acme"), exists: true),
        ])
        #expect(RecentProjects.removeMissing(defaults: d, isDirectory: exists) == 1)
        #expect(AppSettings.recentProjects(defaults: d).map(\.path) == ["/tmp/demo", "/Users/me/acme"])
        #expect(RecentProjects.entries(defaults: d, isDirectory: exists).map(\.url.path) == ["/Users/me/acme"])
    }
}
