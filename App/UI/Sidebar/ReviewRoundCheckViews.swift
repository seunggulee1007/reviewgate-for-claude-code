import SwiftUI
import ReviewGateCore

// MARK: wave3 check-clients
// The §34 pieces the Mac lacked next to Electron: "요청 후 바뀌지 않음" on a file with sent notes the follow-up left alone,
// and the words of the HUD's "진행 중" chip from `hud.turnFiles` on (the +/− once a list has every file); the turn summary
// card's whole-review totals after a merged turn (both clients).

/// "요청 후 바뀌지 않음": the follow-up to your request did not change this file (its notes are still "요청함").
struct UnchangedSinceRequestChip: View {
    var body: some View {
        TagChip("Unchanged since request", systemImage: "equal", tint: .secondary)
            .help("The follow-up to your request did not change this file")
            .accessibilityIdentifier("Unchanged since request")
    }
}

/// The "진행 중 변경" list before a `live_changes` list with files is in: how many the turn touched (↻ reads them).
struct LiveChangesPlaceholder: View {
    @Environment(AppState.self) private var store
    let files: Int

    var body: some View {
        Group {
            if store.isLoadingLiveChanges {
                Text("Loading…")
            } else {
                Text("Claude has changed \(files) file(s) so far")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("Live changes placeholder")
    }
}

extension LiveChipSummary {
    /// "진행 중: 파일 N개 · +A −D", or "진행 중: 파일 N개" until a `live_changes` list has every file.
    var text: String {
        if let added, let deleted { return String(localized: "In progress: \(files) files · +\(added) −\(deleted)") }
        return String(localized: "In progress: \(files) files")
    }
}

/// Under the range picker of a range other than "전체": "줄 곁질문은 / 부분 되돌리기는 ‘전체’ 보기에서 할 수 있어요" instead of
/// those controls just going away (§34.1; Electron's range row and hunk bar say the same).
struct DiffRangeHints: View {
    @Environment(AppState.self) private var store
    let file: ChangedFile

    var body: some View {
        let hints = store.rangeHints(for: file)
        if !hints.isEmpty {
            Text(verbatim: hints.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("Range hints")
        }
    }
}

/// The turn summary card's "리뷰 전체: 파일 N개 · +A −D" after a merged turn, on its own line under the header's numbers
/// (this turn's own, §34.3) — in the header it pushed the test line out of a narrow chat pane.
struct SummaryReviewTotalsLine: View {
    let totals: ChangeTotals

    var body: some View {
        let text = String(localized: "Whole review: \(totals.files) file(s) · +\(totals.added) −\(totals.deleted)")
        Label {
            Text(verbatim: text).font(.caption.monospacedDigit())
        } icon: {
            Image(systemName: "square.stack.3d.up").font(.caption2)
        }
        .foregroundStyle(.secondary)
        .padding(.leading, 26).padding(.trailing, 10).padding(.bottom, 6)
        .help("The review as a whole after this turn — the numbers before it are what this turn changed")
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityIdentifier("Turn summary review totals")
    }
}
