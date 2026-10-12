import SwiftUI
import ReviewGateCore

/// wave1 mac-perms (client handoff §2.8): the first time a project is opened, when the terminal starts Claude Code in a
/// mode ReviewGate offers (`permissions.defaultMode`, via `permission_rules`) and this session runs in another one:
/// "터미널처럼 auto 모드로 시작할까요?" — [예] switches and remembers it for the project, [아니요] is not asked again.
struct DefaultModeOfferBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(width: 0, height: 0)   // keeps the `.task` alive while nothing is offered
            if let mode = store.defaultModeOffer, mode != store.permissionMode {
                HStack(spacing: 10) {
                    Image(systemName: mode.symbolName).foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Start in \(mode.displayName) mode like the terminal?")
                            .font(.callout.weight(.semibold))
                        Text("Claude Code starts in this mode in your terminal (permissions.defaultMode): \(mode.helpText)")
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Button("No") { store.declineDefaultModeOffer() }
                        .help("Keep the current mode; this project will not be asked again")
                        .accessibilityIdentifier("Default mode offer no")
                    Button("Yes") { store.acceptDefaultModeOffer() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!store.canSetPermissionMode)
                        .help(store.canSetPermissionMode
                              ? String(localized: "Switch this session and remember the mode for this project")
                              : String(localized: "The mode can be changed once Claude is idle"))
                        .accessibilityIdentifier("Default mode offer yes")
                }
                .padding(10)
                .background(Color.accentColor.wash(colorScheme, light: 0.08, dark: 0.16), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.wash(colorScheme, light: 0.35, dark: 0.45)))
                .padding(.horizontal, 12).padding(.top, 10)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("Default mode offer")
            }
        }
        .task(id: store.projectInfo?.path) { await store.checkDefaultModeOffer() }
    }
}
