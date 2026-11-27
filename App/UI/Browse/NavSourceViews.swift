import ReviewGateCore
import SwiftUI

// MARK: lsp — docs/PROTOCOL.md §73.5 on the Mac: "Exact" (the language server's answer) or "Estimated" (the search's) next to
// a definition list, a peek band and the references, and "Starting the language server…" while it starts. Words in Core
// `LanguageServer.swift`.

/// The small label with its tooltip (who answered, why the search did).
struct NavSourceBadge: View {
    let source: NavSource?
    let fallback: LspFallback?

    var body: some View {
        let exact = source == .lsp
        Text(verbatim: NavSourceText.label(source))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(exact ? AnyShapeStyle(Color.green.opacity(0.16)) : AnyShapeStyle(.quaternary), in: Capsule())
            .foregroundStyle(exact ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
            .help(NavSourceText.help(source, fallback: fallback))
            .accessibilityLabel(Text(verbatim: "\(NavSourceText.label(source)): \(NavSourceText.help(source, fallback: fallback))"))
            .accessibilityIdentifier("Nav source")
    }
}

/// "Starting the language server…" while `state.nav.lsp` is starting (nothing otherwise).
struct NavLspStartingNote: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if store.navLspStarting {
            Text(verbatim: NavSourceText.starting)
                .font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("Language server starting")
        }
    }
}
