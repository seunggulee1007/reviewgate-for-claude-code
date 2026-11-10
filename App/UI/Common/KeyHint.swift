import SwiftUI
import ReviewGateCore

// MARK: polish p-foundation — PX-11: a tooltip names the key of what it does, read from the one shortcut table
// (docs/SHORTCUTS.md via `ShortcutTable.key`), never typed into the text — so it cannot be wrong or drift.
//
//   .helpWithKey("Accept this file", action: "Accept")                       // "이 파일 수락 (⌘⇧A)"
//   .help(String.withKey(String(localized: "Send"), key: KeyHint.sendKey))     // "보내기 (↩)" — or (⌘↩)
//   Text.withKey("Stop", action: "Stop")                                      // "중지 (⌘.)"
//
// `action` is the row's English `action` in ShortcutTable.swift; an action the table does not list shows the label alone.

enum KeyHint {
    /// The key that sends the message box: ↩ while Settings › "↩로 메시지 보내기" is on (the default), else ⌘↩.
    static var sendKey: String {
        (UserDefaults.standard.object(forKey: AppSettings.Key.returnSends) as? Bool ?? true) ? "↩" : "⌘↩"
    }
}

extension String {
    /// "수락 (⌘⇧A)": `label` and the key the shortcut table lists for `action`; `label` alone when it lists none.
    static func withKey(_ label: String, action: String) -> String {
        guard let key = ShortcutTable.key(action) else { return label }
        return withKey(label, key: key)
    }

    /// "보내기 (↩)": `label` and `key`.
    static func withKey(_ label: String, key: String) -> String {
        String(localized: "\(label) (\(key))")
    }
}

extension Text {
    /// A label with the key of `action` ("중지 (⌘.)").
    static func withKey(_ label: LocalizedStringResource, action: String) -> Text {
        Text(verbatim: String.withKey(String(localized: label), action: action))
    }
}

extension View {
    /// `.help` with the key of `action`: `.helpWithKey("Accept this file", action: "Accept")` → "이 파일 수락 (⌘⇧A)".
    func helpWithKey(_ label: LocalizedStringResource, action: String) -> some View {
        help(String.withKey(String(localized: label), action: action))
    }
}
