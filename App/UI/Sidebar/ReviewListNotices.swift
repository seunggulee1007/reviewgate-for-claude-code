import SwiftUI
import ReviewGateCore

// MARK: wave4b w4b-bigturn
/// docs/PROTOCOL.md §39.1 above the review list: the large untracked files the snapshots left out — "큰 파일 N개는 내용을
/// 저장하지 않았어요(되돌릴 수 없어요)" with each path and size (they stay in the list, pending: the gate still asks, nothing is hidden)
/// — and "대량 변경: 파일 N개" when the list folds by folder (robustness-10 ②).
struct ReviewListNotices: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    private static let shownPaths = 5

    var body: some View {
        let large = store.largeFiles
        if !large.isEmpty || store.isBulkChange {
            VStack(alignment: .leading, spacing: 4) {
                if store.isBulkChange {
                    Label {
                        Text(verbatim: StorageText.bulk(store.changedFiles.count)).font(.callout.weight(.medium))
                    } icon: {
                        Image(systemName: "square.stack.3d.up").foregroundStyle(.secondary)
                    }
                    .help("Over \(FolderFold.bulkThreshold) files: the list is folded by folder — open a folder to review its files")
                    .accessibilityIdentifier("Bulk change")
                }
                if !large.isEmpty {
                    Label {
                        Text(verbatim: StorageText.largeFiles(large.count)).font(.callout)
                    } icon: {
                        Image(systemName: "doc.badge.ellipsis").foregroundStyle(.orange)
                    }
                    .help("Untracked files over the large-file limit (Settings › General) are not stored in snapshots: they cannot be reverted and the app does not commit them")
                    ForEach(large.prefix(Self.shownPaths), id: \.path) { f in
                        Text(verbatim: StorageText.largeFileRow(f))
                            .font(.caption.monospaced()).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                    if large.count > Self.shownPaths {
                        Text("+\(large.count - Self.shownPaths) more").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color.orange.wash(colorScheme, light: 0.06, dark: 0.12))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Review list notices")
            Divider()
        }
    }
}
