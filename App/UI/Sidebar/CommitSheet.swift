import SwiftUI
import AppKit
import ReviewGateCore

/// Localizes the engine's `commit` / `push` refusal codes (docs/M12-COMMIT.md); anything else is shown verbatim.
func commitRefusalText(_ code: String) -> String {
    let parts = code.split(separator: ":", maxSplits: 1).map(String.init)
    let detail = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
    switch parts.first ?? code {
    case "no_project": return String(localized: "Open a project first (⌘O)")
    case "session_running": return String(localized: "Wait until Claude has finished the current turn.")
    case "nothing_to_commit": return String(localized: "No accepted files to commit.")
    case "empty_message": return String(localized: "Enter a commit message.")
    case "git_identity_missing":
        return String(localized: "Git identity is not configured. Set user.name and user.email (git config --global user.name \"…\" / user.email \"…\").")
    case "push_failed": return String(localized: "Committed, but the push failed: \(detail)")
    // §46: the commit concludes an unfinished merge; these are still unmerged, or staged without being accepted.
    case "merge_unresolved": return String(localized: "A merge is in progress — accept these files before committing it: \(detail)")
    case "no_remote": return String(localized: "The repository has no remote to push to.")
    case "nothing_to_push": return String(localized: "Nothing to push: commit first.")
    default: return EngineMessages.refusal(error: code)
    }
}

/// Web URL of a commit for a GitHub-style remote: `git@host:o/r.git` or `https://host/o/r(.git)` →
/// `https://host/o/r/commit/<sha>`; nil when the remote is not a GitHub host (github.com, GitHub Enterprise or the
/// configured PR host) or cannot be parsed.
func commitWebURL(remote: String?, sha: String, ghHost: String) -> URL? {
    guard let remote, !sha.isEmpty else { return nil }
    var host = "", path = ""
    if remote.hasPrefix("git@"), let colon = remote.firstIndex(of: ":") {
        host = String(remote[remote.index(remote.startIndex, offsetBy: 4)..<colon])
        path = String(remote[remote.index(after: colon)...])
    } else if let url = URL(string: remote), let h = url.host, ["https", "http", "ssh"].contains(url.scheme ?? "") {
        host = h
        path = url.path
    } else {
        return nil
    }
    path = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if path.hasSuffix(".git") { path.removeLast(4) }
    guard !host.isEmpty, path.split(separator: "/").count == 2 else { return nil }
    let isGitHub = host == "github.com" || host.lowercased().contains("github") || host == ghHost
    guard isGitHub else { return nil }
    return URL(string: "https://\(host)/\(path)/commit/\(sha)")
}

/// "Commit accepted (N)…": message editor (prefilled with the engine's suggestion), checklist of accepted files,
/// "Push to origin" → `commit{message, paths, push}`. The result lands in the Changes banner (`state.commit.lastCommit`).
/// §53: "나눠서 커밋" turns the ticked files into several commits, down to hunks (`CommitSplitPanel`).
struct CommitSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var message = ""
    @State private var selected: Set<String> = []
    @State private var push = AppSettings.commitPushByDefault()
    @State private var committing = false
    @State private var error: String?
    /// §53: "나눠서 커밋" — and its cards, kept while the sheet is open (back and forth between the modes).
    @State private var split: Bool
    @State private var splitSession: CommitSplitSession?

    /// `splitPreview`: open in "나눠서 커밋" with these files and cards (the screenshot tour).
    init(splitPreview: CommitSplitSession? = nil) {
        _split = State(initialValue: splitPreview != nil)
        _splitSession = State(initialValue: splitPreview)
    }

    /// §32: accepted gitignored mods files are not committable — left out of the list and named under it.
    private var ignoredAccepted: [String] { store.ignoredAcceptedPaths }
    private var accepted: [String] { store.committablePaths }
    private var trimmedMessage: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSubmit: Bool { !trimmedMessage.isEmpty && !selected.isEmpty && !committing && store.canCommit }
    private var commitTitle: LocalizedStringKey { push ? "Commit and push" : "Commit" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Commit accepted changes").font(.headline)
                Spacer()
                Picker("Commit mode", selection: Binding(get: { split }, set: { setSplit($0) })) {
                    Text("Commit at once").tag(false)
                    Text("Commit in parts").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .disabled(committing || splitSession?.isCommitting == true || splitSession?.stopped == true
                          || (!split && selected.isEmpty))
                .help("Commit in parts: several commits from the ticked files, down to hunks")
                .accessibilityIdentifier("Commit mode")
            }
            if split, let splitSession {
                CommitSplitPanel(session: splitSession, push: $push) { dismiss() }
            } else {
                single
            }
        }
        .padding(20)
        .frame(width: split ? 640 : 520)
        .onAppear {
            // What was typed before the sheet closed (Esc, Cancel), else the engine's suggestion.
            if message.isEmpty { message = store.flow.commitMessageDraft ?? store.suggestedCommitMessage }
            if selected.isEmpty { selected = Set(accepted) }
        }
        .onChange(of: message) { _, new in
            store.flow.commitMessageDraft = new.isEmpty || new == store.suggestedCommitMessage ? nil : new
        }
    }

    /// "한 번에 커밋 / 나눠서 커밋". The cards are made from the ticked files (with the message as the first card's) and kept
    /// until the ticked files change.
    private func setSplit(_ on: Bool) {
        if on {
            let paths = accepted.filter { selected.contains($0) }
            if splitSession?.paths != paths { splitSession = CommitSplitSession(paths: paths, message: trimmedMessage) }
        }
        split = on
    }

    /// "Commit at once": the message, the files, push and Commit.
    @ViewBuilder private var single: some View {
        Text("Commits the selected accepted files on \(store.projectInfo?.branch ?? "HEAD"). Pending and rejected files are left alone.")
            .font(.callout).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        TextEditor(text: $message)
            .font(.body.monospaced())
            .frame(minHeight: 110, maxHeight: 180)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
            .accessibilityLabel("Commit message")
            .accessibilityIdentifier("Commit message")
        // wave3 mac-flow (§36.11): Claude drafts the message (read-only); it only fills the field above.
        CommitDraftRow(message: $message, paths: accepted.filter { selected.contains($0) })
        HStack {
            Text("Files (\(selected.count) of \(accepted.count))").font(.subheadline.weight(.medium))
            Spacer()
            Button("All") { selected = Set(accepted) }
                .controlSize(.small)
                .disabled(selected.count == accepted.count)
                .accessibilityIdentifier("Commit select all")
            Button("None") { selected = [] }
                .controlSize(.small)
                .disabled(selected.isEmpty)
                .accessibilityIdentifier("Commit select none")
        }
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(accepted, id: \.self) { path in
                    Toggle(isOn: Binding(
                        get: { selected.contains(path) },
                        set: { if $0 { selected.insert(path) } else { selected.remove(path) } })) {
                        Text(verbatim: path).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                    }
                    .toggleStyle(.checkbox)
                    .accessibilityIdentifier("Commit file \(path)")
                }
                if accepted.isEmpty {
                    Text("No accepted files").font(.callout).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
        .frame(minHeight: 60, maxHeight: 160)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
        .accessibilityIdentifier("Commit files")
        if !ignoredAccepted.isEmpty {
            Label(String(localized: "\(ignoredAccepted.count) gitignored file(s) are not committable: \(ignoredAccepted.joined(separator: ", "))"),
                  systemImage: "nosign")
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(2).truncationMode(.middle)
                .help(ignoredAccepted.joined(separator: "\n"))
                .accessibilityIdentifier("Commit ignored files")
        }
        Toggle("Push to origin", isOn: $push)
            .accessibilityIdentifier("Commit push")
        if store.projectInfo?.remoteURL == nil, push {
            Text("The repository has no remote; the push will fail.")
                .font(.caption).foregroundStyle(.orange)
        }
        if !store.commitIdentity.isComplete {
            Label(commitRefusalText("git_identity_missing"), systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("Commit identity warning")
        }
        if let error {
            Text(verbatim: error).font(.caption).foregroundStyle(.red)
                .textSelection(.enabled)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("Commit error")
        }
        HStack {
            if committing { ProgressView().controlSize(.small) }
            Spacer()
            Button("Cancel", role: .cancel) { dismiss() }
                .keyboardShortcut(.cancelAction)
                .disabled(committing)
            Button(commitTitle, action: commit)
                .buttonStyle(.borderedProminent)
                // ⌘↩, as the other sheets with a TextEditor: Return is a new line in the message.
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSubmit)
                .help(store.commitLockReason.map { Text(verbatim: $0) } ?? Text(verbatim: "⌘↩"))
                .accessibilityLabel("Commit")
                .accessibilityIdentifier("Commit")
        }
        if let reason = store.commitLockReason {
            Text(verbatim: reason)   // why Commit is off now (a turn, its collection, a revert, a failed collection)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .accessibilityIdentifier("Commit locked reason")
        }
    }

    private func commit() {
        guard canSubmit else { return }
        committing = true
        error = nil
        let paths = accepted.filter { selected.contains($0) }
        let text = trimmedMessage
        let pushNow = push
        Task {
            let result = await store.commitAccepted(message: text, paths: paths, push: pushNow)
            committing = false
            if result != nil {
                store.flow.commitMessageDraft = nil   // committed: the next sheet starts from the next suggestion
                dismiss()   // a failed push after a successful commit shows up in the banner ("Push now")
            } else {
                error = store.lastError.map(commitRefusalText) ?? String(localized: "Could not commit")
            }
        }
    }
}
