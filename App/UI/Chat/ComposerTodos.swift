import SwiftUI
import ReviewGateCore

// MARK: §71.2 — docs/PROTOCOL.md §71.2: Claude's to-do checklist over the message box, live (`state.session.todos`).
// ⌃T in the box and `/todos` show or hide it, as Ctrl+T in Claude Code; the choice stays with the app.

extension ComposerModel {
    /// ⌃T: the checklist shown or hidden; the line under it says which (or why there is nothing to show).
    func toggleTodos(store: AppState) {
        if let blocker = store.todoBlocker {
            notice = blocker
            return
        }
        let show = !AppSettings.todoListShown()
        AppSettings.setTodoListShown(show)
        if show, store.todos?.isEmpty != false { infoNotice = TodoText.none } else { infoNotice = show ? TodoText.shown : TodoText.hidden }
    }

    /// `/todos`: the checklist shown (it says so when Claude has none yet).
    func showTodos(store: AppState) {
        if let blocker = store.todoBlocker {
            notice = blocker
            return
        }
        AppSettings.setTodoListShown(true)
        if store.todos?.isEmpty != false { infoNotice = TodoText.none }
    }
}

/// The checklist: "To-dos 2 of 5 done", then at most five items (□ pending, ◼ in progress with its running words, ✓ done).
struct ComposerTodoPanel: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.todoListShownKey) private var shown = true

    var body: some View {
        if shown, store.todoBlocker == nil, let all = store.todos, !all.isEmpty {
            let window = TodoWindow(all)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: "checklist").foregroundStyle(.secondary)
                    Text(verbatim: TodoText.title).font(.caption.weight(.semibold))
                    Text(verbatim: TodoText.progress(all)).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    Button { shown = false } label: { Image(systemName: "chevron.down").font(.caption2.weight(.semibold)) }
                        .buttonStyle(.icon)
                        .help(TodoText.hideHelp)
                        .accessibilityLabel(Text(verbatim: TodoText.hideHelp))
                        .accessibilityIdentifier("Todo checklist hide")
                }
                if window.before > 0 {
                    Text(verbatim: TodoText.moreBefore(window.before)).font(.caption2).foregroundStyle(.tertiary).padding(.leading, 20)
                }
                ForEach(Array(window.items.enumerated()), id: \.offset) { _, item in
                    row(item)
                }
                if window.after > 0 {
                    Text(verbatim: TodoText.moreAfter(window.after)).font(.caption2).foregroundStyle(.tertiary).padding(.leading, 20)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
            .help(TodoText.panelHelp)
            .transition(.opacity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("Todo checklist")
        }
    }

    private func row(_ item: TodoItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon(item.status))
                .font(.caption)
                .foregroundStyle(item.status == .inProgress ? Color.accentColor : item.status == .completed ? Color.green : Color.secondary)
                .frame(width: 14)
            Text(verbatim: item.shownText)
                .font(.caption.weight(item.status == .inProgress ? .semibold : .regular))
                .strikethrough(item.status == .completed, color: .secondary)
                .foregroundStyle(item.status == .completed ? Color.secondary : Color.primary)
                .lineLimit(1).truncationMode(.tail)
        }
        .help(item.text)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: "\(TodoText.statusLabel(item.status)): \(item.text)"))
    }

    private func icon(_ s: TodoItem.Status) -> String {
        switch s {
        case .pending: "square"
        case .inProgress: "square.inset.filled"
        case .completed: "checkmark.square"
        }
    }
}
