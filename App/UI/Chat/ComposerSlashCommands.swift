import SwiftUI
import ReviewGateCore

// MARK: b-slash — docs/PROTOCOL.md §56.5: the terminal's built-ins typed in a classic chat open the app's own screens
// (`SlashAppCommand`): /model the HUD's model picker (or sets the model), /resume the chat history, /rewind the rewind sheet
// of the last message, /context and /cost the HUD's popovers, /permissions and /config Settings, /agents the agent panel,
// /memory the applied extensions (CLAUDE.md and memory), /help the keyboard shortcuts, /status a card over the box, /rename
// the tab's rename, /exit closes the chat tab (it stays in the history — ⌘⇧T brings it back). A built-in only the terminal
// has is never sent: the card offers "Continue as Terminal Chat". §67.1: /add-dir <path> adds a directory to the chat
// (`add_dir`), /add-dir alone opens the folder picker first. §70.3: /export [file] and /copy [N] (ComposerExport.swift).

/// A HUD popover a typed built-in opens (the HUD's chip shows it).
enum HUDPopoverRequest: Equatable { case model, context, cost }

/// What the card over the box shows.
enum SlashCard: Equatable {
    case terminalOnly(String)
    case status
}

/// A typed built-in for `ComposerSlashHooks` to run with the window's actions.
struct SlashRequest: Equatable {
    let id = UUID()
    let command: SlashAppCommand
    /// What was typed (§67.1: a refused /add-dir gives it back).
    var draft = ""
}

extension ComposerModel {
    /// §56.5: the draft is a built-in the app answers (or one only a terminal chat has — kept in the box, never sent); false
    /// for anything else, which goes to Claude as before.
    func takeSlashCommand(_ store: AppState) -> Bool {
        guard store.canUseSlashPalette, !store.isTerminalChat,
              let command = SlashAppCommand.parse(draft, entries: store.slashEntries) else { return false }
        closePalette()
        let typed = draft
        if case .terminalOnly = command {} else {
            store.recordSlashUse(inPrompt: draft)
            draft = ""
        }
        slashRequest = SlashRequest(command: command, draft: typed)
        inputFocused = true
        return true
    }
}

/// The card over the box: a built-in only the terminal has, or `/status`.
struct ComposerSlashSlot: View {
    @Environment(AppState.self) private var store
    let composer: ComposerModel

    var body: some View {
        if let card = composer.slashCard {
            HStack(alignment: .top, spacing: 8) {
                switch card {
                case let .terminalOnly(name): terminalOnly(name)
                case .status: status
                }
                Spacer(minLength: 4)
                Button { composer.slashCard = nil } label: { Image(systemName: "xmark").font(.caption2.weight(.semibold)) }
                    .buttonStyle(.icon)
                    .help("Close")
                    .accessibilityLabel(Text("Close"))
            }
            .font(.caption)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
            .transition(.opacity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Composer slash card")
        }
    }

    // MARK: A built-in only the terminal has

    private func terminalOnly(_ name: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal").foregroundStyle(.secondary)
            Text(verbatim: "/\(name) — \(SlashAppCommand.terminalOnlyNotice)")
            continueButton
        }
    }

    /// The chat on screen goes on in a terminal chat; a chat with nothing to continue opens a new terminal chat.
    @ViewBuilder
    private var continueButton: some View {
        let meta = store.shownChatId.flatMap { id in store.sessions.first { $0.id == id } }
        let blocker = meta.map { store.continueAsTerminalBlocker($0) } ?? nil
        if let meta, blocker != ContinueTerminalText.refusal("nothing_to_continue") {
            Button("Continue as Terminal Chat") {
                composer.slashCard = nil
                Task { await store.continueAsTerminalChat(id: meta.id) }
            }
            .controlSize(.small)
            .disabled(blocker != nil)
            .help(blocker ?? String(localized: "This chat's conversation goes on in a terminal chat, where every / command works"))
            .accessibilityIdentifier("Slash continue as terminal chat")
        } else {
            Button("New Terminal Chat") {
                composer.slashCard = nil
                Task { await store.newTerminalChat() }
            }
            .controlSize(.small)
            .disabled(store.newChatBlocker != nil)
            .help(store.newChatBlocker ?? String(localized: "Opens a terminal chat, where every / command works"))
            .accessibilityIdentifier("Slash new terminal chat")
        }
    }

    // MARK: /status

    private var status: some View {
        let chat = store.currentSessionId.flatMap { id in store.sessions.first { $0.id == id } }
        let servers = store.mcp.loaded ? store.mcp.servers.count : (store.capabilities?.mcpServers.count ?? 0)
        let attention = store.mcp.attentionServers.count
        return Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 3) {
            row("Model", store.autoModelChipText ?? store.modelChipText)
            row("Effort", store.effort?.displayName ?? String(localized: "Default"))
            row("Mode", store.permissionMode.displayName)
            row("Chat", chat.map(\.displayTitle) ?? String(localized: "New chat"))
            if let id = store.currentSessionId { row("Session", String(id.prefix(8))) }
            row("MCP", attention > 0 ? String(localized: "\(servers) servers · \(attention) need attention")
                                     : String(localized: "\(servers) servers"))
        }
        .textSelection(.enabled)
    }

    private func row(_ label: LocalizedStringKey, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(verbatim: value).lineLimit(1).truncationMode(.middle)
        }
    }
}

/// Runs a typed built-in with the window's actions (`composer.slashRequest`), and the sheets it opens.
struct ComposerSlashHooks: ViewModifier {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow
    let composer: ComposerModel
    @State private var rewind: TurnCheckpoint?
    @State private var showExtensions = false
    @State private var exportItem: ChatExportItem?   // §70.3

    func body(content: Content) -> some View {
        content
            .onChange(of: composer.slashRequest) { _, request in
                guard let request else { return }
                composer.slashRequest = nil
                run(request)
            }
            .onChange(of: store.draftChatId) { _, _ in composer.slashCard = nil }   // the card was the other chat's
            .sheet(item: $rewind) { RewindSheet(checkpoint: $0) }
            .sheet(isPresented: $showExtensions) { ExtensionsSheet() }
            .sheet(item: $exportItem) { item in
                ChatExportSheet(item: item, done: { composer.infoNotice = $0 }, failed: { composer.notice = $0 })
            }
    }

    private func run(_ request: SlashRequest) {
        composer.slashCard = nil
        switch request.command {
        case let .model(name):
            if name.isEmpty { popover(.model) } else { setModel(name) }
        case .resume: model.showChatHistoryTick += 1
        case .rewind:
            if let last = store.sessionInfo.checkpoints.max(by: { $0.turn < $1.turn }) {
                rewind = last
            } else {
                composer.notice = String(localized: "Nothing to rewind yet — no message has a rewind point")
            }
        case .context: popover(.context)
        case .cost: popover(.cost)
        case .permissions: settings(.general)   // the permissions are in General
        case .config: settings(.general)
        case .agents: model.showAgentPanelTick += 1
        case .memory: showExtensions = true
        case .help: openWindow(id: keyboardShortcutsWindowID)
        case .status: composer.slashCard = .status
        case .rename: model.renameChatTick += 1
        case .exit: closeTab()
        case let .terminalOnly(name): composer.slashCard = .terminalOnly(name)
        case let .addDir(path):   // §67.1
            if path.isEmpty { composer.pickAddDir(store: store) } else { composer.addDir(path, typed: request.draft, store: store) }
        case let .export(file):   // §70.3
            if file.isEmpty { composer.openExport(store: store) { exportItem = ChatExportItem(export: $0) } }
            else { composer.export(to: file, typed: request.draft, store: store) }
        case let .copy(argument):
            composer.copyResponse(argument, typed: request.draft, store: store)
        }
    }

    private func popover(_ request: HUDPopoverRequest) {
        model.hudPopover = request
        model.hudPopoverTick += 1
    }

    private func settings(_ tab: SettingsView.Tab) {
        UserDefaults.standard.set(tab.rawValue, forKey: SettingsView.tabKey)
        openSettings()
    }

    /// `/model <name>`: a model of the list by its value or name, else the name as typed (the CLI's aliases: opus, sonnet …).
    private func setModel(_ name: String) {
        let option = store.availableModels.first {
            $0.value.caseInsensitiveCompare(name) == .orderedSame || $0.displayName.caseInsensitiveCompare(name) == .orderedSame
        }
        if store.modelMode == .auto { AutoModelSettings.apply(.manual, from: store) }   // a model is a manual pick, as in the picker
        Task {
            if let refusal = await store.setModel(option?.value ?? name) { composer.notice = refusal }
        }
    }

    /// `/exit`: as Chat › Close Chat Tab (⌘⇧W) — the chat stays in the history.
    private func closeTab() {
        guard let id = store.shownChatId, store.canCloseTab(id: id) else {
            composer.notice = store.chatSwitchBlocker ?? String(localized: "This tab can't be closed — it is the only chat tab")
            return
        }
        Task { if await store.closeChatTab(id: id) { ClosedChatTabs.remember(id, in: model) } }
    }
}
