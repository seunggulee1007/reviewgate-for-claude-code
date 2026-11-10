import SwiftUI
import ReviewGateCore

// wave2 mac-diff — the rows of a folded diff (audit comp-18) and "Show 20 more lines" around a hunk (comp-19), between the
// line rows of `DiffView`'s list (`DiffDisplayPlan`).

/// The pane's last plan: a hover re-evaluates the body, and rebuilding thousands of rows each time would show.
@MainActor
final class DiffPlanCache {
    private struct Key: Equatable {
        let diff: FileDiff
        let generated: GeneratedKind?
        let fold: DiffFoldState
        let fullFile: [String]?
        let truncated: Bool
        let contextEnabled: Bool
    }

    private var key: Key?
    private var value: DiffDisplayPlan?

    func plan(diff: FileDiff, generated: GeneratedKind?, fold: DiffFoldState, fullFile: [String]?, truncated: Bool,
              contextEnabled: Bool) -> DiffDisplayPlan {
        let key = Key(diff: diff, generated: generated, fold: fold, fullFile: fullFile, truncated: truncated, contextEnabled: contextEnabled)
        if let value, self.key == key { return value }
        let plan = DiffDisplayPlan.make(diff: diff, generated: generated, fold: fold, fullFile: fullFile, truncated: truncated,
                                        contextEnabled: contextEnabled)
        self.key = key
        value = plan
        return plan
    }

    // MARK: wave4d w4d-speed — polish-09: the diff's line count and header → hunk map, built once per diff.
    private var indexed: (diff: FileDiff, index: FileDiffIndex)?
    /// MARK: wave7 w7-state — §45.2: bumped for each other diff indexed (a new B, another range). The list's rows compare
    /// it: their actions captured the diff they were drawn with, so another diff draws them again once.
    private var generation = 0

    func index(for diff: FileDiff) -> FileDiffIndex {
        if let indexed, indexed.diff == diff { return indexed.index }
        let index = FileDiffIndex(diff)
        indexed = (diff, index)
        generation += 1
        return index
    }

    /// The generation of `diff` (indexed first when it is another one).
    func generation(of diff: FileDiff) -> Int {
        _ = index(for: diff)
        return generation
    }
}

/// "+N줄 · 펼치기" under a folded hunk, "큰 diff · N줄 · 펼치기" above a large diff's hunks, "생성 파일 · +N줄 · 펼치기"
/// for a generated file / lockfile — and once open, the way back ("접기").
struct DiffFoldRow: View {
    @Environment(\.colorScheme) private var colorScheme

    enum Kind {
        case hunk(lines: Int)
        case large(lines: Int)
        case generated(lines: Int)
    }

    let kind: Kind
    let open: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: open ? "rectangle.compress.vertical" : "rectangle.expand.vertical")
                    .font(.caption)
                    .foregroundStyle(Color.accentColor)
                Text(verbatim: label)
                    .font(.callout)
                    .foregroundStyle(open ? Color.secondary : Color.accentColor)
                Spacer(minLength: 0)
            }
            .padding(.leading, leading).padding(.trailing, 8).padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityIdentifier(identifier)
    }

    private var label: String {
        if open { return String(localized: "Collapse") }
        switch kind {
        case let .hunk(lines): return String(localized: "+\(lines) lines · Expand")
        case let .large(lines): return String(localized: "Large diff · \(lines) lines · Expand")
        case let .generated(lines): return String(localized: "Generated file · +\(lines) lines · Expand")
        }
    }

    private var help: String {
        switch kind {
        case .hunk: String(localized: "Large diffs open one part at a time; syntax colours are left out")
        case .large: String(localized: "Over \(DiffDisplay.foldLineThreshold) lines: every part starts folded and syntax colours are left out")
        case .generated: String(localized: "Lockfiles and generated files start folded")
        }
    }

    private var leading: CGFloat {
        if case .hunk = kind { return DiffRow.gutterWidth * 2 + 20 }
        return 12
    }

    private var background: Color {
        switch kind {
        case .hunk: Color.blue.wash(colorScheme, light: 0.04, dark: 0.08)
        case .large, .generated: Color.orange.wash(colorScheme, light: 0.08, dark: 0.14)
        }
    }

    private var identifier: String {
        switch kind {
        case .hunk: "Folded hunk"
        case .large: "Large diff fold"
        case .generated: "Generated file fold"
        }
    }
}

/// "Show 20 more lines" in a gap of unchanged lines: up (just above the next hunk), down (just below the previous one), or
/// one button when what is hidden fits in one step. Disabled with its reason when the full file cannot give the lines.
/// Once the gap shows lines, "Collapse N lines" hides them again — alone on the row when the whole gap is shown — and the
/// row's menu collapses every gap of the diff.
struct DiffContextExpanderRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let gap: Int
    let up: Bool
    let down: Bool
    /// The gap's lines on screen (`DiffDisplayItem.Kind.expander`'s `revealed`).
    let revealed: Int
    let loading: Bool
    /// Why no more lines can be shown (too large, changed on disk, …); nil = available.
    let blocked: String?
    /// Some gap of this diff shows lines (`DiffFoldState.hasRevealed`): the menu offers collapsing them all.
    let canCollapseAll: Bool
    let onReveal: (ContextDirection) -> Void
    let onCollapse: () -> Void
    let onCollapseAll: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if up { button(.up, systemImage: gap == 0 || down ? "arrow.up.to.line" : "arrow.up.and.down") }
            if down { button(.down, systemImage: "arrow.down.to.line") }
            if revealed > 0 { collapseButton }
            if loading { ProgressView().controlSize(.small) }
            if let blocked {
                Text(verbatim: blocked)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(blocked)
                    .accessibilityIdentifier("More lines unavailable")
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, DiffRow.gutterWidth * 2 + 20).padding(.trailing, 8).padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.wash(colorScheme, light: 0.06, dark: 0.10))
        .contentShape(Rectangle())
        .contextMenu {
            if canCollapseAll {
                Button("Collapse All Shown Lines", systemImage: "rectangle.compress.vertical", action: onCollapseAll)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Show more lines")
    }

    /// Hides what "Show 20 more lines" revealed in this gap (both ends); always available — nothing to load.
    private var collapseButton: some View {
        Button(action: onCollapse) {
            Label("Collapse \(revealed) lines", systemImage: "rectangle.compress.vertical")
                .font(.caption)
        }
        .buttonStyle(.link)
        .help("Hide the lines shown here again")
        .accessibilityIdentifier("Collapse shown lines")
    }

    private func button(_ direction: ContextDirection, systemImage: String) -> some View {
        Button { onReveal(direction) } label: {
            Label("Show 20 more lines", systemImage: systemImage)
                .font(.caption)
        }
        .buttonStyle(.link)
        .disabled(blocked != nil || loading)
        .help(blocked ?? String(localized: "Show 20 more lines"))
        .accessibilityLabel(direction == .up ? "Show 20 more lines above" : "Show 20 more lines below")
        .accessibilityIdentifier(direction == .up ? "Show more lines above" : "Show more lines below")
    }
}
