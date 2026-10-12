import SwiftUI
import ReviewGateCore

// wave2 mac-flow — §34.4: a note that went to Claude with "Request changes" stays on its line as "요청함: …" until the
// user checks it off ("반영 확인"); a line that no longer exists says so ("위치 사라짐"), and notes without a line in the
// diff on screen are listed above it instead of disappearing.

/// One note in the diff: a sent one as `SentNoteCard`, an unsent one as the orange `NoteBubble`.
struct ReviewNoteCard: View {
    @Environment(AppState.self) private var store
    let note: ReviewNote

    var body: some View {
        if note.sent != nil {
            // wave3 check-clients: "반영 확인" waits (disabled, with why) while the change request it answers runs.
            SentNoteCard(note: note, lockReason: store.noteLockReason) { store.markAddressed(note) }
        } else {
            NoteBubble(note: note, canSend: store.canRequestChanges, lockReason: store.noteLockReason,
                       onEdit: { store.editNote(id: note.id, body: $0) },
                       onSendOnly: { store.requestChanges(extraMessage: nil, noteIds: [note.id]) },
                       onDelete: { store.removeNote(id: note.id) })
        }
    }
}

/// "요청함: <note>" with [반영 확인] (removes it): Claude was asked; check the follow-up did it.
struct SentNoteCard: View {
    @Environment(\.colorScheme) private var colorScheme
    let note: ReviewNote
    /// wave3 check-clients: why "반영 확인" waits (a change request's follow-up runs); nil when it can be used.
    var lockReason: String? = nil
    let onAddressed: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "paperplane.fill").font(.caption2).foregroundStyle(.orange)
                if let line = note.line {
                    Text(verbatim: "\(note.side == .old ? "−" : "+")\(line)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                if note.anchor == .gone { LineGoneChip() }
                Spacer(minLength: 0)
                Button("Mark as addressed", systemImage: "checkmark.circle", action: onAddressed)
                    .controlSize(.small)
                    .disabled(lockReason != nil)
                    .help(lockReason.map { Text(verbatim: $0) } ?? Text("Claude did what this note asked — remove it"))
                    .accessibilityIdentifier("Mark as addressed")
            }
            Text("Requested: \(note.body)")
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if note.anchor == .gone, !note.excerpt.isEmpty {
                // The line it was written on, so the user can find what took its place.
                Text(verbatim: note.excerpt)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(8)
        .background(Color.orange.wash(colorScheme, light: 0.05, dark: 0.10), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6)
            .strokeBorder(Color.orange.wash(colorScheme, light: 0.45, dark: 0.55), style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Sent note")
    }
}

/// "위치 사라짐": the note's line was rewritten or removed by a later turn.
struct LineGoneChip: View {
    var body: some View {
        TagChip("Line no longer exists", systemImage: "questionmark.square.dashed", tint: .orange)
            .help("A later change rewrote or removed the line this note was on")
            .accessibilityIdentifier("Line no longer exists")
    }
}

/// The selected file's notes that have no line in the diff on screen (gone lines, old-side notes in a range, lines the
/// range leaves out), above the diff.
struct DisplacedNotesSection: View {
    @Environment(AppState.self) private var store
    let file: ChangedFile

    var body: some View {
        let notes = store.displacedNotes(path: file.path)
        if !notes.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(notes) { note in ReviewNoteCard(note: note) }
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
            }
            .frame(maxHeight: 170)
            .fixedSize(horizontal: false, vertical: notes.count <= 2)
            .accessibilityIdentifier("Notes off this diff")
            Divider()
        }
    }
}
