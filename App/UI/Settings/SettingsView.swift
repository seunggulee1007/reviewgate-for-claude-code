import SwiftUI
import ReviewGateCore

/// docs/PROTOCOL.md §55.11: Settings as panes in a sidebar (the old General tab split by what it holds), a search field
/// over all of them, and one "다음 세션부터 적용돼요 — [지금 재시작]" banner on every pane. The window is resizable and
/// starts short enough for a 637 pt high screen area.
struct SettingsView: View {
    /// §56.4: the pane shown — `/mcp`'s "Add in Settings…" opens Extensions (where MCP servers are added).
    typealias Tab = SettingsPane
    static let tabKey = "settingsTab"
    @AppStorage(SettingsView.tabKey) private var tab = SettingsPane.general.rawValue
    @State private var query = ""
    private var navigation: SettingsNavigation { .shared }

    private var pane: SettingsPane { SettingsPane(stored: tab) }

    private var results: [SettingEntry] { SettingsCatalog.search(query, localize: settingsLocalized) }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 190, ideal: 205, max: 260)
        } detail: {
            detail
        }
        .searchable(text: $query, placement: .sidebar, prompt: Text("Search settings"))
        .onSubmit(of: .search) { if let first = results.first { navigation.show(first.id) } }
        .toolbar(removing: .sidebarToggle)
        .frame(minWidth: 660, idealWidth: 740, minHeight: 380, idealHeight: 540)
    }

    // MARK: Sidebar

    @ViewBuilder
    private var sidebar: some View {
        if query.trimmingCharacters(in: .whitespaces).isEmpty {
            List(selection: Binding(get: { pane }, set: { if let new = $0 { tab = new.rawValue } })) {
                ForEach(SettingsPane.allCases) { pane in
                    Label { Text(LocalizedStringKey(pane.title)) } icon: { SettingsPaneIcon(pane: pane) }
                        .tag(pane)
                        .accessibilityIdentifier("Settings pane \(pane.rawValue)")
                }
            }
            .safeAreaInset(edge: .bottom) { legend }
        } else if results.isEmpty {
            ContentUnavailableView.search(text: query)
        } else {
            List {
                ForEach(SettingsPane.allCases.filter { p in results.contains { $0.pane == p } }) { pane in
                    Section(LocalizedStringKey(pane.title)) {
                        ForEach(results.filter { $0.pane == pane }) { entry in
                            SettingsSearchRow(entry: entry, current: navigation.highlighted == entry.id) { navigation.show(entry.id) }
                        }
                    }
                }
            }
            .accessibilityIdentifier("Settings search results")
        }
    }

    /// The badge model in one line, once: no badge = at once.
    private var legend: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: "clock.arrow.circlepath").accessibilityHidden(true)
            Text("Settings without a badge apply right away.")
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Detail

    private var detail: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                SettingsRestartBanner()
                paneView
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            // A search result or "Change Limit…": the pane switches first, then its row scrolls into view.
            .task(id: navigation.jumps) {
                guard let id = navigation.highlighted else { return }
                try? await Task.sleep(for: .milliseconds(150))
                withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .center) }
            }
        }
        .navigationTitle(Text(LocalizedStringKey(pane.title)))
    }

    @ViewBuilder
    private var paneView: some View {
        switch pane {
        case .general: GeneralSettingsPane()
        case .permissions: PermissionsSettingsPane()
        case .session: SessionSettingsPane()
        case .review: ReviewSettingsPane()
        case .git: GitSettingsPane()
        case .extensions: ExtensionsSettingsView()
        case .project: ProjectFlowSettingsView()   // wave3 mac-flow: commit template, workbench setup, PR command of this repository
        case .accounts: AccountsSettingsView()
        case .advanced: AdvancedSettingsPane()
        }
    }
}

/// A pane's symbol on a tinted square, as System Settings draws its own.
struct SettingsPaneIcon: View {
    let pane: SettingsPane

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 20, height: 20)
            .background(tint.gradient, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch pane {
        case .general: "gearshape.fill"
        case .permissions: "hand.raised.fill"
        case .session: "bubble.left.and.text.bubble.right.fill"
        case .review: "checkmark.seal.fill"
        case .git: "arrow.triangle.branch"
        case .extensions: "puzzlepiece.extension.fill"
        case .project: "folder.fill"
        case .accounts: "person.crop.circle.fill"
        case .advanced: "wrench.and.screwdriver.fill"
        }
    }

    private var tint: Color {
        switch pane {
        case .general, .advanced: .gray
        case .permissions: .orange
        case .session: .blue
        case .review: .green
        case .git: .red
        case .extensions: .indigo
        case .project: .teal
        case .accounts: .cyan
        }
    }
}

/// One search result: its title, where it is, and its badge.
private struct SettingsSearchRow: View {
    let entry: SettingEntry
    let current: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(LocalizedStringKey(entry.title)).lineLimit(2)
                    AppliesBadge(entry.applies)
                }
                if entry.section != entry.title {
                    Text(LocalizedStringKey(entry.section))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 2)
        .listRowBackground(current ? Color.accentColor.opacity(0.18) : nil)
        .help(entry.info.map { LocalizedStringKey($0) } ?? LocalizedStringKey(entry.title))
        .accessibilityIdentifier("Settings result \(entry.id)")
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
                    Text("GitHub accounts").settingAnchor("githubAccounts")
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
                        .help(newHost.trimmingCharacters(in: .whitespaces).isEmpty ? String(localized: "Type a host first") : "")
                        .accessibilityIdentifier("Log in new host")
                }
                .settingAnchor("addHost")
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
