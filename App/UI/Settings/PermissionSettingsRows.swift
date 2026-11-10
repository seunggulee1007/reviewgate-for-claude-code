import SwiftUI
import ReviewGateCore

/// Settings › General › Permissions, the §33 rows (wave1 mac-perms): isolated worktree agents (§33.4), the terminal's
/// allow rules (§33.5, and their Bash rules — r2 M20), keeping "세션 동안 허용" per repository (§33.7, r2 M21) with what this window remembered, and the
/// terminal (Claude Code) allow rules with import (§33.8). Rows of the enclosing `Form` section.
struct PermissionSettingsRows: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.allowWorktreeIsolation) private var allowWorktreeIsolation = true   // M05b: on unless turned off
    @AppStorage(AppSettings.Key.applyUserAllowRules) private var applyUserAllowRules = true
    @AppStorage(AppSettings.Key.persistSessionAllows) private var persistSessionAllows = true   // r2-skills-side (§33.7, M21): on by default
    @AppStorage(AppSettings.Key.applyUserBashRules) private var applyUserBashRules = true   // MARK: r2-skills-side (§33.5, M20)
    @State private var showTerminalRules = false

    var body: some View {
        Group {
            Toggle("Allow agents that work in another worktree (isolation)", isOn: $allowWorktreeIsolation)
                .onChange(of: allowWorktreeIsolation) { _, _ in pushToEveryWindow() }
                .accessibilityIdentifier("Allow worktree isolation")
            Text("In auto mode they run without a card; otherwise each asks with a card. A row afterwards says where they worked · applies from the next session")
                .font(.caption).foregroundStyle(.secondary)
            Toggle("Apply the terminal's allow rules (lookup and read tools)", isOn: $applyUserAllowRules)
                .onChange(of: applyUserAllowRules) { _, _ in pushToEveryWindow() }
                .accessibilityIdentifier("Apply terminal allow rules")
            Text("Tools you allowed in Claude Code that cannot change files — web search and fetch, read-only MCP tools, agents — run without a card here too. Edits and commands still go through the review. Applies live.")
                .font(.caption).foregroundStyle(.secondary)
            // MARK: r2-skills-side — §33.5 (M20): the terminal's Bash(…) rules, like the app's allow patterns.
            Toggle("Also apply the terminal's Bash allow rules", isOn: $applyUserBashRules)
                .onChange(of: applyUserBashRules) { _, _ in pushToEveryWindow() }
                .disabled(!applyUserAllowRules)
                .help(applyUserAllowRules ? "" : String(localized: "Turn on the terminal allow rules first"))
                .accessibilityIdentifier("Apply terminal Bash rules")
            Text("Commands your Bash(…) rules allow (e.g. Bash(mvn:*)) run without a card, as in the terminal; your deny and ask rules still win, and the files they change are reviewed. Applies immediately.")
                .font(.caption).foregroundStyle(.secondary)
            Toggle("Keep \"Allow for session\" for this repository", isOn: $persistSessionAllows)
                .onChange(of: persistSessionAllows) { _, _ in pushToEveryWindow() }
                .accessibilityIdentifier("Keep session allows")
            Text("Kept when the app reopens · shared by the repository's worktrees and workbenches")
                .font(.caption).foregroundStyle(.secondary)
            rememberedAllows
            LabeledContent {
                Button("Show…") { showTerminalRules = true }
                    .disabled(store.projectInfo == nil)
                    .accessibilityLabel("Show the terminal allow rules")
                    .accessibilityIdentifier("Show terminal allow rules")
            } label: {
                Text("Terminal (Claude Code) allow rules")
                Text(store.projectInfo == nil
                     ? String(localized: "Open a project to see which of your Claude Code rules apply here")
                     : String(localized: "Which rules apply here, which are ignored, and what you can import"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            .sheet(isPresented: $showTerminalRules) {
                TerminalAllowRulesSheet()
                    .environment(store)
            }
        }
    }

    /// "세션 동안 허용" answers of this window's session (`state.session.rememberedAllows`), with [모두 지우기].
    private var rememberedAllows: some View {
        LabeledContent {
            if store.rememberedAllows.isEmpty {
                Text("none").foregroundStyle(.secondary)
            } else {
                VStack(alignment: .trailing, spacing: 3) {
                    ForEach(store.rememberedAllows, id: \.self) { key in
                        Text(verbatim: RememberedAllowText.text(key))
                            .font(.callout.monospaced())
                            .lineLimit(1).truncationMode(.middle)
                            .textSelection(.enabled)
                            .help(key)
                    }
                    Button("Clear all") { store.forgetAllows() }
                        .controlSize(.small)
                        .help("Ask again for these tools and commands (this window)")
                        .accessibilityIdentifier("Clear remembered allows")
                }
            }
        } label: {
            Text("Allowed for this session")
            Text(persistSessionAllows ? String(localized: "This window · kept for this repository") : String(localized: "This window · until the session ends"))
                .font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("Remembered allows")
    }

    private func pushToEveryWindow() {
        for store in WorkbenchRegistry.shared.allStores { store.pushWorktreePermissionSettings() }
    }
}

/// §33.8: the user's Claude Code `permissions.allow` rules — what this app applies, what it ignores and why — and the
/// import of the importable ones into the global or this project's allow list. Claude Code's files are never changed.
struct TerminalAllowRulesSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    /// Ids of the rows ticked for import (none by default).
    @State private var selected: Set<String> = []
    @State private var toProject = false
    @State private var importResult: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text("Terminal (Claude Code) allow rules").font(.title3.weight(.semibold))
                    if store.isLoadingPermissionRules { ProgressView().controlSize(.small) }
                    Spacer()
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.loadPermissionRules() } }
                        .controlSize(.small)
                        .disabled(store.isLoadingPermissionRules || store.projectInfo == nil)
                        .accessibilityIdentifier("Refresh terminal allow rules")
                }
                Text("Rules for tools that cannot change files apply here as well. The rest can be imported as this app's allow patterns. Claude Code's settings files are never changed.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            content
            footer
        }
        .padding(16)
        .frame(width: 660, height: 600)
        .task { await store.loadPermissionRules() }
        .accessibilityIdentifier("Terminal allow rules")
    }

    @ViewBuilder
    private var content: some View {
        if let error = store.permissionRulesError {
            HStack(spacing: 8) {
                Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Button("Retry") { Task { await store.loadPermissionRules() } }
                    .controlSize(.small)
            }
        }
        if let rules = store.permissionRules {
            notes(rules)
            sources(rules)
            ruleList(rules)
        } else {
            if store.permissionRulesError == nil { HStack { Spacer(); ProgressView(); Spacer() } }
            Spacer()
        }
    }

    @ViewBuilder
    private func notes(_ rules: PermissionRulesReply) -> some View {
        if !rules.applyUserAllowRules {
            Label("Applying the terminal's rules is off — none of them is used here until you turn it on", systemImage: "info.circle")
                .font(.callout).foregroundStyle(.orange)
        }
        if !rules.loadUserSettings {
            Label("Loading user settings is off — your user rules are not used here", systemImage: "info.circle")
                .font(.callout).foregroundStyle(.orange)
        }
        if let mode = rules.defaultMode {
            Label {
                if let supported = rules.supportedDefaultMode {
                    Text("The terminal starts in \(supported.displayName) mode (permissions.defaultMode)")
                } else {
                    Text("The terminal starts in \(mode) mode, which ReviewGate does not offer")
                }
            } icon: {
                Image(systemName: "terminal")
            }
            .font(.callout).foregroundStyle(.secondary)
        }
    }

    private func sources(_ rules: PermissionRulesReply) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(rules.sources) { source in
                HStack(spacing: 6) {
                    TagChip(Text(verbatim: source.scope.displayName), tint: .secondary)
                    Text(verbatim: source.path)
                        .font(.caption.monospaced())
                        .lineLimit(1).truncationMode(.middle)
                        .textSelection(.enabled)
                    if let problem = source.problemText {
                        Text(verbatim: problem)
                            .font(.caption)
                            .foregroundStyle(source.error != nil ? Color.orange : Color.secondary)
                            .lineLimit(1).truncationMode(.tail)
                            .help(problem)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .accessibilityIdentifier("Terminal rule sources")
    }

    private func ruleList(_ rules: PermissionRulesReply) -> some View {
        Group {
            if rules.rules.isEmpty {
                Text("No allow rules in your Claude Code settings").foregroundStyle(.secondary)
                Spacer()
            } else {
                List(rules.rules) { rule in row(rule) }
                    .listStyle(.bordered)
                    .alternatingRowBackgrounds()
                    .accessibilityIdentifier("Terminal rules list")
            }
        }
    }

    private func row(_ rule: UserPermissionRule) -> some View {
        HStack(alignment: .top, spacing: 8) {
            if rule.importAs != nil {
                Toggle(isOn: Binding(get: { selected.contains(rule.id) },
                                     set: { on in if on { selected.insert(rule.id) } else { selected.remove(rule.id) } })) { EmptyView() }
                    .toggleStyle(.checkbox)
                    .labelsHidden()
                    .accessibilityLabel(Text("Import \(rule.rule)"))
            } else {
                Color.clear.frame(width: 14, height: 14)
            }
            Circle()
                .fill(rule.isApplied ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 7, height: 7)
                .padding(.top, 5)
                .help(rule.statusText)
                .accessibilityLabel(rule.statusText)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: rule.rule).font(.callout.monospaced()).textSelection(.enabled)
                    if rule.importIsRisky {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                            .help("This command can delete files, rewrite git history, reach the network or run other commands — import it only if you mean it")
                            .accessibilityLabel("Risky command")
                    }
                    Spacer(minLength: 4)
                    TagChip(Text(verbatim: rule.source.displayName), tint: .secondary)
                }
                Text(verbatim: rule.whyText).font(.caption).foregroundStyle(.secondary)
                if let importAs = rule.importAs, importAs != rule.rule {
                    Text("Imports as \(importAs)").font(.caption2.monospaced()).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Picker("Import into", selection: $toProject) {
                Text("All projects").tag(false)
                Text("This project (\(store.projectName))").tag(true)
            }
            .pickerStyle(.menu)
            .fixedSize()
            .disabled(store.projectInfo == nil)
            .accessibilityIdentifier("Import target")
            if let importResult {
                Text(verbatim: importResult).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button("Import \(selected.count)") { importSelected() }
                .buttonStyle(.borderedProminent)
                .disabled(selected.isEmpty || store.permissionRules == nil)
                .accessibilityIdentifier("Import terminal rules")
        }
    }

    private func importSelected() {
        guard let rules = store.permissionRules else { return }
        let patterns = rules.rules.filter { selected.contains($0.id) }.compactMap(\.importAs)
        let added = store.importAllowPatterns(patterns, toProject: toProject)
        if !toProject, !added.isEmpty {
            // The global list belongs to every window.
            for other in WorkbenchRegistry.shared.allStores where other !== store { other.pushPermissionSettings() }
        }
        importResult = added.isEmpty ? String(localized: "Already in the allow list") : String(localized: "Imported \(added.count)")
        selected = []
    }
}
