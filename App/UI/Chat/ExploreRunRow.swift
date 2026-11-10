import SwiftUI
import ReviewGateCore

// MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2 (market-12): a run of reads / searches / read-only commands as one line,
// "탐색: 파일 12개 읽음 · 검색 5회"; it opens to the rows. Settings › General "탐색 행 자세히 보기" shows every row instead.

struct ExploreRunRow<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    let run: ExploreRun
    /// The session is running (an open call spins).
    let running: Bool
    @Binding var expanded: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .frame(width: 10)
                    Image(systemName: "magnifyingglass")
                        .font(.caption)
                    Text(running && run.counts.open > 0 ? String(localized: "Exploring: \(run.counts.summary)")
                                                        : String(localized: "Explored: \(run.counts.summary)"))
                        .font(.callout)
                        .lineLimit(1)
                    if running && run.counts.open > 0 { ProgressView().controlSize(.mini) }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(expanded ? String(localized: "Fold the reads and searches into one line") : String(localized: "Show every read and search"))
            .accessibilityLabel(String(localized: "Explored: \(run.counts.summary)"))
            .accessibilityValue(expanded ? String(localized: "Expanded") : String(localized: "Collapsed"))
            .accessibilityIdentifier("Explore run")
            if expanded {
                VStack(alignment: .leading, spacing: 10) { content() }
                    .padding(.leading, 14)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(Color.primary.opacity(colorScheme == .dark ? 0.06 : 0.035), in: RoundedRectangle(cornerRadius: 8))
    }
}
