import SwiftUI
import ReviewGateCore

// MARK: wave4c w4c-trust
// docs/PROTOCOL.md §41.2 (Mac; Electron `components/trust/TrustViews.tsx`): the "규칙으로 수락" chip of a file, the turn
// summary's "규칙으로 수락 N개 [모두 대기로 되돌리기]", the "거절했어요 — [거절 취소]" banner and Settings › Project ›
// 자동 수락 규칙. Words and decisions: Core `TrustRules`.

/// The file row's chip (and the history's): accepted by a rule, not by the user.
struct AutoAcceptedChip: View {
    let rule: String?
    let path: String

    var body: some View {
        if let rule {
            TagChip(Text(verbatim: TrustRules.badgeLabel(rule)), systemImage: "checkmark.seal", tint: .green)
                .help(TrustRules.badgeHelp(rule))
                .accessibilityLabel(Text(verbatim: TrustRules.badgeHelp(rule)))
                .accessibilityIdentifier("Auto accepted \(path)")
        }
    }
}

/// The turn summary's line: how many files this collection's rules accepted, and [모두 대기로 되돌리기].
struct AutoAcceptedSummaryLine: View {
    @Environment(AppState.self) private var store
    let files: [AutoAcceptedFile]

    /// The rules' names, each once, in the order they first appear.
    private var ruleNames: [String] {
        var seen = Set<String>()
        return files.compactMap { TrustRules.name($0.rule) }.filter { seen.insert($0).inserted }
    }

    var body: some View {
        if !files.isEmpty {
            let view = TrustRules.autoUndo(files: store.changedFiles, phase: store.gatePhase, paths: files.map(\.path))   // wave7 w7-state (§45.2)
            let names = ruleNames
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal").foregroundStyle(.green).accessibilityHidden(true)
                Text(verbatim: TrustRules.summaryLine(count: files.count) + (names.isEmpty ? "" : " (\(names.joined(separator: " · ")))"))
                    .font(.caption)
                    .help(files.map(\.path).joined(separator: "\n"))
                Spacer(minLength: 4)
                Button(TrustRules.undoAllButton) { store.undoAutoAccept(paths: view.paths) }
                    .controlSize(.small)
                    .disabled(view.blocked != nil)
                    .help(view.blocked ?? TrustRules.undoAllHelp)
                    .accessibilityIdentifier("Summary auto accepted undo")
                if let blocked = view.blocked {
                    Text(verbatim: blocked).font(.caption2).foregroundStyle(.secondary)
                        .accessibilityIdentifier("Summary auto accepted reason")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Summary auto accepted")
        }
    }
}

/// "거절했어요 — [거절 취소]" while the engine offers it (gone at the next turn or another reject).
struct RejectUndoBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        if let offer = store.rejectUndoOffer {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.uturn.backward.circle").foregroundStyle(.yellow).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: TrustRules.rejectedText(offer.path)).font(.callout).lineLimit(1).truncationMode(.middle)
                        if let blocked = offer.blocked {
                            Text(verbatim: blocked).font(.caption).foregroundStyle(.secondary)
                                .accessibilityIdentifier("Reject undo reason")
                        }
                    }
                    Spacer(minLength: 8)
                    Button(TrustRules.undoRejectButton) { store.undoLastReject() }
                        .disabled(offer.blocked != nil)
                        .help(offer.blocked ?? TrustRules.undoRejectHelp)
                        .accessibilityIdentifier("Reject undo")
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.yellow.wash(colorScheme, light: 0.10, dark: 0.18))
                Divider()
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Reject undo banner")
        }
    }
}

/// Settings › Project › 자동 수락 규칙: one switch per rule, kept for the repository by the engine.
struct AutoAcceptSettingsSection: View {
    @Environment(AppState.self) private var store

    var body: some View {
        Section {
            Text(verbatim: TrustRules.sectionCaption)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(TrustRules.rules, id: \.self) { rule in
                VStack(alignment: .leading, spacing: 2) {
                    Toggle(isOn: Binding(get: { store.autoAcceptRules.isOn(rule) }, set: { store.setAutoAcceptRule(rule, on: $0) })) {
                        Text(verbatim: TrustRules.name(rule.rawValue) ?? rule.rawValue)
                    }
                    .disabled(store.projectInfo == nil)
                    .accessibilityIdentifier("Auto accept \(rule.rawValue)")
                    Text(verbatim: TrustRules.help(rule))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(verbatim: TrustRules.neverText)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text(verbatim: TrustRules.sectionTitle)
        }
    }
}
