import SwiftUI
import ReviewGateCore

// wave2 mac-flow — the diff header's §34 pieces: the range picker (전체 / 이번 턴 / 요청 이후 / 수락 이후), the banner over a
// diff read while Claude works (§34.2), what the pane says when there is no diff during a turn, and the per-file chips.

/// "전체 / 이번 턴 / 요청 이후 / 수락 이후": only the ranges this file has; nothing when the whole review is the only one.
struct DiffRangePicker: View {
    @Environment(AppState.self) private var store
    let file: ChangedFile

    var body: some View {
        let ranges = store.availableRanges(for: file)
        if ranges.count > 1 {
            Picker("Diff range", selection: Binding(get: { store.diffSince(for: file) }, set: { store.setDiffRange($0, for: file) })) {
                ForEach(ranges, id: \.self) { since in
                    Text(verbatim: since.label).tag(since)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            .help("Which part of the change the diff shows: the whole review, this turn, since your change request, or since you accepted the file")
            .accessibilityIdentifier("Diff range")
            DiffRangeHints(file: file)   // wave3 check-clients: what this range leaves to 전체, said (as Electron)
        }
    }
}

/// §34.2: the diff is the review as it was before the running turn — read-only until the turn is collected. Reject's
/// reason is said here (accept still works on a standing review); the Changes list says it only while this is hidden.
struct StaleDiffBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "hourglass").foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Claude is working — this is the diff from before this turn (read-only)")
                    .font(.callout.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Stale diff text")
                if !store.pendingFiles.isEmpty, let reason = store.rejectLockReason {
                    Text(verbatim: reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("Stale diff reject reason")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.blue.wash(colorScheme, light: 0.08, dark: 0.16))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Stale diff banner")
    }
}

/// A turn runs and there is no B to show this file from (a turn on a fresh review, or an engine before §34) — said
/// instead of a spinner that would never end.
struct DiffUnavailableDuringTurn: View {
    var body: some View {
        ContentUnavailableView("No diff while Claude works", systemImage: "hourglass",
                               description: Text("It appears when this turn ends."))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("Diff unavailable during turn")
    }
}

/// The file was accepted earlier in this review and a later turn changed it ("수락 이후" shows what changed).
struct ChangedAfterAcceptChip: View {
    var body: some View {
        TagChip("Changed after accept", systemImage: "arrow.triangle.2.circlepath", tint: .orange)
            .help("You accepted this file earlier in this review; a later turn changed it again")
    }
}

/// §34.5: the file's content changed after you viewed its diff.
struct ChangedSinceViewedChip: View {
    var body: some View {
        TagChip("Changed since viewed", systemImage: "eye.trianglebadge.exclamationmark", tint: .blue)
            .help("The file changed after you viewed its diff")
    }
}
