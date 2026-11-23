import SwiftUI
import ReviewGateCore

/// docs/PROTOCOL.md §9 "New Chat in a Workbench" (워크벤치에서 새 대화): the way out of a new chat that waits for Claude. One
/// field — the branch, `wb/<yyMMdd-HHmm>` until edited — and [만들기] (Return): `workbench_create` from this worktree's HEAD
/// with the repository's usual setup (§36.12), then the caller opens its window, whose first chat is of the default kind (a
/// chat when a held message comes along: it waits in that composer, never sent). The held switch here is called off.
struct WorkbenchChatSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// Called with the created worktree folder.
    let onCreated: (URL) -> Void
    @State private var branch = ""
    @State private var creating = false
    @State private var error: String?
    /// `branch_in_use:<path>`: the workbench that has the branch already — offered instead.
    @State private var inUsePath: String?

    private var hint: String? { branchNameHint(branch, existing: store.branches) }
    private var trimmedBranch: String { branch.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New Chat in a Workbench").font(.headline)
            Text("Claude works in one folder one turn at a time. A workbench is a folder of its own — a new branch from HEAD, its own window and Claude — so its chat starts now.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("Branch name", text: $branch)
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .disabled(creating)
                .accessibilityIdentifier("Workbench chat branch")
                .onSubmit(create)
            if creating, !store.flow.progress.isEmpty {
                WorkbenchProgressView(progress: store.flow.progress, running: creating)
            }
            if let error {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Workbench chat error")
                if let inUsePath {
                    Button("Open that workbench") {
                        dismiss()
                        onCreated(URL(fileURLWithPath: inUsePath))
                    }
                    .controlSize(.small)
                    .accessibilityIdentifier("Workbench chat open existing")
                }
            } else if let hint {
                Text(hint).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("Workbench chat hint")
            } else if store.heldMessagesForWorkbench != nil {
                Text("Your waiting message moves to the new chat's message box there — it is not sent.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Workbench chat held message")
            } else {
                Text("Branches from HEAD into a new worktree and opens it in its own window with a new chat.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if creating { ProgressView().controlSize(.small) }
                Spacer()
                // A create cannot be stopped: closing the sheet leaves it running, and its window opens when it is ready.
                Button(creating ? LocalizedStringKey("Close") : LocalizedStringKey("Cancel"), role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .help(creating ? String(localized: "The workbench is still being prepared; its window opens when it is ready") : "")
                Button("Create", action: create)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(hint != nil || creating)
                    .help(hint ?? (creating ? String(localized: "The workbench is being created") : "↩"))
                    .accessibilityIdentifier("Workbench chat create")
            }
        }
        .padding(20)
        .frame(width: 440)
        .onAppear { if branch.isEmpty { branch = store.suggestedWorkbenchChatBranch() } }
    }

    private func create() {
        guard hint == nil, !creating else { return }
        let name = trimmedBranch
        creating = true
        error = nil
        inUsePath = nil
        Task {
            let url = await store.createWorkbench(branch: name)
            creating = false
            if let url {
                // A failed setup does not fail the create: the new window opens and shows the log.
                if store.flow.setupFailed { WorkbenchSetupReports.shared.record(path: url.path, progress: store.flow.progress) }
                store.handHeldSwitchToWorkbench(url)   // before the window opens: its first chat depends on it
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
