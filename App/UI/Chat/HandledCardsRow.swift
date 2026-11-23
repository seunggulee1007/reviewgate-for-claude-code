import SwiftUI
import ReviewGateCore

// docs/PROTOCOL.md §56.6: decided permission cards and questions one after another — "처리됨 · Bash npm test" line after
// line — as one quiet line, "권한 3건 처리됨 · 허용 2 · 거부 1", that opens to the lines it holds (each still opens to its
// card). It opens by itself while it holds the ⌘F match or the card a reveal flashes. Core `HandledCardFold`.

struct HandledCardsRow: View {
    @Environment(TranscriptViewState.self) private var view
    let run: HandledCardFold.Run<ExploreFold.Entry>
    let context: TranscriptRowContext
    let restored: Set<UUID>

    var body: some View {
        let expanded = view.handledExpansion[run.id] ?? holdsFocus
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeOut(duration: 0.12)) { view.handledExpansion[run.id] = !expanded }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .frame(width: 10)
                    Image(systemName: "checkmark.circle")
                    Text(verbatim: run.counts.summary)
                    if !run.counts.detail.isEmpty {
                        Text(verbatim: "· " + run.counts.detail).foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverHighlight(cornerRadius: 6)
            .help(expanded ? String(localized: "Fold the decided cards into one line") : String(localized: "Show each decided card"))
            .accessibilityLabel(Text(verbatim: run.counts.detail.isEmpty ? run.counts.summary : run.counts.summary + " · " + run.counts.detail))
            .accessibilityValue(expanded ? String(localized: "Expanded") : String(localized: "Collapsed"))
            .accessibilityIdentifier("Handled cards")
            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(run.elements) { entry in
                        TranscriptEntryView(entry: entry, context: context, restored: restored.contains(entry.id)).equatable()
                    }
                }
                .padding(.leading, 14)
            }
        }
    }

    /// The ⌘F match or the card a reveal flashes is in this run.
    private var holdsFocus: Bool {
        run.elements.contains { entry in
            if entry.id == view.currentMatch { return true }
            guard let flash = view.flashPermissionId, case let .node(.row(.permission(_, request, _))) = entry else { return false }
            return request.requestId == flash
        }
    }
}
