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
/// r2-review-flow M28: pending files are listed too (after the accepted ones) — ticked, they are accepted as the commit goes
/// ("리뷰 끝냄으로 표시하고 커밋", one action instead of accept → sheet → commit); "push after commit" is kept per project.
struct CommitSheet: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var message = ""
    @State private var selected: Set<String> = []
    @State private var push = AppSettings.commitPushByDefault()
    @State private var committing = false
    @State private var error: String?
    /// §53: "나눠서 커밋" — and its cards, kept while the sheet is open (back and forth between the modes).
    @State private var split: Bool
    @State private var splitSession: CommitSplitSession?
    // MARK: git-sync — §68.5: changed files outside the review, none ticked at first; untracked ones only when asked for.
    @State private var others: [OtherChange] = []
    @State private var othersTruncated = false
    @State private var showUntracked = false
    @State private var extraSelected: Set<String> = []

    /// `splitPreview`: open in "나눠서 커밋" with these files and cards; `showUntracked` / `extraTicked`: the "Other changes"
    /// group with untracked files listed and these ticked (the screenshot tour).
    init(splitPreview: CommitSplitSession? = nil, showUntracked: Bool = false, extraTicked: Set<String> = []) {
        _split = State(initialValue: splitPreview != nil)
        _splitSession = State(initialValue: splitPreview)
        _showUntracked = State(initialValue: showUntracked)
        _extraSelected = State(initialValue: extraTicked)
    }

    /// §32: accepted gitignored mods files are not committable — left out of the list and named under it.
    private var ignoredAccepted: [String] { store.ignoredAcceptedPaths }
    private var accepted: [String] { store.committablePaths }
    /// r2-review-flow M28: the accepted files, then the pending ones (accepted when ticked and committed).
    private var listed: [String] { CommitAcceptRules.listed(committable: accepted, files: store.changedFiles) }
    /// The ticked files that are still pending.
    private var toAccept: [String] { CommitAcceptRules.toAccept(ticked: selected, files: store.changedFiles) }
    private var trimmedMessage: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// §68.5: the ticked files outside the review that are still listed.
    private var extras: [String] { CommitOthersRules.extraPaths(ticked: extraSelected, files: others, showUntracked: showUntracked) }
    private var visibleOthers: [OtherChange] { CommitOthersRules.visible(others, showUntracked: showUntracked) }
    private var untrackedCount: Int { others.filter(\.untracked).count }
    /// §68.8: no review file to list, only changes outside the review (a commit from the branch menu with no review).
    private var othersOnly: Bool { CommitOthersRules.othersOnly(reviewListed: listed.count, others: others.count, truncated: othersTruncated) }
    private var canSubmit: Bool {
        !trimmedMessage.isEmpty && CommitOthersRules.canCommit(reviewTicked: selected.count, extras: extras.count) && !committing
            && store.commitLockReason == nil && (store.canCommit || !toAccept.isEmpty || !extras.isEmpty)
    }
    private var commitTitle: String {
        if !toAccept.isEmpty {
            return push ? String(localized: "Mark Reviewed, Commit and Push") : String(localized: "Mark Reviewed and Commit")
        }
        return push ? String(localized: "Commit and push") : String(localized: "Commit")
    }
    /// The project's key for "push after commit".
    private var projectKey: String? { store.projectURL.map(AppSettings.projectKey) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                // §68.8: with no review file, only the user's own changes — nothing "accepted" to commit.
                if othersOnly { Text("Commit changes").font(.headline) } else { Text("Commit accepted changes").font(.headline) }
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
            // r2-review-flow M28: the accepted files; with none, every pending one (one action: accept and commit).
            if selected.isEmpty { selected = Set(accepted.isEmpty ? listed : accepted) }
            // polish P5-sheets-09: cards left by Esc or Cancel come back as they were, on the same files (still accepted).
            if splitSession == nil, let stash = model.commitSplitStash, !stash.stopped, !stash.paths.isEmpty,
               Set(stash.paths).isSubset(of: Set(accepted)) {
                selected = Set(stash.paths)
                splitSession = stash
                split = true
            }
            if let projectKey { push = AppSettings.commitPush(root: projectKey) }
        }
        .task {   // MARK: git-sync — §68.5: the second group (an older engine: none)
            if let reply = await store.loadOtherChanges() {
                others = reply.files
                othersTruncated = reply.truncated
            }
        }
        .onChange(of: push) { _, on in if let projectKey { AppSettings.setCommitPush(on, root: projectKey) } }
        // polish P5-sheets-09: the split cards are kept for the next opening on the same files; a series that ran is not.
        .onDisappear {
            if let session = splitSession, !session.stopped, session.made.isEmpty, !session.isCommitting {
                model.commitSplitStash = session
            } else if splitSession != nil {
                model.commitSplitStash = nil
            }
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
            // polish P5-sheets-09: the cards of an earlier opening on the same files come back (Esc or Cancel lose nothing).
            if splitSession?.paths != paths {
                if let stash = model.commitSplitStash, stash.paths == paths, !stash.stopped {
                    splitSession = stash
                } else {
                    splitSession = CommitSplitSession(paths: paths, message: trimmedMessage)
                }
            }
        }
        split = on
    }

    /// "Commit at once": the message, the files, push and Commit.
    @ViewBuilder private var single: some View {
        Group {
            if othersOnly {
                Text("Commits the ticked files on \(store.projectInfo?.branch ?? "HEAD") as they are — they are not reviewed and nothing is marked accepted.")
            } else {
                Text("Commits the ticked files on \(store.projectInfo?.branch ?? "HEAD"). A ticked pending file is marked reviewed (accepted) first; rejected files are left alone.")
            }
        }
            .font(.callout).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        TextEditor(text: $message)
            .plainTextInput()   // polish PX-05: no curly quotes or em dashes in the commit message
            .font(.body.monospaced())
            .frame(minHeight: 110, maxHeight: 180)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
            .accessibilityLabel("Commit message")
            .accessibilityIdentifier("Commit message")
        // wave3 mac-flow (§36.11): Claude drafts the message (read-only); it only fills the field above.
        CommitDraftRow(message: $message, paths: listed.filter { selected.contains($0) })
        if !othersOnly {   // §68.8: no empty "No accepted files" box over the user's own changes
        HStack {
            Text("Files (\(selected.count) of \(listed.count))").font(.subheadline.weight(.medium))
            Spacer()
            Button("All") { selected = Set(listed) }
                .controlSize(.small)
                .disabled(selected.count == listed.count)
                .accessibilityIdentifier("Commit select all")
            Button("None") { selected = [] }
                .controlSize(.small)
                .disabled(selected.isEmpty)
                .accessibilityIdentifier("Commit select none")
        }
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(listed, id: \.self) { path in
                    let file = store.changedFiles.first { $0.path == path }
                    Toggle(isOn: Binding(
                        get: { selected.contains(path) },
                        set: { if $0 { selected.insert(path) } else { selected.remove(path) } })) {
                        HStack(spacing: 6) {
                            TruncatedText(path).font(.callout.monospaced())   // polish PX-10: the whole path on hover
                            if file?.state == .pending {
                                // r2-review-flow M28: a pending file — ticked, it is accepted as the commit goes.
                                Text("Pending").font(.caption2.weight(.semibold)).foregroundStyle(.orange)
                                    .help("Not reviewed yet — committing it marks it reviewed (accepted) first")
                            }
                            Spacer(minLength: 4)
                            if let file {
                                Text(verbatim: "+\(file.added)").font(.caption.monospacedDigit()).foregroundStyle(.green)
                                Text(verbatim: "−\(file.deleted)").font(.caption.monospacedDigit()).foregroundStyle(.red)
                            }
                        }
                    }
                    .toggleStyle(.checkbox)
                    // polish P5-sheets-13: the file's menu — its path, Finder, the editor, and its diff in the review.
                    .contextMenu {
                        FilePathMenuItems(path: path, showsDiff: false)
                        Divider()
                        Button("Show in Review", systemImage: "list.bullet.rectangle") {
                            dismiss()
                            store.selectFile(path: path)
                        }
                    }
                    .accessibilityIdentifier("Commit file \(path)")
                }
                if listed.isEmpty {
                    Text("No accepted files").font(.callout).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
        .frame(minHeight: 60, maxHeight: 160)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
        .accessibilityIdentifier("Commit files")
        }
        if !others.isEmpty || othersTruncated {
            otherChangesGroup   // MARK: git-sync (§68.5)
        }
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
            if committing {
                ProgressView().controlSize(.small)
                // polish P5-sheets-15: what it is doing (a push takes a while)
                Text(push ? "Committing and pushing…" : "Committing…").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Cancel", role: .cancel) { dismiss() }
                .keyboardShortcut(.cancelAction)
                .disabled(committing)
            Button(commitTitle, action: commit)
                .buttonStyle(.borderedProminent)
                // ⌘↩, as the other sheets with a TextEditor: Return is a new line in the message.
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSubmit)
                // polish P5-sheets-03: what it does and its key — and why it is off.
                .help(store.commitLockReason.map { Text(verbatim: $0) }
                      ?? (selected.isEmpty && extras.isEmpty ? Text("Tick the files to commit") : trimmedMessage.isEmpty ? Text("Enter a commit message.")
                          : push ? Text("Commit the ticked files and push (⌘↩)") : Text("Commit the ticked files (⌘↩)")))
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

    /// MARK: git-sync — §68.5: "Other changes" — files changed outside the review (the user's own edits, files that were
    /// dirty before the turn), none ticked; committed as they are, never reviewed or marked accepted.
    @ViewBuilder private var otherChangesGroup: some View {
        HStack {
            Text("Other changes (\(extras.count) of \(visibleOthers.count))").font(.subheadline.weight(.medium))
                .help("Files changed outside the review — your own edits, or files changed before Claude's turn. Ticked, they go into this commit as they are: they are not reviewed and nothing is marked accepted.")
            Spacer()
            if untrackedCount > 0 {
                Toggle(isOn: $showUntracked) { Text("Untracked (\(untrackedCount))") }
                    .toggleStyle(.checkbox)
                    .controlSize(.small)
                    .help("Also list new files git does not track yet")
                    .accessibilityIdentifier("Commit show untracked")
            }
        }
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(visibleOthers) { file in
                    Toggle(isOn: Binding(
                        get: { extraSelected.contains(file.path) },
                        set: { if $0 { extraSelected.insert(file.path) } else { extraSelected.remove(file.path) } })) {
                        HStack(spacing: 6) {
                            Text(verbatim: file.untracked ? "U" : file.status)
                                .font(.caption.monospaced().weight(.semibold)).foregroundStyle(.secondary)
                                .frame(width: 14)
                                .help(file.untracked ? String(localized: "Untracked — a new file git does not track yet") : String(localized: "Changed outside the review"))
                            TruncatedText(file.oldPath.map { "\($0) → \(file.path)" } ?? file.path).font(.callout.monospaced())
                            if file.hidden {
                                Text("Hidden from the review").font(.caption2).foregroundStyle(.secondary)
                                    .help("An ignore pattern in Settings hides this file from the review; it can still be committed")
                            }
                        }
                    }
                    .toggleStyle(.checkbox)
                    .contextMenu { FilePathMenuItems(path: file.path, showsDiff: false) }
                    .accessibilityIdentifier("Commit other \(file.path)")
                }
                if visibleOthers.isEmpty {
                    Text("No tracked changes outside the review").font(.callout).foregroundStyle(.secondary)
                }
                if othersTruncated {
                    Text("Only the first 500 files are listed").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
        .frame(minHeight: 40, maxHeight: othersOnly ? 220 : 120)   // alone in the sheet: the room the review's list leaves
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
        .accessibilityIdentifier("Commit other changes")
    }

    private func commit() {
        guard canSubmit else { return }
        committing = true
        error = nil
        let paths = listed.filter { selected.contains($0) }
        let accepting = toAccept
        let text = trimmedMessage
        let pushNow = push
        let extraPaths = extras   // §68.5: committed along, never accepted
        Task {
            // r2-review-flow M28: the ticked pending files are accepted first (the engine commits accepted files only).
            guard await store.acceptForCommit(accepting) else {
                committing = false
                error = store.lastError.map(commitRefusalText) ?? String(localized: "Could not commit")
                return
            }
            let result = await store.commitAccepted(message: text, paths: paths, push: pushNow, extraPaths: extraPaths)
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
