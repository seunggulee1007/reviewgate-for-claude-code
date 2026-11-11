import Foundation
import Testing
@testable import ReviewGateCore

/// An open whose git never answered (macOS once held git started by GUI apps until a restart) left the window empty with
/// nothing on screen. The window says it is opening, and the engine's `project_open_failed` banner offers to try again.
@MainActor
struct OpenProjectStallTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "OpenProjectStallTests.\(UUID().uuidString)")!)
    }

    /// While the engine works on `open_project` / `switch_project`, `openingProject` names the folder; it clears once the
    /// open is over — here, failed at once (no engine).
    @Test func openingProjectNamesTheFolderUntilTheOpenEnds() async {
        let app = makeState()
        let url = URL(fileURLWithPath: "/Users/dev/acme-shop")
        #expect(app.openingProject == nil)
        let open = Task { await app.openProject(url) }
        await Task.yield()
        #expect(app.openingProject == url)
        await open.value
        #expect(app.openingProject == nil)
    }

    /// The stall's banner ("git rev-parse did not respond within 20 s — macOS may be holding …") retries the open.
    @Test func projectOpenFailedOffersReopen() {
        let app = makeState()
        let url = URL(fileURLWithPath: "/Users/dev/acme-shop")
        app.openingProject = url
        app.handle(.error(message: "git rev-parse did not respond within 20 s", fatal: true, scope: .git,
                          detail: EngineErrorDetail(code: "project_open_failed")))
        #expect(app.errorBanner?.code == "project_open_failed")
        #expect(app.errorBanner?.reopenProject == url)
    }

    /// An open superseded by a newer one does not clear the newer one's "opening" state when it ends.
    @Test func anOlderOpenEndingKeepsTheNewerOpening() async {
        let app = makeState()
        let first = URL(fileURLWithPath: "/Users/dev/acme-a"), second = URL(fileURLWithPath: "/Users/dev/acme-b")
        let tick = app.beginOpening(first)
        _ = app.beginOpening(second)
        app.endOpening(tick)
        #expect(app.openingProject == second)
    }
}
