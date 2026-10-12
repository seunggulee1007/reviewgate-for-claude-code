import SwiftUI
import ReviewGateCore

/// An error / notice row of the chat (PROTOCOL §30): live and restored rows look the same — the style of its code, the
/// text, "×N · last 09:41" when it repeated, and the CLI's own words · exit code on a gray second line.
struct ErrorTranscriptRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let message: String
    let fatal: Bool
    let info: ErrorRowInfo
    /// ⌘F: the highlighted text when the row matches.
    var highlighted: AttributedString?

    private var style: NoticeStyle { SessionNotices.style(code: info.code, fatal: fatal) }

    private var tint: Color {
        switch style {
        case .info: .blue
        case .warning: .orange
        case .error: .red
        }
    }

    private var icon: String {
        switch style {
        case .info: "info.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .error: "xmark.circle.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Group {
                        if let highlighted { Text(highlighted) } else { Text(verbatim: message) }
                    }
                    .font(.callout)
                    .foregroundStyle(style == .info ? Color.primary : tint)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    if let repeats = SessionNotices.repeatText(count: info.count, lastAt: info.lastAt) {
                        Text(verbatim: repeats)
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.secondary.opacity(colorScheme == .dark ? 0.22 : 0.14), in: Capsule())
                            .fixedSize()
                            .accessibilityIdentifier("Error row repeat")
                    }
                }
                if let secondary = info.secondary {
                    Text(verbatim: secondary)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(3).truncationMode(.middle)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("Error row detail")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.wash(colorScheme, light: 0.08, dark: 0.16), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(style == .info ? "Notice row" : "Error row")
    }
}
