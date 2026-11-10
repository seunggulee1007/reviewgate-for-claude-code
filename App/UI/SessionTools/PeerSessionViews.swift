import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave4d w4d-peers
// docs/PROTOCOL.md §42.2 on the Mac (audit peer-05, peer-07): under the SendMessage card's receiving session, where it runs
// (a terminal or an app, its folder, its state) and its address; in the "Other Claude sessions" section, the name the
// user's other sessions see this window under — to tell a terminal Claude — with its address and a copy button.

/// The SendMessage card's second line: "터미널 · ~/acme · 입력 대기" and the address; nothing for an older engine.
struct PeerRecipientDetail: View {
    let content: SendMessageCardContent

    var body: some View {
        let detail = PeerSessionText.recipientDetail(content.toSession)
        let address = PeerSessionText.recipientAddress(content)
        if !detail.isEmpty || address != nil {
            VStack(alignment: .leading, spacing: 1) {
                // r2-peers (polish P4-composer-24): a line cut in the middle shows all of it on hover.
                if !detail.isEmpty {
                    TruncatedText(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let address {
                    TruncatedText(address)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("SendMessage recipient detail")
        }
    }
}

/// "다른 세션에 보이는 이 창 이름: ReviewGate · acme [복사]" — shown once this window's CLI is in the registry.
struct PeerSelfLine: View {
    @Environment(AppState.self) private var store
    @State private var copied = false

    var body: some View {
        if let me = store.sessionTools.selfSession, let copy = PeerSessionText.selfCopyText(me) {
            HStack(spacing: 6) {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text("This window's name for other sessions")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: me.name ?? me.address ?? "")
                        .font(.caption)
                        .lineLimit(1).truncationMode(.middle)
                        .textSelection(.enabled)
                }
                // r2-peers (polish PX-03): the explanation sits on the name, not on the row — the row's .help hid the copy
                // button's own ("복사됨").
                .help(Text("Tell a terminal Claude to send to this name and the message comes to this window. \(copy)"))
                Spacer(minLength: 4)
                Button {
                    Clipboard.copy(copy)   // "복사됨: …" in the toast, as every copy
                    copied = true
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                }
                .buttonStyle(IconButtonStyle(padding: 2))   // `.borderless` left the glyph alone as the target
                .padding(.vertical, -2)
                .help(copied ? Text("Copied") : Text("Copy this window's name and address"))
                .accessibilityLabel(Text("Copy this window's name and address"))
                .accessibilityIdentifier("Copy peer name")
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Peer self")
        }
    }
}
