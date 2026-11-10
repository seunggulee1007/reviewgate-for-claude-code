import SwiftUI

// MARK: polish p-foundation — the types of the `WindowModel` seeds (App/WorkbenchRegistry.swift) and the modifier that
// registers unsaved work for the close / quit confirmation.
//
//   .registersUnsavedWork("noteDraft") { drafts.isEmpty ? nil : String(localized: "…") }

/// P2-review-09: the part of the window the user last clicked in.
enum WindowFocusArea: Sendable, Equatable {
    case chat, diff, other
}

/// PX-20: where a chat was read when the user left it (another tab, the PRs tab).
struct ChatScrollAnchor: Equatable {
    /// The row at the top of what was shown; nil when the chat followed its newest row.
    var topRowID: UUID?
    /// The chat was at its end, following new rows.
    var atBottom: Bool
    /// How many rows the chat had then — the rows since are the "최신으로" pill's count.
    var rowCount: Int
}

extension View {
    /// While this view is on screen, closing the window (or quitting) lists `line()` — when it returns a line — among what
    /// would be lost ("작성 중인 리뷰 메모가 있어요. 닫으면 사라져요."). `key` names the work (one line per key and window).
    func registersUnsavedWork(_ key: String, line: @escaping @MainActor () -> String?) -> some View {
        modifier(UnsavedWorkRegistration(key: key, line: line))
    }
}

private struct UnsavedWorkRegistration: ViewModifier {
    @Environment(WindowModel.self) private var model
    let key: String
    let line: @MainActor () -> String?

    func body(content: Content) -> some View {
        content
            .onAppear { model.registerUnsavedWork(key, line: line) }
            .onDisappear { model.unregisterUnsavedWork(key) }
    }
}
