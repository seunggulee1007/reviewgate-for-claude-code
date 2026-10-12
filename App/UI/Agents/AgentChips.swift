import SwiftUI
import ReviewGateCore

// wave3 mac-agents — the small pieces the agent card, the chat's agent group and the "Agent details" sheet share
// (docs/PROTOCOL.md §36.1–36.3): the model chip, "재개됨(N회차)", the stop control and the agent's menu items.

/// §36.1: which "Agent details" sheet is open (`focusReport`: opened from "View full report", scrolled to the report).
struct AgentDetailRequest: Identifiable, Equatable {
    var toolUseId: String
    var focusReport: Bool
    var id: String { toolUseId + (focusReport ? "#report" : "") }
}

extension AgentModelFamily {
    /// opus purple, sonnet blue, haiku green, anything else gray — the same on both clients.
    var tint: Color {
        switch self {
        case .opus: .purple
        case .sonnet: .blue
        case .haiku: .green
        case .other: .gray
        }
    }
}

/// The model a subagent runs with ("opus", "sonnet 4.5"), tinted by family.
struct AgentModelChip: View {
    let model: String

    var body: some View {
        TagChip(Text(verbatim: AgentModelText.label(model)), systemImage: "cpu", tint: AgentModelText.family(model).tint)
            .help(Text("Model: \(model)"))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Model: \(model)"))
            .accessibilityIdentifier("Agent model")
    }
}

/// §36.3: "↻ 재개됨(2회차)" — SendMessage continued the agent after it had finished (`resumeCount` + 1 = this run).
struct AgentResumedBadge: View {
    let resumeCount: Int

    var body: some View {
        if resumeCount > 0 {
            TagChip(Text("Resumed (run \(resumeCount + 1))"), systemImage: "arrow.clockwise", tint: .indigo)
                .accessibilityIdentifier("Agent resumed")
        }
    }
}

/// §36.2: the hover ■ of a running agent. Off with its reason when this Claude Code cannot stop one agent; a spinner while
/// the stop is on its way; nothing for a finished agent or an engine without `stop_agent`.
struct AgentStopButton: View {
    @Environment(AppState.self) private var store
    let node: AgentNode

    var body: some View {
        switch store.agentStopState(node) {
        case .hidden:
            EmptyView()
        case .stopping:
            ProgressView().controlSize(.mini)
                .frame(width: 16, height: 16)
                .help(Text("Stopping this agent…"))
                .accessibilityLabel(Text("Stopping this agent…"))
        case .available:
            button.help(Text("Stop this agent — the turn and the other agents go on"))
        case let .unavailable(reason):
            button.disabled(true).help(reason)
        }
    }

    private var button: some View {
        Button {
            Task { await store.stopAgent(toolUseId: node.toolUseId) }
        } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 9, weight: .bold))
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.red)
        .accessibilityLabel(Text("Stop this agent"))
        .accessibilityIdentifier("Stop this agent")
    }
}

/// The agent's context-menu / head-menu items: "Agent details" and, while it runs, "Stop this agent".
struct AgentMenuItems: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let toolUseId: String

    var body: some View {
        Button("Agent details", systemImage: "info.circle") { model.showAgentDetails(toolUseId: toolUseId) }
        if let node = store.agentNode(toolUseId: toolUseId) {
            switch store.agentStopState(node) {
            case .hidden:
                EmptyView()
            case .available:
                Button("Stop this agent", systemImage: "stop.circle") { Task { await store.stopAgent(toolUseId: toolUseId) } }
            case .stopping:
                Button("Stop this agent", systemImage: "stop.circle") {}.disabled(true)
            case let .unavailable(reason):
                Section(reason) {
                    Button("Stop this agent", systemImage: "stop.circle") {}.disabled(true)
                }
            }
        }
    }
}

/// The HUD agents chip's context menu: "Agent details" of each agent (live ones first), and the panel.
struct HUDAgentDetailItems: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @AppStorage(AgentPanel.storageKey) private var showAgentPanel = false

    var body: some View {
        let agents = store.agents.filter(\.status.isLive) + store.agents.filter { !$0.status.isLive }
        Section("Agent details") {
            ForEach(agents, id: \.toolUseId) { agent in
                Button {
                    model.showAgentDetails(toolUseId: agent.toolUseId)
                } label: {
                    Text(verbatim: agent.description.isEmpty ? agent.type : "\(agent.type) — \(agent.description)")
                }
            }
        }
        Divider()
        Button("Show the agent activity panel (⌥⌘A)") { showAgentPanel = true }
    }
}

/// §36.2: why the last stop of this agent was refused, under the card / the group head (until the agent ends).
struct AgentStopRefusalLine: View {
    @Environment(AppState.self) private var store
    let toolUseId: String

    var body: some View {
        if let refusal = store.agentStopRefusals[toolUseId] {
            Label {
                Text(verbatim: refusal).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(.caption)
            .foregroundStyle(.orange)
            .accessibilityIdentifier("Agent stop refusal")
        }
    }
}
