import SwiftUI
import ReviewGateCore

/// wave4 w4-input (polish-06): the Chat menu — ⌘T a new chat, ⌘⇧W closes the tab on screen, ⌘1…⌘9 the chat tab at that
/// place. A blocked switch is a disabled item, as the tab strip's `+` and tabs are. Electron has the same keys
/// (src/renderer/keymap.ts). ⌘W stays the window's (File › Close).
/// MARK: wave7 w7-state — §45.2: it reads the window's `menuState` alone (the tabs' titles, the live chat, the blocker).
struct ChatCommands: Commands {
    let focused: WorkbenchWindowEntry?

    var body: some Commands {
        CommandMenu("Chat") {
            let store = focused?.store
            let menu = store?.menuState ?? MenuState()
            Button("New chat") { if let store { Task { await store.newChat() } } }
                .keyboardShortcut("t", modifiers: .command)
                .disabled(!menu.hasProject || menu.chatSwitchBlocked)
                .accessibilityIdentifier("Chat menu New chat")
            // As the tab's ×: a chat shown read-only hands back to the live one; the live chat's tab waits for a switch.
            Button("Close Chat Tab") {
                if let store, let id = store.shownChatId { Task { await store.closeChatTab(id: id) } }
            }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .disabled(!menu.canCloseShownTab)
                .accessibilityIdentifier("Chat menu Close Chat Tab")
            if !menu.chatTabs.isEmpty { Divider() }
            ForEach(Array(menu.chatTabs.enumerated()), id: \.element.id) { index, tab in
                Button(tab.title.isEmpty ? String(localized: "New chat") : tab.title) { focused?.model.chatTabRequest = tab.id }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                    .disabled(tab.isCurrent || menu.chatSwitchBlocked)
            }
        }
    }
}
