import ReviewGateCore
import SwiftUI

// MARK: wave4b w4b-side — §40.3 Settings › Side questions: the model from the session's list, the web off by default.

/// The side model (from an open window's model list; a free-text field while no session has listed models) and the web
/// in side questions with what each choice lets them do. Electron: `SideSettings.tsx`.
struct SideSettingsRows: View {
    @Binding var sideModel: String
    @AppStorage(AppSettings.Key.sideWeb) private var sideWeb = SideWebMode.off.rawValue
    let onChange: () -> Void

    private var models: [ModelOption] { WorkbenchRegistry.shared.allStores.first(where: { !$0.availableModels.isEmpty })?.availableModels ?? [] }

    var body: some View {
        Group {
            if models.isEmpty {
                TextField("Model", text: $sideModel, prompt: Text("Same as the main session"))
                    .accessibilityIdentifier("Side model")
            } else {
                Picker("Model", selection: $sideModel) {
                    ForEach(SideTrust.modelChoices(models, current: sideModel)) { choice in
                        Text(choice.label).tag(choice.value)
                    }
                }
                .accessibilityIdentifier("Side model")
            }
            Text("Same model as the main conversation: it reuses the conversation's cache and answers fastest. Another model (e.g. haiku) costs less per token but reads the whole conversation again.")
                .font(.caption).foregroundStyle(.secondary)
            Picker("Web in side questions", selection: $sideWeb) {
                ForEach(SideWebMode.allCases) { mode in
                    Text(mode.label).tag(mode.rawValue)
                }
            }
            .accessibilityIdentifier("Side web")
            Text(SideWebMode(stored: sideWeb).help)
                .font(.caption)
                .foregroundStyle(SideWebMode(stored: sideWeb) == .on ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                .accessibilityIdentifier("Side web help")
        }
        .onChange(of: sideWeb) { _, _ in onChange() }
    }
}
