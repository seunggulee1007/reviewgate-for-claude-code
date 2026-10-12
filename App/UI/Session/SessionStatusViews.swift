import SwiftUI
import ReviewGateCore

/// Audit daily-03: the badge on the sidebar's "Changes" segment while another tab is in front — a blue pulse while
/// Claude works, an orange "!" while it waits for the user, the number of files waiting for review otherwise.
/// Drawn over the segmented picker's first (equal-width) segment.
struct ChangesTabBadge: View {
    @Environment(AppState.self) private var store
    let tab: MainTab

    var body: some View {
        GeometryReader { geo in
            let segment = geo.size.width / CGFloat(MainTab.allCases.count)
            badge
                .position(x: max(segment - 9, 9), y: 3)
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private var badge: some View {
        if tab != .changes {
            switch store.changesTabStatus {
            case .idle:
                EmptyView()
            case .working:
                PulseDot(color: .blue, size: 6)
                    .accessibilityElement()
                    .accessibilityLabel(Text("Claude is working"))
                    .accessibilityIdentifier("Changes tab working")
            case .waiting:
                Text(verbatim: "!")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundStyle(.white)
                    .frame(width: 13, height: 13)
                    .background(Color.orange, in: Circle())
                    .accessibilityLabel(Text(verbatim: store.claudeWaitingText))
                    .accessibilityIdentifier("Changes tab waiting")
            case let .review(count):
                Text(verbatim: count > 99 ? "99+" : String(count))
                    .font(.system(size: 9, weight: .bold).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 4).frame(minWidth: 14, minHeight: 13)
                    .background(Color.accentColor, in: Capsule())
                    .accessibilityLabel(Text("\(count) files waiting for review"))
                    .accessibilityIdentifier("Changes tab review")
            }
        }
    }
}

/// Audit daily-03: a thin bar over the PR browser while Claude waits for the user (a permission, a question, a plan, a
/// message from another session); a click goes back to the Changes tab, where the card is.
struct ClaudeWaitingBar: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    let onReturn: () -> Void

    var body: some View {
        if store.changesTabStatus == .waiting {
            Button(action: onReturn) {
                HStack(spacing: 6) {
                    Image(systemName: "hand.raised.fill")
                    Text(verbatim: store.claudeWaitingText).font(.callout.weight(.medium))
                    Spacer(minLength: 4)
                    Image(systemName: "arrow.uturn.backward")
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.orange)
            .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.22))
            .help("Back to the Changes tab")
            .accessibilityIdentifier("Claude waiting bar")
            Divider()
        }
    }
}
