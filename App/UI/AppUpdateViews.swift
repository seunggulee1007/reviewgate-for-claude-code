import SwiftUI
import AppKit
import ReviewGateCore

// MARK: app-update
/// docs/PROTOCOL.md §48: the app notices a new GitHub release and offers to install it. One controller for the app (every
/// window's banner shows the same state): checks at launch, every 6 hours (Settings › General › Updates turns that off)
/// and from ReviewGate › Check for Updates…; installs on [Install and Restart]. The check, the gates and the helper are
/// Core (`AppUpdate.swift`, `AppUpdateInstall.swift`, unit-tested); this holds the timers, the windows' state and AppKit.
@MainActor @Observable
final class AppUpdateController {
    static let shared = AppUpdateController()

    enum InstallPhase: Equatable {
        case step(AppUpdateStep)
        /// MARK: polish p-lifecycle (PX-update-wait): the windows the restart waits for, with why (`UpdateWait`).
        case waitingForClaude(UpdateWait.Decision)
        case restarting
        case failed(String)
    }

    /// The running bundle's CFBundleShortVersionString.
    let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    /// The newer release the last check found.
    private(set) var release: AppRelease?
    private(set) var checking = false
    private(set) var install: InstallPhase?
    /// The last check's result, for Settings.
    private(set) var lastOutcome: UpdateCheckOutcome?
    private(set) var dismissed = AppSettings.dismissedUpdateVersion()

    private var loop: Task<Void, Never>?
    /// "Check for Updates…" while an automatic check runs: that check's result is reported.
    private var reportNextResult = false
    private var prepared: PreparedUpdate?
    private var preparedContext: AppUpdateContext?
    /// The helper started for the restart (our own child, terminated by its pid if the quit is cancelled).
    private var helper: Process?
    private var restartRequested = false
    // MARK: polish p-lifecycle (P5-sheets-47)
    /// The download and checks under way — [Cancel] stops them (its process is terminated).
    private var installTask: Task<Void, Never>?
    /// What the download has brought so far, while it runs.
    private(set) var receivedBytes: Int64?

    /// A download, a check or the wait is under way: no second install, no dismiss.
    var isInstalling: Bool {
        switch install {
        case .step, .waitingForClaude, .restarting: true
        case .failed, nil: false
        }
    }

    /// What the banner shows: a newer release not closed — or one being installed / that failed to install.
    var bannerRelease: AppRelease? {
        guard let release else { return nil }
        if install != nil { return release }
        return AppUpdateBanner.shows(release, currentVersion: currentVersion, dismissed: dismissed) ? release : nil
    }

    // MARK: Checks

    /// From `applicationDidFinishLaunching`: the first check shortly after launch (the first window's engine resolves
    /// `gh` meanwhile), then every 6 hours while automatic checks are on.
    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            while !Task.isCancelled {
                if AppSettings.checkForUpdatesAutomatically() { await self?.runCheck(userInitiated: false) }
                try? await Task.sleep(for: AppUpdateChecker.interval)
            }
        }
    }

    /// "Check for Updates…" / Settings' [Check Now]: the result is always said (an alert).
    func checkNow() {
        Task { await runCheck(userInitiated: true) }
    }

    /// Settings' toggle turned on: check right away.
    func automaticChecksChanged(_ on: Bool) {
        guard on else { return }
        Task { await runCheck(userInitiated: false) }
    }

    private func runCheck(userInitiated: Bool) async {
        if checking {
            if userInitiated { reportNextResult = true }
            return
        }
        if isInstalling {
            if userInitiated, let release { AppUpdateAlerts.installing(release) }
            return
        }
        checking = true
        let (gh, run) = await Self.ghRunner()
        let outcome = await AppUpdateChecker.check(currentVersion: currentVersion, ghPath: gh, run: run)
        checking = false
        lastOutcome = outcome
        let report = userInitiated || reportNextResult
        reportNextResult = false
        switch outcome {
        case .available(let found):
            release = found
            // Asked for: a version closed before comes back.
            if report, let closed = dismissed, closed >= found.version {
                AppSettings.clearDismissedUpdate()
                dismissed = nil
            }
            if case .failed = install, report { install = nil }
        case .upToDate:
            if !isInstalling { release = nil; install = nil }
        case .unavailable:
            break   // a failed check keeps what an earlier one found
        }
        if report { AppUpdateAlerts.report(outcome, controller: self) }
    }

    /// `gh` as the engine of any window resolved it (else the login PATH's), run with the login PATH.
    private static func ghRunner() async -> (String?, UpdateRun) {
        let stores = WorkbenchRegistry.shared.allStores
        let engineGh = stores.lazy.compactMap { $0.engineToolchain.gh }.first
        let known = stores.lazy.compactMap { $0.toolchain?.loginPATH }.first
        let path = await UpdateGHLocator.loginPATH(known: known)
        return (UpdateGHLocator.resolve(engineGh: engineGh, loginPATH: path), UpdateGHLocator.liveRun(path: path))
    }

    // MARK: Banner actions

    /// [×]: this version's banner stays closed (a newer release shows again).
    func dismiss() {
        guard let release, !isInstalling else { return }
        install = nil
        AppSettings.dismissUpdate(release.version)
        dismissed = AppSettings.dismissedUpdateVersion()
    }

    /// [Install and Restart] / [Try Again].
    func startInstall() {
        guard let release, !isInstalling else { return }
        install = .step(.downloading)   // at once: a second click finds the install under way
        receivedBytes = nil
        installTask = Task { await runInstall(release) }
    }

    /// [Cancel] — MARK: polish p-lifecycle (P5-sheets-47): while downloading or checking too (it was offered only while
    /// waiting for Claude): the steps stop (their process is terminated), the image is detached and the download removed.
    func cancelInstall() {
        switch install {
        case .step, .waitingForClaude: break
        default: return
        }
        installTask?.cancel()
        installTask = nil
        install = nil
        receivedBytes = nil
        discardPrepared()
    }

    private func runInstall(_ release: AppRelease) async {
        install = .step(.downloading)
        let (gh, run) = await Self.ghRunner()
        guard !Task.isCancelled else { return }
        guard let gh else {
            install = .failed(AppUpdateText.problem(.ghMissing))
            return
        }
        let context = AppUpdateContext(ghPath: gh, run: run, bundlePath: Bundle.main.bundlePath,
                                       bundleIdentifier: Bundle.main.bundleIdentifier)
        let result = await AppUpdateInstaller.prepare(release, context: context, received: { bytes in
            await MainActor.run {
                let shared = AppUpdateController.shared
                if shared.install == .step(.downloading) { shared.receivedBytes = bytes }
            }
        }) { step in
            await MainActor.run {
                let shared = AppUpdateController.shared
                guard shared.installTask?.isCancelled == false else { return }
                shared.install = .step(step)
                if step != .downloading { shared.receivedBytes = nil }
            }
        }
        // Cancelled meanwhile: `prepare` cleaned up after itself (a step it stopped fails); nothing to say.
        guard !Task.isCancelled else {
            if case .success(let ready) = result { Task { await AppUpdateInstaller.discard(ready, context: context) } }
            return
        }
        installTask = nil
        switch result {
        case .failure(let refusal):
            install = .failed(AppUpdateText.refusal(refusal))
        case .success(let ready):
            prepared = ready
            preparedContext = context
            await restartWhenClaudeIsIdle()
        }
    }

    /// Restarting quits every window: it waits while any window has a turn running or a card waiting for the user — MARK:
    /// polish p-lifecycle (PX-update-wait): by window and why, never on a window "working" without a word from its engine
    /// for two minutes (a turn whose end was missed), and the closed windows' stores are gone from the registry.
    private func restartWhenClaudeIsIdle() async {
        while prepared != nil, !restartRequested {
            let decision = UpdateWait.decide(Self.waitWindows(), now: Date())
            if decision.restartsNow {
                restart()
                return
            }
            if install != .waitingForClaude(decision) { install = .waitingForClaude(decision) }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// Every store that may own an engine — the open windows, then the Settings scene's — as the wait sees them.
    private static func waitWindows() -> [UpdateWaitWindow] {
        WorkbenchRegistry.shared.allStores.map { store in
            UpdateWaitWindow(name: store.quitDisplayName, reason: store.closeGuardReason, lastEventAt: store.lastEngineEventAt)
        }
    }

    /// A waiting line's window to the front (`index` of `waitWindows`).
    func focusWaiting(_ blocker: UpdateWait.Blocker) {
        let stores = WorkbenchRegistry.shared.allStores
        guard stores.indices.contains(blocker.index), let entry = WorkbenchRegistry.shared.entry(for: stores[blocker.index]) else { return }
        entry.focus()
    }

    /// MARK: polish p-lifecycle — P5-sheets-48 / PX-update-wait: [지금 다시 시작] — asked once ("작업 중인 턴은 멈춰요." with the
    /// windows it waits for), then the restart goes ahead (the quit asks nothing more).
    func restartNow(in window: NSWindow?) {
        guard case .waitingForClaude(let decision) = install, prepared != nil else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = UpdateWait.restartNowTitle
        alert.informativeText = (decision.blockers.map(UpdateWait.line) + [UpdateWait.restartNowMessage]).joined(separator: "\n")
        alert.addButton(withTitle: UpdateWait.restartNowButton)
        let cancel = alert.addButton(withTitle: CloseGuardText.cancelButton)
        cancel.keyEquivalent = "\u{1b}"
        let go: @MainActor (NSApplication.ModalResponse) -> Void = { response in
            guard response == .alertFirstButtonReturn, case .waitingForClaude = AppUpdateController.shared.install else { return }
            AppUpdateController.shared.restart()
        }
        if let window { alert.beginSheetModal(for: window) { response in go(response) } } else { go(alert.runModal()) }
    }

    private func restart() {
        guard let prepared else { return }
        install = .restarting
        do {
            helper = try AppUpdateHelper.launch(prepared, bundlePath: Bundle.main.bundlePath,
                                                log: EngineLogFile.shared.directory.appendingPathComponent("update.log"))
        } catch {
            install = .failed(AppUpdateText.refusal(.helperFailed(error.localizedDescription)))
            discardPrepared()
            return
        }
        restartRequested = true
        // polish P5-sheets-48: not the user's quit — the next launch reopens these windows whatever "Reopen last projects"
        // says.
        AppSettings.setRestoreOnceAfterRelaunch()
        // The usual quit: the window list is written and every engine stops; the helper waits for this pid to exit.
        // From the run loop, not from this main-queue job: Quit's `.terminateLater` waits for engine shutdown tasks (and
        // its 6 s cap) that need the main queue, which a nested run loop does not drain inside a main-queue job — called
        // from here, the app hung in Quit with any project open, and the helper gave up after 10 minutes (0.5.6–0.5.8).
        // polish P5-sheets-48: the app's own quit — no "Quit ReviewGate?" (the wait above already saw every window idle).
        AppQuit.terminate()
    }

    /// Forgets the prepared update at once (the wait loop stops on its next look) and detaches / removes it behind.
    private func discardPrepared() {
        guard let ready = prepared, let context = preparedContext else { return }
        prepared = nil
        preparedContext = nil
        Task { await AppUpdateInstaller.discard(ready, context: context) }
    }

    // MARK: Quit hooks (AppDelegate)

    /// The quit was cancelled (Claude started working meanwhile and the user kept it): the helper is stopped — by its own
    /// pid, never by name — and the image detached.
    func quitWasCancelled() {
        guard restartRequested else { return }
        restartRequested = false
        helper?.terminate()
        helper = nil
        install = .failed(AppUpdateText.restartCancelled)
        discardPrepared()
    }

    /// The app quits on its own while an update waits: the mounted image does not outlive it.
    func appWillTerminate() {
        guard let ready = prepared, !restartRequested else { return }
        let detach = Process()
        detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        detach.arguments = ["detach", ready.mountPoint.path, "-force", "-quiet"]
        detach.standardOutput = FileHandle.nullDevice
        detach.standardError = FileHandle.nullDevice
        do {
            try detach.run()
            detach.waitUntilExit()
        } catch {}
        try? FileManager.default.removeItem(at: ready.workDirectory)
    }
}

#if DEBUG
extension AppUpdateController {
    /// The screenshot tour (App/Debug/ScreenshotTour.swift): the banner in a phase of its own with a made-up release; nil
    /// puts it back.
    func debugShow(_ phase: InstallPhase?, release: AppRelease?, received: Int64? = nil) {
        self.release = release
        install = phase
        receivedBytes = received
    }
}
#endif

/// The on-demand check's answers (also with no window open).
@MainActor
enum AppUpdateAlerts {
    static func report(_ outcome: UpdateCheckOutcome, controller: AppUpdateController) {
        let alert = NSAlert()
        switch outcome {
        case .available(let release):
            alert.messageText = AppUpdateText.available(release.version.description)
            alert.informativeText = AppUpdateText.youHave(controller.currentVersion)
            alert.accessoryView = notesView(release.notes)
            alert.addButton(withTitle: AppUpdateText.installButton)
            alert.addButton(withTitle: String(localized: "Later"))
            if !release.isInstallable { alert.buttons.first?.isEnabled = false }
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn { controller.startInstall() }
        case let .upToDate(current, latest):
            alert.messageText = AppUpdateText.upToDateTitle
            alert.informativeText = AppUpdateText.upToDate(current: current, latest: latest)
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        case .unavailable(let problem):
            alert.alertStyle = .warning
            alert.messageText = AppUpdateText.checkFailedTitle
            alert.informativeText = AppUpdateText.problem(problem)
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    /// "Check for Updates…" during an install: the banner already says where it is.
    static func installing(_ release: AppRelease) {
        let alert = NSAlert()
        alert.messageText = AppUpdateText.available(release.version.description)
        alert.informativeText = String(localized: "The update is being installed — the banner at the top of the window shows its progress.")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    /// The release notes in a small scrolling box under the alert's text.
    private static func notesView(_ notes: String) -> NSView {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 180))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let text = NSTextView(frame: scroll.bounds)
        text.isEditable = false
        text.isSelectable = true
        text.autoresizingMask = [.width]
        text.textContainerInset = NSSize(width: 6, height: 6)
        let body = notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? AppUpdateText.noNotes : notes
        let styled = (try? AttributedString(markdown: body, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            .map { NSMutableAttributedString(attributedString: NSAttributedString($0)) } ?? NSMutableAttributedString(string: body)
        styled.addAttributes([.font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: NSColor.labelColor],
                             range: NSRange(location: 0, length: styled.length))
        text.textStorage?.setAttributedString(styled)
        scroll.documentView = text
        return scroll
    }
}

/// Every window's banner stack: "ReviewGate 0.5.5 is available" — [Install and Restart] [What's New] [×]; then the
/// install's progress, the wait for Claude, or why it failed, in words.
struct AppUpdateBannerView: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var showingNotes = false
    private var updater: AppUpdateController { AppUpdateController.shared }

    var body: some View {
        if let release = updater.bannerRelease {
            let version = release.version.description
            HStack(spacing: 8) {
                Image(systemName: failure == nil ? "arrow.down.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(failure == nil ? Color.blue : Color.orange)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: failure == nil ? AppUpdateText.available(version) : AppUpdateText.installFailedTitle(version))
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                        .accessibilityIdentifier("Update banner text")
                    Text(verbatim: detail(release))
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("Update banner detail")
                    // PX-update-wait: under the words, the windows it waits for — the buttons keep their room (at 1000 pt
                    // the line beside them cut the words short).
                    if case .waitingForClaude(let decision) = updater.install { waitingLines(decision) }
                }
                Spacer(minLength: 4)
                if showsProgress { ProgressView().controlSize(.small) }
                buttons(release)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background((failure == nil ? Color.blue : Color.orange).wash(colorScheme, light: 0.10, dark: 0.18))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Update banner")
            .sheet(isPresented: $showingNotes) { AppUpdateNotesSheet(release: release) }
            Divider()
        }
    }

    private var failure: String? {
        if case .failed(let message) = updater.install { return message }
        return nil
    }

    /// Downloading, checking or restarting (the wait for Claude has its own words and its buttons).
    private var showsProgress: Bool {
        switch updater.install {
        case .step, .restarting: true
        case .waitingForClaude, .failed, nil: false
        }
    }

    private func detail(_ release: AppRelease) -> String {
        let version = release.version.description
        switch updater.install {
        case nil: return AppUpdateText.youHave(updater.currentVersion)
        case .step(let step):
            // polish P5-sheets-47: how much has come ("12.4 / 48.0 MB").
            guard step == .downloading, let bytes = updater.receivedBytes else { return AppUpdateText.step(step, version: version) }
            return AppUpdateText.step(step, version: version) + " " + AppUpdateText.received(bytes, of: release.dmg?.size)
        case .waitingForClaude(let decision):
            let head = AppUpdateText.waitingForClaude(version: version, windows: decision.blockers.count)
            return ([head] + decision.stale.map(UpdateWait.staleLine)).joined(separator: "\n")
        case .restarting: return AppUpdateText.restarting(version)
        case .failed(let message): return message
        }
    }

    @ViewBuilder
    private func buttons(_ release: AppRelease) -> some View {
        switch updater.install {
        case nil, .failed:
            Button(failure == nil ? AppUpdateText.installButton : String(localized: "Try Again")) { updater.startInstall() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!release.isInstallable)
                .help(release.isInstallable
                      ? String(localized: "Downloads the release with gh, checks its checksum and signature, then quits ReviewGate and opens the new version")
                      : AppUpdateText.refusal(.notInstallable))
                .accessibilityIdentifier("Install update")
            Button(AppUpdateText.whatsNewButton) { showingNotes = true }
                .controlSize(.small)
                .accessibilityIdentifier("Update notes")
            Button { updater.dismiss() } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .controlSize(.small)
                // MARK: polish p-lifecycle (P1-chrome-18): when it shows again — the next version (`dismiss` keeps this one quiet).
                .help("Hide this version — the next one is announced again")
                .accessibilityLabel("Hide this version — the next one is announced again")
                .accessibilityIdentifier("Dismiss update banner")
        case .waitingForClaude:
            Button(AppUpdateText.whatsNewButton) { showingNotes = true }
                .controlSize(.small)
            Button(UpdateWait.restartNowButton) { updater.restartNow(in: NSApp.keyWindow) }
                .controlSize(.small)
                .help(UpdateWait.restartNowMessage)
                .accessibilityIdentifier("Restart now for update")
            Button("Cancel") { updater.cancelInstall() }
                .controlSize(.small)
                .help("Stops the update — the download is removed")
                .accessibilityIdentifier("Cancel update")
        case .step:
            Button(AppUpdateText.whatsNewButton) { showingNotes = true }
                .controlSize(.small)
            // P5-sheets-47: the download and the checks can be stopped too.
            Button("Cancel") { updater.cancelInstall() }
                .controlSize(.small)
                .help("Stops the update — the download is removed")
                .accessibilityIdentifier("Cancel update")
        case .restarting:
            Button(AppUpdateText.whatsNewButton) { showingNotes = true }
                .controlSize(.small)
        }
    }

    /// The windows the restart waits for — one: a link ("acme-api: Claude가 작업 중이에요"); more: a menu of them. A click
    /// brings that window to the front.
    @ViewBuilder
    private func waitingLines(_ decision: UpdateWait.Decision) -> some View {
        if decision.blockers.count == 1, let only = decision.blockers.first {
            Button(UpdateWait.line(only)) { updater.focusWaiting(only) }
                .buttonStyle(.link)
                .font(.caption)
                .lineLimit(1)
                .help("Brings that window to the front")
                .accessibilityIdentifier("Update waits for")
        } else if !decision.blockers.isEmpty {
            Menu {
                ForEach(decision.blockers, id: \.index) { blocker in
                    Button(UpdateWait.line(blocker)) { updater.focusWaiting(blocker) }
                }
            } label: {
                Text("Waiting for \(decision.blockers.count) windows").font(.caption).lineLimit(1)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .controlSize(.small)
            .help("Brings that window to the front")
            .accessibilityIdentifier("Update waits for")
        }
    }
}

/// [What's New]: the release notes (Markdown) and a link to the release page.
struct AppUpdateNotesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let release: AppRelease

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(.blue)
                    .accessibilityHidden(true)
                Text(verbatim: AppUpdateText.whatsNewTitle(release.version.description))
                    .font(.title3.weight(.semibold))
                Spacer()
                if let page = release.page {
                    Link("Open Release Page", destination: page)
                        .help(page.absoluteString)
                }
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(12)
            Divider()
            ScrollView {
                Group {
                    if release.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(verbatim: AppUpdateText.noNotes).foregroundStyle(.secondary)
                    } else {
                        MarkdownText(text: release.notes)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .textSelection(.enabled)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .accessibilityIdentifier("Update notes text")
        }
        .frame(minWidth: 560, idealWidth: 640, minHeight: 420, idealHeight: 560)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Update notes")
    }
}

/// ReviewGate › Check for Updates… (after About).
struct UpdateCommands: Commands {
    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { AppUpdateController.shared.checkNow() }
                .accessibilityIdentifier("Check for Updates")
        }
    }
}

/// Settings › General › Updates: automatic checks (default on) and [Check Now] with the last result.
struct UpdateSettingsSection: View {
    @AppStorage(AppSettings.Key.checkForUpdatesAutomatically) private var automatic = true
    private var updater: AppUpdateController { AppUpdateController.shared }

    var body: some View {
        Section("Updates") {
            Toggle("Check for updates automatically", isOn: $automatic)
                .accessibilityIdentifier("Check for updates automatically")
            Text(verbatim: AppUpdateText.settingsNote)
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("Check Now") { updater.checkNow() }
                    .disabled(updater.checking || updater.isInstalling)
                    .accessibilityIdentifier("Check for updates now")
                if updater.checking {
                    ProgressView().controlSize(.small)
                    Text(verbatim: AppUpdateText.checking).font(.caption).foregroundStyle(.secondary)
                } else if let outcome = updater.lastOutcome {
                    Text(verbatim: AppUpdateText.lastResult(outcome))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("Last update check")
                }
            }
        }
        .onChange(of: automatic) { _, on in updater.automaticChecksChanged(on) }
    }
}
