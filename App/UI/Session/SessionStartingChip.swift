import SwiftUI
import ReviewGateCore

/// HUD: "Claude Code 시작 중…" while the CLI has not answered initialize (PROTOCOL §30 `state.session.ready`). The
/// slow-start hint (`cli_start_slow`) takes its place once it comes.
struct SessionStartingChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        // wave3 mac-session (§36.7): "serena 기다리는 중" (`ExtensionsWaitingChip`) says more once the CLI names what it waits for.
        if store.isClaudeCodeStarting, store.transientNotice == nil, store.extensionsWaitingOn == nil {
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text(verbatim: store.claudeCodeStartingText).lineLimit(1)
            }
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Color.blue.wash(colorScheme, light: 0.12, dark: 0.22), in: Capsule())
            .foregroundStyle(Color.blue)
            .fixedSize()
            .accessibilityElement(children: .combine)
            .accessibilityLabel(store.claudeCodeStartingText)
            .accessibilityIdentifier("HUD starting")
        }
    }
}
