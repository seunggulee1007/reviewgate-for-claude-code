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
            logTranscript(image)
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
            let image = try render(window)
            try write(image, "agents-\(appearance.rawValue)")
            logTranscript(image)
        }
        UserDefaults.standard.set(false, forKey: AgentPanel.storageKey)
    }

    /// §49.2 (`SHOTS_LAYOUT=1`): no turn — the chat column in short windows with the mode offer card up, the "Run as Task"
    /// sheet, the commit sheet's "나눠서 커밋" (§53), and the transcript as the column around it changes (§45.1).
    /// `layout-<w>x<h>.png`, `run-as-task.png`, `commit-split-*.png`, `chat-*.png`.
    private func layoutShots() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        // §49.2: a laptop screen's window (1000 × 637) and the smallest window (900 × 460 + the toolbar), with and without
        // the mode offer above the composer.
        for offer in [true, false] {
            store.debugShowDefaultModeOffer(offer ? .auto : nil)
            for size in [NSSize(width: 1100, height: 752), NSSize(width: 1000, height: 637), NSSize(width: 900, height: 512)] {
                window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
                try await Task.sleep(for: .milliseconds(1200))
                log("frame \(NSStringFromRect(window.frame)), min \(NSStringFromSize(window.minSize))")
                try write(try render(window), "layout-\(offer ? "offer-" : "")\(Int(size.width))x\(Int(size.height))")
            }
        }
        store.debugShowDefaultModeOffer(nil)
        try await backgroundShots(window)
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1100, height: 752)), display: true)
        entry.model.runAsTask("Do the task at https://tasks.example.com/project/tasks/4821 — fix the cart total")
        try await Task.sleep(for: .milliseconds(1500))
        guard let sheet = window.attachedSheet, let frame = sheet.contentView?.superview else { throw TourError("no Run as Task sheet") }
        frame.layoutSubtreeIfNeeded()
        guard let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { throw TourError("no bitmap") }
        frame.cacheDisplay(in: frame.bounds, to: rep)
        try write(rep, "run-as-task")
        entry.model.showNewWorkbench = false
        try await Task.sleep(for: .milliseconds(800))
        try await prSheetShot()
        try await commitSplitShots(window)
        try await transcriptShots(window)
    }

    /// The transcript at the laptop size, through what changes the chat column around it: a long chat, a turn streamed in,
    /// the permission mode cycled as ⇧⇥ does, the diff pane opened (⌘⇧D) and the mode cycled beside it, turns that end into a
    /// review and reviews that end. `chat-<n>-<step>.png`, taken as they come (no width nudge); the log has the transcript's
    /// scroll position and how much of it is drawn.
    private func transcriptShots(_ window: NSWindow) async throws {
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(1200))
        var shot = 0
        func capture(_ step: String) async throws {
            try await Task.sleep(for: .milliseconds(1200))
            shot += 1
            let image = try render(window)
            try write(image, "chat-\(shot)-\(step)")
            logTranscript(image)
        }
        func cycleModes(_ times: Int, _ prefix: String) async throws {
            for _ in 0..<times {
                store.cyclePermissionMode()   // ⇧⇥ in the message box
                try await capture("\(prefix)mode-\(store.permissionMode.rawValue)")
            }
        }
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        store.debugHandle((1...20).flatMap { Self.turnEvents($0, root: root) })   // a long chat
        try await capture("long-chat")
        store.debugShowGate(.running)
        try await stream(Self.turnEvents(21, root: root))
        store.debugShowGate(.idle)
        try await capture("streamed")
        try await cycleModes(4, "")
        for round in 1...5 {
            entry.model.toggleDiffTick += 1   // ⌘⇧D
            try await capture("diff-open-\(round)")
            try await cycleModes(4, "diff-")
            entry.model.toggleDiffTick += 1
            try await capture("diff-closed-\(round)")
        }
        // Turns that end into a review (running, rows streamed in, collecting, the summary and the files), and the review
        // ending (the files accepted).
        let files = [ChangedFile(path: "src/pricing.ts", oldPath: nil, status: .modified, added: 14, deleted: 2, isBinary: false),
                     ChangedFile(path: "src/cart.ts", oldPath: nil, status: .modified, added: 9, deleted: 3, isBinary: false)]
        for turn in 22...24 {
            store.debugShowGate(.running)
            try await stream(Self.turnEvents(turn, root: root))
            store.debugShowGate(.collecting)
            try await Task.sleep(for: .milliseconds(300))
            store.debugHandle([.turnSummary(TurnSummary(turn: turn, files: files.map { TurnSummary.File(path: $0.path, adds: $0.added, dels: $0.deleted) }))])
            store.debugShowGate(.reviewing, files: files)
            try await capture("review-\(turn)")
            store.debugShowGate(.idle)
            try await capture("reviewed-\(turn)")
        }
    }

    /// Events one by one, as a turn sends them: the answer's text in small pieces.
    private func stream(_ events: [EngineEvent]) async throws {
        for event in events {
            store.debugHandle([event])
            if case .textDelta = event { try await Task.sleep(for: .milliseconds(20)) } else { try await Task.sleep(for: .milliseconds(150)) }
        }
    }

    /// One turn of a made-up chat about the demo project: the request, a read, an edit, a test run and the answers.
    private static func turnEvents(_ turn: Int, root: String) -> [EngineEvent] {
        let file = "\(root)/src/\(turn % 2 == 0 ? "cart" : "pricing").ts"
        let read = "toolu_read_\(turn)", edit = "toolu_edit_\(turn)", test = "toolu_test_\(turn)"
        func answer(_ text: String) -> [EngineEvent] {
            text.split(separator: " ", omittingEmptySubsequences: false).enumerated().map { i, word in .textDelta(text: (i == 0 ? "" : " ") + word) }
        }
        return [.userMessage(text: "Step \(turn): make the discount codes stack in the order they were entered, and keep the tests green.", turn: turn)]
            + answer("I'll read the pricing code first to see how a code is applied today.")
            + [.toolUse(id: read, name: "Read", input: .object(["file_path": .string(file)]), file: file),
               .toolResult(toolUseId: read, isError: false, preview: (1...12).map { "\($0)\texport const line\($0) = \($0 * 10);" }.joined(separator: "\n"))]
            + answer("""
            The codes are applied one by one, but **SAVE10** is taken off the subtotal after shipping. I'll change \
            `applyCodes` so that:

            1. percentage codes come first, in the order entered;
            2. `FREESHIP` only zeroes the shipping line;
            3. an unknown code throws `UnknownCodeError` with the code in its message.
            """)
            + [.toolUse(id: edit, name: "Edit", input: .object(["file_path": .string(file), "old_string": .string("const total = subtotal + shipping;"),
                                                                 "new_string": .string("const total = applyCodes(subtotal, codes) + shippingFor(codes);")]), file: file),
               .toolResult(toolUseId: edit, isError: false, preview: "The file \(file) has been updated."),
               .toolUse(id: test, name: "Bash", input: .object(["command": .string("npm test"), "description": .string("Run the tests")]), file: nil),
               .toolResult(toolUseId: test, isError: false, preview: "✔ applies SAVE10 (2ms)\n✔ FREESHIP removes shipping (1ms)\n✔ rejects unknown codes (1ms)\nℹ tests 12\nℹ pass 12")]
            + answer("Step \(turn) is done: the codes stack in order and all 12 tests pass.")
    }

    /// The transcript's scroll view in `image`: what it shows of its content, and how much of that is drawn ("BLANK": nothing).
    private func logTranscript(_ image: NSBitmapImageRep) {
        if transcript?.window == nil, let window = entry.window {
            transcript = (try? scrollViews(window))?.max { $0.convert($0.bounds, to: nil).maxX < $1.convert($1.bounds, to: nil).maxX }
        }
        guard let chat = transcript else { return log("chat: no scroll view") }
        let frame = chat.convert(chat.bounds, to: nil)
        let ink = Self.ink(image, in: frame)
        log("chat: shows \(NSStringFromRect(chat.contentView.bounds)) of \(NSStringFromRect(chat.documentView?.frame ?? .zero)), "
            + "frame \(NSStringFromRect(frame)), ink \(String(format: "%.1f", ink * 100)) %" + (ink < 0.01 ? " — BLANK" : ""))
    }

    /// The share of `rect`'s pixels (window points, bottom-left origin) that differ from its most common colour.
    private static func ink(_ rep: NSBitmapImageRep, in rect: NSRect) -> Double {
        let scale = CGFloat(rep.pixelsWide) / rep.size.width
        let crop = CGRect(x: rect.minX * scale, y: (rep.size.height - rect.maxY) * scale,
                          width: rect.width * scale, height: rect.height * scale).integral
        guard let image = rep.cgImage?.cropping(to: crop) else { return 1 }
        let (w, h) = (image.width, image.height)
        var px = [UInt8](repeating: 0, count: w * h * 4)
        px.withUnsafeMutableBytes { buffer in
            CGContext(data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?
                .draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        var counts: [Int: Int] = [:]
        for i in stride(from: 0, to: px.count, by: 4) { counts[Int(px[i]) << 16 | Int(px[i + 1]) << 8 | Int(px[i + 2]), default: 0] += 1 }
        guard let background = counts.max(by: { $0.value < $1.value })?.key else { return 1 }
        let (r, g, b) = (background >> 16 & 255, background >> 8 & 255, background & 255)
        var ink = 0
        for i in stride(from: 0, to: px.count, by: 4) where abs(Int(px[i]) - r) + abs(Int(px[i + 1]) - g) + abs(Int(px[i + 2]) - b) > 40 {
            ink += 1
        }
        return Double(ink) / Double(max(w * h, 1))
    }

    /// §52: the chat with two background tasks (the HUD chip) and the row of a turn Claude started after one ended, at the
    /// laptop size; then the chip's list on its own.
    private func backgroundShots(_ window: NSWindow) async throws {
        store.debugShowBackgroundWork()
        defer { store.debugHideBackgroundWork() }
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(1500))
        try write(try render(window), "background-1000x637")
        let view = NSHostingView(rootView: BackgroundTasksPopover().environment(store))
        let panel = NSWindow(contentRect: NSRect(origin: .zero, size: view.fittingSize), styleMask: [.titled], backing: .buffered, defer: false)
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.contentView = view
        panel.setFrameOrigin(NSPoint(x: window.frame.minX, y: window.frame.minY))
        panel.orderFrontRegardless()
        defer { panel.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(800))
        panel.setContentSize(view.fittingSize)
        try await Task.sleep(for: .milliseconds(300))
        try write(try render(panel), "background-tasks")
    }

    /// §51: the Create PR sheet — every field named on the left, "AI로 채우기" under the description.
    private func prSheetShot() async throws {
        let view = NSHostingView(rootView: CreatePRSheet().environment(store).environment(store.pr).environment(entry.model))
        let panel = NSWindow(contentRect: NSRect(origin: .zero, size: view.fittingSize), styleMask: [.titled], backing: .buffered, defer: false)
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.contentView = view
        panel.setFrameOrigin(NSPoint(x: entry.window?.frame.minX ?? 0, y: entry.window?.frame.minY ?? 0))
        panel.orderFrontRegardless()
        defer { panel.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(2500))   // the base is picked, then pr_draft fills the fields
        panel.setContentSize(view.fittingSize)
        try await Task.sleep(for: .milliseconds(500))
        try write(try render(panel), "create-pr")
    }

    /// §53: the commit sheet's "나눠서 커밋" on the laptop-size window — the user's cards with a hunk open (`cards`), Claude's
    /// split (`ai`) and a series that stopped after its first commit (`stopped`), then "한 번에 커밋" (`commit-single`).
    /// `commit-split-<step>.png` is the window with the sheet on it as the user sees it (a sheet taller than the window is cut
    /// there, and the log says so); `commit-split-<step>-sheet.png` the sheet alone.
    private func commitSplitShots(_ window: NSWindow) async throws {
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(1200))
        let files = Self.splitFiles
        let paths = files.map(\.path)
        var mine = CommitSplitState(files: files, message: "feat(cart): discount codes SAVE10 and FREESHIP")
        let tests = mine.addCard()
        mine.setMessage("test(cart): the discount codes", card: tests)
        mine.moveFile("test/cart.test.ts", from: .card(1), to: .card(tests), files: files)
        mine.movePart(SplitPart(path: "src/cart.ts", hunk: 2), from: .card(1), to: .card(tests), files: files)
        mine.moveFile("src/format.ts", from: .card(1), to: .notCommitted, files: files)
        let cards = CommitSplitSession(paths: paths, files: files, state: mine)
        cards.toggleExpanded(SplitPart(path: "src/pricing.ts", hunk: 0), in: .card(1))

        var proposed = mine
        proposed.propose(files: files, commits: [
            CommitPlan(message: "feat(pricing): discount codes SAVE10 and FREESHIP",
                       parts: [CommitPart(path: "src/pricing.ts")],
                       why: "The codes and their rule come first; the cart builds on them."),
            CommitPlan(message: "feat(cart): apply a discount code to the totals",
                       parts: [CommitPart(path: "src/cart.ts"), CommitPart(path: "test/cart.test.ts"), CommitPart(path: "README.md")],
                       why: "The cart applies the codes; its test and the README describe this change."),
            CommitPlan(message: "fix(format): a minus sign for negative amounts",
                       parts: [CommitPart(path: "src/format.ts")],
                       why: "An unrelated fix found on the way, in its own commit."),
        ])
        let ai = CommitSplitSession(paths: paths, files: files, state: proposed)

        let stopped = CommitSplitSession(paths: paths, files: files, state: proposed)
        let made = [SeriesCommit(sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", message: "feat(pricing): discount codes SAVE10 and FREESHIP",
                                 files: ["src/pricing.ts"])]
        stopped.debugShow(made: made, commitError: CommitSplitText.failure(
            EngineClientError.refused("commit_failed:pre-commit hook rejected the commit (npm test: 1 failing)", code: "commit_failed"), made: made))

        for (step, session) in [("cards", cards), ("ai", ai), ("stopped", stopped)] {
            try await sheetShot("commit-split-\(step)", on: window, CommitSheet(splitPreview: session))
        }
        try await sheetShot("commit-single", on: window, CommitSheet())   // the mode picker beside the title, 520 pt wide
    }

    /// `content` as a sheet on `window`: the window with the sheet where AppKit puts it, and the sheet alone.
    private func sheetShot(_ name: String, on window: NSWindow, _ content: some View) async throws {
        let controller = NSHostingController(rootView: content.environment(store).environment(store.pr).environment(entry.model))
        controller.sizingOptions = [.preferredContentSize]
        let sheet = NSWindow(contentViewController: controller)
        sheet.appearance = NSAppearance(named: .darkAqua)
        window.beginSheet(sheet, completionHandler: nil)
        defer { window.endSheet(sheet) }
        try await Task.sleep(for: .milliseconds(1500))
        let (outer, inner) = (window.frame, sheet.frame)
        log("\(name): sheet \(NSStringFromRect(inner)) on window \(NSStringFromRect(outer))"
            + (inner.minY < outer.minY || inner.maxY > outer.maxY ? " — TALLER THAN THE WINDOW" : ""))
        let back = try render(window)
        let front = try render(sheet)
        try write(front, "\(name)-sheet")
        let scale = CGFloat(back.pixelsWide) / back.size.width
        guard let backImage = back.cgImage, let frontImage = front.cgImage,
              let context = CGContext(data: nil, width: backImage.width, height: backImage.height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw TourError("no composite for \(name)") }
        context.draw(backImage, in: CGRect(x: 0, y: 0, width: backImage.width, height: backImage.height))
        context.setFillColor(NSColor.black.withAlphaComponent(0.25).cgColor)   // the window behind a sheet
        context.fill(CGRect(x: 0, y: 0, width: backImage.width, height: backImage.height))
        context.draw(frontImage, in: CGRect(x: (inner.minX - outer.minX) * scale, y: (inner.minY - outer.minY) * scale,
                                            width: inner.width * scale, height: inner.height * scale))
        guard let composite = context.makeImage() else { throw TourError("no composite for \(name)") }
        try write(NSBitmapImageRep(cgImage: composite), name)
    }

    /// The demo project's discount-code change as `commit_hunks` sends it: two files split by hunks, three whole-only ones.
    private static let splitFiles: [CommitFile] = [
        CommitFile(path: "src/pricing.ts", hunks: [
            CommitHunk(id: 0, header: "@@ -1,5 +1,11 @@", added: 6, deleted: 0, text: """
             /** Flat shipping per order, in cents. */
             export const FLAT_SHIPPING = 599;
            +/** Discount codes: a share of the subtotal off, or free shipping. */
            +export const DISCOUNT_CODES = {
            +  SAVE10: { percentOff: 10 },
            +  FREESHIP: { freeShipping: true },
            +} as const;
            +export type DiscountCode = keyof typeof DISCOUNT_CODES;
             /** Orders from this subtotal ship free, in cents. */
             export const FREE_SHIPPING_FROM = 5000;
            """),
            CommitHunk(id: 1, header: "@@ -14,3 +20,8 @@ export function taxFor(amount: number): number {", added: 5, deleted: 0, text: """
               return Math.round(amount * TAX_RATE);
             }
            +
            +export function discountFor(code: DiscountCode, subtotal: number): number {
            +  const rule = DISCOUNT_CODES[code];
            +  return "percentOff" in rule ? Math.round((subtotal * rule.percentOff) / 100) : 0;
            +}
            """),
        ]),
        CommitFile(path: "src/cart.ts", hunks: [
            CommitHunk(id: 0, header: "@@ -1,4 +1,4 @@", added: 1, deleted: 1, text: """
            -import { shippingFor, taxFor } from "./pricing.ts";
            +import { DISCOUNT_CODES, discountFor, shippingFor, taxFor, type DiscountCode } from "./pricing.ts";
             import { formatPrice } from "./format.ts";
            """),
            CommitHunk(id: 1, header: "@@ -19,6 +19,15 @@ export interface Totals {", added: 9, deleted: 0, text: """
             export class Cart {
               private readonly items = new Map<string, LineItem>();
            +  private readonly codes: DiscountCode[] = [];
            +
            +  applyCode(code: string): void {
            +    if (!(code in DISCOUNT_CODES)) throw new RangeError(`unknown discount code: ${code}`);
            +    this.codes.push(code as DiscountCode);
            +  }
            """),
            CommitHunk(id: 2, header: "@@ -38,9 +47,11 @@ export class Cart {", added: 3, deleted: 2, text: """
               totals(): Totals {
                 const subtotal = this.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
            -    const shipping = shippingFor(subtotal);
            -    const tax = taxFor(subtotal);
            +    const discount = this.codes.reduce((sum, code) => sum + discountFor(code, subtotal), 0);
            +    const shipping = this.codes.includes("FREESHIP") ? 0 : shippingFor(subtotal);
            +    const tax = taxFor(subtotal - discount);
            """),
        ]),
        CommitFile(path: "test/cart.test.ts"),
        CommitFile(path: "README.md"),
        CommitFile(path: "src/format.ts"),
    ]

    /// The chat's scroll view, found before the agent panel adds scroll views of its own.
    private weak var transcript: NSScrollView?

    /// Appearance, highlighting and layout settle. The transcript keeps its newest rows in view by itself (§45.1): no width
    /// nudge, no scrolling here, so a blank transcript shows in the shots (and as BLANK in the log).
    private func settle(_ window: NSWindow) async throws {
        try await activate(window)
        if transcript?.window == nil {
            transcript = try scrollViews(window).max { $0.convert($0.bounds, to: nil).maxX < $1.convert($1.bounds, to: nil).maxX }
        }
        try await Task.sleep(for: .milliseconds(2900))
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
