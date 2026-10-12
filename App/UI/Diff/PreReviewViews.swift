import SwiftUI
import ReviewGateCore

// MARK: wave3 mac-flow
// docs/PROTOCOL.md §36.13 on the Mac: "AI pre-review" in the Changes head (a read-only side session runs /code-review on this
// round; "사전 리뷰 중… / 지적 N개 / 실패: 이유", cancel), a badge per file, a mark on the diff line and an inline card with
// "노트로 추가 / 곁질문 / 무시". The main chat's own ReportFindings show the same way. Nothing here changes a file: "Add as
// note" is an ordinary review note (sent with Request changes), "Ask in a side thread" an ordinary side question.

/// The Changes head's row: the button (with the effort and "this file only") and the status of the latest run.
struct PreReviewHeadControl: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.preReviewEffort) private var effortRaw = PreReviewEffort.medium.rawValue

    private var effort: PreReviewEffort { PreReviewEffort(rawValue: effortRaw) ?? .medium }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                status
                Spacer(minLength: 4)
                startButton
            }
            if let line = reasonLine {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Label(line, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .help(line)
                        .accessibilityIdentifier("Pre-review notice")
                    if store.flow.preReviewSupported {
                        Spacer(minLength: 0)
                        Button { store.flow.clearPreReviewError() } label: { Image(systemName: "xmark") }
                            .buttonStyle(IconButtonStyle(padding: 2))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .help("Dismiss")
                            .accessibilityLabel("Dismiss")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Pre-review head")
    }

    @ViewBuilder
    private var status: some View {
        switch store.preReviewStatus {
        case .idle:
            EmptyView()
        case let .running(prereviewId):
            ProgressView().controlSize(.small)
            Text("Pre-reviewing…")
                .font(.caption.weight(.medium))
                .foregroundStyle(.purple)
                .accessibilityIdentifier("Pre-review running")
            Button {
                Task { await store.flow.cancelPreReview(prereviewId) }
            } label: {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(IconButtonStyle(padding: 2))
            .foregroundStyle(.secondary)
            .help("Cancel the pre-review")
            .accessibilityLabel("Cancel the pre-review")
            .accessibilityIdentifier("Cancel pre-review")
        case let .done(count, stale):
            Button {
                if let path = store.firstPreReviewPath { _ = store.selectFile(path: path) }
            } label: {
                Label("\(count) findings", systemImage: "sparkles")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(count > 0 ? Color.purple : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(count == 0)
            .help(count > 0 ? String(localized: "Open the first file with a finding") : String(localized: "The pre-review found nothing"))
            .accessibilityIdentifier("Pre-review findings")
            if stale {
                TagChip("Earlier version", systemImage: "clock.arrow.circlepath", tint: .secondary)
                    .help("The pre-review looked at an earlier version of these changes; lines may have moved")
            }
        case let .failed(reason):
            Label {
                Text("Failed: \(reason)")
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(.caption)
            .foregroundStyle(.orange)
            .lineLimit(1)
            .truncationMode(.tail)
            .help(reason)
            .accessibilityIdentifier("Pre-review failed")
        }
    }

    private var startButton: some View {
        Menu {
            Picker("Effort", selection: $effortRaw) {
                ForEach(PreReviewEffort.allCases) { Text(verbatim: $0.title).tag($0.rawValue) }
            }
            .pickerStyle(.inline)
            Divider()
            Button("Pre-review the selected file only") {
                if let path = store.selectedPath { start(scope: .files, paths: [path]) }
            }
            .disabled(store.selectedPath == nil)
        } label: {
            Label("AI pre-review", systemImage: "sparkles")
        } primaryAction: {
            start(scope: .round, paths: nil)
        }
        .menuStyle(.button)
        .controlSize(.small)
        .fixedSize()
        .disabled(store.preReviewBlocker != nil)
        .help(store.preReviewBlocker ?? String(localized: "Claude reviews this round's changes first, in a read-only side session — findings go on the diff lines, not into the chat (effort \(effort.title))"))
        .accessibilityLabel("AI pre-review")
        .accessibilityIdentifier("AI pre-review")
    }

    /// An engine without §36.13, or the last start / cancel / dismiss refused (one line; the next action clears it).
    private var reasonLine: String? {
        if !store.flow.preReviewSupported { return FlowText.updateReason }
        return store.flow.preReviewError
    }

    private func start(scope: PreReviewScope, paths: [String]?) {
        let effort = effort
        Task { await store.flow.startPreReview(scope: scope, paths: paths, effort: effort) }
    }
}

/// "✦ 2" on a changed file with pre-review findings.
struct PreReviewFileBadge: View {
    @Environment(AppState.self) private var store
    let path: String

    var body: some View {
        if let count = store.preReviewCounts[path], count > 0 {
            TagChip(Text(verbatim: String(count)), systemImage: "sparkles", tint: .purple)
                .help(String(localized: "\(count) findings"))
                .accessibilityLabel(String(localized: "\(count) findings"))
                .accessibilityIdentifier("Pre-review badge \(path)")
        }
    }
}

/// The mark at the end of a diff line that carries pre-review findings. wave7 w7-state (§45.2): the row knows from the
/// findings keyed by line (`PreReviewDisplay.findingsByLine`) — no lookup over every run per row.
struct PreReviewLineMarkIcon: View {
    var body: some View {
        Image(systemName: "sparkles")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.purple)
            .padding(.trailing, 8)
            .help("AI pre-review finding on this line")
            .accessibilityLabel("AI pre-review finding on this line")
    }
}

/// One finding under its line (or in the file's list): what may break, and what to do with it.
struct PreReviewFindingCard: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    let item: PreReviewItem
    /// The diff line's text (a note's excerpt); "" for a finding without a line on screen.
    var excerpt: String = ""
    /// Shown in the file's list: the line it is about.
    var showsLine = false

    private var finding: PreReviewFinding { item.finding }
    private var stale: Bool { store.isPreReviewStale(item.run) }
    private var busy: Bool { store.flow.isBusy(finding, of: item.run.prereviewId) }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").font(.caption2.weight(.bold)).foregroundStyle(.purple)
                Text("AI pre-review").font(.caption.weight(.semibold)).foregroundStyle(.purple)
                if showsLine {
                    Text(verbatim: finding.line.map { "+\($0)" } ?? String(localized: "whole file"))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                if let category = finding.category {
                    TagChip(Text(verbatim: category), tint: .purple)
                }
                if item.run.source == .main {
                    TagChip("From the chat", systemImage: "bubble.left", tint: .secondary)
                        .help("Claude reported this in the main chat (ReportFindings)")
                }
                if stale {
                    TagChip("Earlier version", systemImage: "clock.arrow.circlepath", tint: .secondary)
                        .help("The pre-review looked at an earlier version of these changes; lines may have moved")
                }
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.mini) }
            }
            Text(verbatim: finding.summary.isEmpty ? finding.shortSummary : finding.summary)
                .font(.callout.weight(.medium))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !finding.failureScenario.isEmpty {
                Text(verbatim: finding.failureScenario)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 6) {
                Button("Add as note", systemImage: "text.bubble") {
                    let excerpt = excerpt
                    Task { await store.flow.addAsNote(finding, of: item.run.prereviewId, excerpt: excerpt) }
                }
                .disabled(busy || store.isNoteLocked)
                .help(store.isNoteLocked ? AppState.sessionRefusalText("session_running")
                      : String(localized: "A review note on this line — sent to Claude with Request changes (⌘⇧C)"))
                .accessibilityIdentifier("Pre-review add as note")
                if store.side.isSupported {
                    Button("Ask in a side thread", systemImage: "bubble.left.and.text.bubble.right") {
                        store.side.askNow(anchor: SideAnchor(path: finding.file, line: finding.line, side: finding.line == nil ? nil : .new),
                                          question: PreReviewDisplay.sideQuestion(finding))
                    }
                    .help("Ask about this finding in a side question — the main conversation is not affected")
                    .accessibilityIdentifier("Pre-review ask")
                }
                Button("Dismiss finding", systemImage: "xmark") {
                    Task { await store.flow.dismiss(finding, of: item.run.prereviewId) }
                }
                .disabled(busy)
                .help("Remove this finding")
                .accessibilityIdentifier("Pre-review dismiss")
                Spacer(minLength: 0)
            }
            .controlSize(.small)
            .labelStyle(.titleAndIcon)
        }
        .padding(8)
        .background(Color.purple.wash(colorScheme, light: 0.06, dark: 0.13), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.purple.wash(colorScheme, light: 0.30, dark: 0.45)))
        .opacity(stale ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Pre-review finding \(finding.id)")
    }
}

/// Above the diff: the file's findings that no shown line carries (the whole file, a line outside the hunks).
struct PreReviewUnplacedSection: View {
    @Environment(AppState.self) private var store
    let file: ChangedFile
    let diff: FileDiff?

    var body: some View {
        let lines = Set((diff?.allLines ?? []).compactMap { $0.kind == .del ? nil : $0.newNo })
        let items = store.preReviewCounts[file.path] == nil ? [] : store.preReviewUnplaced(path: file.path, newLines: lines)
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items) { item in
                    PreReviewFindingCard(item: item, showsLine: true)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Pre-review findings without a line")
            Divider()
        }
    }
}
