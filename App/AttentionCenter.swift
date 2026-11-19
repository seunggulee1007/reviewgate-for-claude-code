import AppKit
import Observation
import UserNotifications
import ReviewGateCore

/// User notifications for workbenches in the background and the dock badge over every window.
///
/// A store reports what needs the user (`AppState.onAttention`); a notification is posted only when that window is not
/// in front (app inactive, or another window key), at most once per event (`AttentionCoalescer`), and only while its
/// group is on in Settings › Notifications (`NotificationGroup`). macOS is asked for permission up front (launch, the
/// switch turned on) and its answer is re-read on every activation: Settings and the window say when it is off
/// (`NotificationStatusModel`). Clicking a notification brings its window forward (restored from the Dock), opens its
/// chat and scrolls to the card or summary it was about (`AttentionTarget`).
///
/// §39.7: each kind sounds its own (`NotificationSoundCategory`). The app plays the sound itself (`NotificationSoundPlayer`)
/// at the moment it posts — the notification carries none — so a macOS alert sound picked by name always resolves and the
/// sound plays also when macOS shows no banner.
@MainActor
final class AttentionCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AttentionCenter()

    private var coalescer = AttentionCoalescer()
    private var authorization: UNAuthorizationStatus?
    private var requestingAuthorization = false
    /// Posted while authorization was being asked; sent once it is granted.
    private var waiting: [(AttentionEvent, String, String, AttentionTarget)] = []
    private var badgeObserved = false
    // MARK: wave4b w4-notify
    private var activationObserver: NSObjectProtocol?
    // MARK: polish p-lifecycle (PX-15)
    /// The windows (`scope`) that waited for the user at the last look: one that stops waiting has its cards' notifications
    /// removed.
    private var waitingScopes: Set<String> = []
    // MARK: notification-sounds (§39.7)
    /// One sound per category every 2 s over every window.
    private var soundGate = NotificationSoundGate()
    /// "Play sound for notifications" is off for ReviewGate in System Settings › Notifications: the app plays none either.
    private var systemSoundsOff = false

    /// Called once at launch (the delegate must be set before a click is delivered).
    func start() {
        UNUserNotificationCenter.current().delegate = self
        observeBadge()
        // wave4b w4-notify: ask now (not at the first notification, which the question would hold back) and notice a
        // change made in System Settings when the user comes back.
        prepare()
        activationObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification,
                                                                    object: nil, queue: .main) { _ in
            Task { @MainActor in AttentionCenter.shared.refreshStatus() }
        }
    }

    /// Wires one window's store to the center.
    func attach(_ entry: WorkbenchWindowEntry) {
        entry.store.onAttention = { [weak self, weak entry] event in
            guard let self, let entry else { return }
            self.handle(event, entry: entry)
        }
        observeBadge()
    }

    // MARK: wave4b w4-notify — the macOS permission

    /// Reads what macOS allows and, while it never asked and the app's switch is on, asks.
    func prepare() {
        guard !requestingAuthorization else { return }
        requestingAuthorization = true
        Task {
            let center = UNUserNotificationCenter.current()
            var status = await Self.read(center)
            if NotificationHealth.asksUpFront(appEnabled: AppSettings.notificationsEnabled(), system: status.system) {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                status = await Self.read(center)
            }
            apply(status)
            requestingAuthorization = false
            flushWaiting()
        }
    }

    /// Re-reads what macOS allows (the user may have changed it in System Settings meanwhile).
    func refreshStatus() {
        Task {
            apply(await Self.read(UNUserNotificationCenter.current()))
        }
    }

    private func apply(_ status: (raw: UNAuthorizationStatus, system: SystemNotificationStatus, soundsOff: Bool)) {
        authorization = status.raw
        systemSoundsOff = status.soundsOff
        if NotificationStatusModel.shared.system != status.system { NotificationStatusModel.shared.system = status.system }
    }

    private static func read(_ center: UNUserNotificationCenter) async
        -> (raw: UNAuthorizationStatus, system: SystemNotificationStatus, soundsOff: Bool) {
        let settings = await center.notificationSettings()
        let raw = settings.authorizationStatus
        let system: SystemNotificationStatus
        switch raw {
        case .notDetermined: system = .notDetermined
        case .denied: system = .denied
        case .authorized, .provisional, .ephemeral: system = settings.alertStyle == .none ? .noBanners : .allowed
        @unknown default: system = .unknown
        }
        // §39.7: only an allowed app's sound switch says anything (denied or never asked: the app's own switch decides).
        let allowed = raw == .authorized || raw == .provisional
        return (raw, system, allowed && settings.soundSetting == .disabled)
    }

    private func flushWaiting() {
        let queued = waiting
        waiting = []
        guard authorization == .authorized || authorization == .provisional else { return }
        for (event, scope, project, target) in queued { deliver(event, scope: scope, project: project, target: target) }
    }

    // MARK: Posting

    private func handle(_ event: AttentionEvent, entry: WorkbenchWindowEntry) {
        guard AppSettings.notificationsEnabled() else { return }
        guard AppSettings.notifies(NotificationGroup(kind: event.kind)) else { return }   // wave4b w4-notify
        // In front: the window itself shows it.
        if NSApp.isActive, entry.window?.isKeyWindow == true { return }
        guard let url = entry.store.projectURL else { return }
        let scope = AppSettings.projectKey(url)
        guard coalescer.shouldPost(event, scope: scope) else { return }
        let target = AttentionTarget(kind: event.kind, chatId: entry.store.currentSessionId, requestId: event.requestId)
        post(event, scope: scope, project: entry.store.windowTitle, target: target)
        playSound(NotificationSoundCategory(event: event))   // §39.7: also when macOS shows nothing (off, not asked yet)
        // MARK: polish p-lifecycle (P1-chrome-11): Claude waits for the user while the app is behind — the Dock icon bounces
        // once too (a notification turned off in macOS left only the badge's number).
        if event.kind.blocksClaude, !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
    }

    // MARK: polish p-lifecycle — PX-15: what the user has seen in the window leaves Notification Center

    /// `entry`'s window came to the front: its cards' and its summary's notifications go.
    func windowBecameKey(_ entry: WorkbenchWindowEntry) {
        guard let url = entry.store.projectURL else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(
            withIdentifiers: DeliveredNotifications.seen(scope: AppSettings.projectKey(url)))
    }

    private func post(_ event: AttentionEvent, scope: String, project: String, target: AttentionTarget) {
        switch authorization {
        case .authorized, .provisional, .ephemeral:
            deliver(event, scope: scope, project: project, target: target)
        default:
            // Not asked yet, or off: read it again (it may have been turned on in System Settings) before dropping it.
            waiting.append((event, scope, project, target))
            prepare()
        }
    }

    private func deliver(_ event: AttentionEvent, scope: String, project: String, target: AttentionTarget) {
        let content = UNMutableNotificationContent()
        content.title = event.title
        content.subtitle = project
        content.body = event.body
        content.threadIdentifier = scope
        var info: [String: String] = ["projectPath": scope]
        info.merge(target.userInfo) { old, _ in old }
        content.userInfo = info
        // §39.7: no sound here — `handle` played this kind's own (a sound by name only resolves from Library/Sounds).
        // One live notification per window and kind: a newer "turn finished" replaces the older one.
        let request = UNNotificationRequest(identifier: DeliveredNotifications.identifier(scope: scope, kind: event.kind),
                                            content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: app-update (§48)

    /// The update's own notices — "Installing ReviewGate X" as the app quits for the restart, "Updated to ReviewGate X"
    /// after it. Only while ReviewGate's notifications are on and macOS allows them (else the window's banner alone says
    /// it); nothing waits for it. One at a time: the newer replaces the older.
    func postAppUpdate(title: String, body: String) {
        guard AppSettings.notificationsEnabled() else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: "app-update", content: content, trigger: nil)
        switch authorization {
        case .authorized, .provisional, .ephemeral:
            UNUserNotificationCenter.current().add(request)
            playUpdateSound()
        case nil:
            // At launch macOS's answer may not have been read yet.
            Task {
                let status = await Self.read(UNUserNotificationCenter.current())
                guard status.raw == .authorized || status.raw == .provisional else { return }
                apply(status)
                try? await UNUserNotificationCenter.current().add(request)
                playUpdateSound()
            }
        default:
            break
        }
    }

    // MARK: notification-sounds (§39.7)

    /// `category`'s sound, as Settings › Notifications picked it — none while "Play a sound" is off, "None" is picked,
    /// macOS turned ReviewGate's sounds off, or the same category sounded under 2 s ago (another window, a burst).
    private func playSound(_ category: NotificationSoundCategory) {
        guard !systemSoundsOff, let sound = AppSettings.notificationSoundToPlay(for: category),
              soundGate.admits(category) else { return }
        NotificationSoundPlayer.play(sound)
    }

    /// The update's notice sounds only while the app is behind: in front, the window's own banner says it.
    private func playUpdateSound() {
        guard !NSApp.isActive else { return }
        playSound(.appUpdate)
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let path = info["projectPath"] as? String
        let target = AttentionTarget(userInfo: info)
        await MainActor.run {
            guard let path else { NSApp.activate(ignoringOtherApps: true); return }
            let url = URL(fileURLWithPath: path)
            guard WorkbenchRegistry.shared.focusWindow(for: url) else {
                NSApp.activate(ignoringOtherApps: true)
                return
            }
            // wave4b w4-notify: its chat, and the card / summary it was about.
            if let target, let entry = WorkbenchRegistry.shared.entry(for: url) {
                entry.model.openFromNotification(target, store: entry.store)
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        // Posted only for a window that is not in front; while the app is active (another window key) show it too.
        [.banner, .list, .sound]
    }

    // MARK: Dock badge

    /// Recomputes the badge whenever a window's pending files / waiting state change (observation re-armed each time).
    private func observeBadge() {
        guard !badgeObserved else { return }
        badgeObserved = true
        updateBadge()
    }

    private func updateBadge() {
        let (label, waiting) = withObservationTracking {
            let stores = WorkbenchRegistry.shared.stores
            let waitingStores = stores.filter { $0.pendingPermission != nil || $0.pendingPlan != nil || $0.terminalWaiting != nil }   // §57.5
            // §31: changes from outside the app are not Claude's work waiting for review — not counted.
            let label = DockBadge.label(pendingCounts: stores.map { $0.dockBadgeCount }, anyWaiting: !waitingStores.isEmpty)
            return (label, Set(waitingStores.compactMap { $0.projectURL.map(AppSettings.projectKey) }))
        } onChange: {
            Task { @MainActor in AttentionCenter.shared.updateBadge() }
        }
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
        // MARK: polish p-lifecycle (PX-15): a card answered anywhere (the window, the board, a rule) — its notification goes.
        let answered = DeliveredNotifications.answered(was: waitingScopes, now: waiting)
        waitingScopes = waiting
        if !answered.isEmpty {
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: answered.flatMap { DeliveredNotifications.waiting(scope: $0) })
        }
    }
}

// MARK: notification-sounds (§39.7)

/// Plays a notification's sound with `NSSound`: by name it finds the macOS alert sounds (/System/Library/Sounds), which
/// `UNNotificationSound(named:)` does not (it looks only in Library/Sounds of the app and its container). "Default" is the
/// alert sound of System Settings › Sound; a sound that is gone plays that too.
@MainActor
enum NotificationSoundPlayer {
    static func play(_ sound: NotificationSound) {
        switch sound {
        case .none:
            return
        case .systemDefault:
            NSSound.beep()
        case .named(let name):
            guard let nsSound = NSSound(named: NSSound.Name(name)) else { NSSound.beep(); return }
            nsSound.stop()   // a shared instance: played again while it sounds, it would stay silent
            nsSound.play()
        }
    }
}
