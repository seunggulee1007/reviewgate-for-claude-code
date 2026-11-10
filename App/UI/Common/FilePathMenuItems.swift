import SwiftUI
import AppKit
import ReviewGateCore

// MARK: polish p-foundation — P3-transcript-08: the items every file's context menu shares — copy the path (whole or
// relative to the project), reveal it in Finder, open it in the editor, and its diff when the file is under review.
//
//   .contextMenu { FilePathMenuItems(path: file) }                       // a path from a tool call, absolute or relative
//   .contextMenu { FilePathMenuItems(path: changed.path, showsDiff: false); Divider(); … }
//
// Copies confirm with "복사됨: …" (`Clipboard.copy`). Needs `AppState` (and `WindowModel` for the diff) in the environment.

struct FilePathMenuItems: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    /// Absolute, or relative to the project's root.
    let path: String
    /// Offer "diff 보기" when the file is in the review.
    var showsDiff = true

    private var root: String? { store.projectInfo?.root ?? store.projectURL?.path }

    private var absolute: String {
        guard !path.hasPrefix("/"), let root else { return path }
        return (root as NSString).appendingPathComponent(path)
    }

    private var relative: String {
        TouchedFile(path: absolute, tools: [], count: 0).relativePath(to: root.map { URL(fileURLWithPath: $0) })
    }

    var body: some View {
        let absolute = absolute
        let relative = relative
        let exists = FileManager.default.fileExists(atPath: absolute)
        Button("Copy Path", systemImage: "doc.on.doc") { Clipboard.copy(absolute) }
        if relative != absolute {
            Button("Copy Relative Path") { Clipboard.copy(relative) }
        }
        Button("Reveal in Finder", systemImage: "folder") {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: absolute)])
        }
        .disabled(!exists)
        Button("Open in Editor", systemImage: "arrow.up.forward.app") {
            // The editor the diff header's button would use (`DiffEditorButton`), at line 1.
            (ExternalEditor.preferred ?? ExternalEditor.installed.first ?? .finder).open(absolute, line: 1)
        }
        .disabled(!exists)
        if showsDiff, relative != absolute, store.changedFiles.contains(where: { $0.path == relative }) {
            Button("Show the diff", systemImage: "plusminus") { model.showReviewDiff(path: relative, line: nil) }
        }
    }
}
