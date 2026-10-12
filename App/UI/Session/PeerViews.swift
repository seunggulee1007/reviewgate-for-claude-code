import SwiftUI
import ReviewGateCore

// Messages from the user's other Claude sessions (PROTOCOL §29): the card above the composer, the transcript rows, the
// project menu and the Settings section.

/// The inbox card (`state.session.peerInbox`), pinned above the composer: who sent something, what Claude would see, and
/// "Claude가 처리" / "거절" / "이 프로젝트는 받지 않기". Several messages share one card; they are accepted or declined together.
struct PeerInboxCard: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        let inbox = store.peerInbox
        let busy = store.isPeerBusy || store.isPeerDelivering
        let blocked = store.peerAcceptBlockedReason
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.and.text.bubble.right.fill")
                    .foregroundStyle(Color.teal)
                    .accessibilityHidden(true)
                if inbox.count > 1 {
                    Text(verbatim: PeerText.messagesTitle(count: inbox.count)).font(.callout.weight(.semibold))
                } else if let only = inbox.first {
                    senderLine(only)
                }
                Spacer(minLength: 4)
                if busy {
                    ProgressView().controlSize(.small)
                    Text(verbatim: PeerText.delivering).font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("Peer card delivering")
                }
            }
            if inbox.count > 1 {
                ForEach(inbox) { message in
                    HStack(spacing: 4) {
                        Text(verbatim: "•").foregroundStyle(.secondary)
                        senderLine(message, compact: true)
                    }
                }
            } else if let only = inbox.first, only.cause == "mode-mismatch" {
                Text(verbatim: PeerText.modeMismatch).font(.caption).foregroundStyle(.secondary)
            }
            Text(verbatim: PeerText.cardHint)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let note = store.peerAcceptNote {
                Label(note, systemImage: "checklist")
                    .font(.caption).foregroundStyle(.orange)
                    .accessibilityIdentifier("Peer card review note")
            }
            if let notice = store.peerNotice {
                Label(notice, systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Peer card notice")
            }
            HStack(spacing: 8) {
                Button("Let Claude handle it") { store.acceptPeerMessages() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(blocked != nil || store.heldPeerMessages.isEmpty)
                    .help(blocked ?? String(localized: "Hands the messages to Claude as one turn; its changes are reviewed like any other"))
                    .accessibilityIdentifier("Peer accept")
                Button("Decline") { store.dismissPeerMessages() }
                    .controlSize(.small)
                    .disabled(busy || store.heldPeerMessages.isEmpty)
                    .help("The sending session is told the message was not delivered")
                    .accessibilityIdentifier("Peer dismiss")
                Menu {
                    Button("Don't accept for this project") { store.setProjectPeerInbound(.off) }
                        .accessibilityIdentifier("Peer off for project")
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .disabled(busy)   // wave2 check-clients: also while the messages are handed over (delivering), as in Electron
                .accessibilityLabel("More")
                .accessibilityIdentifier("Peer card more")
                if let blocked, !busy {
                    Text(verbatim: blocked).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .accessibilityIdentifier("Peer card waits")
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.teal.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.teal.wash(colorScheme, light: 0.35, dark: 0.45)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Peer inbox card")
    }

    /// "**acme-b4** sent a message" — the name in bold; it is what the sender says it is.
    private func senderLine(_ message: PeerMessage, compact: Bool = false) -> some View {
        let name = message.senderName
        var line = AttributedString(PeerText.sentMessage(from: name))
        if let range = line.range(of: name) { line[range].inlinePresentationIntent = .stronglyEmphasized }
        return HStack(spacing: 4) {
            Text(line).font(compact ? .caption : .callout)
            if compact, message.cause == "mode-mismatch" {
                Text(verbatim: PeerText.modeMismatch).font(.caption).foregroundStyle(.secondary)
            }
            if message.state == .delivering {
                ProgressView().controlSize(.mini)
            }
        }
        .help(message.from)
    }
}

/// A peer message in the transcript: delivered (its turn's first row, where a user message would be), dropped (declined,
/// expired, the session ended), or read by an older CLI without being held (with "이 메시지 처리하기").
struct PeerMessageRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let message: PeerMessage

    var body: some View {
        switch message.state {
        case .delivered where message.unprompted:
            unpromptedCard
        case .delivered:
            delivered
        default:
            Label(PeerText.droppedText(message), systemImage: "bubble.left.and.exclamationmark.bubble.right")
                .font(.callout)
                .foregroundStyle(.secondary)
                .help(message.from)
                .accessibilityIdentifier("Peer message dropped")
        }
    }

    /// Incoming style (left, teal) — the user's own messages sit on the right.
    private var delivered: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 5) {
                Label(PeerText.deliveredHeader(message), systemImage: "bubble.left.and.text.bubble.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.teal)
                    .help(message.from)
                if let body = message.body, !body.isEmpty {
                    MarkdownText(text: body)
                }
                if let pid = message.verifiedPeerPid {
                    Text(verbatim: PeerText.verifiedPid(pid))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help("The process id the system confirmed for the sending connection")
                }
            }
            .padding(10)
            .background(Color.teal.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 10))
            Spacer(minLength: 40)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Peer message")
    }

    private var unpromptedCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(PeerText.unpromptedHeader, systemImage: "bubble.left.and.exclamationmark.bubble.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(verbatim: PeerText.deliveredHeader(message)).font(.caption).foregroundStyle(.secondary)
            if let body = message.body, !body.isEmpty {
                MarkdownText(text: body)
            }
            // wave2 check-clients: once — the button then says it went out as the user's message.
            let handled = store.isUnpromptedPeerMessageHandled(message)
            Button(handled ? PeerText.sentAsYourMessage : PeerText.handleThisMessage) { store.handleUnpromptedPeerMessage(message) }
                .controlSize(.small)
                .disabled(handled || (message.body?.isEmpty ?? true))
                .help("Sends the message as your own request — its changes go through the review")
                .accessibilityIdentifier("Handle peer message")
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Unprompted peer message")
    }
}

/// The project menu's "다른 세션 메시지" (`peer_set`; the current value is `state.session.peerInbound`).
struct PeerInboundProjectMenu: View {
    @Environment(AppState.self) private var store

    var body: some View {
        Menu("Messages from Other Sessions") {
            ForEach(PeerInboundMode.allCases) { mode in
                Button {
                    store.setProjectPeerInbound(mode)
                } label: {
                    if store.state.session.peerInbound == mode {
                        Label(mode.displayName, systemImage: "checkmark")
                    } else {
                        Text(verbatim: mode.displayName)
                    }
                }
                .accessibilityIdentifier("Peer mode \(mode.rawValue)")
            }
        }
        .disabled(store.projectInfo == nil || store.state.session.peerInbound == nil)
        .accessibilityIdentifier("Peer mode menu")
    }
}

/// Settings › General: the default for every project (a project's own choice in its menu wins), applied live.
struct PeerInboundSettingsSection: View {
    @AppStorage(AppSettings.Key.peerInbound) private var raw = PeerInboundMode.ask.rawValue

    var body: some View {
        Section("Messages from other sessions") {
            Picker("Messages from other sessions", selection: $raw) {
                ForEach(PeerInboundMode.allCases) { Text(verbatim: $0.displayName).tag($0.rawValue) }
            }
            .accessibilityIdentifier("Peer inbound")
            Text("When another Claude session of yours (a terminal, the IDE) sends a message to this window's Claude: ask with a card, let Claude handle it once it is idle (the changes are still reviewed), or decline it. A project can choose its own in the project menu.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .onChange(of: raw) { _, new in
            let mode = PeerInboundMode(wire: new) ?? .ask
            for store in WorkbenchRegistry.shared.allStores { store.updatePeerInbound(mode) }
        }
    }
}
