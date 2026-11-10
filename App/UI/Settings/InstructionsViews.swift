import AppKit
import SwiftUI
import ReviewGateCore

// MARK: wave4d w4d-config — docs/PROTOCOL.md §42.3: Claude's instructions in "Applied extensions": the project's CLAUDE.md
// (edited here, the diff confirmed before saving), the memory files the CLI loaded with what each is and when Claude reads
// it, the subagents — each opened in the system's default app. Files in the home folder are only opened, never edited here.

/// Opens a Markdown file in the system's default app (`InstructionText.canOpen` keeps it to `.md` files that exist).
@MainActor
enum InstructionFileOpener {
    static func open(_ path: String) {
        guard InstructionText.canOpen(path) else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }
}

/// The "CLAUDE.md and memory" and "Subagents" sections of `AppliedExtensionsView`.
struct InstructionsSection: View {
    @Environment(AppState.self) private var store
    let applied: SessionExtensions
    var compact = false
    /// The file the editor sheet is open for.
    @State private var editing: EditTarget?

    struct EditTarget: Identifiable {
        var id: String { path }
        let path: String
        let kind: InstructionKind
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 12 : 16) {
            instructionsSection
            if let agents = applied.agents { agentsSection(agents) }
        }
        .sheet(item: $editing) { target in
            ClaudeMdEditorSheet(path: target.path, kind: target.kind)
        }
    }

    // MARK: CLAUDE.md and memory

    private var instructionsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("CLAUDE.md and memory").font(.subheadline.weight(.semibold))
            HStack(spacing: 14) {
                presence("User (~/.claude)", applied.claudeMd.user)
                presence("Project", applied.claudeMd.project)
            }
            Text(applied.claudeMd.source == "cli" ? "Reported by Claude Code" : "Based on the files present")
                .font(.caption).foregroundStyle(.secondary)
            if let files = applied.projectInstructions {
                ForEach(files) { file in projectFileRow(file) }
            }
            if let files = applied.memoryFiles?.filter({ m in !(applied.projectInstructions ?? []).contains { $0.path == m.path } }), !files.isEmpty {
                ForEach(Array(files.enumerated()), id: \.offset) { _, file in memoryRow(file) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Instructions section")
    }

    private func projectFileRow(_ file: ProjectInstructionFile) -> some View {
        let kind = InstructionKind(lenient: file.kind)
        return row(name: file.relPath, kind: kind, tokens: nil, help: file.path) {
            // The composer's popover only opens files: a sheet over a popover is cut off — Settings › Extensions edits them.
            if !compact {
                Button(file.exists ? "Edit…" : "Create…") { editing = EditTarget(path: file.relPath, kind: kind) }
                    .controlSize(.small)
                    .help(file.exists ? String(localized: "Edit it here; you see the change before it is saved") : String(localized: "Create it here; you see it before it is saved"))
                    .accessibilityIdentifier("Edit \(file.relPath)")
            }
            openButton(file.exists ? file.path : nil, missing: String(localized: "The file does not exist yet"))
        }
    }

    private func memoryRow(_ file: MemoryFile) -> some View {
        let kind = InstructionKind(lenient: file.kind)
        return row(name: McpOriginText.abbreviate(file.path), kind: file.kind == nil ? nil : kind, tokens: file.tokens, help: file.path, type: file.type) {
            if file.editable == true, !compact {
                Button("Edit…") { editing = EditTarget(path: file.path, kind: kind) }
                    .controlSize(.small)
                    .accessibilityIdentifier("Edit \(file.path)")
            }
            openButton(file.path, missing: String(localized: "Only Markdown files that exist can be opened"))
        }
    }

    private func row(name: String, kind: InstructionKind?, tokens: Int?, help: String, type: String? = nil, @ViewBuilder actions: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(verbatim: name).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                if let kind {
                    TagChip(Text(verbatim: InstructionText.title(kind)), tint: kind == .project || kind == .local ? .blue : .secondary)
                } else if let type {
                    Text(verbatim: type).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if let tokens {
                    Text("\(tokens) tokens").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
                actions()
            }
            if let kind {
                Text(verbatim: InstructionText.whenRead(kind))
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .help(help)
        .accessibilityElement(children: .contain)
    }

    private func openButton(_ path: String?, missing: String) -> some View {
        let can = InstructionText.canOpen(path)
        return Button {
            if let path { InstructionFileOpener.open(path) }
        } label: {
            Image(systemName: "arrow.up.forward.app")
        }
        .buttonStyle(IconButtonStyle(padding: 2))
        .controlSize(.small)
        .disabled(!can)
        .help(can ? String(localized: "Opens in the default app") : missing)
        .accessibilityLabel(Text("Open in Editor"))
    }

    private func presence(_ title: LocalizedStringKey, _ present: Bool) -> some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: present ? "checkmark.circle.fill" : "minus.circle").foregroundStyle(present ? Color.green : Color.secondary)
        }
        .font(.callout)
    }

    // MARK: Subagents

    private func agentsSection(_ agents: [SubagentInfo]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("Subagents").font(.subheadline.weight(.semibold))
                Text(verbatim: "\(agents.count)")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 5).padding(.vertical, 0.5)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
            }
            Text("Claude can hand work to these; a file's change applies from the next session.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if agents.isEmpty {
                Text("none").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(agents.prefix(compact ? 12 : 200)) { agent in
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(verbatim: agent.name).font(.callout.monospaced().weight(.medium)).lineLimit(1).truncationMode(.middle)
                        TagChip(Text(verbatim: InstructionText.agentSource(agent.source)), tint: agent.source == "project" ? .blue : .secondary)
                        if let model = agent.model {
                            Text(verbatim: model).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        if agent.path != nil {
                            openButton(agent.path, missing: String(localized: "Only Markdown files that exist can be opened"))
                        }
                    }
                    if !agent.description.isEmpty {
                        Text(verbatim: agent.description)
                            .font(.caption).foregroundStyle(.secondary)
                            .lineLimit(2)
                            .help(agent.description)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("Subagent \(agent.name)")
            }
        }
    }
}

/// Edit a project CLAUDE.md: the text, then its diff to confirm, then saved (over what was read — the engine refuses a
/// file that changed meanwhile, one in the open review and a save while Claude works).
struct ClaudeMdEditorSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    let path: String
    let kind: InstructionKind
    @State private var editor: InstructionEditor?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Group {
                    if editor?.phase == .confirming || editor?.phase == .saving {
                        Text("Check the change")
                    } else {
                        Text("Edit \(kind == .local ? "CLAUDE.local.md" : "CLAUDE.md")")
                    }
                }
                .font(.headline)
                Text(verbatim: editor?.displayPath ?? path).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                Text(verbatim: InstructionText.whenRead(kind)).font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 10)
            Divider()
            content
            Divider()
            footer.padding(14)
        }
        .frame(width: 640, height: 560)
        .task {
            if editor == nil {
                let e = InstructionEditor(app: store, path: path)
                editor = e
                await e.load()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let editor {
            switch editor.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .editing:
                TextEditor(text: Binding(get: { editor.text }, set: { editor.text = $0 }))
                    .font(.body.monospaced())
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .accessibilityIdentifier("CLAUDE.md text")
            case .confirming, .saving:
                diffView(editor)
            case .saved:
                VStack(spacing: 10) {
                    Label("Saved", systemImage: "checkmark.circle.fill").font(.title3).foregroundStyle(.green)
                    Text(verbatim: InstructionText.appliesNextSession)
                        .font(.callout).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed:
                VStack(spacing: 10) {
                    Label(editor.errorText ?? String(localized: "Could not read the file"), systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Retry") { Task { await editor.load() } }
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func diffView(_ editor: InstructionEditor) -> some View {
        let lines = editor.diff
        let counts = InstructionDiff.counts(lines)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(verbatim: "+\(counts.added)").foregroundStyle(.green)
                Text(verbatim: "−\(counts.removed)").foregroundStyle(.red)
                Text("Saved only after you confirm").foregroundStyle(.secondary)
            }
            .font(.caption.monospacedDigit())
            .padding(.horizontal, 14).padding(.vertical, 6)
            if let error = editor.errorText {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(verbatim: error).font(.caption).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if editor.stale {
                        Button("Reload") { Task { await editor.load() } }.controlSize(.small)
                    }
                }
                .padding(8)
                .background(Color.orange.wash(colorScheme, light: 0.08, dark: 0.14), in: RoundedRectangle(cornerRadius: 6))
                .padding(.horizontal, 12)
                .accessibilityIdentifier("CLAUDE.md save error")
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines) { line in diffRow(line) }
                }
                .padding(.vertical, 4)
            }
            .accessibilityIdentifier("CLAUDE.md diff")
        }
    }

    private func diffRow(_ line: InstructionDiffLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: line.kind == .add ? "+" : line.kind == .del ? "−" : " ")
                .foregroundStyle(line.kind == .add ? Color.green : line.kind == .del ? Color.red : Color.secondary)
                .frame(width: 12)
            if line.kind == .hunkHeader {
                Text("\(line.folded) unchanged lines").foregroundStyle(.secondary).italic()
            } else {
                Text(verbatim: line.text.isEmpty ? " " : line.text).foregroundStyle(line.kind == .context ? Color.secondary : Color.primary)
            }
            Spacer(minLength: 0)
        }
        .font(.caption.monospaced())
        .padding(.horizontal, 14).padding(.vertical, 1)
        .background(rowTint(line.kind))
    }

    private func rowTint(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .add: Color.green.wash(colorScheme, light: 0.10, dark: 0.16)
        case .del: Color.red.wash(colorScheme, light: 0.10, dark: 0.16)
        default: Color.clear
        }
    }

    @ViewBuilder
    private var footer: some View {
        HStack {
            if editor?.phase == .editing {
                Label("Files in your home folder open in an editor; only this project's files are edited here.", systemImage: "info.circle")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            switch editor?.phase {
            case .editing:
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Review Changes…") { editor?.confirm() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!(editor?.hasChanges ?? false))
                    .help(editor?.hasChanges == true ? String(localized: "See the change before it is saved") : String(localized: "Nothing changed yet"))
                    .accessibilityIdentifier("CLAUDE.md review")
            case .confirming, .saving:
                Button("Back to Editing") { editor?.backToEditing() }
                    .disabled(editor?.phase == .saving)
                Button {
                    Task { await editor?.save() }
                } label: {
                    if editor?.phase == .saving { ProgressView().controlSize(.small) } else { Text("Save") }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(editor?.phase == .saving || store.isRunning)
                .help(store.isRunning ? String(localized: "Claude is working — save once the turn has ended") : String(localized: "Save the file"))
                .accessibilityIdentifier("CLAUDE.md save")
            case .saved:
                Button("Restart now") {
                    store.restartSession()
                    dismiss()
                }
                .disabled(!store.canRestartSession || store.isRunning)
                .help(store.isRunning ? String(localized: "Claude is working — wait for the turn to finish") : String(localized: "Restart the Claude session now"))
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            default:
                Button("Close", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
    }
}
