import SwiftUI
import ReviewGateCore

// MARK: §53 commits in meaningful units
// docs/PROTOCOL.md §53 on the Mac: the commit sheet's "나눠서 커밋" mode — the accepted changes as commit cards (a message
// each, the files and their hunks, a → menu to move a file or a hunk to another card or to "커밋하지 않음", up / down /
// delete), "AI로 나누기" (`commit_split_draft`, with "원래대로 되돌리기") and "커밋 N개 만들기" (`commit_series`). The state and
// the words are Core's (`CommitSplitSession`, `CommitSplitState`, `CommitSplitText`); this is the screen.

/// The split mode under the commit sheet's mode picker, with its own actions (Cancel / Close, "커밋 N개 만들기").
struct CommitSplitPanel: View {
    @Environment(AppState.self) private var store
    @Bindable var session: CommitSplitSession
    @Binding var push: Bool
    /// The sheet's "Commit at once" checklist (hidden in this mode) and the rest of the sheet stay; this closes it.
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AIRow(session: session)
            if let line = session.loadError {
                warning(line).accessibilityIdentifier("Split error")
            } else if session.files == nil {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(verbatim: CommitSplitText.loading).font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(session.state.cards.enumerated()), id: \.element.id) { index, card in
                            cardView(card, index: index)
                        }
                        Button {
                            session.state.addCard()
                        } label: {
                            Label("Add commit", systemImage: "plus")
                        }
                        .controlSize(.small)
                        .disabled(session.isCommitting || session.stopped)
                        .accessibilityIdentifier("Add commit")
                        notCommittedView
                    }
                    .padding(.trailing, 10)   // clear of the scroller
                }
                .frame(minHeight: 150, maxHeight: 330)
                .accessibilityIdentifier("Split cards")
            }
            if let error = session.commitError {
                stopView(error)
            }
            Toggle("Push to origin", isOn: $push)
                .disabled(session.isCommitting || session.stopped)
                .accessibilityIdentifier("Commit push")
            if !store.commitIdentity.isComplete {
                Label(commitRefusalText("git_identity_missing"), systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                if session.isCommitting { ProgressView().controlSize(.small) }
                if let blocker, !session.isCommitting {
                    Text(verbatim: blocker)
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2)
                        .accessibilityIdentifier("Split blocker")
                }
                Spacer(minLength: 8)
                Button(session.stopped ? "Close" : "Cancel", role: .cancel, action: onClose)
                    .keyboardShortcut(.cancelAction)
                    .disabled(session.isCommitting)
                Button("Make \(session.state.cards.count) commit(s)", action: make)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(blocker != nil)
                    .help(blocker.map { Text(verbatim: $0) } ?? Text(verbatim: "⌘↩"))
                    .accessibilityIdentifier("Make commits")
            }
        }
        .task(id: ObjectIdentifier(session)) { await session.load(store) }
    }

    /// "AI로 나누기", its progress, "원래대로 되돌리기" after a proposal, and why the last one failed (one line).
    struct AIRow: View {
        @Environment(AppState.self) private var store
        @Bindable var session: CommitSplitSession

        var body: some View {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Button {
                        Task { await session.splitWithClaude(store) }
                    } label: {
                        Label("Split with Claude", systemImage: "sparkles")
                    }
                    .controlSize(.small)
                    .disabled(!session.canSplit)
                    .help("Claude proposes the smallest meaningful commits, in an order where each one builds — in a read-only side session; nothing is committed")
                    .accessibilityIdentifier("Split with Claude")
                    if session.isSplitting {
                        ProgressView().controlSize(.small)
                        Text(verbatim: CommitSplitText.splitting).font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("Split progress")
                    } else if session.state.canRestore {
                        Button("Restore the previous split") { session.state.restore() }
                            .buttonStyle(.link)
                            .controlSize(.small)
                            .disabled(session.isCommitting || session.stopped)
                            .accessibilityIdentifier("Restore split")
                    }
                    Spacer(minLength: 0)
                }
                if let line = session.splitError, !session.isSplitting {
                    Label(line, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                        .lineLimit(2)
                        .help(line)
                        .accessibilityIdentifier("Split with Claude error")
                }
            }
        }
    }

    /// Why "커밋 N개 만들기" is off: the mode's own reason, else the sheet's (a turn, its collection, a revert, a failed
    /// collection).
    private var blocker: String? {
        session.blocker ?? store.commitLockReason
    }

    private func make() {
        guard blocker == nil else { return }
        let pushNow = push
        Task {
            if await session.commit(store, push: pushNow) != nil { onClose() }   // the Changes banner names the commits
        }
    }

    // MARK: Cards

    private func cardView(_ card: SplitCard, index: Int) -> some View {
        let place = SplitTarget.card(card.id)
        let locked = session.isCommitting || session.stopped
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text("Commit \(index + 1)").font(.caption.weight(.semibold))
                Spacer()
                Group {
                    Button { session.state.reorder(card.id, by: -1) } label: { Image(systemName: "arrow.up") }
                        .help("Move up").accessibilityLabel("Move up")
                        .disabled(index == 0)
                    Button { session.state.reorder(card.id, by: 1) } label: { Image(systemName: "arrow.down") }
                        .help("Move down").accessibilityLabel("Move down")
                        .disabled(index == session.state.cards.count - 1)
                    Button { session.deleteCard(card.id) } label: { Image(systemName: "xmark") }
                        .help("Delete this commit — its changes go to Not committed").accessibilityLabel("Delete this commit")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(locked)
            }
            TextField("Commit message", text: Binding(
                get: { card.message },
                set: { session.state.setMessage($0, card: card.id) }), axis: .vertical)
                .font(.callout.monospaced())
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
                .disabled(locked)
                .accessibilityLabel(Text("Commit message") + Text(verbatim: " \(index + 1)"))
                .accessibilityIdentifier("Split message \(index + 1)")
            if let why = card.why {
                Text(verbatim: why)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Split why \(index + 1)")
            }
            if card.parts.isEmpty {
                Text("No changes in this commit").font(.caption).foregroundStyle(.secondary)
            } else {
                partRows(card.parts, in: place)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Split card \(index + 1)")
    }

    private var notCommittedView: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Not committed").font(.caption.weight(.semibold))
            if session.state.unassigned.isEmpty {
                Text("Everything is in a commit").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("These stay uncommitted and in the review").font(.caption).foregroundStyle(.secondary)
                partRows(session.state.unassigned, in: .notCommitted)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Split not committed")
    }

    // MARK: Files and hunks

    /// One row per file (in the order the parts have), its hunks under it; a whole-only file is one row.
    private func partRows(_ parts: [SplitPart], in place: SplitTarget) -> some View {
        let paths = parts.reduce(into: [String]()) { if !$0.contains($1.path) { $0.append($1.path) } }
        return VStack(alignment: .leading, spacing: 3) {
            ForEach(paths, id: \.self) { path in
                fileRow(path, parts: parts.filter { $0.path == path }, in: place)
            }
        }
    }

    private func fileRow(_ path: String, parts mine: [SplitPart], in place: SplitTarget) -> some View {
        let file = session.file(path)
        let whole = mine.count == 1 && mine[0].hunk == nil
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: whole ? "doc" : "doc.text")
                    .font(.caption).foregroundStyle(.secondary)
                Text(verbatim: path)
                    .font(.caption.monospaced())
                    .lineLimit(1).truncationMode(.middle)
                    .help(path)
                if let file, !file.wholeOnly, mine.count < file.hunks.count {
                    Text("\(mine.count) of \(file.hunks.count) parts").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                MoveMenu(label: path, targets: session.state.targets(from: place), title: title(of:)) { to in
                    session.moveFile(path, from: place, to: to)
                }
                .disabled(session.isCommitting || session.stopped)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Split file \(path)")
            if !whole {
                ForEach(mine, id: \.self) { part in
                    hunkRow(part, file: file, in: place)
                }
            }
        }
    }

    private func hunkRow(_ part: SplitPart, file: CommitFile?, in place: SplitTarget) -> some View {
        let hunk = file?.hunks.first { $0.id == part.hunk }
        let expanded = session.isExpanded(part, in: place)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Button {
                    session.toggleExpanded(part, in: place)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .frame(width: 10)
                        Text(verbatim: "#\(part.hunk ?? 0) \(hunk?.header ?? "")")
                            .font(.caption.monospaced())
                            .lineLimit(1).truncationMode(.tail)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Show the change")
                .accessibilityIdentifier("Split hunk \(part.key)")
                if let hunk {
                    HStack(spacing: 3) {
                        Text(verbatim: "+\(hunk.added)").foregroundStyle(.green)
                        Text(verbatim: "−\(hunk.deleted)").foregroundStyle(.red)
                    }
                    .font(.caption2.monospaced())
                }
                Spacer(minLength: 4)
                MoveMenu(label: "\(part.path) #\(part.hunk ?? 0)", targets: session.state.targets(from: place), title: title(of:)) { to in
                    session.movePart(part, from: place, to: to)
                }
                .disabled(session.isCommitting || session.stopped)
            }
            if expanded, let hunk {
                HunkLinesView(text: hunk.text)
            }
        }
        .padding(.leading, 18)
    }

    private func title(of target: SplitTarget) -> String {
        switch target {
        case let .card(id): String(localized: "Commit \(session.state.number(of: id) ?? 0)")
        case .notCommitted: String(localized: "Not committed")
        }
    }

    // MARK: Messages

    private func warning(_ line: String) -> some View {
        Label(line, systemImage: "exclamationmark.triangle")
            .font(.caption).foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// A series that failed: the commits it made (they stay — the sheet can only be closed), then why it stopped.
    private func stopView(_ error: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.red)
                .textSelection(.enabled)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("Split commit error")
            ForEach(session.made) { commit in
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    Text(verbatim: commit.shortSha).font(.caption.monospaced())
                    Text(verbatim: commit.subject).font(.caption).lineLimit(1).truncationMode(.tail)
                }
                .padding(.leading, 18)
            }
        }
    }
}

/// The "→" menu of a file or a hunk: the other cards, then "커밋하지 않음".
private struct MoveMenu: View {
    let label: String
    let targets: [SplitTarget]
    let title: (SplitTarget) -> String
    let onPick: (SplitTarget) -> Void

    var body: some View {
        Menu {
            ForEach(targets, id: \.self) { target in
                Button(title(target)) { onPick(target) }
            }
        } label: {
            Image(systemName: "arrow.right")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .controlSize(.small)
        .fixedSize()
        .disabled(targets.isEmpty)
        .help("Move to another commit")
        .accessibilityLabel(Text("Move \(label) to…"))
        .accessibilityIdentifier("Split move")
    }
}

/// A hunk's lines as the engine sent them (≤ 300): added green, removed red, context secondary — one text, selectable.
private struct HunkLinesView: View {
    let text: String

    var body: some View {
        Text(attributed)
            .font(.caption.monospaced())
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor).opacity(0.6)))
            .accessibilityIdentifier("Split hunk text")
    }

    private var attributed: AttributedString {
        var out = AttributedString()
        for (i, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            var piece = AttributedString((i == 0 ? "" : "\n") + line)
            switch line.first {
            case "+": piece.foregroundColor = .green
            case "-": piece.foregroundColor = .red
            default: piece.foregroundColor = .secondary
            }
            out += piece
        }
        return out
    }
}
