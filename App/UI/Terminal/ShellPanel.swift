import AppKit
import Observation
import ReviewGateCore
import SwiftUI

// MARK: terminal-chat (§57.6)
/// The window's bottom terminal panel, as in VS Code / Cursor: shell tabs in the window's project (or workbench) folder.
/// ⌃` shows it (and a first tab), focuses it, or hides it; a shell that exits 0 closes its tab; the last tab closing hides
/// the panel. The hosts live here, so hiding the panel or switching tabs never ends a shell.
@MainActor @Observable
final class ShellPanelModel {
    struct Tab: Identifiable {
        let id = UUID()
        let host: TerminalHost
        /// "zsh 1", "zsh 2" … when the shell sets no title of its own.
        let name: String
        /// The folder it started in.
        let cwd: String
    }

    /// MARK: c-panel (§57.18): the panel's tabs — the shells, the window's output, the run configurations; ide-nav (§65.8):
    /// Find References' results.
    enum PanelTab: String, CaseIterable { case terminal, output, run, references }

    var visible = false
    private(set) var tabs: [Tab] = []
    var selectedId: UUID?
    /// §57.18: the tab the panel shows, remembered for every window (user defaults `terminalPanelTab`).
    var tab: PanelTab = PanelTab(rawValue: UserDefaults.standard.string(forKey: "terminalPanelTab") ?? "") ?? .terminal {
        didSet { UserDefaults.standard.set(tab.rawValue, forKey: "terminalPanelTab") }
    }
    /// §57.18: the run tab — its commands as listed, the PTY of each one started, the one shown, the one asking first.
    var runs = RunPanelModel()
    @ObservationIgnored private var opened = 0
    /// The folder a new tab starts in: the window's project (worktree or workbench), read when the tab is made.
    @ObservationIgnored var cwd: () -> String? = { nil }
    /// Hiding with ⌃` gives the keyboard back to the chat (its terminal, else the message box).
    @ObservationIgnored var focusChat: () -> Void = {}

    var selected: Tab? { tabs.first { $0.id == selectedId } ?? tabs.last }

    /// ⌃` / View › Toggle Terminal Panel: hidden → shown with the keyboard (a first tab when there is none); shown and
    /// focused → hidden, the keyboard back to the chat; shown but not focused → the keyboard to it.
    /// §57.18: on the 출력 or 실행 tab ⌃` shows the panel there, and hides it when shown.
    func toggle() {
        if !visible {
            visible = true
            guard tab == .terminal else { return }
            if tabs.isEmpty { newTab() } else { focusSelected() }
        } else if tab != .terminal || selected?.host.isFocused == true {
            visible = false
            focusChat()
        } else {
            focusSelected()
        }
    }

    /// §57.18: the status bar's buttons and the panel's tab bar — the panel on `tab` (a first shell for the terminal).
    func show(_ tab: PanelTab) {
        self.tab = tab
        visible = true
        if tab == .terminal {
            if tabs.isEmpty { newTab() } else { focusSelected() }
        }
    }

    /// The panel's `+`: a new shell in the project folder.
    func newTab() {
        guard let folder = cwd() else { return }
        let height = UserDefaults.standard.object(forKey: "terminalPanelHeight") as? Double ?? 220
        let host = TerminalHost(size: NSSize(width: 900, height: max(80, height - 40)))
        opened += 1
        let shell = TerminalHub.debugShell ?? TerminalLaunch.userLoginShell()
        let tab = Tab(host: host, name: "\((shell as NSString).lastPathComponent) \(opened)", cwd: folder)
        tabs.append(tab)
        selectedId = tab.id
        self.tab = .terminal
        visible = true
        host.onExit = { [weak self] code in
            // VS Code: a shell that ends cleanly (exit, ⌃D) takes its tab with it; any other end stays to be read.
            if code == 0 { self?.close(tab.id) }
        }
        host.start(launch: TerminalLaunch.shell(cwd: folder, parentEnv: ProcessInfo.processInfo.environment,
                                                loginShell: TerminalLaunch.userLoginShell(), appVersion: TerminalHub.appVersion,
                                                debugShell: TerminalHub.debugShell))
    }

    /// A tab's ×: its shell ends (SIGTERM, then SIGKILL after 3 s).
    func close(_ id: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        let tab = tabs.remove(at: index)
        Task { await tab.host.stop() }
        if selectedId == id { selectedId = tabs.indices.contains(index) ? tabs[index].id : tabs.last?.id }
        guard self.tab == .terminal else { return }   // §57.18: a shell ending behind 출력 / 실행 leaves the panel as it is
        if tabs.isEmpty {
            visible = false
            focusChat()
        } else {
            focusSelected()
        }
    }

    /// An exited tab's Restart: the same folder, a fresh shell.
    func restart(_ id: UUID) {
        guard let tab = tabs.first(where: { $0.id == id }) else { return }
        Task {
            await tab.host.restart(launch: TerminalLaunch.shell(cwd: tab.cwd, parentEnv: ProcessInfo.processInfo.environment,
                                                                loginShell: TerminalLaunch.userLoginShell(),
                                                                appVersion: TerminalHub.appVersion, debugShell: TerminalHub.debugShell))
        }
    }

    func select(_ id: UUID) {
        selectedId = id
        focusSelected()
    }

    /// Every shell ends (the window closes, the project changes).
    func stopAll() async {
        let hosts = tabs.map(\.host) + runs.takeAll()
        tabs = []
        selectedId = nil
        visible = false
        await TerminalHub.stop(hosts)
    }

    /// Quit: SIGTERM to every shell (and every run, §57.18) without waiting.
    func terminateAll() {
        for tab in tabs where tab.host.view.process.running { tab.host.terminate() }
        runs.terminateAll()
    }

    private func focusSelected() {
        guard let host = selected?.host else { return }
        DispatchQueue.main.async { host.focus() }
    }
}

/// The panel under the diff and the chat: a tab bar (each tab's shell, `+`, hide) over the selected shell.
struct ShellPanelView: View {
    @Environment(WindowModel.self) private var model
    /// The panel's height as last dragged (every window).
    @AppStorage("terminalPanelHeight") private var height = 220.0
    /// The height when the drag on the edge began.
    @State private var dragStart: Double?
    /// §57.18: the 출력 tab's search (per window, not remembered).
    @State private var outputQuery = ""

    var body: some View {
        let shell = model.shell
        VStack(spacing: 0) {
            // The top edge: drag to make the panel taller or shorter (the window keeps 200 pt above it).
            Divider()
                .frame(height: 5)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .onHover { inside in if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() } }
                .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { drag in
                        let start = dragStart ?? height
                        dragStart = start
                        height = min(max(start - drag.translation.height, 120), 900)
                    }
                    .onEnded { _ in dragStart = nil })
                .help(String(localized: "Drag to resize the terminal panel"))
                .accessibilityHidden(true)
            HStack(spacing: 2) {
                // MARK: c-panel (§57.18): 터미널 · 출력 · 실행
                PanelTabBar()
                Divider().frame(height: 14).padding(.horizontal, 4)
                switch shell.tab {
                case .terminal:
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 2) {
                            ForEach(shell.tabs) { tab in
                                ShellTabButton(tab: tab, isSelected: tab.id == shell.selected?.id)
                            }
                        }
                    }
                    Spacer(minLength: 4)
                    Button { shell.newTab() } label: { Image(systemName: "plus") }
                        .buttonStyle(.icon)
                        .controlSize(.small)
                        .help(String(localized: "New terminal in the project folder"))
                        .accessibilityLabel(Text("New terminal"))
                        .accessibilityIdentifier("Shell panel new tab")
                case .output:
                    Spacer(minLength: 4)
                    OutputPanelControls(query: $outputQuery)
                case .run:
                    Spacer(minLength: 4)
                case .references:   // MARK: ide-nav (§65.8)
                    ReferencesPanelControls()
                }
                Button { shell.visible = false; shell.focusChat() } label: { Image(systemName: "chevron.down") }
                    .buttonStyle(.icon)
                    .controlSize(.small)
                    .help(String(localized: "Hide the terminal panel (⌃`) — its shells keep running"))
                    .accessibilityLabel(Text("Hide the terminal panel"))
                    .accessibilityIdentifier("Shell panel hide")
            }
            .padding(.horizontal, 8).padding(.vertical, 3)
            Divider()
            switch shell.tab {
            case .terminal:
                if let tab = shell.selected {
                    TerminalContainer(host: tab.host)
                        .id(tab.id)
                        .overlay { ShellExitedOverlay(tab: tab) }
                        .accessibilityIdentifier("Shell panel terminal")
                } else {
                    VStack(spacing: 8) {
                        Text("No terminal is open.").font(.callout).foregroundStyle(.secondary)
                        Button("New Terminal") { shell.newTab() }
                            .controlSize(.small)
                            .help(String(localized: "New terminal in the project folder"))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .output:
                OutputPanelView(query: outputQuery)
            case .run:
                RunPanelView()
            case .references:
                ReferencesPanelView()
            }
        }
        .frame(minHeight: 80, idealHeight: height, maxHeight: height)
        .layoutPriority(1)   // its height first; the review and the chat keep the rest (200 pt at least)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Shell panel")
    }
}

/// MARK: c-panel (§57.18): the panel's tabs — 터미널 (the shells), 출력, 실행 (with how many commands run).
private struct PanelTabBar: View {
    @Environment(WindowModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let shell = model.shell
        HStack(spacing: 2) {
            ForEach(ShellPanelModel.PanelTab.allCases, id: \.self) { tab in
                let selected = shell.tab == tab
                Button { shell.show(tab) } label: {
                    HStack(spacing: 4) {
                        Text(verbatim: PanelTabText.title(tab)).font(.caption.weight(selected ? .semibold : .regular))
                        if tab == .run, shell.runs.runningCount > 0 {
                            Text(verbatim: "\(shell.runs.runningCount)").font(.caption2.monospacedDigit())
                                .padding(.horizontal, 4)
                                .background(Color.green.opacity(0.25), in: Capsule())
                        }
                    }
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .foregroundStyle(selected ? .primary : .secondary)
                    .background(selected ? Color.primary.opacity(colorScheme == .dark ? 0.14 : 0.08) : .clear, in: RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(PanelTabText.help(tab))
                .accessibilityAddTraits(selected ? [.isSelected] : [])
                .accessibilityIdentifier("Panel tab \(tab.rawValue)")
            }
        }
    }
}

/// The tabs' words, shared by the panel and the status bar.
enum PanelTabText {
    static func title(_ tab: ShellPanelModel.PanelTab) -> String {
        switch tab {
        case .terminal: String(localized: "Terminal")
        case .output: String(localized: "panel.output", defaultValue: "Output")
        case .run: String(localized: "panel.run", defaultValue: "Run")
        case .references: String(localized: "panel.references", defaultValue: "References")
        }
    }

    static func help(_ tab: ShellPanelModel.PanelTab) -> String {
        switch tab {
        case .terminal: String(localized: "Terminal panel (⌃`)")
        case .output: String(localized: "Output — ReviewGate's log and the Bash commands Claude ran")
        case .run: String(localized: "Run — the project's commands (dev server, tests), each in its own terminal")
        case .references: String(localized: "References — where a name is used (⇧F12 on it); F4 / ⇧F4 step through them")
        }
    }
}

/// MARK: c-panel (§57.18): the bar under the window while the panel is hidden — the way to it for anyone who does not
/// know ⌃`: 터미널 · 출력 · 실행, and how many commands are running.
struct PanelStatusBar: View {
    @Environment(WindowModel.self) private var model

    var body: some View {
        let shell = model.shell
        HStack(spacing: 2) {
            Spacer()
            ForEach(ShellPanelModel.PanelTab.allCases, id: \.self) { tab in
                Button { shell.show(tab) } label: {
                    HStack(spacing: 3) {
                        Image(systemName: icon(tab)).font(.caption2)
                        Text(verbatim: PanelTabText.title(tab)).font(.caption2)
                        if tab == .run, shell.runs.runningCount > 0 {
                            Text(verbatim: "\(shell.runs.runningCount)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
                        }
                    }
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .contentShape(Rectangle())
                }
                .buttonStyle(IconButtonStyle(padding: 0))
                .foregroundStyle(.secondary)
                .help(PanelTabText.help(tab))
                .accessibilityLabel(Text(verbatim: PanelTabText.title(tab)))
                .accessibilityIdentifier("Panel status \(tab.rawValue)")
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Panel status bar")
    }

    private func icon(_ tab: ShellPanelModel.PanelTab) -> String {
        switch tab {
        case .terminal: "apple.terminal"
        case .output: "text.alignleft"
        case .run: "play.circle"
        case .references: "text.magnifyingglass"
        }
    }
}

/// One shell tab: its title (what the shell set, else "zsh 1"), "exited (n)" when it ended, ×.
private struct ShellTabButton: View {
    @Environment(WindowModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    let tab: ShellPanelModel.Tab
    let isSelected: Bool
    @State private var hovering = false

    var body: some View {
        let title = tab.host.title.isEmpty ? tab.name : tab.host.title
        HStack(spacing: 4) {
            Button { model.shell.select(tab.id) } label: {
                HStack(spacing: 4) {
                    Image(systemName: "apple.terminal").font(.caption2)
                    Text(verbatim: title).font(.caption).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160)
                    if case let .exited(code, _) = tab.host.state {
                        Text(code.map { String(localized: "exited (\(Int($0)))") } ?? String(localized: "stopped"))
                            .font(.caption2).foregroundStyle(.orange)
                    }
                }
                .padding(.leading, 8).padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "\(title) — in \(tab.cwd)"))
            .accessibilityIdentifier("Shell tab \(tab.name)")
            Button { model.shell.close(tab.id) } label: {
                Image(systemName: "xmark").font(.caption2.weight(.semibold))
            }
            .buttonStyle(IconButtonStyle(padding: 2))
            .foregroundStyle(.secondary)
            .opacity(hovering || isSelected ? 1 : 0.35)
            .padding(.trailing, 4)
            .help(String(localized: "Close this terminal — its shell ends"))
            .accessibilityLabel(Text("Close the terminal ‘\(title)’"))
            .accessibilityIdentifier("Close shell tab \(tab.name)")
        }
        .background(isSelected ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28) : (hovering ? Color.primary.opacity(0.08) : .clear),
                    in: RoundedRectangle(cornerRadius: 6))
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Restart") { model.shell.restart(tab.id) }
            Button("Close") { model.shell.close(tab.id) }
        }
    }
}

/// Over a shell that ended with a code other than 0 (a 0 closes its tab): what happened, Restart, Close.
private struct ShellExitedOverlay: View {
    @Environment(WindowModel.self) private var model
    let tab: ShellPanelModel.Tab

    var body: some View {
        switch tab.host.state {
        case let .exited(code, _):
            HStack(spacing: 10) {
                Text(code.map { String(localized: "The shell exited (\(Int($0)))") } ?? String(localized: "The shell was stopped"))
                    .font(.callout)
                Button("Restart") { model.shell.restart(tab.id) }
                    .controlSize(.small)
                    .help(String(localized: "Start a new shell in \(tab.cwd)"))
                Button("Close") { model.shell.close(tab.id) }
                    .controlSize(.small)
                    .help(String(localized: "Close this terminal tab"))
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 12)
            .accessibilityIdentifier("Shell exited")
        case let .failed(message):
            Text(message).font(.callout).padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        case .idle, .starting, .running:
            EmptyView()
        }
    }
}
