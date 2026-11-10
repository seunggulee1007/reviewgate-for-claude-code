import SwiftUI
import ReviewGateCore

/// wave4 w4-input (polish-06): the Chat menu — ⌘T a new chat, ⌘⇧W closes the tab on screen, ⌘1…⌘9 the chat tab at that
/// place. A blocked switch is a disabled item, as the tab strip's `+` and tabs are. Electron has the same keys
/// (src/renderer/keymap.ts). ⌘W stays the window's (File › Close).
/// MARK: wave7 w7-state — §45.2: it reads the window's `menuState` alone (the tabs' titles, the live chat, the blocker).
/// MARK: r2-chats-cards — polish P4-composer-05 / PX-19: Stop (⌘.) is found here (no longer only a running button's key),
/// with Commands… (⌘/), Chat History… (⌘Y), the next / previous tab (⌃⇥ / ⌃⇧⇥), Rename, the permission mode, Attach
/// Images… and Reopen Closed Chat Tab (⌘⇧T).
struct ChatCommands: Commands {
    let focused: WorkbenchWindowEntry?

    var body: some Commands {
        CommandMenu("Chat") {
            let store = focused?.store
            let model = focused?.model
            let menu = store?.menuState ?? MenuState()
            Button("New chat") { if let store { Task { await store.newChat() } } }
                .keyboardShortcut("t", modifiers: .command)
                .disabled(!menu.hasProject || menu.newChatBlocked)   // r2-chats-cards M31: while Claude works it waits for the turn
                .accessibilityIdentifier("Chat menu New chat")
            // As the tab's ×: a chat shown read-only hands back to the live one; the live chat's tab waits for a switch.
            Button("Close Chat Tab") {
                if let store, let model, let id = store.shownChatId {
                    Task { if await store.closeChatTab(id: id) { ClosedChatTabs.remember(id, in: model) } }
                }
            }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .disabled(!menu.canCloseShownTab)
                .accessibilityIdentifier("Chat menu Close Chat Tab")
            Button("Reopen Closed Chat Tab") {
                if let store, let model { Task { await ClosedChatTabs.reopen(store: store, model: model) } }
            }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                .disabled(!menu.hasChatSessions || (model?.closedChatTabs.isEmpty ?? true))
                .accessibilityIdentifier("Chat menu Reopen Closed Chat Tab")
            Divider()
            Button("Stop Claude") { store?.interrupt() }
                .keyboardShortcut(".", modifiers: .command)
                .disabled(!menu.isRunning)
                .accessibilityIdentifier("Chat menu Stop")
            Button("Commands…") { model?.commandsTick += 1 }
                .keyboardShortcut("/", modifiers: .command)
                .disabled(!menu.hasProject)
            Button("Chat History…") { model?.showChatHistoryTick += 1 }
                .keyboardShortcut("y", modifiers: .command)
                .disabled(!menu.hasChatSessions)
            Divider()
            Button("Show Next Chat Tab") { step(1, menu: menu) }
                .keyboardShortcut(.tab, modifiers: .control)
                .disabled(menu.chatTabs.count < 2)
            Button("Show Previous Chat Tab") { step(-1, menu: menu) }
                .keyboardShortcut(.tab, modifiers: [.control, .shift])
                .disabled(menu.chatTabs.count < 2)
            Button("Rename Chat…") { model?.renameChatTick += 1 }
                .disabled(!menu.hasChatSessions)
            Divider()
            Menu("Permission Mode") {
                ForEach(PermissionMode.allCases) { mode in
                    Toggle(mode.displayName, isOn: Binding(get: { menu.permissionMode == mode }, set: { _ in store?.pickPermissionMode(mode) }))
                }
                Divider()
                Text("⇧⇥ in the message box cycles the modes")
            }
            .disabled(!menu.canPickPermissionMode)
            Button("Attach Images…") { model?.attachImagesTick += 1 }
                .disabled(!menu.hasProject)
            if !menu.chatTabs.isEmpty { Divider() }
            ForEach(Array(menu.chatTabs.enumerated()), id: \.element.id) { index, tab in
                Button(tab.title.isEmpty ? String(localized: "New chat") : tab.title) { focused?.model.chatTabRequest = tab.id }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                    .disabled(tab.isCurrent)   // §39.2: a tab only shows the chat (read-only) — never refused
            }
        }
    }

    /// ⌃⇥ / ⌃⇧⇥: the tab after / before the one on screen, around the ends (as a tab click shows it).
    private func step(_ by: Int, menu: MenuState) {
        let ids = menu.chatTabs.map(\.id)
        guard ids.count > 1 else { return }
        let at = menu.shownChatId.flatMap { ids.firstIndex(of: $0) } ?? 0
        focused?.model.chatTabRequest = ids[(at + by + ids.count) % ids.count]
    }
}

/// PX-19: the chats whose tabs were closed in this window (`WindowModel.closedChatTabs`), for "닫은 채팅 탭 다시 열기" (⌘⇧T)
/// and the tab strip's "탭을 닫았어요 · 다시 열기" — the chat is still in the history; reopening shows it in a tab.
@MainActor
enum ClosedChatTabs {
    static let limit = 20

    static func remember(_ id: String, in model: WindowModel) {
        model.closedChatTabs.removeAll { $0 == id }
        model.closedChatTabs.append(id)
        if model.closedChatTabs.count > limit { model.closedChatTabs.removeFirst(model.closedChatTabs.count - limit) }
    }

    /// The last closed chat that still exists comes back as a tab (shown read-only, as a tab click shows it).
    static func reopen(store: AppState, model: WindowModel) async {
        while let id = model.closedChatTabs.popLast() {
            guard store.sessions.contains(where: { $0.id == id }) else { continue }
            await store.openTabReadOnly(id: id)
            return
        }
    }
}
