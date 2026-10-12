import SwiftUI
import ReviewGateCore

enum SidePanel {
    /// `@AppStorage` key: the side-question inspector is open (remembered across launches).
    static let storageKey = "sidePanelVisible"
}

/// §21 "곁질문" inspector: the current chat's side threads (list), one thread (anchor header, streaming answer, tool calls,
/// follow-up, promote) or a new question on an anchor. Nothing here changes the main conversation until "Send to main".
struct SidePanelView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        let side = store.side
        VStack(spacing: 0) {
            header
            Divider()
            Group {
                if side.isComposing {
                    SideComposeView(anchor: side.composeAnchor)
                } else if let thread = side.selectedThread {
                    SideThreadView(thread: thread)
                        .id(thread.id)
                } else {
                    threadList
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(item: Binding(get: { store.side.draft }, set: { if $0 == nil { store.side.dismissDraft() } })) { draft in
            SidePromoteSheet(draft: draft)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Side panel")
    }

    // MARK: Header

    private var header: some View {
        let side = store.side
        return HStack(spacing: 8) {
            if side.isComposing || side.selectedThread != nil {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { side.showList() }
                } label: {
                    Image(systemName: "chevron.left").font(.callout.weight(.semibold))
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("All side questions")
                .accessibilityLabel("All side questions")
                .accessibilityIdentifier("Side back")
            }
            Label("Side questions", systemImage: "bubble.left.and.text.bubble.right")
                .font(.headline)
                .lineLimit(1)
                .fixedSize()
            if side.runningCount > 0 {
                HStack(spacing: 3) {
                    PulseDot(color: .teal, size: 4).frame(width: 8, height: 8)
                    Text("\(side.runningCount) answering").font(.caption2.weight(.semibold))
                }
                .foregroundStyle(Color.teal)
                .fixedSize()
            }
            Spacer(minLength: 4)
            if store.hud.sideCostUSD > 0 {
                Text(verbatim: SideQuestionText.cost(store.hud.sideCostUSD))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .help(Text("Side questions in this session — not part of the session cost"))
                    .accessibilityIdentifier("Side cost")
            }
            Button {
                side.compose(anchor: side.selectionAnchor)
            } label: {
                Image(systemName: "square.and.pencil")
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(store.projectInfo == nil)
            .help("New side question (⌥⌘/)")
            .accessibilityLabel("New side question")
            .accessibilityIdentifier("New side question")
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
    }

    // MARK: List

    @ViewBuilder
    private var threadList: some View {
        let threads = store.side.threads
        if threads.isEmpty {
            emptyState
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(threads) { thread in
                        SideThreadRow(thread: thread) { store.side.select(thread.id) }
                    }
                }
                .padding(10)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Color.teal.opacity(0.8))
            Text("Ask about a change without leaving the review")
                .font(.callout.weight(.semibold))
                .multilineTextAlignment(.center)
            Text("Side questions read the code and the conversation so far but never change files or the main chat. Send the conclusion to the main conversation when you are ready.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("New side question", systemImage: "square.and.pencil") { store.side.compose(anchor: store.side.selectionAnchor) }
                .controlSize(.small)
                .disabled(store.projectInfo == nil)
                .padding(.top, 2)
            Text("Tip: hover a file, a part of a diff or a line and click “Why?”.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A thread in the list: anchor chip, title, the last answer's first line, status, cost and promotion.
private struct SideThreadRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let thread: SideThread
    let onOpen: () -> Void
    @State private var hovering = false
    /// The right-click "Delete Side Question" asks first, as the thread's own trash button does.
    @State private var confirmDelete = false

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    SideAnchorChip(anchor: thread.anchor, toolName: toolName)
                    Spacer(minLength: 4)
                    status
                }
                Text(verbatim: thread.title.isEmpty ? String(localized: "Side question") : thread.title)
                    .font(.callout.weight(.medium))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let answer = lastAnswer {
                    Text(verbatim: answer)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                HStack(spacing: 8) {
                    Text("\(thread.messages.filter { $0.role == .user }.count) questions")
                    if thread.costUSD > 0 { Text(verbatim: SideQuestionText.cost(thread.costUSD)) }
                    if let date = thread.updatedDate {
                        Text(date, format: .relative(presentation: .named))
                    }
                    Spacer(minLength: 0)
                    if let promotion = thread.promotions.last {
                        Label(promotion.target == .message ? "Sent" : "Noted", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    } else if store.side.queuedThreadIds.contains(thread.id) {
                        Label("Queued", systemImage: "tray.and.arrow.down.fill").foregroundStyle(.orange)
                    }
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(hovering ? Color.secondary.opacity(colorScheme == .dark ? 0.16 : 0.12) : Color.cardFill(colorScheme)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(thread.isRunning ? Color.teal.opacity(0.45) : Color.clear))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Delete Side Question", systemImage: "trash", role: .destructive) { confirmDelete = true }
        }
        .confirmationDialog("Delete this side question?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await store.side.close(thread.id) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The thread and its answers are removed. Nothing in the main conversation changes.")
        }
        .accessibilityIdentifier("Side thread row")
    }

    private var toolName: String? {
        thread.anchor?.toolUseId.flatMap { id in store.transcriptIndex.calls[id]?.name }   // MARK: wave7 w7-chat — §45.1: the shared index
    }

    private var lastAnswer: String? {
        let text = thread.messages.last(where: { $0.role == .assistant })?.text ?? store.side.live[thread.id]?.text
        let line = text?.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "#*> -").union(.whitespaces)) }
            .first { !$0.isEmpty }
        // A one-line preview reads as plain text: inline markdown marks dropped.
        return line.map { $0.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "") }
    }

    @ViewBuilder
    private var status: some View {
        switch thread.status {
        case .running:
            HStack(spacing: 3) {
                PulseDot(color: .teal, size: 4).frame(width: 8, height: 8)
                Text("Answering").font(.caption2.weight(.semibold))
            }
            .foregroundStyle(Color.teal)
        case .error:
            Label("Failed", systemImage: "exclamationmark.triangle.fill")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.orange)
        case .idle:
            EmptyView()
        }
    }
}

/// A new question: the anchor it is about, one-click suggestions and the field.
struct SideComposeView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let anchor: SideAnchor?
    @FocusState private var focused: Bool
    /// The anchor the user removed with ×: asks in general.
    @State private var anchorCleared = false

    private var effectiveAnchor: SideAnchor? { anchorCleared ? nil : anchor }
    /// The question is the store's (`composeDraft`): ‹, the panel toggle or the agent panel do not lose it.
    private var question: String {
        get { store.side.composeDraft }
        nonmutating set { store.side.composeDraft = newValue }
    }

    // MARK: wave4 w4-check3
    /// The anchored call's tool (a subagent's call gets questions about its work): from the chat, else the HUD's agents.
    private var anchorToolName: String? {
        guard let id = effectiveAnchor?.toolUseId else { return nil }
        // MARK: wave7 w7-chat — §45.1: a lookup in the shared index (this runs on every keystroke of the field)
        if let name = store.transcriptIndex.calls[id]?.name { return name }
        return store.agents.contains { $0.toolUseId == id } ? "Agent" : nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("About").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    if let effectiveAnchor {
                        SideAnchorHeader(anchor: effectiveAnchor, onClear: { anchorCleared = true })
                    } else {
                        SideAnchorChip(anchor: nil)
                    }
                    // wave3 mac-agents (§36.10, SME-02): only what the fork will know — never the review list.
                    SideForkKnowsLine()
                }
                VStack(alignment: .leading, spacing: 8) {
                    TextField("What would you like to know?", text: Binding(get: { question }, set: { question = $0 }), axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .lineLimit(3...10)
                        .focused($focused)
                        .padding(10)
                        .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Color.teal.opacity(0.6) : Color.secondary.opacity(0.2)))
                        .onSubmit(send)
                        .accessibilityIdentifier("Side question field")
                    FlowLayout(spacing: 6) {
                        ForEach(SideQuestionText.suggestions(for: effectiveAnchor, toolName: anchorToolName), id: \.self) { suggestion in
                            Button {
                                question = suggestion
                                send()
                            } label: {
                                Text(verbatim: suggestion)
                                    .font(.caption)
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(Color.teal.wash(colorScheme, light: 0.10, dark: 0.16), in: Capsule())
                                    .foregroundStyle(Color.teal)
                            }
                            .buttonStyle(.plain)
                            .disabled(store.side.isAskingNew)
                        }
                    }
                    if let error = store.side.errors[""] {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("Side compose error")
                    }
                    HStack {
                        Label("Read-only · the main chat is not affected", systemImage: "lock")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 4)
                        Button {
                            send()
                        } label: {
                            if store.side.isAskingNew {
                                ProgressView().controlSize(.small)
                            } else {
                                Label("Ask", systemImage: "arrow.up")
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.teal)
                        .controlSize(.small)
                        .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.side.isAskingNew)
                        .help("Ask (↩)")
                        .accessibilityIdentifier("Side ask")
                    }
                }
            }
            .padding(12)
        }
        .onAppear { focused = true }
        .onChange(of: store.side.focusTick) { _, _ in focused = true }
        .onChange(of: anchor) { _, _ in anchorCleared = false }
    }

    private func send() {
        let text = question
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !store.side.isAskingNew else { return }
        let target = effectiveAnchor
        Task { await store.side.ask(text, anchor: target) }   // asked: the store empties the field
    }
}
