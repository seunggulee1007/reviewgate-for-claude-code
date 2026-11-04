#if DEBUG
import SwiftUI
import AppKit
import ReviewGateCore

/// Dev-only README screenshots (`make screenshots`, scripts/screenshots.sh). With `REVIEWGATE_SCREENSHOT_TOUR=<dir>` set and
/// `REVIEWGATE_PROJECT` opening the project, the first window sends one prompt (`REVIEWGATE_SCREENSHOT_PROMPT`, else
/// `defaultPrompt`) on `REVIEWGATE_SCREENSHOT_MODEL` (default haiku), waits for the review gate, selects the most
/// interesting file and writes PNGs of itself — the window, crops of it, the agent panel — in dark and light, then quits.
/// The window renders itself (`cacheDisplay`): no screen-recording or accessibility permission. Progress goes to
/// `<dir>/tour.log`, a failure to `<dir>/tour-failed.txt`.
/// Only a build whose bundle id ends in `.screenshots` runs it, so its settings never reach the real app's defaults.
@MainActor
enum ScreenshotTour {
    static let defaultPrompt = """
    Add discount codes to the cart: SAVE10 takes 10% off the subtotal, FREESHIP removes shipping. Keep the codes in \
    src/pricing.ts, apply them in src/cart.ts, reject unknown codes with a clear error, and add tests to \
    test/cart.test.ts. Before each edit, say in one line what it changes. Keep it small and do not run any commands.
    """

    /// Called once, by the window `REVIEWGATE_PROJECT` opens, right before it opens the project.
    static func startIfRequested(_ entry: WorkbenchWindowEntry) {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["REVIEWGATE_SCREENSHOT_TOUR"], !dir.isEmpty else { return }
        let out = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let tour = Tour(entry: entry, out: out,
                        prompt: env["REVIEWGATE_SCREENSHOT_PROMPT"].flatMap { $0.isEmpty ? nil : $0 } ?? defaultPrompt,
                        model: env["REVIEWGATE_SCREENSHOT_MODEL"].flatMap { $0.isEmpty ? nil : $0 } ?? "haiku")
        guard Bundle.main.bundleIdentifier?.hasSuffix(".screenshots") == true else {
            tour.finish(TourError("bundle id \(Bundle.main.bundleIdentifier ?? "?") does not end in .screenshots"))
            return
        }
        entry.store.fileLog = EngineLogFile(directory: out.appendingPathComponent("logs"))   // not ~/Library/Logs/ReviewGate
        Task { await tour.run() }
    }
}

private struct TourError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

@MainActor
private final class Tour {
    let entry: WorkbenchWindowEntry
    let out: URL
    let prompt: String
    let model: String
    private var store: AppState { entry.store }
    private let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "Screenshot tour")

    init(entry: WorkbenchWindowEntry, out: URL, prompt: String, model: String) {
        self.entry = entry
        self.out = out
        self.prompt = prompt
        self.model = model
    }

    func run() async {
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "1" {
            do { try await layoutShots(); finish(nil) } catch { finish(error) }
            return
        }
        do {
            try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
            try place()
            if let refusal = await store.setModel(model) { throw TourError("set_model \(model): \(refusal)") }
            log("sending on \(model): \(prompt)")
            store.send(prompt)
            try await waitForReview()
            try await wait("turn summary", timeout: 60) { store in
                store.transcript.contains { if case .turnSummary = $0 { true } else { false } }
            }
            try await shoot()
            finish(nil)
        } catch {
            finish(error)
        }
    }

    // MARK: Driving the turn

    /// Until the review gate holds the turn's files. A permission card is denied (the prompt asks for edits only), a
    /// question skipped; a turn that ends without changes fails the tour.
    private func waitForReview() async throws {
        let deadline = ContinuousClock.now + .seconds(300)
        var answered = Set<String>()
        var ran = false
        while ContinuousClock.now < deadline {
            if let request = store.pendingPermission, answered.insert(request.requestId).inserted {
                log("answering \(request.toolName) request \(request.requestId)")
                if request.toolName == AskUserQuestions.toolName {
                    store.skipQuestions(requestId: request.requestId)
                } else {
                    store.respondPermission(requestId: request.requestId, allow: false,
                                            message: "No commands in this session: edit the files only.")
                }
            }
            switch store.gatePhase {
            case .running, .collecting: ran = true
            case .reviewing where !store.changedFiles.isEmpty:
                log("review: " + store.changedFiles.map { "\($0.path) +\($0.added) -\($0.deleted)" }.joined(separator: ", "))
                return
            case .idle where ran: throw TourError("the turn ended without changes")
            case .collectFailed: throw TourError("collecting the review failed: \(store.reviewCollectFailed ?? "?")")
            default: break
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw TourError("timed out waiting for the review")
    }

    private func wait(_ what: String, timeout seconds: Int, until done: (AppState) -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !done(store) {
            guard ContinuousClock.now < deadline else { throw TourError("timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(250))
        }
        log(what)
    }

    // MARK: Shots

    /// 1440×900 pt, in front, on a Retina screen when there is one (the capture has the screen's scale), and away from the
    /// mouse pointer when the screen has room (a row under it would show its hover controls).
    private func place() throws {
        guard let window = entry.window else { throw TourError("no window") }
        let size = NSSize(width: 1440, height: 900)
        let screen = NSScreen.screens.filter { $0.visibleFrame.width >= size.width && $0.visibleFrame.height >= size.height }
            .max { $0.backingScaleFactor < $1.backingScaleFactor } ?? window.screen ?? NSScreen.main
        let v = screen?.visibleFrame ?? window.frame
        let origins = [NSPoint(x: v.midX - size.width / 2, y: v.midY - size.height / 2),
                       NSPoint(x: v.minX, y: v.maxY - size.height), NSPoint(x: v.maxX - size.width, y: v.maxY - size.height),
                       NSPoint(x: v.minX, y: v.minY), NSPoint(x: v.maxX - size.width, y: v.minY)]
        let origin = origins.first { !NSRect(origin: $0, size: size).contains(NSEvent.mouseLocation) } ?? origins[0]
        window.setFrame(NSRect(origin: origin, size: size), display: true)
        entry.focus()
    }

    /// `review`: the whole window. `why`: the diff's header, "Why it changed" and the chat's turn summary, down to the HUD.
    /// `budget`: the chat's foot — the HUD with the turn budget, the pending-review notice and the composer. `agents`: the
    /// window with the agent panel open.
    private func shoot() async throws {
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        // An occluded window renders no new rows, and an app in the background cannot activate itself (macOS 14+): above
        // the other apps' windows for the few seconds of the shots.
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        guard let file = mostInteresting(store.changedFiles) else { throw TourError("no file to show") }
        store.selectFile(path: file.path)
        try await wait("diff of \(file.path)", timeout: 30) { $0.selectedDiff != nil }
        for appearance in [Appearance.dark, .light] {
            AppSettings.setAppearance(appearance)
            try await settle(window)
            let image = try render(window)
            try write(image, "review-\(appearance.rawValue)")
            let regions = try layout(window)
            try write(image, "why-\(appearance.rawValue)", crop: regions.why)
            try write(image, "budget-\(appearance.rawValue)", crop: regions.budget)
        }
        // The agent panel with the sidebar folded, so the chat keeps the width it had.
        UserDefaults.standard.set(true, forKey: AgentPanel.storageKey)
        let sidebar = try sidebarItem(window)
        sidebar?.isCollapsed = true
        log("sidebar folded: \(sidebar != nil)")
        for appearance in [Appearance.dark, .light] {
            AppSettings.setAppearance(appearance)
            try await settle(window)
            try write(try render(window), "agents-\(appearance.rawValue)")
        }
        UserDefaults.standard.set(false, forKey: AgentPanel.storageKey)
    }

    /// §49.2 (`SHOTS_LAYOUT=1`): no turn — the chat column in short windows with the mode offer card up, and the
    /// "Run as Task" sheet. `layout-<w>x<h>.png`, `run-as-task.png`.
    private func layoutShots() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        store.debugShowDefaultModeOffer(.auto)
        for size in [NSSize(width: 1100, height: 752), NSSize(width: 1100, height: 640), NSSize(width: 1100, height: 572)] {
            window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
            try await Task.sleep(for: .milliseconds(1200))
            log("frame \(NSStringFromRect(window.frame)), min \(NSStringFromSize(window.minSize))")
            try write(try render(window), "layout-\(Int(size.width))x\(Int(size.height))")
        }
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1100, height: 752)), display: true)
        entry.model.runAsTask("Do the task at https://tasks.example.com/project/tasks/4821 — fix the cart total")
        try await Task.sleep(for: .milliseconds(1500))
        guard let sheet = window.attachedSheet, let frame = sheet.contentView?.superview else { throw TourError("no Run as Task sheet") }
        frame.layoutSubtreeIfNeeded()
        guard let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { throw TourError("no bitmap") }
        frame.cacheDisplay(in: frame.bounds, to: rep)
        try write(rep, "run-as-task")
        entry.model.showNewWorkbench = false
    }

    /// The chat's scroll view, found before the agent panel adds scroll views of its own.
    private weak var transcript: NSScrollView?

    /// Appearance, highlighting and layout settle. The chat's lazy rows streamed in during the turn draw nothing in a capture
    /// until the column's width changes: a one-point wider window and back, then the transcript scrolled to its end.
    private func settle(_ window: NSWindow) async throws {
        try await activate(window)
        let frame = window.frame
        window.setFrame(NSRect(origin: frame.origin, size: NSSize(width: frame.width + 1, height: frame.height)), display: true)
        try await Task.sleep(for: .milliseconds(400))
        window.setFrame(frame, display: true)
        if transcript?.window == nil {
            transcript = try scrollViews(window).max { $0.convert($0.bounds, to: nil).maxX < $1.convert($1.bounds, to: nil).maxX }
        }
        for _ in 0..<2 {   // twice: the rows realized at the end change the content height
            try await Task.sleep(for: .milliseconds(500))
            if let chat = transcript, let document = chat.documentView {
                let clip = chat.contentView
                clip.scroll(to: NSPoint(x: clip.bounds.minX,
                                        y: document.isFlipped ? max(0, document.frame.height - clip.bounds.height) : 0))
                chat.reflectScrolledClipView(clip)
            }
        }
        try await Task.sleep(for: .milliseconds(1500))
        log("settled: active \(NSApp.isActive), key \(window.isKeyWindow), visible \(window.occlusionState.contains(.visible)), "
            + "chat \(transcript.map { NSStringFromRect($0.contentView.bounds) + " of " + NSStringFromRect($0.documentView?.frame ?? .zero) } ?? "?")")
    }

    /// An inactive window draws grey controls, and an app in the background cannot activate itself (macOS 14+): the script
    /// answers `activate` with `open -a`, which LaunchServices may honour. If nothing does, the shot is taken inactive.
    private func activate(_ window: NSWindow) async throws {
        guard !NSApp.isActive else { return }
        try? Data().write(to: out.appendingPathComponent("activate"))
        NSApp.activate()
        let deadline = ContinuousClock.now + .seconds(5)
        while !NSApp.isActive, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(250)) }
        window.makeKeyAndOrderFront(nil)
    }

    /// The NavigationSplitView's sidebar: the split view controller AppKit has behind it is the split view's delegate.
    private func sidebarItem(_ window: NSWindow) throws -> NSSplitViewItem? {
        try views(NSSplitView.self, in: window, minSize: 0).lazy
            .compactMap { ($0.delegate as? NSSplitViewController)?.splitViewItems.first { $0.behavior == .sidebar } }.first
    }

    /// SwiftUI's lists and scroll views on screen, as AppKit has them.
    private func scrollViews(_ window: NSWindow) throws -> [NSScrollView] {
        try views(NSScrollView.self, in: window, minSize: 150)
    }

    private func views<V: NSView>(_ type: V.Type, in window: NSWindow, minSize: CGFloat) throws -> [V] {
        guard let root = window.contentView else { throw TourError("no content view") }
        var found: [V] = []
        func walk(_ view: NSView) {
            if let match = view as? V, !view.isHiddenOrHasHiddenAncestor, view.bounds.width > minSize, view.bounds.height > minSize {
                found.append(match)
            }
            view.subviews.forEach(walk)
        }
        walk(root)
        return found
    }

    /// The crops, in window points (bottom-left origin), from the scroll views: the leftmost is the sidebar's file list, the
    /// rightmost the chat transcript, whose foot the HUD sits on.
    private func layout(_ window: NSWindow) throws -> (why: NSRect, budget: NSRect) {
        guard let root = window.contentView else { throw TourError("no content view") }
        let frames = try scrollViews(window).map { $0.convert($0.bounds, to: nil) }
        guard let sidebar = frames.min(by: { $0.minX < $1.minX }), let chat = frames.max(by: { $0.maxX < $1.maxX }),
              chat.minX > sidebar.maxX else { throw TourError("cannot find the sidebar and the chat") }
        let top = window.contentLayoutRect.maxY
        let hud: CGFloat = 30
        let why = NSRect(x: sidebar.maxX, y: chat.minY - hud, width: root.bounds.width - sidebar.maxX, height: top - chat.minY + hud)
        let budget = NSRect(x: chat.minX, y: 0, width: root.bounds.width - chat.minX, height: chat.minY)
        return (why, budget)
    }

    /// A source file over a test, an edited file over a new one (both colours in the diff), then the most changed lines.
    private func mostInteresting(_ files: [ChangedFile]) -> ChangedFile? {
        files.filter { !$0.isBinary }.max { a, b in
            let (ta, tb) = (a.path.contains("test"), b.path.contains("test"))
            if ta != tb { return ta }
            let (ma, mb) = (a.status == .modified, b.status == .modified)
            return ma != mb ? mb : a.added + a.deleted < b.added + b.deleted
        }
    }

    /// The whole window, title bar and toolbar included (the theme frame), at the screen's backing scale.
    private func render(_ window: NSWindow) throws -> NSBitmapImageRep {
        guard let frame = window.contentView?.superview else { throw TourError("no theme frame") }
        frame.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        guard let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { throw TourError("no bitmap") }
        frame.cacheDisplay(in: frame.bounds, to: rep)
        return rep
    }

    /// `crop`: window points, bottom-left origin (the image's rows run top-down).
    private func write(_ rep: NSBitmapImageRep, _ name: String, crop: NSRect? = nil) throws {
        var image = rep.cgImage
        if let crop, let full = image {
            let scale = CGFloat(rep.pixelsWide) / rep.size.width
            let rect = CGRect(x: crop.minX * scale, y: (rep.size.height - crop.maxY) * scale,
                              width: crop.width * scale, height: crop.height * scale).integral
            image = full.cropping(to: rect)
        }
        guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw TourError("no PNG for \(name)")
        }
        try png.write(to: out.appendingPathComponent("\(name).png"))
        log("wrote \(name).png (\(image.width)×\(image.height))")
    }

    // MARK: Ending

    func finish(_ error: Error?) {
        if let error {
            log("failed: \(error)")
            try? "\(error)\n".write(to: out.appendingPathComponent("tour-failed.txt"), atomically: true, encoding: .utf8)
        } else {
            log("done")
        }
        ProcessInfo.processInfo.endActivity(activity)
        // From the run loop, not from this main-queue job: Quit's `.terminateLater` waits for engine shutdown tasks that
        // need the main queue.
        RunLoop.main.perform { NSApp.terminate(nil) }
    }

    private func log(_ line: String) {
        let entry = "\(Date().formatted(.iso8601)) \(line)\n"
        let url = out.appendingPathComponent("tour.log")
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(entry.utf8))
        } else {
            try? entry.write(to: url, atomically: true, encoding: .utf8)
        }
    }
}
#endif
