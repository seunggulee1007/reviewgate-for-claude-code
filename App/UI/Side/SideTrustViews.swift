import AppKit
import ReviewGateCore
import SwiftUI

// MARK: wave4b w4b-side — docs/PROTOCOL.md §40.3 side questions you can trust (Electron: SidePanel.tsx, QuoteMenu.tsx)

/// At the top of a thread: "턴 N 시점" (orange once the main conversation went on) and [최신 대화로 다시 묻기] — asks the
/// follow-up being typed, else the last question, against the main conversation as it is now (the earlier Q&A goes along).
struct SideForkPointRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let thread: SideThread
    @Binding var typed: String

    var body: some View {
        if !thread.messages.isEmpty {
            let behind = SideTrust.forkIsBehind(thread, turnCount: store.finishedTurnsInChat)
            HStack(spacing: 8) {
                if let label = SideTrust.forkPointLabel(thread) {
                    Text(label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(behind ? Color.orange : Color.secondary)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background((behind ? Color.orange : Color.secondary).wash(colorScheme, light: 0.12, dark: 0.20), in: Capsule())
                        .help(behind ? Text("The main conversation went on since — this thread does not know the later turns.")
                                     : Text("This thread knows the main conversation up to this turn."))
                        .accessibilityIdentifier("Side fork point")
                }
                Button {
                    let text = typed
                    Task { if await store.side.refork(thread.id, typed: text) { typed = "" } }
                } label: {
                    Label("Ask again with the latest conversation", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(thread.isRunning || SideTrust.reforkQuestion(thread, typed: typed) == nil)
                .help(thread.isRunning ? Text("Wait for the answer first.")
                                       : Text("Asks again with the main conversation as it is now (the earlier questions and answers go along)."))
                .accessibilityIdentifier("Side refork")
                Spacer(minLength: 0)
            }
        }
    }
}

/// Before a chat switch while a side answer is coming (`AppState.confirmSideSwitch`): [채팅 바꾸기] / [취소].
enum SideSwitchAlert {
    @MainActor static func confirm(_ message: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message
        alert.addButton(withTitle: String(localized: "Switch chats"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        return alert.runModal() == .alertFirstButtonReturn
    }
}

/// A thread about a passage of Claude's answer: the passage, quoted.
struct SideQuoteHeader: View {
    let quote: SideQuoteAnchor

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(SideTrust.quoteLabel(quote)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(quote.text)
                .font(.callout)
                .lineLimit(8)
                .textSelection(.enabled)
                .padding(.leading, 8)
                .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.5)).frame(width: 2) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Side quote")
    }
}

/// Right-click on Claude's answer → "곁질문으로 묻기" about the whole answer (SwiftUI text gives no selection to a menu; the
/// thread quotes the answer). Disabled while another chat is shown read-only: its question would go to the running chat.
struct AskQuoteMenuItem: View {
    @Environment(AppState.self) private var store
    let text: String
    let turn: Int?

    var body: some View {
        Button("Ask about this answer in a side question", systemImage: "bubble.left.and.text.bubble.right") {
            guard let anchor = SideTrust.quoteAnchor(text, turn: turn) else { return }
            store.side.compose(anchor: anchor)
        }
        .disabled(store.viewedChat != nil)
        .help(store.viewedChat != nil ? Text("You are reading another chat — side questions go to the running chat.") : Text("Ask about this answer in a side question"))
    }
}
