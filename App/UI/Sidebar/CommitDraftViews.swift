import SwiftUI
import ReviewGateCore

// MARK: wave3 mac-flow
// docs/PROTOCOL.md §36.11 on the Mac: "Write with Claude" in the commit sheet (a read-only fork drafts the message in the
// project's format from the accepted diff and the recent commit subjects; the result only fills the field — the user
// commits) and the repository's "Commit message template".

/// The row under the commit sheet's message: "Write with Claude", its progress, a failure in one line, "Restore my message"
/// after a draft replaced what was typed, and the template.
struct CommitDraftRow: View {
    @Environment(AppState.self) private var store
    @Binding var message: String
    /// The files the commit would hold (the sheet's ticked accepted files).
    let paths: [String]
    /// What the last draft replaced (non-empty), until restored or edited.
    @State private var replaced: String?
    @State private var drafted: String?
    @State private var showTemplate = false
    /// Observed so the template's first line follows an edit in the popover / Settings.
    @AppStorage(AppSettings.Key.projectCommitTemplate) private var templatesRaw = Data()
    /// MARK: wave4c w4c-commit — §41.1: the format learned from the recent subjects (nil on an older engine).
    @State private var format: CommitFormatReply?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button(action: draft) {
                    Label("Write with Claude", systemImage: "sparkles")
                }
                .controlSize(.small)
                .disabled(blocker != nil || store.flow.isDraftingCommit)
                .help(blocker ?? String(localized: "Claude drafts the message in this repository's format from the accepted diff and the last commit subjects — in a read-only side session; the main chat is untouched and nothing is committed"))
                .accessibilityIdentifier("Write commit message with Claude")
                if store.flow.isDraftingCommit {
                    ProgressView().controlSize(.small)
                    Text("Writing…").font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("Commit draft progress")
                } else if replaced != nil {
                    Button("Restore my message") {
                        if let replaced { message = replaced }
                        replaced = nil
                        drafted = nil
                    }
                    .buttonStyle(.link)
                    .controlSize(.small)
                    .accessibilityIdentifier("Restore commit message")
                }
                Spacer(minLength: 4)
                templateButton
            }
            if let line = reasonLine {
                Label(line, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(line)
                    .accessibilityIdentifier("Commit draft error")
            }
            TeamFormatLineView(template: { _ = templatesRaw; return store.commitTemplate }(), reply: format) { showTemplate = true }
        }
        .task(id: store.projectInfo?.branch) { format = await store.loadCommitFormat() }   // wave4c w4c-commit
        .onChange(of: message) { _, new in
            if let drafted, new != drafted { replaced = nil; self.drafted = nil }   // edited: nothing to restore
        }
        // The draft lands here when it finishes — also in a sheet opened again while Claude was writing it.
        .onChange(of: store.flow.finishedCommitDraft, initial: true) { _, _ in
            if let text = store.flow.takeFinishedCommitDraft() { fill(text) }
        }
        .onAppear { store.flow.clearCommitDraftError() }   // a failure of an earlier sheet is not this one's
    }

    /// The repository's template: an icon button (the rendered first line next to it when one is set).
    private var templateButton: some View {
        let template = { _ = templatesRaw; return store.commitTemplate }()
        return Button { showTemplate = true } label: {
            HStack(spacing: 4) {
                Image(systemName: "text.badge.checkmark")
                if !template.isEmpty {
                    Text(verbatim: firstLine(CommitTemplate.render(template, branch: store.projectInfo?.branch)))
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 150, alignment: .leading)
                }
            }
        }
        .controlSize(.small)
        .help("Commit message template")
        .accessibilityLabel("Commit message template")
        .accessibilityIdentifier("Commit message template")
        .popover(isPresented: $showTemplate, arrowEdge: .bottom) {
            CommitTemplateEditor()
                .padding(14)
                .frame(width: 400)
        }
    }

    /// Why the button is off, or why the last draft failed (one line, never hidden).
    private var reasonLine: String? {
        if !store.flow.commitDraftSupported { return FlowText.updateReason }
        if store.flow.isDraftingCommit { return nil }
        return store.flow.commitDraftError
    }

    private var blocker: String? {
        if !store.flow.commitDraftSupported { return FlowText.updateReason }
        if paths.isEmpty { return String(localized: "Tick at least one accepted file") }
        return nil
    }

    private func firstLine(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? text
    }

    private func draft() {
        guard blocker == nil, !store.flow.isDraftingCommit else { return }
        let paths = paths
        Task { _ = await store.flow.draftCommitMessage(paths: paths) }   // the result comes back as `finishedCommitDraft`
    }

    /// A finished draft replaces the field; what it replaced can be restored until the field is edited.
    private func fill(_ text: String) {
        let current = message.trimmingCharacters(in: .whitespacesAndNewlines)
        replaced = current.isEmpty || current == text ? nil : message
        drafted = text
        message = text
    }
}

/// The repository's commit message template (the commit sheet's popover and Settings › Project): saved as typed, given to the
/// engine when editing ends and before every draft.
struct CommitTemplateEditor: View {
    @Environment(AppState.self) private var store
    var showsTitle = true
    @State private var text = ""
    @State private var loadedRoot: String?
    @State private var format: CommitFormatReply?   // MARK: wave4c w4c-commit — §41.1

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsTitle {
                Text("Commit message template").font(.headline)
            }
            TextEditor(text: $text)
                .font(.body.monospaced())
                .frame(minHeight: 54, maxHeight: 110)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                .accessibilityLabel("Commit message template")
                .accessibilityIdentifier("Commit message template editor")
            LearnedFormatRow(template: text, reply: format) { text = $0 }   // wave4c w4c-commit (§41.1)
            Text("Claude writes the message in this format. {issue} = the issue number in the branch name (feature/PAY-1800-2 → 1800), {branch} = the branch; Claude fills {title} and {summary}. Empty: Claude follows the format of the recent commits.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let branch = store.projectInfo?.branch {
                LabeledContent {
                    Text(verbatim: CommitTemplate.render(text, branch: branch))
                        .font(.caption.monospaced())
                        .lineLimit(3)
                        .textSelection(.enabled)
                } label: {
                    Text("On \(branch)").font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("Commit template preview")
            }
        }
        .disabled(store.flowSettingsRoot == nil)
        .onAppear(perform: load)
        .task(id: store.flowSettingsRoot) { format = await store.loadCommitFormat() }   // wave4c w4c-commit
        .onChange(of: store.flowSettingsRoot) { _, _ in load() }
        .onChange(of: text) { _, new in
            guard loadedRoot != nil, loadedRoot == store.flowSettingsRoot else { return }
            store.setCommitTemplate(new)
        }
        .onDisappear { store.pushFlowSettings() }
    }

    private func load() {
        loadedRoot = store.flowSettingsRoot
        text = store.commitTemplate
    }
}
