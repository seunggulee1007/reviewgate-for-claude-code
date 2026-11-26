import SwiftUI
import ReviewGateCore

// MARK: §70.4 — docs/PROTOCOL.md §70.4: ⌥T turns extended thinking on or off for the chat, as Option+T in Claude Code. The
// chip in the composer bar shows it (the brain, "Thinking off" when off) and toggles it on a click; its tooltip says the
// key and, for a model that always thinks, that the toggle has no effect there.

extension ComposerModel {
    /// ⌥T and the chip: the other state, and the line that says what happened (or why not).
    func toggleThinking(store: AppState) {
        Task {
            let result = await store.toggleThinking()
            let notice = result.notice
            if notice.warning { self.notice = notice.text } else { infoNotice = notice.text }
        }
    }
}

/// The composer bar's thinking chip (hidden with an engine that has no §70.4).
struct ThinkingChip: View {
    @Environment(AppState.self) private var store
    let composer: ComposerModel

    var body: some View {
        if let state = store.thinking {
            let blocker = store.thinkingBlocker
            Button { composer.toggleThinking(store: store) } label: {
                HStack(spacing: 3) {
                    Image(systemName: "brain")
                        .foregroundStyle(state.thinks ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.tertiary))
                    if !state.thinks {
                        Text(ThinkingText.chip(state)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(IconButtonStyle(padding: 2))
            .controlSize(.small)
            .fixedSize()
            .disabled(blocker != nil)
            .help(blocker ?? ThinkingText.help(state))
            .accessibilityLabel(Text(ThinkingText.chip(state)))
            .accessibilityHint(Text(blocker ?? ThinkingText.help(state)))
            .accessibilityIdentifier("Thinking toggle")
        }
    }
}
