import SwiftUI
import ReviewGateCore

// MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2 (daily-13): another chat tab is read without switching the Claude session.
// The bar above the composer says so and offers [이 채팅으로 이어가기]; while Claude works in the live chat sending waits with
// the reason and [실행 중인 채팅으로]. The review panel says whose review it shows. Logic: AppState+ChatViewing.swift.

/// Above the composer while another chat is shown read-only.
struct ViewingChatBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        if let viewed = store.viewingChat {
            let blocker = store.viewingSendBlocker
            let recordOnly = store.isReadOnlyChat(id: viewed.id)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Label(recordOnly ? String(localized: "Only the record of this chat is left — sending starts a new chat")
                                     : String(localized: "You're viewing this chat — sending continues it here"),
                          systemImage: "eye")
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("Viewing chat note")
                    Spacer(minLength: 4)
                    Button("Continue in this chat") { Task { await store.continueInViewedChat() } }
                        .controlSize(.small)
                        .disabled(blocker != nil)
                        .help(blocker ?? String(localized: "Moves Claude's session to this chat; the running chat stays in its tab"))
                        .accessibilityIdentifier("Continue in this chat")
                }
                if let blocker {
                    HStack(spacing: 8) {
                        Label(store.liveChatWaits ? String(localized: "Claude is waiting for you in '\(store.chatTitle(id: store.currentSessionId))'") : blocker,
                              systemImage: store.liveChatWaits ? "bell.badge" : "hourglass")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .accessibilityIdentifier("Viewing chat blocker")
                        Spacer(minLength: 4)
                        Button("Back to the running chat") { store.stopViewing() }
                            .controlSize(.small)
                            .accessibilityIdentifier("Back to the running chat")
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Viewing chat bar")
        }
    }
}

/// At the top of a chat shown read-only: loading, a failed read, or [이전 대화 더 보기] for its older rows.
struct ViewedChatHeader: View {
    @Environment(AppState.self) private var store
    let viewed: ViewedChat

    var body: some View {
        HStack(spacing: 6) {
            if viewed.loading {
                ProgressView().controlSize(.small)
                Text(viewed.rows.isEmpty ? String(localized: "Loading this chat…") : String(localized: "Show earlier messages"))
                    .font(.caption).foregroundStyle(.secondary)
            } else if let error = viewed.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                Button("Retry") {
                    store.stopViewing()
                    Task { await store.viewChat(id: viewed.id) }
                }
                .controlSize(.small)
            } else if viewed.canLoadEarlier {
                Button("Show earlier messages", systemImage: "arrow.up") { Task { await store.loadEarlierInViewedChat() } }
                    .controlSize(.small)
                    .accessibilityIdentifier("Viewed chat earlier messages")
            } else if viewed.rows.isEmpty {
                Text("No messages in this chat yet").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityIdentifier("Viewed chat header")
    }
}

/// The review panel while another chat is shown: the review is the running chat's.
struct ViewingReviewNote: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if store.viewingChat != nil {
            Label("This review belongs to the running chat ('\(store.chatTitle(id: store.currentSessionId))')", systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .accessibilityIdentifier("Viewing review note")
        }
    }
}

/// wave4b integration (§39.2 × §39.3): the agent panel while another chat is shown — its agents (this turn's and the
/// earlier turns') are the running chat's, as the review is.
struct ViewingAgentsNote: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if store.viewingChat != nil {
            Label("These agents belong to the running chat ('\(store.chatTitle(id: store.currentSessionId))')", systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .accessibilityIdentifier("Viewing agents note")
        }
    }
}
