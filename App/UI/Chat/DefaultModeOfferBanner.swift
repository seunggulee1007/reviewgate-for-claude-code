import SwiftUI
import ReviewGateCore

/// wave1 mac-perms (client handoff §2.8): the first time a project is opened, when the terminal starts Claude Code in a
/// mode ReviewGate offers (`permissions.defaultMode`, via `permission_rules`) and this session runs in another one:
/// "터미널처럼 auto 모드로 시작할까요?" — [예] switches and remembers it for the project, × is not asked again (§56.5: one line,
/// no settings key in the text).
struct DefaultModeOfferBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(width: 0, height: 0)   // keeps the `.task` alive while nothing is offered
            if let mode = store.defaultModeOffer, mode != store.permissionMode {
                // §56.5: one line — the question, Yes, and × (no: not asked again); why it asks is in the tooltip.
                HStack(spacing: 8) {
                    Image(systemName: mode.symbolName).foregroundStyle(Color.accentColor)
                    Text("Start in \(mode.displayName) mode like the terminal?")
                        .font(.callout)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(String(localized: "Claude Code starts in this mode in your terminal: \(mode.helpText)"))
                    Spacer(minLength: 8)
                    Button("Yes") { store.acceptDefaultModeOffer() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(!store.canSetPermissionMode)
                        .help(store.canSetPermissionMode
                              ? String(localized: "Switch this session and remember the mode for this project")
                              : String(localized: "The mode can be changed once Claude is idle"))
                        .accessibilityIdentifier("Default mode offer yes")
                    Button { store.declineDefaultModeOffer() } label: {
                        Image(systemName: "xmark").font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.icon)
                    .help("Keep the current mode; this project will not be asked again")
                    .accessibilityLabel("No")
                    .accessibilityIdentifier("Default mode offer no")
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Color.accentColor.wash(colorScheme, light: 0.08, dark: 0.16), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor.wash(colorScheme, light: 0.35, dark: 0.45)))
                .padding(.horizontal, 12).padding(.top, 8)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("Default mode offer")
            }
        }
        .task(id: store.projectInfo?.path) { await store.checkDefaultModeOffer() }
    }
}
