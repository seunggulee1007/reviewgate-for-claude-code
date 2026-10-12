import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave4b w4-notify

/// What macOS lets ReviewGate show, as `AttentionCenter` last read it (launch, every activation, every post). Settings ›
/// Notifications and the window banner say so when notifications cannot reach the user (`NotificationHealth`).
@MainActor @Observable
final class NotificationStatusModel {
    static let shared = NotificationStatusModel()

    var system: SystemNotificationStatus = .unknown

    /// System Settings › Notifications › ReviewGate (the list of apps when this build has no bundle id).
    static func openSystemSettings() {
        let id = Bundle.main.bundleIdentifier ?? ""
        let direct = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")
        let list = URL(string: "x-apple.systempreferences:com.apple.preference.notifications")
        if let url = id.isEmpty ? list : direct, NSWorkspace.shared.open(url) { return }
        if let list { NSWorkspace.shared.open(list) }
    }
}

/// Top of a project window, once: "macOS에서 ReviewGate 알림이 꺼져 있어요" with [시스템 설정 열기] and [닫기] (closed for
/// good; Settings › Notifications keeps saying it).
struct NotificationsOffBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(AppSettings.Key.notificationsEnabled) private var notificationsEnabled = true
    @AppStorage(AppSettings.notificationsOffNoticeDismissedKey) private var dismissed = false
    private var status: NotificationStatusModel { NotificationStatusModel.shared }

    var body: some View {
        if NotificationHealth.showsWindowNotice(appEnabled: notificationsEnabled, system: status.system, dismissed: dismissed),
           let problem = NotificationHealth.problem(appEnabled: notificationsEnabled, system: status.system) {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "bell.slash")
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: problem.text).font(.callout)
                        Text(verbatim: problem.detail).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Button("Open System Settings") { NotificationStatusModel.openSystemSettings() }
                        .accessibilityIdentifier("Notifications off open settings")
                    Button("Close") { dismissed = true }
                        .help("Settings › Notifications keeps showing this")
                        .accessibilityIdentifier("Notifications off close")
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))   // the other banners' wash
                Divider()
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Notifications off banner")
        }
    }
}

/// Settings › Notifications below the main switch: what stands in the way in macOS, and one switch per group (permission
/// requests · questions · plans / finished work / the rest), all on by default.
struct NotificationSettingsRows: View {
    @AppStorage(AppSettings.Key.notificationsEnabled) private var notificationsEnabled = true
    @AppStorage(NotificationGroup.waiting.defaultsKey) private var waiting = true
    @AppStorage(NotificationGroup.turnEnd.defaultsKey) private var turnEnd = true
    @AppStorage(NotificationGroup.other.defaultsKey) private var other = true
    private var status: NotificationStatusModel { NotificationStatusModel.shared }

    var body: some View {
        if let problem = NotificationHealth.problem(appEnabled: notificationsEnabled, system: status.system) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: problem.text)
                    Text(verbatim: problem.detail).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Button("Open System Settings") { NotificationStatusModel.openSystemSettings() }
                    .accessibilityIdentifier("Notification settings open system settings")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Notifications off in macOS")
        }
        Toggle("Permission requests, questions and plans", isOn: $waiting)
            .disabled(!notificationsEnabled)
            .accessibilityIdentifier("Notify waiting")
        Toggle("When work finishes", isOn: $turnEnd)
            .disabled(!notificationsEnabled)
            .accessibilityIdentifier("Notify turn end")
        Toggle("Everything else (errors, side questions, other sessions, subagents)", isOn: $other)
            .disabled(!notificationsEnabled)
            .accessibilityIdentifier("Notify other")
        Text("Clicking a notification opens its window, chat and card.")
            .font(.caption).foregroundStyle(.secondary)
        // A Focus (Do Not Disturb) silences them too, and an app cannot read it without asking for another permission.
        Text("If notifications do not appear, check Focus (Do Not Disturb) in Control Center too.")
            .font(.caption).foregroundStyle(.secondary)
            .onChange(of: notificationsEnabled) { _, on in
                if on { AttentionCenter.shared.prepare() }   // macOS asks now, not at the first notification
            }
    }
}

extension WindowModel {
    /// A clicked notification (the window is already in front): the review tab, its chat and the card / summary the chat
    /// scrolls to (`notificationReveal`). wave4b integration (§39.2 × §39.6): a click never switches the Claude session —
    /// it shows the chat `AttentionReveal.chatToShow` picks, as a tab click does.
    func openFromNotification(_ target: AttentionTarget, store: AppState) {
        if !tab.showsReview { tab = .changes }
        let show = AttentionReveal.chatToShow(for: target, currentChatId: store.currentSessionId, openTabIds: store.openTabs.map(\.id))
        guard let show, show != store.shownChatId else { revealNotified(target); return }
        if show == store.currentSessionId {
            store.stopViewing()   // the running chat again: its card is there
            revealNotified(target)
            return
        }
        Task { [weak self] in
            await store.viewChat(id: show)   // a chat the session has left since, read-only; its saved rows are read first
            self?.revealNotified(target)
        }
    }

    private func revealNotified(_ target: AttentionTarget) {
        notificationReveal = target
        notificationRevealTick &+= 1
    }
}
