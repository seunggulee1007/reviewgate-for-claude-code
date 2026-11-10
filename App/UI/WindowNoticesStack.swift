import SwiftUI
import ReviewGateCore

/// r2-review-flow M27: the window's information banners — notifications off in macOS, a new Claude CLI not verified yet, a
/// ReviewGate update, a workbench setup that failed, a project in a temporary folder — each took a full-width row above the
/// chat; at 637 pt three of them left the conversation a few lines. One of them shows as before; two or more fold into one
/// "알림 N개" chip whose popover holds them all (each with its own buttons). Errors, the commit banner, a reject's undo and the
/// review notices stay banners.
struct WindowNoticesStack: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    // Observed so the count follows a close in the popover or another window, as the banners themselves do.
    @AppStorage(AppSettings.Key.notificationsEnabled) private var notificationsEnabled = true
    @AppStorage(AppSettings.notificationsOffNoticeDismissedKey) private var notificationsNoticeDismissed = false
    @AppStorage(AppSettings.Key.dismissedCliVersions) private var dismissedCliVersions = ""
    @AppStorage(AppSettings.Key.claudePath) private var claudePath = ""
    @State private var showsAll = false

    private enum Notice: CaseIterable { case notifications, cliVersion, appUpdate, setupReport, transient }

    private var active: [Notice] {
        let _ = (dismissedCliVersions, claudePath)
        return Notice.allCases.filter { notice in
            switch notice {
            case .notifications:
                NotificationHealth.showsWindowNotice(appEnabled: notificationsEnabled, system: NotificationStatusModel.shared.system,
                                                     dismissed: notificationsNoticeDismissed)
                    && NotificationHealth.problem(appEnabled: notificationsEnabled, system: NotificationStatusModel.shared.system) != nil
            case .cliVersion: store.cliVersionBanner != nil
            case .appUpdate: AppUpdateController.shared.bannerRelease != nil
            case .setupReport: WorkbenchSetupReports.shared.report(for: store.projectURL) != nil
            case .transient: store.projectURL.map { RecentProjects.isTransient($0.path) } ?? false
            }
        }
    }

    var body: some View {
        if active.count >= 2 {
            HStack(spacing: 6) {
                Button { showsAll.toggle() } label: {
                    Label(String(localized: "\(active.count) notices"), systemImage: "bell.badge.fill")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.orange.wash(colorScheme, light: 0.18, dark: 0.26), in: Capsule())
                        .foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
                .hoverHighlight(cornerRadius: 9)
                .help("The window's notices — the CLI version, an update, notifications, a workbench's setup — click to see them")
                .accessibilityIdentifier("Window notices chip")
                .popover(isPresented: $showsAll, arrowEdge: .bottom) {
                    ScrollView {
                        VStack(spacing: 0) { banners }
                            .frame(width: 520)
                    }
                    .frame(maxHeight: 460)
                    .accessibilityIdentifier("Window notices popover")
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(Color.orange.wash(colorScheme, light: 0.06, dark: 0.14))
            Divider()
        } else {
            banners
        }
    }

    /// The banners as they are (each shows only when it has something to say, with its own divider).
    @ViewBuilder private var banners: some View {
        NotificationsOffBanner()   // MARK: wave4b w4-notify — macOS turned ReviewGate's notifications off (once)
        CliVersionBannerView()   // wave3 mac-session (§36.8): "새 CLI x — 아직 검증 안 됨" (with its divider)
        AppUpdateBannerView()   // MARK: app-update (§48) — "ReviewGate x is available" (with its divider)
        WorkbenchSetupReportBanner()   // wave3 mac-flow (§36.12): this new workbench's setup failed — the log
        TransientProjectBanner()   // a project in /tmp: macOS sweeps it, .git included
    }
}
