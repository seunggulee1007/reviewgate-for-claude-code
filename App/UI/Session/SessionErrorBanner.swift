import SwiftUI
import AppKit
import ReviewGateCore

/// The window's error / notice banner (audit 4.2; PROTOCOL §30, §33.4): blue for a notice (a resume that fell back to a
/// new chat), orange for something stopped or a non-fatal failure, red for a fatal one. One line says what happened —
/// with ×N when it repeated — a gray second line the CLI's own words and exit code, and the buttons what to do next.
struct SessionErrorBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    let banner: ErrorBanner
    @State private var showDetail = false
    @State private var copied = false

    private var tint: Color {
        switch banner.style {
        case .info: .blue
        case .warning: .orange
        case .error: .red
        }
    }

    private var icon: String {
        switch banner.style {
        case .info: "info.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .error: "xmark.octagon.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .padding(.top, 1)
                .accessibilityLabel(styleLabel)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if banner.style != .info {
                        Text(scopeTitle)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(tint.wash(colorScheme, light: 0.18, dark: 0.26), in: Capsule())
                            .help(scopeHelp)   // polish P1-chrome-29: what the chip means
                            .accessibilityIdentifier("Error banner scope")
                    }
                    Text(verbatim: banner.message)
                        .font(.callout)
                        .lineLimit(3).truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("Error banner text")
                    if banner.repeatCount > 1 {
                        Text(verbatim: "×\(banner.repeatCount)")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(tint.wash(colorScheme, light: 0.18, dark: 0.30), in: Capsule())
                            .help("The same error came \(banner.repeatCount) times in a row")
                            .accessibilityLabel(Text("Repeated \(banner.repeatCount) times"))
                            .accessibilityIdentifier("Error banner repeat")
                    }
                }
                if let secondary = banner.secondary {
                    if banner.style == .info {
                        // A notice: the CLI's words are there for whoever wants them, folded.
                        DisclosureGroup(isExpanded: $showDetail) {
                            detailText(secondary)
                        } label: {
                            Text("Details").font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("Error banner details")
                    } else {
                        detailText(secondary)
                    }
                }
            }
            Spacer(minLength: 4)
            ForEach(banner.actions, id: \.self) { action in
                actionButton(action)
            }
            if banner.reopenProject != nil {
                Button("Reopen") { Task { await store.reopenAfterEngineFailure() } }
                    .controlSize(.small)
                    .help("Start the engine again and reopen the project")
                    .accessibilityIdentifier("Reopen project")
            }
            logMenu
            // polish P1-chrome-29: the whole error for a bug report — the message, the CLI's words, the code, ×N.
            Button { Clipboard.copy(copyText, toast: String(localized: "Copied")) } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.icon)
                .help("Copy the error")
                .accessibilityLabel(Text("Copy the error"))
                .accessibilityIdentifier("Copy error from banner")
            Button("Dismiss") { store.dismissErrorBanner() }
                .controlSize(.small)
                .accessibilityIdentifier("Dismiss error banner")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(tint.wash(colorScheme, light: 0.10, dark: 0.18))
        .contextMenu {
            Button("Copy Error", systemImage: "doc.on.doc") { Clipboard.copy(copyText, toast: String(localized: "Copied")) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Error banner")
    }

    /// What "오류 복사" puts on the clipboard: the message (×N), the CLI's words and the code.
    private var copyText: String {
        var lines = [banner.message + (banner.repeatCount > 1 ? " ×\(banner.repeatCount)" : "")]
        if let secondary = banner.secondary, !secondary.isEmpty { lines.append(secondary) }
        if let code = banner.code { lines.append("code: \(code)") }
        return lines.joined(separator: "\n")
    }

    private func detailText(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(2).truncationMode(.middle)
            .textSelection(.enabled)
            .help(text)
            .accessibilityIdentifier("Error banner detail")
    }

    // MARK: Actions

    /// §19.6 / §30 / §33.4: what the code offers — new chat, retry / reconnect, the previous chat, the workbench, …
    @ViewBuilder
    private func actionButton(_ action: EngineMessageAction) -> some View {
        switch action {
        case .login:
            Button("Log in…") { store.openClaudeLogin() }
                .controlSize(.small)
                .help("Opens Terminal with `claude /login`; send your message again once the login completes")
                .accessibilityIdentifier("Claude login")
        case .restartSession:
            Button(restartTitle) { store.restartSessionFromBanner() }
                .controlSize(.small)
                .disabled(!store.canRestartSession)
                .help(restartHelp)
                .accessibilityIdentifier("Restart session from banner")
        case .openSettings:
            Button("Settings…") { openSettings() }
                .controlSize(.small)
                .accessibilityIdentifier("Open settings from banner")
        case .mcpLogin:
            Button("Log in…") {
                let server = store.mcp.authRequiredServer ?? ""
                Task { await store.mcp.login(server) }
            }
            .controlSize(.small)
            .disabled((store.mcp.authRequiredServer ?? "").isEmpty)
            .help("Opens Terminal with claude /mcp, where you log in to the server")
            .accessibilityIdentifier("MCP login from banner")
        case .newChat:
            Button(banner.code == "session_start_failed" ? String(localized: "Start a new chat") : String(localized: "New chat")) {
                store.startNewChat()
            }
            .controlSize(.small)
            .disabled(store.newChatBlocker != nil)   // r2-chats-cards M31 (§9): while Claude works it waits for the turn
            .help(store.newChatBlocker ?? String(localized: "Continue in a fresh chat; this one stays in the history"))
            .accessibilityIdentifier("New chat from banner")
        case .showPreviousChat:
            Button("Show previous chat") {
                model.highlightChatId = banner.sessionId
                model.showChatHistoryTick += 1
            }
            .controlSize(.small)
            .help("Opens the chat list with the chat that could not be continued")
            .accessibilityIdentifier("Show previous chat")
        case .openLogs:
            Button("Open Log") { LogActions.openLogFolder() }
                .controlSize(.small)
                .help(LogActions.folderHelp)
                .accessibilityIdentifier("Open log folder from banner")
        case .openWorkbench:
            Button("Open as Workbench") { openAsWorkbench() }
                .controlSize(.small)
                .disabled(store.projectInfo == nil)
                .help(banner.code == "worktree_blocked"
                      ? String(localized: "Creates a workbench on that branch — its own window, its own review")
                      : String(localized: "Opens that workbench in its own window, where its changes are reviewed"))
                .accessibilityIdentifier("Open as workbench from banner")
        case .openFolder:
            Button("Open Folder") { openFolder() }
                .controlSize(.small)
                .disabled(banner.path == nil)
                .help(banner.path ?? "")
                .accessibilityIdentifier("Open folder from banner")
        // MARK: wave4b w4b-follow (§39.4)
        case .moveChat:
            Button(ChatMoveText.moveTitle) {
                if let path = banner.path { ChatMoveActions.move(store: store, to: path) }
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(banner.path == nil || store.chatMoveBlocker != nil)
            .help(store.chatMoveBlocker ?? ChatMoveText.moveHelp)
            .accessibilityIdentifier("Move chat from banner")
        // MARK: wave4 w4-longwork (§38.2)
        case .continueWork:
            Button(LongWorkText.continueTitle) {
                store.continueWork()
                store.dismissErrorBanner()
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(store.projectInfo == nil || !store.state.session.open)
            .help(LongWorkText.continueHelp)
            .accessibilityIdentifier("Continue from banner")
        case .resumeAfterLimit:
            Toggle(LongWorkText.resumeTitle, isOn: Binding(get: { store.longWork.resumeArmed },
                                                          set: { $0 ? store.armLimitResume() : store.cancelLimitResume() }))
                .toggleStyle(.checkbox)
                .controlSize(.small)
                .disabled(!store.canArmLimitResume && !store.longWork.resumeArmed)
                .help(store.canArmLimitResume || store.longWork.resumeArmed ? LongWorkText.resumeHelp
                      : String(localized: "The reset time is not known, so it cannot continue by itself"))
                .accessibilityIdentifier("Continue when the limit resets")
        }
    }

    /// "다시 시도" after a start failure (the same arguments again), "다시 연결" after a crash (the chat resumes).
    private var restartTitle: String {
        switch banner.code {
        case "session_start_failed": String(localized: "Try again")
        case "session_crashed": String(localized: "Reconnect chat")
        default: String(localized: "Restart session")
        }
    }

    private var restartHelp: String {
        switch banner.code {
        case "session_start_failed": String(localized: "Starts Claude Code again with the same settings")
        default: String(localized: "Reconnects this chat")
        }
    }

    /// §33.4: a blocked EnterWorktree → the new-workbench sheet with its branch (base = the current branch); work that
    /// ran in a worktree → that workbench's window.
    private func openAsWorkbench() {
        if banner.code == "worktree_blocked" || banner.path == nil {
            model.newWorkbenchBranch = banner.branch ?? ""
            model.showNewWorkbench = true
        } else if let path = banner.path {
            ProjectOpener.openInNewWindow(URL(fileURLWithPath: path), openWindow: openWindow)
        }
    }

    private func openFolder() {
        guard let path = banner.path else { return }
        ProjectOpener.openInNewWindow(URL(fileURLWithPath: path), openWindow: openWindow)
    }

    // MARK: Log

    /// "Show log" (the chat pane's sidecar log) with the log folder and "Copy Diagnostics" behind its arrow.
    private var logMenu: some View {
        Menu {
            Button("Open Log Folder") { LogActions.openLogFolder() }
                .accessibilityIdentifier("Open log folder")
            Button("Copy Diagnostics") {
                LogActions.copyDiagnostics(store: store)
                copied = true
            }
            .accessibilityIdentifier("Copy diagnostics")
        } label: {
            Text(copied ? String(localized: "Copied") : String(localized: "Show log"))
        } primaryAction: {
            model.showSidecarLog = true
        }
        .menuStyle(.button)
        .controlSize(.small)
        .fixedSize()
        .help("Show the log here; the arrow opens the log folder or copies diagnostics for a bug report")
        .accessibilityIdentifier("Show log")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    // MARK: Words

    private var scopeTitle: String {
        switch banner.scope {
        case .engine: String(localized: "Engine")
        case .session: String(localized: "Session")
        case .git: String(localized: "Git")
        case .pr: String(localized: "PR")
        }
    }

    /// polish P1-chrome-29: the scope chip's meaning.
    private var scopeHelp: String {
        switch banner.scope {
        case .engine: String(localized: "The app's engine")
        case .session: String(localized: "The Claude Code session")
        case .git: String(localized: "A git command")
        case .pr: String(localized: "GitHub (gh)")
        }
    }

    private var styleLabel: String {
        switch banner.style {
        case .info: String(localized: "Notice")
        case .warning: String(localized: "Warning")
        case .error: String(localized: "Error")
        }
    }
}
