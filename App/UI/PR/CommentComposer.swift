import SwiftUI

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
