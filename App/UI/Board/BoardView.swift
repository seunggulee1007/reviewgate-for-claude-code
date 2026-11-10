import SwiftUI
import ReviewGateCore

// MARK: wave5 w5-board
// docs/PROTOCOL.md §43.1 — the agent board ("관제판"): one window per project window (Window › Agent Board, ⌥⌘B) with three
// tabs — agents (`AgentBoardView`), sub-brain (`SubBrainBoardView`, w5-brain) and code graph (`CodeGraphBoardView`, w5-graph).
// Each tab view takes no arguments and reads the project's state from the environment. The tab is remembered per project.

struct BoardView: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @State private var tab: BoardTab = .agents
    @State private var loadedFor: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Group {
                switch tab {
                case .agents: AgentBoardView()
                case .brain: SubBrainBoardView()
                case .graph: CodeGraphBoardView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 420, minHeight: 420)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { loadTab() }
        .onChange(of: projectKey) { _, _ in loadTab() }
        .onChange(of: tab) { _, new in
            if let projectKey, loadedFor == projectKey { BoardPrefs.setTab(new, project: projectKey) }
        }
        // A click on an agent shows its group in the chat (or its card, its details sheet): the project's window comes forward.
        .onChange(of: model.revealTick) { _, _ in BoardWindows.shared.bringOwnerForward(of: model) }
        .onChange(of: model.revealPermissionTick) { _, _ in BoardWindows.shared.bringOwnerForward(of: model) }
        .onChange(of: model.agentDetail?.toolUseId) { _, new in if new != nil { BoardWindows.shared.bringOwnerForward(of: model) } }
        // §43.5's "왜 시작했는지 묻기" from a tile's menu (the card's menu): the side question opens in the project's window.
        .onChange(of: store.side.presentTick) { _, _ in BoardWindows.shared.bringOwnerForward(of: model) }
        .accessibilityIdentifier("Agent board window")
    }

    private var projectKey: String? { store.projectURL.map(AppSettings.projectKey) }

    private func loadTab() {
        guard let projectKey else { return }
        tab = BoardPrefs.tab(project: projectKey)
        loadedFor = projectKey
    }

    private var header: some View {
        HStack(spacing: 10) {
            Picker(selection: $tab) {
                Label("Agents", systemImage: "person.2.wave.2").tag(BoardTab.agents)
                Label("Sub-brain", systemImage: "brain.head.profile").tag(BoardTab.brain)
                Label("Code graph", systemImage: "point.3.connected.trianglepath.dotted").tag(BoardTab.graph)
            } label: {
                Text("Agent Board")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .accessibilityIdentifier("Agent board tabs")
            Spacer(minLength: 8)
            if let name = store.projectInfo?.name {
                Label { Text(verbatim: name) } icon: { Image(systemName: "folder") }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }
}
