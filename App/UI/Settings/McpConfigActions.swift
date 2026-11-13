import AppKit
import SwiftUI
import ReviewGateCore

/// Opening the file that defines an MCP server (its `.mcp.json`, or `~/.claude.json`) from Settings › MCP Servers.
/// The editor is the one the diff's "Open in Editor" remembered (else the system's app for the file); every file opened
/// here is watched, so a save shows the restart banner (`McpStore.checkConfigEdited`).
@MainActor
enum McpConfigOpener {
    static func open(_ path: String, mcp: McpStore) {
        guard FileManager.default.fileExists(atPath: path) else {
            mcp.report(String(localized: "That file no longer exists: \(path)"))
            return
        }
        mcp.configOpened(path)
        if let editor = ExternalEditor.preferred, editor != .finder {
            editor.open(path, line: 1)
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        }
    }

    static func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// The tooltip of "Open Config File"; the disabled reason when there is no file.
    static func openHelp(_ file: String?) -> String {
        guard let file else { return String(localized: "ReviewGate does not know which file defines this server") }
        return McpConfigFile.isHomeConfig(file)
            ? String(localized: "Opens ~/.claude.json — a large file that also holds your other Claude Code state. Edit it with care.")
            : String(localized: "Open the file that defines this server")
    }
}

/// "Open Config File" and "Show in Finder" of one server, for its context menu and its actions menu. `~/.claude.json`
/// lists Show in Finder first (the file is large and holds other state).
struct McpConfigItems: View {
    let mcp: McpStore
    let file: String?

    var body: some View {
        if let file, McpConfigFile.isHomeConfig(file) {
            reveal
            open
        } else {
            open
            reveal
        }
    }

    private var open: some View {
        Button("Open Config File", systemImage: "doc.text") {
            if let file { McpConfigOpener.open(file, mcp: mcp) }
        }
        .disabled(file == nil)
        .help(McpConfigOpener.openHelp(file))
    }

    private var reveal: some View {
        Button("Show in Finder", systemImage: "folder") {
            if let file { McpConfigOpener.reveal(file) }
        }
        .disabled(file == nil)
        .help(file == nil ? String(localized: "ReviewGate does not know which file defines this server") : String(localized: "Show the file that defines this server in Finder"))
    }
}

/// The section header's "Open .mcp.json" of the project itself — created after a confirmation when it is not there yet.
/// It also watches the app coming back to the front, to catch a save of any file opened from the section.
struct McpConfigHeaderButton: View {
    @Environment(AppState.self) private var store
    var compact = false
    @State private var askCreate = false

    private var root: String? { store.projectInfo?.root ?? store.projectURL?.path }
    private var file: String? { root.map(McpConfigFile.projectFile(root:)) }

    var body: some View {
        Group {
            if let file {
                Button {
                    if FileManager.default.fileExists(atPath: file) {
                        McpConfigOpener.open(file, mcp: store.mcp)
                    } else {
                        askCreate = true
                    }
                } label: {
                    if compact { Image(systemName: "doc.text") } else { Label("Open .mcp.json", systemImage: "doc.text") }
                }
                .controlSize(.small)
                .help("Open the project's .mcp.json — you can create it if it is not there yet")
                .accessibilityLabel("Open .mcp.json")
                .accessibilityIdentifier("MCP open project file")
                .alert("Create .mcp.json?", isPresented: $askCreate) {
                    Button("Create and Open") { create(file) }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This project has no .mcp.json yet. ReviewGate creates it with an empty server list and opens it.")
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if store.mcp.checkConfigEdited() { Task { await store.mcp.refresh() } }
        }
    }

    private func create(_ file: String) {
        if McpConfigFile.createEmpty(at: file) {
            McpConfigOpener.open(file, mcp: store.mcp)
        } else {
            store.mcp.report(String(localized: "Could not create \(file)"))
        }
    }
}
