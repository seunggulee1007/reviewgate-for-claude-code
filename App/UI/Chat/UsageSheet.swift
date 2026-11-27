import SwiftUI
import ReviewGateCore

// MARK: §71.1 — docs/PROTOCOL.md §71.1: `/usage` (`/cost`, `/stats`) in a classic chat — the terminal's Session block
// and the plan's usage windows with their reset times, in a sheet. Everything comes from the state (live while it is open).

struct UsageSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: UsageText.title).font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    session
                    Divider()
                    plan
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 430)
            Text(verbatim: UsageText.terminalNote)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("usage.done")
            }
        }
        .padding(16)
        .frame(width: 520)
        .accessibilityIdentifier("Usage sheet")
    }

    // MARK: Session

    private var session: some View {
        let hud = store.state.hud
        let totals = store.sessionTotals
        return VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: UsageText.sessionHeading).font(.subheadline.weight(.semibold))
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                row(UsageText.estimatedCost, UsageText.cost(hud.sessionCostUSD))
                if let totals {
                    row(UsageText.apiDuration, UsageText.duration(ms: totals.apiDurationMs))
                    GridRow {
                        Text(verbatim: UsageText.wallDuration).foregroundStyle(.secondary)
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(verbatim: totals.startedDate.map { UsageText.duration(ms: Int(context.date.timeIntervalSince($0) * 1000)) }
                                 ?? UsageText.notRunning)
                                .monospacedDigit()
                        }
                    }
                    row(UsageText.codeChangesLabel, UsageText.codeChanges(added: totals.linesAdded, removed: totals.linesRemoved))
                }
            }
            .font(.callout)
            .textSelection(.enabled)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: UsageText.byModel).font(.callout).foregroundStyle(.secondary)
                if hud.sessionModels.isEmpty {
                    Text(verbatim: UsageText.noModels).font(.callout).foregroundStyle(.secondary)
                } else {
                    ForEach(hud.sessionModels, id: \.model) { m in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(verbatim: m.model).font(.callout.weight(.medium)).lineLimit(1)
                            Text(verbatim: UsageText.modelTokens(m)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 4)
                            Text(verbatim: UsageText.cost(m.costUsd)).font(.caption.monospacedDigit())
                        }
                        .padding(.leading, 12)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("usage.model")
                    }
                }
            }
            .textSelection(.enabled)
            if hud.sideCostUSD > 0 {
                Text(verbatim: UsageText.sideCost(hud.sideCostUSD)).font(.caption).foregroundStyle(.teal)
            }
            Text(verbatim: UsageText.estimateNote).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("usage.session")
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(verbatim: label).foregroundStyle(.secondary)
            Text(verbatim: value).monospacedDigit()
        }
    }

    // MARK: Plan usage

    private var plan: some View {
        let windows = UsageText.ordered(store.state.hud.rateLimits)
        return VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: UsageText.planHeading).font(.subheadline.weight(.semibold))
            if windows.isEmpty {
                Text(verbatim: UsageText.noWindows).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(windows, id: \.kind) { w in
                PlanWindowRow(window: w)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("usage.plan")
    }
}

/// One plan window: its name, the bar, "72% used" and when it resets (orange from 80 % and when it is reached).
private struct PlanWindowRow: View {
    let window: RateLimitWindow

    var body: some View {
        let percent = window.percent ?? (window.isRejected ? 100 : nil)
        let high = window.isRejected || UsageMeter.isHigh(percent)
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: UsageText.windowTitle(window.kind)).font(.callout)
                Spacer()
                if window.isRejected {
                    Text(verbatim: UsageText.limitReached).font(.caption.weight(.semibold)).foregroundStyle(.orange)
                } else if let percent {
                    Text(verbatim: UsageText.used(percent)).font(.caption.monospacedDigit()).foregroundStyle(high ? Color.orange : Color.secondary)
                }
            }
            if let percent {
                ProgressView(value: Double(min(100, max(0, percent))), total: 100)
                    .progressViewStyle(.linear)
                    .tint(high ? .orange : .accentColor)
            }
            if let reset = window.resetDate {
                Text(verbatim: UsageText.resets(reset)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("usage.window.\(window.kind)")
    }
}
