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
        if ProcessInfo.processInfo.environment["REVIEWGATE_SCREENSHOT_LAYOUT"] == "cpu" {
            do { try await cpuChecks(); finish(nil) } catch { finish(error) }
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
        await store.refreshWorkbenches()
        log("guards: \(worktree) is a workbench: \(store.isWorkbenchPath(worktree) ? "yes" : "NO")")
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

    /// `SHOTS_LAYOUT=cpu`: what the main thread spends while Claude works and nothing changes on screen but the HUD's clock and
    /// the live agents' dots — a long chat (60 turns), the window 1257 × 1104, in front and behind another app — and how late a
    /// job queued on it runs (a tab switch's rows wait for that). `cpu:` lines in tour.log.
    private func cpuChecks() async throws {
        try await wait("session ready", timeout: 180) { $0.isSessionOpen && !$0.isStarting && $0.canSend }
        guard let window = entry.window else { throw TourError("no window") }
        try place()
        window.level = .floating
        window.orderFrontRegardless()
        defer { window.level = .normal }
        AppSettings.setAppearance(.dark)
        let root = store.projectURL?.path ?? "/Users/Shared/acme-shop"
        let visible = window.screen?.visibleFrame ?? window.frame
        window.setFrame(NSRect(origin: NSPoint(x: visible.minX, y: visible.maxY - 1104), size: NSSize(width: 1257, height: 1104)), display: true)
        store.debugHandle((1...60).flatMap { Self.turnEvents($0, root: root) })
        try await Task.sleep(for: .milliseconds(2500))
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
        for (a, b) in zip(samples, samples.dropFirst()) {
            if b.y < a.y - 4 { ups += 1; worstUp = max(worstUp, a.y - b.y) }
            farthest = max(farthest, b.height - (b.y + b.visible))
        }
        if following {
            // At the bottom: the stack's bottom padding (12 pt) under the bottom marker.
            let gap = last.height - (last.y + last.visible)
            log("scroll \(what): \(samples.count) samples, moved up \(ups)× (worst \(Int(worstUp)) pt), farthest from the bottom \(Int(farthest)) pt, "
                + "at the end \(Int(gap)) pt" + (ups > 0 || gap > 16 ? " — JUMP" : " — steady"))
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
