import SwiftUI

extension View {
    /// The screenshot tour's overlap check (`SHOTS_LAYOUT=overlap`, DEBUG only) reads where the stack laid each transcript row
    /// out (`TranscriptRowFrames`). Nothing in a release build, nor in any other run.
    @ViewBuilder
    func transcriptRowFrame(_ id: UUID) -> some View {
        #if DEBUG
        if TranscriptRowFrames.enabled {
            modifier(TranscriptRowFrameProbe(id: id))
        } else {
            self
        }
        #else
        self
        #endif
    }

    /// The same for the transcript's bottom marker.
    @ViewBuilder
    func transcriptBottomFrame() -> some View {
        #if DEBUG
        transcriptRowFrame(TranscriptRowFrames.bottomMarker)
        #else
        self
        #endif
    }
}

#if DEBUG
/// Where each transcript row was laid out, in the transcript scroll view's own space (0 is the top of what it shows). The
/// check bumps `generation` and scrolls a point: every row on screen reports again, and a frame of an older generation is
/// one no view stands for any more.
@MainActor
enum TranscriptRowFrames {
    static let enabled = ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "overlap"
        && Bundle.main.bundleIdentifier?.hasSuffix(".screenshots") == true
    /// The bottom marker's frame (it ends where the content does): ties the rows' space to the AppKit views'.
    static let bottomMarker = UUID(uuidString: "00000000-0000-0000-0000-00000000B077")!

    struct Row {
        var id: UUID
        var frame: CGRect
        var generation: Int
    }

    static var generation = 0
    static var rows: [UUID: Row] = [:]
}

private struct TranscriptRowFrameProbe: ViewModifier {
    let id: UUID

    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGRect.self) { $0.frame(in: .scrollView(axis: .vertical)) } action: { frame in
            TranscriptRowFrames.rows[id] = .init(id: id, frame: frame, generation: TranscriptRowFrames.generation)
        }
    }
}
#endif
