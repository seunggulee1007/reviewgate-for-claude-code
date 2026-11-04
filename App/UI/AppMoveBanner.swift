import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave4 w4-install
/// Audit robustness-13 / daily-15 / polish-13: the app runs from a disk image (or from App Translocation). Every window
/// shows the banner until "Later" (once per launch); "Move to Applications Folder" copies the app there, reopens it once
/// this one has quit, and quits. The order and the decisions are `AppMover` (Core, unit-tested); this holds the real
/// file operations.
@MainActor @Observable
final class AppMoveController {
    static let shared = AppMoveController()

    let location = AppInstallLocation.classify(bundlePath: Bundle.main.bundlePath)
    private(set) var dismissed = false
    private(set) var moving = false
    /// The last failure, in the banner (Finder shows both folders for a drag).
    private(set) var failure: String?
    /// "ReviewGate is already in Applications" — waiting on the user.
    var pendingReplace: AppMovePlan?

    var isVisible: Bool { location.shouldOfferMove && !dismissed }

    func later() { dismissed = true }

    func start() {
        guard !moving else { return }
        failure = nil
        switch AppMover.plan(source: Bundle.main.bundlePath, ops: Self.liveOps) {
        case .copy(let destination): run(destination: destination, replace: false)
        case let plan: pendingReplace = plan
        }
    }

    func replaceInstalled() {
        guard case .askReplace(let destination, _, _, _) = pendingReplace else { return }
        pendingReplace = nil
        run(destination: destination, replace: true)
    }

    /// The copy already in Applications (same or newer) instead of this one.
    func openInstalled() {
        guard case .askReplace(let destination, _, _, _) = pendingReplace else { return }
        pendingReplace = nil
        do {
            try Self.liveOps.reopenAfterQuit(destination)
            Self.liveOps.quit()
        } catch {
            failure = String(localized: "Could not open \(destination): \(error.localizedDescription)")
        }
    }

    private func run(destination: String, replace: Bool) {
        moving = true
        let source = Bundle.main.bundlePath
        Task.detached(priority: .userInitiated) {
            let outcome = AppMover.perform(source: source, destination: destination, replace: replace, ops: Self.liveOps)
            await MainActor.run { self.finish(outcome, source: source) }
        }
    }

    private func finish(_ outcome: AppMoveOutcome, source: String) {
        moving = false
        guard case .failed(_, let message, let copied) = outcome else { return }
        if copied {
            failure = String(localized: "Copied to Applications, but could not reopen it (\(message)). Quit and open ReviewGate from Applications.")
            return
        }
        failure = String(localized: "Could not copy (\(message)). Drag ReviewGate into the Applications folder in the Finder windows.")
        // Both folders side by side for the drag.
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: source)])
        NSWorkspace.shared.open(URL(fileURLWithPath: AppMover.applicationsFolder, isDirectory: true))
    }

    nonisolated static let liveOps = AppMoveOps(
        exists: { FileManager.default.fileExists(atPath: $0) },
        version: { path in Bundle(path: path)?.infoDictionary.flatMap(AppBundleVersion.init(info:)) },
        copy: { from, to in
            try FileManager.default.copyItem(atPath: from, toPath: to)
            // A copy made outside Finder keeps the download's quarantine and would be translocated again on launch.
            stripQuarantine(to)
        },
        trash: { try FileManager.default.trashItem(at: URL(fileURLWithPath: $0), resultingItemURL: nil) },
        move: { try FileManager.default.moveItem(atPath: $0, toPath: $1) },
        remove: { try? FileManager.default.removeItem(atPath: $0) },
        reopenAfterQuit: { path in
            // Waits (at most 2 minutes) for this process to exit, then opens the new copy: the two never hold the same
            // projects at once, and the window list written at quit is the one the new copy restores.
            let helper = Process()
            helper.executableURL = URL(fileURLWithPath: "/bin/sh")
            helper.arguments = ["-c", "i=0; while /bin/kill -0 \"$1\" 2>/dev/null && [ $i -lt 400 ]; do /bin/sleep 0.3; i=$((i+1)); done; /bin/kill -0 \"$1\" 2>/dev/null || /usr/bin/open \"$2\"",
                                "sh", String(ProcessInfo.processInfo.processIdentifier), path]
            helper.standardInput = FileHandle.nullDevice
            helper.standardOutput = FileHandle.nullDevice
            helper.standardError = FileHandle.nullDevice
            try helper.run()
        },
        // From the run loop, not a main-queue job: Quit's `.terminateLater` needs the main queue for the engines' shutdown
        // (and its 6 s cap), and a nested run loop inside a main-queue job does not drain it — the app hung in Quit.
        quit: { RunLoop.main.perform { NSApp.terminate(nil) } })

    private nonisolated static func stripQuarantine(_ path: String) {
        let xattr = Process()
        xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        xattr.arguments = ["-dr", "com.apple.quarantine", path]
        xattr.standardOutput = FileHandle.nullDevice
        xattr.standardError = FileHandle.nullDevice
        do {
            try xattr.run()
            xattr.waitUntilExit()
        } catch {}
    }
}

/// Top of every window while the app runs from a disk image: what happens on eject, Move / Later.
struct AppMoveBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    private var mover: AppMoveController { AppMoveController.shared }

    var body: some View {
        if mover.isVisible {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "externaldrive.badge.exclamationmark")
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.callout)
                        if let line = detail {
                            Text(verbatim: line).font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 8)
                    if mover.moving { ProgressView().controlSize(.small) }
                    Button("Move to Applications Folder") { mover.start() }
                        .disabled(block != nil)
                        .help(blockText ?? String(localized: "Copies the app to Applications, reopens it from there and quits this one"))
                        .accessibilityIdentifier("Move to Applications")
                    Button("Later") { mover.later() }
                        .accessibilityIdentifier("Move to Applications later")
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))   // the other banners' wash
                Divider()
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Disk image banner")
            .alert("ReviewGate is already in Applications", isPresented: Binding(
                get: { mover.pendingReplace != nil }, set: { if !$0 { mover.pendingReplace = nil } }), presenting: mover.pendingReplace) { plan in
                Button("Replace") { mover.replaceInstalled() }
                if case .askReplace(_, _, _, let order) = plan, order == .installedIsNewer || order == .same {
                    Button("Open Installed App") { mover.openInstalled() }
                }
                Button("Cancel", role: .cancel) { mover.pendingReplace = nil }
            } message: { plan in
                Text(verbatim: Self.replaceMessage(plan))
            }
        }
    }

    private var title: String {
        if mover.location == .translocated {
            return String(localized: "Running from a temporary copy macOS made. Move it to Applications to keep Claude connected.")
        }
        return String(localized: "Running from a disk image. Ejecting the image disconnects Claude.")
    }

    private var block: AppMover.Block? {
        AppMover.block(anyTurnRunning: WorkbenchRegistry.shared.allStores.contains { $0.isRunning }, moving: mover.moving)
    }

    private var blockText: String? {
        switch block {
        case .turnRunning: String(localized: "Claude is working — move after the turn ends.")
        case .moving: String(localized: "Copying to Applications…")
        case nil: nil
        }
    }

    /// The failure wins over the reason the button is disabled.
    private var detail: String? { mover.failure ?? blockText }

    static func replaceMessage(_ plan: AppMovePlan) -> String {
        guard case .askReplace(_, let installed, let running, let order) = plan else { return "" }
        let installedText = installed?.description ?? "?"
        let runningText = running?.description ?? "?"
        switch order {
        case .installedIsNewer:
            return String(localized: "The installed app (\(installedText)) is newer than this one (\(runningText)). Replace it anyway? The installed app goes to the Trash.")
        case .same:
            return String(localized: "The installed app is the same version (\(installedText)). Replace it, or open the installed one? The installed app goes to the Trash when replaced.")
        case .runningIsNewer, .unknown:
            return String(localized: "Installed: \(installedText) · This app: \(runningText). Replace it? The installed app goes to the Trash.")
        }
    }
}

/// The bottom of Settings › General: "ReviewGate 0.2.3 (610)" (the About window and Copy Diagnostics say the same).
struct AppVersionFooter: View {
    var body: some View {
        Section {
            LabeledContent("Version") {
                Text(verbatim: AppBundleVersion(info: Bundle.main.infoDictionary ?? [:])?.description ?? "?")
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
            }
            .accessibilityIdentifier("App version")
        }
    }
}
