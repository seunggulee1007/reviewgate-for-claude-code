import SwiftUI
import ReviewGateCore

// docs/PROTOCOL.md §60 on the Mac: the PR's Conversation (description, general comments and reviews as one thread, with
// "Leave a comment" under it).

/// The opened PR's Conversation: the description, then the comments and the reviews by time, then the composer.
struct PRConversationView: View {
    @Environment(PRStore.self) private var store

    /// Login of the account for the selected PR's host, so the user's own entries stand out.
    private var me: String? {
        let host = store.selectedSummary?.host ?? store.host
        return store.accounts.first { $0.host == host }?.login
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(PRTimeline.items(selected: store.selected, conversation: store.conversation, reviews: store.reviews)) { item in
                    PRTimelineRow(item: item, me: me, prURL: store.selected?.url)
                }
                Divider().padding(.vertical, 4)
                ConversationComposer()
            }
            .frame(maxWidth: 820, alignment: .leading)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("PR conversation")
    }
}

/// One entry of the thread: who, what kind, when (the exact time on hover), the body as Markdown, and "Open on GitHub".
private struct PRTimelineRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    let item: PRTimelineItem
    let me: String?
    let prURL: String?

    private var author: String {
        switch item {
        case let .description(author, _): author
        case let .comment(c): c.author
        case let .review(r): r.author
        }
    }

    private var text: String {
        switch item {
        case let .description(_, body): PRTimeline.displayBody(body)
        case let .comment(c): PRTimeline.displayBody(c.body)
        case let .review(r): PRTimeline.displayBody(r.body)
        }
    }

    private var url: URL? {
        let raw: String? = switch item {
        case .description: prURL
        case let .comment(c): c.url
        case let .review(r): r.url
        }
        return raw.flatMap { $0.isEmpty ? nil : URL(string: $0) }
    }

    private var mine: Bool { me != nil && author == me }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if !text.isEmpty {
                MarkdownText(text: text)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if case .description = item {
                Text("No description provided.").font(.callout).italic().foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(Color.secondary.wash(colorScheme, light: 0.05, dark: 0.10), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.wash(colorScheme, light: 0.20, dark: 0.30)))
        .overlay(alignment: .leading) {
            if mine { RoundedRectangle(cornerRadius: 1).fill(Color.accentColor).frame(width: 2).padding(.vertical, 6) }
        }
        .contextMenu {
            if let url { Button("Open on GitHub", systemImage: "arrow.up.right.square") { openURL(url) } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Conversation \(item.id)")
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.caption).foregroundStyle(.secondary)
            Text(verbatim: author).font(.callout.weight(.semibold)).lineLimit(1)
            if mine { Text("you").font(.caption2).foregroundStyle(.secondary) }
            switch item {
            case .description: Text("opened this pull request").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            case let .review(r): PRReviewStateBadge(state: r.state)
            case .comment: EmptyView()
            }
            if let date = item.date {
                Text(date, format: .relative(presentation: .named))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    .help(date.formatted(date: .complete, time: .shortened))
            }
            if case let .comment(c) = item, c.isEdited, let edited = c.updatedAt {
                Text("edited").font(.caption).foregroundStyle(.secondary)
                    .help(String(localized: "Edited \(edited.formatted(date: .abbreviated, time: .shortened))"))
            }
            Spacer(minLength: 4)
            if let url {
                Button("Open on GitHub", systemImage: "arrow.up.right.square") { openURL(url) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .foregroundStyle(.secondary)
                    .help("Open on GitHub")
                    .accessibilityIdentifier("Open conversation item on GitHub")
            }
        }
    }

    private var icon: String {
        switch item {
        case .description: "text.alignleft"
        case .comment: "bubble.left"
        case let .review(r):
            switch r.state {
            case "APPROVED": "checkmark.circle"
            case "CHANGES_REQUESTED": "exclamationmark.bubble"
            default: "eye"
            }
        }
    }
}

/// A review's state as a small capsule: Approved / Changes requested / Commented (Pending, Dismissed).
struct PRReviewStateBadge: View {
    let state: String

    var body: some View {
        let (label, color): (String, Color) = switch state {
        case "APPROVED": (String(localized: "Approved"), .green)
        case "CHANGES_REQUESTED": (String(localized: "Changes requested"), .red)
        case "COMMENTED": (String(localized: "Commented"), .secondary)
        case "PENDING": (String(localized: "Pending"), .orange)
        case "DISMISSED": (String(localized: "Dismissed"), .secondary)
        default: (state, .secondary)
        }
        Text(label)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}
