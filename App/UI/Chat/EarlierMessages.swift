import SwiftUI
import ReviewGateCore

/// §45.1: [이전 대화 더 보기] over the first row shown of a long chat — the rows before it are in the app, not made; each
/// press shows a page more (`TranscriptViewState.showEarlier`), the view kept on the row that was on top. `later`: under
/// the last row shown after a jump far back, [다음 대화 더 보기] (`showLater`).
struct EarlierRowsButton: View {
    let later: Bool
    let count: Int
    let action: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            Button(action: action) {
                HStack(spacing: 5) {
                    Image(systemName: later ? "arrow.down.circle" : "arrow.up.circle")
                    Text(later ? LocalizedStringKey("Show later messages") : LocalizedStringKey("Show earlier messages"))
                }
            }
            .controlSize(.small)
            .help(later ? String(localized: "Show the later rows of this chat (\(count) more)")
                  : String(localized: "Show the earlier rows of this chat (\(count) more)"))
            .accessibilityIdentifier(later ? "Show later rows" : "Show earlier rows")
            Spacer(minLength: 0)
        }
        .padding(later ? .top : .bottom, 2)
    }
}

/// MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 [이전 대화 더 보기] over the oldest shown row: each press brings the 200
/// rows before it (dimmed like restored rows); `onLoaded` gets the row that was on top, so the view stays on it. A
/// refusal shows one line next to it. Hidden with an engine before §38.3 or when the chat starts here.
struct EarlierMessagesButton: View {
    @Environment(AppState.self) private var store
    let onLoaded: (UUID) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            Button {
                let first = store.transcript.first?.id
                Task {
                    if await store.loadEarlierMessages(), let first { onLoaded(first) }
                }
            } label: {
                HStack(spacing: 5) {
                    if store.transcriptPaging.loading {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.up.circle")
                    }
                    Text("Show earlier messages")
                }
            }
            .controlSize(.small)
            .disabled(store.transcriptPaging.loading)
            .accessibilityIdentifier("Show earlier messages")
            if let error = store.transcriptPaging.error {
                Text(verbatim: error).font(.caption).foregroundStyle(.orange).lineLimit(1)
                    .accessibilityIdentifier("Earlier messages error")
            }
            Spacer(minLength: 0)
        }
        .padding(.bottom, 2)
    }
}
