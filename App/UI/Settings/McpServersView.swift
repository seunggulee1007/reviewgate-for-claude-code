import AppKit
import SwiftUI
import ReviewGateCore

/// §22 MCP servers of the live session: status, source, transport, tools, error; reconnect / on-off / remove (scope-aware
/// confirmation) / log in; "Add server"; the restart and needs-auth banners. Secret values are never shown — the engine
/// only reports env / header keys.
struct McpServersSection: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    /// The capabilities popover: actions in a menu, tighter rows.
    var compact = false
    /// What the session applied (§16) — the fallback list before the first `mcp_status`.
    var applied: [MCPServerStatus] = []
    @State private var showAdd = false
    @State private var removeCandidate: McpServerInfo?
    @State private var expandedTools: Set<String> = []

    private var mcp: McpStore { store.mcp }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("MCP servers").font(.subheadline.weight(.semibold))
                Text(verbatim: "\(mcp.loaded ? mcp.servers.count : applied.count)")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 5).padding(.vertical, 0.5)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                Spacer(minLength: 4)
                McpConfigHeaderButton(compact: compact)
                if mcp.isSupported, store.isSessionOpen {
                    Button {
                        Task { await mcp.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .controlSize(.small)
                    .help("Refresh the server status")
                    .accessibilityLabel("Refresh MCP servers")
                    Button {
                        showAdd = true
                    } label: {
                        if compact { Image(systemName: "plus") } else { Label("Add server…", systemImage: "plus") }
                    }
                        .controlSize(.small)
                        .help("Add an MCP server to this session, the project or your user settings")
                        .accessibilityIdentifier("MCP add server")
                }
            }
            if mcp.needsRestart { restartBanner }
            if let server = mcp.authRequiredServer, !server.isEmpty { authBanner(server) }
            if let error = mcp.errorText {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(verbatim: error).font(.caption).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button { mcp.dismissError() } label: { Image(systemName: "xmark") }
                        .buttonStyle(IconButtonStyle(padding: 2)).foregroundStyle(.secondary)
                        .accessibilityLabel("Dismiss")
                }
                .padding(8)
                .background(Color.orange.wash(colorScheme, light: 0.08, dark: 0.14), in: RoundedRectangle(cornerRadius: 6))
                .accessibilityIdentifier("MCP error")
            }
            if mcp.loaded {
                if mcp.servers.isEmpty {
                    Text("No MCP servers. Add one, or configure them with claude mcp add.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(mcp.servers) { server in
                    serverRow(server)
                }
            } else if applied.isEmpty {
                Text("none").font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(Array(applied.enumerated()), id: \.offset) { _, server in
                    HStack(spacing: 6) {
                        Circle().fill(dotColor(McpServerStatus(lenient: server.status))).frame(width: 7, height: 7)
                        Text(verbatim: server.name).font(.callout.monospaced())
                        Spacer(minLength: 4)
                        Text(verbatim: McpText.status(McpServerStatus(lenient: server.status))).font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("MCP \(server.name)")
                }
            }
        }
        .task {
            if !mcp.loaded, store.isSessionOpen { await mcp.refresh() }
        }
        .sheet(isPresented: $showAdd) { McpAddServerSheet() }
        .alert("Remove MCP server?", isPresented: Binding(get: { removeCandidate != nil }, set: { if !$0 { removeCandidate = nil } }),
               presenting: removeCandidate) { server in
            // MARK: wave4d w4d-config — §42.3: where the engine cannot remove it, the command that does (to copy).
            if server.removeScope != nil {
                Button("Remove", role: .destructive) { Task { await mcp.remove(server) } }
            } else if let command = server.origin?.command {
                Button("Copy Command") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command, forType: .string)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { server in
            Text(verbatim: [McpText.removeExplanation(server), McpOriginText.terminalHint(server)].compactMap { $0 }.joined(separator: "\n\n"))
        }
    }

    // MARK: Banners

    private var restartBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.clockwise.circle.fill").foregroundStyle(.orange)
            Text("The MCP change applies from the next session").font(.callout.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button("Restart now") { mcp.configRestarted(); store.restartSession() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(!store.canRestartSession || store.isRunning)
                .help(store.isRunning ? String(localized: "Claude is working — wait for the turn to finish") : String(localized: "Restart the Claude session now"))
                .accessibilityIdentifier("MCP restart now")
        }
        .padding(10)
        .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("MCP restart banner")
    }

    private func authBanner(_ server: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "key.fill").foregroundStyle(.yellow)
            VStack(alignment: .leading, spacing: 2) {
                Text("“\(server)” needs you to log in").font(.callout.weight(.semibold))
                // MARK: wave4d w4d-config — §42.3: the terminal is open; the engine reconnects once the login took.
                if mcp.server(server)?.authWaiting == true {
                    Text(verbatim: McpOriginText.waitingForLogin).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 4)
            Button("Log in…") { Task { await mcp.login(server) } }
                .controlSize(.small)
                .help("Opens Terminal with claude /mcp, where you log in; ReviewGate then reconnects the server")
                .accessibilityIdentifier("MCP login banner")
            Button("Reconnect") { Task { await mcp.reconnect(server) } }
                .controlSize(.small)
                .disabled(mcp.busy.contains(server))
                .accessibilityIdentifier("MCP reconnect banner")
            Button { mcp.dismissAuthRequired() } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle(padding: 2)).foregroundStyle(.secondary)
                .accessibilityLabel("Dismiss")
        }
        .padding(10)
        .background(Color.yellow.wash(colorScheme, light: 0.10, dark: 0.14), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("MCP auth banner")
    }

    // MARK: Rows

    private func serverRow(_ server: McpServerInfo) -> some View {
        let busy = mcp.busy.contains(server.name)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if busy {
                    ProgressView().controlSize(.mini).frame(width: 9)
                } else {
                    Circle().fill(dotColor(server.isOff ? .disabled : server.status)).frame(width: 7, height: 7)
                        .help(Text(verbatim: McpText.status(server.status)))
                }
                Text(verbatim: server.name).font(.callout.monospaced().weight(.medium)).lineLimit(1).truncationMode(.middle)
                TagChip(Text(verbatim: McpText.source(server.source)), tint: sourceTint(server.source))
                if server.isOffForRepository {   // wave4d w4d-config (§42.3)
                    TagChip(Text(verbatim: McpOriginText.offEverywhere), tint: .orange)
                }
                if !compact {
                    Text(verbatim: McpText.transport(server.transport)).font(.caption2.monospaced()).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if let count = server.toolCount {
                    Button {
                        if expandedTools.contains(server.name) { expandedTools.remove(server.name) } else { expandedTools.insert(server.name) }
                    } label: {
                        HStack(spacing: 2) {
                            Text("\(count) MCP tools").font(.caption.monospacedDigit())
                            Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                                .rotationEffect(.degrees(expandedTools.contains(server.name) ? 180 : 0))
                        }
                        .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(server.tools.isEmpty)
                    .help("Show the tool names")
                } else {
                    Text(verbatim: McpText.status(server.isOff ? .disabled : server.status))
                        .font(.caption).foregroundStyle(server.needsAttention ? Color.orange : Color.secondary)
                }
                actions(server, busy: busy)
            }
            if let summary = configSummary(server) {
                Text(verbatim: summary)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.leading, 13)
                    .help(Text(verbatim: summary))
            }
            // MARK: wave4d w4d-config — §42.3: the file that defines it (a folder above the project: every project under it).
            if let origin = McpOriginText.line(server) {
                originLabel(origin, server)
            }
            if server.authWaiting, server.status == .needsAuth {
                Text(verbatim: McpOriginText.waitingForLogin)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 13)
            }
            if let error = server.error, !error.isEmpty {
                Text(verbatim: error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 13)
                    .textSelection(.enabled)
            }
            if expandedTools.contains(server.name), !server.tools.isEmpty {
                Text(verbatim: server.tools.joined(separator: "  "))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 13)
            }
        }
        .padding(.vertical, 3)
        .contextMenu { McpConfigItems(mcp: mcp, file: server.origin?.file) }
        .opacity(server.isOff ? 0.65 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("MCP \(server.name)")
    }

    @ViewBuilder
    private func actions(_ server: McpServerInfo, busy: Bool) -> some View {
        let on = !server.isOff
        if compact {
            Menu {
                actionItems(server, on: on)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(busy || !mcp.isSupported)
            .help(Text("Actions for \(server.name)"))   // MARK: wave4d w4d-speed — polish-10: the "⋯" menu has a name
            .accessibilityLabel(Text("Actions for \(server.name)"))
            .accessibilityIdentifier("MCP actions \(server.name)")
        } else {
            HStack(spacing: 4) {
                if server.status == .needsAuth {
                    Button("Log in…") { Task { await mcp.login(server.name) } }
                        .controlSize(.small)
                        .help("Opens Terminal with claude /mcp, where you log in; ReviewGate then reconnects the server")
                        .accessibilityIdentifier("MCP login \(server.name)")
                    if server.authWaiting {   // wave4d w4d-config (§42.3)
                        Button("Reconnect") { Task { await mcp.reconnect(server.name) } }
                            .controlSize(.small)
                            .accessibilityIdentifier("MCP reconnect after login \(server.name)")
                    }
                }
                Button {
                    Task { await mcp.reconnect(server.name) }
                } label: { Image(systemName: "arrow.triangle.2.circlepath") }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .controlSize(.small)
                    .disabled(!on)
                    .help("Reconnect")
                    .accessibilityLabel("Reconnect \(server.name)")
                Toggle(isOn: Binding(get: { on }, set: { value in Task { await mcp.setEnabled(server.name, enabled: value) } })) {
                    Text(verbatim: server.name)
                }
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.mini)
                .help(on ? "Turn off for this project (remembered)" : "Turn on")
                .accessibilityIdentifier("MCP toggle \(server.name)")
                if mcp.supportsRepositoryToggle {   // wave4d w4d-config (§42.3)
                    Menu {
                        repositoryItems(server)
                    } label: {
                        Image(systemName: "square.stack.3d.up")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Turn on or off in every workbench of this repository")
                    .accessibilityLabel(Text("Turn on or off in every workbench of this repository"))
                    .accessibilityIdentifier("MCP every worktree \(server.name)")
                }
                Button(role: .destructive) {
                    removeCandidate = server
                } label: { Image(systemName: "trash") }
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .controlSize(.small)
                    .disabled(!canAskRemove(server))
                    .help(Text(verbatim: server.removeScope == nil ? McpText.removeExplanation(server) : String(localized: "Remove…")))
                    .accessibilityLabel("Remove \(server.name)")
            }
            .disabled(busy || !mcp.isSupported)
        }
    }

    @ViewBuilder
    private func actionItems(_ server: McpServerInfo, on: Bool) -> some View {
        if server.status == .needsAuth {
            Button("Log in…", systemImage: "key") { Task { await mcp.login(server.name) } }
        }
        Button("Reconnect", systemImage: "arrow.triangle.2.circlepath") { Task { await mcp.reconnect(server.name) } }
            .disabled(!on)
        Button(on ? "Turn Off" : "Turn On", systemImage: on ? "pause.circle" : "play.circle") {
            Task { await mcp.setEnabled(server.name, enabled: !on) }
        }
        if mcp.supportsRepositoryToggle { repositoryItems(server) }   // wave4d w4d-config (§42.3)
        Divider()
        McpConfigItems(mcp: mcp, file: server.origin?.file)
        Divider()
        Button("Remove…", systemImage: "trash", role: .destructive) { removeCandidate = server }
            .disabled(!canAskRemove(server))
    }

    /// "Defined in …" — a click opens the file (`~/.claude.json` only reveals it: it is large and holds other state).
    @ViewBuilder
    private func originLabel(_ text: String, _ server: McpServerInfo) -> some View {
        let file = server.origin?.file
        let home = file.map(McpConfigFile.isHomeConfig) ?? false
        let hint = home
            ? String(localized: "Click to show it in Finder — it is a large file that also holds your other Claude Code state")
            : String(localized: "Click to open the file")
        let label = Text(verbatim: text)
            .font(.caption2)
            .foregroundStyle(server.isFromParentFolder ? Color.orange : Color.secondary)
            .lineLimit(2)
            .truncationMode(.middle)
        Button {
            guard let file else { return }
            if home { McpConfigOpener.reveal(file) } else { McpConfigOpener.open(file, mcp: mcp) }
        } label: { label }
            .buttonStyle(.plain)
            .onHover { inside in if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() } }
            .padding(.leading, 13)
            .help(Text(verbatim: "\(file ?? "")\n\(hint)"))
            .accessibilityIdentifier("MCP origin \(server.name)")
    }

    // MARK: wave4d w4d-config — §42.3

    /// On / off for every worktree of the repository (the switch stays this worktree's).
    @ViewBuilder
    private func repositoryItems(_ server: McpServerInfo) -> some View {
        Button("Turn Off in Every Workbench", systemImage: "pause.circle") {
            Task { await mcp.setEnabled(server.name, enabled: false, repository: true) }
        }
        .disabled(server.isOffForRepository)
        Button("Turn On in Every Workbench", systemImage: "play.circle") {
            Task { await mcp.setEnabled(server.name, enabled: true, repository: true) }
        }
        .disabled(!server.isOff)
    }

    /// The remove confirmation opens when the server can be removed, or to show the terminal command that removes it.
    private func canAskRemove(_ server: McpServerInfo) -> Bool {
        server.removeScope != nil || McpOriginText.terminalHint(server) != nil
    }

    private func configSummary(_ server: McpServerInfo) -> String? {
        guard let config = server.config else { return nil }
        var parts: [String] = []
        if let url = config.url { parts.append(url) }
        if let command = config.command { parts.append(([command] + config.args).joined(separator: " ")) }
        if !config.envKeys.isEmpty { parts.append("env: " + config.envKeys.joined(separator: ", ")) }
        if !config.headerKeys.isEmpty { parts.append(String(localized: "headers: ") + config.headerKeys.joined(separator: ", ")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func dotColor(_ status: McpServerStatus) -> Color {
        switch status {
        case .connected: .green
        case .failed: .red
        case .needsAuth: .yellow
        case .pending: .orange
        case .disabled, .unknown: .secondary.opacity(0.5)
        }
    }

    private func sourceTint(_ source: McpSource) -> Color {
        switch source {
        case .project: .blue
        case .user: .purple
        case .session: .teal
        case .plugin: .indigo
        default: .secondary
        }
    }
}

/// "Add server": name, where it goes (with what that means), stdio command / args / env or http / sse URL / headers.
struct McpAddServerSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var form = McpAddForm()
    @State private var adding = false
    @State private var refusal: String?
    /// Problems are shown once the user tried to add (or edited a field after that).
    @State private var showIssues = false
    @State private var commandLine = ""

    private var existing: [String] { store.mcp.servers.map(\.name) }
    private var issues: [McpAddForm.Issue] { form.issues(existingNames: existing) }
    /// wave3 mac-session (§36.6): "Local" picked while the engine is known not to have it.
    private var localScopeUnavailable: Bool { form.scope == .local && store.extensions != nil && !store.supportsSessionTools }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Add MCP server").font(.headline).padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    field("Name") {
                        TextField("github", text: $form.name)
                            .textFieldStyle(.roundedBorder)
                            .font(.body.monospaced())
                            .accessibilityIdentifier("MCP add name")
                    }
                    field("Where") {
                        Picker("Where", selection: $form.scope) {
                            ForEach(McpScope.allCases) { Text(verbatim: McpText.scopeTitle($0)).tag($0) }
                        }
                        .labelsHidden()
                        .pickerStyle(.radioGroup)
                        .accessibilityIdentifier("MCP add scope")
                        Text(verbatim: McpText.scopeExplanation(form.scope))
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if localScopeUnavailable {
                            // wave3 mac-session (§36.6): an engine before §36 refuses scope local.
                            Label(SessionToolsSupport.updateReason, systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(.orange)
                                .accessibilityIdentifier("MCP add local unavailable")
                        }
                    }
                    field("Transport") {
                        Picker("Transport", selection: $form.transport) {
                            Text("Command (stdio)").tag(McpAddForm.Transport.stdio)
                            Text(verbatim: "HTTP").tag(McpAddForm.Transport.http)
                            Text(verbatim: "SSE").tag(McpAddForm.Transport.sse)
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("MCP add transport")
                    }
                    if form.transport == .stdio { stdioFields } else { remoteFields }
                    if showIssues, !issues.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in
                                Label(issue.message, systemImage: "exclamationmark.circle.fill")
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("MCP add issues")
                    }
                    if let refusal {
                        Label(refusal, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 18).padding(.vertical, 6)
            }
            Divider()
            HStack {
                Label("Values are sent to Claude Code only; ReviewGate never shows them again.", systemImage: "lock")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    add()
                } label: {
                    if adding { ProgressView().controlSize(.small) } else { Text("Add") }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(adding || localScopeUnavailable)
                .accessibilityIdentifier("MCP add confirm")
            }
            .padding(14)
        }
        .frame(width: 520, height: 600)
    }

    private var stdioFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            field("Command") {
                TextField("npx -y @modelcontextprotocol/server-github", text: $commandLine)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .onChange(of: commandLine) { _, line in
                        let parts = McpAddForm.splitCommandLine(line)
                        form.command = parts.first ?? ""
                        form.args = Array(parts.dropFirst())
                    }
                    .accessibilityIdentifier("MCP add command")
                if !form.args.isEmpty {
                    Text("Command \(form.command) · \(form.args.count) arguments")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            pairsField("Environment", pairs: $form.env, keyPlaceholder: "API_KEY", addTitle: "Add variable")
        }
    }

    private var remoteFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            field("URL") {
                TextField("https://mcp.example.com/mcp", text: $form.url)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .accessibilityIdentifier("MCP add url")
            }
            pairsField("Headers", pairs: $form.headers, keyPlaceholder: "Authorization", addTitle: "Add header")
        }
    }

    private func pairsField(_ title: LocalizedStringKey, pairs: Binding<[McpAddForm.Pair]>, keyPlaceholder: String, addTitle: LocalizedStringKey) -> some View {
        field(title) {
            ForEach(pairs) { $pair in
                HStack(spacing: 6) {
                    TextField(keyPlaceholder, text: $pair.key)
                        .textFieldStyle(.roundedBorder)
                        .font(.callout.monospaced())
                        .frame(width: 150)
                    SecureField("value", text: $pair.value)
                        .textFieldStyle(.roundedBorder)
                        .font(.callout.monospaced())
                    Button {
                        pairs.wrappedValue.removeAll { $0.id == pair.id }
                    } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(IconButtonStyle(padding: 2))
                        .accessibilityLabel("Remove")
                }
            }
            Button(addTitle, systemImage: "plus") { pairs.wrappedValue.append(McpAddForm.Pair()) }
                .buttonStyle(.link)
                .font(.caption)
        }
    }

    private func field(_ title: LocalizedStringKey, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }
    }

    private func add() {
        showIssues = true
        refusal = nil
        guard issues.isEmpty, let config = form.config else { return }
        adding = true
        let name = form.trimmedName, scope = form.scope
        Task {
            let error = await store.mcp.add(name: name, scope: scope, config: config)
            adding = false
            if let error { refusal = error } else { dismiss() }
        }
    }
}
