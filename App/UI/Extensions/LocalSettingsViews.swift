import SwiftUI
import ReviewGateCore

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.6 on the Mac: the per-project "Load local settings (settings.local.json)" switch and the "Not applied
// in the app" section (what .claude/settings.local.json and the local MCP servers hold that this session left out). Shown
// in Settings › Extensions, the composer's capabilities popover and the fallback banner's sheet.

/// The per-project switch, with what it loads and whether this session loaded it.
struct LocalSettingsToggleRow: View {
    @Environment(AppState.self) private var store
    /// Observed so the switch follows a change made in another view (the value itself is per project).
    @AppStorage(AppSettings.Key.projectLoadLocalSettings) private var raw = Data()

    private var isOn: Binding<Bool> {
        Binding(get: { _ = raw; return store.loadsLocalSettingsForProject },
                set: { store.setLoadsLocalSettingsForProject($0) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text("Load local settings (settings.local.json)").font(.callout)
                if let applied = store.extensions, store.supportsSessionTools {
                    if applied.loadsLocalSettings {
                        TagChip("Loaded", systemImage: "checkmark", tint: .green)
                    } else {
                        TagChip("Off", systemImage: "pause.fill", tint: .secondary)
                    }
                }
                Spacer(minLength: 8)
                Toggle("Load local settings (settings.local.json)", isOn: isOn)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .controlSize(.small)
                    .disabled(!canToggle)
                    .help(canToggle ? String(localized: "Load this project's .claude/settings.local.json and local MCP servers in new sessions")
                          : SessionToolsSupport.updateReason)
                    .accessibilityIdentifier("Load local settings")
            }
            Text("Hooks, environment variables and allow rules of this project's .claude/settings.local.json and its local MCP servers, as in the terminal. Permission cards and the review still apply. Applies from the next session.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !canToggle {
                Label(SessionToolsSupport.updateReason, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Load local settings unavailable")
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// An engine before §36 never loads them: off with a reason (only known once a session started).
    private var canToggle: Bool { store.extensions == nil || store.supportsSessionTools }
}

/// "Not applied in the app": hooks, env keys, local MCP servers and allow rules the session left out — names, commands and
/// counts only, never a value.
struct NotAppliedLocalSection: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.projectLoadLocalSettings) private var raw = Data()
    let notApplied: NotAppliedLocalSettings
    /// The §16 fallback dropped them (with the user settings) rather than the project's switch.
    let byFallback: Bool
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "doc.badge.ellipsis").foregroundStyle(.orange)
                Text("Not applied in the app").font(.subheadline.weight(.semibold))
            }
            Text(byFallback ? "Extensions did not start in time, so local settings are off too until you retry."
                 : "Local settings are off for this project. Claude in the terminal uses these; this session does not:")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !notApplied.hooks.isEmpty {
                group("Hooks") {
                    ForEach(Array(notApplied.hooks.prefix(compact ? 4 : 50).enumerated()), id: \.offset) { _, hook in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(verbatim: hook.event).font(.caption.weight(.medium))
                            Text(verbatim: hook.command).font(.caption.monospaced()).foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.middle)
                                .help(hook.command)
                        }
                    }
                }
            }
            if !notApplied.envKeys.isEmpty {
                group("Environment variables") {
                    Text(verbatim: notApplied.envKeys.joined(separator: ", ")).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(compact ? 2 : nil).textSelection(.enabled)
                }
            }
            if !notApplied.mcpServers.isEmpty {
                group("Local MCP servers") {
                    Text(verbatim: notApplied.mcpServers.joined(separator: ", ")).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(compact ? 2 : nil).textSelection(.enabled)
                }
            }
            if notApplied.allowRuleCount > 0 {
                Text("\(notApplied.allowRuleCount) allow rules").font(.caption).foregroundStyle(.secondary)
            }
            if byFallback {
                Button("Retry with extensions") { Task { await store.retryWithExtensions() } }
                    .controlSize(.small)
                    .disabled(store.isRunning)
                    .accessibilityIdentifier("Not applied retry")
            } else if !localOn {
                Button("Load local settings") { store.setLoadsLocalSettingsForProject(true) }
                    .controlSize(.small)
                    .help("Turns on “Load local settings” for this project; applies from the next session")
                    .accessibilityIdentifier("Load local settings now")
            }
        }
        .padding(10)
        .background(Color.orange.wash(colorScheme, light: 0.07, dark: 0.14), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Not applied in the app")
    }

    private var localOn: Bool { _ = raw; return store.loadsLocalSettingsForProject }

    private func group(_ title: LocalizedStringKey, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }
    }
}
