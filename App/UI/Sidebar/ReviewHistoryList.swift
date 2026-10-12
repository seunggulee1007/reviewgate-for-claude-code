import SwiftUI
import ReviewGateCore

/// §14 "Review history": past review rounds of this chat (or every chat of the worktree), newest first — when,
/// the prompt, the verdicts — and per round the files with their verdicts and the notes sent back. A file opens its
/// diff of that round read-only in the diff pane.
struct ReviewHistoryList: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    /// The rounds the user opened / closed (`historyExpansion`; the newest is open by default, the rest closed) and the
    /// search (`historyQuery`; wave4 w4-history — §38.3: a past change by path, request, note or commit subject) — the
    /// window's, so a trip to another tab keeps them.
    @Environment(WindowModel.self) private var model

    /// A round ends with the next fresh send (new snapshot A), an emptied review, or a chat switch: reload then. The round
    /// in progress also changes with each collection, verdict and note (wave2 mac-flow, §34.4).
    private var reloadKey: String {
        [store.projectInfo?.root ?? "", store.currentSessionId ?? "", store.gate.turnStartTree ?? "",   // wave7 w7-state (§45.2): slices
         String(store.changedFiles.count), String(store.pendingFiles.count), String(store.historyAllSessions),
         store.reviewTree ?? "", String(store.reviewNotes.count), String(store.changesRequestedFiles.count)].joined(separator: "|")
    }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            header
            TextField("Search paths, requests, notes, commits", text: $model.historyQuery)   // wave4 w4-history (§38.3)
                .textFieldStyle(.roundedBorder)
                .controlSize(.small)
                .onExitCommand { model.historyQuery = "" }   // Esc clears, as the find bars close
                .overlay(alignment: .trailing) {
                    // Inside the field (an overlay: the row keeps its height as the button comes and goes).
                    if !model.historyQuery.isEmpty {
                        Button { model.historyQuery = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .buttonStyle(IconButtonStyle(padding: 2))
                            .foregroundStyle(.secondary)
                            .help("Clear search")
                            .accessibilityLabel("Clear search")
                            .accessibilityIdentifier("Review history clear search")
                    }
                }
                .padding(.horizontal, 12).padding(.bottom, 6)
                .accessibilityIdentifier("Review history search")
            Divider()
            content
        }
        .task(id: reloadKey) { await store.loadReviewHistory() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Picker("Scope", selection: Binding(get: { store.historyAllSessions },
                                                set: { all in Task { await store.loadReviewHistory(allSessions: all) } })) {
                Text("This chat").tag(false)
                Text("All chats").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            .accessibilityIdentifier("History scope")
            Spacer(minLength: 4)
            if store.isLoadingHistory { ProgressView().controlSize(.small) }
            Button("Reload", systemImage: "arrow.clockwise") { Task { await store.loadReviewHistory() } }
                .labelStyle(.iconOnly)
                .buttonStyle(IconButtonStyle(padding: 2))
                .disabled(store.isLoadingHistory || store.projectInfo == nil)
                .help("Reload the review history")
                .accessibilityIdentifier("Reload history")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    @ViewBuilder
    private var content: some View {
        // wave2 mac-flow (§34.4): the round in progress sits on top, open, with the notes already sent.
        let query = model.historyQuery
        let current = store.currentReviewRound.flatMap { TranscriptHistory.filter([$0], query: query).first }   // wave4 w4-history
        let rounds = TranscriptHistory.filter(store.reviewHistory, query: query)
        if let error = store.historyLoadError, store.reviewHistory.isEmpty, current == nil {
            ContentUnavailableView("Could not load the history", systemImage: "exclamationmark.triangle",
                                   description: Text(verbatim: error))
                .frame(maxHeight: .infinity)
        } else if store.reviewHistory.isEmpty, current == nil {
            if store.isLoadingHistory {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("No past reviews", systemImage: "clock",
                                       description: Text("Finished review rounds appear here with their verdicts and diffs."))
                    .frame(maxHeight: .infinity)
            }
        } else if rounds.isEmpty, current == nil {   // wave4 w4-history: the search found nothing
            ContentUnavailableView {
                Label("No matching review round", systemImage: "magnifyingglass")
            } actions: {
                Button("Clear search") { model.historyQuery = "" }
                    .accessibilityIdentifier("Review history no match clear")
            }
                .frame(maxHeight: .infinity)
                .accessibilityIdentifier("Review history no match")
        } else {
            List {
                if let current {
                    let open = Binding(get: { model.historyExpansion[current.id] ?? true }, set: { model.historyExpansion[current.id] = $0 })
                    DisclosureGroup(isExpanded: open) {
                        files(of: current)
                    } label: {
                        HistoryEntryLabel(entry: current, sessionTitle: sessionTitle(current))
                    }
                    .accessibilityIdentifier("History current round")
                }
                ForEach(Array(rounds.enumerated()), id: \.element.id) { offset, entry in
                    let open = Binding(get: { model.historyExpansion[entry.id] ?? (offset == 0 && current == nil) },
                                       set: { model.historyExpansion[entry.id] = $0 })
                    DisclosureGroup(isExpanded: open) {
                        files(of: entry)
                    } label: {
                        HistoryEntryLabel(entry: entry, sessionTitle: sessionTitle(entry))
                    }
                    .accessibilityIdentifier("History entry")
                }
            }
            .listStyle(.sidebar)
            .accessibilityIdentifier("Review history")
        }
    }

    private func files(of entry: ReviewHistoryEntry) -> some View {
        ForEach(entry.files) { file in
            HistoryFileRow(entry: entry, file: file,
                           selected: store.historySelection == HistorySelection(entryId: entry.id, path: file.path)) {
                Task { await store.openHistoryDiff(entryId: entry.id, path: file.path) }
            }
        }
    }

    /// With "All chats", the chat a round ran in.
    private func sessionTitle(_ entry: ReviewHistoryEntry) -> String? {
        guard store.historyAllSessions, let id = entry.sessionId else { return nil }
        return store.sessions.first { $0.id == id }?.title
    }
}

private struct HistoryEntryLabel: View {
    let entry: ReviewHistoryEntry
    let sessionTitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if entry.inProgress {
                    // wave2 mac-flow (§34.4): the round still under review.
                    TagChip("In progress", systemImage: "circle.dotted", tint: .blue)
                        .accessibilityIdentifier("History in progress")
                }
                Text(verbatim: when).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if let sessionTitle {
                    Text(verbatim: sessionTitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Text(verbatim: "+\(entry.totalAdds)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
                Text(verbatim: "−\(entry.totalDels)").font(.caption2.monospacedDigit()).foregroundStyle(.red)
            }
            Text(verbatim: entry.prompt.isEmpty ? "—" : entry.prompt)
                .font(.callout)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .truncationMode(.tail)
                .help(entry.prompt)
            FlowLayout(spacing: 4) {
                ForEach(entry.verdictCounts, id: \.verdict) { item in
                    VerdictChip(verdict: item.verdict, count: item.count)
                }
                if entry.rejectedHunks > 0 {
                    TagChip(Text("Partial revert \(entry.rejectedHunks)"), systemImage: "scissors", tint: .purple)
                }
                // §31.5: closed by "Finish review" — what was still pending stayed on disk, unreviewed.
                if entry.finished {
                    TagChip("Review finished", systemImage: "flag.checkered", tint: .secondary)
                        .help("Closed with Finish review — the files still pending were left on disk as they were, unreviewed")
                        .accessibilityIdentifier("History finished")
                }
            }
        }
        .padding(.vertical, 3)
    }

    /// Today: the time; otherwise date and time.
    private var when: String {
        guard let date = entry.endedDate else { return entry.endedAt }
        return Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct HistoryFileRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(WindowModel.self) private var model
    let entry: ReviewHistoryEntry
    let file: ReviewHistoryFile
    let selected: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(file.status.rawValue)
                        .font(.caption.weight(.bold).monospaced())
                        .foregroundStyle(statusColor(file.status))
                        .frame(width: 12)
                    pathText(file.path).font(.callout).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    Text(verbatim: "+\(file.adds)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
                    Text(verbatim: "−\(file.dels)").font(.caption2.monospacedDigit()).foregroundStyle(.red)
                }
                FlowLayout(spacing: 4) {
                    VerdictChip(verdict: file.verdict)
                    if file.verdict == .accepted { AutoAcceptedChip(rule: file.autoAccepted, path: file.path) }   // MARK: wave4c w4c-trust (§41.2)
                    if file.committed {
                        TagChip("Committed", systemImage: "checkmark.seal.fill", tint: .green)
                            .help(file.commit.map { String(localized: "Commit: \($0.subject)") } ?? "")   // wave4 w4-history (§38.3)
                    }
                    if file.changesRequested > 0 {
                        TagChip(Text("Sent back \(file.changesRequested)×"), systemImage: "exclamationmark.bubble", tint: .orange)
                    }
                    if file.rejectedHunks > 0 {
                        TagChip(Text("Partial revert \(file.rejectedHunks)"), systemImage: "scissors", tint: .purple)
                    }
                }
                ForEach(Array(entry.notes(for: file.path).enumerated()), id: \.offset) { _, note in
                    HStack(alignment: .top, spacing: 4) {
                        Image(systemName: "text.bubble.fill").font(.caption2).foregroundStyle(.orange)
                        if let line = note.line {
                            Text(verbatim: "\(note.side == .old ? "−" : "+")\(line)")
                                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        Text(verbatim: note.body).font(.caption).lineLimit(3)
                    }
                }
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(file.oldPath.map { String(localized: "\(file.path) (from \($0))") } ?? file.path)
        .contextMenu {
            Button("Copy Path", systemImage: "doc.on.doc") { DiffLineCopyMenuItems.copy(file.path) }
            Button("Mention in Chat", systemImage: "at") {
                model.mentionPaths = [file.path]
                model.mentionTick &+= 1
            }
            .disabled(file.status == .deleted)   // as the Changes list: that round deleted it
            Divider()
            SideQuestionMenuItems(anchor: SideAnchor(path: file.path, entryId: entry.id))   // §21: about what that round proposed
        }
        .accessibilityIdentifier("History file \(file.path)")
    }
}

/// A review verdict as a colored chip (optionally with a count).
struct VerdictChip: View {
    let verdict: HistoryVerdict
    var count: Int?

    var body: some View {
        let text = count.map { Text(verbatim: "\(verdict.displayName) \($0)") } ?? Text(verbatim: verdict.displayName)
        switch verdict {
        case .accepted: TagChip(text, systemImage: "checkmark", tint: .green)
        case .rejected: TagChip(text, systemImage: "arrow.uturn.backward", tint: .orange)
        case .changesRequested: TagChip(text, systemImage: "exclamationmark.bubble.fill", tint: .yellow)
        case .pending: TagChip(text, systemImage: "questionmark", tint: .secondary)
        }
    }
}
