import SwiftUI
import ReviewGateCore

// docs/PROTOCOL.md §55.11 — the pieces every Settings pane shares: a row's title with its ⓘ and "when it applies" badge
// (Core `SettingsCatalog`), the anchor search jumps to, and the one "다음 세션부터 적용돼요 — [지금 재시작]" banner.

/// Which row Settings scrolls to and highlights: set by a search result, or by "Change Limit…" and the like elsewhere.
@MainActor @Observable
final class SettingsNavigation {
    static let shared = SettingsNavigation()

    /// The catalog id of the row to scroll to and tint; cleared after a moment.
    private(set) var highlighted: String?
    /// Bumped with every jump, so the same row twice scrolls twice.
    private(set) var jumps = 0
    private var clearTask: Task<Void, Never>?

    /// Shows `id`'s pane (`SettingsView.tabKey`) and highlights its row.
    func show(_ id: String) {
        guard let entry = SettingsCatalog.entry(id) else { return }
        UserDefaults.standard.set(entry.pane.rawValue, forKey: SettingsView.tabKey)
        highlighted = id
        jumps &+= 1
        clearTask?.cancel()
        clearTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.2))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.6)) { self?.highlighted = nil }
        }
    }

    /// From outside Settings ("Change Limit…", "Versions…"): the row first, then the window.
    func open(_ id: String, with openSettings: OpenSettingsAction) {
        show(id)
        openSettings()
    }
}

/// A button elsewhere in the app that opens Settings on one row ("Change Limit…", "Versions…").
struct SettingsJumpButton: View {
    @Environment(\.openSettings) private var openSettings
    let title: LocalizedStringKey
    let id: String

    init(_ title: LocalizedStringKey, to id: String) {
        self.title = title
        self.id = id
    }

    var body: some View {
        Button(title) { SettingsNavigation.shared.open(id, with: openSettings) }
    }
}

/// The English catalog key in this app's language (the views' own `Text("…")` keys).
func settingsLocalized(_ key: String) -> String {
    Bundle.main.localizedString(forKey: key, value: key, table: nil)
}

/// A row's title from the catalog (or `title`), its ⓘ with the longer explanation and its badge when it does not apply at
/// once. Used as the label of a Toggle / Picker / TextField row.
struct SettingLabel: View {
    let id: String
    var title: Text?

    init(_ id: String, title: Text? = nil) {
        self.id = id
        self.title = title
    }

    var body: some View {
        let entry = SettingsCatalog.entry(id)
        HStack(spacing: 5) {
            title ?? Text(LocalizedStringKey(entry?.title ?? id))
            if let info = entry?.info { SettingInfoButton(text: info) }
            if let entry { AppliesBadge(entry.applies) }
        }
    }
}

/// ⓘ: the explanation that used to sit under the row as a paragraph — its tooltip, and a popover on click.
struct SettingInfoButton: View {
    let text: String
    @State private var shown = false

    var body: some View {
        Button { shown.toggle() } label: {
            Image(systemName: "info.circle")
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.borderless)
        .help(LocalizedStringKey(text))
        .accessibilityLabel(Text("More about this setting"))
        .popover(isPresented: $shown, arrowEdge: .bottom) {
            Text(LocalizedStringKey(text))
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 300, alignment: .leading)
                .padding(12)
        }
    }
}

/// "다음 세션부터" / "새 창부터" / "새 프로젝트부터"; nothing for a setting that applies at once.
struct AppliesBadge: View {
    let applies: SettingApplies

    init(_ applies: SettingApplies) { self.applies = applies }

    var body: some View {
        if let badge = applies.badge {
            TagChip(Text(LocalizedStringKey(badge)), systemImage: applies == .nextSession ? "arrow.clockwise" : "sparkle", tint: .orange)
                .help(LocalizedStringKey(applies.help ?? badge))
                .accessibilityElement(children: .combine)
        }
    }
}

extension View {
    /// The row search jumps to: its scroll anchor and a tint while it is the highlighted one.
    func settingAnchor(_ id: String) -> some View {
        modifier(SettingAnchor(id: id))
    }
}

private struct SettingAnchor: ViewModifier {
    let id: String
    @Environment(\.colorScheme) private var colorScheme
    private var navigation: SettingsNavigation { .shared }

    func body(content: Content) -> some View {
        content
            .background {
                if navigation.highlighted == id {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.accentColor.wash(colorScheme, light: 0.16, dark: 0.30))
                        .padding(.horizontal, -6).padding(.vertical, -3)
                        .transition(.opacity)
                        .allowsHitTesting(false)
                }
            }
            .id(id)
    }
}

// MARK: - Restart

/// Restarts this window's Claude session (the conversation resumes; the review list is kept) — the Extensions pane's
/// "Restart now", shared with Settings' banner.
struct SessionRestartButton: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let reason = Self.unavailableReason(store)
        Button("Restart now") { store.restartSession() }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(reason != nil)
            .help(reason ?? String(localized: "Restarting resumes this chat with the new settings; the review list is kept."))
            .accessibilityIdentifier("Restart now")
    }

    /// Why it cannot restart now; nil = it can.
    static func unavailableReason(_ store: AppState) -> String? {
        if store.isRunning { return String(localized: "Claude is working — wait for the turn to finish") }
        if !store.canRestartSession { return String(localized: "This window's session cannot restart right now") }
        return nil
    }
}

/// "다음 세션부터 적용돼요 — [지금 재시작]" on every pane while a setting this window's session read at its start changed
/// (`AppState.settingsWaitingForRestart`), or the Extensions pane's plugins / hooks / local settings differ from what it
/// applied. Lists what changed.
struct SettingsRestartBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.disabledPlugins) private var disabledRaw = ""
    @AppStorage(AppSettings.Key.disableUserHooks) private var disableUserHooks = false
    @AppStorage(AppSettings.Key.projectLoadLocalSettings) private var localSettingsRaw = Data()
    /// Bumped on every defaults change: the list reads UserDefaults.
    @State private var tick = 0

    private var names: [String] {
        _ = (tick, disabledRaw, disableUserHooks, localSettingsRaw)
        var ids = store.settingsWaitingForRestart
        if ExtensionSettingsLogic.needsRestart(applied: store.extensions, disabledPlugins: AppSettings.disabledPlugins(),
                                               disableUserHooks: disableUserHooks) || store.localSettingsNeedRestart {
            ids.append("disabledPlugins")
        }
        return ids.map { id in
            id == "disabledPlugins" ? settingsLocalized("Extensions") : settingsLocalized(SettingsCatalog.entry(id)?.title ?? id)
        }
    }

    var body: some View {
        let names = names
        Group {
            if !names.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.clockwise.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Changes apply from the next session").font(.callout.weight(.semibold))
                        Text("Changed: \(names.joined(separator: " · "))")
                            .font(.caption).foregroundStyle(.secondary)
                            .lineLimit(2)
                            .help(names.joined(separator: "\n"))
                    }
                    Spacer(minLength: 6)
                    SessionRestartButton()
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 16).padding(.top, 10)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("Settings restart banner")
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: names)
        .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in tick &+= 1 }
    }
}
