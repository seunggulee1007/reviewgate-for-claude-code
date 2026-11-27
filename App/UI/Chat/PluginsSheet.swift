import SwiftUI
import ReviewGateCore

// MARK: §72.3 — docs/PROTOCOL.md §72.3: `/plugin` in a classic chat — the terminal's plugin panel (Installed, Discover,
// Marketplaces) on Claude Code's own `claude plugin … --json` commands: turn a plugin on or off, update or uninstall it,
// install one a marketplace offers, add, update or remove a marketplace. What installs or deletes asks first; every
// command's words and output show under the list. Reload Plugins is `/reload-plugins`.

struct PluginsSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    /// What a typed `/plugin …` asked for (its tab, and an action to confirm or run).
    let request: PluginRequest
    /// The composer's line (a reload's summary, a refusal).
    let notify: (String, Bool) -> Void
    @State private var tab: PluginTab = .discover
    @State private var list: PluginsList?
    @State private var failure: String?
    @State private var busy: String?
    @State private var last: PluginResult?
    @State private var confirm: PendingPluginAction?
    @State private var newMarketplace = ""
    @State private var reloadNote: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: PluginText.title).font(.headline)
                Spacer()
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .disabled(busy != nil)
                    .help(busy != nil ? PluginText.busyBlocker : String(localized: "Ask Claude Code for the plugins again"))
                    .accessibilityLabel(String(localized: "Refresh"))
                    .accessibilityIdentifier("plugins.refresh")
            }
            Text(verbatim: PluginText.subtitle).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Picker("", selection: $tab) {
                ForEach(PluginTab.allCases, id: \.self) { t in Text(verbatim: tabTitle(t)).tag(t) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier("plugins.tabs")
            content
                .frame(maxWidth: .infinity, minHeight: 150, maxHeight: 280, alignment: .topLeading)
            resultLine
            Text(verbatim: PluginText.appliesNote).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                let blocker = store.reloadPluginsBlocker ?? (busy != nil ? PluginText.busyBlocker : nil)
                Button(PluginText.reloadButton) { reload(force: false) }
                    .disabled(blocker != nil)
                    .help(blocker ?? PluginText.reloadHelp)
                    .accessibilityIdentifier("plugins.reload")
                if let reloadNote {
                    Text(verbatim: reloadNote).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        .help(reloadNote)
                }
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("plugins.done")
            }
        }
        .padding(16)
        .frame(width: 620)
        .task {
            tab = request.tab
            if let word = request.unknown { last = PluginResult(action: nil, target: "", ok: false, message: PluginText.unknownSubcommand(word)) }
            await load()
            if let action = request.action, let target = request.target {
                if action.confirms { confirm = PendingPluginAction(action: action, target: target) } else { run(action, target) }
            }
        }
        .sheet(item: $confirm) { pending in
            PluginConfirmSheet(pending: pending, hasProject: store.projectInfo != nil) { scope in run(pending.action, pending.target, scope: scope) }
        }
        .accessibilityIdentifier("Plugins sheet")
    }

    private func tabTitle(_ t: PluginTab) -> String {
        guard let list else { return PluginText.tab(t) }
        let n = switch t {
        case .installed: list.installed.count
        case .discover: list.available.count
        case .marketplaces: list.marketplaces.count
        }
        return "\(PluginText.tab(t)) \(n)"
    }

    @ViewBuilder private var content: some View {
        if let failure {
            Text(verbatim: failure).font(.callout).foregroundStyle(.red).textSelection(.enabled)
        } else if let list {
            if let error = list.error {
                Text(verbatim: PluginText.listFailed(error)).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            } else {
                switch tab {
                case .installed: installed(list.installed)
                case .discover: discover(list.available)
                case .marketplaces: marketplaces(list.marketplaces)
                }
            }
        } else {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text(verbatim: PluginText.loading).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Installed

    @ViewBuilder private func installed(_ plugins: [PluginInstalled]) -> some View {
        if plugins.isEmpty {
            empty(PluginText.noneInstalled)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(plugins) { p in InstalledRow(plugin: p, busy: busy, run: { run($0, p.id) }, ask: { confirm = PendingPluginAction(action: $0, target: p.id) }) }
                }
            }
        }
    }

    // MARK: Discover

    @ViewBuilder private func discover(_ plugins: [PluginAvailable]) -> some View {
        if plugins.isEmpty {
            empty(PluginText.noneAvailable)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(plugins) { p in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    Text(verbatim: p.name).font(.callout.weight(.medium))
                                    Text(verbatim: "@" + p.marketplace).font(.caption).foregroundStyle(.secondary)
                                    if let v = p.version { Text(verbatim: v).font(.caption.monospaced()).foregroundStyle(.secondary) }
                                }
                                if let d = p.description {
                                    Text(verbatim: d).font(.caption).foregroundStyle(.secondary).lineLimit(2).help(d)
                                }
                            }
                            Spacer(minLength: 4)
                            Button(PluginText.installButton) { confirm = PendingPluginAction(action: .install, target: p.id) }
                                .controlSize(.small)
                                .disabled(busy != nil)
                                .help(busy != nil ? PluginText.busyBlocker : String(localized: "Install \(p.id) — you pick the scope first"))
                                .accessibilityIdentifier("plugins.install")
                        }
                        .padding(8)
                        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                        .accessibilityElement(children: .contain)
                    }
                }
            }
        }
    }

    // MARK: Marketplaces

    private func marketplaces(_ markets: [MarketplaceInfo]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if markets.isEmpty {
                empty(PluginText.noMarketplaces)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(markets) { m in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: m.name).font(.callout.weight(.medium))
                                    Text(verbatim: m.location).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                        .help(m.location)
                                }
                                Spacer(minLength: 4)
                                Button(PluginText.updateButton) { run(.marketplaceUpdate, m.name) }
                                    .controlSize(.small)
                                    .disabled(busy != nil)
                                    .help(busy != nil ? PluginText.busyBlocker : PluginText.marketplaceUpdateHelp)
                                Button(PluginText.removeButton) { confirm = PendingPluginAction(action: .marketplaceRemove, target: m.name) }
                                    .controlSize(.small)
                                    .disabled(busy != nil)
                                    .help(busy != nil ? PluginText.busyBlocker : PluginText.confirmMessage(.marketplaceRemove))
                            }
                            .padding(8)
                            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                            .accessibilityElement(children: .contain)
                        }
                    }
                }
            }
            HStack {
                TextField(PluginText.addMarketplacePlaceholder, text: $newMarketplace)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(addMarketplace)
                    .accessibilityIdentifier("plugins.marketplaceSource")
                let blocker = busy != nil ? PluginText.busyBlocker : newMarketplace.trimmingCharacters(in: .whitespaces).isEmpty ? PluginText.addMarketplaceBlocker : nil
                Button(PluginText.addMarketplaceButton, action: addMarketplace)
                    .disabled(blocker != nil)
                    .help(blocker ?? PluginText.confirmMessage(.marketplaceAdd))
                    .accessibilityIdentifier("plugins.addMarketplace")
            }
        }
    }

    private func addMarketplace() {
        let source = newMarketplace.trimmingCharacters(in: .whitespaces)
        guard !source.isEmpty, busy == nil else { return }
        confirm = PendingPluginAction(action: .marketplaceAdd, target: source)
    }

    private func empty(_ text: String) -> some View {
        Text(verbatim: text).font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 80)
    }

    // MARK: The last command

    @ViewBuilder private var resultLine: some View {
        if let busy {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text(verbatim: busy).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        } else if let last {
            VStack(alignment: .leading, spacing: 4) {
                Label { Text(verbatim: last.message).lineLimit(2) } icon: {
                    Image(systemName: last.ok ? "checkmark.circle" : "exclamationmark.triangle")
                }
                .font(.caption)
                .foregroundStyle(last.ok ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.orange))
                .help(last.message)
                if !last.output.isEmpty, last.output != last.message {
                    DisclosureGroup(PluginText.outputHeading) {
                        ScrollView {
                            Text(verbatim: last.output).font(.caption.monospaced()).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 90)
                    }
                    .font(.caption)
                    .accessibilityIdentifier("plugins.output")
                }
            }
            .accessibilityIdentifier("plugins.result")
        }
    }

    // MARK: Actions

    private func load() async {
        do {
            list = try await store.pluginsList()
            failure = nil
        } catch {
            failure = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    private func run(_ action: PluginAction, _ target: String, scope: String? = nil) {
        guard busy == nil else { return }
        busy = PluginText.running(action, target)
        Task {
            do {
                let r = try await store.runPlugin(action, target: target, scope: scope)
                last = r.ok ? r : PluginResult(action: action, target: target, ok: false, message: PluginText.failed(action, r.message), output: r.output)
                if r.ok, action == .marketplaceAdd { newMarketplace = "" }
            } catch {
                last = PluginResult(action: action, target: target, ok: false, message: (error as? EngineClientError)?.userMessage ?? error.localizedDescription)
            }
            busy = nil
            await load()
        }
    }

    private func reload(force: Bool) {
        Task {
            do {
                let r = try await store.reloadPlugins(force: force)
                let line = PluginText.reloaded(r)
                reloadNote = line
                notify(line, r.held)
            } catch {
                let why = (error as? EngineClientError)?.userMessage ?? error.localizedDescription
                reloadNote = why
                notify(why, true)
            }
        }
    }
}

/// One installed plugin: name, marketplace, version, scope, its switch (the CLI's enable / disable), Update, Uninstall.
private struct InstalledRow: View {
    let plugin: PluginInstalled
    let busy: String?
    let run: (PluginAction) -> Void
    let ask: (PluginAction) -> Void

    var body: some View {
        let blocker = busy != nil ? PluginText.busyBlocker : plugin.manageBlocker
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: plugin.name).font(.callout.weight(.medium))
                    if let m = plugin.marketplace { Text(verbatim: "@" + m).font(.caption).foregroundStyle(.secondary) }
                    Text(verbatim: plugin.version).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    Text(verbatim: PluginText.scope(plugin.scope)).font(.caption)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
                }
                if plugin.appOff {
                    Text(verbatim: PluginText.appOff).font(.caption).foregroundStyle(.orange)
                }
                ForEach(plugin.errors, id: \.self) { e in
                    Label { Text(verbatim: e).lineLimit(2) } icon: { Image(systemName: "exclamationmark.triangle") }
                        .font(.caption).foregroundStyle(.red).help(e)
                }
                ForEach(plugin.notes, id: \.self) { n in
                    Text(verbatim: n).font(.caption).foregroundStyle(.secondary).lineLimit(2).help(n)
                }
            }
            Spacer(minLength: 4)
            Toggle("", isOn: Binding(get: { plugin.enabled }, set: { run($0 ? .enable : .disable) }))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .disabled(blocker != nil)
                .help(blocker ?? PluginText.toggleHelp(enabled: plugin.enabled))
                .accessibilityLabel(Text(verbatim: plugin.name))
                .accessibilityIdentifier("plugins.toggle")
            Button(PluginText.updateButton) { run(.update) }
                .controlSize(.small)
                .disabled(blocker != nil || plugin.marketplace == nil)
                .help(blocker ?? PluginText.updateHelp)
            Button(PluginText.uninstallButton) { ask(.uninstall) }
                .controlSize(.small)
                .disabled(blocker != nil)
                .help(blocker ?? PluginText.confirmMessage(.uninstall))
        }
        .padding(8)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("plugins.installed.\(plugin.name)")
    }
}

/// An install, uninstall or marketplace change waiting for the user's yes.
struct PendingPluginAction: Identifiable, Equatable {
    let id = UUID()
    let action: PluginAction
    let target: String
}

/// The confirmation: what runs, why to be careful, and (to install) the scope, as the terminal's three install options.
struct PluginConfirmSheet: View {
    @Environment(\.dismiss) private var dismiss
    let pending: PendingPluginAction
    let hasProject: Bool
    let go: (String?) -> Void
    @State private var scope = "user"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: PluginText.confirmTitle(pending.action, pending.target)).font(.headline)
            Text(verbatim: PluginText.confirmMessage(pending.action)).font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if pending.action == .install {
                Picker(String(localized: "Scope"), selection: $scope) {
                    ForEach(["user", "project", "local"], id: \.self) { s in Text(verbatim: PluginText.installScope(s)).tag(s) }
                }
                .pickerStyle(.radioGroup)
                .disabled(!hasProject)
                .help(hasProject ? String(localized: "Where Claude Code turns it on") : String(localized: "Open a project to install for it — without one it installs for you"))
                .accessibilityIdentifier("plugins.scope")
            }
            Text(verbatim: "claude plugin \(pending.action.cliWords) \(pending.target)" + (pending.action == .install ? " --scope \(scope)" : ""))
                .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(PluginText.confirmButton(pending.action)) {
                    go(pending.action == .install ? scope : nil)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("plugins.confirm")
            }
        }
        .padding(16)
        .frame(width: 440)
    }
}
