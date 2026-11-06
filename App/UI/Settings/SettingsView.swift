import SwiftUI
import ReviewGateCore

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label("General", systemImage: "gearshape") }
            ExtensionsSettingsView()
                .tabItem { Label("Extensions", systemImage: "puzzlepiece.extension") }
            ProjectFlowSettingsView()   // wave3 mac-flow: commit template, workbench setup, PR command of this repository
                .tabItem { Label("Project", systemImage: "folder.badge.gearshape") }
            AccountsSettingsView()
                .tabItem { Label("Accounts", systemImage: "person.crop.circle") }
        }
        .frame(width: 560, height: 760)
    }
}

private struct GeneralSettingsView: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.appearance) private var appearance = Appearance.system.rawValue
    /// M19: reopen last session's project windows on launch.
    @AppStorage(AppSettings.Key.reopenLastProjects) private var reopenLastProjects = true
    // MARK: wave4 w4-safety
    @AppStorage(AppSettings.Key.confirmCloseWhileWorking) private var confirmCloseWhileWorking = true
    @AppStorage(ExploreFold.detailDefaultsKey) private var showExploreDetail = false   // MARK: wave4b w4b-tabs (§39.2)
    @AppStorage(AppSettings.Key.returnSends) private var returnSends = true
    @AppStorage(AppSettings.Key.budgetEnabled) private var budgetEnabled = false   // §54: the change limit is opt-in
    @AppStorage(AppSettings.Key.budgetMaxFiles) private var maxFiles = AppSettings.defaultMaxFiles
    @AppStorage(AppSettings.Key.budgetMaxLines) private var maxLines = AppSettings.defaultMaxLines
    @AppStorage(AppSettings.maxTurnsLimitKey) private var maxTurnsLimit = false   // §38.2: no tool-call limit by default
    @AppStorage(AppSettings.maxTurnsKey) private var maxTurns = AppSettings.defaultMaxTurns   // wave4 w4-longwork
    @AppStorage(AppSettings.Key.systemPromptAppend) private var systemPrompt = AppSettings.defaultSystemPromptAppend
    @AppStorage(AppSettings.Key.nodePath) private var nodePath = ""
    @AppStorage(AppSettings.Key.claudePath) private var claudePath = ""
    @AppStorage(AppSettings.Key.checkpointIgnorePatterns) private var ignorePatterns = AppSettings.defaultIgnorePatternsText
    @AppStorage(AppSettings.Key.autoAllowBash) private var autoAllowBash = false
    @AppStorage(AppSettings.Key.loadUserSettings) private var loadUserSettings = true
    @AppStorage(AppSettings.Key.worktreeRoot) private var worktreeRoot = ""
    @AppStorage(AppSettings.Key.runAsTaskEnabled) private var runAsTaskEnabled = true   // §49
    @AppStorage(AppSettings.Key.commitPushByDefault) private var commitPushByDefault = false
    @AppStorage(AppSettings.Key.commitTrailer) private var commitTrailer = ""
    @AppStorage(AppSettings.Key.autoRestartSession) private var autoRestartSession = true
    @AppStorage(AppSettings.backgroundWorkKey) private var backgroundWork = true   // §52
    @AppStorage(AppSettings.subagentsInTurnKey) private var subagentsInTurn = false   // §52.2
    // M16 permissions
    @AppStorage(AppSettings.Key.autoAllowReadOnlyBash) private var autoAllowReadOnlyBash = true
    @AppStorage(AppSettings.Key.bashAllowPatterns) private var bashAllowPatterns = ""
    @AppStorage(AppSettings.Key.notificationsEnabled) private var notificationsEnabled = true
    @AppStorage(AppSettings.Key.notificationSound) private var notificationSound = true
    // §21 side questions
    @AppStorage(AppSettings.Key.sideModel) private var sideModel = ""
    /// Bumped after removing a project pattern so the list re-reads UserDefaults.
    @State private var projectPatternsTick = 0
    /// wave2 mac-flow: the ignore patterns go to the engines when editing ends, never keystroke by keystroke.
    @FocusState private var ignorePatternsFocused: Bool
    @State private var nodeVersion: String?
    @State private var claudeVersion: String?

    var body: some View {
        Form {
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases) { Text(verbatim: $0.displayName).tag($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("Appearance")
                Text("System follows macOS. Light and Dark apply to every window, sheet and menu right away.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Reopen last projects on launch", isOn: $reopenLastProjects)
                    .accessibilityIdentifier("Reopen last projects on launch")
                Text("On launch, reopens the project windows that were open at last quit (up to \(AppSettings.maxRestoredWindows)). Off: the app starts with the empty state.")
                    .font(.caption).foregroundStyle(.secondary)
                // MARK: wave4 w4-safety — daily-12: the close / quit confirm ("Don't ask again" turns it off; on again here).
                Toggle("Ask before closing while Claude works", isOn: $confirmCloseWhileWorking)
                    .accessibilityIdentifier("Ask before closing while Claude works")
                Text("Closing a window or quitting while a turn runs, or while Claude waits for your answer, asks first.")
                    .font(.caption).foregroundStyle(.secondary)
                // MARK: wave4b w4b-tabs — market-12: reads and searches in a row fold into one "탐색: …" line unless this is on.
                Toggle("Return sends the message", isOn: $returnSends)
                    .accessibilityIdentifier("Return sends the message")
                Text("On: ↩ sends and ⇧↩ starts a new line. Off: ↩ starts a new line and ⌘↩ sends. ⌘↩ sends either way.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Show exploration rows in detail", isOn: $showExploreDetail)
                    .accessibilityIdentifier("Show exploration rows in detail")
                Text("Off: reads, searches and read-only commands in a row fold into one line in the chat (click it to open).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            DiffSettingsSection()   // wave2 mac-diff: 줄바꿈 (also the diff header's toggle)
            Section("Notifications") {
                Toggle("Notify when a window in the background needs you", isOn: $notificationsEnabled)
                    .accessibilityIdentifier("Notifications enabled")
                Toggle("Play a sound", isOn: $notificationSound)
                    .disabled(!notificationsEnabled)
                    .accessibilityIdentifier("Notification sound")
                Text("Turn finished (with the files waiting for review), permission requests, questions, plans and errors that need you. The dock badge counts files pending review across windows, or shows ! while Claude waits for an answer.")
                    .font(.caption).foregroundStyle(.secondary)
                NotificationSettingsRows()   // MARK: wave4b w4-notify — macOS turned them off? one switch per group
            }
            Section("Limits") {
                // §54: off by default — Claude works through a task as in the terminal; the numbers apply only while it is on.
                Toggle("Limit changes per reply", isOn: $budgetEnabled)
                    .accessibilityIdentifier("Limit changes per reply")
                Stepper("Max files: \(maxFiles)", value: $maxFiles, in: 1...100)
                    .disabled(!budgetEnabled)
                Stepper("Max changed lines: \(maxLines)", value: $maxLines, in: 10...5000, step: 10)
                    .disabled(!budgetEnabled)
                if budgetEnabled {
                    Text("Hard stop at ×\(AppSettings.hardMultiplier, specifier: "%.1f") — edits beyond it are denied by the sidecar. Applies live to the open session.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Off (the default): no limit on the files or lines one reply changes — Claude finishes the task as in the terminal, and you review the changes afterwards.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                // MARK: wave4 w4-longwork (§38.2): no tool-call limit by default — the number applies only while it is on
                Toggle(LongWorkText.settingsToggle, isOn: $maxTurnsLimit)
                    .accessibilityIdentifier("Limit tool calls per message")
                Stepper(LongWorkText.settingsStepper(maxTurns), value: $maxTurns, in: AppSettings.maxTurnsRange, step: 10)
                    .disabled(!maxTurnsLimit)
                    .accessibilityIdentifier("Max tool calls per message")
                Text(verbatim: maxTurnsLimit ? LongWorkText.settingsNote : LongWorkText.settingsOffNote)
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Permissions") {
                DefaultModeSettingsRow()   // wave4b w4b-auto (§39.5): the mode new projects start in, auto included
                Toggle("Auto-allow read-only Bash", isOn: $autoAllowReadOnlyBash)
                    .accessibilityIdentifier("Auto-allow read-only Bash")
                Text("Commands that only read (git status, ls, cat, grep, …) with no redirection or chaining run without asking. Applies live.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Auto-allow Bash", isOn: $autoAllowBash)
                    .accessibilityIdentifier("Auto-allow Bash")
                Text("Off: every shell command asks for permission in the chat. Edits are always auto-allowed (within the change limit, when it is on). Takes effect on the next Open Project.")
                    .font(.caption).foregroundStyle(.secondary)
                Text("Allow patterns").font(.subheadline.weight(.semibold))   // wave1 mac-perms: not only Bash any more
                TextEditor(text: $bashAllowPatterns)
                    .font(.body.monospaced())
                    .frame(minHeight: 60)
                    .accessibilityIdentifier("Allow patterns")
                // wave1 mac-perms (§33.6): the list covers MCP tools / servers and WebFetch domains too, not only Bash.
                Text("Allow patterns, one per line — Bash(npm test:*), Bash(git *), mcp__github__* (an MCP server), mcp__github__get_issue (one tool), WebFetch(domain:docs.spring.io), WebSearch. Matching calls never ask. Applies live.")
                    .font(.caption).foregroundStyle(.secondary)
                projectPatterns
                PermissionSettingsRows()   // wave1 mac-perms: §33.4 / §33.5 / §33.7 switches, remembered allows, terminal rules
                Button("Forget session allows") {
                    for store in WorkbenchRegistry.shared.allStores { store.forgetAllows() }
                }
                .disabled(WorkbenchRegistry.shared.allStores.allSatisfy { $0.rememberedAllows.isEmpty })
                .help("Clears what \"Allow for session\" remembered in every open window")
                .accessibilityIdentifier("Forget session allows")
                Toggle("Load user settings (skills, plugins, MCP, hooks from ~/.claude)", isOn: $loadUserSettings)
                    .accessibilityIdentifier("Load user settings")
                Text("Bash and other non-edit tools still require approval here. Takes effect on the next Open Project.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            PeerInboundSettingsSection()   // wave1 mac-session (§29)
            Section("Session") {
                Toggle("Auto-restart session", isOn: $autoRestartSession)
                    .accessibilityIdentifier("Auto-restart session")
                Text("Starts a new Claude session once when the current one dies unexpectedly. The review list is kept either way; off, the chat shows \"Session ended — Restart\".")
                    .font(.caption).foregroundStyle(.secondary)
                // §52: background commands, Ctrl+B, /loop — and the turns Claude then starts itself, reviewed like any other.
                Toggle("Allow background work and /loop", isOn: $backgroundWork)
                    .accessibilityIdentifier("Allow background work")
                Text("As in the terminal: Claude can run a command in the background (a dev server, a long build) and /loop can repeat a prompt. When a background command ends or a scheduled run starts, Claude goes on by itself — that turn is reviewed like any other, and files a background command changed in between go into the next review. Takes effect when the session restarts.")
                    .font(.caption).foregroundStyle(.secondary)
                // §52.2: subagents work in the background by default, as in the terminal — Claude answers meanwhile.
                Toggle("Subagents finish inside the turn", isOn: $subagentsInTurn)
                    .disabled(!backgroundWork)
                    .accessibilityIdentifier("Subagents finish inside the turn")
                Text("Off (the default): as in the terminal, a subagent works in the background and Claude answers your messages meanwhile; what it changes still goes into the next review, and Claude goes on when it is done. On: Claude waits for its subagents before it answers, as before. Takes effect when the session restarts.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            StatusLineSettingsSection()   // MARK: wave6 w6-statusline (§44.2)
            Section("Side questions") {
                SideSettingsRows(sideModel: $sideModel, onChange: pushSideSettings)   // wave4b w4b-side (§40.3)
                Text("Side questions run in their own read-only Claude session forked from the chat; they never change files or the main conversation. A cheaper model (e.g. haiku) keeps them fast. Applies to the next question; clearing the model applies after reopening the project.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .onChange(of: sideModel) { _, _ in pushSideSettings() }
            Section("Checkpoint ignore patterns") {
                TextEditor(text: $ignorePatterns)
                    .font(.body.monospaced())
                    .frame(minHeight: 70)
                    .focused($ignorePatternsFocused)
                    .accessibilityIdentifier("Checkpoint ignore patterns")
                // wave2 mac-flow: a half-typed pattern ("*") must never reach a turn's collection — applied on leaving the box.
                Text("One per line; a path prefix (e.g. .omc/) or a glob with * (e.g. *.log). Matching files are hidden from the review list and never reverted. Applied to every open project when you leave this box, from the next collected turn or refresh.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Reset to default") {
                    ignorePatterns = AppSettings.defaultIgnorePatternsText
                    commitIgnorePatterns()
                }
            }
            .onChange(of: ignorePatternsFocused) { _, focused in if !focused { commitIgnorePatterns() } }
            StorageSettingsSection()   // MARK: wave4b w4b-bigturn (§39.1): large-file limit, [오래된 리뷰 기록 정리]
            TestCommandSettingsSection()   // wave3 check-clients (§34.9)
            Section("System prompt append") {
                TextEditor(text: $systemPrompt)
                    .font(.body)
                    .frame(minHeight: 120)
                Text("Placeholders {maxFiles} and {maxLines} are substituted. Takes effect on the next Open Project.")
                    .font(.caption).foregroundStyle(.secondary)
                // §54: removes the stored text, so a later version's default reaches this Mac too.
                Button("Reset to default") { UserDefaults.standard.removeObject(forKey: AppSettings.Key.systemPromptAppend) }
            }
            Section("Workbenches") {
                TextField("Worktree folder", text: $worktreeRoot, prompt: Text(verbatim: AppSettings.defaultWorktreeRoot))
                    .accessibilityIdentifier("Worktree folder")
                Text("New workbenches are created under this folder as <repo>-<hash>/<branch>. Never inside the repository.")
                    .font(.caption).foregroundStyle(.secondary)
                // §49
                Toggle("Run as Task", isOn: $runAsTaskEnabled)
                    .accessibilityIdentifier("Run as Task enabled")
                Text("Adds \"Run as Task\" to the composer and the Workbenches menu: the message starts in a new workbench (its own branch, folder, window and chat), so this chat is left as it is.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Commit") {
                Toggle("Push by default", isOn: $commitPushByDefault)
                    .accessibilityIdentifier("Push by default")
                Text("Preselects \"Push to origin\" in the Commit accepted sheet.")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("Commit trailer", text: $commitTrailer, prompt: Text(verbatim: "Co-Authored-By: Name <email>"))
                    .accessibilityIdentifier("Commit trailer")
                Text("Appended as the last line of every commit message (e.g. Co-Authored-By: …). Leave empty for none.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Toolchain") {
                LabeledContent("node") {
                    toolchainValue(path: store.toolchain?.nodePath, version: nodeVersion)
                }
                LabeledContent("claude") {
                    toolchainValue(path: store.toolchain?.claudePath, version: claudeVersion)
                }
                if store.toolchain == nil {
                    Text("Detected when a project is opened.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Detected via the login shell for the current session.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            CliVersionPinSection()   // wave3 mac-session (§36.8): CLI 버전 고정
            Section("Toolchain overrides") {
                TextField("node path", text: $nodePath, prompt: store.toolchain?.nodePath.map { Text(verbatim: $0) } ?? Text("auto-detect"))
                TextField("claude path", text: $claudePath, prompt: store.toolchain?.claudePath.map { Text(verbatim: $0) } ?? Text("auto-detect"))
                Text("Leave empty to detect via the login shell. Takes effect on the next Open Project.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            UpdateSettingsSection()   // MARK: app-update (§48): check automatically (default on), [Check Now]
            AppVersionFooter()   // MARK: wave4 w4-install — "0.2.3 (610)", as in About and Copy Diagnostics
        }
        .formStyle(.grouped)
        .onChange(of: budgetEnabled) { _, _ in pushBudget() }
        .onChange(of: maxFiles) { _, _ in pushBudget() }
        .onChange(of: maxLines) { _, _ in pushBudget() }
        .onChange(of: maxTurns) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushMaxTurns() } }   // wave4 w4-longwork
        .onChange(of: maxTurnsLimit) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushMaxTurns() } }   // §38.2
        .onChange(of: backgroundWork) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushBackgroundWork() } }   // §52
        .onChange(of: subagentsInTurn) { _, _ in for store in WorkbenchRegistry.shared.allStores { store.pushBackgroundWork() } }   // §52.2
        .onChange(of: worktreeRoot) { _, _ in
            let root = AppSettings.worktreeRoot()
            for store in WorkbenchRegistry.shared.allStores { store.updateWorktreeRoot(root) }
        }
        .onChange(of: commitPushByDefault) { _, _ in pushCommitSettings() }
        .onChange(of: commitTrailer) { _, _ in pushCommitSettings() }
        .onChange(of: autoRestartSession) { _, enabled in
            for store in WorkbenchRegistry.shared.allStores { store.updateAutoRestartSession(enabled) }
        }
        .onChange(of: autoAllowReadOnlyBash) { _, _ in pushPermissionSettings() }
        .onChange(of: bashAllowPatterns) { _, _ in pushPermissionSettings() }
        .task(id: store.toolchain) { await loadVersions() }
        .onDisappear { commitIgnorePatterns() }   // wave2 mac-flow: the window closed (or the tab changed) while typing
    }

    /// wave2 mac-flow: `set_settings{ignorePatterns}` to every open window's engine — each only when its list changed.
    private func commitIgnorePatterns() {
        for store in WorkbenchRegistry.shared.allStores { store.commitIgnorePatterns() }
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
                Text("Always allowed in \(url.lastPathComponent)")
                Text("Saved from the permission card: simple Bash commands, MCP tools and servers, WebFetch domains.").font(.caption).foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("Project allow patterns")
        }
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

    /// `set_settings{budget}` to every open window's engine: the limits while the switch is on, else none (§54).
    private func pushBudget() {
        let budget = AppSettings.budget()
        for store in WorkbenchRegistry.shared.allStores { store.updateBudget(budget) }
    }

    /// M16: `set_settings{autoAllowReadOnlyBash, bashAllowPatterns}` to every open window's engine.
    private func pushPermissionSettings() {
        // Each window gets the global list plus its own project's patterns.
        for store in WorkbenchRegistry.shared.allStores { store.pushPermissionSettings() }
    }

    private func pushCommitSettings() {
        let push = AppSettings.commitPushByDefault(), trailer = AppSettings.commitTrailer()
        for store in WorkbenchRegistry.shared.allStores { store.updateCommitSettings(pushByDefault: push, trailer: trailer) }
    }

    /// §21: `set_settings{sideModel, sideAllowWeb}` to every open window's engine (running engines only).
    private func pushSideSettings() {
        for store in WorkbenchRegistry.shared.allStores where store.isEngineRunning { store.updateSideSettings() }
    }
}

/// `gh auth status` per host: who is logged in where, plus a way to start `gh auth login` for a host.
private struct AccountsSettingsView: View {
    @Environment(PRStore.self) private var store
    @State private var newHost = ""

    var body: some View {
        Form {
            Section {
                if store.accounts.isEmpty {
                    Text("No GitHub accounts found. Log in to a host below.")
                        .foregroundStyle(.secondary)
                } else {
                    Table(store.accounts) {
                        TableColumn("Host") { account in
                            Text(account.host).lineLimit(1).truncationMode(.middle)
                        }
                        TableColumn("Login") { account in
                            Text(verbatim: account.login ?? "—").foregroundStyle(account.login == nil ? .secondary : .primary)
                        }
                        TableColumn("Status") { account in
                            Label(account.ok ? "OK" : "Not logged in",
                                  systemImage: account.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(account.ok ? Color.green : Color.red)
                                .help(account.detail)
                        }
                        .width(min: 90, ideal: 110)
                        TableColumn("") { account in
                            Button("Log in…") { store.openLoginInTerminal(host: account.host) }
                                .controlSize(.small)
                                .accessibilityIdentifier("Log in")
                        }
                        .width(70)
                    }
                    .frame(minHeight: 120, idealHeight: CGFloat(store.accounts.count) * 28 + 40, maxHeight: 260)
                    .accessibilityIdentifier("Accounts table")
                }
                if let detail = store.accounts.first(where: { !$0.ok })?.detail, !detail.isEmpty {
                    Text(verbatim: detail)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(6)
                }
            } header: {
                HStack {
                    Text("GitHub accounts")
                    Spacer()
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refreshAccounts() } }
                        .controlSize(.small)
                        .accessibilityIdentifier("Refresh accounts")
                }
            }
            Section("Add a host") {
                HStack {
                    TextField("Host", text: $newHost, prompt: Text("github.example.com"))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(login)
                        .accessibilityIdentifier("New host")
                    Button("Log in…", action: login)
                        .disabled(newHost.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("Log in new host")
                }
                // Two Texts, so each is a localized key (one String expression for both was shown verbatim, in English).
                Group {
                    if let loginCommand = PRStore.loginCommand(host: newHost.isEmpty ? "HOST" : newHost.trimmingCharacters(in: .whitespaces)) {
                        Text("Opens Terminal with `\(loginCommand)`. Press Refresh once the browser flow completes.")
                    } else {
                        Text("Enter a valid host (letters, digits, `.`, `-`, optional `:port`).")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .task { if store.accounts.isEmpty { await store.refreshAccounts() } }
    }

    private func login() {
        let host = newHost.trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty else { return }
        store.openLoginInTerminal(host: host)
    }
}
