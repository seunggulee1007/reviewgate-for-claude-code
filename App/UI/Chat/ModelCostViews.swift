import SwiftUI
import ReviewGateCore

// MARK: wave4d w4d-agents2
// docs/PROTOCOL.md §42.4 — what each model cost (rules in Core `ModelCostText`, the same as Electron's agentCost.ts): the
// HUD's session cost opens a popover with the last turn's and the session's split by model, and the turn summary card
// ends with "이번 턴 비용(추정)" and its bar.

/// A thin stacked bar (one segment per model family, tinted like the model chips) and its line
/// "opus $0.38 · sonnet $0.06 · haiku $0.01".
struct ModelCostBar: View {
    @Environment(\.colorScheme) private var colorScheme
    let shares: [ModelCostShare]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                HStack(spacing: 1) {
                    ForEach(shares) { share in
                        Rectangle()
                            .fill(share.family.tint.opacity(colorScheme == .dark ? 0.85 : 0.75))
                            .frame(width: max(2, geo.size.width * share.fraction - 1))
                    }
                }
                .clipShape(Capsule())
            }
            .frame(height: 6)
            .background(Color.secondary.opacity(0.12), in: Capsule())
            .accessibilityHidden(true)
            HStack(spacing: 8) {
                ForEach(shares) { share in
                    HStack(spacing: 3) {
                        Circle().fill(share.family.tint).frame(width: 6, height: 6)
                        Text(verbatim: "\(share.label) \(ModelCostText.usd(share.costUsd))")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .fixedSize()
                    }
                    .help(Text(verbatim: "\(share.models.joined(separator: ", ")) · \(String(format: "$%.4f", share.costUsd)) · \(HUDStrip.tokens(share.tokens))"))
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: ModelCostText.line(shares)))
    }
}

/// The turn summary's last line: "이번 턴 비용(추정)" and the bar; nothing from an engine / CLI without per-model usage.
struct TurnModelCostSection: View {
    let models: [ModelCost]

    var body: some View {
        let shares = ModelCostText.shares(models)
        if !shares.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("Cost this turn (estimate)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ModelCostBar(shares: shares)
            }
            .help("Claude Code's estimate from the tokens each model used — not a bill")
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Turn summary model cost")
        }
    }
}

/// The HUD's "$1.23 세션": a click shows the session cost, the last turn and the session split by model, and the side
/// questions' cost (apart from the session's).
struct HUDCostButton: View {
    @Environment(AppState.self) private var store
    @State private var open = false

    var body: some View {
        let hud = store.hud
        Button { open.toggle() } label: {
            Text("\(HUDStrip.usd(hud.sessionCostUSD)) session")
        }
        .buttonStyle(.plain)
        .help("Session cost so far: \(String(format: "$%.4f", hud.sessionCostUSD))")
        .accessibilityIdentifier("HUD cost")
        .popover(isPresented: $open, arrowEdge: .top) {
            HUDCostPopover()
        }
    }
}

private struct HUDCostPopover: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let hud = store.hud
        let turn = ModelCostText.shares(store.state.hud.turnModels)
        let session = ModelCostText.shares(store.state.hud.sessionModels)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Cost").font(.headline)
                Spacer()
                Text(verbatim: String(format: "$%.4f", hud.sessionCostUSD)).font(.callout.monospacedDigit().weight(.semibold))
            }
            Text("Session cost so far: \(String(format: "$%.4f", hud.sessionCostUSD))").font(.caption).foregroundStyle(.secondary)
            if turn.isEmpty && session.isEmpty {
                Text("The cost per model shows here once a turn ends.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                if !turn.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Last turn by model (estimate)").font(.subheadline.weight(.semibold))
                        ModelCostBar(shares: turn)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("HUD cost last turn")
                }
                if !session.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("This session by model (estimate)").font(.subheadline.weight(.semibold))
                        ModelCostBar(shares: session)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("HUD cost session")
                }
                Text("Claude Code's estimate from the tokens each model used — not a bill")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            AutoModelCountsLine(counts: store.state.hud.autoModelCounts)   // wave5 w5-model (§43.4)
            if hud.sideCostUSD > 0 {
                Divider()
                Text("Side questions in this session: \(String(format: "$%.4f", hud.sideCostUSD)) — not part of the session cost")
                    .font(.caption).foregroundStyle(.teal)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(width: 300, alignment: .leading)
        .accessibilityIdentifier("HUD cost popover")
    }
}
