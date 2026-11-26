import AppKit
import SwiftUI
import UniformTypeIdentifiers
import ReviewGateCore

// MARK: §70.3 — docs/PROTOCOL.md §70.3: `/export [file]` and `/copy [N]` in a classic chat, as in Claude Code. `/export
// file` writes the file (the engine refuses one that exists); `/export` alone opens the sheet — copy the text to the
// clipboard or save it through a save panel; `/copy [N]` puts Claude's Nth-latest answer on the clipboard.

/// The export sheet's content (`/export` alone).
struct ChatExportItem: Identifiable {
    let id = UUID()
    let export: ChatExport
}

extension ComposerModel {
    /// `/export` alone: the engine's text for the sheet; a refusal (nothing to export …) says why in the notice line.
    func openExport(store: AppState, show: @escaping (ChatExport) -> Void) {
        Task {
            do { show(try await store.exportChat()) } catch { notice = Self.refusal(error) }
        }
    }

    /// `/export <file>`: written there (relative to the project); a refusal gives the typed command back.
    func export(to file: String, typed: String, store: AppState) {
        Task {
            do {
                let written = try await store.exportChat(to: file)
                infoNotice = ChatExportText.saved(written.path ?? file)
            } catch {
                notice = Self.refusal(error)
                if draft.isEmpty, !typed.isEmpty { draft = typed }
            }
        }
    }

    /// `/copy [N]`: the answer on the clipboard (a user-initiated write) and a line that says so.
    func copyResponse(_ argument: String, typed: String, store: AppState) {
        guard let n = CopyArgument.parse(argument) else {
            notice = ChatExportText.copyUsage
            if draft.isEmpty { draft = typed }
            return
        }
        Task {
            do {
                let answer = try await store.copyResponse(n)
                Clipboard.copy(answer.text, toast: ChatExportText.copiedResponse(n))
            } catch {
                notice = Self.refusal(error)
                if draft.isEmpty, !typed.isEmpty { draft = typed }
            }
        }
    }

    static func refusal(_ error: Error) -> String {
        (error as? EngineClientError)?.userMessage ?? error.localizedDescription
    }
}

/// `/export` alone: the text, its size, and Copy to Clipboard / Save to File… (as the terminal's dialog).
struct ChatExportSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: ChatExportItem
    /// The composer's line after a copy or a save (the sheet closes first).
    let done: (String) -> Void
    let failed: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(ChatExportText.sheetTitle).font(.headline)
            Text(ChatExportText.sheetMessage).font(.callout).foregroundStyle(.secondary)
            ScrollView {
                Text(verbatim: preview)
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(8)
            }
            .frame(minHeight: 120, maxHeight: 220)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
            .accessibilityIdentifier("chatExport.preview")
            HStack {
                Text(ChatExportText.size(item.export.text)).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(ChatExportText.saveButton) { save() }
                    .help(String(localized: "Choose where to save the conversation as a text file"))
                    .accessibilityIdentifier("chatExport.save")
                Button(ChatExportText.copyButton) { copy() }
                    .keyboardShortcut(.defaultAction)
                    .help(String(localized: "Puts the whole conversation on the clipboard as plain text"))
                    .accessibilityIdentifier("chatExport.copy")
            }
        }
        .padding(16)
        .frame(width: 520)
    }

    /// The start of the text (a long chat is cut for the sheet; Copy and Save take all of it).
    private var preview: String {
        let text = item.export.text
        return text.count > 6000 ? String(text.prefix(6000)) + "\n…" : text
    }

    private func copy() {
        Clipboard.copy(item.export.text, toast: ChatExportText.copied)   // the toast says it
        dismiss()
    }

    /// The save panel (it asks before replacing), then the engine writes it there.
    private func save() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = item.export.name
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true
        if let root = store.projectInfo?.root { panel.directoryURL = URL(fileURLWithPath: root) }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        dismiss()
        Task {
            do {
                let written = try await store.exportChat(to: url.path, replace: true)
                done(ChatExportText.saved(written.path ?? url.path))
            } catch {
                failed(ComposerModel.refusal(error))
            }
        }
    }
}
