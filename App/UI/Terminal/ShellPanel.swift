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

    var visible = false
    private(set) var tabs: [Tab] = []
    var selectedId: UUID?
    @ObservationIgnored private var opened = 0
    /// The folder a new tab starts in: the window's project (worktree or workbench), read when the tab is made.
    @ObservationIgnored var cwd: () -> String? = { nil }
    /// Hiding with ⌃` gives the keyboard back to the chat (its terminal, else the message box).
    @ObservationIgnored var focusChat: () -> Void = {}

    var selected: Tab? { tabs.first { $0.id == selectedId } ?? tabs.last }

    /// ⌃` / View › Toggle Terminal Panel: hidden → shown with the keyboard (a first tab when there is none); shown and
    /// focused → hidden, the keyboard back to the chat; shown but not focused → the keyboard to it.
    func toggle() {
        if !visible {
            visible = true
            if tabs.isEmpty { newTab() } else { focusSelected() }
        } else if selected?.host.isFocused == true {
            visible = false
            focusChat()
        } else {
            focusSelected()
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
        let hosts = tabs.map(\.host)
        tabs = []
        selectedId = nil
        visible = false
        for host in hosts { await host.stop() }
    }

    /// Quit: SIGTERM to every shell without waiting.
    func terminateAll() {
        for tab in tabs where tab.host.view.process.running { tab.host.view.terminate() }
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
                Text("Terminal").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .padding(.trailing, 6)
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
                Button { shell.toggle() } label: { Image(systemName: "chevron.down") }
                    .buttonStyle(.icon)
                    .controlSize(.small)
                    .help(String(localized: "Hide the terminal panel (⌃`) — its shells keep running"))
                    .accessibilityLabel(Text("Hide the terminal panel"))
                    .accessibilityIdentifier("Shell panel hide")
            }
            .padding(.horizontal, 8).padding(.vertical, 3)
            Divider()
            if let tab = shell.selected {
                TerminalContainer(host: tab.host)
                    .id(tab.id)
                    .overlay { ShellExitedOverlay(tab: tab) }
                    .accessibilityIdentifier("Shell panel terminal")
            } else {
                Color.clear
            }
        }
        .frame(minHeight: 80, idealHeight: height, maxHeight: height)
        .layoutPriority(1)   // its height first; the review and the chat keep the rest (200 pt at least)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Shell panel")
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
