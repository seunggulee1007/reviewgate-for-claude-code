import AppKit
import SwiftUI
import ReviewGateCore

// MARK: §72.1 — docs/PROTOCOL.md §72.1: `/hooks` in a classic chat — the hooks in effect, read-only, as the terminal's
// `/hooks` browser: grouped by event, each with its matcher, what it runs and where it is defined, and Open in Editor for
// its file. No hook is edited here (the terminal's browser does not edit either).

struct HooksSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var list: HooksList?
    @State private var failure: String?
    @State private var allEvents = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: HooksText.title).font(.headline)
                Spacer()
                Toggle(HooksText.allEvents, isOn: $allEvents)
                    .toggleStyle(.checkbox)
                    .controlSize(.small)
                    .disabled(list == nil)
                    .help(HooksText.allEventsHelp)
                    .accessibilityIdentifier("hooks.allEvents")
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help(String(localized: "Read the settings files again"))
                    .accessibilityLabel(String(localized: "Refresh"))
                    .accessibilityIdentifier("hooks.refresh")
            }
            Text(verbatim: HooksText.subtitle).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let off = HooksText.off(list?.off) {
                Label { Text(verbatim: off).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "pause.circle") }
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("hooks.off")
            }
            content
                .frame(maxWidth: .infinity, minHeight: 160, maxHeight: 380, alignment: .topLeading)
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: HooksText.sessionNote).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                filesMenu
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("hooks.done")
            }
        }
        .padding(16)
        .frame(width: 600)
        .task { await load() }
        .accessibilityIdentifier("Hooks sheet")
    }

    @ViewBuilder private var content: some View {
        if let failure {
            Text(verbatim: failure).font(.callout).foregroundStyle(.red).textSelection(.enabled)
        } else if let list {
            let groups = list.byEvent(allEvents: allEvents)
            if groups.isEmpty {
                Text(verbatim: HooksText.empty).font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(groups, id: \.event) { group in
                            EventGroup(event: group.event, hooks: group.hooks, files: list.files)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        } else {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text(verbatim: HooksText.loading).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    /// The settings files this chat reads — open one to add or change a hook (a missing one is disabled with why).
    private var filesMenu: some View {
        Menu(HooksText.filesHeading) {
            ForEach(list?.files ?? []) { file in
                Button(HooksText.source(file.source, plugin: file.plugin) + " — " + SessionNotices.abbreviatingHome(file.path)) {
                    HookFileOpener.open(file.path)
                }
                .disabled(!file.exists)
                .help(HooksText.openHelp(file.path, exists: file.exists))
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(list?.files.isEmpty ?? true)
        .help(String(localized: "Open a settings file this chat reads in your editor"))
        .accessibilityIdentifier("hooks.files")
    }

    private func load() async {
        do {
            list = try await store.hooksList()
            failure = nil
        } catch {
            failure = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }
}

/// One event's heading and its hooks.
private struct EventGroup: View {
    let event: String
    let hooks: [HookEntry]
    let files: [HookFile]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: event).font(.callout.weight(.semibold).monospaced())
                Text(verbatim: hooks.isEmpty ? HooksText.noHookForEvent : HooksText.count(hooks.count))
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(hooks) { HookRow(hook: $0) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hooks.event.\(event)")
    }
}

/// A hook: matcher, type, where it comes from, what it runs (selectable), its details, Open in Editor.
private struct HookRow: View {
    let hook: HookEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: HooksText.matcher(hook.matcher))
                    .font(.caption.monospaced())
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
                    .help(String(localized: "Matcher"))
                Text(verbatim: hook.type).font(.caption).foregroundStyle(.secondary)
                Text(verbatim: HooksText.source(hook.source, plugin: hook.plugin)).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1)
                if !hook.active {
                    Text(verbatim: HooksText.inactive).font(.caption.weight(.semibold)).foregroundStyle(.orange)
                }
                Spacer(minLength: 4)
                Button(HooksText.openInEditor) { HookFileOpener.open(hook.path) }
                    .buttonStyle(.link)
                    .font(.caption)
                    .disabled(hook.path.isEmpty)
                    .help(HooksText.openHelp(hook.path, exists: !hook.path.isEmpty))
                    .accessibilityIdentifier("hooks.open")
            }
            Text(verbatim: hook.text)
                .font(.caption.monospaced())
                .lineLimit(4)
                .truncationMode(.tail)
                .textSelection(.enabled)
                .foregroundStyle(hook.active ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .help(hook.text)
            let details = HooksText.details(hook)
            if !details.isEmpty {
                Text(verbatim: details).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "\(hook.event), \(HooksText.matcher(hook.matcher)), \(HooksText.source(hook.source, plugin: hook.plugin))"))
        .accessibilityIdentifier("hooks.row")
    }
}

/// Opens a settings file in the editor the diff's Open in Editor remembered, else the system's app for it.
@MainActor
enum HookFileOpener {
    static func open(_ path: String) {
        guard FileManager.default.fileExists(atPath: path) else { return }
        if let editor = ExternalEditor.preferred, editor != .finder {
            editor.open(path, line: 1)
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }
}
