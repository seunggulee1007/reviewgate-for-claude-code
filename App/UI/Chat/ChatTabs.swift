import SwiftUI
import ReviewGateCore

/// M15 (docs/M15-POLISH.md): the chat pane's header is a tab strip — one tab per open session (`state.sessions.openTabIds`),
/// `+` for a new chat and an overflow menu with "History…". `+` is disabled, with the reason as tooltip, while the
/// engine would refuse a switch (a turn is running, or the review is bound to this chat — see `AppState.chatSwitchBlocker`).
/// wave4b w4b-tabs (§39.2): a tab click only shows that chat's saved rows (read-only); the Claude session stays where it
/// is (a dot on its tab) until a send or [이 채팅으로 이어가기] moves it — so tabs are never disabled.
struct ChatTabStrip: View {
    @Environment(AppState.self) private var store
    @Binding var showHistory: Bool
    // MARK: wave3 mac-session
    @Environment(WindowModel.self) private var model
    /// §36.9: what "Continue in terminal" copied (the confirmation).
    @State private var continueRequest: ContinueInTerminalRequest?
    /// The tab's "Rename…" (the same alert as the history's).
    @State private var renameTarget: SessionMeta?
    @State private var renameText = ""

    var body: some View {
        let blocker = store.chatSwitchBlocker
        HStack(spacing: 4) {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(store.openTabs) { tab in
                            ChatTab(meta: tab,
                                    isCurrent: tab.id == store.shownChatId,   // wave4b w4b-tabs: the chat on screen
                                    isRunning: tab.id == store.currentSessionId && (store.isRunning || store.isStarting),
                                    blocker: blocker,
                                    canClose: store.canCloseTab(id: tab.id),
                                    onSelect: { open(tab) },
                                    onClose: { Task { await store.closeChatTab(id: tab.id) } },   // wave4b w4b-tabs: a shown chat hands back first
                                    isLive: tab.id == store.currentSessionId && store.viewingChat != nil)
                                .id(tab.id)
                                .contextMenu { tabMenu(tab) }
                        }
                    }
                    .padding(.horizontal, 4)
                }
                .onChange(of: store.currentSessionId, initial: true) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id) } }
                }
            }
            Button { Task { await store.newChat() } } label: { Image(systemName: "plus") }
                .buttonStyle(.icon)
                .controlSize(.small)
                .disabled(blocker != nil || store.projectInfo == nil)
                .help(blocker ?? String(localized: "New chat") + " (⌘T)")   // wave4 w4-input: Chat → New chat
                .accessibilityLabel("New chat")
                .accessibilityIdentifier("New chat")
            Menu {
                Button("History…") { showHistory = true }
                    .accessibilityIdentifier("Chat history")
                if let current = store.sessions.first(where: { $0.id == store.currentSessionId }) {
                    Divider()
                    Text(verbatim: current.title)
                    ContinueInTerminalMenuItem(meta: current) { continueRequest = $0 }   // wave3 mac-session (§36.9)
                }
                if store.sessionTools.sessionsSupported {   // wave3 mac-session (§36.9)
                    Divider()
                    Button("Import a CLI session…") { model.showCliImport = true }
                        .accessibilityIdentifier("Chat menu import CLI session")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Chat history")
            .accessibilityLabel("Chat history")
            .accessibilityIdentifier("Chat history")
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Chat tabs")
        .continueInTerminalAlert($continueRequest, store: store)   // wave3 mac-session (§36.9)
        .renameChatAlert($renameTarget, text: $renameText)
        // wave4 w4-input (polish-06): Chat → ⌘1…⌘9 asks for a tab; it opens like a click (wave4b w4b-tabs: read-only).
        .onChange(of: model.chatTabRequest) { _, id in
            guard let id else { return }
            model.chatTabRequest = nil
            guard id != store.shownChatId, let tab = store.openTabs.first(where: { $0.id == id }) else { return }
            open(tab)
        }
    }

    /// wave4b w4b-tabs (§39.2): shows the chat — its saved rows read-only, or the live chat again; nothing switches.
    private func open(_ meta: SessionMeta) {
        Task { await store.viewChat(id: meta.id) }
    }

    /// A tab's right-click menu: rename, close (this one / the others), move, continue in the terminal.
    @ViewBuilder
    private func tabMenu(_ tab: SessionMeta) -> some View {
        let tabs = store.openTabs
        let index = tabs.firstIndex { $0.id == tab.id } ?? 0
        Button("Rename…") { renameText = tab.title; renameTarget = tab }
            .accessibilityIdentifier("Rename chat tab")
        Divider()
        Button("Close Tab") { Task { await store.closeChatTab(id: tab.id) } }
            .disabled(!store.canCloseTab(id: tab.id))
            .accessibilityIdentifier("Close chat tab menu")
        // The live chat's tab stays: closing it would move Claude's session.
        Button("Close Other Tabs") { store.closeOtherTabs(keeping: tab.id) }
            .disabled(tabs.allSatisfy { $0.id == tab.id || $0.id == store.currentSessionId })
            .accessibilityIdentifier("Close other chat tabs")
        Divider()
        Button("Move Tab Left") { store.moveTab(id: tab.id, to: index - 1) }
            .disabled(index == 0)
        Button("Move Tab Right") { store.moveTab(id: tab.id, to: index + 1) }
            .disabled(index >= tabs.count - 1)
        Divider()
        ContinueInTerminalMenuItem(meta: tab) { continueRequest = $0 }   // wave3 mac-session (§36.9)
    }
}

/// "Rename chat": the history's rows and a tab's right-click menu.
private struct RenameChatAlert: ViewModifier {
    @Environment(AppState.self) private var store
    @Binding var target: SessionMeta?
    @Binding var text: String

    func body(content: Content) -> some View {
        content.alert("Rename chat", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
                      presenting: target) { meta in
            TextField("Title", text: $text)
                .accessibilityIdentifier("Rename chat title")
            Button("Rename") { store.renameChat(id: meta.id, title: text); target = nil }
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityIdentifier("Rename chat confirm")
            Button("Cancel", role: .cancel) { target = nil }
        } message: { _ in
            Text("The title is shown on the tab and in this list.")
        }
    }
}

extension View {
    fileprivate func renameChatAlert(_ target: Binding<SessionMeta?>, text: Binding<String>) -> some View {
        modifier(RenameChatAlert(target: target, text: text))
    }
}

/// wave1 mac-session (§30): "Claude Code 기록이 없어 이어갈 수 없어요. 내용만 볼까요?" before opening a `resumeFailed` chat — the
/// CLI has no record of it, so opening shows its rows and what follows goes to a new chat.
private struct ReadOnlyChatConfirmation: ViewModifier {
    @Binding var candidate: SessionMeta?
    let onOpen: (SessionMeta) -> Void

    func body(content: Content) -> some View {
        content.alert("Claude Code has no record of this chat, so it cannot be continued. View its content only?",
                      isPresented: Binding(get: { candidate != nil }, set: { if !$0 { candidate = nil } }),
                      presenting: candidate) { meta in
            Button("View content") { candidate = nil; onOpen(meta) }
                .accessibilityIdentifier("Open read-only chat")
            Button("Cancel", role: .cancel) { candidate = nil }
        } message: { _ in
            Text("Its messages are shown; what you send next goes to a new chat.")
        }
    }
}

/// "기록만": the CLI could not resume this chat (`resumeFailed`); its transcript is still readable.
struct ReadOnlyChatBadge: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Text("Transcript only")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Color.secondary.opacity(colorScheme == .dark ? 0.25 : 0.15), in: Capsule())
            .foregroundStyle(.secondary)
            .help("Claude Code has no record of this chat any more; its messages can be read, not continued")
            .accessibilityIdentifier("Transcript only badge")
    }
}

extension View {
    fileprivate func readOnlyChatConfirmation(_ candidate: Binding<SessionMeta?>, onOpen: @escaping (SessionMeta) -> Void) -> some View {
        modifier(ReadOnlyChatConfirmation(candidate: candidate, onOpen: onOpen))
    }
}

/// One tab: title, a spinning dot while it is the running one, and × (close).
private struct ChatTab: View {
    @Environment(\.colorScheme) private var colorScheme
    let meta: SessionMeta
    let isCurrent: Bool
    let isRunning: Bool
    let blocker: String?
    let canClose: Bool
    let onSelect: () -> Void
    let onClose: () -> Void
    // MARK: wave4b w4b-tabs
    /// §39.2: Claude's session is on this chat while another one is shown (a hollow dot when it is idle).
    var isLive = false
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 5) {
            // wave4b w4b-tabs (§39.2): a click shows the chat read-only, so it is never blocked.
            Button(action: { if !isCurrent { onSelect() } }) {
                HStack(spacing: 5) {
                    if isRunning {
                        Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                            .accessibilityIdentifier("Chat tab running")
                    } else if isLive {
                        Circle().strokeBorder(Color.accentColor, lineWidth: 1.5).frame(width: 7, height: 7)
                            .accessibilityIdentifier("Chat tab live")
                    }
                    Text(verbatim: title)
                        .font(.callout.weight(isCurrent ? .semibold : .regular))
                        .lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: 160)
                    if meta.resumeFailed { ReadOnlyChatBadge() }   // wave1 mac-session (§30)
                    if let moved = meta.movedTo { MovedChatBadge(moved: moved) }   // wave4b w4b-follow (§39.4)
                }
                .padding(.leading, 10).padding(.vertical, 5)   // inside the label: the whole tab is the target
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isRunning || isLive ? String(localized: "Claude's session is on this chat") : title)
            .accessibilityLabel(title)
            .accessibilityValue(isRunning || isLive ? String(localized: "Claude's session is on this chat") : "")
            .accessibilityAddTraits(isCurrent ? [.isSelected] : [])
            .accessibilityIdentifier("Chat tab \(title)")
            Button(action: onClose) {
                Image(systemName: "xmark").font(.caption2.weight(.semibold))
            }
            .buttonStyle(IconButtonStyle(padding: 2))
            .padding(.trailing, 4)
            .foregroundStyle(.secondary)
            .opacity(hovering || isCurrent ? 1 : 0.35)
            .disabled(!canClose)
            .help(canClose ? String(localized: "Close tab (the chat stays in History)") : (blocker ?? String(localized: "The only open chat cannot be closed")))
            .accessibilityLabel("Close tab")
            .accessibilityIdentifier("Close chat tab \(title)")
        }
        .background(isCurrent ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28) : (hovering ? Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.06) : .clear),
                    in: RoundedRectangle(cornerRadius: 7))
        .onHover { hovering = $0 }
    }

    private var title: String { meta.title.isEmpty ? String(localized: "New chat") : meta.title }
}

/// The "History…" sheet: every session of the worktree with search, relative time, turns and cost, plus
/// Open / Rename / Archive / Delete. Deleting confirms; the current chat cannot be deleted.
struct ChatHistorySheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// wave1 mac-session (§30): the chat a resume notice is about (`error.sessionId`), selected and scrolled to.
    var highlightId: String?
    @State private var readOnlyCandidate: SessionMeta?
    @State private var query = ""
    @State private var showArchived = false
    @State private var selection: String?
    @State private var renameTarget: SessionMeta?
    @State private var renameText = ""
    @State private var deleteTarget: SessionMeta?
    /// The engine's refusal of the last Open / Delete (localized), shown under the list.
    @State private var actionError: String?
    /// wave3 mac-session (§36.9): what "Continue in terminal" copied (the confirmation).
    @State private var continueRequest: ContinueInTerminalRequest?
    // MARK: wave4 w4-history — §38.3: the chats whose messages contain the query (their newest matching line).
    @State private var matches: [String: TranscriptSearchMatch] = [:]
    @State private var matchedQuery = ""
    @State private var searching = false
    // MARK: wave4c w4c-review — §41.3: the search line clicked (the chat opens at its row)
    private struct PickedRow: Equatable {
        let sessionId: String
        let row: Int
    }
    @State private var pickedRow: PickedRow?

    private var rows: [SessionMeta] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return store.sessions.filter { meta in
            guard showArchived || !meta.archived || meta.id == store.currentSessionId else { return false }
            guard !q.isEmpty else { return true }
            return meta.title.lowercased().contains(q) || meta.lastUserText.lowercased().contains(q) || meta.id.lowercased().hasPrefix(q)
                || match(meta) != nil   // wave4 w4-history
        }
    }

    /// wave4 w4-history: the message line the search found in `meta` (for the query on screen only).
    private func match(_ meta: SessionMeta) -> TranscriptSearchMatch? {
        matchedQuery == query.trimmingCharacters(in: .whitespacesAndNewlines) ? matches[meta.id] : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Chat history").font(.headline)
                Spacer()
                Toggle("Show archived", isOn: $showArchived).toggleStyle(.checkbox).controlSize(.small)
                    .accessibilityIdentifier("Show archived chats")
            }
            TextField("Search chats", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("Chat history search")
                .task(id: query) { await searchMessages() }   // wave4 w4-history (§38.3)
            ScrollViewReader { proxy in
                List(rows, selection: $selection) { meta in
                    row(meta)
                        .tag(meta.id)
                        .id(meta.id)
                        .contextMenu { actions(meta) }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("Chat history row \(title(meta))")
                }
                .listStyle(.bordered)
                .frame(minHeight: 260)
                .accessibilityIdentifier("Chat history list")
                .onAppear {
                    guard let highlightId, store.sessions.contains(where: { $0.id == highlightId }) else { return }
                    selection = highlightId
                    DispatchQueue.main.async { proxy.scrollTo(highlightId, anchor: .center) }
                }
            }
            if searching {
                Text("Searching the messages…").font(.caption).foregroundStyle(.secondary)   // wave4 w4-history
                    .accessibilityIdentifier("Chat history searching")
            }
            if rows.isEmpty, !searching {
                Text(store.sessions.isEmpty ? "No chats yet" : "No matching chat")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let actionError {
                Text(verbatim: actionError).font(.caption).foregroundStyle(.red).lineLimit(2)
                    .accessibilityIdentifier("Chat history error")
            }
            HStack {
                if let blocker = store.chatSwitchBlocker {
                    Text(verbatim: blocker).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("Close chat history")
            }
        }
        .padding(20)
        .frame(width: 560, height: 460)
        .task { await store.refreshSessions() }
        .readOnlyChatConfirmation($readOnlyCandidate) { meta in openNow(meta) }   // wave1 mac-session (§30)
        .continueInTerminalAlert($continueRequest, store: store)   // wave3 mac-session (§36.9)
        .renameChatAlert($renameTarget, text: $renameText)
        .alert("Delete chat?", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
               presenting: deleteTarget) { meta in
            Button("Delete", role: .destructive) {
                deleteTarget = nil
                Task { if !(await store.deleteChat(id: meta.id)) { actionError = store.lastError } }
            }
                .accessibilityIdentifier("Delete chat confirm")
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        } message: { meta in
            Text("“\(title(meta))” and its transcript are deleted permanently.")
        }
    }

    private func title(_ meta: SessionMeta) -> String { meta.title.isEmpty ? String(localized: "New chat") : meta.title }

    private func row(_ meta: SessionMeta) -> some View {
        let isCurrent = meta.id == store.currentSessionId
        return HStack(spacing: 8) {
            Image(systemName: isCurrent ? "bubble.left.fill" : (meta.archived ? "archivebox" : "bubble.left"))
                .foregroundStyle(isCurrent ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(verbatim: title(meta)).font(.callout.weight(isCurrent ? .semibold : .regular)).lineLimit(1)
                    if isCurrent {
                        Text("current").font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28), in: Capsule())
                    }
                    if meta.resumeFailed {
                        ReadOnlyChatBadge()   // wave1 mac-session (§30)
                    }
                    if let moved = meta.movedTo { MovedChatBadge(moved: moved) }   // wave4b w4b-follow (§39.4)
                }
                if let found = match(meta) {   // wave4 w4-history — §38.3: the line that matched
                    // MARK: wave4c w4c-review — §41.3: up to three lines (each opens the chat there) and "N건 더"
                    let shown = ReviewLeftovers.matchHits(found)
                    ForEach(shown.hits, id: \.row) { hit in
                        Button {
                            openAt(meta, row: hit.row)
                        } label: {
                            Label {
                                Text(verbatim: hit.line).lineLimit(1).truncationMode(.tail)
                            } icon: {
                                Image(systemName: hit.isUser ? "person.fill" : "sparkles")
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .disabled(!isCurrent && store.chatSwitchBlocker != nil)
                        .help(isCurrent ? String(localized: "Found in the messages") : (store.chatSwitchBlocker ?? String(localized: "Found in the messages")))
                        .accessibilityIdentifier("Chat history match line")
                    }
                    if shown.more > 0 {
                        Text("\(shown.more) more")
                            .font(.caption2).foregroundStyle(.secondary)
                            .help("Open the chat and use Find (⌘F) to see every match")
                            .accessibilityIdentifier("Chat history match more")
                    }
                } else {
                    Text(verbatim: meta.lastUserText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                Text(verbatim: relativeTime(meta)).font(.caption).foregroundStyle(.secondary)
                Text("\(meta.turns) turns · \(costText(meta.costUSD))").font(.caption2).foregroundStyle(.secondary)
            }
            if isCurrent, let found = match(meta) {   // wave4 w4-history: the match is in the open chat — go to it
                Button("Show in chat") {
                    store.jumpToMessage(sessionId: meta.id, row: found.row)
                    dismiss()
                }
                .controlSize(.small)
                .accessibilityIdentifier("Show match \(title(meta))")
            }
            Button("Open") { open(meta) }
                .controlSize(.small)
                .disabled(isCurrent)
                .help(store.chatSwitchBlocker.map { String(localized: "Opens it read-only in a tab — \($0)") }
                      ?? String(localized: "Open this chat in a tab"))
                .accessibilityIdentifier("Open chat \(title(meta))")
            Menu {
                actions(meta)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("Chat actions")
            .accessibilityIdentifier("Chat actions \(title(meta))")
        }
        .padding(.vertical, 2)
        .opacity(meta.archived ? 0.6 : 1)
        .onTapGesture(count: 2) { open(meta) }
    }

    @ViewBuilder
    private func actions(_ meta: SessionMeta) -> some View {
        let isCurrent = meta.id == store.currentSessionId
        Button("Rename…") { renameText = meta.title; renameTarget = meta }
            .accessibilityIdentifier("Rename chat \(title(meta))")
        Button(meta.archived ? "Unarchive" : "Archive") { store.archiveChat(id: meta.id, archived: !meta.archived) }
            .accessibilityIdentifier("Archive chat \(title(meta))")
        ContinueInTerminalMenuItem(meta: meta) { continueRequest = $0 }   // wave3 mac-session (§36.9)
        Button("Delete…", role: .destructive) { deleteTarget = meta }
            .disabled(isCurrent)
            .help(isCurrent ? String(localized: "The current chat cannot be deleted") : String(localized: "Delete this chat and its transcript"))
            .accessibilityIdentifier("Delete chat \(title(meta))")
    }

    private func open(_ meta: SessionMeta) {
        guard meta.id != store.currentSessionId else { return }
        guard store.chatSwitchBlocker == nil else {
            // wave4b w4b-tabs (§39.2): while a switch is refused the chat opens as a tab click shows one — read-only, nothing
            // switches (a found line is not jumped to: that works on the live transcript).
            pickedRow = nil
            Task {
                await store.openTabReadOnly(id: meta.id)
                dismiss()
            }
            return
        }
        if store.isReadOnlyChat(id: meta.id) { readOnlyCandidate = meta } else { openNow(meta) }
    }

    /// wave4c w4c-review — §41.3: a search line of `meta` was clicked — the open chat scrolls there, another opens at it.
    private func openAt(_ meta: SessionMeta, row: Int) {
        if meta.id == store.currentSessionId {
            store.jumpToMessage(sessionId: meta.id, row: row)
            dismiss()
            return
        }
        pickedRow = PickedRow(sessionId: meta.id, row: row)
        open(meta)
    }

    private func openNow(_ meta: SessionMeta) {
        if let picked = pickedRow, picked.sessionId == meta.id {   // wave4c w4c-review: the line clicked
            store.jumpToMessage(sessionId: meta.id, row: picked.row)
        } else if let found = match(meta) { store.jumpToMessage(sessionId: meta.id, row: found.row) }   // wave4 w4-history
        pickedRow = nil
        Task {
            if await store.openChat(id: meta.id) { dismiss() } else { actionError = store.lastError }
        }
    }

    /// wave4 w4-history — §38.3 `transcript_search`, debounced; an engine before §38.3 answers nothing (titles only).
    private func searchMessages() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            matches = [:]
            matchedQuery = ""
            searching = false
            return
        }
        searching = true
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        let found = await store.searchMessages(q) ?? []
        guard !Task.isCancelled else { return }
        matches = Dictionary(found.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first })
        matchedQuery = q
        searching = false
    }

    private func relativeTime(_ meta: SessionMeta) -> String {
        guard let date = meta.updatedDate else { return "" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }

    private func costText(_ usd: Double) -> String {
        usd < 0.01 && usd > 0 ? "<$0.01" : String(format: "$%.2f", usd)
    }
}
