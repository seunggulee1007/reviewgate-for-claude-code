import SwiftUI
import ReviewGateCore

// MARK: wave6 w6-terminal
// docs/PROTOCOL.md §44.1: the terminal's mode line under the composer — "⏵⏵ 자동 모드 (shift+tab 전환)", "⏸ 계획 모드 — 승인하면
// 자동 모드로 돌아가요 (shift+tab 전환)". It follows the engine's mode at once, plan mode Claude entered by itself included;
// ⇧⇥ in the composer cycles default → accept edits → plan → auto (the mode menu next to Send does the same with the mouse).

struct ComposerModeLineView: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let line = store.composerModeLine
        Text(verbatim: line.text)
            .font(.caption)
            .foregroundStyle(color(line.tone))
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 4)
            .help("Shift+Tab in the message box switches the permission mode")
            .accessibilityIdentifier("Composer mode line")
    }

    private func color(_ tone: ComposerModeTone) -> Color {
        switch tone {
        case .auto: .orange
        case .acceptEdits: .purple
        case .plan: .teal
        case .plain: .secondary
        }
    }
}
