import SwiftUI
import AppKit
import ReviewGateCore

/// Client-side mirror of `git check-ref-format --branch`, so hints update as the user types.
/// nil means the name is acceptable.
func branchNameHint(_ raw: String, existing: [BranchInfo]) -> String? {
    let name = raw.trimmingCharacters(in: .whitespaces)
    if name.isEmpty { return String(localized: "Enter a branch name") }
    if existing.contains(where: { $0.name == name }) { return String(localized: "A branch with this name already exists") }
    let badChars: Set<Character> = [" ", "~", "^", ":", "?", "*", "[", "\\"]
    if name.contains(where: { badChars.contains($0) || $0.isWhitespace || ($0.asciiValue ?? 32) < 32 })
        || name.hasPrefix("-") || name.hasPrefix("/") || name.hasSuffix("/") || name.hasSuffix(".")
        || name.hasSuffix(".lock") || name.contains("..") || name.contains("//") || name.contains("@{")
        || name == "@" || name.split(separator: "/").contains(where: { $0.hasPrefix(".") || $0.hasSuffix(".lock") }) {
        return String(localized: "Not a valid branch name")
    }
    return nil
}

/// Folder name the engine derives from a branch (`feature/x` → `feature-x`).
func workbenchSlug(_ branch: String) -> String {
    let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    let slug = String(branch.trimmingCharacters(in: .whitespaces).map { allowed.contains($0) ? $0 : "-" })
    return slug.isEmpty ? "workbench" : slug
}

/// Localizes the engine's `workbench_*` / `pr_create` refusal codes; anything else is shown verbatim.
func workbenchRefusalText(_ code: String) -> String {
    let parts = code.split(separator: ":", maxSplits: 1).map(String.init)
    let detail = parts.count > 1 ? parts[1] : ""
    switch parts.first ?? code {
    case "worktree_locked": return String(localized: "The workbench is in use by another session (pid \(detail)).")
    case "worktree_dirty": return String(localized: "The workbench has uncommitted changes.")
    case "cannot_remove_main": return String(localized: "The main workbench cannot be removed.")
    case "cannot_remove_current": return String(localized: "This window's own workbench cannot be removed from here.")
    case "unknown_worktree": return String(localized: "No such workbench: \(detail)")
    case "invalid_branch_name": return String(localized: "Not a valid branch name: \(detail)")
    case "branch_in_use": return String(localized: "That branch is already checked out in \(detail)")
    case "path_exists": return String(localized: "The folder already exists: \(detail)")
    case "no_project": return String(localized: "Open a project first (⌘O)")
    case "no_remote": return String(localized: "The repository has no remote to push to.")
    case "detached_head": return String(localized: "Check out a branch first (HEAD is detached).")
    case "unsupported_remote": return String(localized: "The origin remote is not a GitHub URL: \(detail)")
    case "fetch_failed": return FlowText.refusal(code: "fetch_failed", detail: detail) ?? code   // wave3 mac-flow (§36.12)
    case "invalid_task": return String(localized: "Describe the task first (at most 100,000 characters).")   // §49
    case "task_handoff_failed": return String(localized: "The workbench was created, but the task could not be handed to it: \(detail)")
    default: return EngineMessages.refusal(error: code)
    }
}

/// "New Workbench…": branch name + base branch → `workbench_create`, then the caller opens the new window. wave3 mac-flow
/// (§36.12 / §36.14): remote bases with "Fetch before creating", the files it copies, the setup command and the folder rule
/// (an engine that knows §36.12), the steps and their log while it creates; "Open as workbench" from the PR tab checks out
/// the PR's head instead of branching from a base.
struct NewWorkbenchSheet: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// The branch the sheet starts with (wave1 mac-session, §33.4: a blocked EnterWorktree's name); "" = empty.
    var initialBranch = ""
    /// Called with the created worktree folder.
    let onCreated: (URL) -> Void
    @State private var branch = ""
    @State private var base = ""
    @State private var creating = false
    @State private var error: String?
    // MARK: wave3 mac-flow
    /// §36.14: the PR whose head the sheet checks out (taken from the window model when the sheet opens).
    @State private var fromPr: PRWorkbenchRequest?
    @State private var fetch = true
    @State private var runSetup = true
    @State private var location: WorkbenchLocation = .managed
    /// `branch_in_use:<path>`: the workbench that has the branch already — offered instead.
    @State private var inUsePath: String?
    /// The steps stay on screen after a refused create (a failed fetch says why).
    @State private var showSteps = false
    /// Observed: an edit of the repository's setup ("편집…") asks for the preview again.
    @AppStorage(AppSettings.Key.projectWorkbenchSetup) private var setupsRaw = Data()
    // MARK: §49 Run as Task — the task (taken from the window model when the sheet opens), its chat's mode, the branch
    // suggested from it until the user types one.
    @State private var runsTask = false
    @State private var task = ""
    /// The text the composer handed over: the composer empties its draft once the task started.
    @State private var handedTask = ""
    @State private var taskMode: PermissionMode = .default
    @State private var branchTyped = false
    @AppStorage(AppSettings.Key.taskBranchPrefix) private var taskPrefix = TaskBranchName.defaultPrefix
    private var trimmedTask: String { task.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// An existing local branch is fine for a PR (the engine checks it out as it is). §49: a task needs its text.
    private var hint: String? {
        if runsTask, trimmedTask.isEmpty { return String(localized: "Describe the task") }
        return branchNameHint(branch, existing: fromPr == nil ? store.branches : [])
    }
    private var trimmedBranch: String { branch.trimmingCharacters(in: .whitespaces) }
    private var supportsSetup: Bool { store.supportsWorkbenchSetup }
    private var isRemoteBase: Bool { fromPr == nil && store.remoteBranches.contains { $0.name == base } }
    private var baseRef: String? { fromPr == nil && !base.isEmpty ? base : nil }

    private var previewRequest: WorkbenchPreviewRequest {
        WorkbenchPreviewRequest(branch: trimmedBranch, from: baseRef, location: location)
    }

    private var pathPreview: String {
        if supportsSetup, let preview = store.flow.preview(for: previewRequest), !preview.path.isEmpty { return preview.path }
        if supportsSetup, location == .sibling, let main = store.workbenches.list.first(where: \.isMain)?.path {
            return WorkbenchPaths.sibling(mainWorktree: main, branch: trimmedBranch)
        }
        let root = store.workbenches.managedRoot.isEmpty ? AppSettings.worktreeRoot() : store.workbenches.managedRoot
        return (root as NSString).appendingPathComponent(workbenchSlug(branch))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if runsTask {
                taskFields
                Text("Branch name").font(.subheadline.weight(.semibold))   // filled in already: the field shows no placeholder
            }
            TextField("Branch name", text: Binding(get: { branch }, set: { branch = $0; branchTyped = true }))
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .disabled(creating)
                .accessibilityIdentifier("New workbench branch")
                .onSubmit(create)
            baseRow
            LabeledContent("Folder") {
                VStack(alignment: .trailing, spacing: 4) {
                    if supportsSetup {
                        Picker("Folder", selection: $location) {
                            Text("Managed folder").tag(WorkbenchLocation.managed)
                            Text("Next to the repository").tag(WorkbenchLocation.sibling)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .fixedSize()
                        .disabled(creating)
                        .accessibilityIdentifier("Workbench location")
                    }
                    Text(verbatim: pathPreview)
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                        .help(pathPreview)
                        .accessibilityIdentifier("Workbench path preview")
                }
            }
            if supportsSetup {
                WorkbenchSetupSection(runSetup: $runSetup, preview: store.flow.preview(for: previewRequest),
                                      isLoadingPreview: store.flow.isLoadingPreview, disabled: creating)
            }
            // The steps an engine that knows §36.12 reports (an older one sends none: the spinner below says it).
            if creating || showSteps, !store.flow.progress.isEmpty || (creating && supportsSetup) {
                WorkbenchProgressView(progress: store.flow.progress, running: creating)
            }
            if let error {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("New workbench error")
                if let inUsePath {
                    Button("Open that workbench") {
                        dismiss()
                        onCreated(URL(fileURLWithPath: inUsePath))
                    }
                    .controlSize(.small)
                    .accessibilityIdentifier("Open the workbench that has the branch")
                }
            } else if let hint {
                Text(hint).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("New workbench hint")
            } else if let fromPr {
                Text("Checks out PR #\(fromPr.number)'s head into a new worktree.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if runsTask {
                Text("Branches from \(base.isEmpty ? "HEAD" : base) into a new worktree; its window sends the task in a fresh chat.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Branches from \(base.isEmpty ? "HEAD" : base) into a new worktree.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if creating { ProgressView().controlSize(.small) }
                Spacer()
                // A create cannot be stopped: closing the sheet leaves it running, and its window opens when it is ready.
                Button(creating ? LocalizedStringKey("Close") : LocalizedStringKey("Cancel"), role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .help(creating ? String(localized: "The workbench is still being prepared; its window opens when it is ready") : "")
                Button(createTitle, action: create)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(hint != nil || creating)
                    .accessibilityIdentifier("Create workbench")
            }
        }
        .padding(20)
        .frame(width: 500)
        .onAppear {
            // §49: "Run as Task" — the composer's text (or none from the menu), this chat's mode.
            if let text = model.newWorkbenchTask {
                runsTask = true
                task = text
                handedTask = text
                taskMode = store.permissionMode
                if branch.isEmpty, initialBranch.isEmpty { branch = TaskBranchName.suggest(text: text, prefix: taskPrefix) }
            }
            // wave3 mac-flow: a PR from the PR tab, the repository's setup defaults.
            if let request = model.newWorkbenchFromPr {
                fromPr = request
                if branch.isEmpty { branch = PRClaude.workbenchBranch(number: request.number, headRef: request.headRef, baseRef: request.baseRef) }
            }
            let setup = store.workbenchSetup
            fetch = setup.fetchBase
            location = setup.location
            if base.isEmpty {
                // Fetching by default: origin/<the main worktree's branch> — where new work starts (origin/develop).
                base = WorkbenchDefaults.base(current: store.projectInfo?.branch ?? store.branches.first(where: \.isCurrent)?.name ?? "",
                                              mainBranch: store.workbenches.list.first(where: \.isMain)?.branch,
                                              remotes: store.remoteBranches.map(\.name),
                                              fetchBase: setup.fetchBase, supportsSetup: supportsSetup)
            }
            if branch.isEmpty { branch = initialBranch }
            if supportsSetup, hint == nil { store.flow.requestPreview(previewRequest, delay: .zero) }
        }
        .onChange(of: previewRequest) { _, request in
            if supportsSetup, hint == nil { store.flow.requestPreview(request) }
        }
        .onChange(of: setupsRaw) { _, _ in
            if supportsSetup, hint == nil { store.flow.requestPreview(previewRequest) }
        }
        .onChange(of: task) { _, text in
            if runsTask, !branchTyped { branch = TaskBranchName.suggest(text: text, prefix: taskPrefix) }
        }
        .onDisappear { model.newWorkbenchFromPr = nil; model.newWorkbenchTask = nil }
    }

    private var createTitle: LocalizedStringKey {
        if runsTask { return "Run as Task" }
        return fromPr == nil ? "Create workbench" : "Open as workbench"
    }

    /// §49: the task — the first message of the new workbench's fresh chat — and the mode that chat starts in.
    @ViewBuilder
    private var taskFields: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Task").font(.subheadline.weight(.semibold))
            TextEditor(text: $task)
                .font(.body)
                .frame(minHeight: 72, maxHeight: 160)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                .disabled(creating)
                .accessibilityIdentifier("Run as Task text")
            Text("A task link, a key such as ABC-123, or what to do — sent as the first message there.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        Picker("Mode", selection: $taskMode) {
            ForEach(PermissionMode.allCases) { mode in
                Text(verbatim: "\(mode.displayName) — \(mode.helpText)").tag(mode)
            }
        }
        .disabled(creating)
        .accessibilityIdentifier("Run as Task mode")
    }

    @ViewBuilder
    private var header: some View {
        if runsTask {
            Text("Run as Task").font(.headline)
            Text("Starts the task in a workbench of its own — a new branch and folder, its own window and a fresh chat — so this chat is left as it is.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else if let fromPr {
            Text("Open PR #\(fromPr.number) as a workbench").font(.headline)
            Text(verbatim: fromPr.title)
                .font(.callout)
                .lineLimit(2)
            Text("Checks out the PR's head in a worktree and opens it in its own window with its own Claude session — to build, test or fix it locally.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text("New Workbench").font(.headline)
            Text("Creates a git worktree on a new branch and opens it in its own window with its own Claude session.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var baseRow: some View {
        if let fromPr {
            LabeledContent("From") {
                Text(verbatim: "PR #\(fromPr.number) · \(fromPr.headRef)")
                    .font(.callout.monospaced())
                    .lineLimit(1).truncationMode(.middle)
            }
            .accessibilityIdentifier("Workbench PR head")
        } else {
            Picker("Base branch", selection: $base) {
                if supportsSetup, !store.remoteBranches.isEmpty {
                    Section("Local") {
                        ForEach(store.branches) { Text(verbatim: $0.name).tag($0.name) }
                    }
                    Section("Remote") {
                        ForEach(store.remoteBranches) { Text(verbatim: $0.name).tag($0.name) }
                    }
                } else {
                    ForEach(store.branches) { Text(verbatim: $0.name).tag($0.name) }
                }
                if store.branches.isEmpty { Text("HEAD").tag("") }
            }
            .disabled(creating)
            .accessibilityIdentifier("Workbench base")
            if supportsSetup, isRemoteBase {
                Toggle("Fetch before creating", isOn: $fetch)
                    .disabled(creating)
                    .help("Runs git fetch for this branch first, so the workbench starts from the remote's latest commit")
                    .accessibilityIdentifier("Workbench fetch")
            }
        }
    }

    private func create() {
        guard hint == nil, !creating else { return }
        let name = trimmedBranch
        creating = true
        error = nil
        inUsePath = nil
        showSteps = true
        let options = WorkbenchCreateOptions(
            fetch: supportsSetup && isRemoteBase ? fetch : nil,
            setup: supportsSetup ? runSetup : nil,
            location: supportsSetup ? location : nil,
            fromPr: fromPr.map { WorkbenchFromPr(number: $0.number, headRef: $0.headRef) },
            task: runsTask ? WorkbenchTask(text: task, mode: taskMode) : nil)   // §49
        let from = baseRef
        let started = runsTask ? handedTask : nil
        Task {
            let url = await store.createWorkbench(branch: name, from: from, options: options)
            creating = false
            if let url {
                // A failed setup does not fail the create: the new window opens and shows the log.
                if store.flow.setupFailed { WorkbenchSetupReports.shared.record(path: url.path, progress: store.flow.progress) }
                if let started {   // §49: the next suggestion starts the way this branch did; the composer lets the text go
                    taskPrefix = TaskBranchName.prefix(of: name)
                    if !started.isEmpty {
                        model.startedTaskText = started
                        model.startedTaskTick &+= 1
                    }
                }
                dismiss()
                onCreated(url)
            } else {
                let code = store.lastError ?? ""
                if code.hasPrefix("branch_in_use:") { inUsePath = String(code.dropFirst("branch_in_use:".count)).trimmingCharacters(in: .whitespaces) }
                error = code.isEmpty ? String(localized: "Could not create the workbench") : workbenchRefusalText(code)
            }
        }
    }
}

/// "Create PR from this branch…" (M10.1): base picker, title, body, draft → `pr_create`; the URL lands in the header banner.
struct CreatePRSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var base = ""
    @State private var title = ""
    @State private var body_ = ""
    @State private var draft = false
    @State private var creating = false
    @State private var error: String?
    // MARK: wave4c w4c-commit — §41.1: the title / body from the branch's commits (until typed), metadata per repository, gh
    @State private var prDraft: PRDraftReply?
    @State private var meta = PRMetaText.default
    @State private var typedTitle = false
    @State private var typedBody = false
    private var ghReason: String? { TeamFormat.ghBlocker(prDraft?.gh, host: prDraft?.host) }

    private var head: String { store.projectInfo?.branch ?? "HEAD" }
    private var bases: [BranchInfo] { store.branches.filter { !$0.isCurrent } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Create PR from \(head)").font(.headline)
            Picker("Base", selection: $base) {
                ForEach(bases) { Text(verbatim: $0.name).tag($0.name) }
                if bases.isEmpty { Text("main").tag("main") }
            }
            .accessibilityIdentifier("PR base")
            TextField("Title", text: Binding(get: { title }, set: { title = $0; typedTitle = true }), prompt: Text(verbatim: head))
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("PR title")
            TextEditor(text: Binding(get: { body_ }, set: { body_ = $0; typedBody = true }))
                .font(.body)
                .frame(minHeight: 100)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                .accessibilityIdentifier("PR body")
            if let prDraft, !prDraft.commits.isEmpty {
                Text("Filled from the \(prDraft.commits.count) commit(s) of this branch since \(prDraft.baseRef ?? base)")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("PR draft source")
            }
            PRMetaFields(meta: $meta)
            Toggle("Draft", isOn: $draft)
                .accessibilityIdentifier("PR draft")
            if let prDraft, !prDraft.hasUpstream {
                Text("\(head) is not on the remote yet — Create PR pushes it first, then runs `gh pr create` against \(base.isEmpty ? "main" : base).")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Pushes \(head) and runs `gh pr create` against \(base.isEmpty ? "main" : base).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let ghReason {
                Label(ghReason, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Create PR gh reason")
            }
            if let error {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
                    .textSelection(.enabled)
                    .lineLimit(4)
                    .accessibilityIdentifier("Create PR error")
            }
            HStack {
                if creating { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create PR", action: create)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)   // ⌘↩: Return is a new line in the body (or ends the title)
                    .disabled(base.isEmpty || creating || ghReason != nil)
                    .help(ghReason ?? "⌘↩")
                    .accessibilityIdentifier("Create PR")
            }
        }
        .padding(20)
        .frame(width: 480)
        .onAppear {
            if base.isEmpty {
                let names = bases.map(\.name)
                base = ["main", "develop", "master"].first { names.contains($0) } ?? names.first ?? "main"
            }
            meta = store.prMeta   // wave4c w4c-commit
        }
        .task(id: base) {   // wave4c w4c-commit — §41.1
            guard let d = await store.loadPRDraft(base: base) else { return }
            prDraft = d
            if !typedTitle { title = d.title }
            if !typedBody { body_ = d.body }
        }
    }

    private func create() {
        guard !base.isEmpty, !creating, ghReason == nil else { return }
        creating = true
        error = nil
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = body_.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let url = await store.createPR(base: base, title: t.isEmpty ? nil : t, body: b.isEmpty ? nil : b, draft: draft, meta: meta.meta)
            creating = false
            if url != nil {
                store.setPRMeta(meta)   // wave4c w4c-commit: the next PR of this repository starts from these
                dismiss()
            } else {
                error = store.lastError.map(workbenchRefusalText) ?? String(localized: "Could not create the pull request")
            }
        }
    }
}
