import SwiftUI
import AppKit
import ReviewGateCore

// wave1 mac-review — docs/PROTOCOL.md §31–§32 in the review UI: who changed a file (external badge), the mods risks,
// uncaptured / gitignored files, and the window-level modals: the second confirmation before external files are
// reverted, the stale-review sheet and the "Finish review" confirmation.

/// "앱 밖 변경": the file changed outside Claude's tools (the IDE, another session, a git pull).
struct ExternalChip: View {
    var body: some View {
        TagChip(Text(verbatim: ReviewProvenanceText.externalBadge), systemImage: "tray.and.arrow.down.fill", tint: .secondary)
            .help(ReviewProvenanceText.externalHelp)
            .accessibilityLabel(Text(verbatim: ReviewProvenanceText.externalBadge))
    }
}

/// A mods file's risk, red: what the change makes run or lets through from the next prompt on.
struct ModsRiskChip: View {
    let risk: ModsRisk

    private var icon: String {
        switch risk {
        case .hook: "bolt.fill"
        case .script: "scroll.fill"
        case .mcp: "server.rack"
        case .permissions: "lock.open.fill"
        case .env: "key.fill"
        case .other: "exclamationmark.triangle.fill"
        }
    }

    var body: some View {
        TagChip(Text(verbatim: risk.label), systemImage: icon, tint: .red)
            .help(Text("Claude Code configuration — it takes effect from the next prompt, in every session of this project"))
    }
}

/// r1-git (§46): "커밋됨 abc1234" — Claude's own commit holds the change; the file stays in the review.
struct CommittedChip: View {
    let sha: String

    var body: some View {
        TagChip(Text(verbatim: GitNoticeText.committedBadge(sha)), systemImage: "checkmark.seal", tint: .secondary)
            .help(GitNoticeText.committedHelp(sha))
            .accessibilityLabel(Text(verbatim: GitNoticeText.committedBadge(sha)))
            .accessibilityIdentifier("Committed badge")
    }
}

/// The §31–32 badges of a changed file: outside the app, the mods risks, not captured, gitignored (and §46: committed).
struct ProvenanceChips: View {
    let file: ChangedFile

    var body: some View {
        if let sha = file.committedIn { CommittedChip(sha: sha) }   // r1-git (§46)
        if file.isExternal { ExternalChip() }
        ForEach(file.risk, id: \.self) { ModsRiskChip(risk: $0) }
        if file.uncaptured {
            TagChip("Not captured", systemImage: "eye.slash", tint: .orange)
                .help(ReviewProvenanceText.uncaptured)
                .accessibilityLabel(Text(verbatim: ReviewProvenanceText.uncaptured))
        }
        if file.ignored {
            TagChip("Gitignored", systemImage: "nosign", tint: .secondary)
                .help(ReviewProvenanceText.ignored)
                .accessibilityLabel(Text(verbatim: ReviewProvenanceText.ignored))
        }
    }
}

/// The diff header's §31–32 lines: the external / mods risk badges, then what cannot be done with the file, in full.
struct DiffProvenanceHeader: View {
    let file: ChangedFile

    var body: some View {
        if file.isExternal || !file.risk.isEmpty || file.uncaptured || file.ignored || file.committedIn != nil {
            VStack(alignment: .leading, spacing: 3) {
                if file.isExternal || !file.risk.isEmpty || file.committedIn != nil {
                    FlowLayout(spacing: 4) {
                        if let sha = file.committedIn { CommittedChip(sha: sha) }   // r1-git (§46)
                        if file.isExternal { ExternalChip() }
                        ForEach(file.risk, id: \.self) { ModsRiskChip(risk: $0) }
                    }
                }
                if file.uncaptured {
                    Label(ReviewProvenanceText.uncaptured, systemImage: "eye.slash")
                        .font(.caption).foregroundStyle(.orange)
                        .accessibilityIdentifier("Uncaptured notice")
                }
                if file.ignored {
                    Label(ReviewProvenanceText.ignored, systemImage: "nosign")
                        .font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("Ignored notice")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Diff provenance")
        }
    }
}

// MARK: - Window-level modals

/// Attached once to the window: the second confirmation before files from outside the app are reverted (one file or
/// "Reject all" with them), the stale-review sheet, and the "Finish review" confirmation (toolbar / menu).
struct ReviewProvenanceModals: ViewModifier {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    func body(content: Content) -> some View {
        @Bindable var model = model
        content
            .alert(Self.confirmQuestion(store.externalRejectRequest),
                   isPresented: Binding(get: { store.externalRejectRequest != nil }, set: { if !$0 { store.cancelExternalReject() } }),
                   presenting: store.externalRejectRequest) { request in
                Button(Self.confirmTitle(request), role: .destructive) { store.confirmExternalReject() }
                    .accessibilityIdentifier("External reject confirm")
                Button("Cancel", role: .cancel) { store.cancelExternalReject() }
                    .accessibilityIdentifier("External reject cancel")
            } message: { request in
                Text(verbatim: request.message)
            }
            .confirmationDialog(Text("Finish the review?"), isPresented: $model.showFinishReview, titleVisibility: .visible) {
                Button("Finish review") { Task { await store.finishReview() } }
                    .accessibilityIdentifier("Finish review confirm")
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(verbatim: FinishReviewRules.confirmation(notes: store.unsentNotes.count))
            }
            .sheet(isPresented: Binding(get: { store.staleReview != nil }, set: { if !$0 { store.keepReview() } })) {
                if let stale = store.staleReview {
                    StaleReviewSheet(stale: stale)
                }
            }
    }

    /// "…도" when "Reject all" adds the external files to Claude's changes; one external file is asked about on its own.
    private static func confirmQuestion(_ request: ExternalRejectRequest?) -> Text {
        if case .rejectAll? = request?.command { return Text("Revert changes from outside the app too?") }
        return Text("Revert this change from outside the app?")
    }

    /// "Reject all" with the external files reverts Claude's pending changes too; one file is just that file.
    private static func confirmTitle(_ request: ExternalRejectRequest) -> String {
        if case .rejectAll = request.command { return String(localized: "Reject all") }
        return String(localized: "Revert")
    }
}

/// §31.5: a restored review saved before HEAD moved or more than 12 hours ago. "정리" empties the list (no file is
/// touched), "이어서 리뷰" keeps it; closing the sheet keeps it too.
struct StaleReviewSheet: View {
    @Environment(AppState.self) private var store
    let stale: StaleReview
    @State private var confirming = false
    @State private var finishing = false
    @State private var refusal: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("This review is stale", systemImage: "clock.badge.exclamationmark")
                .font(.headline)
                .foregroundStyle(.primary)
                .accessibilityIdentifier("Stale review title")
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(stale.lines().enumerated()), id: \.offset) { _, line in
                    Text(verbatim: line).font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .help(stale.savedDate.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "")
            .accessibilityIdentifier("Stale review lines")
            Text("Clean up empties the review list and leaves every file on disk as it is; Keep reviewing goes on with it as it is.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let refusal {
                Label(refusal, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Stale review refusal")
            }
            HStack {
                if finishing { ProgressView().controlSize(.small) }
                Spacer()
                Button("Clean up…") { confirming = true }
                    .disabled(finishing)
                    .help(Text(verbatim: FinishReviewRules.confirmation(notes: store.unsentNotes.count)))
                    .accessibilityIdentifier("Stale review clean up")
                Button("Keep reviewing") { store.keepReview() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(finishing)
                    .accessibilityIdentifier("Stale review keep")
            }
        }
        .padding(20)
        .frame(width: 460)
        .confirmationDialog(Text("Finish the review?"), isPresented: $confirming, titleVisibility: .visible) {
            Button("Clean up") { finish() }
                .accessibilityIdentifier("Stale review clean up confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(verbatim: FinishReviewRules.confirmation(notes: store.unsentNotes.count))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Stale review sheet")
    }

    private func finish() {
        finishing = true
        refusal = nil
        Task {
            // Success clears `gate.stale`, which closes the sheet; a refusal stays here in the user's words.
            refusal = await store.finishReview(reportFailure: false)
            finishing = false
        }
    }
}
