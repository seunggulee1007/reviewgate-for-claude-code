import SwiftUI
import ReviewGateCore

/// Compact gantt of the session's subagents: one bar per agent (tree order, indented by nesting) on a shared time
/// axis from the first start to now / the last end; live bars grow every second.
struct AgentTimelineView: View {
    /// wave1 mac-perms: which agents wait for a permission answer (orange bar + [카드로 이동]).
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model   // wave4b w4b-agents
    let roots: [AgentTreeNode]
    /// Epoch ms the axis starts at when earlier than every agent (the turn start).
    var turnStartedAt: Double?

    private static let rowHeight: CGFloat = 16
    private static let labelWidth: CGFloat = 104

    var body: some View {
        let rows = AgentTreeNode.flatten(roots)
        let live = rows.contains { $0.agent.status.isLive }
        TimelineView(.periodic(from: .now, by: live ? 1 : 3600)) { ctx in
            let now = AgentFormat.nowMs(ctx.date)
            let starts = rows.map(\.agent.startedAt).filter { $0 > 0 }
            let t0 = min(starts.min() ?? now, turnStartedAt ?? .infinity)
            let t1 = max(rows.map { $0.agent.startedAt + $0.agent.elapsedMs(now: now) }.max() ?? now, t0 + 1000)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Timeline").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Text(verbatim: AgentFormat.duration(ms: t1 - t0)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(rows, id: \.agent.toolUseId) { row in
                            bar(row.agent, level: row.level, t0: t0, t1: t1, now: now)
                        }
                    }
                }
                .frame(maxHeight: min(CGFloat(rows.count) * (Self.rowHeight + 3), 132))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent timeline")
    }

    private func bar(_ agent: AgentNode, level: Int, t0: Double, t1: Double, now: Double) -> some View {
        let waiting = store.pendingPermission(forAgent: agent.toolUseId)
        let tint = waiting != nil ? Color.orange : agent.status.tint
        return HStack(spacing: 6) {
            // wave4d w4d-agents2 — agents-10: the type behind its color (the description was cut at 104 pt; it is in the help).
            HStack(spacing: 4) {
                Circle().fill(AgentIdentity.color(agent.type)).frame(width: 6, height: 6)
                Text(verbatim: AgentGlance.typeLabel(agent.type))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.leading, CGFloat(min(level, 4)) * 8)
            .frame(width: Self.labelWidth, alignment: .leading)
            if let waiting {
                AgentPermissionWaiting(request: waiting, compact: true).fixedSize()
            }
            GeometryReader { geo in
                let span = t1 - t0
                let start = agent.startedAt > 0 ? agent.startedAt : t0
                let x = CGFloat((start - t0) / span) * geo.size.width
                let w = max(CGFloat(agent.elapsedMs(now: now) / span) * geo.size.width, 4)
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.08))
                    Capsule()
                        .fill(tint.gradient.opacity(agent.status.isLive ? 0.95 : 0.7))
                        .frame(width: min(w, geo.size.width - x))
                        .offset(x: x)
                }
            }
            .frame(height: 8)
        }
        .frame(height: Self.rowHeight)
        .help(Text(verbatim: "\(AgentGlance.typeLabel(agent.type)) — \(agent.description) · \(AgentFormat.duration(ms: agent.elapsedMs(now: now)))"))
        // MARK: wave4b w4b-agents — agents-11: a bar opens and shows the agent's group in the chat.
        .contentShape(Rectangle())
        .onTapGesture { model.reveal(toolUseId: agent.toolUseId) }
    }
}
