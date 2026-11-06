import SwiftUI
import ReviewGateCore

// MARK: wave4b w4b-auto
// docs/PROTOCOL.md §39.5: one mode menu for the composer picker and the HUD chip. Picking a mode switches now — while
// Claude works too, from its next step — except plan mode during a turn, which waits for the turn's end; a refused switch
// says why.

/// The entries: every mode with its one-line help (auto: "명령은 Claude Code의 자동 판단으로 실행돼요. 파일 변경은 그대로
/// 리뷰돼요."), the current — or waiting — one checked; while Claude works a last line says when a pick applies.
struct PermissionModeMenuItems: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let chosen = store.scheduledPermissionMode ?? store.permissionMode
        ForEach(PermissionMode.allCases) { mode in
            Button {
                store.pickPermissionMode(mode)
            } label: {
                if mode == chosen {
                    Label("\(mode.displayName) — \(mode.helpText)", systemImage: "checkmark")
                } else {
                    Text(verbatim: "\(mode.displayName) — \(mode.helpText)")
                }
            }
            .accessibilityIdentifier("Permission mode \(mode.rawValue)")
        }
        if !store.canSetPermissionMode {
            Divider()
            Text(AutoModeText.busyHelp(switchesNow: store.canSetPermissionMode(to: .auto)))
        }
    }
}

/// What the picker and the chip say about the mode.
@MainActor enum PermissionModeLabels {
    /// "자동", or "기본 → 자동" while a pick waits for the turn to end.
    static func title(_ store: AppState) -> String {
        guard let next = store.scheduledPermissionMode else { return store.permissionMode.displayName }
        return "\(store.permissionMode.displayName) → \(next.displayName)"
    }

    /// The tooltip: why the last switch was refused, else the waiting pick, else the mode's help.
    static func help(_ store: AppState) -> String {
        if let refusal = store.permissionModeRefusal { return refusal }
        if let next = store.scheduledPermissionMode { return AutoModeText.scheduledText(next) }
        return String(localized: "Permission mode: \(store.permissionMode.helpText)")
    }
}

/// The HUD's mode chip (shown while the mode is not `default` or a pick waits): the same menu as the composer's picker.
struct HUDModeChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        Menu {
            PermissionModeMenuItems()
        } label: {
            Label(PermissionModeLabels.title(store), systemImage: (store.scheduledPermissionMode ?? store.permissionMode).symbolName)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize().layoutPriority(1)
        .padding(.horizontal, 6).padding(.vertical, 1)
        .background(Color.accentColor.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
        .foregroundStyle(Color.accentColor)
        .disabled(!store.canPickPermissionMode)
        .help(PermissionModeLabels.help(store))
        .accessibilityLabel(String(localized: "Permission mode: \(PermissionModeLabels.title(store))"))
        .accessibilityIdentifier("HUD mode")
    }
}
