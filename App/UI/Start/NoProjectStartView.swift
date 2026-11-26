import SwiftUI
import AppKit
import ReviewGateCore

// MARK: §69 start without a folder — docs/PROTOCOL.md §69.4: the window with no project offers 1 New (a folder made from the
// first prompt), 2 Start from a task (the base project picked first, then §63's task sheet) and 3 Open a folder (as Open
// Project). 1 / 2 / 3 act at once, the arrows move the mark, ↩ takes it. The recent projects stay below (MainWindow).

/// The three cards of the window with no project, with their sheets.
struct NoProjectStartCards: View {
    @Environment(AppState.self) private var store
    @State private var mark: NoProjectChoice = .new
    @State private var showNew = false
    @State private var showTask = false
    @FocusState private var focused: Bool

    private var openingReason: String? {
        store.openingProject.map { String(localized: "Opening \($0.lastPathComponent)…") }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            card(.new, symbol: "sparkles", title: "New Project", detail: "No folder yet — say what you want to make",
                 help: String(localized: "Makes a folder for it under \(AppSettings.newProjectParentForDisplay) as a git repository (1)"))
            card(.task, symbol: "checklist", title: "Start from a task", detail: "Pick the project the task belongs to",
                 help: String(localized: "A task link, key or number — then its project, its branch and first prompt (2)"))
            card(.open, symbol: "folder.badge.plus", title: "Open a folder…", detail: "A project you already have",
                 help: String(localized: "Choose a project folder (3)"))
                .accessibilityIdentifier("Open Project…")
        }
        .fixedSize(horizontal: false, vertical: true)   // every card as tall as the tallest
        .frame(maxWidth: 640)
        .disabled(store.openingProject != nil)
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .task {
            focused = true
            try? await Task.sleep(for: .milliseconds(150))
            focused = true
        }
        .onKeyPress(characters: CharacterSet(charactersIn: "123"), phases: .down) { press in
            guard let n = Int(press.characters), let choice = NoProjectChoice(rawValue: n) else { return .ignored }
            mark = choice
            perform(choice)
            return .handled
        }
        .onKeyPress(.leftArrow) { mark = mark.moved(-1); return .handled }
        .onKeyPress(.upArrow) { mark = mark.moved(-1); return .handled }
        .onKeyPress(.rightArrow) { mark = mark.moved(1); return .handled }
        .onKeyPress(.downArrow) { mark = mark.moved(1); return .handled }
        .onKeyPress(.return) { perform(mark); return .handled }
        .sheet(isPresented: $showNew, onDismiss: { focused = true }) { NewProjectSheet() }
        .sheet(isPresented: $showTask, onDismiss: { focused = true }) { TaskProjectSheet() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("No project start")
    }

    private func perform(_ choice: NoProjectChoice) {
        guard store.openingProject == nil else { return }
        switch choice {
        case .new: showNew = true
        case .task: showTask = true
        case .open: ProjectOpener.choose(store: store)
        }
    }

    private func card(_ choice: NoProjectChoice, symbol: String, title: LocalizedStringKey, detail: LocalizedStringKey, help: String) -> some View {
        let marked = mark == choice
        return Button {
            mark = choice
            perform(choice)
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: symbol).font(.title2).foregroundStyle(Color.accentColor)
                    Spacer()
                    Text(verbatim: "\(choice.rawValue)")
                        .font(.caption.monospaced().weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                        .accessibilityHidden(true)
                }
                .frame(height: 24)   // the symbols differ in height: the titles stay on one line across the cards
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.leading)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 104, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(marked ? Color.accentColor : Color.secondary.opacity(0.25), lineWidth: marked ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .help(openingReason ?? help)
        .accessibilityLabel(Text(title))
        .accessibilityHint(Text(detail))
        .accessibilityIdentifier("No project choice \(choice.rawValue)")
    }
}

/// 1 New: the first prompt, the folder name it gives (editable) and where it goes; Create makes, opens and fills the chat.
struct NewProjectSheet: View {
    /// The words already typed when it opens (the screenshot tour's; empty: none).
    var initialPrompt: String = ""

    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var name = ""
    @State private var nameTyped = false
    @State private var preview: ProjectNameReply?
    /// Why the engine gives no name (too old, the parent setting refused): shown on the path line and as Create's reason.
    @State private var unavailable: String?
    @State private var creating = false
    @State private var error: String?
    @FocusState private var promptFocused: Bool

    private var blocker: String? {
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Say what you want to make first") }
        if let unavailable { return unavailable }
        if preview == nil { return String(localized: "Working out the folder name…") }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("New project").font(.headline)
                Text("ReviewGate makes the folder and a git repository; your words go into the message box.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text("What do you want to make?").font(.subheadline.weight(.semibold))
            TextEditor(text: $prompt)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 4).padding(.vertical, 4)   // the words off the border, as in the other text boxes
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 4))
                .frame(minHeight: 90, maxHeight: 180)
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.secondary.opacity(0.3)))
                .focused($promptFocused)
                .disabled(creating)
                .accessibilityLabel("What do you want to make?")
                .accessibilityIdentifier("New project prompt")
            Text("Folder name").font(.subheadline.weight(.semibold))
            TextField("Folder name", text: Binding(get: { name }, set: { name = $0; nameTyped = true }))
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .disabled(creating)
                .help("Follows what you type above until you edit it; a name already taken gets -2, -3")
                .accessibilityIdentifier("New project name")
            HStack(spacing: 6) {
                if unavailable != nil {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                } else {
                    Image(systemName: "folder").foregroundStyle(.secondary)
                }
                Text(unavailable ?? preview.map { String(localized: "Creates \($0.path)") } ?? String(localized: "Working out the folder name…"))
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(unavailable == nil ? 1 : 2).truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(unavailable ?? preview?.path ?? "")
                    .accessibilityIdentifier("New project path")
                Spacer()
                SettingsJumpButton("Change…", to: "newProjectParent")
                    .controlSize(.small)
                    .disabled(creating)
                    .help(creating ? String(localized: "The project is being made") : String(localized: "Settings › General › Folder for new projects"))
                    .accessibilityIdentifier("New project parent")
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    .accessibilityIdentifier("New project error")
            }
            HStack {
                Text("Goes into the message box — you send it").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if creating { ProgressView().controlSize(.small) }
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(creating)
                    .help(creating ? String(localized: "The project is being made") : "")
                    .accessibilityIdentifier("New project cancel")
                Button("Create and Open") { create() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(creating || blocker != nil)
                    .help(blocker ?? String(localized: "Makes the folder, opens it and puts your words into the message box; nothing is sent until you press Return"))
                    .accessibilityIdentifier("New project create")
            }
        }
        .padding(20)
        .frame(width: 520)
        .onAppear {
            if prompt.isEmpty, !initialPrompt.isEmpty { prompt = initialPrompt }
            promptFocused = true
        }
        .task(id: nameTyped ? "name:\(name)" : "prompt:\(prompt)") { await refreshPreview() }
    }

    /// The name follows the prompt until edited; the engine says what it becomes and where (0.3 s after typing stops).
    private func refreshPreview() async {
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        let outcome = await store.newProjectName(text: nameTyped ? name : prompt)
        guard !Task.isCancelled else { return }
        switch outcome {
        case .ready(let reply):
            preview = reply
            unavailable = nil
            if !nameTyped { name = reply.name }
        case .unavailable(let why):
            preview = nil
            unavailable = why
        }
    }

    private func create() {
        guard blocker == nil, let preview else { return }
        creating = true
        error = nil
        model.suppressNextStartScreen = true   // §69.4: the new project opens into its chat, the prompt waiting there
        Task {
            defer { creating = false }
            let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            if let why = await store.createProject(name: nameTyped ? name : preview.name, expected: URL(fileURLWithPath: preview.path), prompt: text) {
                model.suppressNextStartScreen = false
                error = why
                return
            }
            dismiss()
        }
    }
}

/// 2 Start from a task: the task first, then the project it belongs to (one click), then §63's task sheet in that project.
struct TaskProjectSheet: View {
    /// The task already typed when it opens (the screenshot tour's; empty: none).
    var initialRef: String = ""

    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var refText = ""
    @State private var recent: [URL] = []
    @State private var matches: ProjectMatchesReply = ProjectMatchesReply()
    @State private var selected: URL?
    @State private var matching = false
    @FocusState private var refFocused: Bool

    private var reference: TaskReference? { TaskReference.parse(refText) }

    private var blocker: String? {
        if reference == nil { return String(localized: "Enter a task id or link") }
        if selected == nil { return String(localized: "Choose the project the task belongs to") }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Start from a task").font(.headline)
                Text("First the project the task belongs to — then its branch and first prompt, as in a project window.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            TextField("Task id or link", text: $refText, prompt: Text(verbatim: "ACME-123 · #42 · https://github.com/acme/widgets/issues/42"))
                .textFieldStyle(.roundedBorder)
                .focused($refFocused)
                .accessibilityIdentifier("Task project reference")
            Group {
                if let reference {
                    if matching {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Looking for its project…") }
                    } else if let repo = matches.repo {
                        Text(matches.matches.isEmpty ? String(localized: "Task \(reference.id) — no recent project has \(repo) as a remote")
                             : String(localized: "Task \(reference.id) — \(repo)"))
                    } else {
                        Text("Task \(reference.id)")
                    }
                } else if !refText.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("No task id in this — use a key (ACME-123), a number or a link")
                }
            }
            .font(.caption).foregroundStyle(.secondary)
            Text("Project").font(.subheadline.weight(.semibold))
            if recent.isEmpty {
                Text("No recent projects — choose its folder.").font(.callout).foregroundStyle(.secondary)
            } else {
                List(recent, id: \.self, selection: $selected) { url in
                    HStack(spacing: 8) {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: url.lastPathComponent)
                            Text(verbatim: url.path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        if matches.matches.contains(url.path), let repo = matches.repo {
                            Text("Matches \(repo)").font(.caption).foregroundStyle(.green)
                        }
                    }
                    .tag(url)
                    .contentShape(Rectangle())
                    .help(url.path)
                }
                .listStyle(.bordered)
                .frame(height: min(CGFloat(recent.count) * 40 + 8, 220))
                .accessibilityIdentifier("Task project list")
            }
            HStack {
                Button("Other Folder…") { chooseOther() }
                    .help("Choose the project's folder")
                    .accessibilityIdentifier("Task project other folder")
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("Task project cancel")
                Button("Open and Continue") { start() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(blocker != nil)
                    .help(blocker ?? String(localized: "Opens the project, then its task sheet with this task filled in"))
                    .accessibilityIdentifier("Task project continue")
            }
        }
        .padding(20)
        .frame(width: 540)
        .onAppear {
            recent = RecentProjects.entries().filter(\.exists).map(\.url)
            selected = recent.first
            if refText.isEmpty, !initialRef.isEmpty { refText = initialRef }
            refFocused = true
        }
        .task(id: refText) { await match() }
    }

    /// The recent projects whose remote is the task's repository; the engine's guess (else the most recent) is preselected.
    private func match() async {
        guard reference != nil else {
            matches = ProjectMatchesReply()
            return
        }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        matching = true
        defer { matching = false }
        let reply = await store.matchProjects(ref: refText.trimmingCharacters(in: .whitespacesAndNewlines), paths: recent.map(\.path))
        guard !Task.isCancelled else { return }
        matches = reply
        if let pick = reply.preselect(in: recent.map(\.path)) { selected = URL(fileURLWithPath: pick) }
    }

    private func chooseOther() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "Choose")
        panel.message = String(localized: "Choose the project the task belongs to")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if !recent.contains(url) { recent.insert(url, at: 0) }
        selected = url
    }

    private func start() {
        guard blocker == nil, let url = selected else { return }
        model.pendingTaskStart = PendingTaskStart(root: AppSettings.projectKey(url), ref: refText.trimmingCharacters(in: .whitespacesAndNewlines))
        dismiss()
        ProjectOpener.open(url, store: store)
    }
}

/// §69.4: the task the no-project window named, for the start screen of the project it opens.
struct PendingTaskStart: Equatable {
    let root: String
    let ref: String
}
