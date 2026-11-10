import ReviewGateCore
import SwiftUI

// MARK: wave4b w4b-files — docs/PROTOCOL.md §40.2 (comp-11): what a diff's lines cannot show — a pure move, a rename's
// similarity, a mode change, a binary's sizes (`FileMetaText`, the same lines as Electron's `fileMeta.ts`).

/// Above a diff that has lines: "이름 바뀜 (유사도 87%) · 실행 권한 추가 644→755".
struct FileMetaBanner: View {
    @Environment(\.colorScheme) private var colorScheme
    let lines: [String]

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "info.circle").foregroundStyle(.secondary)
            Text(verbatim: lines.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.wash(colorScheme, light: 0.05, dark: 0.09))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("File meta")
    }
}

/// A diff without lines that says what changed: "내용 변화 없이 이동 (유사도 100%)", "바이너리 · 12KB → 14KB".
struct FileMetaEmptyView: View {
    let diff: FileDiff
    let lines: [String]

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(verbatim: diff.isBinary ? String(localized: "Binary file") : lines.first ?? "")
            } icon: {
                Image(systemName: diff.isBinary ? "doc.zipper" : "arrow.left.arrow.right.square")
            }
        } description: {
            Text(verbatim: description)
        }
        .accessibilityIdentifier(diff.isBinary ? "Diff binary" : "Diff meta only")
    }

    private var description: String {
        if diff.isBinary { return lines.joined(separator: "\n") }
        return lines.count > 1 ? lines.dropFirst().joined(separator: " · ") : FileMetaText.noLineChanged
    }
}
