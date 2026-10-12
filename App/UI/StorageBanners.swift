import SwiftUI
import ReviewGateCore

// MARK: wave4b w4b-bigturn
/// docs/PROTOCOL.md §39.1 (robustness-11 ② ③): the window's storage banners — a save that failed (the review, its
/// history, the checkpoints or the chat's rows; "디스크가 가득 차서 리뷰를 저장하지 못했어요 — …" with [다시 시도], one
/// banner per run of failures) and, below 1 GB free, one disk banner. Closing either keeps it closed (`StorageNotices`).
struct StorageBanners: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        if let failure = store.saveFailureNotice {
            banner(icon: "externaldrive.badge.xmark", tint: .red,
                   title: StorageText.saveFailed(failure),
                   detail: failure.diskFull ? nil : failure.detail,
                   id: "Save failed banner") {
                Button("Retry") { store.retrySave() }
                    .disabled(store.isRetryingSave)
                    .help("Saves the review, its history and the checkpoints again")
                    .accessibilityIdentifier("Retry save")
                Button("Close") { store.dismissSaveFailure() }
                    .accessibilityIdentifier("Close save failed banner")
            }
        } else if let disk = store.diskCriticalNotice {
            banner(icon: "externaldrive.badge.exclamationmark", tint: .red,
                   title: StorageText.diskCritical(disk), detail: nil, id: "Disk full banner") {
                Button("Close") { store.dismissDiskCritical() }
                    .accessibilityIdentifier("Close disk full banner")
            }
        }
    }

    private func banner<Buttons: View>(icon: String, tint: Color, title: String, detail: String?, id: String,
                                       @ViewBuilder buttons: () -> Buttons) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: title).font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail, !detail.isEmpty {
                        Text(verbatim: detail).font(.caption.monospaced()).foregroundStyle(.secondary)
                            .lineLimit(2)
                            .textSelection(.enabled)
                    }
                }
                Spacer(minLength: 8)
                if store.isRetryingSave { ProgressView().controlSize(.small) }
                buttons()
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(tint.wash(colorScheme, light: 0.10, dark: 0.18))   // the other banners' wash
            Divider()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
    }
}

/// HUD (§39.1): "디스크 여유 1.2 GB" below 2 GB free — orange, red below 1 GB. Nothing above (a Mac at 3–8 GB never sees it).
struct DiskSpaceChip: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if let disk = store.diskChip {
            let label = StorageText.diskChip(disk)
            Label {
                Text(verbatim: label).lineLimit(1)
            } icon: {
                Image(systemName: "internaldrive")
            }
            .labelStyle(.titleAndIcon)
            .foregroundStyle(disk.level == .critical ? Color.red : Color.orange)
            .fixedSize()
            .help("Free space on the project's disk. Settings › General › Clean Up Old Review History frees what the app keeps.")
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: label))
            .accessibilityIdentifier("HUD disk space")
        }
    }
}
