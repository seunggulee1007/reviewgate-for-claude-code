import SwiftUI
import ReviewGateCore

// docs/PROTOCOL.md §55.11 — the panes that used to be one long General tab. Each row's title, ⓘ and "when it applies"
// badge come from Core `SettingsCatalog` (`SettingLabel`); `.settingAnchor` is where search jumps. Every key is the one
// General used.

// MARK: - General

/// Appearance, typing and the chat, closing and quitting, notifications, updates.
struct GeneralSettingsPane: View {
    @AppStorage(AppSettings.Key.appearance) private var appearance = Appearance.system.rawValue
    /// M19: reopen last session's project windows on launch.
    @AppStorage(AppSettings.Key.reopenLastProjects) private var reopenLastProjects = true
    // MARK: wave4 w4-safety
    @AppStorage(AppSettings.Key.confirmQuit) private var confirmQuit = true   // polish P1-chrome-01: closing the last window / ⌘Q asks
    @AppStorage(AppSettings.Key.confirmCloseWhileWorking) private var confirmCloseWhileWorking = true
    @AppStorage(ExploreFold.detailDefaultsKey) private var showExploreDetail = false   // MARK: wave4b w4b-tabs (§39.2)
    @AppStorage(AppSettings.Key.returnSends) private var returnSends = true
    @AppStorage(AppSettings.Key.notificationsEnabled) private var notificationsEnabled = true
    @AppStorage(AppSettings.Key.notificationSound) private var notificationSound = true
    @AppStorage(AppSettings.Key.newProjectParent) private var newProjectParent = ""   // §69

    var body: some View {
        Form {
            Section("Appearance") {
                Picker(selection: $appearance) {
                    ForEach(Appearance.allCases) { Text(verbatim: $0.displayName).tag($0.rawValue) }
                } label: { SettingLabel("appearance") }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("Appearance")
                .settingAnchor("appearance")
                Toggle(isOn: $reopenLastProjects) { SettingLabel("reopenLastProjects") }
                    .help("On launch, reopens the project windows that were open at last quit (up to \(AppSettings.maxRestoredWindows)). Off: the app starts with the empty state.")
                    .accessibilityIdentifier("Reopen last projects on launch")
                    .settingAnchor("reopenLastProjects")
            }
            // §69: where New (no folder open) makes each project's folder.
            Section("Starting without a folder") {
                LabeledContent {
                    HStack(spacing: 6) {
                        Text(verbatim: newProjectParent.isEmpty ? AppSettings.defaultNewProjectParent : newProjectParent)
                            .foregroundStyle(newProjectParent.isEmpty ? .secondary : .primary)
                            .lineLimit(1).truncationMode(.middle)
                            .textSelection(.enabled)
                        Button("Choose…") { chooseNewProjectParent() }
                            .help("The folder New makes each project's folder in")
                            .accessibilityIdentifier("Choose folder for new projects")
                        Button("Reset") { newProjectParent = "" }
                            .disabled(newProjectParent.isEmpty)
                            .help(newProjectParent.isEmpty ? String(localized: "Already the default (ReviewGate in your home folder)") : String(localized: "Back to ReviewGate in your home folder"))
                            .accessibilityIdentifier("Reset folder for new projects")
                    }
                } label: { SettingLabel("newProjectParent") }
                .settingAnchor("newProjectParent")
            }
            Section("Typing and the chat") {
                Toggle(isOn: $returnSends) { SettingLabel("returnSends") }
                    .accessibilityIdentifier("Return sends the message")
                    .settingAnchor("returnSends")
                // MARK: wave4b w4b-tabs — market-12: reads and searches in a row fold into one "탐색: …" line unless this is on.
                Toggle(isOn: $showExploreDetail) { SettingLabel("showExploreDetail") }
                    .accessibilityIdentifier("Show exploration rows in detail")
                    .settingAnchor("showExploreDetail")
            }
            // MARK: wave4 w4-safety — daily-12: the close / quit confirm ("Don't ask again" turns it off; on again here).
            Section("Closing and quitting") {
                Toggle(isOn: $confirmQuit) { SettingLabel("confirmQuit") }
                    .accessibilityIdentifier("Ask before quitting")
                    .settingAnchor("confirmQuit")
                Toggle(isOn: $confirmCloseWhileWorking) { SettingLabel("confirmCloseWhileWorking") }
                    .accessibilityIdentifier("Ask before closing while Claude works")
                    .settingAnchor("confirmCloseWhileWorking")
            }
            Section("Notifications") {
                Toggle(isOn: $notificationsEnabled) { SettingLabel("notificationsEnabled") }
                    .accessibilityIdentifier("Notifications enabled")
                    .settingAnchor("notificationsEnabled")
                NotificationSettingsRows()   // MARK: wave4b w4-notify — macOS turned them off? one switch per group
                Toggle(isOn: $notificationSound) { SettingLabel("notificationSound") }
                    .disabled(!notificationsEnabled)
                    .help(notificationsEnabled ? "" : String(localized: "Turn on notifications first"))
                    .accessibilityIdentifier("Notification sound")
                    .settingAnchor("notificationSound")
                NotificationSoundRows()   // §39.7: a sound per kind of notification
            }
            UpdateSettingsSection()   // MARK: app-update (§48): check automatically (default on), [Check Now]
            AppVersionFooter()   // MARK: wave4 w4-install — "0.2.3 (610)", as in About and Copy Diagnostics
        }
        .formStyle(.grouped)
    }
}

extension GeneralSettingsPane {
    /// §69: picks the parent folder for new projects (a folder made here if the user wants one).
    private func chooseNewProjectParent() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "Choose")
        panel.message = String(localized: "Choose the folder for new projects")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        newProjectParent = url.path
    }
}

// MARK: - Permissions

/// The starting mode, Bash auto-allow, allow patterns (all projects / this project), the terminal's rules, session allows
/// and isolated worktree agents.
struct PermissionsSettingsPane: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.autoAllowBash) private var autoAllowBash = false
    // M16 permissions
    @AppStorage(AppSettings.Key.autoAllowReadOnlyBash) private var autoAllowReadOnlyBash = true
    @AppStorage(AppSettings.Key.bashAllowPatterns) private var bashAllowPatterns = ""
    /// Bumped after removing a project pattern so the list re-reads UserDefaults.
    @State private var projectPatternsTick = 0

    var body: some View {
        Form {
            Section("Asking for permission") {
                DefaultModeSettingsRow()   // wave4b w4b-auto (§39.5): the mode new projects start in, auto included
                Toggle(isOn: $autoAllowReadOnlyBash) { SettingLabel("autoAllowReadOnlyBash") }
                    .accessibilityIdentifier("Auto-allow read-only Bash")
                    .settingAnchor("autoAllowReadOnlyBash")
                Toggle(isOn: $autoAllowBash) { SettingLabel("autoAllowBash") }
                    .accessibilityIdentifier("Auto-allow Bash")
                    .settingAnchor("autoAllowBash")
            }
            Section("Allow patterns") {
                // wave1 mac-perms (§33.6): the list covers MCP tools / servers and WebFetch domains too, not only Bash.
                VStack(alignment: .leading, spacing: 6) {
                    SettingLabel("bashAllowPatterns", title: Text("All projects"))
                    TextEditor(text: $bashAllowPatterns)
                        .font(.body.monospaced())
                        .frame(minHeight: 60)
                        .accessibilityLabel("Allow patterns")
                        .accessibilityIdentifier("Allow patterns")
                }
                .settingAnchor("bashAllowPatterns")
                projectPatterns
                Button("Forget session allows") {
                    for store in WorkbenchRegistry.shared.allStores { store.forgetAllows() }
                }
                .disabled(WorkbenchRegistry.shared.allStores.allSatisfy { $0.rememberedAllows.isEmpty })
                .help(WorkbenchRegistry.shared.allStores.allSatisfy { $0.rememberedAllows.isEmpty }
                      ? String(localized: "No window remembers an \"Allow for session\" answer")
                      : String(localized: "Clears what \"Allow for session\" remembered in every open window"))
                .accessibilityIdentifier("Forget session allows")
            }
            // wave1 mac-perms: §33.4 / §33.5 / §33.7 switches, remembered allows, terminal rules
            Section("Terminal (Claude Code) allow rules") { TerminalAllowRuleRows() }
            Section("Allowed for this session") { SessionAllowRows() }
            Section("Agents and worktrees") { WorktreeIsolationRow() }
        }
        .formStyle(.grouped)
        .onChange(of: autoAllowReadOnlyBash) { _, _ in pushPermissionSettings() }
        .onChange(of: bashAllowPatterns) { _, _ in pushPermissionSettings() }
        .onChange(of: autoAllowBash) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushSessionStartSettings() } }
    }

    /// M16: `set_settings{autoAllowReadOnlyBash, bashAllowPatterns}` to every open window's engine.
    private func pushPermissionSettings() {
        // Each window gets the global list plus its own project's patterns.
        for store in WorkbenchRegistry.shared.allStores { store.pushPermissionSettings() }
    }

    /// "Always allow in this project" patterns of the focused window's project, each removable.
    @ViewBuilder
    private var projectPatterns: some View {
        if let url = store.projectURL {
            let patterns = { _ = projectPatternsTick; return store.projectAllowPatterns }()
            LabeledContent {
                if patterns.isEmpty {
                    Text("none").foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .trailing, spacing: 4) {
                        ForEach(patterns, id: \.self) { pattern in
                            HStack(spacing: 6) {
                                // wave1 mac-perms: MCP / WebFetch entries say what they cover ("github 서버 전체").
                                if AllowPatternLabel.text(pattern) != pattern {
                                    Text(verbatim: AllowPatternLabel.text(pattern)).font(.caption).foregroundStyle(.secondary)
                                }
                                Text(verbatim: pattern).font(.callout.monospaced()).textSelection(.enabled)
                                Button {
                                    store.removeProjectAllowPattern(pattern)
                                    projectPatternsTick += 1
                                } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(IconButtonStyle(padding: 2))
                                .help("Remove this pattern")
                                .accessibilityLabel("Remove \(pattern)")
                            }
                        }
                    }
                }
            } label: {
                SettingLabel("projectAllowPatterns", title: Text("Always allowed in \(url.lastPathComponent)"))
            }
            .accessibilityIdentifier("Project allow patterns")
            .settingAnchor("projectAllowPatterns")
        }
    }
}

// MARK: - Session

/// Chats, the session, limits, side questions, messages from other sessions, the status line, the system prompt.
struct SessionSettingsPane: View {
    @AppStorage(AppSettings.Key.budgetEnabled) private var budgetEnabled = false   // §54: the change limit is opt-in
    @AppStorage(AppSettings.Key.budgetMaxFiles) private var maxFiles = AppSettings.defaultMaxFiles
    @AppStorage(AppSettings.Key.budgetMaxLines) private var maxLines = AppSettings.defaultMaxLines
    @AppStorage(AppSettings.maxTurnsLimitKey) private var maxTurnsLimit = false   // §38.2: no tool-call limit by default
    @AppStorage(AppSettings.maxTurnsKey) private var maxTurns = AppSettings.defaultMaxTurns   // wave4 w4-longwork
    @AppStorage(AppSettings.Key.systemPromptAppend) private var systemPrompt = AppSettings.defaultSystemPromptAppend
    @AppStorage(AppSettings.Key.autoRestartSession) private var autoRestartSession = true
    @AppStorage(AppSettings.Key.newChatKind) private var newChatKind = SessionKind.terminal.rawValue   // MARK: terminal-default (§57.7)
    @AppStorage(AppSettings.Key.terminalPermissionBridge) private var terminalPermissionBridge = true   // MARK: terminal-stage2 (§57.15)
    @AppStorage(AppSettings.backgroundWorkKey) private var backgroundWork = true   // §52
    @AppStorage(AppSettings.subagentsInTurnKey) private var subagentsInTurn = false   // §52.2
    // §21 side questions
    @AppStorage(AppSettings.Key.sideModel) private var sideModel = ""
    /// The prompt goes to the engines when editing ends, never keystroke by keystroke.
    @FocusState private var systemPromptFocused: Bool

    var body: some View {
        Form {
            Section("Chats") {
                // MARK: terminal-default (§57.7): what ⌘T, + and a project's first chat open as; existing chats keep theirs.
                Picker(selection: $newChatKind) {
                    Text("Terminal").tag(SessionKind.terminal.rawValue)
                    Text("Chat").tag(SessionKind.chat.rawValue)
                } label: { SettingLabel("newChatKind") }
                .pickerStyle(.segmented)
                .help("Terminal: Claude Code itself runs in the chat column — every command, key and dialog of the terminal works, and ReviewGate reviews each turn. Chat: ReviewGate's own chat UI with cards, the queue and flows that send for you.")
                .accessibilityIdentifier("New chats open as")
                .settingAnchor("newChatKind")
                // MARK: terminal-stage2 (§57.15)
                Toggle(isOn: $terminalPermissionBridge) { SettingLabel("terminalPermissionBridge") }
                    .accessibilityIdentifier("Terminal permission bridge")
                    .settingAnchor("terminalPermissionBridge")
            }
            Section("Session") {
                Toggle(isOn: $autoRestartSession) { SettingLabel("autoRestartSession") }
                    .accessibilityIdentifier("Auto-restart session")
                    .settingAnchor("autoRestartSession")
                // §52: background commands, Ctrl+B, /loop — and the turns Claude then starts itself, reviewed like any other.
                Toggle(isOn: $backgroundWork) { SettingLabel("backgroundWork") }
                    .accessibilityIdentifier("Allow background work")
                    .settingAnchor("backgroundWork")
                // §52.2: subagents work in the background by default, as in the terminal — Claude answers meanwhile.
                Toggle(isOn: $subagentsInTurn) { SettingLabel("subagentsInTurn") }
                    .disabled(!backgroundWork)
                    .help(backgroundWork ? "" : String(localized: "Allow background work first: without it every subagent finishes inside the turn"))
                    .accessibilityIdentifier("Subagents finish inside the turn")
                    .settingAnchor("subagentsInTurn")
            }
            Section("Limits") {
                // §54: off by default — Claude works through a task as in the terminal; the numbers apply only while it is on.
                Toggle(isOn: $budgetEnabled) { SettingLabel("budgetEnabled") }
                    .accessibilityIdentifier("Limit changes per reply")
                    .settingAnchor("budgetEnabled")
                Stepper("Max files: \(maxFiles)", value: $maxFiles, in: 1...100)
                    .disabled(!budgetEnabled)
                    .help(budgetEnabled ? "" : String(localized: "Turn on Limit changes per reply first"))
                Stepper("Max changed lines: \(maxLines)", value: $maxLines, in: 10...5000, step: 10)
                    .disabled(!budgetEnabled)
                    .help(budgetEnabled ? "" : String(localized: "Turn on Limit changes per reply first"))
                if budgetEnabled {
                    Text("Hard stop at ×\(AppSettings.hardMultiplier, specifier: "%.1f") — edits beyond it are denied by the sidecar. Applies live to the open session.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                // MARK: wave4 w4-longwork (§38.2): no tool-call limit by default — the number applies only while it is on
                Toggle(isOn: $maxTurnsLimit) { SettingLabel("maxTurns") }
                    .accessibilityIdentifier("Limit tool calls per message")
                    .settingAnchor("maxTurns")
                Stepper(LongWorkText.settingsStepper(maxTurns), value: $maxTurns, in: AppSettings.maxTurnsRange, step: 10)
                    .disabled(!maxTurnsLimit)
                    .help(maxTurnsLimit ? "" : String(localized: "Turn on Limit tool calls per message first"))
                    .accessibilityIdentifier("Max tool calls per message")
            }
            Section {
                SideSettingsRows(sideModel: $sideModel, onChange: pushSideSettings)   // wave4b w4b-side (§40.3)
            } header: {
                Text("Side questions")
            } footer: {
                Text(LocalizedStringKey(SettingsCatalog.Info.sideQuestions))
                    .font(.caption).foregroundStyle(.secondary)
            }
            .onChange(of: sideModel) { _, _ in pushSideSettings() }
            PeerInboundSettingsSection()   // wave1 mac-session (§29)
            StatusLineSettingsSection()   // MARK: wave6 w6-statusline (§44.2)
            Section("System prompt append") {
                VStack(alignment: .leading, spacing: 6) {
                    SettingLabel("systemPromptAppend", title: Text("Added to every session"))
                    TextEditor(text: $systemPrompt)
                        .font(.body)
                        .frame(minHeight: 110)
                        .focused($systemPromptFocused)
                        .accessibilityLabel("System prompt append")
                        .accessibilityIdentifier("System prompt append")
                }
                .settingAnchor("systemPromptAppend")
                // §54: removes the stored text, so a later version's default reaches this Mac too.
                Button("Reset to default") {
                    UserDefaults.standard.removeObject(forKey: AppSettings.Key.systemPromptAppend)
                    pushSessionStartSettings()
                }
            }
            .onChange(of: systemPromptFocused) { _, focused in if !focused { pushSessionStartSettings() } }
        }
        .formStyle(.grouped)
        .onChange(of: budgetEnabled) { _, _ in pushBudget() }
        .onChange(of: maxFiles) { _, _ in pushBudget() }
        .onChange(of: maxLines) { _, _ in pushBudget() }
        .onChange(of: maxTurns) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushMaxTurns() } }   // wave4 w4-longwork
        .onChange(of: maxTurnsLimit) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushMaxTurns() } }   // §38.2
        .onChange(of: backgroundWork) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushBackgroundWork() } }   // §52
        .onChange(of: subagentsInTurn) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushBackgroundWork() } }   // §52.2
        .onChange(of: autoRestartSession) { _, enabled in
            for store in WorkbenchRegistry.shared.allStores { store.updateAutoRestartSession(enabled) }
        }
        .onChange(of: newChatKind) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushNewChatKind() } }   // §57.7
        .onChange(of: terminalPermissionBridge) { _, _ in   // §57.15
            for store in WorkbenchRegistry.shared.allStores { store.pushTerminalPermissionBridge() }
        }
        .onDisappear { pushSessionStartSettings() }   // the window closed (or the pane changed) while typing the prompt
    }

    /// `set_settings{budget}` to every open window's engine: the limits while the switch is on, else none (§54) — and the
    /// prompt, whose sentence about the limit follows the switch.
    private func pushBudget() {
        let budget = AppSettings.budget()
        for store in WorkbenchRegistry.shared.allStores { store.updateBudget(budget) }
        pushSessionStartSettings()
    }

    /// §55.11: the Bash auto-allow, user settings and rendered prompt — the next session start reads them.
    private func pushSessionStartSettings() {
        for store in WorkbenchRegistry.shared.allStores { store.pushSessionStartSettings() }
    }

    /// §21: `set_settings{sideModel, sideAllowWeb}` to every open window's engine (running engines only).
    private func pushSideSettings() {
        for store in WorkbenchRegistry.shared.allStores where store.isEngineRunning { store.updateSideSettings() }
    }
}

// MARK: - Review

/// The diff, checkpoint ignore patterns, test command patterns, disk space.
struct ReviewSettingsPane: View {
    @AppStorage(AppSettings.Key.checkpointIgnorePatterns) private var ignorePatterns = AppSettings.defaultIgnorePatternsText
    @AppStorage(AppSettings.Key.reviewFirst) private var reviewFirst = ReviewFirstMode.edits.rawValue   // §64
    /// wave2 mac-flow: the ignore patterns go to the engines when editing ends, never keystroke by keystroke.
    @FocusState private var ignorePatternsFocused: Bool

    var body: some View {
        Form {
            // §64: Claude's next work waits for the review — only the files under review may change (default), nothing and
            // no prompt either, or neither.
            Section("Review first") {
                Picker(selection: $reviewFirst) {
                    ForEach(ReviewFirstMode.allCases, id: \.self) { mode in
                        Text(LocalizedStringKey(mode.title)).tag(mode.rawValue)
                    }
                } label: { SettingLabel("reviewFirst") }
                .accessibilityIdentifier("Review first")
                .settingAnchor("reviewFirst")
            }
            .onChange(of: reviewFirst) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushReviewFirst() } }
            DiffSettingsSection()   // wave2 mac-diff: 줄바꿈 (also the diff header's toggle)
            Section("Checkpoint ignore patterns") {
                VStack(alignment: .leading, spacing: 6) {
                    SettingLabel("checkpointIgnorePatterns", title: Text("Hidden from the review"))
                    TextEditor(text: $ignorePatterns)
                        .font(.body.monospaced())
                        .frame(minHeight: 70)
                        .focused($ignorePatternsFocused)
                        .accessibilityLabel("Checkpoint ignore patterns")
                        .accessibilityIdentifier("Checkpoint ignore patterns")
                }
                .settingAnchor("checkpointIgnorePatterns")
                // wave2 mac-flow: a half-typed pattern ("*") must never reach a turn's collection — applied on leaving the box.
                Button("Reset to default") {
                    ignorePatterns = AppSettings.defaultIgnorePatternsText
                    commitIgnorePatterns()
                }
            }
            .onChange(of: ignorePatternsFocused) { _, focused in if !focused { commitIgnorePatterns() } }
            TestCommandSettingsSection()   // wave3 check-clients (§34.9)
            StorageSettingsSection()   // MARK: wave4b w4b-bigturn (§39.1): large-file limit, [오래된 리뷰 기록 정리]
        }
        .formStyle(.grouped)
        .onDisappear { commitIgnorePatterns() }   // wave2 mac-flow: the window closed (or the pane changed) while typing
    }

    /// wave2 mac-flow: `set_settings{ignorePatterns}` to every open window's engine — each only when its list changed.
    private func commitIgnorePatterns() {
        for store in WorkbenchRegistry.shared.allStores { store.commitIgnorePatterns() }
    }
}

// MARK: - Git & Workbenches

/// Where workbenches go, Run as Task, the commit sheet's push default and trailer.
struct GitSettingsPane: View {
    @AppStorage(AppSettings.Key.worktreeRoot) private var worktreeRoot = ""
    @AppStorage(AppSettings.Key.runAsTaskEnabled) private var runAsTaskEnabled = true   // §49
    @AppStorage(AppSettings.Key.commitPushByDefault) private var commitPushByDefault = false
    @AppStorage(AppSettings.Key.commitTrailer) private var commitTrailer = ""
    @AppStorage(AppSettings.Key.autoFetch) private var autoFetch = true   // MARK: git-sync (§68.4)

    var body: some View {
        Form {
            Section("Workbenches") {
                TextField(text: $worktreeRoot, prompt: Text(verbatim: AppSettings.defaultWorktreeRoot)) { SettingLabel("worktreeRoot") }
                    .accessibilityIdentifier("Worktree folder")
                    .settingAnchor("worktreeRoot")
                // §49
                Toggle(isOn: $runAsTaskEnabled) { SettingLabel("runAsTaskEnabled") }
                    .accessibilityIdentifier("Run as Task enabled")
                    .settingAnchor("runAsTaskEnabled")
            }
            Section("Commit") {
                Toggle(isOn: $commitPushByDefault) { SettingLabel("commitPushByDefault") }
                    .accessibilityIdentifier("Push by default")
                    .settingAnchor("commitPushByDefault")
                TextField(text: $commitTrailer, prompt: Text(verbatim: "Co-Authored-By: Name <email>")) { SettingLabel("commitTrailer") }
                    .accessibilityIdentifier("Commit trailer")
                    .settingAnchor("commitTrailer")
            }
            // MARK: git-sync — §68.4
            Section("Fetch and Pull") {
                Toggle(isOn: $autoFetch) { SettingLabel("autoFetch") }
                    .accessibilityIdentifier("Fetch automatically")
                    .settingAnchor("autoFetch")
            }
            Section {
                Text("The commit message template, workbench setup and PR command of the open repository are in Project.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onChange(of: worktreeRoot) { _, _ in
            let root = AppSettings.worktreeRoot()
            for store in WorkbenchRegistry.shared.allStores { store.updateWorktreeRoot(root) }
        }
        .onChange(of: commitPushByDefault) { _, _ in pushCommitSettings() }
        .onChange(of: commitTrailer) { _, _ in pushCommitSettings() }
        .onChange(of: autoFetch) { _, on in
            for store in WorkbenchRegistry.shared.allStores { store.updateAutoFetch(on) }
        }
    }

    private func pushCommitSettings() {
        let push = AppSettings.commitPushByDefault(), trailer = AppSettings.commitTrailer()
        for store in WorkbenchRegistry.shared.allStores { store.updateCommitSettings(pushByDefault: push, trailer: trailer) }
    }
}

// MARK: - Advanced

/// What node and claude the window found, the pinned CLI version and the path overrides.
struct AdvancedSettingsPane: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.nodePath) private var nodePath = ""
    @AppStorage(AppSettings.Key.claudePath) private var claudePath = ""
    @FocusState private var claudePathFocused: Bool
    @State private var nodeVersion: String?
    @State private var claudeVersion: String?

    var body: some View {
        Form {
            Section("Toolchain") {
                LabeledContent("node") {
                    toolchainValue(path: store.toolchain?.nodePath, version: nodeVersion)
                }
                LabeledContent("claude") {
                    toolchainValue(path: store.toolchain?.claudePath, version: claudeVersion)
                }
                Group {
                    if store.toolchain == nil {
                        Text("Detected when a project is opened.")
                    } else {
                        Text("Detected via the login shell for the current session.")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            .settingAnchor("toolchain")
            CliVersionPinSection()   // wave3 mac-session (§36.8): CLI 버전 고정
            Section("Toolchain overrides") {
                TextField(text: $claudePath, prompt: store.toolchain?.claudePath.map { Text(verbatim: $0) } ?? Text("auto-detect")) {
                    SettingLabel("claudePath")
                }
                .focused($claudePathFocused)
                .onSubmit(pushClaudePath)
                .settingAnchor("claudePath")
                TextField(text: $nodePath, prompt: store.toolchain?.nodePath.map { Text(verbatim: $0) } ?? Text("auto-detect")) {
                    SettingLabel("nodePath")
                }
                .settingAnchor("nodePath")
            }
            .onChange(of: claudePathFocused) { _, focused in if !focused { pushClaudePath() } }
        }
        .formStyle(.grouped)
        .task(id: store.toolchain) { await loadVersions() }
    }

    /// §55.11: the claude path goes to every window's engine (as a pin does), so its next session starts with it.
    private func pushClaudePath() {
        let path = claudePath.trimmingCharacters(in: .whitespaces)
        for store in WorkbenchRegistry.shared.allStores { store.applyClaudePath(path) }
    }

    private func toolchainValue(path: String?, version: String?) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            (path.map { Text(verbatim: $0) } ?? Text("not found"))
                .font(.callout.monospaced())
                .foregroundStyle(path == nil ? Color.orange : Color.primary)
                .lineLimit(1).truncationMode(.middle)
                .textSelection(.enabled)
            if let version {
                Text(version).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func loadVersions() async {
        guard let toolchain = store.toolchain else { nodeVersion = nil; claudeVersion = nil; return }
        claudeVersion = toolchain.claudeVersion
        nodeVersion = await toolchain.nodeVersion()
    }
}
