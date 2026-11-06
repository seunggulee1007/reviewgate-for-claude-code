import SwiftUI
import ReviewGateCore

/// An error / notice row of the chat (PROTOCOL §30): live and restored rows look the same — the style of its code, the
/// text, "×N · last 09:41" when it repeated, and the CLI's own words · exit code on a gray second line. r1-scope (§33.4): a
/// `worktree_outside_review` row — no banner says it — names the files on that line and offers the folder's actions.
struct ErrorTranscriptRow: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(\.openWindow) private var openWindow
    let message: String
    let fatal: Bool
    let info: ErrorRowInfo
    /// ⌘F: the highlighted text when the row matches.
    var highlighted: AttributedString?
    /// False for another chat's rows (§38.4 viewing): its actions would act on this window's chat.
    var actionable = true

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
                if actionable { scopeActions }
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.wash(colorScheme, light: 0.08, dark: 0.16), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: actionable && !ScopeText.rowActions(info, isWorkbench: { store.isWorkbenchPath($0) }).isEmpty ? .contain : .combine)
        .accessibilityIdentifier(style == .info ? "Notice row" : "Error row")
    }

    /// r1-scope (§33.4, §39.4): what a `worktree_outside_review` row offers — move this chat into that worktree (asks first
    /// while Claude works) and open it as a workbench, or open the folder.
    @ViewBuilder
    private var scopeActions: some View {
        let actions = ScopeText.rowActions(info, isWorkbench: { store.isWorkbenchPath($0) })
        if let path = info.path, !actions.isEmpty {
            HStack(spacing: 6) {
                ForEach(actions, id: \.self) { action in
                    switch action {
                    case .moveChat:
                        Button(ChatMoveText.moveTitle) { ChatMoveActions.move(store: store, to: path) }
                            .buttonStyle(.borderedProminent)
                            .disabled(store.chatMoveBlocker != nil)
                            .help(store.chatMoveBlocker ?? ChatMoveText.moveHelp)
                            .accessibilityIdentifier("Move chat from row")
                    case .openWorkbench:
                        Button("Open as Workbench") { ProjectOpener.openInNewWindow(URL(fileURLWithPath: path), openWindow: openWindow) }
                            .help("Opens that workbench in its own window, where its changes are reviewed")
                            .accessibilityIdentifier("Open as workbench from row")
                    case .openFolder:
                        Button("Open Folder") { ProjectOpener.openInNewWindow(URL(fileURLWithPath: path), openWindow: openWindow) }
                            .help(path)
                            .accessibilityIdentifier("Open folder from row")
                    default:
                        EmptyView()
                    }
                }
            }
            .controlSize(.small)
            .padding(.top, 2)
        }
    }
}
