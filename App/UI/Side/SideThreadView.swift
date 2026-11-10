import SwiftUI
import ReviewGateCore

/// One side thread: what it is about (with the hunk), the questions and the streaming answers, compact tool calls, the
/// follow-up field, Stop while it answers, and "Send to main" / "Add as review note".
struct SideThreadView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let thread: SideThread
    @FocusState private var followUpFocused: Bool
    @State private var confirmClose = false

    /// The follow-up is the store's (`followUpDrafts`): the list, another thread or the agent panel do not lose it.
    private var followUp: Binding<String> {
        Binding(get: { store.side.followUpDrafts[thread.id] ?? "" },
                set: { store.side.followUpDrafts[thread.id] = $0.isEmpty ? nil : $0 })
    }

    private static let bottomID = "side-bottom"

    var body: some View {
        let messages = store.side.displayMessages(thread)
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        SideForkNotice(fork: thread.fork)   // wave3 mac-agents (§36.10): "턴 N 진행 중 — 요약만 전달됨"
                        SideForkPointRow(thread: thread, typed: followUp)   // wave4b w4b-side (§40.3): "턴 N 시점", [최신 대화로 다시 묻기]
                        if let quote = thread.anchor?.quote {
                            SideQuoteHeader(quote: quote)   // wave4b w4b-side (§40.3)
                        } else if let anchor = thread.anchor {
                            SideAnchorHeader(anchor: anchor)
                        }
                        ForEach(messages) { item in
                            messageView(item)
                        }
                        footerNotes
                        Color.clear.frame(height: 1).id(Self.bottomID)
                    }
                    .padding(12)
                }
                .onChange(of: messages.last?.message.text.count ?? 0) { _, _ in
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
                .onChange(of: messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                }
            }
            Divider()
            actionBar
        }
        .onAppear { if !thread.isRunning { followUpFocused = true } }
        .onChange(of: store.side.focusTick) { _, _ in followUpFocused = true }
        .confirmationDialog("Delete this side question?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await store.side.close(thread.id) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The thread and its answers are removed. Nothing in the main conversation changes.")
        }
    }

    // MARK: Messages

    @ViewBuilder
    private func messageView(_ item: SideDisplayMessage) -> some View {
        let message = item.message
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 28)
                Text(verbatim: message.text)
                    .textSelection(.enabled)
                    .font(.callout)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Color.teal.wash(colorScheme, light: 0.16, dark: 0.26), in: RoundedRectangle(cornerRadius: 10))
                    .contextMenu {   // MARK: r2-skills-side — P3-transcript-10
                        Button("Copy Question", systemImage: "doc.on.doc") { Clipboard.copy(message.text) }
                    }
            }
            .accessibilityIdentifier("Side question")
        case .assistant:
            VStack(alignment: .leading, spacing: 6) {
                if !message.toolCalls.isEmpty {
                    SideToolCallList(calls: message.toolCalls, root: store.projectInfo?.root)
                }
                if message.text.isEmpty {
                    if item.streaming {
                        HStack(spacing: 6) {
                            PulseDot(color: .teal, size: 5).frame(width: 10, height: 10)
                            Text(message.toolCalls.isEmpty ? "Thinking…" : "Reading the code…")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("Side typing")
                    } else if message.wasInterrupted {
                        Text("Stopped").font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    MarkdownText(text: message.text)
                        .font(.callout)
                        // MARK: r2-skills-side — P3-transcript-10: the answer text's own right-click menu copies it.
                        .environment(\.proseMenuItems, item.streaming ? [] : [ProseMenuItem(title: String(localized: "Copy Answer")) { Clipboard.copy(message.text) }])
                    if item.streaming {
                        PulseDot(color: .teal, size: 4).frame(width: 8, height: 8)
                    }
                }
                if !item.streaming, message.wasInterrupted, !message.text.isEmpty {
                    Label("Stopped before the end", systemImage: "stop.circle").font(.caption2).foregroundStyle(.secondary)
                }
                if !item.streaming, let cost = message.costUSD, cost > 0 {
                    HStack(spacing: 6) {
                        Text(verbatim: SideQuestionText.cost(cost))
                        if let ms = message.durationMs, ms > 0 { Text(verbatim: ElapsedFormat.text(seconds: Double(ms) / 1000)) }
                    }
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 10))
            .modifier(SideAnswerCopy(text: message.text, enabled: !item.streaming && !message.text.isEmpty))   // MARK: r2-skills-side (P3-transcript-10)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(item.streaming ? "Side answer streaming" : "Side answer")
        }
    }

    @ViewBuilder
    private var footerNotes: some View {
        if let promotion = thread.promotions.last {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text(verbatim: SideQuestionText.promotionLabel(promotion)).font(.caption.weight(.semibold))
                if let date = isoDateValue(promotion.at) {
                    RelativeTimeText(date).font(.caption2).foregroundStyle(.secondary)   // MARK: r2-skills-side — PX-21
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Color.green.wash(colorScheme, light: 0.10, dark: 0.16), in: Capsule())
            .accessibilityIdentifier("Side promoted")
        } else if store.side.queuedThreadIds.contains(thread.id) {
            Label("Queued for the main conversation — sent when Claude is free", systemImage: "tray.and.arrow.down.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
        }
        if let error = store.side.errors[thread.id] {
            Label {
                Text(verbatim: error).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(.caption)
            .foregroundStyle(.orange)
            .accessibilityIdentifier("Side thread error")
        }
        // MARK: r2-skills-side — §21 (M18): the answer tried a skill (or a follow-up was a slash command): send it to the main chat.
        if !thread.isRunning, store.side.mainOnlyRequest(thread.id) != nil {
            SideSendToMainButton(key: thread.id)
        }
    }

    private func isoDateValue(_ s: String) -> Date? {
        if let d = try? Date(s, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(s, strategy: Date.ISO8601FormatStyle())
    }

    // MARK: Actions

    private var canAddNote: Bool { thread.anchor?.path != nil && thread.anchor?.entryId == nil }
    private var drafting: Bool { store.side.draftingThreadId == thread.id }

    private var actionBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if thread.isRunning, !drafting {
                HStack(spacing: 8) {
                    PulseDot(color: .teal, size: 4).frame(width: 8, height: 8)
                    Text("Answering in a side session…").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    Button("Stop", systemImage: "stop.fill") { Task { await store.side.cancel(thread.id) } }
                        .controlSize(.small)
                        .help("Stop this answer; the thread stays")
                        .accessibilityIdentifier("Side stop")
                }
            } else {
                HStack(spacing: 6) {
                    Button {
                        Task { await store.side.preparePromotion(thread.id, target: .message) }
                    } label: {
                        if drafting {
                            HStack(spacing: 5) { ProgressView().controlSize(.mini); Text("Summarizing…") }
                        } else {
                            Label("Send to main", systemImage: "arrowshape.turn.up.left.fill")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.teal)
                    .controlSize(.small)
                    .disabled(!thread.hasAnswer || drafting)
                    // wave4 w4-input (polish-06): ⌘↩ / ⌥⌘↩ from the follow-up field only — the composer keeps its own ⌘↩.
                    .keyboardShortcut(followUpFocused ? KeyboardShortcut(.return, modifiers: .command) : nil)
                    .help(Text("Summarize the conclusion as an instruction, edit it, then send it to the main conversation") + Text(verbatim: " (⌘↩)"))
                    .accessibilityIdentifier("Side send to main")
                    if canAddNote {
                        Button("Add as note", systemImage: "text.bubble") {
                            Task { await store.side.preparePromotion(thread.id, target: .note) }
                        }
                        .controlSize(.small)
                        .disabled(!thread.hasAnswer || drafting)
                        .keyboardShortcut(followUpFocused ? KeyboardShortcut(.return, modifiers: [.command, .option]) : nil)
                        .help(Text("Add the conclusion as a review note on \(SideQuestionText.location(thread.anchor) ?? "")") + Text(verbatim: " (⌥⌘↩)"))
                        .accessibilityIdentifier("Side add note")
                    }
                    Spacer(minLength: 4)
                    Button {
                        confirmClose = true
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(IconButtonStyle(padding: 2))   // `.borderless` left the glyph alone as the target
                    .controlSize(.small)
                    .help("Delete this side question")
                    .accessibilityLabel("Delete Side Question")
                    .accessibilityIdentifier("Side close")
                }
            }
            HStack(alignment: .bottom, spacing: 6) {
                TextField("Ask a follow-up…", text: followUp, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($followUpFocused)
                    .padding(.horizontal, 9).padding(.vertical, 6)
                    .background(Color.cardFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(followUpFocused ? Color.teal.opacity(0.6) : Color.secondary.opacity(0.2)))
                    .onSubmit(sendFollowUp)
                    .accessibilityIdentifier("Side follow-up field")
                Button(action: sendFollowUp) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                        .foregroundStyle(canSendFollowUp ? Color.teal : Color.secondary.opacity(0.4))
                }
                .buttonStyle(.plain)
                .disabled(!canSendFollowUp)
                .help("Ask (↩)")
                .accessibilityLabel("Ask")   // MARK: r2-skills-side — P3-transcript-15: the word its tooltip uses
                .accessibilityIdentifier("Side send follow-up")
            }
        }
        .padding(10)
    }

    private var canSendFollowUp: Bool {
        !thread.isRunning && !store.side.busyThreadIds.contains(thread.id) && !followUp.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendFollowUp() {
        guard canSendFollowUp else { return }
        let text = followUp.wrappedValue
        followUp.wrappedValue = ""
        Task {
            if !(await store.side.ask(text, threadId: thread.id)) { followUp.wrappedValue = text }
        }
    }
}

/// The compact tool calls of an answer: "Read src/a.ts ✓", denied ones in orange.
private struct SideToolCallList: View {
    @Environment(\.colorScheme) private var colorScheme
    let calls: [SideToolCall]
    let root: String?
    @State private var expanded = false

    var body: some View {
        let shown = expanded ? calls : Array(calls.prefix(3))
        VStack(alignment: .leading, spacing: 2) {
            ForEach(shown) { call in
                // MARK: r2-skills-side — P3-transcript-07 / PX-04: what the call did, in words, on its name and detail — no
                // row-wide tooltip hiding the status mark's own.
                let words = ToolRowTooltip.text(name: call.name, input: call.input, root: root.map { URL(fileURLWithPath: $0) }, linked: false)
                HStack(spacing: 5) {
                    Image(systemName: icon(call.name)).font(.caption2).foregroundStyle(.tertiary).frame(width: 12)
                    Text(verbatim: call.name).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        .help(words)
                    Text(verbatim: detail(call)).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                        .help(words)
                    Spacer(minLength: 2)
                    statusMark(call)
                }
            }
            if calls.count > 3 {
                Button(expanded ? String(localized: "Show fewer") : String(localized: "+\(calls.count - 3) more")) { expanded.toggle() }
                    .buttonStyle(.link)
                    .font(.caption2)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(Color.panelFill(colorScheme), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityIdentifier("Side tool calls")
    }

    @ViewBuilder
    private func statusMark(_ call: SideToolCall) -> some View {
        if call.denied {
            Text("read-only").font(.caption2.weight(.semibold)).foregroundStyle(.orange)
                .help(call.name == "Skill" ? String(localized: "Skills run in the main conversation only")   // MARK: r2-skills-side (M18)
                                           : String(localized: "Denied: side questions cannot change anything"))
        } else if call.isError == true {
            // MARK: r2-skills-side — P3-transcript-31: the marks say what they are.
            Image(systemName: "xmark.circle.fill").font(.caption2).foregroundStyle(.red)
                .help("Tool error")
                .accessibilityLabel("Tool error")
        } else if call.isError == false {
            Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(.green.opacity(0.8))
                .help("Tool result")
                .accessibilityLabel("Tool result")
        } else {
            ProgressView().controlSize(.mini)
        }
    }

    private func icon(_ name: String) -> String {
        switch name {
        case "Read", "NotebookRead": "doc.text"
        case "Glob", "Grep", "LS": "magnifyingglass"
        case "Bash": "terminal"
        case "WebFetch", "WebSearch": "globe"
        default: "wrench"
        }
    }

    private func detail(_ call: SideToolCall) -> String {
        let input = call.input
        if let path = input["file_path"]?.stringValue ?? input["path"]?.stringValue { return RepoPath.relative(path, root: root) }
        if let cmd = input["command"]?.stringValue { return cmd.split(separator: "\n").first.map(String.init) ?? cmd }
        if let pattern = input["pattern"]?.stringValue { return pattern }
        if let url = input["url"]?.stringValue ?? input["query"]?.stringValue { return url }
        return ""
    }
}

/// What a thread (or a new question) is about: the anchor chip, "Show diff", and the hunk as a small collapsible preview.
struct SideAnchorHeader: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let anchor: SideAnchor
    var onClear: (() -> Void)?
    @AppStorage("sideAnchorPreviewExpanded") private var expanded = true

    var body: some View {
        let lines = previewLines
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if !lines.isEmpty {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                    } label: {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .frame(width: 12, height: 12)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .help(expanded ? "Hide the code" : "Show the code")
                    .accessibilityLabel(expanded ? Text("Hide the code") : Text("Show the code"))   // MARK: wave4d w4d-speed — polish-10
                }
                SideAnchorChip(anchor: anchor, toolName: toolName)
                if let rationale = toolRationale {
                    TruncatedText(rationale, mode: .tail).font(.caption).foregroundStyle(.secondary)   // MARK: r2-skills-side — P3-transcript-22
                }
                Spacer(minLength: 4)
                if anchor.path != nil {
                    Button("Show diff") { openDiff() }
                        .buttonStyle(.link)
                        .font(.caption)
                        .fixedSize()
                        .accessibilityIdentifier("Side show diff")
                }
                if let onClear {
                    Button(action: onClear) { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(IconButtonStyle(padding: 2))   // `.plain` left the glyph alone as the target
                        .padding(.vertical, -2)
                        .help("Ask without this anchor")
                        .accessibilityLabel("Remove anchor")
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            if expanded, !lines.isEmpty {
                Divider().opacity(0.5)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(lines) { line in
                        previewRow(line)
                    }
                }
                .padding(.vertical, 4)
                .accessibilityIdentifier("Side anchor preview")
            }
        }
        .background(Color.panelFill(colorScheme), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.15)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Side anchor")
    }

    private func previewRow(_ line: DiffLine) -> some View {
        let focused = anchor.line != nil && (anchor.side == .old ? line.oldNo : line.newNo) == anchor.line && line.kind != .hunkHeader
        return HStack(spacing: 0) {
            Text(verbatim: (line.kind == .del ? line.oldNo : line.newNo).map(String.init) ?? "")
                .frame(width: 30, alignment: .trailing)
                .foregroundStyle(.secondary)
                .padding(.trailing, 4)
            Text(verbatim: line.kind == .add ? "+" : line.kind == .del ? "−" : " ")
                .frame(width: 10)
                .foregroundStyle(.secondary)
            TruncatedText(line.text, mode: .tail)   // MARK: r2-skills-side — P3-transcript-22: the whole line on hover
            Spacer(minLength: 0)
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.vertical, 0.5)
        .background(background(line, focused: focused))
    }

    private func background(_ line: DiffLine, focused: Bool) -> Color {
        if focused { return Color.teal.wash(colorScheme, light: 0.22, dark: 0.28) }
        switch line.kind {
        case .add: return Color.green.wash(colorScheme, light: 0.13, dark: 0.13)
        case .del: return Color.red.wash(colorScheme, light: 0.13, dark: 0.13)
        default: return .clear
        }
    }

    private var previewLines: [DiffLine] {
        if let pr = anchor.pr { return SideAnchors.previewLines(PRClaude.previewAnchor(pr), in: PRClaude.previewDiff(pr)) }   // wave3 mac-flow (§36.14)
        guard let path = anchor.path else { return [] }
        if let entry = anchor.entryId {
            guard let sel = store.historySelection, sel.entryId == entry, sel.path == path else { return [] }
            return SideAnchors.previewLines(anchor, in: store.historyDiff)
        }
        return SideAnchors.previewLines(anchor, in: store.cachedDiff(path: path))
    }

    private var call: ToolCallRecord? {
        anchor.toolUseId.flatMap { store.transcriptIndex.calls[$0] }   // MARK: wave7 w7-chat — §45.1: the shared index
    }
    private var toolName: String? { call?.name }
    private var toolRationale: String? { anchor.path == nil ? call?.shortInput(root: store.projectInfo?.root) : nil }

    private func openDiff() {
        guard let path = anchor.path else { return }
        if let entry = anchor.entryId {
            if model.tab != .history { model.tab = .history }
            Task { await store.openHistoryDiff(entryId: entry, path: path) }
            return
        }
        store.closeHistoryDiff()
        if model.tab != .changes { model.tab = .changes }
        if store.selectFile(path: path) { model.showReviewDiff(path: path, line: nil) }   // the pane opens for the file already selected too
    }
}

/// MARK: r2-skills-side — P3-transcript-10: a finished side answer's copy button while the pointer is over it (and its
/// right-click item), as the main chat's answers have.
private struct SideAnswerCopy: ViewModifier {
    let text: String
    let enabled: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .topTrailing) {
                if enabled, hovering {
                    Button { Clipboard.copy(text) } label: { Image(systemName: "doc.on.doc") }
                        .buttonStyle(.icon)
                        .help("Copy Answer")
                        .accessibilityLabel("Copy Answer")
                        .accessibilityIdentifier("Side copy answer")
                        .padding(2)
                }
            }
            .contextMenu {
                if enabled { Button("Copy Answer", systemImage: "doc.on.doc") { Clipboard.copy(text) } }
            }
            .onHover { inside in if hovering != inside { hovering = inside } }
    }
}
