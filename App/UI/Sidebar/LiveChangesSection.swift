import SwiftUI
import ReviewGateCore

// wave2 mac-flow — §34.6 (comp-03): what the running turn changed so far, read-only — a section on top of the Changes
// list and the HUD's "진행 중" popover. A row opens the file's live diff; nothing here can be accepted until the turn is
// collected into the review.

/// One file the running turn changed so far.
struct LiveChangeRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let file: LiveChangedFile
    let selected: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 6) {
                Text(file.status.rawValue)
                    .font(.caption.weight(.bold).monospaced())
                    .foregroundStyle(statusColor(file.status))
                    .frame(width: 14)
                pathText(file.path)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                Text(verbatim: "+\(file.added)").font(.caption2.monospacedDigit()).foregroundStyle(.green)
                Text(verbatim: "−\(file.deleted)").font(.caption2.monospacedDigit()).foregroundStyle(.red)
            }
            .padding(.horizontal, 4).padding(.vertical, 2)
            // Lockfiles and generated files are part of the turn but rarely what one reads first.
            .opacity(file.generated == nil ? 1 : 0.6)
            .background(RoundedRectangle(cornerRadius: 5).fill(selected ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(file.oldPath.map { String(localized: "\(file.path) (from \($0))") } ?? file.path)
        .accessibilityIdentifier("Live change \(file.path)")
    }
}

/// "진행 중 변경 (아직 수락 불가)" with its files, for the Changes list while a turn runs.
struct LiveChangesSection: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model

    var body: some View {
        // wave3 check-clients: from `hud.turnFiles` on (as the HUD chip and Electron), the files once a list has them.
        if let chip = store.liveChip {
            let files = store.liveChanges?.files ?? []
            Section {
                ForEach(files) { file in
                    LiveChangeRow(file: file, selected: store.liveSelection == file.path) { open(file.path) }
                }
                if files.isEmpty {
                    LiveChangesPlaceholder(files: chip.files)
                }
                if store.liveChanges?.truncated == true {
                    Text(verbatim: "…").foregroundStyle(.secondary)
                }
            } header: {
                LiveChangesHeader()
            }
        }
    }

    private func open(_ path: String) {
        if model.tab != .changes { model.tab = .changes }
        Task { await store.openLiveDiff(path) }
    }
}

/// The section's / popover's title with a refresh (the list is a snapshot of the worktree taken on request).
struct LiveChangesHeader: View {
    @Environment(AppState.self) private var store

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "hammer.fill").foregroundStyle(.orange)
            Text("In progress (can't accept yet)").lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            if store.isLoadingLiveChanges {
                ProgressView().controlSize(.mini)
            } else {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refreshLiveChanges() } }
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .font(.caption2)   // the size `.controlSize(.mini)` drew it at
                    .help("Refresh")
                    .accessibilityIdentifier("Refresh live changes")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Live changes header")
    }
}

/// The HUD chip's popover: the same files, a row opens its live diff in the diff pane.
struct LiveChangesPopover: View {
    @Environment(AppState.self) private var store
    let onOpen: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LiveChangesHeader().font(.subheadline.weight(.semibold))
            if let live = store.liveChanges, !live.files.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(live.files) { file in
                            LiveChangeRow(file: file, selected: store.liveSelection == file.path) { onOpen(file.path) }
                        }
                    }
                }
                .frame(maxHeight: 320)
                .fixedSize(horizontal: false, vertical: live.files.count <= 12)
            } else if let chip = store.liveChip {
                LiveChangesPlaceholder(files: chip.files)   // wave3 check-clients: the list is still being read
            }
        }
        .padding(12)
        .frame(width: 380, alignment: .leading)
        .accessibilityIdentifier("Live changes popover")
    }
}
