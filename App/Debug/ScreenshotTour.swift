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

    /// A quiet run (`REVIEWGATE_SCREENSHOT_QUIET=1`: SHOTS_LAYOUT runs unless SHOTS_VISIBLE=1): the app never comes to the
    /// front or takes the focus — an accessory app, launched in the background — and its windows, sheets and panels are
    /// transparent and let clicks through, so the user working beside it sees nothing. The shots render the views
    /// (`cacheDisplay`), not the screen.
    private(set) static var quiet = false
    /// The tour's engine log (under its folder): every window it opens writes there, never to ~/Library/Logs/ReviewGate.
    private(set) static var logFile: EngineLogFile?
    private static var quietTimer: Timer?

    /// From `applicationWillFinishLaunching`, before any window shows.
    static func quietIfRequested() {
        let env = ProcessInfo.processInfo.environment
        guard env["REVIEWGATE_SCREENSHOT_TOUR"].map({ !$0.isEmpty }) == true, env["REVIEWGATE_SCREENSHOT_QUIET"] == "1",
              Bundle.main.bundleIdentifier?.hasSuffix(".screenshots") == true else { return }
        quiet = true
        NSApp.setActivationPolicy(.accessory)
        let timer = Timer(timeInterval: 0.05, repeats: true) { _ in MainActor.assumeIsolated { hideWindows() } }
        RunLoop.main.add(timer, forMode: .common)
        quietTimer = timer
        NotificationCenter.default.addObserver(forName: NSWindow.didUpdateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { hideWindows() }
        }
    }

    private static func hideWindows() {
        for window in NSApp.windows where window.alphaValue > 0 || !window.ignoresMouseEvents { hideIfQuiet(window) }
    }

    /// A window the tour orders in itself (a panel for a popover's shot): transparent before it shows, in a quiet run.
    static func hideIfQuiet(_ window: NSWindow) {
        guard quiet else { return }
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.hasShadow = false
    }

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
        logFile = EngineLogFile(directory: out.appendingPathComponent("logs"))
        entry.store.fileLog = logFile   // not ~/Library/Logs/ReviewGate — nor for the windows the tour opens
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
        // r1x (`SHOTS_LAYOUT=scroll`): only the transcript's scroll check, over a long made-up chat.
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "scroll" {
            do { try await scrollOnly(); finish(nil) } catch { finish(error) }
            return
        }
        // `SHOTS_LAYOUT=cards`: only the composer's shots, six times over the layout check's transcript.
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "cards" {
            do { try await cardsOnly(); finish(nil) } catch { finish(error) }
            return
        }
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "scrolldown" {
            do { try await scrollDownChecks(); finish(nil) } catch { finish(error) }
            return
        }
        // `SHOTS_LAYOUT=overlap`: rows laid out over one another in a long session of rich turns (`overlap:` lines).
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "overlap" {
            do { try await overlapChecks(); finish(nil) } catch { finish(error) }
            return
        }
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "cpu" {
            do { try await cpuChecks(); finish(nil) } catch { finish(error) }
            return
        }
        // `SHOTS_LAYOUT=cpulong`: the same after 45 more turns came while the chat stayed open (a long session's).
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "cpulong" {
            do { try await cpuChecks(longTurns: 45); finish(nil) } catch { finish(error) }
            return
        }
        // `SHOTS_LAYOUT=open`: what Open Project… / Switch Project… / Open in New Window… end in, state by state.
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "open" {
            do { try await openChecks(); finish(nil) } catch { finish(error) }
            return
        }
        // `SHOTS_LAYOUT=composer`: only the message box's terminal checks (paste, the slash palette, the queue).
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "composer" {
            do { try await composerOnly(); finish(nil) } catch { finish(error) }
            return
        }
        // `SHOTS_LAYOUT=blank`: only the blank-chat check in tall windows.
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "blank" {
            do { try await blankOnly(); finish(nil) } catch { finish(error) }
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
        entry.model.runAsTask("Do the task at https://tracker.example.com/issues/1800 — fix the cart total")
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
        try await scrollChecks(window)
        try await composerShots(window)
        try await guardsShots(window)
        try await peerShots(window)   // r2-peers
        try await sideShots(window)   // MARK: r2-skills-side (§55.4)
        try await whySkillShots()   // MARK: r2-skills-side (§31.1, M35)
        try await lifecycleShots(window)   // MARK: polish p-lifecycle (§55.8, §55.9)
        try await composerTerminalChecks(window)   // MARK: composer
    }

    /// r2-peers — messages between sessions at the laptop size, dark and light (§29, §33.2, §33.1): a message the default
    /// mode runs by itself (one line above the composer while Claude works), one no live session vouches for (the card), a
    /// SendMessage card that can be allowed for its session, two subagents' cards with the bulk answers, and the row of a
    /// turn another session's message started. `peer-<step>-<appearance>.png`; the log says "CUT" when the held message's
    /// card above the composer does not show whole (the permission cards are rows of the chat).
    private func peerShots(_ window: NSWindow) async throws {
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(1200))
        let terminal = PeerSessionInfo(address: "uds:/tmp/cc-socks/4242.sock", pid: 4242, name: "acme-b4", cwd: "/work/acme", status: .waiting,
                                       entrypoint: "cli", sessionId: "s-acme-b4")
        func held(_ id: String, sender: PeerSessionInfo?) -> PeerMessage {
            PeerMessage(id: id, from: terminal.address, fromName: "acme-b4", cause: "explicit-setting", receivedAt: "2026-11-06T06:00:00Z",
                        state: .held, sender: sender)
        }
        func shoot(_ step: String, _ appearance: Appearance) async throws {
            try await Task.sleep(for: .milliseconds(1500))
            try write(try render(window), "peer-\(step)-\(appearance.rawValue)")
        }
        func checkCards(_ step: String) {
            let cards = entry.model.debugCardsHeights   // width: the height shown, height: the height needed
            let whole = cards.height > 0 && cards.height <= cards.width + 0.5
            log("peer \(step): the cards above the composer shown at \(Int(cards.width)) of \(Int(cards.height)) pt" + (whole ? " — whole" : " — CUT"))
        }
        for appearance in [Appearance.dark, .light] {
            AppSettings.setAppearance(appearance)
            store.debugShowComposerState(working: true, files: [])
            store.debugShowPeerInbox([held("tour-peer-1-\(appearance.rawValue)", sender: terminal)], mode: .auto)
            try await shoot("auto", appearance)
            store.debugShowPeerInbox([held("tour-peer-2-\(appearance.rawValue)", sender: nil)], mode: .auto)
            try await shoot("card", appearance)
            checkCards("card-\(appearance.rawValue)")
            store.debugShowPeerInbox([], mode: .auto)
            var send = PermissionRequest(requestId: "tour-send-\(appearance.rawValue)", toolName: "SendMessage", input: .object([
                "to": .string(terminal.address), "summary": .string("#42 done"),
                "message": .string("The cart total is fixed and the tests pass. Take the review from here."),
            ]))
            send.toSession = terminal
            store.debugHandle([.permissionRequest(send)])
            try await shoot("send", appearance)
            store.respondPermission(requestId: send.requestId, allow: false)   // the engine says it is not its: the card leaves
            let executor = PermissionAgent(agentId: "tour-a", agentToolUseId: "tour-ag-a", subagentType: "executor", description: "compile")
            let tester = PermissionAgent(agentId: "tour-b", agentToolUseId: "tour-ag-b", subagentType: "test-engineer", description: "test")
            let first = PermissionRequest(requestId: "tour-bulk-1-\(appearance.rawValue)", toolName: "Bash",
                                          input: .object(["command": .string("./gradlew :acme-api:compileJava")]), file: nil, toolUseId: "tour-b1",
                                          agent: executor)
            let second = PermissionRequest(requestId: "tour-bulk-2-\(appearance.rawValue)", toolName: "Bash",
                                           input: .object(["command": .string("./gradlew test")]), file: nil, toolUseId: "tour-b2", agent: tester)
            store.debugHandle([.permissionRequest(first), .permissionRequest(second)])
            try await shoot("bulk", appearance)
            store.respondPermission(requestId: first.requestId, allow: false)
            store.respondPermission(requestId: second.requestId, allow: false)
            store.debugShowComposerState(working: false, files: [])
            store.debugHandle([.peerMessage(PeerMessage(id: "tour-peer-row-\(appearance.rawValue)", from: terminal.address, fromName: "acme-b4",
                                                        verifiedPeerPid: 4242, cause: "explicit-setting", receivedAt: "2026-11-06T06:00:00Z",
                                                        state: .delivered, body: "#42 리뷰 끝났어 — 장바구니 합계 수정은 그대로 두고 테스트만 하나 더 붙여줘",
                                                        turn: 3, sender: terminal))])
            try await shoot("row", appearance)
        }
        store.debugShowPeerInbox([], mode: .auto)
        store.debugShowGate(.idle)
        AppSettings.setAppearance(.dark)
    }

    /// MARK: r2-skills-side — §31.1 (M35): "Why it changed" of a file a slash command's !`command` line wrote: the command
    /// named ("/acme-verify", its lines ran while it loaded) — not a call missing from the chat — dark and light, 560 pt
    /// wide as in the diff pane. `why-skill-<appearance>.png`, and a `why-skill:` line in tour.log.
    private func whySkillShots() async throws {
        let json = #"{"path":"gen/version.txt","oldPath":null,"status":"M","added":1,"deleted":1,"isBinary":false,"tools":["Skill"],"toolUseIds":["skill:acme-verify"],"state":"pending","noteCount":0,"origin":"skill","risks":["bash"]}"#
        let file = try JSONDecoder().decode(ChangedFile.self, from: Data(json.utf8))
        log("why-skill: origin \(file.origin?.rawValue ?? "nil"), cause \(ReviewLeftovers.fileCause(file, index: store.transcriptIndex))")
        // A window of a fixed size: sized to the section's preferred size, its flexible width and scroll height kept asking
        // for another constraints pass until AppKit gave up (an exception, the tour ended there).
        let size = NSSize(width: 560, height: 120)
        for appearance in [Appearance.dark, .light] {
            let view = WhyChangedSection(file: file)
                .frame(width: size.width, height: size.height, alignment: .top)
                .environment(store).environment(store.pr).environment(entry.model)
            let panel = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.contentView = NSHostingView(rootView: view)
            panel.appearance = NSAppearance(named: appearance == .dark ? .darkAqua : .aqua)
            ScreenshotTour.hideIfQuiet(panel)
            panel.orderFrontRegardless()
            try await Task.sleep(for: .milliseconds(900))
            try write(try render(panel), "why-skill-\(appearance.rawValue)")
            panel.orderOut(nil)
        }
    }

    /// MARK: r2-skills-side — §55.4: the side panel at the laptop size, dark and light: the list (an answer, a failed
    /// question), a thread whose answer tried to run a skill ([메인 대화로 보내기]) with its tool calls, and a question that is
    /// a slash command (the engine refuses it `side_command`). `side-<step>-<appearance>.png`.
    private func sideShots(_ window: NSWindow) async throws {
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        let main = store.currentSessionId ?? "tour-chat"
        store.debugHandle([.sideThreads(id: "tour", mainSessionId: main, threads: try Self.sideThreads(main: main))])
        store.side.present()
        store.side.showList()
        func shoot(_ step: String) async throws {
            for appearance in [Appearance.dark, .light] {
                AppSettings.setAppearance(appearance)
                try await Task.sleep(for: .milliseconds(900))
                try write(try render(window), "side-\(step)-\(appearance.rawValue)")
                try await sidePanelShot("side-panel-\(step)-\(appearance.rawValue)", appearance: appearance)
            }
        }
        try await Task.sleep(for: .milliseconds(1200))
        // present() opens the panel from the window's observer; after the composer steps' tab round trip it may not have
        // (the inspector stays shut, the sidebar beside the chat) — open it through the menu's own toggle then.
        if !UserDefaults.standard.bool(forKey: SidePanel.storageKey) {
            log("side: the panel did not open on present() — toggling it")
            entry.model.toggleSidePanelTick += 1
            try await Task.sleep(for: .milliseconds(1200))
        }
        log("side: panel open \(UserDefaults.standard.bool(forKey: SidePanel.storageKey)), window \(NSStringFromRect(window.frame))")
        try await shoot("list")
        store.side.select("tour-skill")
        try await shoot("skill")
        store.side.compose(anchor: nil)
        let asked = await store.side.ask("/compact")
        log("side: /compact asked \(asked), notice \(store.side.errors[""] ?? "none"), send-to-main \(store.side.mainOnlyRequest("") != nil)")
        try await shoot("command")
        store.side.showList()
        AppSettings.setAppearance(.dark)
    }

    /// The side panel alone at its ideal width (340 pt) and the laptop window's height — what it shows whether or not the
    /// window's inspector came up for the shot beside it (it stayed shut in some runs after the composer steps).
    private func sidePanelShot(_ name: String, appearance: Appearance) async throws {
        let size = NSSize(width: 340, height: 600)
        let view = SidePanelView()
            .frame(width: size.width, height: size.height)
            .environment(store).environment(store.pr).environment(entry.model)
        let panel = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: view)
        panel.appearance = NSAppearance(named: appearance == .dark ? .darkAqua : .aqua)
        ScreenshotTour.hideIfQuiet(panel)
        panel.orderFrontRegardless()
        try await Task.sleep(for: .milliseconds(700))
        try write(try render(panel), name)
        panel.orderOut(nil)
    }

    private static func sideThreads(main: String) throws -> [SideThread] {
        let skill = #"{"id":"tour-skill","mainSessionId":"\#(main)","anchor":null,"createdAt":"2026-11-06T05:00:00.000Z","updatedAt":"2026-11-06T05:01:00.000Z","title":"PR 12 리뷰 답변해 줘","messages":[{"role":"user","text":"PR 12 리뷰 답변해 줘","at":"2026-11-06T05:00:00.000Z"},{"role":"assistant","text":"리뷰 답변은 스킬이라 곁질문에서는 실행하지 못해요. 메인 대화로 보내면 그대로 실행돼요. 지금 PR에는 src/cart.ts의 합계 계산과 src/pricing.ts의 세금 규칙에 대한 지적이 두 개 있어요.","at":"2026-11-06T05:01:00.000Z","costUSD":0.0134,"durationMs":8200,"toolCalls":[{"id":"r1","name":"Read","input":{"file_path":"src/cart.ts"},"isError":false,"preview":"export function total"},{"id":"b1","name":"Bash","input":{"command":"gh pr view 12 --comments"},"isError":false,"preview":"2 comments"},{"id":"k1","name":"Skill","input":{"skill":"acme-tools:review-reply"},"isError":true,"preview":"ReviewGate: this is a side question","denied":true}]}],"status":"idle","error":null,"sessionId":"tour-side-1","fork":{"mode":"fork_full","fromSessionId":"\#(main)","at":null,"atTurn":1},"costUSD":0.0134}"#
        let answered = #"{"id":"tour-why","mainSessionId":"\#(main)","anchor":{"path":"src/cart.ts","line":12,"side":"new"},"createdAt":"2026-11-06T04:40:00.000Z","updatedAt":"2026-11-06T04:41:00.000Z","title":"왜 이 줄을 이렇게 바꿨어?","messages":[{"role":"user","text":"왜 이 줄을 이렇게 바꿨어?","at":"2026-11-06T04:40:00.000Z"},{"role":"assistant","text":"할인을 두 번 적용하던 버그를 막으려고 합계 전에 한 번만 적용하게 바꿨어요.","at":"2026-11-06T04:41:00.000Z","costUSD":0.004}],"status":"idle","error":null,"sessionId":"tour-side-2","fork":{"mode":"fork_full","fromSessionId":"\#(main)","at":null,"atTurn":1},"costUSD":0.004}"#
        let failed = #"{"id":"tour-fail","mainSessionId":"\#(main)","anchor":{"path":"src/pricing.ts"},"createdAt":"2026-11-06T04:30:00.000Z","updatedAt":"2026-11-06T04:31:00.000Z","title":"세금 규칙이 바뀐 이유는?","messages":[{"role":"user","text":"세금 규칙이 바뀐 이유는?","at":"2026-11-06T04:30:00.000Z"}],"status":"error","error":"the side session ended without an answer","sessionId":null,"fork":null,"costUSD":0}"#
        return try [skill, answered, failed].map { try NDJSON.decode(SideThread.self, from: $0) }
    }

    /// polish p-lifecycle — Help › Keyboard Shortcuts with its search (`shortcuts-<query>-<appearance>.png`), and the update
    /// banner on the laptop-size window while it downloads and while its restart waits for a window
    /// (`update-<phase>-<appearance>.png`, a made-up release).
    private func lifecycleShots(_ window: NSWindow) async throws {
        for (query, dark) in [("", true), ("", false), ("reject", true), ("zzz-nothing", false)] {
            let view = NSHostingView(rootView: ShortcutsView(query: query))
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 720), styleMask: [.titled], backing: .buffered, defer: false)
            panel.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            panel.contentView = view
            panel.setFrameOrigin(NSPoint(x: window.frame.minX, y: window.frame.minY))
            ScreenshotTour.hideIfQuiet(panel)
            panel.orderFrontRegardless()
            try await Task.sleep(for: .milliseconds(800))
            try write(try render(panel), "shortcuts-\(query.isEmpty ? "all" : query)-\(dark ? "dark" : "light")")
            panel.orderOut(nil)
        }
        let updater = AppUpdateController.shared
        defer { updater.debugShow(nil, release: nil) }
        guard let version = SemanticVersion("9.9.9") else { throw TourError("no version") }
        let release = AppRelease(tag: "v9.9.9", version: version,
                                 assets: [.init(name: "ReviewGate-9.9.9.dmg", size: 48_000_000), .init(name: "ReviewGate-9.9.9.dmg.sha256", size: 64)])
        let waiting = UpdateWait.Decision(blockers: [UpdateWait.Blocker(index: 0, name: "acme-shop", reason: .working)], stale: ["acme-web"])
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        for appearance in [Appearance.dark, .light] {
            AppSettings.setAppearance(appearance)
            updater.debugShow(.step(.downloading), release: release, received: 12_400_000)
            try await Task.sleep(for: .milliseconds(1000))
            try write(try render(window), "update-downloading-\(appearance.rawValue)")
            updater.debugShow(.waitingForClaude(waiting), release: release)
            try await Task.sleep(for: .milliseconds(1000))
            try write(try render(window), "update-waiting-\(appearance.rawValue)")
        }
        AppSettings.setAppearance(.dark)
    }

    /// r1-composer — the composer at the laptop size, dark and light (§49.2, §50, §38.1): Send in the window with files
    /// pending beside the diff (a review, and a turn that runs on beside it: Stop and 바로 보내기), Claude's question whole
    /// above the composer, and a message typed before a look at the PRs tab still there after it.
    /// `composer-<step>-<appearance>.png`; the log says "OUT OF THE WINDOW", "CUT" or "LOST" when one is not.
    private func composerShots(_ window: NSWindow, round: Int = 0) async throws {
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(1200))
        setComposerText("", in: window)   // what the transcript shots typed
        let files = [ChangedFile(path: "src/pricing.ts", oldPath: nil, status: .modified, added: 14, deleted: 2, isBinary: false),
                     ChangedFile(path: "src/cart.ts", oldPath: nil, status: .modified, added: 9, deleted: 3, isBinary: false)]
        func shoot(_ step: String, _ appearance: Appearance) async throws {
            try await Task.sleep(for: .milliseconds(1500))
            let image = try render(window)
            try write(image, "composer-\(step)-\(appearance.rawValue)")
            logTranscript(image)
        }
        func checkSend(_ step: String) {
            let send = entry.model.debugSendFrame
            let room = window.contentView?.bounds.size ?? .zero
            let inside = send.width > 0 && send.minX >= -0.5 && send.minY >= -0.5 && send.maxX <= room.width + 0.5 && send.maxY <= room.height + 0.5
            log("composer \(step): send button \(NSStringFromRect(send)) in \(NSStringFromSize(room))" + (inside ? " — in the window" : " — OUT OF THE WINDOW"))
        }
        func checkCards(_ step: String) {
            let cards = entry.model.debugCardsHeights   // width: the height shown, height: the height needed
            let whole = cards.height > 0 && cards.height <= cards.width + 0.5
            log("composer \(step): the cards above the composer shown at \(Int(cards.width)) of \(Int(cards.height)) pt" + (whole ? " — whole" : " — CUT"))
        }
        for appearance in [Appearance.dark, .light] {
            AppSettings.setAppearance(appearance)
            // A review began: files pending, the diff pane open beside the chat.
            store.debugShowComposerState(working: false, files: files)
            try await shoot("review", appearance)
            checkSend("review-\(appearance.rawValue)")
            // Claude works on beside the pending files: Stop and 바로 보내기.
            store.debugShowComposerState(working: true, files: files)
            try await shoot("working", appearance)
            checkSend("working-\(appearance.rawValue)")
            // Claude asks: the card above the composer, the message box answers it.
            let question = Self.question(id: "tour-question-\(appearance.rawValue)-\(round)")
            store.debugHandle([.permissionRequest(question)])
            try await shoot("question", appearance)
            checkSend("question-\(appearance.rawValue)")
            checkCards("question-\(appearance.rawValue)")
            store.skipQuestions(requestId: question.requestId)   // the engine says it is not its: the card leaves
            // r2-review-flow M27: a permission card while the review stands — whole above the composer (its Allow button in
            // sight), one line in the transcript.
            let card = Self.permission(id: "tour-permission-\(appearance.rawValue)-\(round)")
            store.debugHandle([.permissionRequest(card)])
            try await shoot("permission", appearance)
            checkSend("permission-\(appearance.rawValue)")
            checkCards("permission-\(appearance.rawValue)")
            store.respondPermission(requestId: card.requestId, allow: false, message: "tour")   // the card leaves: a decided line
            // r2-chats-cards M24 / M25 (§33.10): a permission card waits and a message is typed — 이 지시로 거부, the deny menu.
            let typedCard = PermissionRequest(requestId: "tour-card-\(appearance.rawValue)-\(round)", toolName: "Bash",
                                         input: .object(["command": .string("npm run e2e -- --grep cart")]))
            store.debugHandle([.permissionRequest(typedCard)])
            setComposerText("Run only the unit tests instead", in: window)
            try await shoot("card-text", appearance)
            checkSend("card-text-\(appearance.rawValue)")
            setComposerText("", in: window)
            store.denyPermission(requestId: typedCard.requestId)   // the engine says it is not its: the card leaves
            // A message typed, a look at the PRs tab, back to the chat.
            let draft = "Rename SAVE10 to WELCOME10 (typed, not sent, \(appearance.rawValue))"
            setComposerText(draft, in: window)
            entry.model.tab = .prs
            try await Task.sleep(for: .milliseconds(1500))
            entry.model.tab = .changes
            try await shoot("back-from-prs", appearance)
            let back = composerView(window)?.string
            log("composer after the PRs tab (\(appearance.rawValue)): draft " + (back == draft ? "kept" : "LOST (now \"\(back ?? "no composer")\")"))
            setComposerText("", in: window)
        }
        store.debugShowGate(.idle)
        AppSettings.setAppearance(.dark)
    }

    /// Types `text` into the composer as a user would (it replaces what is there).
    private func setComposerText(_ text: String, in window: NSWindow) {
        guard let box = composerView(window) else { return log("composer: no message box") }
        window.makeFirstResponder(box)
        box.insertText(text, replacementRange: NSRange(location: 0, length: (box.string as NSString).length))
    }

    /// r2-review-flow M27: a Bash call that asks first (a commit the demo's turn would make).
    private static func permission(id: String) -> PermissionRequest {
        PermissionRequest(requestId: id, toolName: "Bash", input: .object([
            "command": .string("git commit -m \"Rename SAVE10 to WELCOME10\" -- src/pricing.ts src/cart.ts"),
            "description": .string("Commit the discount rename"),
        ]))
    }

    /// Claude's AskUserQuestion about the demo project: one question, three options.
    private static func question(id: String) -> PermissionRequest {
        func option(_ label: String, _ description: String) -> JSONValue { .object(["label": .string(label), "description": .string(description)]) }
        return PermissionRequest(requestId: id, toolName: AskUserQuestions.toolName, input: .object([
            "questions": .array([.object([
                "question": .string("Where should the discount codes live?"),
                "header": .string("Codes"),
                "options": .array([option("src/pricing.ts", "Next to the shipping and tax rules"),
                                   option("A new src/discounts.ts", "Their own module, imported by the cart"),
                                   option("A JSON file", "Edited without a release; read at start")]),
                "multiSelect": .bool(false),
            ])]),
        ]))
    }

    /// r2-guards — what the guards lane shows, at the laptop size in dark and light (§33.4, §33.9, §39.4): the row of an
    /// EnterWorktree the chat did not follow (a worktree of the demo project, so it offers "이 채팅을 거기로 옮기기"), the
    /// claude_config card that names the settings taking effect before the review, and Settings › Permissions' isolation
    /// switch at the Settings window's width. `guards-<step>-<appearance>.png`; the log says "CUT" for a card above the
    /// composer not shown whole (a card drawn in the transcript is said to be there).
    private func guardsShots(_ window: NSWindow) async throws {
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(1200))
        setComposerText("", in: window)
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        let worktree = (root as NSString).appendingPathComponent(".claude/worktrees/acme-42")
        let git = Process()
        git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        git.arguments = ["-C", root, "worktree", "add", "-q", "-b", "worktree-acme-42", worktree]
        do { try git.run(); git.waitUntilExit() } catch { log("guards: git worktree add failed: \(error)") }
        // At most 10 s: an engine whose CLI stopped answering (seen after the Mac slept) never settles, and the rest of
        // the check need not wait for it.
        var refreshed = false
        Task { @MainActor in await store.refreshWorkbenches(); refreshed = true }
        let refreshDeadline = ContinuousClock.now + .seconds(10)
        while !refreshed, ContinuousClock.now < refreshDeadline { try await Task.sleep(for: .milliseconds(100)) }
        log("guards: \(worktree) is a workbench: \(store.isWorkbenchPath(worktree) ? "yes" : "NO")" + (refreshed ? "" : " (the workbench list did not come in 10 s)"))
        var entered = EngineErrorDetail(code: "worktree_outside_review")
        entered.toolName = "EnterWorktree"
        entered.path = worktree
        entered.branch = "worktree-acme-42"
        store.debugHandle([.error(message: "EnterWorktree worked outside this window's review (\(worktree)): …", fatal: false, scope: .session, detail: entered)])
        for appearance in [Appearance.dark, .light] {   // before any card: an answered card's notice would cover the row
            AppSettings.setAppearance(appearance)
            try await Task.sleep(for: .milliseconds(1500))
            try write(try render(window), "guards-worktree-row-\(appearance.rawValue)")
        }
        let settings = (root as NSString).appendingPathComponent(".claude/settings.json")
        for appearance in [Appearance.dark, .light] {
            AppSettings.setAppearance(appearance)
            let card = PermissionRequest(
                requestId: "tour-config-\(appearance.rawValue)", toolName: "Edit",
                input: .object(["file_path": .string(settings), "old_string": .string("\"hooks\": {}"),
                                "new_string": .string("\"hooks\": { \"PostToolUse\": [{ \"matcher\": \"Edit\", \"hooks\": [{ \"type\": \"command\", \"command\": \"npm run lint\" }] }] }")]),
                file: settings, toolUseId: "toolu_tour_config_\(appearance.rawValue)",
                reason: PermissionReason(code: .claudeConfig, message: "Changes Claude Code's own settings (.claude/settings.json: hooks, env.NODE_OPTIONS) — …",
                                         path: ".claude/settings.json", keys: ["hooks", "env.NODE_OPTIONS"]))
            store.debugHandle([.permissionRequest(card)])
            try await Task.sleep(for: .milliseconds(1500))
            try write(try render(window), "guards-config-card-\(appearance.rawValue)")
            let cards = entry.model.debugCardsHeights   // width: the height shown, height: the height needed; none: in the transcript
            log("guards config-card-\(appearance.rawValue): " + (cards.height == 0 ? "the card is in the transcript"
                : "the cards above the composer shown at \(Int(cards.width)) of \(Int(cards.height)) pt" + (cards.height <= cards.width + 0.5 ? " — whole" : " — CUT")))
            store.respondPermission(requestId: card.requestId, allow: false, message: "tour")   // the engine says it is not its: the card leaves
            let rows = NSHostingView(rootView: Form { Section("Permissions") { PermissionSettingsRows() } }
                .formStyle(.grouped).frame(width: 560, height: 430).environment(store))
            let panel = NSWindow(contentRect: NSRect(origin: .zero, size: NSSize(width: 560, height: 430)), styleMask: [.titled], backing: .buffered, defer: false)
            panel.appearance = NSAppearance(named: appearance == .dark ? .darkAqua : .aqua)
            panel.contentView = rows
            panel.setFrameOrigin(NSPoint(x: window.frame.minX, y: window.frame.minY))
            ScreenshotTour.hideIfQuiet(panel)
            panel.orderFrontRegardless()
            try await Task.sleep(for: .milliseconds(1000))
            try write(try render(panel), "guards-settings-\(appearance.rawValue)")
            panel.orderOut(nil)
        }
        AppSettings.setAppearance(.dark)
    }

    /// The transcript at the laptop size, through what changes the chat column around it: a long chat, a turn streamed in,
    /// the permission mode cycled as ⇧⇥ does, the diff pane opened (⌘⇧D) and the mode cycled beside it, turns that end into a
    /// review and reviews that end. `chat-<n>-<step>.png`, taken as they come (no width nudge); the log has the transcript's
    /// scroll position and how much of it is drawn, and whether the message typed before the diff pane first opened is still
    /// in the same, focused composer ("LOST" / "NO" when not).
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
        // A message being typed, in the focused composer: it, the composer and its focus survive the diff pane and reviews.
        let draft = "Keep the receipt lines aligned when a discount applies (typed, not sent)"
        let typedIn = composerView(window)
        if let typedIn {
            window.makeFirstResponder(typedIn)
            typedIn.insertText(draft, replacementRange: NSRange(location: 0, length: (typedIn.string as NSString).length))
        }
        func checkDraft(_ step: String) {
            let now = composerView(window)
            let kept = now?.string == draft
            log("composer after \(step): draft " + (kept ? "kept" : "LOST (now \"\(now?.string ?? "no composer")\")")
                + ", same view " + (now != nil && now === typedIn ? "yes" : "NO")
                + ", focused " + (now.map { window.firstResponder === $0 } == true ? "yes" : "no"))
        }
        for round in 1...5 {
            entry.model.toggleDiffTick += 1   // ⌘⇧D
            try await capture("diff-open-\(round)")
            checkDraft("diff-open-\(round)")
            try await cycleModes(4, "diff-")
            entry.model.toggleDiffTick += 1
            try await capture("diff-closed-\(round)")
            checkDraft("diff-closed-\(round)")
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
            checkDraft("review-\(turn)")
            store.debugShowGate(.idle)
            try await capture("reviewed-\(turn)")
            checkDraft("reviewed-\(turn)")
        }
    }

    /// `SHOTS_LAYOUT=scroll`: a long made-up chat, then `scrollChecks` — dark, at the laptop size.
    private func scrollOnly() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        store.debugHandle((1...20).flatMap { Self.turnEvents($0, root: root) })
        try await Task.sleep(for: .milliseconds(1500))
        try await scrollChecks(window)
    }

    /// r1x — §45.1: does the transcript hold still while rows change? Three subagents work (their groups open, above the
    /// bottom); their calls come in and finish, a notice repeats in place (×N), one agent ends (its group folds). Following,
    /// the view must stay at the bottom and never move up ("JUMP" in the log); scrolled up, the rows shown must stay where
    /// they are when the rows above them change ("SHIFT"). `scroll: …` lines in tour.log, `chat-scroll-*.png`.
    private func scrollChecks(_ window: NSWindow) async throws {
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(1200))
        guard let chat = (try? scrollViews(window))?.max(by: { $0.convert($0.bounds, to: nil).maxX < $1.convert($1.bounds, to: nil).maxX }) else {
            return log("scroll: no chat scroll view")
        }
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        let state = entry.model.chatTranscript
        func geometry() -> (y: CGFloat, height: CGFloat, visible: CGFloat) {
            (chat.contentView.bounds.origin.y, chat.documentView?.frame.height ?? 0, chat.contentView.bounds.height)
        }
        /// Samples the clip view every few ms while `body` runs: how often it moved up, and how far it was from the bottom.
        func sampled(_ what: String, _ body: () async throws -> Void) async rethrows -> [(y: CGFloat, height: CGFloat, visible: CGFloat)] {
            var samples: [(y: CGFloat, height: CGFloat, visible: CGFloat)] = []
            let sampler = Task { @MainActor in
                while !Task.isCancelled {
                    samples.append(geometry())
                    try? await Task.sleep(for: .milliseconds(4))
                }
            }
            try await body()
            try? await Task.sleep(for: .milliseconds(600))
            sampler.cancel()
            samples.append(geometry())
            return samples
        }
        let agents = ["toolu_agent_1", "toolu_agent_2", "toolu_agent_3"]
        func agentCall(_ id: String, _ n: Int) -> EngineEvent {
            .toolUse(id: id, name: "Agent", input: .object(["subagent_type": .string(n == 1 ? "code-reviewer" : n == 2 ? "security-reviewer" : "test-engineer"),
                                                            "description": .string("PR #\(40 + n) 다시 검토"), "run_in_background": .bool(true)]), file: nil)
        }
        func child(_ agent: String, _ i: Int) -> [EngineEvent] {
            let id = "\(agent)_call_\(i)"
            let file = "\(root)/src/\(i % 2 == 0 ? "cart" : "pricing").ts"
            return [.toolUse(id: id, name: i % 3 == 2 ? "Bash" : "Read",
                             input: i % 3 == 2 ? .object(["command": .string("git diff --stat origin/main")]) : .object(["file_path": .string(file)]),
                             file: i % 3 == 2 ? nil : file, info: ToolUseInfo(parentToolUseId: agent)),
                    .toolResult(toolUseId: id, isError: false, preview: "\(i) lines", info: ToolResultInfo(parentToolUseId: agent))]
        }
        let repeated: EngineEvent = .error(message: "Context left until auto-compact: 9%", fatal: false, scope: .session,
                                           detail: EngineErrorDetail(code: "cli_warning"))
        // Three subagents start; the turn runs (their groups are open while they work).
        store.debugShowGate(.running)
        store.debugHandle([.userMessage(text: "PR 다시 검토해줘 — 리뷰어 셋으로", turn: 30)] + agents.enumerated().map { agentCall($1, $0 + 1) })
        state.follow = true
        try await Task.sleep(for: .milliseconds(1500))
        // 1) Following: calls come in and finish inside the groups (above the bottom); the notice repeats in place.
        let following = try await sampled("following") {
            for i in 0..<10 {
                for agent in agents.prefix(2) {
                    for event in child(agent, i) {
                        store.debugHandle([event])
                        try await Task.sleep(for: .milliseconds(60))
                    }
                }
                if i % 3 == 0 { store.debugHandle([repeated]) }
            }
        }
        report("following", following, following: true)
        try write(try render(window), "chat-scroll-following")
        // 2) Scrolled up a little (a user reading the third agent's group): the first two groups, above, keep growing. The
        // wheel as a user turns it (SwiftUI sees a scroll of the user's, not a jump of the clip view).
        state.follow = false
        if let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 260, wheel2: 0, wheel3: 0),
           let event = NSEvent(cgEvent: wheel) {
            chat.scrollWheel(with: event)
        }
        try await Task.sleep(for: .milliseconds(900))
        state.follow = false
        let scrolledUp = try await sampled("scrolled up") {
            for i in 10..<16 {
                for event in child(agents[0], i) {
                    store.debugHandle([event])
                    try await Task.sleep(for: .milliseconds(60))
                }
            }
            store.debugHandle([repeated])
        }
        report("scrolled up, rows above grow", scrolledUp, following: false)
        // 3) Still scrolled up: the first agent ends — its report comes and its group folds.
        let ended = try await sampled("agent ends") {
            store.debugHandle([.toolResult(toolUseId: agents[0], isError: false, preview: "리뷰 3건: 할인 코드 순서, 세금 반올림, 테스트 누락",
                                           info: { var i = ToolResultInfo(); i.agentEnded = true; return i }())])
        }
        report("scrolled up, a group above folds", ended, following: false)
        // 4) Still scrolled up: two turns' rows come below — the newest rows are made at once (§45.1), and what is shown must
        // not move when some of them would cross into the lazy stack.
        let first = geometry()
        store.debugHandle(Self.turnEvents(31, root: root) + Self.turnEvents(32, root: root))
        try await Task.sleep(for: .milliseconds(800))
        let last = geometry()
        let moved = last.y - first.y
        log("scroll scrolled up, newer rows below: content +\(Int(last.height - first.height)) pt, offset \(moved >= 0 ? "+" : "")\(Int(moved)) pt — "
            + (abs(moved) > 4 ? "SHIFT \(Int(moved)) pt" : "the rows shown stayed"))
        try write(try render(window), "chat-scroll-scrolled-up")
        state.follow = true
        store.debugShowGate(.idle)
        try await Task.sleep(for: .milliseconds(800))
    }

    /// `SHOTS_LAYOUT=cards`: the transcript as the layout check leaves it (a long chat, the scroll check's agents), then the
    /// composer's shots — a review, Claude at work, Claude's question and a permission card above the composer, dark and
    /// light — six times over; the `chat:` lines say BLANK when a card left the transcript showing none of its rows.
    private func cardsOnly() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        store.debugHandle((1...24).flatMap { Self.turnEvents($0, root: root) })
        try await Task.sleep(for: .milliseconds(1500))
        try await scrollChecks(window)
        for round in 1...6 {
            log("cards round \(round)")
            try await composerShots(window, round: round)   // new request ids: an answered one is not asked again
        }
        // Three permission cards at once beside the diff, Claude at work: the transcript keeps its least room (80 pt).
        let files = [ChangedFile(path: "src/pricing.ts", oldPath: nil, status: .modified, added: 14, deleted: 2, isBinary: false)]
        for round in 1...4 {
            store.debugShowComposerState(working: true, files: files)
            try await Task.sleep(for: .milliseconds(1200))
            let cards = (1...3).map { Self.permission(id: "tour-stacked-\(round)-\($0)") }
            store.debugHandle(cards.map { .permissionRequest($0) })
            try await Task.sleep(for: .milliseconds(1500))
            let image = try render(window)
            try write(image, "cards-stacked-\(round)")
            logTranscript(image)
            for card in cards { store.respondPermission(requestId: card.requestId, allow: false, message: "tour") }
            try await Task.sleep(for: .milliseconds(800))
        }
        store.debugShowGate(.idle)
    }

    /// `SHOTS_LAYOUT=blank`: a long made-up chat, then `blankChecks` — dark.
    // MARK: composer — the message box against the terminal's input

    /// `SHOTS_LAYOUT=composer`: only `composerTerminalChecks`.
    private func composerOnly() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        try await composerTerminalChecks(window)
    }

    /// What the terminal's input does, checked in the message box at the laptop size. `composer paste <source>`: ⌘V through
    /// the app's Edit menu, as the key goes, of what a screenshot, a browser's Copy Image, Preview and a Finder copy of an
    /// image file put on the pasteboard — a private pasteboard handed to the box, never the user's clipboard; LOST when no
    /// image was attached. `composer slash`: "/" typed opens the palette with every source a session lists, and the typed
    /// text filters it; LOST when the palette did not show or a command is missing, CUT when it shows fewer than three rows.
    private func composerTerminalChecks(_ window: NSWindow) async throws {
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(1200))
        guard let box = composerView(window) as? ComposerNSTextView else { return log("composer: no message box — LOST") }
        let composer = entry.model.chatComposer
        setComposerText("", in: window)

        // ⌘V of an image.
        let board = NSPasteboard(name: NSPasteboard.Name("rg-tour-paste-\(ProcessInfo.processInfo.processIdentifier)"))
        box.pasteboard = board
        defer { box.pasteboard = .general; board.releaseGlobally() }
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 8, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                   isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        guard let rep, let png = rep.representation(using: .png, properties: [:]), let tiff = rep.tiffRepresentation else {
            return log("composer paste: no test image — LOST")
        }
        let file = out.appendingPathComponent("paste-source.png")
        try png.write(to: file)
        let pasteItem = NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let sources: [(String, (NSPasteboard) -> Void)] = [
            ("screenshot", { $0.setData(png, forType: .png); $0.setData(tiff, forType: .tiff) }),
            ("Preview", { $0.setData(tiff, forType: .tiff) }),
            ("browser Copy Image", { $0.setData(tiff, forType: .tiff); $0.setString("<img src=\"https://example.com/cat.png\">", forType: .html) }),
            ("Finder image file", { $0.writeObjects([file as NSURL]); $0.setString(file.lastPathComponent, forType: .string) }),
        ]
        for (name, fill) in sources {
            composer.images = []
            board.clearContents()
            fill(board)
            window.makeFirstResponder(box)
            let enabled = box.validateMenuItem(pasteItem)
            let key = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: window.windowNumber, context: nil, characters: "v", charactersIgnoringModifiers: "v",
                                       isARepeat: false, keyCode: 9)
            // The key goes through the menu bar when this window is the key window; a quiet run is never the active app (no
            // key window), so the menu item's action goes to the box itself — once Edit › Paste is on, as AppKit would.
            let isKey = NSApp.keyWindow === window
            let route: String
            if isKey, let key, NSApp.mainMenu?.performKeyEquivalent(with: key) == true {
                route = "through the Edit menu"
            } else if enabled {
                route = NSApp.sendAction(#selector(NSText.paste(_:)), to: box, from: pasteItem) ? "Edit › Paste's action sent to the box (no key window)" : "action not taken"
            } else {
                route = "not sent (Paste off)"
            }
            try await Task.sleep(for: .milliseconds(300))
            let attached = composer.images.count
            log("composer paste \(name): Edit › Paste \(enabled ? "on" : "off"), ⌘V \(route) — "
                + (attached == 1 ? "attached an image" : "LOST (\(attached) images\(composer.notice.map { ", notice: \($0)" } ?? ""))"))
        }
        composer.images = []
        composer.notice = nil

        // The slash palette as "/" is typed.
        store.debugShowCommands(Self.paletteCommands)
        let files = [ChangedFile(path: "src/cart.ts", oldPath: nil, status: .modified, added: 9, deleted: 3, isBinary: false)]
        for (state, working) in [("idle", false), ("working beside a review", true)] {
            if working { store.debugShowComposerState(working: true, files: files) }
            setComposerText("/", in: window)
            try await Task.sleep(for: .milliseconds(900))
            let frame = entry.model.debugPaletteFrame, rows = entry.model.debugPaletteRows
            let missing = Self.paletteCommands.map(\.name).filter { !rows.contains($0) }
            log("composer slash \"/\" (\(state)): palette \(NSStringFromRect(frame)) with \(rows.count) rows — "
                + (frame.height <= 0 ? "LOST (no palette)" : !missing.isEmpty ? "LOST (missing \(missing.joined(separator: ", ")))"
                   : frame.height < 120 ? "CUT (\(Int(frame.height)) pt)" : "every source listed"))
            try write(try render(window), "composer-slash-\(working ? "working" : "idle")")
        }
        for (typed, first) in [("/demo-sk", "demo-plugin:demo-skill"), ("/demo-skill", "demo-plugin:demo-skill"), ("/nested", "tools:nested"),
                               ("/summ", "mcp__acme-docs__summarize"), ("/PROJ", "proj-cmd"), ("/acme-review:", "acme-review:check")] {
            setComposerText(typed, in: window)
            try await Task.sleep(for: .milliseconds(500))
            let rows = entry.model.debugPaletteRows
            log("composer slash \"\(typed)\": " + (rows.first == first ? "\(first) first of \(rows.count)" : "LOST (first \(rows.first ?? "none"), want \(first))"))
        }
        setComposerText("", in: window)

        // §50.2: the queue above the box — what waits in Claude's turn, a queued message with Send now.
        store.debugShowComposerState(working: true, files: files)
        store.debugShowSteering([SteeringMessage(id: "tour-steer-1", text: "Also update the README with the new discount codes")])
        try await Task.sleep(for: .milliseconds(600))
        let steeringOnly = entry.model.debugQueueBarFrame
        log("composer queue (steering only): bar \(NSStringFromRect(steeringOnly))" + (steeringOnly.height > 0 ? " — shown" : " — LOST (no queue bar)"))
        store.enqueue("Then run the unit tests and fix what fails")
        try await Task.sleep(for: .milliseconds(900))
        let bar = entry.model.debugQueueBarFrame, send = entry.model.debugSendFrame
        let room = window.contentView?.bounds.size ?? .zero
        let inside = send.width > 0 && send.maxY <= room.height + 0.5 && send.maxX <= room.width + 0.5
        log("composer queue (steering + 1 queued): bar \(NSStringFromRect(bar)), send button \(NSStringFromRect(send))"
            + (bar.height <= 0 ? " — LOST (no queue bar)" : inside ? " — in the window" : " — OUT OF THE WINDOW"))
        if let id = store.queuedMessages.first?.id {
            log("composer queue: Send now on the queued message would \(String(describing: store.queuedSendNowAction(id: id)))")
        }
        // §50.3: a waiting message can be edited and taken back — the tools are on screen, inside the window.
        for (name, what) in [("steer.edit", "Edit on the message in Claude's turn"), ("steer.takeBack", "Take back on it"),
                             ("queued.edit", "Edit on the queued message"), ("queued.remove", "Remove on it")] {
            let frame = entry.model.debugQueueTools[name] ?? .zero
            let inWindow = frame.width > 0 && frame.maxX <= room.width + 0.5 && frame.minX >= -0.5
            log("composer queue tool \(name) (\(what)): \(NSStringFromRect(frame))" + (frame.width <= 0 ? " — LOST (not shown)" : inWindow ? " — shown" : " — OUT OF THE WINDOW"))
        }
        try write(try render(window), "composer-queue")
        // ↑ in an empty box, as in the terminal: the last queued message comes back to edit.
        setComposerText("", in: window)
        window.makeFirstResponder(box)
        box.doCommand(by: #selector(NSResponder.moveUp(_:)))
        try await Task.sleep(for: .milliseconds(500))
        let pulled = box.string == "Then run the unit tests and fix what fails" && store.queuedMessages.isEmpty
        log("composer queue ↑: \(pulled ? "the queued message is back in the box" : "LOST (box \"\(box.string)\", \(store.queuedMessages.count) queued)")")
        try write(try render(window), "composer-queue-up")
        // ↑ again on an empty box with only the turn's message waiting: it is taken back — this made-up one is not in the
        // engine's list, so the engine says Claude read it already, and the box says so (nothing comes back).
        setComposerText("", in: window)
        box.doCommand(by: #selector(NSResponder.moveUp(_:)))
        var notice: String?
        for _ in 0..<30 {
            try await Task.sleep(for: .milliseconds(100))
            notice = composer.notice
            if notice != nil { break }
        }
        let late = notice == SteerTakeBackNotice.alreadyRead && box.string.isEmpty
        log("composer queue ↑ (in Claude's turn, too late): " + (late ? "the box says \"\(notice ?? "")\"" : "LOST (notice \(notice ?? "none"), box \"\(box.string)\")"))
        try write(try render(window), "composer-queue-late")
        composer.notice = nil
        store.clearQueue()
        store.debugShowSteering([])
        store.debugShowGate(.idle)
    }

    /// What a session with the user's settings lists (made-up names): built-in, mine, the project's, a plugin's skill with its
    /// short alias, a plugin command, a command in a subfolder, an MCP prompt.
    private static let paletteCommands: [SlashCommandInfo] = [
        SlashCommandInfo(name: "compact", description: "Clear the history but keep a summary", source: .builtin),
        SlashCommandInfo(name: "my-skill", description: "My own skill", source: .user),
        SlashCommandInfo(name: "tools:nested", description: "A command in a subfolder", source: .user),
        SlashCommandInfo(name: "proj-cmd", description: "The project's command", source: .project),
        SlashCommandInfo(name: "demo-plugin:demo-skill", description: "A plugin's skill", source: .plugin, plugin: "demo-plugin", aliases: ["demo-skill"]),
        SlashCommandInfo(name: "acme-review:check", description: "A plugin's command", source: .plugin, plugin: "acme-review"),
        SlashCommandInfo(name: "mcp__acme-docs__summarize", description: "Summarize a page", source: .mcp, server: "acme-docs"),
    ]

    private func blankOnly() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        store.debugHandle((1...20).flatMap { Self.turnEvents($0, root: root) })
        try await Task.sleep(for: .milliseconds(1500))
        try await blankChecks(window)
    }

    /// The chat column in windows taller than the laptop's (a 1440 pt display's): a turn streamed in (shot while it
    /// streams), subagents' calls coming in, the diff pane, a review, the app hidden and back, the window minimised and
    /// back, a resize, a new chat and back. `blank-<size>-<n>-<step>.png`; the log's `chat:` line says "BLANK" when the
    /// transcript draws nothing, its `column:` line "OUT OF THE WINDOW" when the composer's send button is not in it.
    private func blankChecks(_ window: NSWindow) async throws {
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        let visible = window.screen?.visibleFrame ?? window.frame
        let sizes = [NSSize(width: 1257, height: 1104), NSSize(width: min(visible.width, 1600), height: visible.height)]
        var shot = 0
        func capture(_ label: String, _ step: String) async throws {
            shot += 1
            let image = try render(window)
            try write(image, "blank-\(label)-\(shot)-\(step)")
            logTranscript(image)
            let send = entry.model.debugSendFrame
            let room = window.contentView?.bounds.size ?? .zero
            let inside = send.width > 0 && send.minX >= -0.5 && send.minY >= -0.5 && send.maxX <= room.width + 0.5 && send.maxY <= room.height + 0.5
            log("column \(step): send button \(NSStringFromRect(send)) in \(NSStringFromSize(room))" + (inside ? " — in the window" : " — OUT OF THE WINDOW"))
        }
        /// `events` streamed while the shot is taken halfway through, then once more after they are in.
        func streamed(_ label: String, _ step: String, _ events: [EngineEvent]) async throws {
            let half = events.count / 2
            try await stream(Array(events.prefix(half)))
            try await capture(label, "\(step)-streaming")
            try await stream(Array(events.dropFirst(half)))
            try await Task.sleep(for: .milliseconds(1200))
            try await capture(label, "\(step)-streamed")
        }
        let agents = ["toolu_blank_agent_1", "toolu_blank_agent_2"]
        var turn = 40
        for size in sizes {
            let label = "\(Int(size.width))x\(Int(size.height))"
            window.setFrame(NSRect(origin: NSPoint(x: visible.minX, y: visible.maxY - size.height), size: size), display: true)
            try await Task.sleep(for: .milliseconds(1500))
            log("blank \(label): frame \(NSStringFromRect(window.frame))")
            try await capture(label, "resized")
            store.debugShowGate(.running)
            turn += 1
            try await streamed(label, "turn", Self.turnEvents(turn, root: root))
            // Subagents at work: their calls come into their groups.
            turn += 1
            var events: [EngineEvent] = [.userMessage(text: "Review the cart with two agents", turn: turn)]
            events += agents.enumerated().map { i, id in
                .toolUse(id: id, name: "Agent", input: .object(["subagent_type": .string(i == 0 ? "code-reviewer" : "test-engineer"),
                                                                "description": .string("Review \(i)"), "run_in_background": .bool(true)]), file: nil)
            }
            for i in 0..<8 {
                for agent in agents {
                    let id = "\(agent)_call_\(turn)_\(i)"
                    events += [.toolUse(id: id, name: "Read", input: .object(["file_path": .string("\(root)/src/cart.ts")]), file: "\(root)/src/cart.ts",
                                        info: ToolUseInfo(parentToolUseId: agent)),
                               .toolResult(toolUseId: id, isError: false, preview: "\(i) lines", info: ToolResultInfo(parentToolUseId: agent))]
                }
            }
            events += agents.map { .toolResult(toolUseId: $0, isError: false, preview: "done", info: { var i = ToolResultInfo(); i.agentEnded = true; return i }()) }
            try await streamed(label, "agents", events)
            store.debugShowGate(.idle)
            entry.model.toggleDiffTick += 1   // ⌘⇧D
            try await Task.sleep(for: .milliseconds(1200))
            try await capture(label, "diff-open")
            entry.model.toggleDiffTick += 1
            try await Task.sleep(for: .milliseconds(1200))
            try await capture(label, "diff-closed")
            let files = [ChangedFile(path: "src/cart.ts", oldPath: nil, status: .modified, added: 9, deleted: 3, isBinary: false)]
            store.debugShowGate(.reviewing, files: files)
            try await Task.sleep(for: .milliseconds(1200))
            try await capture(label, "review")
            store.debugShowGate(.idle)
            try await Task.sleep(for: .milliseconds(1200))
            try await capture(label, "reviewed")
            if ScreenshotTour.quiet {   // hiding and minimising animate where the user sees them (the Dock): SHOTS_VISIBLE=1
                log("blank \(label): hidden / minimised steps skipped (quiet run)")
            } else {
                NSApp.hide(nil)
                try await Task.sleep(for: .milliseconds(1200))
                NSApp.unhide(nil)
                window.orderFrontRegardless()
                try await Task.sleep(for: .milliseconds(1500))
                try await capture(label, "unhidden")
                window.miniaturize(nil)
                try await Task.sleep(for: .milliseconds(1500))
                window.deminiaturize(nil)
                try await Task.sleep(for: .milliseconds(1500))
                try await capture(label, "deminiaturized")
            }
            window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
            try await Task.sleep(for: .milliseconds(1200))
            window.setFrame(NSRect(origin: NSPoint(x: visible.minX, y: visible.maxY - size.height), size: size), display: true)
            try await Task.sleep(for: .milliseconds(1200))
            try await capture(label, "resized-back")
        }
        // Moved to each other display (another backing scale: a 1x monitor beside a Retina one) and back, a turn streamed there.
        let home = window.screen
        for (i, screen) in NSScreen.screens.enumerated() where screen != home {
            let label = "screen\(i)-\(Int(screen.backingScaleFactor))x"
            let room = screen.visibleFrame
            let size = NSSize(width: min(1257, room.width), height: min(1104, room.height))
            window.setFrame(NSRect(origin: NSPoint(x: room.minX, y: room.maxY - size.height), size: size), display: true)
            try await Task.sleep(for: .milliseconds(1500))
            log("blank \(label): frame \(NSStringFromRect(window.frame)), on \(window.screen.map { NSStringFromRect($0.frame) } ?? "?") at \(window.backingScaleFactor)x")
            try await capture(label, "moved")
            store.debugShowGate(.running)
            turn += 1
            try await streamed(label, "turn", Self.turnEvents(turn, root: root))
            store.debugShowGate(.idle)
            window.setFrame(NSRect(origin: NSPoint(x: visible.minX, y: visible.maxY - sizes[0].height), size: sizes[0]), display: true)
            try await Task.sleep(for: .milliseconds(1500))
            try await capture(label, "moved-back")
        }
        // A new chat (the engine's), turns in it, and back to the chat before it (shown read-only from its saved rows).
        window.setFrame(NSRect(origin: NSPoint(x: visible.minX, y: visible.maxY - sizes[0].height), size: sizes[0]), display: true)
        let before = store.currentSessionId
        if await store.newChat() {
            try await wait("new chat", timeout: 30) { $0.currentSessionId != before && $0.currentSessionId != nil }
            try await Task.sleep(for: .milliseconds(1200))
            try await capture("new-chat", "new-chat")
            // Its rows grow past the view's height, a turn at a time (a short chat sits at the bottom until then).
            for n in 1...5 {
                store.debugShowGate(.running)
                turn += 1
                try await streamed("new-chat", "turn-\(n)", Self.turnEvents(turn, root: root))
                store.debugShowGate(.idle)
            }
            if let before {
                await store.viewChat(id: before)
                try await Task.sleep(for: .milliseconds(1500))
                try await capture("new-chat", "view-before")
                store.stopViewing()
                try await Task.sleep(for: .milliseconds(1500))
                try await capture("new-chat", "back")
            }
        } else {
            log("blank: no new chat (\(store.newChatBlocker ?? "refused"))")
        }
        window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1000, height: 637)), display: true)
        try await Task.sleep(for: .milliseconds(800))
    }

    /// `SHOTS_LAYOUT=scrolldown`: a reader scrolls down a long chat as with a trackpad — 40 pt steps every 16 ms, a gesture
    /// that begins, changes and ends — from ~5 000 pt above the newest row to it, idle and while Claude streams, at 1000 × 637
    /// with and without the diff pane and in a tall window. The clip's offset is read every 4 ms; any move up the reader did
    /// not make is a jump ("JUMP" in the `scrolldown:` line).
    private func scrollDownChecks() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        store.debugHandle((1...60).flatMap { Self.turnEvents($0, root: root) })
        // Agents' groups among the rows (finished), as a long session has.
        for n in 61...64 {
            let agent = "toolu_down_agent_\(n)"
            var events: [EngineEvent] = [.userMessage(text: "Check the cart with an agent (\(n))", turn: n),
                                         .toolUse(id: agent, name: "Agent", input: .object(["subagent_type": .string("code-reviewer"), "description": .string("Review \(n)")]), file: nil)]
            for i in 0..<12 {
                let id = "\(agent)_call_\(i)"
                events += [.toolUse(id: id, name: "Read", input: .object(["file_path": .string("\(root)/src/cart.ts")]), file: "\(root)/src/cart.ts", info: ToolUseInfo(parentToolUseId: agent)),
                           .toolResult(toolUseId: id, isError: false, preview: "\(i) lines", info: ToolResultInfo(parentToolUseId: agent))]
            }
            events.append(.toolResult(toolUseId: agent, isError: false, preview: "done", info: { var i = ToolResultInfo(); i.agentEnded = true; return i }()))
            store.debugHandle(events + Self.turnEvents(n, root: root).dropFirst())
        }
        try await Task.sleep(for: .milliseconds(1500))
        let visible = window.screen?.visibleFrame ?? window.frame
        var turn = 70
        for (label, size, diff) in [("1000x637", NSSize(width: 1000, height: 637), false), ("1000x637-diff", NSSize(width: 1000, height: 637), true),
                                    ("1257x1104", NSSize(width: 1257, height: 1104), false)] {
            window.setFrame(NSRect(origin: NSPoint(x: visible.minX, y: visible.maxY - size.height), size: size), display: true)
            if diff { entry.model.toggleDiffTick += 1 }
            try await Task.sleep(for: .milliseconds(1500))
            transcript = nil
            guard let chat = Self.chatScrollView(try scrollViews(window)) else { log("scrolldown: no chat scroll view"); continue }
            for streaming in [false, true] {
                // ~5 000 pt above the end (where a reader left it), then let it settle.
                let clip = chat.contentView
                clip.scroll(to: NSPoint(x: 0, y: max(0, (chat.documentView?.frame.height ?? 0) - clip.bounds.height - 5000)))
                chat.reflectScrolledClipView(clip)
                try await Task.sleep(for: .milliseconds(900))
                // While the reader is up there, Claude's turns add rows below (more than the rows made at once).
                entry.model.chatTranscript.follow = false
                for _ in 0..<16 { turn += 1; store.debugHandle(Self.turnEvents(turn, root: root)) }
                try await Task.sleep(for: .milliseconds(900))
                var samples: [(y: CGFloat, h: CGFloat)] = []
                let sampler = Task { @MainActor in
                    while !Task.isCancelled {
                        samples.append((chat.contentView.bounds.minY, chat.documentView?.frame.height ?? 0))
                        try? await Task.sleep(for: .milliseconds(4))
                    }
                }
                var streamer: Task<Void, Never>?
                if streaming {
                    store.debugShowGate(.running)
                    turn += 1
                    let events = Self.turnEvents(turn, root: root) + Self.turnEvents(turn + 100, root: root)
                    streamer = Task { @MainActor in
                        for event in events {
                            guard !Task.isCancelled else { return }
                            store.debugHandle([event])
                            try? await Task.sleep(for: .milliseconds(40))
                        }
                    }
                }
                var visual = ""
                if streaming {
                    try await gesture(chat, by: -40) {   // down to the end, and a few steps more against it
                        (chat.documentView?.frame.height ?? 0) - clip.bounds.maxY < 2
                    }
                } else {
                    visual = try await visualGesture(chat)
                }
                try await Task.sleep(for: .milliseconds(800))
                sampler.cancel()
                streamer?.cancel()
                store.debugShowGate(.idle)
                // A jump: the view went further from the newest row than the reader took it — the rows shown moved down under
                // the view (the distance to the content's end grew) while nothing was added (idle), or with the offset going
                // up. A content that shrinks above the view at its end keeps showing the end: not a jump.
                let vis = chat.contentView.bounds.height
                var jumps: [String] = []
                for (i, (a, b)) in zip(samples, samples.dropFirst()).enumerated() {
                    let ea = a.h - a.y - vis, eb = b.h - b.y - vis
                    if eb > ea + 4, !streaming || b.y < a.y - 4 {
                        jumps.append("#\(i) end \(Int(ea))→\(Int(eb)) y \(Int(a.y))→\(Int(b.y)) h \(Int(a.h))→\(Int(b.h))")
                    }
                }
                let end = samples.last.map { Int($0.h - $0.y - vis) } ?? -1
                log("scrolldown \(label)\(streaming ? ", streaming" : ", idle"): \(samples.count) samples, \(jumps.count) jumps in the geometry, \(end) pt from the end, "
                    + "following \(entry.model.chatTranscript.follow ? "yes" : "no")" + (jumps.isEmpty ? "" : " (" + jumps.prefix(6).joined(separator: " | ") + ")")
                    + (streaming ? (jumps.isEmpty ? " — steady" : " — JUMP") : "; " + visual))
                try await Task.sleep(for: .milliseconds(1500))
            }
            if diff { entry.model.toggleDiffTick += 1; try await Task.sleep(for: .milliseconds(1200)) }
        }
        try write(try render(window), "scrolldown")
    }

    /// The idle scroll down, watched: the clip moved down 40 pt a step to the end, the view drawn after each step and matched
    /// with the one before — what is shown must move up by the 40 pt the reader scrolled, no more, no less ("JUMP" otherwise:
    /// the rows shown moved under the reader). The geometry alone cannot tell rows made below the view from a move above it.
    private func visualGesture(_ chat: NSScrollView) async throws -> String {
        let state = entry.model.chatTranscript
        state.userScrolling = true
        defer {
            state.userScrolling = false
            state.follow = state.nearBottom
            if state.follow { state.unseen = 0 }
        }
        func rows() -> [[Double]] {
            let rect = chat.contentView.frame
            guard let rep = chat.bitmapImageRepForCachingDisplay(in: rect) else { return [] }
            chat.cacheDisplay(in: rect, to: rep)
            let scale = Double(rep.pixelsHigh) / Double(rect.height)
            return (0..<Int(rect.height)).map { y in
                let py = min(rep.pixelsHigh - 1, Int(Double(y) * scale))
                return (0..<16).map { bin in
                    var sum = 0.0
                    for k in 0..<4 {
                        let px = min(rep.pixelsWide - 1, (bin * 4 + k) * rep.pixelsWide / 64)
                        sum += Double(rep.colorAt(x: px, y: py)?.brightnessComponent ?? 0)
                    }
                    return sum / 4
                }
            }
        }
        /// How well `b` is `a` moved up by `s` pt (mean difference over the overlap; 0 is identical), nil without overlap.
        func mismatch(_ a: [[Double]], _ b: [[Double]], _ s: Int) -> Double? {
            var diff = 0.0, n = 0
            for i in stride(from: 0, to: b.count, by: 3) where i + s >= 0 && i + s < a.count {
                for j in 0..<16 { diff += abs(a[i + s][j] - b[i][j]) }
                n += 1
            }
            return n > b.count / 9 ? diff / Double(n * 16) : nil
        }
        /// How far the picture moved up from `a` to `b` (pt), and how well it matched.
        func shift(_ a: [[Double]], _ b: [[Double]]) -> (Int, Double) {
            var best = (0, Double.infinity)
            for s in -120...240 { if let d = mismatch(a, b, s), d < best.1 { best = (s, d) } }
            return best
        }
        /// A picture with nothing drawn in it (every band within a few percent of one brightness): a blank view, where any
        /// move matches — not a move of the rows.
        func blank(_ rows: [[Double]]) -> Bool {
            let all = rows.flatMap { $0 }
            guard let lo = all.min(), let hi = all.max() else { return true }
            return hi - lo < 0.05
        }
        var before = rows()
        var steps = 0, off: [String] = [], blanks: [String] = [], nudges: [String] = []
        // How far the rows shown have drifted from where the reader's scroll put them, over steps that did not match.
        var drift = 0, worstDrift = 0
        while steps < 400 {
            let clip = chat.contentView
            let end = max(0, (chat.documentView?.frame.height ?? 0) - clip.bounds.height)
            let from = clip.bounds.minY
            let to = min(end, from + 40)
            if to - from < 1 { break }
            clip.scroll(to: NSPoint(x: 0, y: to))
            chat.reflectScrolledClipView(clip)
            try await Task.sleep(for: .milliseconds(16))
            let after = rows()
            // What the clip really moved (at the end it stops short of the 40 pt when the content got shorter meanwhile).
            let expected = Int((chat.contentView.bounds.minY - from).rounded())
            if blank(after) {
                blanks.append("step \(steps) (\(Int(end - to)) pt from the end)")
            } else if !blank(before) {
                let (moved, err) = shift(before, after)
                // Off: the scrolled distance matches clearly worse than another (repeated rows can match several shifts as well).
                let atExpected = mismatch(before, after, expected) ?? .infinity
                let line = "step \(steps): moved \(moved) pt of \(expected) (match \(String(format: "%.3f", err)) there, \(String(format: "%.3f", atExpected)) at \(expected), \(Int(end - to)) pt from the end)"
                if abs(moved - expected) > 6 && atExpected > err + 0.01 {
                    // The rows shown moved by more or less than the scroll: the lazy stack placing rows above at their real height
                    // nudges them a few points (and back); the reader is thrown only when that adds up.
                    drift += moved - expected
                    worstDrift = max(worstDrift, abs(drift))
                    if abs(drift) > 80 { off.append(line) } else { nudges.append(line) }
                } else if err > 0.15 {
                    off.append(line)   // no shift matches: the picture was replaced
                } else {
                    drift = 0
                }
            }
            before = after
            steps += 1
        }
        return "\(steps) steps watched, \(off.count) off, \(nudges.count) nudged (at most \(worstDrift) pt), \(blanks.count) blank"
            + (nudges.isEmpty ? "" : " [" + nudges.prefix(3).joined(separator: " | ") + "]")
            + (blanks.isEmpty ? "" : " — BLANK: " + blanks.prefix(6).joined(separator: ", "))
            + (off.isEmpty ? (blanks.isEmpty ? " — steady" : "") : " — JUMP: " + off.prefix(6).joined(separator: " | "))
    }

    /// A trackpad gesture on `chat`: the clip moved `by` pt (positive: up) every 16 ms until `done` and eight steps more.
    private func gesture(_ chat: NSScrollView, by: Int32, until done: () -> Bool) async throws {
        // As AppKit moves the clip for a trackpad gesture, with the transcript told the user is scrolling (its scroll phase):
        // synthesised wheel events do not reach a window that is not in front.
        let state = entry.model.chatTranscript
        state.userScrolling = true
        var extra = 8
        for _ in 0..<400 {
            if done() { extra -= 1 }
            if extra == 0 { break }
            let clip = chat.contentView
            let end = max(0, (chat.documentView?.frame.height ?? 0) - clip.bounds.height)
            clip.scroll(to: NSPoint(x: 0, y: min(end, max(0, clip.bounds.minY - CGFloat(by)))))
            chat.reflectScrolledClipView(clip)
            try await Task.sleep(for: .milliseconds(16))
        }
        // The gesture ends: the transcript's own idle handling (follow when at the bottom).
        state.userScrolling = false
        state.follow = state.nearBottom
        if state.follow { state.unseen = 0 }
    }

    /// `SHOTS_LAYOUT=cpu`: what the main thread spends while Claude works and nothing changes on screen but the HUD's clock and
    /// the live agents' dots — a long chat (60 turns), the window 1257 × 1104, in front and behind another app — and how late a
    /// job queued on it runs (a tab switch's rows wait for that). `cpu:` lines in tour.log.
    private func cpuChecks(longTurns: Int = 0) async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        // A quiet window is never drawn by AppKit: drawn here at the screen's pace, so what is measured includes the layout
        // and drawing a window on screen does every frame.
        let pump = ScreenshotTour.quiet ? Self.drawAtScreenPace(window) : nil
        defer { pump?.invalidate() }
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        let visible = window.screen?.visibleFrame ?? window.frame
        window.setFrame(NSRect(origin: NSPoint(x: visible.minX, y: visible.maxY - 1104), size: NSSize(width: 1257, height: 1104)), display: true)
        store.debugHandle((1...60).flatMap { Self.turnEvents($0, root: root) })
        try await Task.sleep(for: .milliseconds(2500))
        // A long session: turns that come one after another while the chat stays open (followed), each with an agent's group.
        for turn in 61..<(61 + longTurns) {
            let agent = "toolu_long_agent_\(turn)"
            store.debugHandle(Self.turnEvents(turn, root: root) + [
                .toolUse(id: agent, name: "Agent", input: .object(["subagent_type": .string("code-reviewer"), "description": .string("Review \(turn)")]), file: nil),
                .toolResult(toolUseId: agent, isError: false, preview: "done", info: { var i = ToolResultInfo(); i.agentEnded = true; return i }())])
            try await Task.sleep(for: .milliseconds(60))
        }
        if longTurns > 0 {
            try await Task.sleep(for: .milliseconds(2500))
            log("cpu long session: \(store.transcript.count) rows after \(longTurns) turns came in")
        }
        let agentIds = ["toolu_cpu_agent_1", "toolu_cpu_agent_2", "toolu_cpu_agent_3"]
        let started = Date()
        let agents = agentIds.enumerated().map { i, id in
            AgentNode(id: "agent-\(i)", toolUseId: id, type: "code-reviewer", description: "Review \(i)", status: .running, isBackground: true,
                      startedAt: started.timeIntervalSince1970 * 1000)
        }
        /// The main thread's CPU time and how late a job queued on it every 50 ms ran, over `seconds`.
        func measure(_ what: String, seconds: Double = 8, _ during: (() async throws -> Void)? = nil) async throws {
            var lateness: [Double] = []
            let probe = Task { @MainActor in
                while !Task.isCancelled {
                    let queued = ContinuousClock.now
                    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                        DispatchQueue.main.async {
                            lateness.append(Self.ms(queued.duration(to: .now)))
                            done.resume()
                        }
                    }
                    try? await Task.sleep(for: .milliseconds(50))
                }
            }
            let cpu0 = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
            let t0 = ContinuousClock.now
            if let during { try await during() } else { try await Task.sleep(for: .seconds(seconds)) }
            let cpu1 = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
            let wall = Self.ms(t0.duration(to: .now)) / 1000
            probe.cancel()
            let sorted = lateness.sorted()
            let p95 = sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
            log("cpu \(what): main thread \(String(format: "%.0f", Double(cpu1 - cpu0) / 1e7 / wall)) % of \(String(format: "%.1f", wall)) s, "
                + "a queued job \(String(format: "%.1f", sorted.isEmpty ? 0 : sorted.reduce(0, +) / Double(sorted.count))) ms late on average, "
                + "\(String(format: "%.0f", p95)) ms at p95, \(String(format: "%.0f", sorted.last ?? 0)) ms at worst; active \(NSApp.isActive)")
        }
        func streamDeltas(_ seconds: Double) async throws {
            let end = ContinuousClock.now + .seconds(seconds)
            var i = 0
            while ContinuousClock.now < end {
                store.debugHandle([.textDelta(text: (i % 12 == 0 ? "\n\n" : " ") + "word\(i)")])
                i += 1
                try await Task.sleep(for: .milliseconds(40))
            }
        }
        try await activate(window)
        try await measure("idle, in front")
        store.debugShowGate(.running)
        store.debugShowHUD(turnStartedAt: started, agents: [])
        store.debugHandle([.userMessage(text: "Review the cart with three agents", turn: 61)])
        try await measure("working, no agents, in front")
        store.debugHandle(agentIds.enumerated().map { i, id in
            .toolUse(id: id, name: "Agent", input: .object(["subagent_type": .string("code-reviewer"), "description": .string("Review \(i)"),
                                                            "run_in_background": .bool(true)]), file: nil)
        })
        store.debugShowHUD(turnStartedAt: started, agents: agents)
        try await measure("working, 3 agents, in front")
        NSApp.deactivate()
        try await Task.sleep(for: .milliseconds(500))
        try await measure("working, 3 agents, behind another app")
        try await measure("working, 3 agents, streaming, behind another app") { try await streamDeltas(8) }
        store.debugShowHUD(turnStartedAt: started, agents: [])
        try await measure("working, only the agents' rows live, streaming, behind another app") { try await streamDeltas(8) }
        store.debugShowHUD(turnStartedAt: nil, agents: [])
        store.debugShowGate(.idle)
        try await measure("idle, only the agents' rows live, behind another app")
        // Back to the chat from the PRs tab (the chat view is made again over all its rows): how long until its transcript is laid
        // out, and what the main thread spent.
        store.debugShowHUD(turnStartedAt: nil, agents: [])
        entry.model.tab = .prs
        try await Task.sleep(for: .milliseconds(1500))
        let backCPU = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
        let back0 = ContinuousClock.now
        entry.model.tab = .changes
        var backHeight: CGFloat = 0
        while ContinuousClock.now - back0 < .seconds(10) {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in DispatchQueue.main.async { done.resume() } }
            if let chat = (try? scrollViews(window)).flatMap(Self.chatScrollView), let h = chat.documentView?.frame.height, h > 2000 { backHeight = h; break }
            try await Task.sleep(for: .milliseconds(1))
        }
        let backMs = Int(Self.ms(back0.duration(to: .now)))
        log("cpu back to the chat: laid out after \(backMs) ms (\(Int(backHeight)) pt), main thread \(Int(Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - backCPU) / 1e6)) ms")
        try await Task.sleep(for: .milliseconds(1500))
        // A new chat beside the agents still at work (the turn has ended, so the switch is not held): how long from the click
        // until the engine switched, and from there until the transcript has laid out the new chat's rows.
        store.debugShowHUD(turnStartedAt: nil, agents: agents)
        let chat = (try? scrollViews(window))?.max { $0.convert($0.bounds, to: nil).maxX < $1.convert($1.bounds, to: nil).maxX }
        let longHeight = chat?.documentView?.frame.height ?? 0
        let before = store.currentSessionId
        let t0 = ContinuousClock.now
        guard await store.newChat() else { return log("cpu: no new chat (\(store.newChatBlocker ?? "refused"))") }
        while store.currentSessionId == before, ContinuousClock.now - t0 < .seconds(20) { try await Task.sleep(for: .milliseconds(1)) }
        let switched = ContinuousClock.now
        while (chat?.documentView?.frame.height ?? 0) >= longHeight / 2, ContinuousClock.now - switched < .seconds(10) {
            try await Task.sleep(for: .milliseconds(1))
        }
        let laidOut = ContinuousClock.now
        log("cpu new chat: the engine switched after \(Int(Self.ms(t0.duration(to: switched)))) ms, the transcript laid out the new chat "
            + "\(Int(Self.ms(switched.duration(to: laidOut)))) ms later (\(Int(longHeight)) → \(Int(chat?.documentView?.frame.height ?? 0)) pt)")
        try write(try render(window), "cpu-new-chat")
        store.debugShowHUD(turnStartedAt: nil, agents: [])
    }

    private static func ms(_ d: Duration) -> Double { Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15 }

    /// One `scroll:` line: following, how often the view moved up and how far it was from the bottom at the end; scrolled up,
    /// how far the rows shown moved (the content's growth the offset did not follow).
    private func report(_ what: String, _ samples: [(y: CGFloat, height: CGFloat, visible: CGFloat)], following: Bool) {
        guard let first = samples.first, let last = samples.last else { return log("scroll \(what): no samples") }
        var ups = 0
        var worstUp: CGFloat = 0
        var farthest: CGFloat = 0
        var atEnd: [String] = []
        for (a, b) in zip(samples, samples.dropFirst()) {
            // Up, and further from the end: a content that shrinks above a view at its end moves the offset, not the rows shown.
            if b.y < a.y - 4 {
                let (ga, gb) = (a.height - (a.y + a.visible), b.height - (b.y + b.visible))
                if gb > ga + 4 { ups += 1; worstUp = max(worstUp, a.y - b.y) }
                else { atEnd.append("\(Int(a.y - b.y)) pt (content \(Int(b.height - a.height)) pt, \(Int(ga))→\(Int(gb)) pt from the end)") }
            }
            farthest = max(farthest, b.height - (b.y + b.visible))
        }
        if following {
            // At the bottom: the stack's bottom padding (12 pt) under the bottom marker.
            let gap = last.height - (last.y + last.visible)
            log("scroll \(what): \(samples.count) samples, moved up \(ups)× (worst \(Int(worstUp)) pt), farthest from the bottom \(Int(farthest)) pt, "
                + "at the end \(Int(gap)) pt" + (atEnd.isEmpty ? "" : "; the offset went up with the view kept at the end \(atEnd.count)×: " + atEnd.prefix(4).joined(separator: ", "))
                + (ups > 0 || gap > 16 ? " — JUMP" : " — steady"))
        } else {
            let grew = last.height - first.height
            let moved = last.y - first.y
            let shift = grew - moved
            log("scroll \(what): content \(grew >= 0 ? "+" : "")\(Int(grew)) pt, offset \(moved >= 0 ? "+" : "")\(Int(moved)) pt, moved up \(ups)× — "
                + (abs(shift) > 4 ? "SHIFT \(Int(shift)) pt" : "the rows shown stayed"))
        }
    }

    /// The composer's text view (`ComposerTextView`).
    private func composerView(_ window: NSWindow) -> NSTextView? {
        (try? views(NSTextView.self, in: window, minSize: 0))?.first { $0.accessibilityIdentifier() == "Composer" }
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

    // MARK: Overlap (`SHOTS_LAYOUT=overlap`)

    /// Lays `window` out and draws it 60 times a second, as AppKit does a window on screen (it never draws a quiet one).
    private static func drawAtScreenPace(_ window: NSWindow) -> Timer {
        let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { _ in MainActor.assumeIsolated { window.displayIfNeeded() } }
        RunLoop.main.add(timer, forMode: .common)
        return timer
    }

    /// `SHOTS_LAYOUT=overlap`: a long made-up session of rich turns (`richTurn`) — Claude's question answered, an MCP server's
    /// calls, Bash calls and a failing one, long answers with headings, a list and two tables, turn summaries — then more such
    /// turns begin and stream while following (the rows made at once move into the lazy stack as each begins), the reader
    /// scrolls up and back down while turns come, the window changes size and the diff pane opens. After each step the rows on
    /// screen are matched with each other (`overlapCheck`): two rows laid out over one another, an answer's AppKit text or
    /// table in no row's frame, or a text taller than its frame, is an OVERLAP (`overlap:` lines,
    /// `overlap-<n>.png`).
    private func overlapChecks() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        guard TranscriptRowFrames.enabled else { throw TourError("the rows' frames are not recorded (not a .screenshots build?)") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        // A window on screen is laid out and drawn every frame; a quiet one is never drawn by AppKit (its views wait for a
        // display that does not come), so it is drawn here at the screen's pace — what is checked is what a user would see.
        let pump = Self.drawAtScreenPace(window)
        defer { pump.invalidate() }
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        for n in 1...36 { await richTurn(n, root: root, gap: nil) }
        let visible = window.screen?.visibleFrame ?? window.frame
        func resize(_ size: NSSize) async throws {
            window.setFrame(NSRect(origin: NSPoint(x: visible.minX, y: visible.maxY - size.height), size: size), display: true)
            try await Task.sleep(for: .milliseconds(1200))
        }
        try await resize(NSSize(width: 1000, height: 637))
        guard let chat = Self.chatScrollView(try scrollViews(window)) else { throw TourError("overlap: no chat scroll view") }
        var turn = 36, marked = 0, checks = 0
        func check(_ label: String) async throws {
            try await Task.sleep(for: .milliseconds(350))
            checks += 1
            marked += try await overlapCheck(label, chat: chat, window: window, nudge: true)
        }
        try await check("opened")
        // 0) The reader is far up (the "Latest" pill showing, turns coming below) and scrolls down to the newest row as a
        // trackpad does, then back up — at the laptop size and in a tall window. Checked after every step.
        for (label, size) in [("1000x637", NSSize(width: 1000, height: 637)), ("1257x1104", NSSize(width: 1257, height: 1104))] {
            try await resize(size)
            for _ in 0..<2 { turn += 1; await richTurn(turn, root: root, gap: nil) }
            try await Task.sleep(for: .milliseconds(600))
            marked += try await scrollFeel(label, chat: chat, window: window) { turn += 1; await self.richTurn(turn, root: root, gap: nil) }
        }
        try await resize(NSSize(width: 1000, height: 637))
        /// A turn as the engine sends it, checked as it goes: its message glides in, its calls and answer come and the
        /// answer turns into markdown at the turn's end.
        func liveTurn(_ label: String) async throws {
            turn += 1
            store.debugShowGate(.running)
            await richTurn(turn, root: root, gap: .milliseconds(90)) { step in try? await check("\(label) turn \(turn) \(step)") }
            store.debugShowGate(.idle)
            try await check("\(label) turn \(turn) ended")
        }
        // 1) Following at the laptop size: turns begin one after another.
        entry.model.chatTranscript.follow = true
        for _ in 0..<6 { try await liveTurn("following") }
        // 2) The reader scrolls up, turns come below, the reader scrolls back down to the newest row.
        for round in 0..<2 {
            let clip = chat.contentView
            clip.scroll(to: NSPoint(x: 0, y: max(0, (chat.documentView?.frame.height ?? 0) - clip.bounds.height - 2500 - CGFloat(round) * 1500)))
            chat.reflectScrolledClipView(clip)
            entry.model.chatTranscript.follow = false
            try await check("scrolled up \(round)")
            for _ in 0..<2 { turn += 1; await richTurn(turn, root: root, gap: nil) }
            try await check("scrolled up \(round), turns below")
            // Down to the newest row as a trackpad does (`gesture`), a look every 240 pt.
            let state = entry.model.chatTranscript
            state.userScrolling = true
            for step in 1...400 {
                let end = max(0, (chat.documentView?.frame.height ?? 0) - clip.bounds.height)
                if end - clip.bounds.minY < 1 { break }
                clip.scroll(to: NSPoint(x: 0, y: min(end, clip.bounds.minY + 40)))
                chat.reflectScrolledClipView(clip)
                try await Task.sleep(for: .milliseconds(16))
                if step % 6 == 0 { try await check("scrolling down \(round) step \(step)") }
            }
            state.userScrolling = false
            state.follow = state.nearBottom
            if state.follow { state.unseen = 0 }
            try await check("scrolled down \(round)")
            try await liveTurn("after scrolling down \(round)")
        }
        // 3) The window changes size (rows rewrap), a turn at each size; the diff pane opens beside the chat and closes.
        for (label, size) in [("1257x1104", NSSize(width: 1257, height: 1104)), ("800x637", NSSize(width: 800, height: 637)),
                              ("1000x637", NSSize(width: 1000, height: 637))] {
            try await resize(size)
            try await check("resized \(label)")
            try await liveTurn("at \(label)")
        }
        entry.model.toggleDiffTick += 1
        try await Task.sleep(for: .milliseconds(1200))
        try await check("diff pane open")
        try await liveTurn("beside the diff")
        entry.model.toggleDiffTick += 1
        try await Task.sleep(for: .milliseconds(1200))
        try await check("diff pane closed")
        // 4) Following again: more turns, the boundary moving on with each.
        for _ in 0..<6 { try await liveTurn("following again") }
        log("overlap: \(checks) checks, \(marked) overlaps" + (marked == 0 ? " — clear" : " — OVERLAP"))
        try write(try render(window), "overlap")
    }

    /// The rows on screen laid out over one another (by more than 1 pt); an answer's AppKit parts — its text, a table's
    /// scroll view — outside every row's frame (drawn where no row was laid out for them: over other rows); an answer's
    /// text taller than its frame (the rest draws over what lies below). The window is laid out first, as a window on screen
    /// is before it is drawn (a quiet one is never drawn by AppKit), and scrolled a point and back: every row on screen
    /// reports its frame anew, so a frame no view stands for any more is not taken for a row. Returns how many it found; the
    /// window's picture is kept when there are any. `nudge` false: the caller just scrolled under a new generation and laid
    /// the window out (a step of a scroll), and only a finding is logged.
    private func overlapCheck(_ label: String, chat: NSScrollView, window: NSWindow, nudge: Bool) async throws -> Int {
        let clip = chat.contentView
        if nudge {
            TranscriptRowFrames.generation += 1
            let y = clip.bounds.minY
            for offset in [y >= 1 ? -1 : 1, 0] as [CGFloat] {
                clip.scroll(to: NSPoint(x: 0, y: y + offset))
                chat.reflectScrolledClipView(clip)
                window.contentView?.superview?.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(40))
            }
            window.contentView?.superview?.layoutSubtreeIfNeeded()
        }
        let generation = TranscriptRowFrames.generation
        let height = clip.bounds.height
        var rows: [(id: UUID, frame: CGRect)] = []
        var marker: CGRect?
        for row in TranscriptRowFrames.rows.values where row.generation == generation {
            if row.id == TranscriptRowFrames.bottomMarker { marker = row.frame; continue }
            if row.frame.height > 0, row.frame.maxY > 0, row.frame.minY < height { rows.append((row.id, row.frame)) }
        }
        rows.sort { $0.frame.minY < $1.frame.minY }
        var hits: [String] = []
        for (i, a) in rows.enumerated() {
            for b in rows[(i + 1)...] {
                let over = min(a.frame.maxY, b.frame.maxY) - max(a.frame.minY, b.frame.minY)
                if over > 1 {
                    let first = "\(rowKind(a.id)) y \(Int(a.frame.minY))–\(Int(a.frame.maxY))"
                    let second = "\(rowKind(b.id)) y \(Int(b.frame.minY))–\(Int(b.frame.maxY))"
                    hits.append("\(first) over \(second) (\(Int(over)) pt)")
                }
            }
        }
        // The AppKit views in the rows, in the rows' space: the content ends where the bottom marker does.
        var hosted: [(name: String, view: NSView)] = []
        if let doc = chat.documentView, let marker {
            for text in try views(ProseNSTextView.self, in: window, minSize: 0) where text.isDescendant(of: doc) {
                hosted.append(("text \"\(text.string.prefix(20))\"", text))
            }
            for scroll in try views(NSScrollView.self, in: window, minSize: 0) where scroll !== chat && scroll.isDescendant(of: doc) {
                hosted.append(("scroll view", scroll))
            }
            let shift = marker.maxY - doc.frame.height   // rows' y = document y (from the top) + shift
            for (name, view) in hosted {
                var frame = view.convert(view.bounds, to: doc)
                if !doc.isFlipped { frame.origin.y = doc.bounds.height - frame.maxY }
                let minY = frame.minY + shift, maxY = frame.maxY + shift
                guard maxY > 0, minY < height else { continue }
                if !rows.contains(where: { minY >= $0.frame.minY - 2 && maxY <= $0.frame.maxY + 2 }) {
                    var near: [String] = []
                    for row in rows where min(maxY, row.frame.maxY) - max(minY, row.frame.minY) > 1 {
                        near.append("\(rowKind(row.id)) y \(Int(row.frame.minY))–\(Int(row.frame.maxY))")
                    }
                    hits.append("\(name) y \(Int(minY))–\(Int(maxY)) in no row (over \(near.joined(separator: ", ")))")
                }
                // A text frame shorter than its text draws the rest over what lies below it.
                if let text = view as? ProseNSTextView, let layout = text.layoutManager, let container = text.textContainer {
                    let used = layout.usedRect(for: container)
                    if used.height > text.bounds.height + 1 || used.width > text.bounds.width + 1 {
                        let size = "\(Int(used.width))×\(Int(used.height))", box = "\(Int(text.bounds.width))×\(Int(text.bounds.height))"
                        hits.append("\(name): \(size) pt of text in a \(box) pt frame")
                    }
                }
            }
        }
        overlapShots += hits.isEmpty ? 0 : 1
        let counts = "\(rows.count) rows, \(hosted.count) AppKit views" + (marker == nil ? " (no bottom marker)" : "")
        if nudge || !hits.isEmpty {
            log("overlap \(label): \(counts)" + (hits.isEmpty ? " — clear" : " — OVERLAP: " + hits.prefix(6).joined(separator: " | ")))
        }
        if !hits.isEmpty, overlapShots <= 16 { try write(try render(window), "overlap-\(overlapShots)") }
        return hits.count
    }

    private var overlapShots = 0

    /// The reader far up the transcript with the "Latest" pill showing (turns came below, `addTurn`), scrolling down to the
    /// newest row as a trackpad moves the clip (40 pt every 16 ms; the transcript told the user scrolls), then back up as
    /// far. After every step the window is laid out and drawn, as on screen, and checked (`overlapCheck`). Logged: how often
    /// and by how much the content grew or shrank under the scroll, how far the end moved away from a reader going down to
    /// it ("ENDLESS" past 40 pt), and how far the rows shown moved from where the scroll put them going up ("JUMP" past
    /// 40 pt). Returns the overlaps.
    private func scrollFeel(_ label: String, chat: NSScrollView, window: NSWindow, addTurn: () async -> Void) async throws -> Int {
        let clip = chat.contentView, state = entry.model.chatTranscript
        func docHeight() -> CGFloat { chat.documentView?.frame.height ?? 0 }
        func end() -> CGFloat { docHeight() - clip.bounds.maxY }
        let frame = window.contentView?.superview
        // Far up, the reader's own scroll (following ends), then turns come below: the pill counts them.
        // (Placed again while a glide to the newest row, started before, carries it back down.)
        for _ in 0..<3 where end() < 4000 {
            state.userScrolling = true
            clip.scroll(to: NSPoint(x: 0, y: max(0, docHeight() - clip.bounds.height - 6000)))
            chat.reflectScrolledClipView(clip)
            state.userScrolling = false
            state.follow = false
            try await Task.sleep(for: .milliseconds(800))
        }
        await addTurn()
        await addTurn()
        try await Task.sleep(for: .milliseconds(900))
        let pill = !state.follow ? "pill showing (\(state.unseen) new)" : "following (no pill)"
        var overlaps = 0, blind = 0
        /// One step of `by` pt (positive: down); what the content and the clip did.
        /// `shift`: how far the rows on screen moved in the content during the step (0: they moved only by the scroll).
        func step(_ by: CGFloat, _ what: String, _ n: Int) async throws -> (grew: CGFloat, shift: CGFloat) {
            let before = (h: docHeight(), y: clip.bounds.minY)
            let shown = Dictionary(TranscriptRowFrames.rows.values.filter { $0.generation == TranscriptRowFrames.generation
                && $0.frame.maxY > 0 && $0.frame.minY < clip.bounds.height }.map { ($0.id, $0.frame.minY) }) { a, _ in a }
            let target = min(max(0, before.y + by), max(0, before.h - clip.bounds.height))
            TranscriptRowFrames.generation += 1
            clip.scroll(to: NSPoint(x: 0, y: target))
            chat.reflectScrolledClipView(clip)
            frame?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            try await Task.sleep(for: .milliseconds(16))
            overlaps += try await overlapCheck("\(label) scrolling \(what) step \(n)", chat: chat, window: window, nudge: false)
            let scrolled = clip.bounds.minY - before.y
            var shifts: [CGFloat] = []
            for row in TranscriptRowFrames.rows.values where row.generation == TranscriptRowFrames.generation {
                if let y = shown[row.id] { shifts.append(row.frame.minY - y + scrolled) }
            }
            shifts.sort()
            if shifts.isEmpty { blind += 1 }   // no row seen before and after: the step tells nothing
            return (docHeight() - before.h, shifts.isEmpty ? 0 : shifts[shifts.count / 2])
        }
        // Down to the end.
        state.userScrolling = true
        let startHeight = docHeight(), startEnd = end()
        var steps = 0, grewSteps = 0, shrankSteps = 0, grown: CGFloat = 0, away: CGFloat = 0, worstAway: CGFloat = 0
        var shiftSteps = 0, worstShift: CGFloat = 0
        while end() > 1, steps < 800 {
            let before = end()
            let (grew, shift) = try await step(40, "down", steps)
            if grew > 0.5 { grewSteps += 1; grown += grew } else if grew < -0.5 { shrankSteps += 1 }
            if abs(shift) > 1 { shiftSteps += 1; worstShift = max(worstShift, abs(shift)) }
            // How much further the end is than 40 pt nearer (or at the end): the end moving away from the reader.
            let further = end() - max(0, before - 40)
            if further > 0.5 { away += further; worstAway = max(worstAway, further) }
            steps += 1
        }
        state.userScrolling = false
        state.follow = state.nearBottom
        log("scrollfeel \(label) down, \(pill): \(steps) steps from \(Int(startEnd)) pt above the end (content \(Int(startHeight)) → \(Int(docHeight())) pt); "
            + "content grew in \(grewSteps) steps by \(Int(grown)) pt, shrank in \(shrankSteps); the end moved away by \(Int(away)) pt "
            + "(worst step \(Int(worstAway)) pt); the rows shown moved under the reader in \(shiftSteps) steps (worst \(Int(worstShift)) pt)"
            + (away > 40 ? " — ENDLESS" : "") + (worstShift > 40 ? " — JUMP" : "") + (away <= 40 && worstShift <= 40 ? " — steady" : ""))
        try await Task.sleep(for: .milliseconds(600))
        // Back up as far: the rows shown must move by what the reader scrolled, no more (content changing above them).
        state.userScrolling = true
        state.follow = false
        var upSteps = 0, upGrew = 0, upShiftSteps = 0, upShift: CGFloat = 0, upWorst: CGFloat = 0
        let upFrom = docHeight()
        while upSteps < steps, clip.bounds.minY > 1 {
            let (grew, shift) = try await step(-40, "up", upSteps)
            if abs(grew) > 0.5 { upGrew += 1 }
            if abs(shift) > 1 { upShiftSteps += 1; upShift += shift; upWorst = max(upWorst, abs(shift)) }
            upSteps += 1
        }
        state.userScrolling = false
        log("scrollfeel \(label) up: \(upSteps) steps (content \(Int(upFrom)) → \(Int(docHeight())) pt, changed in \(upGrew) steps); "
            + "the rows shown moved under the reader in \(upShiftSteps) steps, \(Int(upShift)) pt in all (worst \(Int(upWorst)) pt)"
            + (upWorst > 40 ? " — JUMP" : " — steady") + (overlaps > 0 ? "; \(overlaps) overlaps on the way" : "")
            + "; \(blind) of \(steps + upSteps) steps saw no row before and after")
        // Back to the newest row, following.
        clip.scroll(to: NSPoint(x: 0, y: max(0, docHeight() - clip.bounds.height)))
        chat.reflectScrolledClipView(clip)
        state.follow = true
        state.unseen = 0
        try await Task.sleep(for: .milliseconds(800))
        return overlaps
    }

    /// What kind of row `id` is, for the log.
    private func rowKind(_ id: UUID) -> String {
        guard let item = store.transcript.first(where: { $0.id == id }) else { return "run/group" }
        let kind = String(String(describing: item).prefix { $0 != "(" })
        if case let .toolUse(_, _, name, _, _, _) = item { return "toolUse \(name)" }
        if case let .toolResult(_, _, isError, _, _) = item { return isError ? "toolResult error" : "toolResult" }
        return kind
    }

    /// One made-up turn of a long session: a request (a long one every third turn), Claude's question answered, two calls to an
    /// MCP server, Bash calls (one failing every other turn), a long answer — a heading, a list and two tables — and the turn's
    /// end with its summary card. `gap`: the events come that far apart, the answer in bursts of words, and `checkpoint` is
    /// called at the turn's milestones; nil: all at once.
    private func richTurn(_ n: Int, root: String, gap: Duration?, checkpoint: (String) async -> Void = { _ in }) async {
        func send(_ events: [EngineEvent]) async {
            guard let gap else { return store.debugHandle(events) }
            for event in events {
                store.debugHandle([event])
                try? await Task.sleep(for: gap)
            }
        }
        func answer(_ text: String) -> [EngineEvent] {
            guard gap != nil else { return [.textDelta(text: text)] }
            let words = text.split(separator: " ", omittingEmptySubsequences: false)
            return stride(from: 0, to: words.count, by: 8).map { i in
                .textDelta(text: (i == 0 ? "" : " ") + words[i..<min(words.count, i + 8)].joined(separator: " "))
            }
        }
        let file = "\(root)/src/\(n % 2 == 0 ? "cart" : "pricing").ts"
        let request = n % 3 == 0
            ? "Step \(n): the codes should stack in the order they were entered.\n\nAlso:\n- keep FREESHIP apart from the percentage codes\n- reject an unknown code with its name in the message\n- look up what the notes say about stacking first\n\nThen run the tests and tell me what changed."
            : "Step \(n): check the notes on discount stacking and make the cart follow them."
        await send([.userMessage(text: request, turn: n)])
        await checkpoint("began")
        await send(answer("I'll look the rules up in the notes first."))
        let search = "toolu_notes_search_\(n)", page = "toolu_notes_page_\(n)"
        await send([.toolUse(id: search, name: "mcp__notes__search_pages", input: .object(["query": .string("discount stacking \(n)")]), file: nil),
                    .toolResult(toolUseId: search, isError: false, preview: "3 pages: Discount rules, Checkout FAQ, Release notes 0.\(n)"),
                    .toolUse(id: page, name: "mcp__notes__get_page", input: .object(["page_id": .string("p-\(1000 + n)")]), file: nil),
                    .toolResult(toolUseId: page, isError: false, preview: "Discount rules\n- percentage codes first\n- shipping codes last\n- at most two codes")])
        // Claude asks; the answer comes back from the message box.
        let question = Self.question(id: "tour-overlap-question-\(n)")
        await send([.permissionRequest(question)])
        await checkpoint("asked")
        store.answerQuestions(requestId: question.requestId, answers: ["Where should the discount codes live?": "src/pricing.ts"])
        try? await Task.sleep(for: gap ?? .zero)
        await checkpoint("answered")
        let read = "toolu_overlap_read_\(n)", test = "toolu_overlap_test_\(n)", stat = "toolu_overlap_stat_\(n)"
        let failing = n % 2 == 0
        await send([.toolUse(id: read, name: "Read", input: .object(["file_path": .string(file)]), file: file),
                    .toolResult(toolUseId: read, isError: false, preview: (1...8).map { "\($0)\texport const line\($0) = \($0 * 10);" }.joined(separator: "\n")),
                    .toolUse(id: test, name: "Bash", input: .object(["command": .string("npm test -- --test-name-pattern cart"), "description": .string("Run the cart tests")]), file: nil),
                    .toolResult(toolUseId: test, isError: failing,
                                preview: failing ? "Error: Command failed with exit code 1\n✖ rejects unknown codes (3ms)\n  AssertionError: expected UnknownCodeError" : "✔ applies SAVE10 (2ms)\nℹ tests 12\nℹ pass 12"),
                    .toolUse(id: stat, name: "Bash", input: .object(["command": .string("git diff --stat")]), file: nil),
                    .toolResult(toolUseId: stat, isError: false, preview: " src/pricing.ts | 14 ++++++++------\n 1 file changed, 8 insertions(+), 6 deletions(-)")])
        // Turns differ as a real session's do: some run a dozen commands, some none more.
        for i in 0..<[0, 6, 1, 12][n % 4] {
            let id = "toolu_overlap_log_\(n)_\(i)"
            await send([.toolUse(id: id, name: "Bash", input: .object(["command": .string("git log --oneline -\(i + 2) -- src/cart.ts")]), file: nil),
                        .toolResult(toolUseId: id, isError: i % 5 == 4, preview: (0...i).map { "a1b2c3\($0) Cart change \($0)" }.joined(separator: "\n"))])
        }
        await checkpoint("calls")
        // A one-line answer every third turn, a very long one (a third table of fourteen rows) every third.
        if n % 3 == 1 {
            await send(answer("Done: step \(n) changed nothing else."))
        } else {
            await send(answer(longAnswer(n, failing: failing) + (n % 3 == 2 ? "\n\n" + Self.longTable(n) : "")))
        }
        await checkpoint("answer streamed")
        let summaryFiles = [TurnSummary.File(path: "src/pricing.ts", adds: 8, dels: 6)]
        await send([.turnSummary(TurnSummary(turn: n, files: summaryFiles)),
                    .turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1200 + n, outputTokens: 640, costUsd: 0.24, durationMs: 36_600),
                             files: 0, added: 0, deleted: 0)])
        await checkpoint("ended")
    }

    /// A markdown table of fourteen rows, for the long answers.
    private static func longTable(_ n: Int) -> String {
        "### Every code tried in step \(n)\n\n| # | Code | Cart | Total before | Total after | Note |\n| ---: | --- | --- | ---: | ---: | --- |\n"
            + (1...14).map { "| \($0) | CODE\($0) | cart \($0 % 4) | $\(20 + $0).00 | $\(18 + $0).50 | \($0 % 3 == 0 ? "applied after shipping, as the notes ask for shipping codes" : "ok") |" }
            .joined(separator: "\n")
    }

    private func longAnswer(_ n: Int, failing: Bool) -> String {
        """
        ## Step \(n): how the codes stack

        The notes say percentage codes come first and shipping codes last. Today the cart takes **SAVE10** off after \
        shipping, so the order the codes were entered in decides the total. I changed `applyCodes` so that:

        - percentage codes come first, in the order they were entered;
        - `FREESHIP` only zeroes the shipping line, wherever it was entered;
        - an unknown code throws `UnknownCodeError` with the code in its message;
        - at most two codes apply, as the notes ask.

        | Code | Kind | Applied | Effect on a $40.00 cart |
        | --- | --- | :---: | ---: |
        | SAVE10 | percentage | 1st | −$4.00 |
        | WELCOME5 | percentage | 2nd | −$1.80 |
        | FREESHIP | shipping | last | −$5.99 |
        | BOGUS | unknown | — | `UnknownCodeError` |

        ### What the tests say

        | Test | Before | After | Note |
        | --- | :---: | :---: | --- |
        | applies SAVE10 | ✔ | ✔ | unchanged |
        | stacks two percentage codes | ✖ | ✔ | the order entered is kept, whatever the kind of the code that came first |
        | rejects unknown codes | ✖ | \(failing ? "✖" : "✔") | \(failing ? "still failing: the error is thrown before the code is named" : "the message names the code") |

        \(failing ? "One test still fails; I'll fix the message next." : "All 12 tests pass.")
        """
    }

    /// The transcript's scroll view in `image`: what it shows of its content, and how much of that is drawn ("BLANK": nothing).
    private func logTranscript(_ image: NSBitmapImageRep) {
        if transcript?.window == nil, let window = entry.window {
            transcript = (try? scrollViews(window)).flatMap(Self.chatScrollView)
        }
        guard let chat = transcript else { return log("chat: no scroll view") }
        let frame = chat.convert(chat.bounds, to: nil)
        // What of the rows is in view: a short chat sits at the bottom (measured there, not over the empty room above it);
        // a view that shows none of its content is blank whatever it draws.
        let clip = chat.contentView
        let shown = clip.bounds.intersection(chat.documentView.map { clip.convert($0.bounds, from: $0) } ?? .zero)
        let ink = shown.height < 1 ? 0 : Self.ink(image, in: clip.convert(shown, to: nil))
        log("chat: shows \(NSStringFromRect(chat.contentView.bounds)) of \(NSStringFromRect(chat.documentView?.frame ?? .zero)), "
            + "frame \(NSStringFromRect(frame)), ink \(String(format: "%.1f", ink * 100)) %" + (ink < 0.01 ? " — BLANK" : ""))
    }

    /// The transcript's scroll view: the rightmost, and of those the top one — the cards above the composer scroll too, below it.
    private static func chatScrollView(_ views: [NSScrollView]) -> NSScrollView? {
        views.max { a, b in
            let (fa, fb) = (a.convert(a.bounds, to: nil), b.convert(b.bounds, to: nil))
            return abs(fa.maxX - fb.maxX) > 0.5 ? fa.maxX < fb.maxX : fa.maxY < fb.maxY
        }
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
        ScreenshotTour.hideIfQuiet(panel)
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
        ScreenshotTour.hideIfQuiet(panel)
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
            transcript = Self.chatScrollView(try scrollViews(window))
        }
        try await Task.sleep(for: .milliseconds(2900))
        log("settled: active \(NSApp.isActive), key \(window.isKeyWindow), visible \(window.occlusionState.contains(.visible)), "
            + "chat \(transcript.map { NSStringFromRect($0.contentView.bounds) + " of " + NSStringFromRect($0.documentView?.frame ?? .zero) } ?? "?")")
    }

    /// An inactive window draws grey controls, and an app in the background cannot activate itself (macOS 14+): the script
    /// answers `activate` with `open -a`, which LaunchServices may honour. If nothing does, the shot is taken inactive.
    private func activate(_ window: NSWindow) async throws {
        guard !ScreenshotTour.quiet, !NSApp.isActive else { return }   // quiet: never in front of the user's apps
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

    // MARK: Open Project (`SHOTS_LAYOUT=open`)

    /// File › Open Project… (⌘O), Switch Project… (⌘⇧O) and Open in New Window… (⌘⇧N), and `ProjectOpener.open` under
    /// them, in each state a window can be in: every one must open the project, bring the window that has it forward, ask, or
    /// say why it did not — `open <case>: <outcome>` lines in tour.log, "SILENT" when none of these happened (fails the run).
    /// The folder picker is `ProjectOpener.debugPick`; the menus are run by their items (`performActionForItem`).
    private func openChecks() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let a = store.projectURL else { throw TourError("no project") }
        let b = try makeProject("acme-b"), c = try makeProject("acme-c")
        AppSettings.setConfirmCloseWhileWorking(true)
        defer { AppSettings.setConfirmCloseWhileWorking(false) }
        let registry = WorkbenchRegistry.shared
        let main = entry
        let files = [ChangedFile(path: "src/cart.ts", oldPath: nil, status: .modified, added: 3, deleted: 1, isBinary: false)]
        log("open: windows \(registry.entries.count), key \(NSApp.keyWindow === main.window), active \(NSApp.isActive)")

        try await check("idle -> B", b) { ProjectOpener.open(b, store: main.store) }
        try await check("idle -> A", a) { ProjectOpener.open(a, store: main.store) }
        try await check("the project open in this window -> A", a) { ProjectOpener.open(a, store: main.store) }
        main.store.debugShowComposerState(working: false, files: files)
        try await check("files pending review -> B", b) { ProjectOpener.open(b, store: main.store) }
        main.model.tab = .prs
        try await Task.sleep(for: .milliseconds(800))
        main.store.debugShowComposerState(working: false, files: files)
        try await check("files pending review, the PRs tab -> B", b) { ProjectOpener.open(b, store: main.store) }
        main.model.tab = .changes
        main.store.debugShowComposerState(working: true, files: [])
        try await check("a turn running -> B", b) { ProjectOpener.open(b, store: main.store) }
        main.store.debugShowComposerState(working: false, files: [])
        main.model.chatComposer.draft = "half a message"
        try await check("a message typed -> B", b) { ProjectOpener.open(b, store: main.store) }
        main.model.chatComposer.draft = ""
        await main.store.refresh(scope: nil)
        try await check("menu Open Project -> B", b) { try self.menu("o", [.command], pick: b) }
        try await check("menu Switch Project -> A", a) { try self.menu("o", [.command, .shift], pick: a) }
        let alias = URL(fileURLWithPath: a.path.hasPrefix("/private/") ? String(a.path.dropFirst(8)) : a.path + "/")
        try await check("the project already open, by another spelling (\(alias.path))", a) { ProjectOpener.open(alias, store: main.store) }
        await main.store.closeProject()
        // The empty window while an open is on its way (its git may wait — the engine caps it and then says why).
        main.store.debugShowOpening(c)
        try await Task.sleep(for: .milliseconds(1000))
        if let window = main.window { try write(try render(window), "open-opening") }
        main.store.debugShowOpening(nil)
        try await check("project closed -> B", b) { ProjectOpener.open(b, store: main.store) }

        // A second window, then the first one closed: the menus must act on the window left.
        // File › New Window (⌘N) must open one, whatever windows are open (with no value SwiftUI brought the launch window).
        let windowsBefore = Set(registry.entries.map(ObjectIdentifier.init))
        try menu("n", [.command], pick: b)
        var newWindow: WorkbenchWindowEntry?
        for _ in 0..<80 where newWindow == nil {
            try await Task.sleep(for: .milliseconds(100))
            newWindow = registry.entries.first { !windowsBefore.contains(ObjectIdentifier($0)) && $0.window != nil }
        }
        log("open menu New Window: " + (newWindow == nil ? "SILENT" : "opened a new window"))
        guard let second = newWindow else { throw TourError("no second window") }
        for extra in registry.entries where extra !== main && extra !== second { extra.window?.close() }
        try await until("two windows") { registry.entries.count == 2 }
        second.window?.makeKeyAndOrderFront(nil)
        main.window?.close()
        try await until("the first window gone") { registry.entries.count == 1 }
        try await Task.sleep(for: .milliseconds(800))
        log("open: windows \(registry.entries.count), key \(NSApp.keyWindow === second.window), focused \(registry.focused === second)")
        try await check("the closed window's store (a stale menu target) -> C", c) { ProjectOpener.open(c, store: main.store) }
        try await check("second window: menu Open Project -> A", a) { try self.menu("o", [.command], pick: a) }
        try await check("second window: menu Open Project -> B", b) { try self.menu("o", [.command], pick: b) }
        try await check("second window: menu Open in New Window -> C", c) { try self.menu("n", [.command, .shift], pick: c) }
        guard let third = registry.entries.first(where: { $0 !== second && $0 !== main }) else { throw TourError("no third window") }
        second.window?.makeKeyAndOrderFront(nil)
        try await check("second window in front: menu Open in New Window -> C", c) { try self.menu("n", [.command, .shift], pick: c) }
        try await check("another window: open A", a) { ProjectOpener.open(a, store: third.store) }
        second.window?.makeKeyAndOrderFront(nil)
        try await check("second window in front: menu Open in New Window -> C, again", c) { try self.menu("n", [.command, .shift], pick: c) }
        second.window?.makeKeyAndOrderFront(nil)
        try await check("second window in front: menu Switch Project -> A", a) { try self.menu("o", [.command, .shift], pick: a) }
        if let window = registry.entries.first?.window { try write(try render(window), "open-last") }
    }

    /// Runs `act` and reads off the app, for up to 8 s, what it ended in; a question it raised is cancelled.
    private func check(_ name: String, _ target: URL, _ act: () throws -> Void) async throws {
        let registry = WorkbenchRegistry.shared
        let key = AppSettings.projectKey(target)
        let before = Dictionary(uniqueKeysWithValues: registry.entries.map { (ObjectIdentifier($0), $0.store.projectURL.map(AppSettings.projectKey)) })
        let front = NSApp.orderedWindows.first
        Toast.debugShown = nil
        try act()
        var outcome: String?
        for _ in 0..<80 where outcome == nil {
            try await Task.sleep(for: .milliseconds(100))
            for e in registry.entries {
                if let sheet = e.window?.attachedSheet {
                    outcome = "asked — \"\(Self.texts(sheet.contentView).joined(separator: " / "))\""
                    // As the user would: the question's Cancel (its Esc button) — never the window's state from outside.
                    guard let cancel = Self.cancelButton(sheet.contentView) else { throw TourError("no Cancel in the question") }
                    cancel.performClick(nil)
                    try await until("the question gone") { e.window?.attachedSheet == nil }
                    break
                }
                let now = e.store.projectURL.map(AppSettings.projectKey)
                if now == key, e.store.projectInfo != nil, before[ObjectIdentifier(e)] != .some(key) {
                    outcome = before[ObjectIdentifier(e)] == nil ? "opened in a new window" : "opened in this window"
                    break
                }
                if let banner = e.store.errorBanner { outcome = "message — \(banner.message)"; break }
                if let toast = Toast.debugShown { outcome = "said — \"\(toast)\""; Toast.debugShown = nil; break }
            }
        }
        if outcome == nil, let window = registry.entry(for: target)?.window, NSApp.orderedWindows.first === window, front !== window {
            outcome = "its window came forward"
        }
        let windows = registry.entries.map { e in
            (e.store.projectURL?.lastPathComponent ?? "empty") + (e.window.map { NSApp.orderedWindows.first === $0 } == true ? "*" : "")
        }
        log("open \(name): \(outcome ?? "SILENT")   [windows: \(windows.joined(separator: ", "))]")
        if case .some(let line) = outcome, line.hasPrefix("opened") {
            try await until("\(target.lastPathComponent) ready") { registry.entry(for: target)?.store.isSessionOpen == true }
        }
    }

    private func until(_ what: String, timeout seconds: Int = 60, _ done: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !done() {
            guard ContinuousClock.now < deadline else { throw TourError("timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

    /// Runs the main menu's item with this shortcut, the folder picker answering `pick`.
    private func menu(_ key: String, _ modifiers: NSEvent.ModifierFlags, pick: URL) throws {
        func find(_ menu: NSMenu) -> (NSMenu, Int)? {
            for (i, item) in menu.items.enumerated() {
                if item.keyEquivalent.lowercased() == key,
                   item.keyEquivalentModifierMask.intersection([.command, .shift, .option, .control]) == modifiers
                    || (item.keyEquivalent == key.uppercased() && modifiers == [.command, .shift]
                        && item.keyEquivalentModifierMask.intersection([.command, .shift, .option, .control]) == .command) {
                    return (menu, i)
                }
                if let sub = item.submenu, let hit = find(sub) { return hit }
            }
            return nil
        }
        guard let bar = NSApp.mainMenu, let (menu, index) = find(bar) else { throw TourError("no menu item for \(key) \(modifiers)") }
        log("open: menu \"\(menu.items[index].title)\"")
        ProjectOpener.debugPick = pick
        menu.performActionForItem(at: index)
        ProjectOpener.debugPick = nil
    }

    private static func cancelButton(_ view: NSView?) -> NSButton? {
        guard let view else { return nil }
        if let button = view as? NSButton,
           button.keyEquivalent == "\u{1b}" || [CloseGuardText.cancelButton, String(localized: "Cancel")].contains(button.title) {
            return button
        }
        return view.subviews.lazy.compactMap { cancelButton($0) }.first
    }

    private static func texts(_ view: NSView?) -> [String] {
        guard let view else { return [] }
        let own = (view as? NSTextField).map { [$0.stringValue] } ?? []
        return own.filter { !$0.isEmpty } + view.subviews.flatMap { texts($0) }
    }

    /// A git repository of one commit under the tour's folder.
    private func makeProject(_ name: String) throws -> URL {
        let dir = out.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "# \(name)\n".write(to: dir.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
        let id = ["-c", "user.name=Acme Dev", "-c", "user.email=dev@acme.example", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"]
        for args in [["init", "-q", "-b", "main"], ["add", "-A"], id + ["commit", "-q", "-m", "init"]] {
            let git = Process()
            git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            git.arguments = ["-C", dir.path] + args
            try git.run()
            git.waitUntilExit()
            guard git.terminationStatus == 0 else { throw TourError("git \(args) failed in \(dir.path)") }
        }
        return dir.standardizedFileURL
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
        // need the main queue. polish p-lifecycle (§55.7): the app's own quit — "Quit ReviewGate?" never holds it.
        AppQuit.terminate()
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
