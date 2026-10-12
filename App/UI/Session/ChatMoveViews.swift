import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave4b w4b-follow
// docs/PROTOCOL.md §39.4 on the Mac: "이 채팅을 거기로 옮기기" (asks first while Claude works), the window of the worktree the
// chat moved to (fronted, or opened), the moved chat's line in this window and its tab badge.

@MainActor
enum ChatMoveActions {
    /// Installs the app-wide route once: the target's window takes the chat (`chat_receive`), or a new window opens it.
    static func installRoute() {
        guard ChatMoveRouter.route == nil else { return }
        ChatMoveRouter.route = { moved, source in
            let url = URL(fileURLWithPath: moved.path).standardizedFileURL
            if let entry = WorkbenchRegistry.shared.entry(for: url), entry.store !== source {
                if !entry.focus() { WorkbenchRegistry.shared.focusWindow(for: url) }
                Task { await entry.store.receiveMovedChat() }
            } else if let openWindow = FolderHandoffRouter.shared.openWindow {
                openWindow(id: "workbench", value: url)
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    /// Moves the chat to `path`; while Claude works it asks first ("멈추고 옮길까요?", with "거기서 이어서 하라고 보내기").
    static func move(store: AppState, to path: String) {
        let name = URL(fileURLWithPath: path).lastPathComponent
        var stop = false
        var continueThere = false
        if store.chatMoveNeedsStop {
            guard let answer = confirmStop(name: name) else { return }
            stop = true
            continueThere = answer
        }
        Task { await store.moveChat(to: path, stop: stop, continueThere: continueThere) }
    }

    /// Nil = Cancel; else whether to send the follow-up there (the checkbox, on by default).
    static func confirmStop(name: String) -> Bool? {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = ChatMoveText.confirmTitle
        alert.informativeText = ChatMoveText.confirmBody(name: name)
        alert.addButton(withTitle: ChatMoveText.confirmStopAndMove)
        alert.addButton(withTitle: String(localized: "Cancel"))
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = ChatMoveText.continueThere
        alert.suppressionButton?.state = .on
        alert.suppressionButton?.setAccessibilityIdentifier("Chat move continue there")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return alert.suppressionButton?.state == .on
    }
}

/// Above the composer: the chat moved to another worktree ("옮김 → name", read-only here, [그 창 열기]), or why the last
/// move was refused.
struct ChatMoveBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let moved = store.shownChatMovedTo {   // wave4b integration: the chat on screen (§39.2 read-only view too)
            bar(tint: .blue, icon: "arrow.right.square", text: ChatMoveText.movedBanner(name: moved.name)) {
                Button(ChatMoveText.openThatWindow) {
                    ProjectOpener.openInNewWindow(URL(fileURLWithPath: moved.path), openWindow: openWindow)
                }
                .controlSize(.small)
                .help(SessionNotices.abbreviatingHome(moved.path))
                .accessibilityIdentifier("Open moved chat window")
            }
            .accessibilityIdentifier("Moved chat bar")
        } else if let notice = store.chatMoveNotice {
            bar(tint: .orange, icon: "exclamationmark.triangle.fill", text: notice) {
                Button("Dismiss") { store.dismissChatMoveNotice() }
                    .controlSize(.small)
                    .accessibilityIdentifier("Dismiss chat move notice")
            }
            .accessibilityIdentifier("Chat move notice")
        }
    }

    private func bar(tint: Color, icon: String, text: String, @ViewBuilder actions: () -> some View) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(tint).accessibilityHidden(true)
            Text(verbatim: text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 4)
            actions()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(tint.wash(colorScheme, light: 0.10, dark: 0.18))
    }
}

/// The tab / history badge of a chat handed to another worktree.
struct MovedChatBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let moved: ChatMoveRef

    var body: some View {
        Text(verbatim: ChatMoveText.movedBadge(name: moved.name))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Color.blue.wash(colorScheme, light: 0.16, dark: 0.28), in: Capsule())
            .foregroundStyle(.secondary)
            .help(SessionNotices.abbreviatingHome(moved.path))
            .accessibilityIdentifier("Moved chat badge")
    }
}
