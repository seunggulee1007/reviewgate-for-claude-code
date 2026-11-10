import SwiftUI
import ReviewGateCore

/// Open PRs authored by me / where my review is requested, fetched through `gh`.
/// Expects a `PRStore` in the environment.
struct PRListView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(PRStore.self) private var store
    /// The row just clicked while its `pr_open` is on the way; the highlight is the store's open PR otherwise, so it is
    /// still there after a visit to another tab and a click on the open PR does not open (and reset) it again.
    @State private var requested: PRSummary.ID?
    /// "Other…" in the host picker reveals the free-text field (also chosen when `store.host` is unknown).
    @State private var customHost = false

    private static let otherTag = "\u{0}other"

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            header
            Divider()
            if let error = store.errorText {
                errorBanner(error)
                Divider()
            }
            List(selection: selection) {
                section(String(localized: "Mine"), store.mine, empty: "No open PRs authored by you")
                section(String(localized: "Review requested"), store.reviewRequested, empty: "No PRs awaiting your review")
            }
            .listStyle(.sidebar)
        }
        .task {
            if store.accounts.isEmpty { await store.refreshAccounts() }
            if store.mine.isEmpty && store.reviewRequested.isEmpty { await store.refresh() }
        }
    }

    private var selection: Binding<PRSummary.ID?> {
        Binding(get: { requested ?? store.selectedSummary?.id }, set: { id in
            guard let id, id != store.selectedSummary?.id,
                  let pr = (store.mine + store.reviewRequested).first(where: { $0.id == id }) else { return }
            requested = id
            Task {
                await store.open(pr)
                if requested == id { requested = nil }
            }
        })
    }

    /// Hosts from `gh auth status`, plus the default and the currently selected host so the picker
    /// never falls back to "Other…" while accounts are still loading.
    private var knownHosts: [String] {
        var hosts = store.accounts.map(\.host)
        for extra in [PRStore.defaultHost, store.host] where !extra.isEmpty && !hosts.contains(extra) {
            hosts.append(extra)
        }
        return hosts
    }

    private var currentAccount: GHAccount? {
        store.accounts.first { $0.host == store.host }
    }

    private var header: some View {
        @Bindable var store = store
        let hostSelection = Binding<String>(
            get: { customHost ? Self.otherTag : store.host },
            set: { tag in
                if tag == Self.otherTag {
                    customHost = true
                } else {
                    customHost = false
                    store.host = tag
                    Task { await store.refresh() }
                }
            }
        )
        return HStack(spacing: 8) {
            Picker("GitHub host", selection: hostSelection) {
                ForEach(knownHosts, id: \.self) { host in
                    Text(host).tag(host)
                }
                Divider()
                Text("Other…").tag(Self.otherTag)
            }
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            .accessibilityIdentifier("GitHub host")
            if customHost {
                TextField("GitHub host", text: $store.host, prompt: Text(PRStore.defaultHost))
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.small)
                    .accessibilityIdentifier("GitHub host field")
                    .onSubmit { Task { await store.refresh() } }
            }
            if let account = currentAccount {
                Label {
                    if let login = account.login { Text(login) } else { Text("not logged in") }
                } icon: {
                    Image(systemName: account.ok ? "person.crop.circle.badge.checkmark" : "person.crop.circle.badge.xmark")
                }
                    .font(.caption)
                    .foregroundStyle(account.ok ? Color.secondary : Color.orange)
                    .lineLimit(1)
                    .help(account.detail)
                    .accessibilityIdentifier("GitHub login")
            }
            if store.isLoading {
                ProgressView().controlSize(.small)
            }
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refresh() } }
                .labelStyle(.iconOnly)
                .controlSize(.small)
                .accessibilityIdentifier("Refresh PRs")
                .disabled(store.isLoading)
                .help("Reload PR lists")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    /// `gh` stderr until the next success — or until ×; not logged in to this host: [Log in…] opens Terminal (as in
    /// Settings › Accounts). Refresh, above, retries.
    private func errorBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .lineLimit(6)
            Spacer(minLength: 0)
            if currentAccount?.ok == false {
                Button("Log in…") { store.openLoginInTerminal(host: store.host) }
                    .controlSize(.small)
                    .help(PRStore.loginCommand(host: store.host).map { String(localized: "Opens Terminal with `\($0)`. Press Refresh once the browser flow completes.") } ?? "")
                    .accessibilityIdentifier("PR error log in")
            }
            Button("Dismiss", systemImage: "xmark") { store.errorText = nil }
                .labelStyle(.iconOnly)
                .buttonStyle(IconButtonStyle(padding: 2))
                .foregroundStyle(.secondary)
                .help("Dismiss")
                .accessibilityIdentifier("Dismiss PR error")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))
    }

    @ViewBuilder
    private func section(_ title: String, _ prs: [PRSummary], empty: LocalizedStringKey) -> some View {
        Section("\(title) (\(prs.count))") {
            if prs.isEmpty {
                Text(empty).foregroundStyle(.secondary).font(.callout)
            } else {
                ForEach(prs) { pr in
                    row(pr).tag(pr.id)
                }
            }
        }
    }

    private func row(_ pr: PRSummary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(pr.repo).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                Text("· #\(pr.number)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if pr.isDraft {
                    Text("Draft").font(.caption2).padding(.horizontal, 4).background(Color.secondary.opacity(0.15), in: Capsule())
                }
                Spacer(minLength: 0)
            }
            Text(pr.title).font(.callout).lineLimit(2)
            HStack(spacing: 4) {
                Text(pr.author)
                Text("·")
                Text(pr.updatedAt, format: .relative(presentation: .named))
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
