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
    @Environment(WindowModel.self) private var model

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
        // MARK: r2-skills-side — P3-transcript-15: Esc goes back to the list from a thread or a new question, then closes the panel.
        .onExitCommand {
            if side.isComposing || side.selectedThread != nil {
                withAnimation(.easeInOut(duration: 0.15)) { side.showList() }
            } else {
                model.toggleSidePanelTick += 1
            }
        }
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
            }
            .buttonStyle(.icon)
            .disabled(store.projectInfo == nil)
            // MARK: r2-skills-side — P3-transcript-31: ⌥⌘/ has one name, the menu's.
            .helpWithKey("Ask about the selection", action: "Ask About Selection…")
            .accessibilityLabel("New side question")
            .accessibilityIdentifier("New side question")
            // MARK: r2-skills-side — P3-transcript-15: the panel closes from its own head too.
            Button {
                model.toggleSidePanelTick += 1
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.icon)
            .helpWithKey("Close side questions", action: "Toggle Side Questions")
            .accessibilityLabel("Close side questions")
            .accessibilityIdentifier("Close side questions")
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
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(threads) { thread in
                            SideThreadRow(thread: thread, isCursor: cursor == thread.id) { store.side.select(thread.id) }
                                .id(thread.id)
                        }
                    }
                    .padding(10)
                }
                // MARK: r2-skills-side — P3-transcript-15: ↑ / ↓ pick a thread, ↩ opens it.
                .focusable()
                .focusEffectDisabled()
                .onKeyPress(.downArrow) { moveCursor(+1, in: threads, proxy: proxy) }
                .onKeyPress(.upArrow) { moveCursor(-1, in: threads, proxy: proxy) }
                .onKeyPress(.return) {
                    guard let id = cursor, threads.contains(where: { $0.id == id }) else { return .ignored }
                    store.side.select(id)
                    return .handled
                }
            }
        }
    }

    /// The thread the arrow keys picked in the list (nil: none yet).
    @State private var cursor: String?

    private func moveCursor(_ step: Int, in threads: [SideThread], proxy: ScrollViewProxy) -> KeyPress.Result {
        guard !threads.isEmpty else { return .ignored }
        let at = cursor.flatMap { id in threads.firstIndex { $0.id == id } }
        let next = at.map { min(max($0 + step, 0), threads.count - 1) } ?? (step > 0 ? 0 : threads.count - 1)
        cursor = threads[next].id
        proxy.scrollTo(threads[next].id)
        return .handled
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
                .helpWithKey("Ask about the selection", action: "Ask About Selection…")   // MARK: r2-skills-side (P3-transcript-15 / 31)
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
    /// MARK: r2-skills-side — P3-transcript-15: the row the arrow keys are on.
    var isCursor = false
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
                        RelativeTimeText(date)   // MARK: r2-skills-side — PX-21 / P3-transcript-23: keeps up, the exact time on hover
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
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(isCursor ? Color.accentColor.opacity(0.8) : thread.isRunning ? Color.teal.opacity(0.45) : Color.clear))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .contextMenu {
            // MARK: r2-skills-side — P3-transcript-10: the thread's words can be copied from the list too.
            if let question = thread.messages.last(where: { $0.role == .user })?.text, !question.isEmpty {
                Button("Copy Question", systemImage: "doc.on.doc") { Clipboard.copy(question) }
            }
            if let answer = thread.messages.last(where: { $0.role == .assistant && !$0.text.isEmpty })?.text {
                Button("Copy Last Answer", systemImage: "doc.on.doc") { Clipboard.copy(answer) }
            }
            Divider()
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
                .help(store.side.errors[thread.id] ?? thread.error ?? "")   // MARK: r2-skills-side — P3-transcript-26: why
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
                                    .hoverHighlight(cornerRadius: 10)   // MARK: r2-skills-side — P3-transcript-19
                            }
                            .buttonStyle(.plain)
                            .disabled(store.side.isAskingNew)
                            .help("Ask this now")
                        }
                    }
                    if let error = store.side.errors[""] {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("Side compose error")
                    }
                    // MARK: r2-skills-side — §21 (M18): a skill / slash command runs in the main conversation — send it there.
                    if store.side.mainOnlyRequest("") != nil {
                        SideSendToMainButton(key: "", showsReason: false)   // the refusal above says why
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
