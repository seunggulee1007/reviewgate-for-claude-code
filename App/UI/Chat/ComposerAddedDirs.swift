import SwiftUI
import AppKit
import ReviewGateCore

// MARK: §67.1 — docs/PROTOCOL.md §67.3: `/add-dir` in a classic chat. `/add-dir <path>` (or the folder picker for `/add-dir`
// alone) adds a directory Claude may work in from the next message on; the chip "디렉터리 N" in the composer's chip row lists
// them with × and "디렉터리 추가…". Edits there always ask (the review does not show them); the directories change only
// between turns, so × and 추가 wait while work runs.

/// The folder picker of `/add-dir` alone and the chip's "디렉터리 추가…".
@MainActor
enum AddDirPicker {
    static func choose() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = String(localized: "Add")
        panel.message = AddDirText.pickerMessage
        return panel.runModal() == .OK ? panel.url : nil
    }
}

extension ComposerModel {
    /// `add_dir {path}`: added → the info line over the box; refused → why in the notice line, and what was typed back in an
    /// empty box.
    func addDir(_ path: String, typed: String, store: AppState) {
        Task {
            if let refusal = await store.addDir(path) {
                notice = refusal
                if draft.isEmpty, !typed.isEmpty { draft = typed }
            } else {
                infoNotice = AddDirText.added
            }
        }
    }

    /// `/add-dir` alone and "디렉터리 추가…": the folder picker, then `add_dir` (Cancel: nothing).
    func pickAddDir(store: AppState) {
        guard let url = AddDirPicker.choose() else { return }
        addDir(url.path, typed: "", store: store)
        inputFocused = true
    }
}

/// "디렉터리 N" in the composer's chip row (only with directories added).
struct AddedDirsChip: View {
    @Environment(AppState.self) private var store
    let composer: ComposerModel
    @State private var showList = false

    var body: some View {
        let count = store.addedDirs.count
        Button { showList.toggle() } label: {
            HStack(spacing: 4) {
                Image(systemName: "folder").font(.caption2)
                Text(verbatim: AddDirText.chip(count)).font(.caption.weight(.medium)).lineLimit(1)
            }
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Color.secondary.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.3)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help(AddDirText.chipHelp)
        .accessibilityLabel(Text(verbatim: AddDirText.chip(count)))
        .accessibilityIdentifier("Added directories chip")
        .popover(isPresented: $showList, arrowEdge: .top) {
            AddedDirsPopover(composer: composer) { showList = false }
        }
    }
}

/// The chip's list: each directory (home as ~, the full path in its tooltip) with ×, then "디렉터리 추가…". Not private: the
/// screenshot tour shows it on its own (a popover is a window of its own, outside the window's capture).
struct AddedDirsPopover: View {
    @Environment(AppState.self) private var store
    let composer: ComposerModel
    let close: () -> Void
    @State private var removing: String?
    @State private var problem: String?

    var body: some View {
        let blocker = store.addedDirsBlocker
        VStack(alignment: .leading, spacing: 8) {
            Text("Added Directories").font(.headline)
            Text(verbatim: AddDirText.chipHelp)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(store.addedDirs, id: \.self) { dir in
                    row(dir, blocker: blocker)
                }
            }
            // While work runs × and 추가 are off: say why where they are, not only in their tooltips.
            if let blocker, removing == nil {
                Label(blocker, systemImage: "hourglass")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Added directories blocked")
            }
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Added directories problem")
            }
            Divider()
            Button("Add Directory…", systemImage: "folder.badge.plus") {
                close()
                DispatchQueue.main.async { composer.pickAddDir(store: store) }
            }
            .disabled(blocker != nil || removing != nil)
            .help(blocker ?? String(localized: "Choose another directory Claude may work in (/add-dir)"))
            .accessibilityIdentifier("Add directory")
        }
        .padding(12)
        .frame(width: 360)
        .accessibilityIdentifier("Added directories list")
    }

    private func row(_ dir: String, blocker: String?) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "folder").foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(verbatim: SessionNotices.abbreviatingHome(dir))
                .font(.callout.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
                .help(dir)
            Spacer(minLength: 8)
            if removing == dir {
                ProgressView().controlSize(.small)
            } else {
                Button { remove(dir) } label: {
                    Image(systemName: "xmark").font(.caption.weight(.semibold))
                }
                .buttonStyle(.icon)
                .disabled(blocker != nil || removing != nil)
                .help(blocker ?? String(localized: "Remove this directory — from your next message Claude no longer works there"))
                .accessibilityLabel(Text("Remove the directory"))
                .accessibilityIdentifier("Remove added directory")
            }
        }
        .contextMenu {
            Button("Copy Path", systemImage: "doc.on.doc") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(dir, forType: .string)
            }
            Button("Show in Finder", systemImage: "folder") {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: dir)])
            }
            Divider()
            Button("Remove the directory", systemImage: "xmark") { remove(dir) }
                .disabled(blocker != nil || removing != nil)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: dir))
    }

    private func remove(_ dir: String) {
        removing = dir
        problem = nil
        Task {
            problem = await store.removeDir(dir)
            removing = nil
        }
    }
}
