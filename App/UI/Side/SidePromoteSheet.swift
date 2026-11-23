import SwiftUI
import ReviewGateCore

/// "Send to main" / "Add as note": the side session's summary as an editable instruction, where it goes, and — when the
/// main turn is running — "Add to queue" instead (the composer queue sends it once Claude is free).
struct SidePromoteSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    let draft: SidePromoteDraft
    @State private var text = ""
    @State private var acceptPending = false
    @FocusState private var focused: Bool

    private var live: SidePromoteDraft { store.side.draft ?? draft }
    private var isMessage: Bool { draft.target == .message }
    /// §57.7: a message for a terminal chat is pasted into its terminal (nothing sends into its TUI).
    private var pastesIntoTerminal: Bool { isMessage && store.isTerminalChat }
    private var chatTitle: String? { store.openTabs.first { $0.id == store.currentSessionId }?.displayTitle }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: isMessage ? "arrowshape.turn.up.left.fill" : "text.bubble.fill")
                    .foregroundStyle(isMessage ? Color.teal : Color.orange)
                Text(isMessage ? "Send to the main conversation" : "Add as a review note").font(.headline)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 10)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text("To").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Label {
                        TruncatedText(SideQuestionText.destination(draft.target, anchor: draft.anchor, chatTitle: chatTitle))   // MARK: r2-skills-side — P3-transcript-22
                    } icon: {
                        Image(systemName: isMessage ? "bubble.left.and.bubble.right" : "doc.text")
                    }
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.secondary.wash(colorScheme, light: 0.10, dark: 0.16), in: Capsule())
                    .accessibilityIdentifier("Promote destination")
                }
                TextEditor(text: $text)
                    .plainTextInput()   // MARK: r2-skills-side — PX-05: quotes and dashes stay as typed (code reaches Claude as is)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .frame(minHeight: 170, maxHeight: 320)
                    .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Color.teal.opacity(0.6) : Color.secondary.opacity(0.2)))
                    .focused($focused)
                    .accessibilityIdentifier("Promote text")
                Text(isMessage ? "Written by the side session as an instruction for Claude — edit it freely. “(side question에서 정리됨)” is added at the end."
                               : "Becomes a note for “Request changes”. “(side question에서 정리됨)” is added at the end.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if isMessage, !pastesIntoTerminal, store.pendingFiles.count > 0 {
                    Toggle(isOn: $acceptPending) {
                        Text("Accept the \(store.pendingFiles.count) pending files first")
                    }
                    .toggleStyle(.checkbox)
                    .disabled(!store.canAcceptAndSend)
                    .help("Off: sent as a question while the files stay under review")
                    .accessibilityIdentifier("Promote accept pending")
                }
                if let refusal = live.refusal {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text(verbatim: refusal)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        if live.canQueue {
                            Button("Add to queue", systemImage: "tray.and.arrow.down") {
                                store.side.queueDraft(text: text)
                            }
                            .controlSize(.small)
                            .help("Sent in order once Claude has finished the current turn")
                            .accessibilityIdentifier("Promote queue")
                        }
                    }
                    .padding(10)
                    .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("Promote refusal")
                }
            }
            .padding(.horizontal, 16)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { store.side.dismissDraft() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    let edited = text
                    // MARK: terminal-default (§57.7): the engine refuses `side_promote {as: "message"}` in a terminal chat —
                    // the instruction is pasted into its Claude Code's prompt (no Enter) and the sheet closes.
                    if pastesIntoTerminal {
                        if let why = store.pasteIntoTerminal(edited) { Toast.show(why, systemImage: "exclamationmark.triangle"); return }
                        Toast.show(NewChatKindText.pasted, systemImage: "terminal")
                        store.side.dismissDraft()
                        return
                    }
                    let accept = acceptPending
                    Task { _ = await store.side.sendDraft(text: edited, acceptPending: accept) }
                } label: {
                    if live.isSending {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(pastesIntoTerminal ? "Paste into the terminal" : isMessage ? "Send" : "Add note")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(isMessage ? .teal : .orange)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || live.isSending)
                // MARK: r2-skills-side — P3-transcript-15: what it does, then its key.
                .help(String.withKey(pastesIntoTerminal ? String(localized: "Paste into Claude Code's prompt in the terminal — press Return there to send it")
                                     : isMessage ? String(localized: "Send to the main conversation") : String(localized: "Add as a review note"), key: "⌘↩"))
                .accessibilityIdentifier("Promote send")
            }
            .padding(16)
        }
        .frame(width: 540)
        .onAppear {
            text = draft.text
            focused = true
        }
        // MARK: r2-skills-side — P3-transcript-29: closing the window (or quitting) with the sheet up loses its text; the
        // side-question drafts themselves are kept per chat (P3-transcript-28), so they list nothing.
        .registersUnsavedWork("sidePromote") {
            store.side.draft == nil ? nil : String(localized: "A side question's instruction or note is not sent yet. Closing discards it.")
        }
    }
}
