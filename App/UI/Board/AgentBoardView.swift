import SwiftUI
import ReviewGateCore

// MARK: wave5 w5-board
// docs/PROTOCOL.md §43.1 — the agent board's first tab: who works on what, as round faces. The main agent (Claude's star)
// on top, its subagents under it (agents that ran at the same time side by side, nested ones under their parent), each with
// what it does now (the tool's icon and words — "MySQL 쿼리 실행 · SELECT 1"), its tool calls, time, tokens and model; a summary
// line ("지금 3명 일하는 중 · 1명 권한 대기 · 오늘 12명 다녀감") and the earlier turns' faces at the bottom. A click shows the
// agent's group in the chat (§39.3), the menu is the card's (§42.4).

struct AgentBoardView: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let agents = store.agents
        let roots = AgentTreeNode.build(agents)
        ScrollView {
            VStack(spacing: 18) {
                BoardSummaryLine()
                ViewingAgentsNote()   // §39.2: the running chat's agents while another chat is shown
                BoardMainTile()
                if roots.isEmpty {
                    BoardEmptyAgents()
                } else {
                    BoardConnector()
                    BoardLevel(nodes: roots, depth: 0)
                }
                BoardEarlierTurns()
            }
            .padding(.horizontal, 18).padding(.vertical, 16)
            .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("Agent board")
    }
}

/// "지금 3명 일하는 중 · 1명 권한 대기 · 오늘 12명 다녀감".
private struct BoardSummaryLine: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(AppState.self) private var store

    var body: some View {
        let summary = AgentBoardSummary.of(
            agents: store.agents, history: store.state.hud.agentHistory,
            awaiting: { store.pendingPermission(forAgent: $0.toolUseId) != nil },
            mainWaiting: store.openPermissions.contains { $0.agent == nil })
        HStack(spacing: 8) {
            Image(systemName: summary.waiting > 0 ? "hand.raised.fill" : summary.working > 0 ? "sparkles" : "moon.stars.fill")
                .foregroundStyle(summary.waiting > 0 ? Color.orange : AgentAvatarTone.claude.color(colorScheme))
                .symbolEffect(.pulse, options: .repeating, isActive: summary.working > 0 && !reduceMotion)
            Text(verbatim: summary.text)
                .font(.callout.weight(.medium))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(Capsule().fill(AgentAvatarTone.claude.color(colorScheme).opacity(colorScheme == .dark ? 0.16 : 0.10)))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Agent board summary")
    }
}

/// The main agent: Claude's star, the model, what it does now, the turn's time.
private struct BoardMainTile: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        let running = store.isRunning
        let waiting = store.openPermissions.first { $0.agent == nil }
        let mood = AgentMood.main(running: running, awaitingPermission: waiting != nil)
        let tone = AgentAvatarTone.claude.color(colorScheme)
        VStack(spacing: 6) {
            AgentAvatarView(avatar: .main, mood: mood, size: 60)
            HStack(spacing: 6) {
                Text("Main agent").font(.headline)
                Text(verbatim: store.modelChipText)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let waiting {
                AgentPermissionWaiting(request: waiting)
                    .frame(maxWidth: 360)
            } else if running {
                HStack(spacing: 5) {
                    AgentToolGlyph(tool: store.hud.activeTool, tint: .blue)
                    Text(verbatim: store.hud.activity)
                        .font(.caption)
                        .foregroundStyle(Color.blue)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let started = store.hud.turnStartedAt {
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Text(verbatim: "· " + AgentFormat.duration(ms: max(0, ctx.date.timeIntervalSince(started)) * 1000))
                        }
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    }
                }
                .frame(maxWidth: 420)
            } else {
                MainAgentIdleLine()
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 18).fill(tone.opacity(colorScheme == .dark ? 0.12 : 0.07)))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(tone.opacity(running ? 0.55 : 0.25), lineWidth: running ? 1.4 : 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Agent board main")
    }
}

/// Nobody here yet: a sleepy robot.
private struct BoardEmptyAgents: View {
    var body: some View {
        VStack(spacing: 8) {
            AgentAvatarView(avatar: AgentAvatar.of(type: "general-purpose"), mood: .idle, size: 40)
            Text("No subagents in this turn").font(.callout).foregroundStyle(.secondary)
            Text("Agents Claude delegates to appear here while they work.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
    }
}

/// The short line from a parent down to its children.
private struct BoardConnector: View {
    var body: some View {
        Capsule().fill(Color.secondary.opacity(0.28)).frame(width: 2, height: 14).accessibilityHidden(true)
    }
}

/// One level of the tree: batches of agents that ran at the same time side by side, one batch under the other.
private struct BoardLevel: View {
    let nodes: [AgentTreeNode]
    let depth: Int

    var body: some View {
        VStack(spacing: 12) {
            ForEach(Array(AgentTreeNode.parallelBatches(nodes, now: AgentFormat.nowMs()).enumerated()), id: \.offset) { _, batch in
                VStack(spacing: 6) {
                    if batch.count > 1 {
                        Label("\(batch.count) in parallel", systemImage: "arrow.triangle.branch")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    BoardFlow(spacing: 12) {
                        ForEach(batch) { node in AnyView(BoardSubtree(node: node, depth: depth)) }
                    }
                }
            }
        }
    }
}

/// An agent and, under it, the agents it started.
private struct BoardSubtree: View {
    let node: AgentTreeNode
    let depth: Int

    var body: some View {
        VStack(spacing: 6) {
            AgentBoardTile(agent: node.agent, small: depth > 0)
            if !node.children.isEmpty {
                BoardConnector()
                BoardLevel(nodes: node.children, depth: depth + 1)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.secondary.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            }
        }
    }
}

/// One subagent: its face, name, what it does now and its numbers.
struct AgentBoardTile: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let agent: AgentNode
    var small = false
    @State private var hovering = false

    var body: some View {
        let avatar = AgentAvatar.of(type: agent.type)
        let waiting = store.pendingPermission(forAgent: agent.toolUseId)
        let mood = AgentMood.of(agent, awaitingPermission: waiting != nil)
        let tone = avatar.tone.color(colorScheme)
        VStack(spacing: 5) {
            AgentAvatarView(avatar: avatar, mood: mood, size: small ? 38 : 48)
                .padding(.top, 4)
            HStack(spacing: 4) {
                Text(verbatim: avatar.name.isEmpty ? agent.type : avatar.name)
                    .font((small ? Font.caption : .callout).weight(.semibold))
                    .lineLimit(1)
                if let badge = avatar.badge {
                    Text(verbatim: badge)
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4).padding(.vertical, 0.5)
                        .background(Color.secondary.opacity(0.14), in: Capsule())
                        .fixedSize()
                }
            }
            .help(Text(verbatim: agent.type))
            if !agent.description.isEmpty {
                Text(verbatim: agent.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let waiting {
                AgentPermissionWaiting(request: waiting, compact: true)
            } else {
                BoardDoingLine(agent: agent, mood: mood)
            }
            BoardNumbers(agent: agent)
        }
        .padding(.horizontal, 10).padding(.bottom, 9).padding(.top, 4)
        .frame(width: small ? 176 : 204)
        .background(RoundedRectangle(cornerRadius: 16).fill(fill(tone, mood: mood)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(border(tone, mood: mood, waiting: waiting != nil), lineWidth: mood == .failed || waiting != nil ? 1.6 : 1.1))
        .scaleEffect(hovering && !reduceMotion ? 1.02 : 1)
        .animation(.easeOut(duration: 0.12), value: hovering)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onHover { hovering = $0 }
        .onTapGesture { model.reveal(toolUseId: agent.toolUseId) }
        .contextMenu { AgentCardMenuItems(agent: agent) }
        .help(Text("Show in chat"))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityActions {
            Button("Show in chat") { model.reveal(toolUseId: agent.toolUseId) }
            Button("Agent details") { model.showAgentDetails(toolUseId: agent.toolUseId) }
        }
        .accessibilityIdentifier("Agent board tile")
    }

    private func fill(_ tone: Color, mood: AgentMood) -> Color {
        mood == .failed ? Color.red.wash(colorScheme, light: 0.07, dark: 0.14) : tone.opacity(colorScheme == .dark ? 0.10 : 0.06)
    }

    private func border(_ tone: Color, mood: AgentMood, waiting: Bool) -> Color {
        if waiting { return .orange.opacity(0.8) }
        switch mood {
        case .failed: return .red.opacity(0.8)
        case .working, .retrying: return tone.opacity(0.7)
        case .stopped: return Color.secondary.opacity(0.25)
        default: return tone.opacity(0.35)
        }
    }
}

/// What the agent does now (its call's icon and words and how long it has run), or what it left.
private struct BoardDoingLine: View {
    let agent: AgentNode
    let mood: AgentMood

    var body: some View {
        switch mood {
        case .working, .retrying:
            if let step = agent.lastStep {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let ms = max(0, (step.endedAt ?? AgentFormat.nowMs(ctx.date)) - step.since)
                    HStack(spacing: 4) {
                        AgentToolGlyph(tool: step.tool, tint: .blue)
                        Text(verbatim: AgentToolText.text(tool: step.tool, detail: step.detail))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(verbatim: ElapsedFormat.text(seconds: ms / 1000)).monospacedDigit().foregroundStyle(.secondary).fixedSize()
                    }
                    .font(.caption2)
                    .foregroundStyle(step.endedAt == nil ? Color.blue : Color.secondary)
                }
            } else if let tool = agent.lastTool {
                HStack(spacing: 4) {
                    AgentToolGlyph(tool: tool, tint: .blue)
                    Text(verbatim: AgentToolText.text(tool: tool, detail: nil)).lineLimit(1)
                }
                .font(.caption2).foregroundStyle(Color.blue)
            } else {
                Text("Working…").font(.caption2).foregroundStyle(.secondary)
            }
        case .failed:
            if let line = AgentPanelLayout.rowDetail(agent, nowMs: 0) {
                Text(verbatim: line).font(.caption2).foregroundStyle(.red).lineLimit(2).multilineTextAlignment(.center)
            }
        default:
            if let line = AgentPanelLayout.rowDetail(agent, nowMs: 0) {
                Text(verbatim: line).font(.caption2).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.center)
            }
        }
    }
}

/// Tool calls · time · tokens · model (what the engine sent).
private struct BoardNumbers: View {
    let agent: AgentNode

    var body: some View {
        let model = ModelCostText.agentModel(agent)
        BoardFlow(spacing: 6) {
            if let uses = agent.toolUses {
                Label("\(uses) tools", systemImage: "hammer")
            }
            if agent.status.isLive, agent.startedAt > 0 {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    Label { Text(verbatim: AgentFormat.duration(ms: agent.elapsedMs(now: AgentFormat.nowMs(ctx.date)))) } icon: { Image(systemName: "clock") }
                }
            } else if agent.elapsedMs(now: 0) > 0 {
                Label { Text(verbatim: AgentFormat.duration(ms: agent.elapsedMs(now: 0))) } icon: { Image(systemName: "clock") }
            }
            if let tokens = agent.tokens {
                Label { Text(verbatim: HUDStrip.tokens(tokens)) } icon: { Image(systemName: "gauge.with.dots.needle.33percent") }
                    .help("\(tokens) tokens")
            }
            if let model { AgentModelChip(model: model) }
        }
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.secondary)
        .labelStyle(.titleAndIcon)
    }
}

/// "이전 턴": the chat's finished agents, a row of small faces per turn.
private struct BoardEarlierTurns: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        let groups = AgentGlance.historyByTurn(store.state.hud.agentHistory)
        if !groups.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Divider()
                HStack(spacing: 6) {
                    Text("Earlier turns").font(.callout.weight(.semibold))
                    Text(verbatim: "\(groups.reduce(0) { $0 + $1.agents.count })").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                .help("Finished subagents of this chat's earlier turns")
                ForEach(Array(groups.prefix(12).enumerated()), id: \.offset) { _, group in
                    HStack(alignment: .center, spacing: 10) {
                        Group {
                            if let turn = group.turn { Text("Turn \(turn)") } else { Text(verbatim: "—") }
                        }
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 52, alignment: .leading)
                        BoardFlow(spacing: 6) {
                            ForEach(group.agents) { agent in
                                let avatar = AgentAvatar.of(type: agent.type)
                                AgentAvatarView(avatar: avatar, mood: AgentMood.of(agent, awaitingPermission: false), size: 26)
                                    .padding(3)
                                    .contentShape(Circle())
                                    .onTapGesture { model.reveal(toolUseId: agent.toolUseId) }
                                    .contextMenu { AgentCardMenuItems(agent: agent) }
                                    .help(Text(verbatim: AgentGlance.historyLine(agent)))
                                    .accessibilityElement(children: .ignore)
                                    .accessibilityLabel(Text(verbatim: AgentGlance.historyLine(agent)))
                                    .accessibilityAddTraits(.isButton)
                                    .accessibilityAction { model.reveal(toolUseId: agent.toolUseId) }
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("Agent board earlier turns")
        }
    }
}

/// Centered wrapping row (tiles side by side, as many as fit), tops aligned.
struct BoardFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: min(width, proposal.width ?? width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX + max(0, (bounds.width - row.width) / 2)
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (items: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let extra = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if !current.items.isEmpty, extra > width {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.items + [index], extra, max(current.height, size.height))
            }
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}
