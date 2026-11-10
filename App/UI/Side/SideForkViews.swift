import SwiftUI
import ReviewGateCore

// wave3 mac-agents — docs/PROTOCOL.md §36.10 (SME-02): what a side question knows of the main conversation.

/// At the top of a thread: "턴 N 진행 중 — 요약만 전달됨" when it started while turn N ran (the fork holds the turns before;
/// that turn's request, latest text and tool calls came as a summary), or that it started without the conversation.
struct SideForkNotice: View {
    @Environment(\.colorScheme) private var colorScheme
    let fork: SideFork?

    var body: some View {
        if let turn = fork?.runningTurn {
            HStack(spacing: 5) {
                Image(systemName: "clock.badge.exclamationmark").font(.system(size: 10, weight: .semibold))
                Text("Turn \(turn) in progress — only a summary was shared")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.orange)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.20), in: Capsule())
            .help(Text("This side question started while turn \(turn) was running: it got that turn's request, its latest text and its tool calls as a summary, not the whole turn."))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("Side running turn chip")
        } else if fork?.mode == .fresh {
            Label("Started without the main conversation (no finished turn yet) — the anchor context is all it knows.",
                  systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("Side fresh notice")
        }
    }
}

/// The new-question view's line: what the fork will hold — the conversation up to the last finished turn, the running
/// turn only as a summary — and never the review list, which no side prompt carries.
struct SideForkKnowsLine: View {
    @Environment(AppState.self) private var store

    var body: some View {
        Label(SideForkText.newQuestionKnows(turnCount: store.finishedTurnsInChat, running: store.isRunning), systemImage: "text.bubble")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("Side fork knows")
    }
}
