import SwiftUI
import ReviewGateCore

// MARK: wave4b w4b-agents
// Subagents at a glance (docs/PROTOCOL.md §39.3; rules in Core `AgentGlance`, the same as Electron's agentGlance.ts): the
// card's current step, badges and isolation, its menu, the panel's earlier turns, MCP / Skill names in tool rows, which
// agent changed a file (the list's chips and filter) and the turn summary's "에이전트별 변경".

/// "Bash · ./gradlew :acme-api:test · 4분 12초" while the agent runs (its tool name alone on an older engine).
struct AgentStepLine: View {
    let agent: AgentNode

    var body: some View {
        if agent.status.isLive {
            if let step = agent.lastStep {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    label(AgentGlance.stepLine(step, nowMs: AgentFormat.nowMs(ctx.date)))
                        .opacity(step.endedAt == nil ? 1 : 0.65)
                }
                .accessibilityIdentifier("Agent step")
            } else if let tool = agent.lastTool {
                label(AgentGlance.toolTitle(tool, detail: nil))
            }
        }
    }

    private func label(_ text: String) -> some View {
        Label {
            Text(verbatim: text).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
        } icon: {
            Image(systemName: "wrench.adjustable")
        }
        .font(.caption)
        .foregroundStyle(.blue)
        .help(text)
    }
}

/// "재시도 3/10" (yellow) · "응답 없음 2분" (red) on a live card; none while it waits for a permission answer.
struct AgentGlanceBadges: View {
    @Environment(AppState.self) private var store
    let agent: AgentNode

    var body: some View {
        if agent.status.isLive, agent.retry != nil || agent.activeAt != nil {
            TimelineView(.periodic(from: .now, by: 5)) { ctx in
                let badges = AgentGlance.badges(agent, nowMs: AgentFormat.nowMs(ctx.date),
                                                awaitingPermission: store.pendingPermission(forAgent: agent.toolUseId) != nil)
                if !badges.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(badges, id: \.text) { b in
                            TagChip(Text(verbatim: b.text), systemImage: b.kind == .retry ? "arrow.clockwise" : "exclamationmark.triangle",
                                    tint: b.kind == .retry ? .yellow : .red)
                                .help(b.help)
                        }
                    }
                }
            }
            .accessibilityIdentifier("Agent glance badges")
        }
    }
}

/// "격리 worktree · 리뷰 밖" and opening that worktree as a workbench window.
struct AgentIsolationBadge: View {
    @Environment(\.openWindow) private var openWindow
    let agent: AgentNode

    var body: some View {
        if let badge = AgentGlance.isolationBadge(agent) {
            HStack(spacing: 6) {
                TagChip(Text(verbatim: badge.text), systemImage: "square.on.square.dashed", tint: .orange)
                    .help(badge.help)
                if let path = agent.worktreePath {
                    Button("Open its worktree as a workbench") {
                        openWindow(id: "workbench", value: URL(fileURLWithPath: path).standardizedFileURL)
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                    .help(path)
                }
            }
            .accessibilityIdentifier("Agent isolation")
        }
    }
}

/// The card's menu: 채팅에서 보기 / 보고서 보기 / 지시 보기 / 중지 (agents-11).
struct AgentCardMenuItems: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let agent: AgentNode

    var body: some View {
        Button("Show in chat", systemImage: "bubble.left.and.text.bubble.right") { model.reveal(toolUseId: agent.toolUseId) }
        // While it runs the sheet says why there is no report yet (never a silently disabled item).
        Button("View report", systemImage: "doc.text") { model.showAgentDetails(toolUseId: agent.toolUseId, report: true) }
        Button("View instructions", systemImage: "list.bullet.rectangle") { model.showAgentDetails(toolUseId: agent.toolUseId) }
        // MARK: wave5 w5-fixes — §43.5: '왜?' — a side question at the agent's call (an engine without side questions: off, with why)
        if store.side.isSupported {
            Button("Ask why it was started (side question)", systemImage: "questionmark.bubble") {
                let why = WhyQuestions.agent(toolUseId: agent.toolUseId)
                store.side.askNow(anchor: why.anchor, question: why.question)
            }
        } else {
            Section(String(localized: "Side questions need the engine of this app version")) {
                Button("Ask why it was started (side question)", systemImage: "questionmark.bubble") {}.disabled(true)
            }
        }
        switch store.agentStopState(agent) {
        case .hidden:
            EmptyView()
        case .available:
            Divider()
            Button("Stop this agent", systemImage: "stop.circle") { Task { await store.stopAgent(toolUseId: agent.toolUseId) } }
        case .stopping:
            Divider()
            Button("Stop this agent", systemImage: "stop.circle") {}.disabled(true)
        case let .unavailable(reason):
            Divider()
            Section(reason) { Button("Stop this agent", systemImage: "stop.circle") {}.disabled(true) }
        }
    }
}

/// The panel's "이전 턴": this chat's finished agents of earlier turns, one line each, by turn (newest first).
struct AgentEarlierTurns: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @State private var open = true

    var body: some View {
        let groups = AgentGlance.historyByTurn(store.state.hud.agentHistory)
        if !groups.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Divider()
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { open.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(open ? 90 : 0))
                        Text("Earlier turns").font(.caption.weight(.semibold))
                        Text(verbatim: "\(groups.reduce(0) { $0 + $1.agents.count })").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Finished subagents of this chat's earlier turns")
                if open {
                    ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                        VStack(alignment: .leading, spacing: 3) {
                            if let turn = group.turn {
                                Text("Turn \(turn)").font(.caption2).foregroundStyle(.secondary)
                            }
                            ForEach(group.agents) { agent in
                                let line = AgentGlance.historyLine(agent)
                                HStack(spacing: 4) {
                                    Button { model.reveal(toolUseId: agent.toolUseId) } label: {
                                        Text(verbatim: line).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .buttonStyle(.plain)
                                    .help(line)
                                    Button { model.showAgentDetails(toolUseId: agent.toolUseId) } label: { Image(systemName: "info.circle") }
                                        .buttonStyle(IconButtonStyle(padding: 2))
                                        .padding(.vertical, -2)
                                        .help("Agent details")
                                        .accessibilityLabel(Text("Agent details"))
                                }
                            }
                        }
                        .padding(.leading, 14)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Earlier agents")
        }
    }
}

/// A tool row's name: server chip + readable tool for an MCP call, "✦ 스킬" for a Skill call, else the raw name.
struct ToolNameText: View {
    let name: String
    let input: JSONValue

    var body: some View {
        let label = ToolLabel.of(name, input: input)
        switch label.kind {
        case .mcp:
            HStack(spacing: 4) {
                Text(verbatim: label.server ?? "")
                    .font(.caption2.weight(.medium))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                Text(verbatim: label.name).font(.callout.weight(.semibold))
            }
            .help(name)
        case .skill:
            Text("Skill").font(.callout.weight(.semibold)).help(name)
        case .tool:
            Text(verbatim: name).font(.callout.weight(.semibold))
        }
    }

    /// The row's detail for MCP / Skill calls (the representative argument, the skill and its args); nil: the row's own.
    static func detail(name: String, input: JSONValue) -> String? {
        let label = ToolLabel.of(name, input: input)
        switch label.kind {
        case .mcp: return label.arg ?? ""
        case .skill: return [label.name.isEmpty ? nil : label.name, label.arg].compactMap { $0 }.joined(separator: " ")
        case .tool: return nil
        }
    }
}

// MARK: who changed a file (agents-13)

/// Authors per changed path, rebuilt when rows are added or the review list changes (not on a streaming delta).
@MainActor
final class FileAuthorsCache {
    private var key: (revision: Int, files: [String]) = (-1, [])
    private var value: [String: [AgentGlance.FileAuthor]] = [:]

    /// `shown`: the chat whose rows the caller is drawn in — a turn summary card of a chat shown read-only (§39.2) names
    /// the authors from that chat's rows, not the running chat's (wave4b integration); the review list passes nil.
    func authors(_ store: AppState, files: [(path: String, toolUseIds: [String])], shown: ViewedChat? = nil) -> [String: [AgentGlance.FileAuthor]] {
        let signature = files.map { "\($0.path)\u{1}\($0.toolUseIds.joined(separator: ","))" } + [shown.map { "\u{2}\($0.id)|\($0.rows.count)" } ?? ""]
        if key.revision == store.transcriptStructureRevision, key.files == signature { return value }
        // MARK: wave7 w7-chat — §45.1: the running chat's shared index; another chat's rows still get their own
        let index = shown.map { TranscriptIndex($0.rows) } ?? store.transcriptIndex
        let agents = shown == nil ? store.agents : []   // the HUD's agents are the running chat's
        var out: [String: [AgentGlance.FileAuthor]] = [:]
        for f in files { out[f.path] = AgentGlance.fileAuthors(f.toolUseIds, index: index, agents: agents) }
        key = (store.transcriptStructureRevision, signature)
        value = out
        return out
    }
}

/// The changed-file row's agent chips (the main agent's own changes get none).
struct FileAuthorChips: View {
    let authors: [AgentGlance.FileAuthor]

    var body: some View {
        let agents = authors.filter { $0.agentToolUseId != nil }
        if !agents.isEmpty {
            HStack(spacing: 3) {
                ForEach(agents.prefix(3)) { a in
                    TagChip(Text(verbatim: a.label), systemImage: "person.2.wave.2", tint: .purple)
                        .help(Text("Changed by \(a.label)"))
                }
                if agents.count > 3 {
                    Text(verbatim: "+\(agents.count - 3)").font(.caption2).foregroundStyle(.secondary)
                        .help(agents.dropFirst(3).map(\.label).joined(separator: ", "))
                }
            }
            .accessibilityIdentifier("File authors")
        }
    }
}

/// "전체 · 메인 · executor · test-engineer" above the list (only with two or more authors).
struct AuthorFilterBar: View {
    let offered: [AgentGlance.FileAuthor]
    @Binding var selection: String?

    var body: some View {
        if offered.count >= 2 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    chip(Text("All files"), key: nil, help: nil)
                    ForEach(offered) { a in chip(Text(verbatim: a.label), key: a.key, help: String(localized: "Only the changes of \(a.label)")) }
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("Changes by agent"))
            .accessibilityIdentifier("Author filters")
        }
    }

    private func chip(_ text: Text, key: String?, help: String?) -> some View {
        let on = selection == key
        return Button { selection = on ? nil : key } label: {
            text.font(.caption2.weight(on ? .semibold : .regular))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(on ? Color.accentColor.opacity(0.22) : Color.secondary.opacity(0.10), in: Capsule())
                .foregroundStyle(on ? Color.accentColor : Color.primary)
        }
        .buttonStyle(.plain)
        .help(help ?? "")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// The turn summary's "에이전트별 변경": each author with its files (click → the diff / the agent's group).
struct AgentChangesSection: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let files: [(path: String, toolUseIds: [String])]
    @State private var cache = FileAuthorsCache()

    var body: some View {
        let authors = cache.authors(store, files: files, shown: store.viewingChat)   // the card's own chat (§39.2)
        let rows = AgentGlance.changesByAgent(files.map(\.path)) { authors[$0] ?? [] }
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text("Changes by agent").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(rows, id: \.author.key) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let id = row.author.agentToolUseId {
                            Button { model.reveal(toolUseId: id) } label: {
                                Label(row.author.label, systemImage: "person.2.wave.2").font(.caption.weight(.medium))
                            }
                            .buttonStyle(.link)
                            .help("Show in chat")
                        } else {
                            Text(verbatim: row.author.label).font(.caption.weight(.medium))
                        }
                        Text(verbatim: row.paths.map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .help(row.paths.joined(separator: "\n"))
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Summary agent changes")
        }
    }
}
