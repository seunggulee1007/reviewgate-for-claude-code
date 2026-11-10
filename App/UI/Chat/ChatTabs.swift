import SwiftUI
import AppKit
import ReviewGateCore

/// M15 (docs/M15-POLISH.md): the chat pane's header is a tab strip — one tab per open session (`state.sessions.openTabIds`),
/// `+` for a new chat and an overflow menu with "History…". r2-chats-cards M31 (§9): `+` is never refused while Claude
/// works — the new chat opens once the turn is over (a chip says so, × calls it off); only a failed collection disables it.
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
    // MARK: r2-chats-cards — polish P4-composer-34 / PX-19
    /// The tab under the pointer (a middle click closes it).
    @State private var hoveredTab: String?
    @State private var middleClicks: Any?
    /// The strip's tabs are wider than its room: the ends fade.
    @State private var tabsWidth: CGFloat = 0
    @State private var roomWidth: CGFloat = 0
    /// "탭을 닫았어요 · 다시 열기" for a few seconds after a tab closed.
    @State private var justClosed: String?

    var body: some View {
        let blocker = store.chatSwitchBlocker
        let tabs = store.openTabs
        HStack(spacing: 4) {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                            ChatTab(meta: tab,
                                    index: index,
                                    isCurrent: tab.id == store.shownChatId,   // wave4b w4b-tabs: the chat on screen
                                    isRunning: tab.id == store.currentSessionId && (store.isRunning || store.isStarting),
                                    blocker: blocker,
                                    canClose: store.canCloseTab(id: tab.id),
                                    hasDraft: hasDraft(tab.id),
                                    onSelect: { open(tab) },
                                    onClose: { close(tab) },   // wave4b w4b-tabs: a shown chat hands back first
                                    isLive: tab.id == store.currentSessionId && store.viewingChat != nil)
                                .id(tab.id)
                                .onHover { inside in if inside { hoveredTab = tab.id } else if hoveredTab == tab.id { hoveredTab = nil } }
                                .contextMenu { tabMenu(tab) }
                                // polish P4-composer-34: drag a tab to put it elsewhere.
                                .draggable(tab.id)
                                .dropDestination(for: String.self) { ids, _ in
                                    guard let moved = ids.first, moved != tab.id, tabs.contains(where: { $0.id == moved }) else { return false }
                                    store.moveTab(id: moved, to: index)
                                    return true
                                }
                        }
                    }
                    .padding(.horizontal, 4)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { tabsWidth = $0 }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { roomWidth = $0 }
                // polish P4-composer-34: tabs past the edge fade out there (the ⋯ menu lists every open tab).
                .mask {
                    HStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: overflows ? 14 : 0)
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: overflows ? 14 : 0)
                    }
                }
                .onChange(of: store.currentSessionId, initial: true) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id) } }
                }
            }
            if let closed = justClosed {
                Button { Task { await reopenClosed(closed) } } label: {
                    Text("Tab closed · Reopen").font(.caption)
                }
                .buttonStyle(.link)
                .help(String.withKey(String(localized: "Reopen the chat you just closed"), action: "Reopen Closed Chat Tab"))
                .accessibilityIdentifier("Reopen closed chat tab")
                .task(id: closed) {
                    try? await Task.sleep(for: .seconds(3))
                    if justClosed == closed { justClosed = nil }
                }
            }
            Button { Task { await store.newChat() } } label: { Image(systemName: "plus") }
                .buttonStyle(.icon)
                .controlSize(.small)
                .disabled(store.newChatBlocker != nil || store.projectInfo == nil)
                .help(store.newChatBlocker ?? (store.chatSwitchWaits ? String(localized: "New chat (⌘T) — it opens once Claude is done")
                                                                     : String(localized: "New chat") + " (⌘T)"))   // wave4 w4-input: Chat → New chat
                .accessibilityLabel("New chat")
                .accessibilityIdentifier("New chat")
            if store.pendingChatSwitch != nil { PendingChatSwitchChip() }   // r2-chats-cards M31 / M33 (§9)
            Menu {
                // polish P4-composer-34: every open tab, the ones scrolled out of sight too.
                if tabs.count > 1 {
                    Section("Open tabs") {
                        ForEach(tabs) { tab in
                            Button { open(tab) } label: {
                                if tab.id == store.shownChatId { Label(tabTitle(tab), systemImage: "checkmark") } else { Text(verbatim: tabTitle(tab)) }
                            }
                        }
                    }
                }
                Button("History…") { showHistory = true }
                    .accessibilityIdentifier("Chat history")
                if let current = store.sessions.first(where: { $0.id == store.currentSessionId }) {
                    Divider()
                    Text(verbatim: current.title)
                    continueInTerminalItem(current)   // wave3 mac-session (§36.9); polish PX-03: why not, as its subtitle
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
            .help("Chat menu — history, continue in terminal, import a CLI session")   // polish P4-composer-33
            .accessibilityLabel("Chat menu")
            .accessibilityIdentifier("Chat history")
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Chat tabs")
        .continueInTerminalAlert($continueRequest, store: store)   // wave3 mac-session (§36.9)
        .renameChatAlert($renameTarget, text: $renameText)
        // wave4 w4-input (polish-06): Chat → ⌘1…9 asks for a tab; it opens like a click (wave4b w4b-tabs: read-only).
        .onChange(of: model.chatTabRequest) { _, id in
            guard let id else { return }
            model.chatTabRequest = nil
            guard id != store.shownChatId, let tab = store.openTabs.first(where: { $0.id == id }) else { return }
            open(tab)
        }
        // polish P4-composer-05: Chat › Rename Chat… — the chat on screen.
        .onChange(of: model.renameChatTick) { _, _ in
            guard let shown = store.openTabs.first(where: { $0.id == store.shownChatId }) else { return }
            renameText = shown.title
            renameTarget = shown
        }
        // polish P4-composer-34: a middle click closes the tab under the pointer, as in a browser.
        .onAppear {
            middleClicks = NSEvent.addLocalMonitorForEvents(matching: .otherMouseUp) { event in
                guard event.buttonNumber == 2 else { return event }
                let closed = MainActor.assumeIsolated { () -> Bool in
                    guard let id = hoveredTab, let tab = store.openTabs.first(where: { $0.id == id }) else { return false }
                    close(tab)
                    return true
                }
                return closed ? nil : event
            }
        }
        .onDisappear {
            if let middleClicks { NSEvent.removeMonitor(middleClicks) }
            middleClicks = nil
        }
    }

    private var overflows: Bool { tabsWidth > roomWidth + 1 }

    private func tabTitle(_ meta: SessionMeta) -> String { meta.title.isEmpty ? String(localized: "New chat") : meta.title }

    /// polish P4-composer-08: an unsent draft waits in this chat — typed in the composer now, kept in memory or saved.
    private func hasDraft(_ id: String) -> Bool {
        let composer = model.chatComposer
        if composer.draftChatId == id {
            return !composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !composer.images.isEmpty || !composer.mentions.isEmpty
        }
        return store.keptDraft(for: id) != nil
    }

    /// wave4b w4b-tabs (§39.2): shows the chat — its saved rows read-only, or the live chat again; nothing switches.
    private func open(_ meta: SessionMeta) {
        Task { await store.viewChat(id: meta.id) }
    }

    /// The tab's ×, its menu, a middle click: closed — remembered for ⌘⇧T (PX-19), and a draft left in it is said to stay.
    private func close(_ meta: SessionMeta) {
        guard store.canCloseTab(id: meta.id) else { return }
        let drafted = hasDraft(meta.id)
        Task {
            guard await store.closeChatTab(id: meta.id) else { return }
            ClosedChatTabs.remember(meta.id, in: model)
            justClosed = meta.id
            if drafted { Toast.show(String(localized: "Draft kept — reopen the chat to get it back (⌘⇧T)"), systemImage: "pencil.circle") }
        }
    }

    private func reopenClosed(_ id: String) async {
        justClosed = nil
        model.closedChatTabs.removeAll { $0 == id }
        await store.openTabReadOnly(id: id)
    }

    /// polish PX-03: "터미널에서 이어가기" with why it is off as the item's subtitle (an item tooltip would not show here).
    @ViewBuilder
    private func continueInTerminalItem(_ meta: SessionMeta) -> some View {
        if store.continueInTerminalCommand(for: meta) != nil {
            ContinueInTerminalMenuItem(meta: meta) { continueRequest = $0 }
        } else {
            Button {} label: {
                Text("Continue in terminal")
                Text(verbatim: ContinueInTerminal.unavailableReason(meta))
            }
            .disabled(true)
        }
    }

    /// A tab's right-click menu: rename, close (this one / the others), move, copy its id, show it in the history, archive,
    /// continue in the terminal.
    @ViewBuilder
    private func tabMenu(_ tab: SessionMeta) -> some View {
        let tabs = store.openTabs
        let index = tabs.firstIndex { $0.id == tab.id } ?? 0
        Button("Rename…") { renameText = tab.title; renameTarget = tab }
            .accessibilityIdentifier("Rename chat tab")
        Divider()
        Button("Close Tab") { close(tab) }
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
        // polish P4-composer-34
        Button("Copy Chat ID", systemImage: "doc.on.doc") { Clipboard.copy(tab.id) }
        Button("Show in History") {
            model.highlightChatId = tab.id
            model.showChatHistoryTick += 1
        }
        Button(tab.archived ? "Unarchive" : "Archive") { store.archiveChat(id: tab.id, archived: !tab.archived) }
        Divider()
        ContinueInTerminalMenuItem(meta: tab) { continueRequest = $0 }   // wave3 mac-session (§36.9)
    }
}

/// r2-chats-cards M31 / M33 (§9): a new chat or a switch held until Claude is done — what it waits for on hover, × calls it
/// off (a message held with it goes back to the composer).
struct PendingChatSwitchChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        if let pending = store.pendingChatSwitch {
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text(verbatim: label(pending))
                    .font(.caption)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 150)
                    .help(store.pendingChatSwitchText ?? "")
                Button { store.cancelPendingChatSwitch() } label: {
                    Image(systemName: "xmark").font(.caption2.weight(.semibold))
                }
                .buttonStyle(IconButtonStyle(padding: 2))
                .help(String(localized: "Call it off"))
                .accessibilityLabel(Text("Call off the waiting chat switch"))
                .accessibilityIdentifier("Cancel pending chat switch")
            }
            .padding(.leading, 6).padding(.trailing, 2).padding(.vertical, 2)
            .background(Color.accentColor.wash(colorScheme, light: 0.12, dark: 0.22), in: Capsule())
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text(verbatim: store.pendingChatSwitchText ?? ""))
            .accessibilityIdentifier("Pending chat switch")
        }
    }

    private func label(_ pending: PendingChatSwitch) -> String {
        switch pending {
        case .newChat: String(localized: "New chat waits")
        case let .openChat(id, _): String(localized: "Waits: \(store.chatTitle(id: id))")
        }
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
    /// Its place in the strip: ⌘1…⌘9 for the first nine.
    let index: Int
    let isCurrent: Bool
    let isRunning: Bool
    let blocker: String?
    let canClose: Bool
    /// polish P4-composer-08: an unsent draft waits in it.
    let hasDraft: Bool
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
                        .help(tabHelp)   // polish PX-02 / P4-composer-33: on the title — the badges keep theirs
                    if hasDraft {
                        Image(systemName: "pencil.circle.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                            .help(String(localized: "Unsent draft"))
                            .accessibilityLabel(Text("Unsent draft"))
                    }
                    if meta.resumeFailed { ReadOnlyChatBadge() }   // wave1 mac-session (§30)
                    if let moved = meta.movedTo { MovedChatBadge(moved: moved) }   // wave4b w4b-follow (§39.4)
                }
                .padding(.leading, 10).padding(.vertical, 5)   // inside the label: the whole tab is the target
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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
            .help(canClose ? String(localized: "Close tab (⌘⇧W) — the chat stays in History") : (blocker ?? String(localized: "The only open chat cannot be closed")))
            .accessibilityLabel(Text("Close the tab ‘\(title)’"))   // polish P4-composer-33: which tab
            .accessibilityIdentifier("Close chat tab \(title)")
        }
        .background(isCurrent ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28) : (hovering ? Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.06) : .clear),
                    in: RoundedRectangle(cornerRadius: 7))
        .onHover { hovering = $0 }
    }

    private var title: String { meta.title.isEmpty ? String(localized: "New chat") : meta.title }

    /// polish P4-composer-33: the whole title (a long one is cut) and its key; the running one says Claude is there.
    private var tabHelp: String {
        let live = isRunning || isLive
        guard index < 9 else { return live ? String(localized: "\(title) — Claude's session is on this chat") : title }
        return live ? String(localized: "\(title) — Claude's session is on this chat (⌘\(index + 1))") : String(localized: "\(title) (⌘\(index + 1))")
    }
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
    /// polish P4-composer-35: kept between openings.
    @AppStorage("chatHistoryShowArchived") private var showArchived = false
    /// polish P4-composer-35: the list is being read (no "아직 채팅이 없습니다" before it came).
    @State private var loading = true
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
                .frame(minHeight: 160)
                // polish P4-composer-35: ↩ opens the selected chat, ⌘⌫ asks to delete it; PX-08: ⌘C copies its title.
                .onKeyPress(.return) {
                    guard let id = selection, let meta = store.sessions.first(where: { $0.id == id }) else { return .ignored }
                    open(meta)
                    return .handled
                }
                .onDeleteCommand {
                    guard let id = selection, id != store.currentSessionId, let meta = store.sessions.first(where: { $0.id == id }) else { return }
                    deleteTarget = meta
                }
                .onCopyCommand {
                    guard let id = selection, let meta = store.sessions.first(where: { $0.id == id }) else { return [] }
                    let text = title(meta)
                    Toast.show(Clipboard.confirmation(for: text))
                    return [NSItemProvider(object: text as NSString)]
                }
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
            if loading, store.sessions.isEmpty {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Loading the chats…").font(.callout).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("Chat history loading")
            } else if rows.isEmpty, !searching {
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
        .adaptiveSheetFrame(width: 560, height: 460, minHeight: 300, key: "chatHistory")   // polish PX-18: fits a 1000×637 window, resizable
        .task {
            await store.refreshSessions()
            loading = false
        }
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
                    if meta.archived {   // polish PX-17
                        Text("Archived").font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.secondary.opacity(colorScheme == .dark ? 0.25 : 0.15), in: Capsule())
                            .foregroundStyle(.secondary)
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
                if let date = meta.updatedDate {
                    RelativeTimeText(date).font(.caption).foregroundStyle(.secondary)   // polish PX-21: the exact time on hover
                }
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
            .help("Chat actions — rename, archive, continue in terminal, delete")   // polish P4-composer-35
            .accessibilityLabel("Chat actions")
            .accessibilityIdentifier("Chat actions \(title(meta))")
        }
        .padding(.vertical, 2)
        .foregroundStyle(meta.archived ? Color.secondary : Color.primary)   // polish PX-17: dimmed text and a word, not a faded row
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
        // polish P4-composer-35: why it is off, in the item itself (a menu item's tooltip is not seen).
        Button(isCurrent ? String(localized: "Delete… (not the current chat)") : String(localized: "Delete…"), role: .destructive) { deleteTarget = meta }
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

    private func costText(_ usd: Double) -> String {
        usd < 0.01 && usd > 0 ? "<$0.01" : String(format: "$%.2f", usd)
    }
}
