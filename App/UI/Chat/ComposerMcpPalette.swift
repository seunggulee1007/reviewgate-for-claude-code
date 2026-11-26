import SwiftUI
import ReviewGateCore

/// MARK: composer parity — docs/PROTOCOL.md §56.4: `/mcp`, as in the terminal. `/mcp ` (picked from the slash palette, or
/// typed with a space) lists the session's MCP servers over the message box: ↑ / ↓ select, ↩ reconnects (logs in to a server
/// that needs it, turns on one that is off), ⌥↩ turns it on / off, ⌘↩ opens its config file, ⇥ completes the name, Esc
/// closes; what follows `/mcp ` filters by name. `/mcp reconnect|enable|disable <name>` + ↩ runs that at once. Each row
/// shows its spinner, then its status — the box stays usable meanwhile.
extension ComposerModel {
    /// The `/mcp` command the list is open for; nil when it is closed (the slash palette has `/mcp` while no space follows).
    func mcpCommand(_ store: AppState) -> McpCommand? {
        guard store.canUseSlashPalette, store.offersMcpCommand, slashToken == nil, !paletteForced else { return nil }
        return McpCommand.parse(draft)
    }

    func mcpRows(_ store: AppState, _ command: McpCommand) -> [McpPaletteRow] {
        McpPalette.rows(servers: store.mcpPaletteServers, busy: store.mcp.busy, filter: command.filter)
    }

    func selectedMcpRow(_ store: AppState, _ command: McpCommand) -> McpPaletteRow? {
        let rows = mcpRows(store, command)
        return rows.isEmpty ? nil : rows[min(mcpIndex, rows.count - 1)]
    }

    /// ↩: the row's own action (`/mcp`), or the typed one (`/mcp reconnect <name>` — the box empties and the notice line says
    /// how it went).
    func runMcpEnter(_ store: AppState, _ command: McpCommand) {
        switch command {
        case .list:
            guard let row = selectedMcpRow(store, command) else { NSSound.beep(); return }
            runMcp(McpPalette.primaryAction(row.server), row: row, store: store, typed: false)
        case let .run(verb, _) where command.isAll:
            runMcpOnEvery(McpPalette.action(for: verb), store: store, command: command)
        case let .run(verb, name):
            guard let row = McpPalette.target(name: name, rows: mcpRows(store, command), selection: mcpIndex) else {
                NSSound.beep()
                notice = McpPalette.noServer(name)
                return
            }
            runMcp(McpPalette.action(for: verb), row: row, store: store, typed: true)
        }
    }

    /// `/mcp <verb> all`: every server it can act on, one after the other; the notice line says how many and how it went.
    func runMcpOnEvery(_ action: McpRowAction, store: AppState, command: McpCommand) {
        let context = store.mcpPaletteContext
        let rows = mcpRows(store, command).filter { McpPalette.disabledReason(action, row: $0, context: context) == nil }
        guard !rows.isEmpty else {
            NSSound.beep()
            notice = McpPalette.unavailableReason(context) ?? McpPalette.noServer("")
            return
        }
        draft = ""
        notice = action.progress(count: rows.count)
        inputFocused = true
        Task { [weak self] in
            var failure: String?
            for row in rows {
                await store.runMcp(action, on: row.server.name)
                if failure == nil { failure = store.mcp.errorText }
            }
            self?.notice = failure ?? action.done(count: rows.count)
        }
    }

    /// Runs `action` on `row` unless it cannot (then a beep and why in the notice line).
    func runMcp(_ action: McpRowAction, row: McpPaletteRow, store: AppState, typed: Bool) {
        if let reason = McpPalette.disabledReason(action, row: row, context: store.mcpPaletteContext) {
            NSSound.beep()
            notice = reason
            return
        }
        let name = row.server.name
        if typed {
            draft = ""
            notice = action.progress(name)
        }
        inputFocused = true
        Task { [weak self] in
            await store.runMcp(action, on: name)
            guard typed, let self else { return }
            if let error = store.mcp.errorText {
                notice = error
            } else if let server = store.mcp.server(name) {
                notice = "\(name) — " + McpText.status(server.isOff ? .disabled : server.status)
            } else {
                notice = nil
            }
        }
    }

    /// ⌘↩ / the row's button: the file that defines the server.
    func openMcpConfig(_ row: McpPaletteRow, store: AppState) {
        guard let file = row.server.origin?.file else {
            NSSound.beep()
            notice = McpConfigOpener.openHelp(nil)
            return
        }
        McpConfigOpener.open(file, mcp: store.mcp)
    }

    /// ⇥: the selected server's name into the command.
    func completeMcpName(_ store: AppState, _ command: McpCommand) {
        guard let row = selectedMcpRow(store, command) else { NSSound.beep(); return }
        draft = command.completing(row.server.name)
        caretRequest = (draft as NSString).length
    }

    /// The list's keys; nil for a key it leaves to the box.
    func handleMcpKey(_ key: ComposerKey, store: AppState, command: McpCommand) -> Bool? {
        let rows = mcpRows(store, command)
        switch key {
        case .up:
            if !rows.isEmpty { mcpIndex = (min(mcpIndex, rows.count - 1) - 1 + rows.count) % rows.count }
            return true
        case .down:
            if !rows.isEmpty { mcpIndex = (min(mcpIndex, rows.count - 1) + 1) % rows.count }
            return true
        case .enter:
            runMcpEnter(store, command)
            return true
        case .optionEnter:
            guard let row = selectedMcpRow(store, command) else { NSSound.beep(); return true }
            runMcp(McpPalette.toggleAction(row.server), row: row, store: store, typed: false)
            return true
        case .commandEnter:
            guard let row = selectedMcpRow(store, command) else { NSSound.beep(); return true }
            openMcpConfig(row, store: store)
            return true
        case .tab:
            completeMcpName(store, command)
            return true
        case .escape:
            draft = ""   // as the terminal's dialog: the command goes with it
            return true
        case .pageUp, .pageDown, .commandSlash, .commandShiftEnter, .optionCommandEnter, .commandDelete, .backtab, .controlB,
             .digit, .space, .controlG, .controlR, .optionT:
            return nil
        }
    }
}

/// The list over the message box.
struct ComposerMcpPalette: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openSettings) private var openSettings
    @Environment(AppState.self) private var store
    #if DEBUG
    @Environment(WindowModel.self) private var model
    #endif
    let composer: ComposerModel
    let command: McpCommand

    private var mcp: McpStore { store.mcp }
    private var rows: [McpPaletteRow] { composer.mcpRows(store, command) }
    private var context: McpPaletteContext { store.mcpPaletteContext }
    private var selection: Int { rows.isEmpty ? -1 : min(composer.mcpIndex, rows.count - 1) }

    var body: some View {
        let rows = rows
        VStack(alignment: .leading, spacing: 0) {
            header
            if let error = mcp.errorText { errorLine(error) }
            Divider()
            if rows.isEmpty {
                emptyState
            } else {
                list(rows)
            }
            Divider()
            footer
        }
        .frame(maxWidth: 520, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.50 : 0.18), radius: 8, y: 2)
        .padding(12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("MCP servers")
        .accessibilityIdentifier("MCP palette")
        .task {
            // The live list (status, tools, where each is defined) as the terminal's /mcp shows it.
            if context.sessionOpen, mcp.isSupported { await mcp.refresh() }
        }
        #if DEBUG
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { model.debugMcpFrame = $0 }   // the composer check
        .onChange(of: rows.map(\.id), initial: true) { _, ids in model.debugMcpRows = ids }
        .onDisappear { model.debugMcpFrame = .zero; model.debugMcpRows = [] }
        #endif
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(verbatim: "/mcp").font(.callout.monospaced().weight(.semibold))
            Text("MCP servers").font(.callout.weight(.semibold))
            Text(verbatim: "\(store.mcpPaletteServers.count)")
                .font(.caption2.weight(.semibold).monospacedDigit())
                .padding(.horizontal, 5).padding(.vertical, 0.5)
                .background(Color.secondary.opacity(0.15), in: Capsule())
                .accessibilityLabel(Text("\(store.mcpPaletteServers.count) servers"))
            if case let .run(verb, _) = command {
                Text(verbatim: McpPalette.action(for: verb).title)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28), in: Capsule())
                    .help("↩ runs this on the server named after it, or on the selected one")
            }
            Spacer(minLength: 4)
            Button {
                Task { await mcp.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(IconButtonStyle(padding: 2))
            .controlSize(.small)
            .disabled(McpPalette.unavailableReason(context) != nil)
            .help(McpPalette.unavailableReason(context) ?? String(localized: "Refresh the server status"))
            .accessibilityLabel("Refresh MCP servers")
            .accessibilityIdentifier("MCP palette refresh")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    private func errorLine(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(verbatim: error).font(.caption).lineLimit(3).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            Spacer(minLength: 4)
            Button { mcp.dismissError() } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle(padding: 2)).foregroundStyle(.secondary)
                .help("Dismiss")
                .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Color.orange.wash(colorScheme, light: 0.08, dark: 0.14))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("MCP palette error")
    }

    @ViewBuilder
    private var emptyState: some View {
        HStack(spacing: 8) {
            if store.mcpPaletteServers.isEmpty {
                if !mcp.loaded, McpPalette.unavailableReason(context) == nil {
                    ProgressView().controlSize(.small)
                    Text("Loading MCP servers…")
                } else if let reason = McpPalette.unavailableReason(context), !mcp.loaded {
                    Text(verbatim: reason)
                } else {
                    Text("No MCP servers")
                    Spacer(minLength: 4)
                    Button("Add in Settings…") {
                        UserDefaults.standard.set(SettingsView.Tab.extensions.rawValue, forKey: SettingsView.tabKey)
                        openSettings()
                    }
                    .controlSize(.small)
                    .help("Opens Settings › Extensions, where “Add server…” adds one to this session, the project or your user settings")
                    .accessibilityIdentifier("MCP palette add in settings")
                }
            } else {
                Text("No server matches “\(command.filter)”")
            }
        }
        .font(.callout).foregroundStyle(.secondary)
        .padding(10)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("MCP palette empty")
    }

    private func list(_ rows: [McpPaletteRow]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        McpPaletteRowView(row: row, selected: index == selection, context: context,
                                          onSelect: { composer.mcpIndex = index },
                                          onAction: { composer.mcpIndex = index; composer.runMcp($0, row: row, store: store, typed: false) },
                                          onOpenConfig: { composer.openMcpConfig(row, store: store) })
                            .id(index)
                    }
                }
                .padding(4)
            }
            .frame(maxHeight: 260)
            .fixedSize(horizontal: false, vertical: rows.count <= 5)
            .onChange(of: selection, initial: true) { _, index in proxy.scrollTo(index) }
        }
    }

    private var footer: some View {
        Text("↑↓ select · ↩ reconnect / log in / turn on · ⌥↩ on/off · ⌘↩ config file · ⇥ complete · esc close")
            .font(.caption2).foregroundStyle(.secondary)
            .lineLimit(1).truncationMode(.tail)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .help("↑↓ select · ↩ reconnect (log in when it needs a login, turn on when it is off) · ⌥↩ turn on or off · ⌘↩ open the config file · ⇥ complete the name · esc close — or type /mcp reconnect <name>")
    }
}

/// One server: status dot (a spinner while an action runs), name, where it comes from, tools, status, and its actions.
private struct McpPaletteRowView: View {
    @Environment(\.colorScheme) private var colorScheme
    let row: McpPaletteRow
    let selected: Bool
    let context: McpPaletteContext
    let onSelect: () -> Void
    let onAction: (McpRowAction) -> Void
    let onOpenConfig: () -> Void

    private var server: McpServerInfo { row.server }
    private var primary: McpRowAction { McpPalette.primaryAction(server) }
    private var toggle: McpRowAction { McpPalette.toggleAction(server) }

    var body: some View {
        HStack(spacing: 6) {
            if row.busy {
                ProgressView().controlSize(.mini).frame(width: 9)
                    .accessibilityLabel("Working…")
            } else {
                Circle().fill(dotColor).frame(width: 7, height: 7)
                    .accessibilityHidden(true)
            }
            Text(verbatim: server.name)
                .font(.callout.monospaced().weight(.medium))
                .lineLimit(1).truncationMode(.middle)
                .help(rowHelp)   // on the name: a tooltip on the whole row would hide its buttons' own (polish PX-02)
            if server.source != .unknown {
                TagChip(Text(verbatim: McpText.source(server.source)), tint: .secondary)
            }
            Spacer(minLength: 4)
            if let count = server.toolCount {
                Text("\(count) MCP tools").font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1).fixedSize()
            }
            Text(verbatim: row.statusText)
                .font(.caption)
                .foregroundStyle(server.needsAttention && !server.isOff ? Color.orange : Color.secondary)
                .lineLimit(1)
                .fixedSize()
            actions
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .contentShape(Rectangle())
        .background(selected ? Color.accentColor.wash(colorScheme, light: 0.22, dark: 0.32) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .opacity(server.isOff && !row.busy ? 0.7 : 1)
        .onHover { if $0 { onSelect() } }
        .onTapGesture { onSelect() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: accessibilityText))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityAction(named: Text(verbatim: primary.title)) { onAction(primary) }
        .accessibilityAction(named: Text(verbatim: toggle.title)) { onAction(toggle) }
        .accessibilityAction(named: Text("Open Config File")) { onOpenConfig() }
        .accessibilityIdentifier("MCP palette \(server.name)")
    }

    private var actions: some View {
        HStack(spacing: 4) {
            let primaryReason = McpPalette.disabledReason(primary, row: row, context: context)
            Button(primary.title) { onAction(primary) }
                .controlSize(.small)
                .fixedSize()
                .disabled(primaryReason != nil)
                .help(primaryReason ?? String(localized: "\(primary.title) (↩)"))
                .accessibilityIdentifier("MCP palette primary \(server.name)")
            let toggleReason = McpPalette.disabledReason(toggle, row: row, context: context)
            Toggle(isOn: Binding(get: { !server.isOff }, set: { _ in onAction(toggle) })) {
                Text(verbatim: server.name)
            }
            .toggleStyle(.switch)
            .labelsHidden()
            .controlSize(.mini)
            .disabled(toggleReason != nil)
            .help(toggleReason ?? String(localized: "\(toggle.title) (⌥↩)"))
            .accessibilityLabel(Text(verbatim: toggle.title + " " + server.name))
            .accessibilityIdentifier("MCP palette toggle \(server.name)")
            Button(action: onOpenConfig) { Image(systemName: "doc.text") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .controlSize(.small)
                .disabled(server.origin?.file == nil)
                .help(server.origin?.file == nil ? McpConfigOpener.openHelp(nil) : McpConfigOpener.openHelp(server.origin?.file) + " (⌘↩)")
                .accessibilityLabel("Open Config File")
                .accessibilityIdentifier("MCP palette config \(server.name)")
        }
    }

    private var rowHelp: String {
        var lines = [server.name + " — " + row.statusText]
        if let error = server.error, !error.isEmpty { lines.append(error) }
        lines.append(String(localized: "↩ \(primary.title) · ⌥↩ \(toggle.title) · ⌘↩ Open Config File"))
        return lines.joined(separator: "\n")
    }

    private var accessibilityText: String {
        var parts = [server.name]
        if server.source != .unknown { parts.append(McpText.source(server.source)) }
        parts.append(row.statusText)
        if let count = server.toolCount { parts.append(String(localized: "\(count) MCP tools")) }
        if let error = server.error, !error.isEmpty { parts.append(error) }
        return parts.joined(separator: ", ")
    }

    private var dotColor: Color {
        if server.isOff { return .secondary.opacity(0.5) }
        switch server.status {
        case .connected: return .green
        case .failed: return .red
        case .needsAuth: return .yellow
        case .pending: return .orange
        case .disabled, .unknown: return .secondary.opacity(0.5)
        }
    }
}
