import SwiftUI
import ReviewGateCore

/// One subagent: status, type + description, current tool, live elapsed time, usage, summary / error, files.
/// wave3 mac-agents (§36.1–36.3): its model, "재개됨(N회차)", "사용자가 중지"; a click opens "Agent details", the hover ■ and
/// the context menu stop it.
struct AgentCard: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let agent: AgentNode
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                AgentStatusChip(status: agent.status, stoppedByUser: agent.stoppedBy == .user)
                AgentTypeTitle(type: agent.type)   // wave4d w4d-agents2 — agents-10: "executor [OMC]" (was the raw type, cut)
                // MARK: wave4b w4b-agents — agents-11: the card shows its chat group; the details open from here.
                Button { model.showAgentDetails(toolUseId: agent.toolUseId) } label: { Image(systemName: "info.circle") }
                    .buttonStyle(IconButtonStyle(padding: 2))   // `.borderless` left the glyph alone as the target
                    .padding(.vertical, -2)
                    .font(.caption)
                    .help("Agent details")
                    .accessibilityLabel(Text("Agent details"))
                Spacer(minLength: 4)
                if agent.isBackground {
                    Image(systemName: "moon.zzz.fill")
                        .font(.caption2)
                        .foregroundStyle(.indigo)
                        .help("Runs in the background")
                        .accessibilityLabel("Background")
                }
                elapsed
                if agent.status.isLive {
                    AgentStopButton(node: agent)
                        .opacity(hovering || store.stoppingAgentIds.contains(agent.toolUseId) ? 1 : 0)
                        .accessibilityHidden(!hovering)
                }
            }
            AgentStopRefusalLine(toolUseId: agent.toolUseId)
            AgentGlanceBadges(agent: agent)   // wave4b w4b-agents: 재시도 3/10 · 응답 없음 2분
            if let waiting = store.pendingPermission(forAgent: agent.toolUseId) {
                AgentPermissionWaiting(request: waiting)   // wave1 mac-perms: "권한 대기" + [카드로 이동]
            }
            if !agent.description.isEmpty {
                Text(verbatim: agent.description)
                    .font(.callout.weight(.medium))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // MARK: wave4b w4b-agents — §39.3: "Bash · ./gradlew :acme-api:test · 4분 12초" (was the tool name only).
            AgentStepLine(agent: agent)
            AgentIsolationBadge(agent: agent)
            if let summary = agent.summary, !summary.isEmpty {
                Text(verbatim: summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(summary)
            }
            if let error = agent.error, !error.isEmpty {
                Label {
                    Text(verbatim: error).lineLimit(3)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                }
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
            }
            metrics
            if !agent.files.isEmpty { files }
        }
        .padding(10)
        .padding(.leading, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        // MARK: wave4d w4d-agents2 — agents-10: the agent's own color on the left edge; a failure is a red card, louder than a
        // running one (its border was the faintest); a stop is quieter than a finished agent.
        .background(emphasis.fill(colorScheme))
        .overlay(alignment: .leading) { AgentIdentityBand(type: agent.type) }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(borderTint.opacity(emphasis.border.opacity), lineWidth: emphasis.border.width)
        )
        // wave3 mac-agents: the card opens "Agent details"; its menu also stops it.
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .onHover { hovering = $0 }
        // MARK: wave4b w4b-agents — agents-11: a click opens and shows its group in the chat (Electron the same).
        .onTapGesture { model.reveal(toolUseId: agent.toolUseId) }
        .contextMenu { AgentCardMenuItems(agent: agent) }
        .help(Text("Show in chat"))
        .accessibilityElement(children: .contain)
        .accessibilityActions {
            Button("Show in chat") { model.reveal(toolUseId: agent.toolUseId) }
            Button("Agent details") { model.showAgentDetails(toolUseId: agent.toolUseId) }
            if store.agentStopState(agent) == .available {
                Button("Stop this agent") { Task { await store.stopAgent(toolUseId: agent.toolUseId) } }
            }
        }
        .accessibilityIdentifier("Agent card")
    }

    /// wave1 mac-perms: orange while the agent waits for a permission answer, else its status color.
    private var borderTint: Color {
        emphasis == .waiting ? .orange : agent.status.tint
    }

    // MARK: wave4d w4d-agents2
    private var emphasis: AgentCardEmphasis {
        AgentCardEmphasis.of(agent, awaitingPermission: store.pendingPermission(forAgent: agent.toolUseId) != nil)
    }

    @ViewBuilder
    private var elapsed: some View {
        if agent.status.isLive, agent.startedAt > 0 {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Text(verbatim: AgentFormat.duration(ms: agent.elapsedMs(now: AgentFormat.nowMs(ctx.date))))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        } else if agent.elapsedMs(now: 0) > 0 {
            Text(verbatim: AgentFormat.duration(ms: agent.elapsedMs(now: 0)))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var metrics: some View {
        let model = ModelCostText.agentModel(agent)   // wave4d w4d-agents2 (§42.4): the model it ran on, else the one named
        if agent.tokens != nil || agent.toolUses != nil || model != nil || agent.resumeCount > 0 {
            FlowLayout(spacing: 8) {
                // wave3 mac-agents (§36.1 / §36.3): the model and "재개됨(N회차)" lead the line (the head keeps the type).
                if let model { AgentModelChip(model: model) }
                AgentResumedBadge(resumeCount: agent.resumeCount)
                if let tokens = agent.tokens {
                    Label(HUDStrip.tokens(tokens), systemImage: "gauge.with.dots.needle.33percent")   // wave4d: was "#"
                        .help("\(tokens) tokens")
                }
                if let uses = agent.toolUses {
                    Label("\(uses) tools", systemImage: "hammer")
                }
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
        }
    }

    private var files: some View {
        let root = store.projectInfo?.root ?? store.projectURL?.path
        let shown = agent.files.prefix(6)
        return FlowLayout(spacing: 4) {
            ForEach(Array(shown), id: \.self) { path in
                let rel = RepoPath.relative(path, root: root)
                let inReview = store.changedFiles.contains { $0.path == rel }
                Button { store.selectFile(path: rel) } label: {
                    TagChip(Text(verbatim: (rel as NSString).lastPathComponent), systemImage: "doc",
                            tint: inReview ? .accentColor : .secondary)
                }
                .buttonStyle(.plain)
                .disabled(!inReview)
                .help(inReview ? String(localized: "Show the diff of \(rel)") : rel)
            }
            if agent.files.count > shown.count {
                Text(verbatim: "+\(agent.files.count - shown.count)").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("Agent files")
    }
}

/// Wraps its children onto as many lines as needed.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += lineHeight + spacing
                x = 0
                lineHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: min(maxX, width), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += lineHeight + spacing
                x = bounds.minX
                lineHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
