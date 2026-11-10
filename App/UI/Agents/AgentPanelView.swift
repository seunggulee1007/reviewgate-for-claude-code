import SwiftUI
import ReviewGateCore

/// Agent activity inspector: the main agent as the root, subagents as a tree under it (siblings that ran at the same
/// time side by side), and a compact timeline at the bottom. Toggled with View → Toggle Agent Panel (⌥⌘A).
struct AgentPanelView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        let agents = store.agents
        let roots = AgentTreeNode.build(agents)
        VStack(spacing: 0) {
            header(agents)
            Divider()
            ViewingAgentsNote()   // wave4b integration (§39.2): the running chat's agents while another chat is shown
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    MainAgentCard()
                    if roots.isEmpty {
                        VStack(spacing: 6) {
                            Image(systemName: "person.2").font(.title2).foregroundStyle(.tertiary)
                            Text("No subagents in this turn").font(.callout).foregroundStyle(.secondary)
                            Text("Agents Claude delegates to appear here while they work.")
                                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                    } else {
                        Branch { AgentLevel(nodes: roots) }
                    }
                    AgentEarlierTurns()   // wave4b w4b-agents — agents-08: this chat's earlier turns
                }
                .padding(12)
            }
            if !roots.isEmpty {
                Divider()
                AgentTimelineView(roots: roots, turnStartedAt: store.hud.turnStartedAt.map { $0.timeIntervalSince1970 * 1000 })
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .accessibilityIdentifier("Agent panel")
    }

    private func header(_ agents: [AgentNode]) -> some View {
        let live = agents.filter { $0.status.isLive }.count
        let failed = agents.filter { $0.status == .failed }.count
        let done = agents.filter { $0.status == .completed }.count
        return HStack(spacing: 8) {
            Label("Agents", systemImage: "person.2.wave.2").font(.headline).fixedSize()
            AgentBoardButton()   // MARK: wave5 w5-board (§43.1)
            Spacer(minLength: 4)
            // A narrow panel keeps the most urgent counts: running and failed.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 4) {
                    if live > 0 { TagChip(Text("\(live) running"), tint: .blue) }
                    if done > 0 { TagChip(Text("\(done) done"), tint: .green) }
                    if failed > 0 { TagChip(Text("\(failed) failed"), tint: .red) }
                }
                HStack(spacing: 4) {
                    if live > 0 { TagChip(Text("\(live) running"), tint: .blue) }
                    if failed > 0 { TagChip(Text("\(failed) failed"), tint: .red) }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
    }
}

/// The implicit main agent: the session itself (model, current activity, turn time).
private struct MainAgentCard: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        let running = store.isRunning
        let hud = store.hud
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if running {
                    AgentStatusChip(status: .running)
                } else {
                    TagChip("Idle", systemImage: "pause.fill", tint: .gray)
                }
                Text("Main agent").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if running, let started = hud.turnStartedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(verbatim: AgentFormat.duration(ms: max(0, ctx.date.timeIntervalSince(started)) * 1000))
                    }
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                }
            }
            // MARK: wave4d w4d-agents2 — agents-10: the model as the HUD names it (was the raw id), and while nothing runs the
            // last turn's time and cost and the context instead of a second "쉬는 중".
            Text(verbatim: store.modelChipText)
                .font(.callout.weight(.medium))
                .lineLimit(1)
            if running {
                Text(verbatim: hud.activity)
                    .font(.caption)
                    .foregroundStyle(Color.blue)
                    .lineLimit(2)
            } else {
                MainAgentIdleLine()
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.wash(colorScheme, light: 0.07, dark: 0.12), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.opacity(running ? 0.45 : 0.15)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Main agent card")
    }
}

/// Children hang off a thin connector line on the left.
private struct Branch<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Rectangle()
                .fill(Color.secondary.opacity(0.25))
                .frame(width: 2)
                .padding(.leading, 10)
            VStack(alignment: .leading, spacing: 8) { content() }
        }
    }
}

/// One level of siblings: agents that ran at the same time side by side, sequential ones stacked.
private struct AgentLevel: View {
    let nodes: [AgentTreeNode]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(AgentTreeNode.parallelBatches(nodes, now: AgentFormat.nowMs()).enumerated()), id: \.offset) { _, batch in
                if batch.count == 1 {
                    subtree(batch[0])
                } else if AgentPanelLayout.compact(batch: batch.count) {
                    // MARK: wave4d w4d-agents2 — agents-10: three or more side by side are one line each (a click opens the card).
                    VStack(alignment: .leading, spacing: 4) {
                        Label("\(batch.count) in parallel", systemImage: "arrow.triangle.branch")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(batch) { node in
                            VStack(alignment: .leading, spacing: 6) {
                                AgentCompactRow(agent: node.agent)
                                if !node.children.isEmpty { Branch { AgentLevel(nodes: node.children) } }
                            }
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("\(batch.count) in parallel", systemImage: "arrow.triangle.branch")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 8, alignment: .top)], alignment: .leading, spacing: 8) {
                            ForEach(batch) { subtree($0) }
                        }
                    }
                }
            }
        }
    }

    private func subtree(_ node: AgentTreeNode) -> AnyView {
        AnyView(
            VStack(alignment: .leading, spacing: 8) {
                AgentCard(agent: node.agent)
                if !node.children.isEmpty {
                    Branch { AgentLevel(nodes: node.children) }
                }
            }
        )
    }
}
