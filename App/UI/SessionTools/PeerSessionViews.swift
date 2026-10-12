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
                if !detail.isEmpty {
                    Text(verbatim: detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                if let address {
                    Text(verbatim: address)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(1).truncationMode(.middle)
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
                Spacer(minLength: 4)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(copy, forType: .string)
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
            .help(Text("Tell a terminal Claude to send to this name and the message comes to this window. \(copy)"))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Peer self")
        }
    }
}
