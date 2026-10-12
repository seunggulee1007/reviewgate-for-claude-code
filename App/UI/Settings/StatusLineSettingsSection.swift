import SwiftUI
import ReviewGateCore

/// MARK: wave6 w6-statusline — §44.2: Settings › General › the Claude Code status line — show it (on by default; nothing
/// shows without a `statusLine` in the user's settings; every open window at once) and, for the focused window's project,
/// whether the project's own `statusLine` may run: code that came with the repository, allowed per project and bound to
/// that very command (a changed one asks again).
struct StatusLineSettingsSection: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.showStatusLine) private var showStatusLine = true
    /// Observed so the project's switch follows a change made in another window (the value itself is per project).
    @AppStorage(AppSettings.Key.projectStatusLineAllowed) private var allowedRaw = Data()

    var body: some View {
        Section("Claude Code status line") {
            Toggle("Show the Claude Code status line", isOn: $showStatusLine)
                .accessibilityIdentifier("Show the Claude Code status line")
            Text("Your own status line (the statusLine command of your Claude Code settings, such as the OMC HUD) under the message box, colored as in the terminal. It runs while a project is open and the chat is on screen.")
                .font(.caption).foregroundStyle(.secondary)
            configured
            if let project = store.statusLine.reply?.project {
                Toggle("Run this project's status line", isOn: projectAllowed)
                    .disabled(store.statusLine.reply?.disabled != nil)
                    .accessibilityIdentifier("Run this project's status line")
                LabeledContent("This project's") {
                    Text(verbatim: project.command).font(.caption.monospaced()).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                }
                .help(project.path)
                if changed {
                    Text("The command changed since you allowed it. Check it and turn this on again.")
                        .font(.caption).foregroundStyle(.orange)
                }
                Text("This project's .claude/settings.json has its own statusLine — a command that came with the repository. It runs only once you allow this very command here; a changed command asks again.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .onChange(of: showStatusLine) { _, _ in pushToEveryWindow() }
    }

    private var projectAllowed: Binding<Bool> {
        Binding(get: { _ = allowedRaw; return store.projectStatusLineAllowed },
                set: { store.setProjectStatusLineAllowed($0) })
    }

    private var changed: Bool {
        _ = allowedRaw
        return store.projectStatusLineChanged
    }

    /// What runs now, as the focused window's engine last said.
    @ViewBuilder
    private var configured: some View {
        if let reply = store.statusLine.reply {
            if reply.configured, let command = reply.command {
                LabeledContent("Command") {
                    Text(verbatim: command).font(.caption.monospaced()).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                }
                .help(reply.path ?? "")
            } else if reply.disabled == "disable_all_hooks" {
                Text("Turned off: a settings file says disableAllHooks, or \"Run hooks from settings files and plugins\" is off (Extensions).")
                    .font(.caption).foregroundStyle(.secondary)
            } else if reply.disabled == "managed_policy" {
                Text("Turned off by your organization's managed settings: they allow only their own status line, or could not be read.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Your Claude Code settings have no statusLine, so nothing extra is shown.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            // A run that failed — also the first one, when there are no lines to hover for the reason.
            if let error = reply.error {
                let why = error.code == "timeout" ? String(localized: "it did not answer in time") : error.message
                Text("The last run failed: \(why)")
                    .font(.caption).foregroundStyle(.orange)
                    .textSelection(.enabled)
            }
        }
    }

    private func pushToEveryWindow() {
        for store in WorkbenchRegistry.shared.allStores { store.pushStatusLineSettings() }
    }
}
