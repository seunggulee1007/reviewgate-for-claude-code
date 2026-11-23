import SwiftUI
import ReviewGateCore

// MARK: wave6 w6-terminal
// docs/PROTOCOL.md §44.1: the terminal's mode line — "⏵⏵ 자동 모드", "⏸ 계획 모드 — 승인하면 자동 모드로 돌아가요". It follows
// the engine's mode at once, plan mode Claude entered by itself included; ⇧⇥ in the composer cycles default → accept edits
// → plan → auto.
// §56.6: it is the composer's mode menu now, first in the row under the box — no line of its own, no picker at the other
// end of the row and no pill in the HUD: one place says which mode runs, in its colour, and a click picks another.

struct ComposerModeMenu: View {
    @Environment(AppState.self) private var store
    /// The row under the box folded (r1-composer M11): the mode's symbol only, the line in its tooltip.
    var compact = false

    var body: some View {
        let line = store.composerModeLine
        let mode = store.scheduledPermissionMode ?? store.permissionMode
        Menu {
            PermissionModeMenuItems()
        } label: {
            if compact {
                Image(systemName: mode.symbolName)
            } else {
                Text(verbatim: line.label)
            }
        }
        .menuStyle(.borderlessButton)
        .controlSize(.small)   // the row's caption size, as the hints next to it
        .font(.caption)
        .fixedSize()
        .tint(Self.color(line.tone))
        .foregroundStyle(Self.color(line.tone))
        .disabled(!store.canPickPermissionMode)
        // Disabled: why; else the mode's help (or the waiting pick, or why a switch was refused) and the key.
        .help(store.canPickPermissionMode
              ? PermissionModeLabels.help(store) + "\n" + (compact ? line.label + "\n" : "")
                + String(localized: "Shift+Tab in the message box switches the permission mode")
              : String(localized: "The permission mode can be picked once the session has started"))
        .accessibilityLabel(String(localized: "Permission mode: \(line.label)"))
        .accessibilityIdentifier("Permission mode")
    }

    static func color(_ tone: ComposerModeTone) -> Color {
        switch tone {
        case .auto: .orange
        case .acceptEdits: .purple
        case .plan: .teal
        case .plain: .secondary
        }
    }
}
