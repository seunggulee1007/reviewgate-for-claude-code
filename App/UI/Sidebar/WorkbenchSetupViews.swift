import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave3 mac-flow
// docs/PROTOCOL.md §36.12 / §36.14 on the Mac: what the New Workbench sheet shows before and while it creates — the files it
// copies ("%d files will be copied", the list), the setup command, the folder rule, the steps and their log — the
// repository's "Workbench setup" editor, and the banner a new window shows when its setup failed (the window still opens).

/// §36.14: "Open as workbench" from the PR tab — the sheet checks out the PR's head instead of branching from a base.
struct PRWorkbenchRequest: Equatable {
    let number: Int
    let headRef: String
    let baseRef: String
    let title: String
}

enum WorkbenchPaths {
    /// The engine's `sibling` folder: `<parent of the main worktree>/<repo>-<branch tail>` (`feature/acme/4790` →
    /// `acme-4790`). Shown until `workbench_preview` answers.
    static func sibling(mainWorktree: String, branch: String) -> String {
        let main = URL(fileURLWithPath: mainWorktree)
        let tail = branch.split(separator: "/").last.map(String.init) ?? branch
        return main.deletingLastPathComponent().appendingPathComponent("\(main.lastPathComponent)-\(workbenchSlug(tail))").path
    }
}

/// The copy / setup part of the New Workbench sheet (an engine that knows §36.12).
struct WorkbenchSetupSection: View {
    @Environment(AppState.self) private var store
    @Binding var runSetup: Bool
    /// The preview of the branch / base / folder the sheet shows now.
    let preview: WorkbenchPreviewReply?
    let isLoadingPreview: Bool
    let disabled: Bool
    @State private var showFiles = false
    @State private var showEditor = false
    /// Observed so an edit in the popover / Settings shows here at once.
    @AppStorage(AppSettings.Key.projectWorkbenchSetup) private var setupsRaw = Data()

    var body: some View {
        let setup = { _ = setupsRaw; return store.workbenchSetup }()
        VStack(alignment: .leading, spacing: 8) {
            filesRow(setup)
            setupRow(setup)
            if setup.command != nil || (preview?.copy.isEmpty == false) {
                Toggle("Copy the files and run the setup command after creating", isOn: $runSetup)
                    .disabled(disabled)
                    .accessibilityIdentifier("Workbench run setup")
            }
        }
    }

    @ViewBuilder
    private func filesRow(_ setup: WorkbenchSetup) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "doc.on.doc").foregroundStyle(.secondary)
                if let preview {
                    if preview.copy.isEmpty {
                        Text("No files to copy").foregroundStyle(.secondary)
                    } else {
                        Button {
                            withAnimation(.easeInOut(duration: 0.15)) { showFiles.toggle() }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: showFiles ? "chevron.down" : "chevron.right").font(.caption2.weight(.semibold))
                                Text("\(preview.count) files will be copied")
                                Text(verbatim: "· " + FlowText.bytes(preview.totalBytes)).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("Workbench copy count")
                    }
                } else if isLoadingPreview {
                    ProgressView().controlSize(.mini)
                    Text("Files to copy").foregroundStyle(.secondary)
                } else {
                    Text("Files to copy").foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                Button("Edit…") { showEditor = true }
                    .controlSize(.small)
                    .help("Workbench setup")
                    .accessibilityIdentifier("Edit workbench setup")
                    .popover(isPresented: $showEditor, arrowEdge: .trailing) {
                        ScrollView { WorkbenchSetupEditor().padding(14) }
                            .frame(width: 420, height: 420)
                    }
            }
            .font(.callout)
            if showFiles, let preview, !preview.copy.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(preview.copy) { item in
                            HStack {
                                Text(verbatim: item.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 8)
                                Text(verbatim: FlowText.bytes(item.bytes)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        if preview.truncated {
                            Text("…and more (the first \(preview.copy.count) are listed)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                .accessibilityIdentifier("Workbench copy list")
            }
            if preview == nil, !isLoadingPreview, let error = store.flow.previewError {
                Text(verbatim: error).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Workbench preview error")
            }
            if preview?.copy.isEmpty == true {
                Text(setup.copy.isEmpty && setup.useWorktreeInclude
                     ? String(localized: "Untracked or ignored files (mvnw, local config…) are copied when they match the patterns of Workbench setup or .worktreeinclude.")
                     : String(localized: "Nothing in this worktree matches the patterns of Workbench setup."))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func setupRow(_ setup: WorkbenchSetup) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "terminal").foregroundStyle(.secondary)
            Text("Setup command").foregroundStyle(.secondary)
            if let command = setup.command {
                Text(verbatim: command)
                    .font(.callout.monospaced())
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
                    .help(command)
                    .accessibilityIdentifier("Workbench setup command")
            } else {
                Text("None").foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }
}

/// The steps of a create (`workbench_progress`) and the log of the latest one that printed something.
struct WorkbenchProgressView: View {
    @Environment(\.colorScheme) private var colorScheme
    let progress: [WorkbenchProgress]
    /// The create is still running (the latest step without an exit is shown as running).
    let running: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(shownSteps, id: \.self) { step in
                HStack(spacing: 6) {
                    stateIcon(step).frame(width: 14)
                    Text(title(step)).font(.callout)
                    if let exit = progress.first(where: { $0.step == step })?.exit, exit != .none {
                        Text(verbatim: exitText(exit)).font(.caption.monospacedDigit()).foregroundStyle(exit.failed ? .red : .secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("Workbench step \(step.rawValue)")
            }
            if let log = latestLog {
                ScrollView {
                    Text(verbatim: log)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                }
                .defaultScrollAnchor(.bottom)
                .frame(maxHeight: 150)
                .background(Color.secondary.wash(colorScheme, light: 0.06, dark: 0.14), in: RoundedRectangle(cornerRadius: 6))
                .accessibilityIdentifier("Workbench step log")
            }
        }
    }

    /// The steps that happened, and while running the ones still ahead (a skipped fetch / copy / setup is left out).
    private var shownSteps: [WorkbenchStep] {
        guard let latest = progress.last?.step else { return running ? [.create] : [] }
        let happened = Set(progress.map(\.step))
        return WorkbenchStep.allCases.filter { happened.contains($0) || (running && $0 > latest) }
    }

    private var latestLog: String? {
        progress.reversed().compactMap { $0.logTail?.trimmingCharacters(in: .newlines) }.first { !$0.isEmpty }
    }

    @ViewBuilder
    private func stateIcon(_ step: WorkbenchStep) -> some View {
        if let event = progress.first(where: { $0.step == step }) {
            if event.exit.failed {
                Image(systemName: step == .fetch ? "exclamationmark.triangle.fill" : "xmark.circle.fill")
                    .foregroundStyle(step == .fetch ? Color.orange : Color.red)
            } else if running, step == progress.last?.step, step != .done, event.exit == .none {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
        } else {
            Image(systemName: "circle").foregroundStyle(.secondary)
        }
    }

    private func title(_ step: WorkbenchStep) -> LocalizedStringKey {
        switch step {
        case .fetch: "Fetch the base"
        case .create: "Create the worktree"
        case .copy: "Copy the files"
        case .setup: "Setup command"
        case .done: "Ready"
        }
    }

    private func exitText(_ exit: WorkbenchExit) -> String {
        switch exit {
        case .none: ""
        case let .code(code): String(localized: "exit \(code)")
        case .killed: String(localized: "stopped (10 min limit)")
        }
    }
}

/// The repository's "Workbench setup" (the sheet's popover and Settings › Project): saved as edited, given to the engine
/// when the editor closes (and before every preview / create).
struct WorkbenchSetupEditor: View {
    @Environment(AppState.self) private var store
    var showsTitle = true
    @State private var setup = WorkbenchSetup.default
    @State private var patterns = ""
    @State private var loadedRoot: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsTitle {
                Text("Workbench setup").font(.headline)
            }
            Text("Files to copy").font(.subheadline.weight(.semibold))
            TextEditor(text: $patterns)
                .font(.body.monospaced())
                .frame(minHeight: 60, maxHeight: 110)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                .accessibilityLabel("Files to copy")
                .accessibilityIdentifier("Workbench copy patterns")
            Text("One pattern per line (mvnw, .mvn/**, config/local/*.yml). Only untracked or ignored files of this worktree are copied — never a tracked file or .git.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Also copy what .worktreeinclude lists", isOn: $setup.useWorktreeInclude)
                .accessibilityIdentifier("Workbench use worktreeinclude")
            Text("Setup command").font(.subheadline.weight(.semibold))
            TextField("Setup command", text: $setup.setupCommand, prompt: Text(verbatim: "./mvnw -q -o compile"))
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .accessibilityIdentifier("Workbench setup command field")
            Text("Runs in the new workbench through your login shell when you create one (at most 10 minutes) — never when a window opens and never by Claude. A failure still opens the window with the log.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Fetch before creating", isOn: $setup.fetchBase)
                .accessibilityIdentifier("Workbench fetch default")
            Picker("Folder", selection: $setup.location) {
                Text("Managed folder").tag(WorkbenchLocation.managed)
                Text("Next to the repository").tag(WorkbenchLocation.sibling)
            }
            .accessibilityIdentifier("Workbench location default")
            Text("Next to the repository: <parent folder>/<repo>-<last part of the branch>, e.g. acme-4790 for feature/acme/4790.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .disabled(store.flowSettingsRoot == nil)
        .onAppear(perform: load)
        .onChange(of: store.flowSettingsRoot) { _, _ in load() }
        .onChange(of: setup) { _, _ in save() }
        .onChange(of: patterns) { _, _ in save() }
        .onDisappear { store.pushFlowSettings() }
    }

    private func load() {
        loadedRoot = store.flowSettingsRoot
        setup = store.workbenchSetup
        patterns = setup.copy.joined(separator: "\n")
    }

    private func save() {
        guard loadedRoot != nil, loadedRoot == store.flowSettingsRoot else { return }
        var next = setup
        next.copy = patterns.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard next != store.workbenchSetup else { return }
        store.setWorkbenchSetup(next)
    }
}

// MARK: - A failed setup, shown in the new window

/// What a create's setup printed when it failed, kept until the new window shows it (one entry per worktree folder).
@MainActor
@Observable
final class WorkbenchSetupReports {
    static let shared = WorkbenchSetupReports()

    struct Report: Equatable {
        let branch: String
        let exit: WorkbenchExit
        let log: String
    }

    private(set) var reports: [String: Report] = [:]

    /// Keeps the setup's failure for the window of `path` (the steps of the create that just replied).
    func record(path: String, progress: [WorkbenchProgress]) {
        guard let setup = progress.last(where: { $0.step == .setup }) ?? progress.last(where: { $0.step == .done }), setup.exit.failed else { return }
        let log = progress.reversed().compactMap(\.logTail).first { !$0.isEmpty } ?? ""
        reports[AppSettings.projectKey(URL(fileURLWithPath: path))] = Report(branch: setup.branch, exit: setup.exit, log: log)
    }

    func report(for url: URL?) -> Report? { url.flatMap { reports[AppSettings.projectKey($0)] } }

    func dismiss(_ url: URL?) {
        guard let url else { return }
        reports[AppSettings.projectKey(url)] = nil
    }
}

/// The banner of a window whose workbench was just created and whose setup failed: the exit and the log.
struct WorkbenchSetupReportBanner: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @State private var reports = WorkbenchSetupReports.shared
    @State private var showLog = true

    var body: some View {
        if let report = reports.report(for: store.projectURL) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(headline(report)).font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if !report.log.isEmpty {
                        Button(showLog ? LocalizedStringKey("Hide log") : LocalizedStringKey("Show log")) { showLog.toggle() }
                            .controlSize(.small)
                            .accessibilityIdentifier("Workbench setup log toggle")
                    }
                    Button { reports.dismiss(store.projectURL) } label: { Image(systemName: "xmark") }
                        .buttonStyle(IconButtonStyle(padding: 2))
                        .controlSize(.small)
                        .help("Dismiss")
                        .accessibilityLabel("Dismiss")
                }
                if showLog, !report.log.isEmpty {
                    ScrollView {
                        Text(verbatim: report.log)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(6)
                    }
                    .defaultScrollAnchor(.bottom)
                    .frame(maxHeight: 160)
                    .background(Color.secondary.wash(colorScheme, light: 0.06, dark: 0.14), in: RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Workbench setup failed banner")
            Divider()
        }
    }

    private func headline(_ report: WorkbenchSetupReports.Report) -> String {
        switch report.exit {
        case .killed:
            return String(localized: "The setup command of this workbench was stopped after 10 minutes. The workbench is ready otherwise.")
        case let .code(code):
            return String(localized: "The setup command of this workbench failed (exit \(code)). The workbench is ready otherwise — fix it in a terminal.")
        case .none:
            return String(localized: "The setup command of this workbench failed. The workbench is ready otherwise — fix it in a terminal.")
        }
    }
}

/// A project in /tmp or /var/folders: macOS deletes the files there it has not seen opened for a few days — `.git`
/// included — and then every send fails with "not a git repository". Said once per window until closed.
struct TransientProjectBanner: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @State private var dismissedPath: String?

    var body: some View {
        if let path = store.projectURL?.path, RecentProjects.isTransient(path), dismissedPath != path {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("This project is in a temporary folder. macOS deletes the files there that were not opened for a few days — .git included — and then messages can no longer be sent. Move it to another folder (git worktree move for a worktree).")
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button { dismissedPath = path } label: { Image(systemName: "xmark") }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .controlSize(.small)
                    .help("Dismiss")
                    .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Transient project banner")
            Divider()
        }
    }
}
