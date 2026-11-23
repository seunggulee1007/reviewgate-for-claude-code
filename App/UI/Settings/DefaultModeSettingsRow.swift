import SwiftUI
import ReviewGateCore

// MARK: wave4b w4b-auto (docs/PROTOCOL.md §39.5)

/// Settings › Permissions › "시작 모드": the mode a project opened for the first time starts in (what `hello` and
/// `open_project` seed the engine with, `AppSettings.startPermissionMode`); each project then keeps the mode picked there
/// (§11). Until it is set, the row shows the last mode used anywhere — what a new project would start in.
struct DefaultModeSettingsRow: View {
    @State private var mode: PermissionMode = AppSettings.startPermissionMode() ?? AppSettings.permissionMode()

    var body: some View {
        Group {
            Picker(selection: $mode) {
                ForEach(PermissionMode.allCases) { m in
                    Text(m.displayName).tag(m)
                }
            } label: { SettingLabel("startPermissionMode") }   // §55.11: "New projects start in this mode…" in its ⓘ
            .onChange(of: mode) { _, m in AppSettings.setStartPermissionMode(m) }
            .accessibilityIdentifier("Default permission mode")
            .settingAnchor("startPermissionMode")
            Text(verbatim: "\(mode.displayName): \(mode.helpText)")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
