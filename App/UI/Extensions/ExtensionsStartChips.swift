import SwiftUI
import ReviewGateCore

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.7 in the HUD: while the CLI starts, what it waits for ("serena 기다리는 중"); after the init-timeout
// fallback, "Extensions off" until a retry succeeds or the project is reopened — its popover says why and offers
// "Retry with extensions".

/// "Waiting for serena" while the starting CLI waits for a hook, an MCP server or a plugin (it replaces "Starting Claude
/// Code…" then).
struct ExtensionsWaitingChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        if let waiting = store.extensionsWaitingOn {
            let text = ExtensionsStartText.waiting(waiting)
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text(verbatim: text).lineLimit(1).truncationMode(.middle)
            }
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Color.blue.wash(colorScheme, light: 0.12, dark: 0.22), in: Capsule())
            .foregroundStyle(Color.blue)
            .frame(maxWidth: 240)
            .fixedSize(horizontal: false, vertical: true)
            .help(ExtensionsStartText.detail(waiting))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(text)
            .accessibilityIdentifier("HUD extensions waiting")
        }
    }
}

/// "Extensions off" after the fallback: stays while the session runs without the user's extensions (closing the banner
/// does not hide it); the popover explains and retries.
struct ExtensionsOffChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @State private var showDetails = false

    var body: some View {
        if let fallback = store.extensionsOff {
            Button { showDetails.toggle() } label: {
                HStack(spacing: 3) {
                    if store.sessionTools.isRetryingExtensions {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "puzzlepiece.extension")
                    }
                    Text("Extensions off")
                }
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Color.orange.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
                .foregroundStyle(.orange)
            }
            .buttonStyle(.plain)
            .fixedSize()
            .layoutPriority(1)
            .help("Your plugins, MCP servers and hooks are off for this session — click for details")
            .accessibilityLabel("Extensions off")
            .accessibilityIdentifier("HUD extensions off")
            .popover(isPresented: $showDetails, arrowEdge: .top) { details(fallback) }
        }
    }

    private func details(_ fallback: ExtensionsFallback) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Extensions off", systemImage: "puzzlepiece.extension.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            Text("Extensions took longer than \(fallback.timeoutSeconds) s to load, so the session started without them")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Text("Plugins, MCP servers and hooks from ~/.claude are off for this project until you retry. A slow VPN or plugin marketplace is the usual cause — check the network, or turn off the plugin that hangs.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if store.supportsSessionTools {
                Text("ReviewGate also retries once by itself the next time Claude is idle.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = store.sessionTools.extensionsRetryError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Extensions retry error")
            }
            HStack(spacing: 8) {
                Button("Retry with extensions") { Task { await store.retryWithExtensions() } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(store.extensionsRetryBlockedReason != nil)
                    .accessibilityIdentifier("HUD retry with extensions")
                if store.sessionTools.isRetryingExtensions {
                    ProgressView().controlSize(.small)
                } else if let reason = store.extensionsRetryBlockedReason {
                    Text(verbatim: reason).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .frame(width: 360, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Extensions off popover")
    }
}
