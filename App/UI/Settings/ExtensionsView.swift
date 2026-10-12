import SwiftUI
import ReviewGateCore

/// §16 "Applied extensions": what the running session took from the user's setup — plugins (each with an on/off
/// switch, `settings.disabledPlugins`), settings-file and plugin hooks (one switch, `settings.disableUserHooks`),
/// MCP servers with their status, skills / commands, CLAUDE.md — and, when a switch differs from what the session
/// applied, "applies from the next session — Restart now". Used by Settings › Extensions, the composer's
/// capabilities popover and the fallback banner's sheet.
struct AppliedExtensionsView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.disabledPlugins) private var disabledRaw = ""
    @AppStorage(AppSettings.Key.disableUserHooks) private var disableUserHooks = false
    @AppStorage(AppSettings.Key.loadUserSettings) private var loadUserSettings = true
    // MARK: wave3 mac-session
    /// §36.6: observed so the restart notice follows the project's "Load local settings" switch.
    @AppStorage(AppSettings.Key.projectLoadLocalSettings) private var localSettingsRaw = Data()
    /// Popover form: tighter spacing, long lists capped.
    var compact = false

    /// Parsed from the observed `@AppStorage` value (same rules as `AppSettings.disabledPlugins`), so toggles re-render.
    private var disabled: [String] {
        var seen = Set<String>()
        return disabledRaw.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
    private var applied: SessionExtensions? { store.extensions }
    private var needsRestart: Bool {
        _ = localSettingsRaw   // wave3 mac-session (§36.6)
        return ExtensionSettingsLogic.needsRestart(applied: applied, disabledPlugins: disabled, disableUserHooks: disableUserHooks)
            || store.localSettingsNeedRestart
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 12 : 16) {
            if needsRestart { restartNotice }
            sourcesSection
            // wave3 mac-session (§36.6): what .claude/settings.local.json and the local MCP servers hold that this session left out.
            if let applied, let notApplied = applied.notApplied {
                NotAppliedLocalSection(notApplied: notApplied, byFallback: applied.fallback != nil, compact: compact)
            }
            if let applied {
                pluginsSection(applied)
                if let mods = applied.mods, !mods.isEmpty { ModsSection(mods: mods, compact: compact) }   // MARK: wave5 w5-graph (§43.3)
                hooksSection(applied)
                mcpSection(applied)
                skillsSection(applied)
                InstructionsSection(applied: applied, compact: compact)   // wave4d w4d-config (§42.3): CLAUDE.md, memory, subagents
            } else {
                Text("Open a project to see which plugins, hooks, MCP servers and CLAUDE.md files its Claude session applied.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                hooksToggle
            }
        }
        .onChange(of: disabledRaw) { _, _ in pushSettings() }
        .onChange(of: disableUserHooks) { _, _ in pushSettings() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Applied extensions")
    }

    /// `set_settings` to every open window's engine; each applies it at its next session start.
    private func pushSettings() {
        let ids = disabled, hooksOff = disableUserHooks
        for other in WorkbenchRegistry.shared.allStores { other.updateExtensionSettings(disabledPlugins: ids, disableUserHooks: hooksOff) }
        if !WorkbenchRegistry.shared.allStores.contains(where: { $0 === store }) {
            store.updateExtensionSettings(disabledPlugins: ids, disableUserHooks: hooksOff)
        }
    }

    // MARK: Restart notice

    private var restartNotice: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.clockwise.circle.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 1) {
                Text("Applies from the next session").font(.callout.weight(.semibold))
                Text("Restarting resumes this chat with the new extension settings; the review list is kept.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Button("Restart now") { store.restartSession() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!store.canRestartSession || store.isRunning)
                .help(store.isRunning ? String(localized: "Claude is working — wait for the turn to finish") : String(localized: "Restart the Claude session now"))
                .accessibilityIdentifier("Restart now")
        }
        .padding(10)
        .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Extensions restart notice")
    }

    // MARK: Sources

    private var sourcesSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let applied {
                if applied.loadsUserSettings {
                    Label("User and project settings are loaded", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else {
                    Label("Project settings only — your ~/.claude plugins, MCP servers and hooks are off", systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(.orange)
                }
                if let fallback = applied.fallback {
                    HStack(spacing: 6) {
                        Text("Extensions took longer than \(fallback.timeoutSeconds) s to load, so the session started without them")
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        Button("Retry with extensions") { Task { await store.retryWithExtensions() } }
                            .controlSize(.small)
                            .disabled(store.isRunning)
                    }
                }
            }
            if !loadUserSettings {
                Text("“Load user settings” is off in General, so new sessions skip your ~/.claude setup.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if store.projectURL != nil {
                LocalSettingsToggleRow()   // wave3 mac-session (§36.6): per project, default on
                    .padding(.top, 6)
            }
        }
        .font(.callout)
    }

    // MARK: Plugins

    private func pluginsSection(_ applied: SessionExtensions) -> some View {
        section(title: "Plugins", count: applied.plugins.count) {
            if applied.plugins.isEmpty {
                Text("No plugins").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(applied.plugins, id: \.key) { plugin in
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: plugin.name).font(.callout.weight(.medium))
                        Text(verbatim: [plugin.id ?? String(localized: "local folder"), plugin.version.map { "v\($0)" }]
                            .compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 4)
                    if plugin.enabled {
                        TagChip("Loaded", systemImage: "checkmark", tint: .green)
                    } else {
                        TagChip("Off", systemImage: "pause.fill", tint: .secondary)
                    }
                    Toggle(plugin.name, isOn: pluginBinding(plugin))
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .controlSize(.small)
                        .disabled(plugin.id == nil)
                        .help(plugin.id == nil ? String(localized: "Plugins loaded from a folder (--plugin-dir) cannot be turned off here")
                              : String(localized: "Turn this plugin on or off for new sessions"))
                        .accessibilityIdentifier("Plugin \(plugin.name)")
                }
            }
            if !applied.unresolvedDisabledPlugins.isEmpty {
                Text("Not found, ignored: \(applied.unresolvedDisabledPlugins.joined(separator: ", "))")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private func pluginBinding(_ plugin: ExtensionPlugin) -> Binding<Bool> {
        Binding(get: { !ExtensionSettingsLogic.isDisabled(plugin, in: disabled) },
                set: { on in disabledRaw = ExtensionSettingsLogic.setting(disabled, plugin: plugin, enabled: on).joined(separator: "\n") })
    }

    // MARK: Hooks

    private var hooksToggle: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text("Run hooks from settings files and plugins").font(.callout)
                Spacer(minLength: 8)
                Toggle("Run hooks from settings files and plugins", isOn: Binding(get: { !disableUserHooks }, set: { disableUserHooks = !$0 }))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .controlSize(.small)
                    .accessibilityIdentifier("User hooks")
            }
            Text("Off: hooks in ~/.claude and project settings and plugin hooks do not run — your statusLine is turned off too. ReviewGate's own safety hooks always stay on.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func hooksSection(_ applied: SessionExtensions) -> some View {
        section(title: "Hooks", count: applied.hooks.count) {
            hooksToggle
            ForEach(ExtensionSettingsLogic.hookGroups(applied.hooks), id: \.source) { group in
                VStack(alignment: .leading, spacing: 3) {
                    Text(hookSourceTitle(group.source)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(Array(group.hooks.enumerated()), id: \.offset) { _, hook in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Circle().fill(hook.active && !applied.userHooksDisabled ? Color.green : Color.secondary.opacity(0.5))
                                .frame(width: 7, height: 7)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: hook.plugin ?? abbreviate(hook.path)).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                                Text(verbatim: hook.events.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        .help(hook.path)
                    }
                }
            }
        }
    }

    private func hookSourceTitle(_ source: ExtensionHook.Source) -> LocalizedStringKey {
        switch source {
        case .user: "User settings"
        case .project: "Project settings"
        case .plugin: "Plugins"
        }
    }

    // MARK: MCP / skills / CLAUDE.md

    private func mcpSection(_ applied: SessionExtensions) -> some View {
        // §22: the live list with its actions once the engine reported it; the applied names until then.
        McpServersSection(compact: compact, applied: applied.mcpServers)
    }

    private func skillsSection(_ applied: SessionExtensions) -> some View {
        section(title: "Skills and commands", count: nil) {
            Text("\(applied.skills.count) skills · \(applied.slashCommands.count) commands")
                .font(.callout)
            let names = (applied.skills + applied.slashCommands.filter { !applied.skills.contains($0) }).sorted()
            if !names.isEmpty {
                Text(verbatim: names.prefix(compact ? 24 : 200).map { "/" + $0 }.joined(separator: "  "))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(compact ? 3 : nil)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Helpers

    private func section(title: LocalizedStringKey, count: Int?, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(title).font(.subheadline.weight(.semibold))
                if let count {
                    Text(verbatim: "\(count)")
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .padding(.horizontal, 5).padding(.vertical, 0.5)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                }
            }
            content()
        }
    }

    private func abbreviate(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }
}

/// Settings › Extensions.
struct ExtensionsSettingsView: View {
    var body: some View {
        ScrollView {
            AppliedExtensionsView()
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The fallback banner's "Extensions…".
struct ExtensionsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Applied extensions").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(14)
            Divider()
            ScrollView {
                AppliedExtensionsView()
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 540, height: 620)
    }
}
