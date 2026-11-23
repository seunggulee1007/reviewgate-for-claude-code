import SwiftUI
import ReviewGateCore

/// Inline editor for a new draft comment or a reply, shown beneath a diff line.
/// ⌘↩ submits, Esc cancels. Submission is disabled while the text is blank.
struct CommentComposer: View {
    @Environment(\.colorScheme) private var colorScheme
    /// Primary button title (already localized), e.g. "Add to review" or "Reply".
    let submitTitle: String
    /// Stable accessibility identifier for the primary button (not localized).
    let submitID: String
    var isBusy = false
    /// The text it opens with (editing a note, a note being written that was put aside).
    var initialText = ""
    /// Every change of the text (the review diff keeps a note being written across files and views).
    var onTextChange: ((String) -> Void)? = nil
    let onSubmit: (String) -> Void
    let onCancel: () -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            TextEditor(text: $text)
                .font(.callout)
                .frame(minHeight: 60, maxHeight: 160)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
                .focused($focused)
                .accessibilityIdentifier("Comment text")
            HStack(spacing: 8) {
                Text("⌘↩ to \(submitTitle.lowercased())").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                if isBusy { ProgressView().controlSize(.small) }
                Button("Cancel", role: .cancel, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                    .controlSize(.small)
                    .accessibilityIdentifier("Cancel comment")
                Button(submitTitle) { onSubmit(trimmed) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(trimmed.isEmpty || isBusy)
                    .accessibilityIdentifier(submitID)
            }
        }
        .padding(8)
        .background(Color.secondary.wash(colorScheme, light: 0.06, dark: 0.12), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.wash(colorScheme, light: 0.25, dark: 0.35)))
        .onAppear {
            if text.isEmpty { text = initialText }
            focused = true
        }
        .onChange(of: text) { _, new in onTextChange?(new) }
    }
}

/// §60: "Leave a comment" under the PR's Conversation — a general comment on the PR (`pr_comment`). ⌘↩ posts; the text
/// is the store's (`conversationDraft`, kept across the PR tab's views) and is cleared only once the comment went out —
/// a refusal shows under the field and the text stays.
struct ConversationComposer: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(PRStore.self) private var store
    /// The refusal of the last post, in the user's words.
    @State private var refusal: String?
    /// Set from the click until the reply: the engine's `isCommenting` may come a moment later.
    @State private var posting = false

    private var busy: Bool { posting || store.isCommenting }

    /// Why "Comment" cannot be pressed now; nil = it can.
    private var blocker: String? {
        if busy { return String(localized: "Posting the comment…") }
        if store.conversationDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "Write a comment first")
        }
        return nil
    }

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 6) {
            Text("Leave a comment").font(.callout.weight(.semibold))
            TextEditor(text: $store.conversationDraft)
                .font(.callout)
                .frame(minHeight: 70, maxHeight: 200)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
                .accessibilityLabel("Leave a comment")
                .accessibilityIdentifier("PR comment text")
            HStack(spacing: 8) {
                Text("Markdown · ⌘↩ to comment").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Comment") { send() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(blocker != nil)
                    .help(blocker ?? String(localized: "Posts this comment on the PR's conversation on GitHub (⌘↩)"))
                    .accessibilityIdentifier("Post PR comment")
            }
            if let refusal {
                Label(refusal, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("PR comment refusal")
            }
        }
        .padding(8)
        .background(Color.secondary.wash(colorScheme, light: 0.06, dark: 0.12), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.wash(colorScheme, light: 0.25, dark: 0.35)))
        .onChange(of: store.selectedSummary?.id) { _, _ in refusal = nil }
    }

    private func send() {
        guard blocker == nil else { return }
        let body = store.conversationDraft
        refusal = nil
        posting = true
        Task {
            let why = await store.comment(body)
            posting = false
            if let why {
                refusal = why
            } else if store.conversationDraft == body {   // what was typed meanwhile stays
                store.conversationDraft = ""
            }
        }
    }
}
