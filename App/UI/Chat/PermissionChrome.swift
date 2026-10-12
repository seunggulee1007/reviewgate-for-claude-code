import SwiftUI
import ReviewGateCore

// wave1 mac-perms — the pieces around the permission cards (docs/PROTOCOL.md §33, §29): the toast for a card that was
// already handled, the HUD chips ("권한 요청 N개 대기", "{fromNames} 요청"), the agent panel's "권한 대기" row with
// [카드로 이동], and the key mapping the focused cards use (polish-01).

extension CardShortcutKey {
    /// ⌘↩ / ⌥⌘↩ / ⌘⌫ / Esc from a SwiftUI key press; nil for any other key or modifier combination.
    init?(_ press: KeyPress) {
        let modifiers = press.modifiers.intersection([.command, .option, .shift, .control])
        if press.key == .return || press.key == KeyEquivalent("\u{3}") {   // return, keypad enter
            if modifiers == .command { self = .commandReturn; return }
            if modifiers == [.command, .option] { self = .optionCommandReturn; return }
            return nil
        }
        if press.key == .delete || press.key == .deleteForward || press.characters == "\u{7F}" || press.characters == "\u{8}" {
            if modifiers == .command { self = .commandDelete; return }
            return nil
        }
        if press.key == .escape, modifiers.isEmpty { self = .escape; return }
        return nil
    }
}

/// A notice about a permission card ("이미 처리된 권한 요청입니다"): informational, never red; goes away after 4 s or on click.
struct PermissionToast: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        VStack {
            if let notice = store.permissionNotice {
                Label(notice.text, systemImage: "info.circle.fill")
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35)))
                    .shadow(color: .black.opacity(colorScheme == .dark ? 0.45 : 0.15), radius: 6, y: 2)
                    .onTapGesture { store.dismissPermissionNotice() }
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("Permission notice")
                    .task(id: notice.id) {
                        try? await Task.sleep(for: .seconds(4))
                        if !Task.isCancelled, store.permissionNotice?.id == notice.id { store.dismissPermissionNotice() }
                    }
            }
        }
        .padding(.top, 8)
        .allowsHitTesting(store.permissionNotice != nil)
        .animation(.easeOut(duration: 0.15), value: store.permissionNotice?.id)
    }
}

/// The HUD's permission flag: "권한 대기 중", or "권한 요청 N개 대기" from two open requests on. Click: the oldest card.
struct PermissionPendingChip: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        let count = store.openPermissions.count
        let text = count > 1 ? String(localized: "\(count) permission requests waiting") : String(localized: "Permission pending")
        Button {
            if let first = store.openPermissions.first { model.revealPermission(requestId: first.requestId) }
        } label: {
            Label(text, systemImage: "hand.raised.fill")
                .foregroundStyle(.orange)
        }
        .buttonStyle(.plain)
        .fixedSize().layoutPriority(1)
        .help("Show the permission card that has waited longest")
        .accessibilityLabel(text)
        .accessibilityIdentifier("HUD permission")
    }
}

/// §29: "{fromNames} 요청" while the running turn is accepted peer messages.
struct PeerTurnChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        if let badge = store.peerTurnBadge {
            Label(badge, systemImage: "bubble.left.and.bubble.right.fill")
                .lineLimit(1)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Color.purple.wash(colorScheme, light: 0.13, dark: 0.24), in: Capsule())
                .foregroundStyle(Color.purple)
                .fixedSize().layoutPriority(1)
                .help("This turn runs a message another Claude session sent — the names are what the sender claims")
                .accessibilityIdentifier("HUD peer turn")
        }
    }
}

/// The agent panel / timeline: this subagent waits for a permission answer — orange "권한 대기" and [카드로 이동].
struct AgentPermissionWaiting: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(WindowModel.self) private var model
    let request: PermissionRequest
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            TagChip(Text("Waiting for permission"), systemImage: "hand.raised.fill", tint: .orange)
                .help(Text("Permission: \(request.toolName)"))
            if !compact {
                Text(verbatim: request.input["command"]?.stringValue ?? request.toolName)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            Button {
                model.revealPermission(requestId: request.requestId)
            } label: {
                if compact { Image(systemName: "arrow.right.circle") } else { Label("Go to card", systemImage: "arrow.right.circle") }
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("Scroll the chat to this agent's permission card")
            .accessibilityLabel("Go to card")
            .accessibilityIdentifier("Agent go to permission card")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent waiting for permission")
    }
}
