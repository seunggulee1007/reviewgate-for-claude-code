import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.9 on the Mac: the sidebar's "이 저장소의 다른 Claude 세션" (name, folder, 작업 중 / 입력 대기 / 쉬는 중 —
// refreshed every 30 s while the window is in front), the "CLI 세션 가져오기" sheet (a terminal conversation becomes a new
// chat; the review gate applies from then on), "터미널에서 이어가기" (copies cd <folder> && claude --resume <id>) and the note an
// imported chat starts with. Hidden with an engine before §36 (it refuses cli_sessions).

/// The window's sheets and alerts of the session tools (one modifier keeps `MainWindow`'s chain short).
struct SessionToolsModals: ViewModifier {
    @Environment(WindowModel.self) private var model

    func body(content: Content) -> some View {
        @Bindable var model = model
        content
            .sheet(isPresented: $model.showCliImport) { CliSessionImportSheet() }
    }
}

// MARK: - Sidebar section

/// "Other Claude sessions in this repository" at the bottom of the Changes sidebar.
struct OtherSessionsSection: View {
    static let expandedKey = "otherClaudeSessionsExpanded"

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.controlActiveState) private var activeState
    @Environment(\.openWindow) private var openWindow
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @AppStorage(OtherSessionsSection.expandedKey) private var expanded = true

    private struct RefreshKey: Equatable {
        var root: String?
        var engine: Bool
        var frontmost: Bool
    }

    var body: some View {
        if store.projectInfo != nil, store.sessionTools.sessionsSupported {
            VStack(alignment: .leading, spacing: 0) {
                Divider()
                header
                if expanded {
                    rows
                    PeerSelfLine() // MARK: wave4d w4d-peers — §42.2
                    footer
                }
            }
            .task(id: RefreshKey(root: store.projectInfo?.root, engine: store.isEngineRunning, frontmost: activeState == .key)) {
                // Only while this window is in front: the registry is read every 30 s, and once when it comes back.
                guard activeState == .key, store.projectInfo != nil, store.isEngineRunning else { return }
                while !Task.isCancelled {
                    await store.sessionTools.refreshSessions()
                    try? await Task.sleep(for: .seconds(30))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Other Claude sessions")
        }
    }

    private var header: some View {
        let sessions = store.otherClaudeSessions
        return Button {
            withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .foregroundStyle(.secondary)
                Text("Other Claude sessions in this repository")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if !sessions.isEmpty {
                    Text(verbatim: String(sessions.count))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.secondary.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
                }
                if sessions.contains(where: { $0.status == .waiting }) {
                    Circle().fill(Color.orange).frame(width: 6, height: 6)
                        .help("A session is waiting for input")
                        .accessibilityLabel("A session is waiting for input")
                }
                Spacer(minLength: 4)
                if store.sessionTools.isLoadingSessions {
                    ProgressView().controlSize(.mini)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .help("Claude Code sessions running in this repository and its worktrees — terminals, other apps")
        .accessibilityLabel("Other Claude sessions in this repository")
        .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
        .accessibilityIdentifier("Other Claude sessions header")
    }

    @ViewBuilder
    private var rows: some View {
        let sessions = store.otherClaudeSessions
        if sessions.isEmpty {
            Text(store.sessionTools.sessionsLoaded ? "No other Claude session is running here" : "Looking for other sessions…")
                .font(.caption).foregroundStyle(.secondary)
                .padding(.horizontal, 12).padding(.bottom, 6)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(sessions) { session in row(session) }
                }
                .padding(.horizontal, 6)
            }
            .frame(maxHeight: min(CGFloat(sessions.count) * 38 + 4, 168))
        }
        if let error = store.sessionTools.sessionsError {
            Label(error, systemImage: "exclamationmark.triangle")
                .font(.caption2).foregroundStyle(.orange)
                .lineLimit(2)
                .padding(.horizontal, 12).padding(.bottom, 4)
        }
    }

    private func row(_ session: CliRunningSession) -> some View {
        let roots = store.sessionFolderRoots
        let title = CliSessionText.title(session, worktrees: roots)
        let folder = CliSessionText.folder(session.cwd, worktrees: roots)
        let status = CliSessionText.status(session.status)
        let second = [status, session.name == nil ? nil : folder].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return HStack(spacing: 7) {
            Circle().fill(statusColor(session.status)).frame(width: 7, height: 7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(verbatim: title).font(.callout).lineLimit(1).truncationMode(.middle)
                    if session.sameWorktree {
                        TagChip("this folder", tint: .orange)
                            .help("Runs in this window's folder: its edits can mix into this window's review")
                    }
                    if !session.isTerminal {
                        TagChip(Text(verbatim: session.entrypoint ?? ""), tint: .secondary)
                            .help("Not a terminal: an app or a script runs it")
                    }
                }
                if !second.isEmpty {
                    Text(verbatim: second).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6).padding(.vertical, 3)
        .contentShape(Rectangle())
        .help(rowHelp(session))
        .contextMenu { rowActions(session) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([title, status, folder].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("Other session \(session.pid)")
    }

    @ViewBuilder
    private func rowActions(_ session: CliRunningSession) -> some View {
        if let id = session.sessionId {
            Button("Copy Session ID") { copy(id) }
        }
        Button("Copy Folder Path") { copy(session.cwd) }
            .disabled(session.cwd.isEmpty)
        Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: session.cwd)]) }
            .disabled(session.cwd.isEmpty)
        if let worktree = otherWorktree(of: session) {
            Divider()
            Button("Open in New Window") { ProjectOpener.openInNewWindow(URL(fileURLWithPath: worktree), openWindow: openWindow) }
                .help(worktree)
        }
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Button {
                model.showCliImport = true
            } label: {
                Label("Import a CLI session…", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("Continue a conversation from Claude in the terminal as a new chat here")
            .accessibilityIdentifier("Import CLI session")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 8)
    }

    private func statusColor(_ status: CliSessionStatus) -> Color {
        switch status {
        case .busy: .green
        case .waiting: .orange
        case .idle: .secondary
        case .unknown: .secondary.opacity(0.5)
        }
    }

    private func rowHelp(_ session: CliRunningSession) -> String {
        var lines = [SessionNotices.abbreviatingHome(session.cwd)]
        if let id = session.sessionId { lines.append(String(localized: "Session \(id)")) }
        lines.append(String(localized: "Process \(String(session.pid))"))
        return lines.joined(separator: "\n")
    }

    /// The worktree (of this repository) the session runs in, when it is not this window's.
    private func otherWorktree(of session: CliRunningSession) -> String? {
        guard !session.sameWorktree, !session.cwd.isEmpty else { return nil }
        let cwd: String = URL(fileURLWithPath: session.cwd).standardizedFileURL.path
        let roots: [String] = store.workbenches.list.map { URL(fileURLWithPath: $0.path).standardizedFileURL.path }
        let containing: [String] = roots.filter { root in cwd == root || cwd.hasPrefix(root + "/") }
        guard let worktree = containing.max(by: { $0.count < $1.count }) else { return nil }
        return worktree == store.projectURL?.standardizedFileURL.path ? nil : worktree
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

// MARK: - Import sheet

/// "Import a CLI session": the terminal conversations of this repository (newest first) — one becomes a new chat of this
/// window, resumed by the engine; from then on every turn goes through the review gate.
struct CliSessionImportSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String?
    @State private var error: String?
    @State private var copiedId: String?

    private var selected: CliResumableSession? { store.sessionTools.resumable.first { $0.sessionId == selection } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Import a CLI session").font(.headline)
                Spacer()
                if store.sessionTools.isLoadingSessions {
                    ProgressView().controlSize(.small)
                }
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await store.sessionTools.refreshSessions(force: true) }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(IconButtonStyle(padding: 2))
                .disabled(store.sessionTools.isLoadingSessions || !store.sessionTools.sessionsSupported)
                .help("Look for terminal conversations again")
                .accessibilityIdentifier("Refresh CLI sessions")
            }
            Text("Continue a conversation from Claude in the terminal as a new chat in this window. Its messages stay in the terminal's record; Claude remembers them.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            gateNote
            list
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("CLI import error")
            }
            HStack(spacing: 8) {
                if let reason = store.cliImportBlockedReason {
                    Text(verbatim: reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                } else if let copiedId, copiedId == selection {
                    Label("Copied — paste it in Terminal", systemImage: "checkmark")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Continue in terminal") { if let selected { copyResume(selected) } }
                    .disabled(selected == nil)
                    .help(selected.map(resumeCommand) ?? String(localized: "Select a conversation first"))
                    .accessibilityIdentifier("CLI session continue in terminal")
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Import") { if let selected { importNow(selected) } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(selected == nil || store.cliImportBlockedReason != nil || store.sessionTools.importingSessionId != nil)
                    .accessibilityIdentifier("CLI session import")
            }
        }
        .padding(20)
        .frame(width: 580, height: 500)
        .task { await store.sessionTools.refreshSessions(force: true) }
        .accessibilityIdentifier("Import a CLI session")
    }

    private var gateNote: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "checkmark.shield.fill").foregroundStyle(.green)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("The review gate applies from here on").font(.callout.weight(.semibold))
                Text("What the terminal session already changed is the starting point, not a review. Every permission ReviewGate asks still comes.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.wash(colorScheme, light: 0.08, dark: 0.15), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private var list: some View {
        let sessions = store.sessionTools.resumable
        if !store.sessionTools.sessionsSupported {
            unavailable(SessionToolsSupport.updateReason)
        } else if sessions.isEmpty {
            unavailable(store.sessionTools.sessionsLoaded ? String(localized: "No terminal conversation of this repository to import")
                                                         : String(localized: "Looking for terminal conversations…"))
        } else {
            List(sessions, selection: $selection) { session in
                row(session)
                    .tag(session.sessionId)
                    .contextMenu {
                        Button("Import") { importNow(session) }
                            .disabled(store.cliImportBlockedReason != nil || store.sessionTools.importingSessionId != nil)
                        Button("Continue in terminal") { copyResume(session) }
                        Button("Copy Session ID") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(session.sessionId, forType: .string)
                        }
                    }
            }
            .listStyle(.bordered)
            .frame(maxHeight: .infinity)
            .accessibilityIdentifier("CLI sessions list")
        }
    }

    private func row(_ session: CliResumableSession) -> some View {
        let folder = session.cwd.map { CliSessionText.folder($0, worktrees: store.sessionFolderRoots) }
        let when = session.updatedDate.map(relative)
        return HStack(spacing: 8) {
            if store.sessionTools.importingSessionId == session.sessionId {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "terminal").foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: session.title.isEmpty ? String(localized: "Untitled conversation") : session.title)
                    .font(.callout).lineLimit(1)
                Text(verbatim: [folder, when].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .help(session.cwd.map { SessionNotices.abbreviatingHome($0) } ?? session.sessionId)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("CLI session \(session.sessionId)")
    }

    private func unavailable(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.callout).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.secondary.wash(colorScheme, light: 0.05, dark: 0.10), in: RoundedRectangle(cornerRadius: 8))
    }

    private func importNow(_ session: CliResumableSession) {
        error = nil
        Task {
            if let refusal = await store.sessionTools.importSession(session.sessionId) { error = refusal } else { dismiss() }
        }
    }

    private func resumeCommand(_ session: CliResumableSession) -> String {
        CliSessionText.resumeCommand(folder: session.cwd ?? store.projectInfo?.path ?? "", sessionId: session.sessionId)
    }

    private func copyResume(_ session: CliResumableSession) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(resumeCommand(session), forType: .string)
        selection = session.sessionId
        copiedId = session.sessionId
    }

    private func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Continue in terminal (this window's chats)

/// What "Continue in terminal" copied, for the confirmation that says how to avoid two processes on one conversation.
struct ContinueInTerminalRequest: Identifiable, Equatable {
    let command: String
    /// The chat open in this window (its Claude process is on that conversation now).
    let isCurrent: Bool
    var id: String { command }
}

enum ContinueInTerminal {
    /// Copies `cd <folder> && claude --resume <id>` for `meta`; nil when Claude Code has no record of it yet.
    @MainActor
    static func copy(_ meta: SessionMeta, store: AppState) -> ContinueInTerminalRequest? {
        guard let command = store.continueInTerminalCommand(for: meta) else { return nil }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        return ContinueInTerminalRequest(command: command, isCurrent: meta.id == store.currentSessionId)
    }

    /// Why the item is off.
    static func unavailableReason(_ meta: SessionMeta) -> String {
        meta.resumeFailed ? String(localized: "Claude Code has no record of this chat any more")
                          : String(localized: "Send a message first — Claude Code has no record of this chat yet")
    }
}

/// The menu item; `onCopied` receives what was copied (the caller shows the confirmation).
struct ContinueInTerminalMenuItem: View {
    @Environment(AppState.self) private var store
    let meta: SessionMeta
    let onCopied: (ContinueInTerminalRequest) -> Void

    var body: some View {
        let available = store.continueInTerminalCommand(for: meta) != nil
        Button("Continue in terminal") {
            if let request = ContinueInTerminal.copy(meta, store: store) { onCopied(request) }
        }
        .disabled(!available)
        .help(available ? String(localized: "Copy a command that resumes this chat in Terminal") : ContinueInTerminal.unavailableReason(meta))
        .accessibilityIdentifier("Continue in terminal")
    }
}

extension View {
    /// "Command copied" with the command and how to keep one process per conversation; the current chat can be left for a
    /// new one right there.
    func continueInTerminalAlert(_ request: Binding<ContinueInTerminalRequest?>, store: AppState) -> some View {
        alert("Command copied", isPresented: Binding(get: { request.wrappedValue != nil }, set: { if !$0 { request.wrappedValue = nil } }),
              presenting: request.wrappedValue) { copied in
            if copied.isCurrent {
                Button("Start a new chat here") { store.startNewChat() }
                    .disabled(store.chatSwitchBlocker != nil)
                    .accessibilityIdentifier("Continue in terminal new chat")
            }
            Button("OK", role: .cancel) {}
        } message: { copied in
            Text(verbatim: copied.command + "\n\n" + (copied.isCurrent
                ? String(localized: "Paste it in Terminal. This chat is open here too: start a new chat in ReviewGate first — two Claude processes on one conversation would corrupt it.")
                : String(localized: "Paste it in Terminal. Don't open this chat in ReviewGate while it runs there — two Claude processes on one conversation would corrupt it.")))
        }
    }
}

// MARK: - Imported chat

/// At the top of a chat imported from a terminal session: what it is and that the review gate applies from here on.
struct ImportedChatNote: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        if let imported = store.currentImportedSession {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "terminal").foregroundStyle(.green)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("The review gate applies from here on").font(.callout.weight(.semibold))
                    Text(verbatim: detail(imported))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.green.wash(colorScheme, light: 0.08, dark: 0.15), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("Imported chat note")
        }
    }

    private func detail(_ imported: ImportedSession) -> String {
        let when = imported.date.map { $0.formatted(date: .abbreviated, time: .shortened) }
        let from = imported.cwd.map { SessionNotices.abbreviatingHome($0) }
        switch (from, when) {
        case let (from?, when?):
            return String(localized: "Imported from a terminal session in \(from) on \(when). Its earlier messages stay in the terminal's record — Claude remembers them; what it changed before is the starting point, not a review.")
        default:
            return String(localized: "Imported from a terminal session. Its earlier messages stay in the terminal's record — Claude remembers them; what it changed before is the starting point, not a review.")
        }
    }
}
