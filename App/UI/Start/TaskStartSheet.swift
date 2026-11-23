import SwiftUI
import ReviewGateCore

// MARK: task-start — docs/PROTOCOL.md §63.3: "Start from a task". The user names the task (an id or a link); a GitHub issue
// is read by the engine (`task_fetch`), any other tracker by Claude through the MCP server of Settings › Tasks. The branch
// `<prefix><id>-<slug>` and the first prompt are filled in and stay editable; Start makes the branch here (or a workbench)
// and puts the prompt into the message box — the user sends it.

struct TaskStartSheet: View {
    enum Outcome {
        /// The branch (if any) is made here and the prompt waits in this window's chat.
        case startedHere
        /// A workbench was made; its window takes the prompt.
        case workbench(URL)
    }

    let onStarted: (Outcome) -> Void

    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var settings = TaskStartSettings.default
    @State private var refText = ""
    @State private var fetched: FetchedTask?
    @State private var fetching = false
    @State private var fetchError: String?
    @State private var branch = ""
    @State private var branchTyped = false
    @State private var location: TaskStartLocation = .branch
    @State private var prompt = ""
    @State private var promptTyped = false
    @State private var starting = false
    @State private var startError: String?
    @FocusState private var refFocused: Bool

    private var reference: TaskReference? { TaskReference.parse(refText) }
    private var shadow: Bool { store.isShadowProject }
    private var fetchesFromGitHub: Bool { reference?.fetchesFromGitHub(platform: settings.platform) ?? false }

    /// What the app knows of the task: the issue read, else its id and link.
    private var task: FetchedTask? {
        guard let reference else { return nil }
        if let fetched { return fetched }
        return FetchedTask(id: reference.id, url: reference.url ?? "")
    }

    private var branchHint: String? {
        guard !shadow else { return nil }
        return branchNameHint(branch, existing: store.branches)
    }

    /// Why Start is off (nil: it can start).
    private var startBlocker: String? {
        if reference == nil { return String(localized: "Enter a task id or link") }
        if fetching { return String(localized: "Reading the issue…") }
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "The first prompt is empty") }
        if let branchHint { return branchHint }
        if !shadow, location == .branch, let blocker = store.branchCreateBlocker() { return blocker.localizedDescription }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Start from a task").font(.headline)
                Text(platformLine).font(.caption).foregroundStyle(.secondary)
            }
            referenceField
            if !shadow {
                Text("Branch").font(.subheadline.weight(.semibold))
                TextField("Branch", text: Binding(get: { branch }, set: { branch = $0; branchTyped = true }))
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .disabled(starting)
                    .accessibilityIdentifier("Task branch")
                if let branchHint, !branch.isEmpty {
                    Text(branchHint).font(.caption).foregroundStyle(.red)
                }
                Picker("Start in", selection: $location) {
                    Text("A new branch in this window").tag(TaskStartLocation.branch)
                    Text("A new workbench").tag(TaskStartLocation.workbench)
                }
                .pickerStyle(.radioGroup)
                .disabled(starting)
                .accessibilityIdentifier("Task start location")
            } else {
                Label("This folder is not a git repository — the task starts in this folder, without a branch.", systemImage: "folder")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text("First prompt").font(.subheadline.weight(.semibold))
                Spacer()
                Text("Goes into the message box — you send it").font(.caption).foregroundStyle(.secondary)
            }
            TextEditor(text: Binding(get: { prompt }, set: { prompt = $0; promptTyped = true }))
                .font(.body.monospaced())
                .frame(minHeight: 120, maxHeight: 220)
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.secondary.opacity(0.3)))
                .disabled(starting)
                .accessibilityLabel("First prompt")
                .accessibilityIdentifier("Task first prompt")
            if let startError {
                Text(startError).font(.caption).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                SettingsJumpButton("Task Settings…", to: "taskPlatform")
                    .help("Settings › Tasks: platform, branch prefix, MCP server, first prompt")
                    .accessibilityIdentifier("Task settings")
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("Task start cancel")
                Button(shadow ? "Start in This Folder" : location == .workbench ? "Create Workbench" : "Create Branch and Start") { start() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(starting || startBlocker != nil)
                    .help(startBlocker ?? String(localized: "The prompt goes into the message box; nothing is sent until you press Return"))
                    .accessibilityIdentifier("Task start")
            }
        }
        .padding(20)
        .frame(width: 560)
        .onAppear {
            settings = store.taskStartSettings
            location = settings.location
            refFocused = true
        }
        .onChange(of: refText) { _, _ in
            fetched = nil
            fetchError = nil
            refill()
        }
        .onChange(of: location) { _, _ in startError = nil }
        .task(id: refText) { await fetchIfGitHub() }
    }

    private var platformLine: String {
        switch settings.platform {
        case .none: String(localized: "A task id or link — set the platform in Settings › Tasks")
        case .github: String(localized: "GitHub Issues — read with the GitHub CLI (gh)")
        case .jira, .linear, .mcp:
            settings.mcpServer.isEmpty
                ? String(localized: "\(String(localized: String.LocalizationValue(settings.platform.title))) — choose its MCP server in Settings › Tasks")
                : String(localized: "\(String(localized: String.LocalizationValue(settings.platform.title))) — Claude reads it with the \(settings.mcpServer) MCP server")
        }
    }

    private var referenceField: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("Task id or link", text: $refText, prompt: Text(verbatim: "ACME-123 · #42 · https://tracker.example.com/task/123"))
                .textFieldStyle(.roundedBorder)
                .focused($refFocused)
                .disabled(starting)
                .accessibilityIdentifier("Task reference")
            Group {
                if fetching {
                    HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Reading the issue…") }
                } else if let fetched {
                    Label(fetched.title, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        .lineLimit(1)
                        .help(fetched.url)
                } else if let fetchError {
                    Label(fetchError, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        .help("The task starts without its title — Claude reads it")
                } else if let reference {
                    Text("Task \(reference.id)").foregroundStyle(.secondary)
                } else if !refText.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("No task id in this — use a key (ACME-123), a number or a link").foregroundStyle(.secondary)
                }
            }
            .font(.caption)
        }
    }

    /// A GitHub issue is read as soon as the field holds one (a paste, or typing that stops for a moment).
    private func fetchIfGitHub() async {
        guard fetchesFromGitHub, let ref = reference?.issueRef else { return }
        try? await Task.sleep(for: .milliseconds(reference?.url != nil ? 50 : 500))
        guard !Task.isCancelled else { return }
        fetching = true
        defer { fetching = false }
        do {
            let task = try await store.fetchTask(ref: ref)
            guard !Task.isCancelled else { return }
            fetched = task
            fetchError = nil
        } catch {
            guard !Task.isCancelled else { return }
            fetchError = error.localizedDescription
        }
        refill()
    }

    /// The branch and the prompt follow the task until the user edits them.
    private func refill() {
        guard let task else {
            if !branchTyped { branch = "" }
            if !promptTyped { prompt = "" }
            return
        }
        if !branchTyped { branch = TaskBranch.name(prefix: settings.branchPrefix, id: task.id, title: task.title, labels: task.labels) }
        if !promptTyped {
            let hint = TaskPrompt.hint(platform: settings.platform, mcpServer: settings.mcpServer, task: task, github: fetchesFromGitHub)
            prompt = TaskPrompt.render(template: settings.template, task: task, hint: hint)
        }
    }

    private func start() {
        guard startBlocker == nil else { return }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = branch.trimmingCharacters(in: .whitespaces)
        starting = true
        startError = nil
        Task {
            defer { starting = false }
            if !shadow, location == .workbench {
                guard let url = await store.createWorkbench(branch: name, options: WorkbenchCreateOptions(task: WorkbenchTask(text: text, draft: true))) else {
                    startError = store.lastError.map { EngineMessages.refusal(error: $0) } ?? String(localized: "Could not create the workbench")
                    return
                }
                dismiss()
                onStarted(.workbench(url))
                return
            }
            if let error = await store.startTaskHere(shadow ? .here : .branch(name), prompt: text) {
                startError = error
                return
            }
            dismiss()
            onStarted(.startedHere)
        }
    }
}
