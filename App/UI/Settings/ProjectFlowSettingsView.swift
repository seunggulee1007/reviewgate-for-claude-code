import SwiftUI
import ReviewGateCore

// MARK: wave3 mac-flow
// Settings › Project: the daily-flow settings of the focused window's repository (docs/PROTOCOL.md §36.11 / §36.12 /
// §36.14) — the commit message template, the workbench setup and the command PR comments start with. Kept per repository
// (its main worktree), so every workbench of it shares them.

struct ProjectFlowSettingsView: View {
    @Environment(AppState.self) private var store

    var body: some View {
        Form {
            if let root = store.flowSettingsRoot {
                Section {
                    Text("Settings of \(URL(fileURLWithPath: root).lastPathComponent) — every workbench of this repository uses them.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Section("Commit message template") {
                    CommitTemplateEditor(showsTitle: false)
                }
                Section("Workbench setup") {
                    WorkbenchSetupEditor(showsTitle: false)
                }
                Section("PR comments") {
                    PRRespondCommandField()
                }
                AutoAcceptSettingsSection()   // MARK: wave4c w4c-trust (§41.2)
            } else {
                ContentUnavailableView("No project open", systemImage: "folder",
                                       description: Text("Open a project to edit the settings of its repository."))
            }
        }
        .formStyle(.grouped)
    }
}

/// The repository's command for "Send to Claude" on PR comments (client only — never sent to the engine).
struct PRRespondCommandField: View {
    @Environment(AppState.self) private var store
    @State private var command = ""
    @State private var loadedRoot: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Command for PR comments", text: $command, prompt: Text(verbatim: "/acme-tools:review-reply {pr}"))
                .font(.body.monospaced())
                .accessibilityIdentifier("PR respond command")
            Text("“Send to Claude” starts the draft with this command ({pr} = the PR number) — e.g. a skill that fixes the code and answers each comment. Empty: the comments only. You still read the draft and send it yourself.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear(perform: load)
        .onChange(of: store.flowSettingsRoot) { _, _ in load() }
        .onChange(of: command) { _, new in
            guard loadedRoot != nil, loadedRoot == store.flowSettingsRoot else { return }
            store.setPRRespondCommand(new)
        }
    }

    private func load() {
        loadedRoot = store.flowSettingsRoot
        command = store.prRespondCommand
    }
}
