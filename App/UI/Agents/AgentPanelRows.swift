import SwiftUI
import ReviewGateCore

// MARK: wave4d w4d-agents2
// The agent panel at its default width (docs/PROTOCOL.md §42.4, audit agents-10; rules in Core `AgentPanelLayout`): every
// agent has its own color (by type, the same in every turn and chat) on the card's left edge, the type reads without
// the plugin prefix (a small "OMC" badge instead), a failure is a red card, and three or more agents side by side are compact
// rows — one line each — that open into the full card.

extension AgentIdentity {
    /// MARK: wave5 w5-board (§43.1): the type's avatar tone — the agent board's faces, the panel's band and the timeline dot
    /// are one color per type, the same as Electron's (a type the avatar table does not know keeps its identity color family).
    static func color(_ type: String) -> Color { AgentAvatar.of(type: type).tone.dynamic }
}

extension AgentCardEmphasis {
    /// The card's wash: red behind a failure, nothing else.
    func fill(_ scheme: ColorScheme) -> Color {
        self == .failed ? Color.red.wash(scheme, light: 0.07, dark: 0.13) : Color.cardFill(scheme)
    }
}

/// "executor [OMC]": the type without its plugin, the plugin as a small gray badge (the raw type in the help).
struct AgentTypeTitle: View {
    let type: String
    var font: Font = .caption.weight(.semibold)

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: AgentGlance.typeLabel(type))
                .font(font)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            if let plugin = AgentIdentity.pluginBadge(type) {
                Text(verbatim: plugin)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4).padding(.vertical, 0.5)
                    .background(Color.secondary.opacity(0.14), in: Capsule())
                    .fixedSize()
            }
        }
        .help(Text(verbatim: type))
    }
}

/// The 4 pt band of the agent's color on a card's / row's left edge.
struct AgentIdentityBand: View {
    let type: String

    var body: some View {
        Rectangle().fill(AgentIdentity.color(type)).frame(width: 4).accessibilityHidden(true)
    }
}

/// One line per agent while three or more run side by side: status, type, description, what it does now, time; a click opens
/// the full card under it, the menu is the card's.
struct AgentCompactRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let agent: AgentNode
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            row
            if open { AgentCard(agent: agent) }
        }
    }

    private var row: some View {
        let emphasis = AgentCardEmphasis.of(agent, awaitingPermission: store.pendingPermission(forAgent: agent.toolUseId) != nil)
        let tint: Color = emphasis == .waiting ? .orange : agent.status.tint
        return HStack(spacing: 0) {
            AgentIdentityBand(type: agent.type)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    AgentStatusChip(status: agent.status, compact: true, stoppedByUser: agent.stoppedBy == .user)
                    AgentTypeTitle(type: agent.type).layoutPriority(1)
                    if !agent.description.isEmpty {
                        Text(verbatim: agent.description)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 2)
                    elapsed
                    if agent.status.isLive { AgentStopButton(node: agent) }
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                TimelineView(.periodic(from: .now, by: agent.status.isLive ? 1 : 3600)) { ctx in
                    if let detail = AgentPanelLayout.rowDetail(agent, nowMs: AgentFormat.nowMs(ctx.date)) {
                        Text(verbatim: detail)
                            .font(agent.status.isLive ? .caption2.monospaced() : .caption2)
                            .foregroundStyle(agent.status == .failed ? Color.red : agent.status.isLive ? Color.blue : Color.secondary)
                            .lineLimit(1)
                            .truncationMode(agent.status.isLive ? .middle : .tail)
                    }
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
        }
        .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
        .background(emphasis.fill(colorScheme))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(tint.opacity(emphasis.border.opacity), lineWidth: emphasis.border.width))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture { withAnimation(.easeInOut(duration: 0.15)) { open.toggle() } }
        .contextMenu { AgentCardMenuItems(agent: agent) }
        .help(Text(verbatim: agent.description.isEmpty ? agent.type : "\(agent.type) — \(agent.description)"))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(open ? Text("Hide the agent's card") : Text("Show the agent's card"))
        .accessibilityActions {
            Button("Show in chat") { model.reveal(toolUseId: agent.toolUseId) }
            Button("Agent details") { model.showAgentDetails(toolUseId: agent.toolUseId) }
        }
        .accessibilityIdentifier("Agent row")
    }

    @ViewBuilder
    private var elapsed: some View {
        if agent.status.isLive, agent.startedAt > 0 {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Text(verbatim: AgentFormat.duration(ms: agent.elapsedMs(now: AgentFormat.nowMs(ctx.date))))
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .fixedSize()
        } else if agent.elapsedMs(now: 0) > 0 {
            Text(verbatim: AgentFormat.duration(ms: agent.elapsedMs(now: 0)))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .fixedSize()
        }
    }
}

/// The main agent's line while nothing runs: the last turn's time and cost and how full the context is (it used to repeat
/// the "쉬는 중" of its chip).
struct MainAgentIdleLine: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let hud = store.hud
        HStack(spacing: 8) {
            if hud.turnCount > 0 {
                Text("Last turn \(HUDStrip.seconds(Double(hud.lastTurnMs) / 1000))")
                let shares = ModelCostText.shares(store.state.hud.turnModels)
                if !shares.isEmpty {
                    Text(verbatim: ModelCostText.usd(shares.reduce(0) { $0 + $1.costUsd }))
                        .help(Text(verbatim: ModelCostText.line(shares)))
                }
            } else {
                Text("No turn yet")
            }
            if let fraction = store.contextFraction {
                Text("Context \(String(format: "%d%%", Int((fraction * 100).rounded())))")
            }
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Main agent idle line")
    }
}
