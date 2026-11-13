import SwiftUI
import AppKit
import ReviewGateCore

/// MARK: composer parity — docs/PROTOCOL.md §56.3: ⌃G edits the draft in an external editor, as Ctrl+G in the terminal. The
/// draft goes to a .md file in the app's own temp folder (`DraftEditor.folder`), the editor `DraftEditor.launch` picks opens
/// it, and every save comes back into the message box. An editor that waits (`code --wait`, a GUI $VISUAL) finishes the
/// editing when it closes; `open -t` does not wait, so Done finishes it. Cancel puts back the draft from before ⌃G.
@MainActor
@Observable
final class ComposerExternalEditor {
    /// "Editing in <name>…" while a draft is out; nil otherwise.
    private(set) var editorName: String?
    /// Why the editor could not open (shown in the notice line by the caller).
    private(set) var failure: String?
    @ObservationIgnored private var file: URL?
    @ObservationIgnored private var before = ""
    @ObservationIgnored private var lastText: String?
    @ObservationIgnored private var lastStamp: Date?
    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var watch: Task<Void, Never>?
    @ObservationIgnored private var onText: (String) -> Void = { _ in }

    var isEditing: Bool { editorName != nil }

    /// Writes `draft` out and opens it; `onText` gets each saved text (trailing newlines trimmed). False when it could not.
    @discardableResult
    func start(draft: String, onText: @escaping (String) -> Void) -> Bool {
        guard !isEditing else { return true }
        failure = nil
        let folder = DraftEditor.folder()
        let file = folder.appendingPathComponent("draft-\(UUID().uuidString.prefix(8)).md")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try draft.write(to: file, atomically: true, encoding: .utf8)
        } catch {
            failure = String(localized: "Couldn't write the draft for the editor: \(error.localizedDescription)")
            return false
        }
        let launch = DraftEditor.launch(file: file.path, env: ProcessInfo.processInfo.environment, findExecutable: Self.find,
                                        defaultEditorName: Self.defaultEditorName(for: file))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launch.executable)
        process.arguments = launch.arguments
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Self.searchPath.joined(separator: ":")
        process.environment = env
        process.standardInput = nil
        process.standardOutput = nil
        process.standardError = nil
        do {
            try process.run()
        } catch {
            try? FileManager.default.removeItem(at: file)
            failure = String(localized: "Couldn't open \(launch.name): \(error.localizedDescription)")
            return false
        }
        self.file = file
        self.before = draft
        self.lastText = draft
        self.lastStamp = Self.stamp(file)
        self.process = launch.waits ? process : nil
        self.onText = onText
        editorName = launch.name
        watch = Task { [weak self] in await self?.watchLoop() }
        return true
    }

    /// Done: what was last saved stays in the box; the editing ends.
    func done() {
        guard isEditing else { return }
        readIfSaved()
        finish()
    }

    /// Cancel: the box gets the draft from before ⌃G back; the editing ends (the editor's window stays the user's).
    func cancel() {
        guard isEditing else { return }
        let restore = before, give = onText
        finish()
        give(restore)
    }

    private func watchLoop() async {
        while !Task.isCancelled, isEditing {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, isEditing else { return }
            readIfSaved()
            if let process, !process.isRunning {
                readIfSaved()
                finish()
                return
            }
        }
    }

    /// A save (the file's date moved, or an editor that writes a new file in its place) comes into the box.
    private func readIfSaved() {
        guard let file else { return }
        let stamp = Self.stamp(file)
        guard stamp != nil, stamp != lastStamp else { return }
        lastStamp = stamp
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        let trimmed = text.replacingOccurrences(of: "\\n+$", with: "", options: .regularExpression)
        guard trimmed != lastText else { return }
        lastText = trimmed
        onText(trimmed)
    }

    private func finish() {
        watch?.cancel()
        watch = nil
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
        process = nil
        editorName = nil
    }

    private static func stamp(_ file: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
    }

    /// The PATH a GUI app lacks: the user's, then the usual install folders.
    private static var searchPath: [String] {
        (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
            + ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]
    }

    private static func find(_ name: String) -> String? {
        let candidates = searchPath.map { "\($0)/\(name)" }
            + ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/\(name)"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func defaultEditorName(for file: URL) -> String {
        guard let app = NSWorkspace.shared.urlForApplication(toOpen: file) else { return String(localized: "the default text editor") }
        return FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: "")
    }
}

/// §56.3: "Editing in <editor>…" over the message box while the draft is out, with Done and Cancel.
struct ComposerExternalEditorBar: View {
    let editor: ComposerExternalEditor

    var body: some View {
        if let name = editor.editorName {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Editing in \(name)… — each save comes into the message box")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(String(localized: "Editing in \(name)… — each save comes into the message box"))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Done") { editor.done() }
                    .controlSize(.small)
                    .help("Stop editing outside — what you saved stays in the message box")
                    .accessibilityIdentifier("External editor done")
                Button("Cancel") { editor.cancel() }
                    .controlSize(.small)
                    .help("Stop editing outside and put back the message as it was before ⌃G")
                    .accessibilityIdentifier("External editor cancel")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            .contextMenu {
                Button("Done", systemImage: "checkmark") { editor.done() }
                Button("Cancel", systemImage: "xmark") { editor.cancel() }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("External editor")
        }
    }
}
