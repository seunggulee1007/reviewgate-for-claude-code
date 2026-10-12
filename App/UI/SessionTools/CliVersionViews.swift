import SwiftUI
import ReviewGateCore

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.8 on the Mac: the banner "새 CLI x — 아직 검증 안 됨" in the window's banner stack (from session.cli,
// closed once per version in every window) with "Pin previous version", and Settings › General "Pin CLI version" (the
// installed versions of ~/.local/share/claude/versions). The cli_version_changed notice is a chat row only.

/// Pinning is app-wide: `claudePath` is one setting, every open window's engine gets it and uses it from its next session start.
@MainActor
enum CliPinning {
    /// `path` nil = back to the claude on the PATH.
    static func pin(_ path: String?, via store: AppState) {
        if let path { store.pinClaude(path: path) } else { store.unpinClaude() }
        for other in WorkbenchRegistry.shared.allStores where other !== store { other.applyClaudePath(path ?? "") }
    }
}

/// The CLI banner in the window's banner stack (with its own divider).
struct CliVersionBannerView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    /// Observed so a close or a pin in another window (or Settings) updates this one.
    @AppStorage(AppSettings.Key.dismissedCliVersions) private var dismissedRaw = ""
    @AppStorage(AppSettings.Key.claudePath) private var claudePath = ""

    var body: some View {
        let _ = (dismissedRaw, claudePath)
        if let state = store.cliVersionBanner {
            Group {
                switch state {
                case let .unverified(version, range, previous): unverified(version: version, range: range, previous: previous)
                case let .pinnedNeedsRestart(version, running): pinned(version: version, running: running)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("CLI version banner")
            Divider()
        }
    }

    private func unverified(version: String, range: CliVersionRange?, previous: CliPreviousVersion?) -> some View {
        let pinnable = previous?.path
        return HStack(spacing: 8) {
            Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: CliVersionText.banner(version))
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                    .accessibilityIdentifier("CLI version banner text")
                Text(verbatim: CliVersionText.bannerDetail(range))
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2)
                if pinnable == nil {
                    Text(verbatim: CliVersionText.cannotPinPrevious(previous))
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Button("Pin previous version") { if let pinnable { CliPinning.pin(pinnable, via: store) } }
                .controlSize(.small)
                .disabled(pinnable == nil)
                .help(pinnable.map { _ in String(localized: "New sessions start with \(previous?.version ?? "") instead (restart the session to switch now)") }
                      ?? CliVersionText.cannotPinPrevious(previous))
                .accessibilityIdentifier("Pin previous CLI version")
            SettingsLink { Text("Versions…") }
                .controlSize(.small)
                .help("Settings › General › Pin CLI version")
                .accessibilityIdentifier("CLI versions settings")
            dismissButton(version)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))
    }

    private func pinned(version: String, running: String) -> some View {
        let blocked = !store.canRestartSession || store.isRunning
        return HStack(spacing: 8) {
            Image(systemName: "pin.fill").foregroundStyle(.blue)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: CliVersionText.pinned(version))
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                    .accessibilityIdentifier("CLI version banner text")
                Text(verbatim: CliVersionText.pinnedDetail(running: running))
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1)
                if store.isRunning {
                    Text("Claude is working — wait for the turn to finish")
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            Button("Restart now") { store.restartSession() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(blocked)
                .help(store.isRunning ? String(localized: "Claude is working — wait for the turn to finish") : String(localized: "Restart the Claude session now"))
                .accessibilityIdentifier("CLI pinned restart now")
            Button("Unpin") { CliPinning.pin(nil, via: store) }
                .controlSize(.small)
                .help("New sessions use the claude on your PATH again")
                .accessibilityIdentifier("Unpin CLI version")
            dismissButton(running)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.blue.wash(colorScheme, light: 0.08, dark: 0.16))
    }

    private func dismissButton(_ version: String) -> some View {
        Button { store.dismissCliVersionBanner(version) } label: { Image(systemName: "xmark") }
            .buttonStyle(IconButtonStyle(padding: 2))
            .controlSize(.small)
            .help("Don't show this again for this version")
            .accessibilityLabel("Dismiss")
            .accessibilityIdentifier("Dismiss CLI version banner")
    }
}

/// Settings › General "Pin CLI version": the claude on the PATH (it updates itself) or one installed version, for every
/// window's next session start.
struct CliVersionPinSection: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.Key.claudePath) private var claudePath = ""

    private struct RefreshKey: Equatable {
        var store: ObjectIdentifier
        var engine: Bool
    }

    private var pinned: String? {
        let path = claudePath.trimmingCharacters(in: .whitespaces)
        return path.isEmpty ? nil : path
    }

    var body: some View {
        Section {
            Text("Claude Code updates itself in the background. Pin a version to keep starting new sessions with it; ReviewGate marks the versions it was checked with.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            content
            if CliVersionList.pinDiffersFromRunning(pinnedPath: pinned, running: store.cliInfo?.version) {
                restartRow
            }
        } header: {
            HStack {
                Text("Pin CLI version")
                Spacer()
                if store.sessionTools.isLoadingVersions {
                    ProgressView().controlSize(.mini)
                }
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.sessionTools.refreshVersions() } }
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .controlSize(.small)
                    .disabled(!store.isEngineRunning || store.sessionTools.isLoadingVersions)
                    .help("List the installed versions again")
                    .accessibilityIdentifier("Refresh CLI versions")
            }
        }
        // Again when Settings follows another window (its store) or that window's engine starts.
        .task(id: RefreshKey(store: ObjectIdentifier(store), engine: store.isEngineRunning)) {
            if store.isEngineRunning { await store.sessionTools.refreshVersions() }
        }
        .accessibilityIdentifier("Pin CLI version")
    }

    @ViewBuilder
    private var content: some View {
        if !store.isEngineRunning {
            Text("Open a project to list the installed versions.")
                .font(.caption).foregroundStyle(.secondary)
        } else if !store.sessionTools.versionsSupported {
            Label(SessionToolsSupport.updateReason, systemImage: "exclamationmark.triangle")
                .font(.caption).foregroundStyle(.orange)
                .accessibilityIdentifier("CLI versions unavailable")
        } else if let rows = store.cliVersionRows {
            latestRow
            ForEach(rows) { row in versionRow(row) }
            if let pinned, !rows.contains(where: \.isPinned) {
                customRow(pinned)
            }
            if rows.isEmpty {
                Text("No versions in ~/.local/share/claude/versions — pinning needs the native installer (claude.ai/install.sh).")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else if store.sessionTools.isLoadingVersions {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Loading the installed versions…").font(.caption).foregroundStyle(.secondary)
            }
        }
        if let error = store.sessionTools.versionsError {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var latestRow: some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Latest (claude on your PATH)").font(.callout)
                Text("Updates itself").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if pinned == nil {
                inUseLabel
            } else {
                Button("Use") { CliPinning.pin(nil, via: store) }
                    .controlSize(.small)
                    .help("Clear the pinned claude: new sessions use the one on your PATH")
                    .accessibilityIdentifier("Use latest CLI")
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func versionRow(_ row: CliVersionRow) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: row.entry.version).font(.callout.monospaced())
            if row.isRunning {
                TagChip("running", tint: .accentColor)
            }
            if row.entry.verified {
                TagChip("verified", systemImage: "checkmark", tint: .green)
            } else {
                TagChip("not verified", tint: .orange)
            }
            Spacer(minLength: 8)
            if row.isPinned {
                inUseLabel
            } else {
                Button("Pin") { CliPinning.pin(row.entry.path, via: store) }
                    .controlSize(.small)
                    .help(String(localized: "New sessions start with \(row.entry.version)"))
                    .accessibilityIdentifier("Pin CLI \(row.entry.version)")
            }
        }
        .help(row.entry.path)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("CLI version \(row.entry.version)")
    }

    /// `claudePath` set by hand to a file outside the versions folder (Toolchain overrides).
    private func customRow(_ path: String) -> some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Custom path").font(.callout)
                Text(verbatim: path).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 8)
            inUseLabel
        }
        .help(path)
    }

    private var inUseLabel: some View {
        Label("In use", systemImage: "checkmark")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.accentColor)
    }

    private var restartRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.clockwise.circle.fill").foregroundStyle(.orange)
                .accessibilityHidden(true)
            Text("Applies from the next session start").font(.caption)
            Spacer(minLength: 4)
            Button("Restart now") { store.restartSession() }
                .controlSize(.small)
                .disabled(!store.canRestartSession || store.isRunning)
                .help(store.isRunning ? String(localized: "Claude is working — wait for the turn to finish") : String(localized: "Restart the Claude session now"))
                .accessibilityIdentifier("CLI pin restart now")
        }
    }
}
