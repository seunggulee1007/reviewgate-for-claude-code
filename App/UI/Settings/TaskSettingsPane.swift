import SwiftUI
import ReviewGateCore

// MARK: task-start — docs/PROTOCOL.md §63: Settings › Tasks — the start screen, and how "Start from a task" works for the
// focused window's repository (or the default every project without its own uses): the platform, the branch prefix,
// where it starts, the MCP server Claude reads the task with, and the first prompt's template.

struct TaskSettingsPane: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.skipStartScreen) private var skipStartScreen = false
    /// Which settings are edited: this repository's own, or the default.
    @State private var scope: Scope = .project
    @State private var settings = TaskStartSettings.default
    @State private var template = ""
    /// The root / scope the fields were read for (a change writes only there).
    @State private var loaded: LoadedKey?

    enum Scope: Hashable { case project, all }

    private struct LoadedKey: Equatable {
        var root: String?
        var scope: Scope
    }

    /// The repository has settings of its own (re-read after every load and save).
    @State private var hasOwn = false

    private var root: String? { store.flowSettingsRoot }

    var body: some View {
        Form {
            Section("Start screen") {
                Toggle(isOn: Binding(get: { !skipStartScreen }, set: { skipStartScreen = !$0 })) { SettingLabel("skipStartScreen") }
                    .accessibilityIdentifier("Show the start screen")
                    .settingAnchor("skipStartScreen")
            }
            Section {
                scopeRow
                Picker(selection: $settings.platform) {
                    ForEach(TaskPlatform.allCases) { Text(LocalizedStringKey($0.title)).tag($0) }
                } label: { SettingLabel("taskPlatform") }
                .accessibilityIdentifier("Task platform")
                .settingAnchor("taskPlatform")
                TextField(text: $settings.branchPrefix, prompt: Text(verbatim: TaskStartSettings.defaultPrefix)) { SettingLabel("taskBranchPrefix") }
                    .font(.body.monospaced())
                    .accessibilityIdentifier("Task branch prefix")
                    .settingAnchor("taskBranchPrefix")
                Text("e.g. \(TaskBranch.name(prefix: settings.branchPrefix, id: "ACME-123", title: "Fix cart total", labels: ["bug"]))")
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                Picker(selection: $settings.location) {
                    Text("A new branch in this window").tag(TaskStartLocation.branch)
                    Text("A new workbench").tag(TaskStartLocation.workbench)
                } label: { SettingLabel("taskStartLocation") }
                .accessibilityIdentifier("Task start location")
                .settingAnchor("taskStartLocation")
                mcpRow.settingAnchor("taskMcpServer")
            } header: {
                Text("Start from a task")
            }
            Section("First prompt") {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        SettingLabel("taskPromptTemplate")
                        Spacer()
                        Button("Reset") { template = TaskPrompt.defaultTemplate }
                            .controlSize(.small)
                            .disabled(template == TaskPrompt.defaultTemplate)
                            .help(template == TaskPrompt.defaultTemplate
                                  ? String(localized: "This is the built-in template")
                                  : String(localized: "Back to the built-in template"))
                            .accessibilityIdentifier("Reset task prompt template")
                    }
                    TextEditor(text: $template)
                        .font(.body.monospaced())
                        .frame(minHeight: 110)
                        .accessibilityLabel("First prompt template")
                        .accessibilityIdentifier("Task prompt template")
                }
                .settingAnchor("taskPromptTemplate")
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: load)
        .onChange(of: root) { _, _ in load() }
        .onChange(of: scope) { _, _ in load() }
        .onChange(of: settings) { _, _ in save() }
        .onChange(of: template) { _, _ in save() }
    }

    /// For which projects: this repository (with "Use the default"), or every project without its own.
    @ViewBuilder
    private var scopeRow: some View {
        if let root {
            Picker("Settings for", selection: $scope) {
                Text("\(URL(fileURLWithPath: root).lastPathComponent) only").tag(Scope.project)
                Text("All projects (default)").tag(Scope.all)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("Task settings scope")
            if scope == .project {
                HStack {
                    Text(hasOwn ? "This project has its own settings." : "This project uses the default until you change something here.")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    let own = hasOwn
                    Button("Use the Default") {
                        AppSettings.clearProjectTaskStartSettings(root: root)
                        load()
                    }
                    .controlSize(.small)
                    .disabled(!own)
                    .help(own ? String(localized: "Forget this project's own settings; it uses the default again")
                              : String(localized: "This project already uses the default"))
                    .accessibilityIdentifier("Use the default task settings")
                }
            }
        } else {
            Text("No project open — these are the default for every project.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    /// The project's MCP servers, or a name typed; only used for Jira / Linear / Other.
    private var mcpRow: some View {
        let names = store.taskMcpServerNames
        let needed = settings.platform.readsThroughMcp
        return HStack {
            TextField(text: $settings.mcpServer, prompt: Text(verbatim: "acme-tracker")) { SettingLabel("taskMcpServer") }
                .font(.body.monospaced())
                .disabled(!needed)
                .accessibilityIdentifier("Task MCP server")
            Menu {
                ForEach(names, id: \.self) { name in Button(name) { settings.mcpServer = name } }
            } label: {
                Image(systemName: "chevron.up.chevron.down")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(!needed || names.isEmpty)
            .accessibilityLabel("Choose an MCP server")
            .accessibilityIdentifier("Task MCP server menu")
        }
        .help(!needed ? String(localized: "Only Jira, Linear and other trackers are read through an MCP server")
              : names.isEmpty ? String(localized: "This project's session reported no MCP servers — type the server's name")
              : String(localized: "The MCP server Claude reads the task with"))
    }

    private func load() {
        let key = LoadedKey(root: root, scope: root == nil ? .all : scope)
        if root == nil { scope = .all }
        settings = key.scope == .project ? AppSettings.taskStartSettings(root: root) : AppSettings.globalTaskStartSettings()
        template = settings.template
        hasOwn = root.map { AppSettings.hasProjectTaskStartSettings(root: $0) } ?? false
        loaded = key
    }

    private func save() {
        guard let loaded, loaded == LoadedKey(root: root, scope: root == nil ? .all : scope) else { return }
        var next = settings
        next.promptTemplate = template == TaskPrompt.defaultTemplate || template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : template
        let target = loaded.scope == .project ? loaded.root : nil
        let current = target.map { AppSettings.taskStartSettings(root: $0) } ?? AppSettings.globalTaskStartSettings()
        guard next != current else { return }
        AppSettings.setTaskStartSettings(next, root: target)
        hasOwn = root.map { AppSettings.hasProjectTaskStartSettings(root: $0) } ?? false
    }
}
