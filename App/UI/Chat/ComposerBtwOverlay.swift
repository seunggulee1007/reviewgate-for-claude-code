import SwiftUI
import AppKit
import ReviewGateCore

/// MARK: composer parity — docs/PROTOCOL.md §56.1: the /btw answer over the message box, never in the chat. While the question
/// is on its way it says so with Cancel; then the question, the answer (selectable) and how it was answered, with Copy and
/// Close. Esc, ↩ or Space in an empty box closes it too (`ChatComposer.handleKey`).
struct ComposerBtwOverlay: View {
    @Environment(AppState.self) private var store
    let overlay: BtwOverlay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if case let .answered(answer) = overlay {
                ScrollView {
                    MarkdownText(text: answer.answer, secondary: answer.synthetic)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
                .fixedSize(horizontal: false, vertical: true)
                Text(answer.viaFork ? "Answered without tools by a copy of the conversation — not added to the chat"
                     : "Answered without tools from the conversation so far — not added to the chat")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
        .padding(8)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor.opacity(0.45)) }
        .contextMenu { menu }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Side answer")
    }

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: "/btw")
                .font(.caption.monospaced().weight(.semibold))
                .foregroundStyle(Color.accentColor)
            Text(verbatim: question)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.tail)
                .help(question)
                .frame(maxWidth: .infinity, alignment: .leading)
            switch overlay {
            case .asking:
                ProgressView().controlSize(.mini)
                Text("Asking on the side…").font(.caption).foregroundStyle(.secondary).fixedSize()
                Button("Cancel") { store.dismissBtw() }
                    .controlSize(.small)
                    .help("Stop waiting — the answer is dropped when it comes")
                    .accessibilityIdentifier("Cancel side question")
            case let .answered(answer):
                Button { copy(answer.answer) } label: { Image(systemName: "doc.on.doc") }
                    .buttonStyle(.icon)
                    .help("Copy the answer")
                    .accessibilityLabel("Copy the answer")
                    .accessibilityIdentifier("Copy side answer")
                Button { store.dismissBtw() } label: { Image(systemName: "xmark").font(.caption2.weight(.semibold)) }
                    .buttonStyle(.icon)
                    .help("Close (esc · ↩ · space) — /btw alone shows it again")
                    .accessibilityLabel("Close the side answer")
                    .accessibilityIdentifier("Close side answer")
            }
        }
    }

    @ViewBuilder
    private var menu: some View {
        if case let .answered(answer) = overlay {
            Button("Copy the answer", systemImage: "doc.on.doc") { copy(answer.answer) }
            Button("Copy the question", systemImage: "questionmark.bubble") { copy(answer.question) }
            Divider()
            Button("Close", systemImage: "xmark") { store.dismissBtw() }
        } else {
            Button("Cancel", systemImage: "xmark") { store.dismissBtw() }
        }
    }

    private var question: String {
        switch overlay {
        case let .asking(question): question
        case let .answered(answer): answer.question
        }
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// §56.1: the overlay's place above the message box (a view of its own, so the composer's body stays small).
struct ComposerBtwSlot: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if let overlay = store.btwOverlay {
            ComposerBtwOverlay(overlay: overlay)
                .transition(.opacity)
        }
    }
}

/// §56.1: a question that got no answer says why in the notice line and comes back into an empty box; another chat closes
/// the answer (it was this chat's).
struct ComposerBtwHooks: ViewModifier {
    @Environment(AppState.self) private var store
    let composer: ComposerModel

    func body(content: Content) -> some View {
        content
            .onChange(of: store.btwFailure?.id) { _, _ in
                guard let failure = store.btwFailure else { return }
                composer.notice = failure.text
                if composer.draft.isEmpty {
                    composer.draft = "/btw " + failure.question
                    composer.caretRequest = (composer.draft as NSString).length
                }
            }
            .onChange(of: store.draftChatId) { _, _ in store.dismissBtw() }
    }
}
