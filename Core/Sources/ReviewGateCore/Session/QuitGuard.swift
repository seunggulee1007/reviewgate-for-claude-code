import Foundation

// MARK: polish p-lifecycle — P1-chrome-01 / P1-chrome-03 / P1-chrome-04 / P2-review-21 / P3-transcript-29 / P4-composer-07 /
// P5-sheets-50 / P5-sheets-51
//
// What quitting (⌘Q, the Dock, closing the last window), closing one window or switching / closing a window's project does
// to that window's work: what stops with its engine, what is lost, and what stays and comes back when the project is opened
// again. The Windows client has the same list and words (clients/desktop/src/shared/closeGuard.ts). docs/PROTOCOL.md §55.7.

/// One thing a window has going on when it would close.
public enum QuitReason: Equatable, Sendable {
    /// A turn runs.
    case working
    /// A permission card, a question or a plan waits for the user.
    case waiting
    /// §52 background commands (a dev server, a build) — they stop with the session.
    case backgroundTasks(Int)
    /// Subagents still working after the turn ended (§52.2).
    case backgroundAgents(Int)
    /// Side questions still answering (§21).
    case sideQuestions(Int)
    /// A workbench being created (its worktree and setup).
    case creatingWorkbench
    /// Images attached to the message being typed or to queued messages: they are not kept.
    case images(Int)
    /// PR review comments not submitted yet: the engine holds them in memory only.
    case prDrafts(Int)
    /// Messages waiting in the queue: kept (text and mentions) and back, paused, when the project opens again.
    case queued(Int)
    /// Files waiting for review: kept with the review.
    case pendingReview(Int)
    /// Review notes not sent yet: kept with the review.
    case unsentNotes(Int)
    /// The message being typed: kept on disk.
    case draft

    /// Closing stops it.
    public var stops: Bool {
        switch self {
        case .working, .waiting, .backgroundTasks, .backgroundAgents, .sideQuestions, .creatingWorkbench: true
        case .images, .prDrafts, .queued, .pendingReview, .unsentNotes, .draft: false
        }
    }

    /// Closing loses it.
    public var loses: Bool {
        switch self {
        case .images, .prDrafts: true
        default: false
        }
    }
}

/// One window as the close / quit confirmation sees it.
public struct WindowQuitState: Equatable, Sendable {
    /// The project's name ("acme-api"); "" for a window without a project.
    public var name: String
    public var reasons: [QuitReason]
    /// What other parts of the window registered as lost on close (`WindowModel.unsavedWorkLines`: a review note being
    /// written, an edited message…), already in words.
    public var unsavedLines: [String]

    public init(name: String, reasons: [QuitReason], unsavedLines: [String] = []) {
        self.name = name
        self.reasons = reasons
        self.unsavedLines = unsavedLines
    }

    /// Closing stops something running.
    public var stops: Bool { reasons.contains(where: \.stops) }
    /// Closing loses something.
    public var loses: Bool { !unsavedLines.isEmpty || reasons.contains(where: \.loses) }
    /// Closing stops or loses something: "Ask before closing while Claude works" decides, not "Ask before quitting".
    public var needsCare: Bool { stops || loses }
}

/// The close / quit / switch confirmation's words and buttons — a pure decision; the apps show it (an alert).
public struct QuitPrompt: Equatable, Sendable {
    public enum Kind: Sendable, Equatable {
        /// ⌘Q, the Dock's Quit.
        case quit
        /// The last window's close button / ⌘W — it quits.
        case lastWindow
    }

    /// P1-chrome-03: what is done to the window's project.
    public enum ProjectChange: Sendable, Equatable {
        case switchProject
        case closeProject
    }

    public var title: String
    public var message: String
    public var confirm: String
    public var cancel: String
    /// "Don't ask again" — on a quit only when nothing would stop or be lost (it turns off `confirmQuit` alone); on a
    /// window's close or a project switch it turns off "Ask before closing while Claude works".
    public var offersSuppression: Bool
    /// Something would be lost: Cancel is the default button.
    public var cancelIsDefault: Bool

    /// Quit and the last window's close. nil: quit without asking. `confirmQuit` = Settings › General "Ask before
    /// quitting" — it decides while nothing would stop or be lost; `confirmWhileWorking` = "Ask before closing while Claude
    /// works" — it alone decides otherwise. `reopenCount`: the projects the next launch reopens (nil when "Reopen last
    /// projects" is off).
    public static func make(_ windows: [WindowQuitState], kind: Kind, confirmQuit: Bool, confirmWhileWorking: Bool,
                            reopenCount: Int?) -> QuitPrompt? {
        let needsCare = windows.contains(where: \.needsCare)
        guard needsCare ? confirmWhileWorking : confirmQuit else { return nil }
        var paragraphs: [String] = []
        if kind == .lastWindow { paragraphs.append(QuitText.lastWindowQuits) }
        let stops = windows.flatMap { w in w.reasons.filter(\.stops).map { QuitText.line($0, window: w.name) } }
        let lost = windows.flatMap { w in
            w.unsavedLines.map { QuitText.named($0, window: w.name) } + w.reasons.filter(\.loses).map { QuitText.line($0, window: w.name) }
        }
        var stays = windows.flatMap { QuitText.stayLines($0) }
        let keepsTyping = windows.contains { w in w.reasons.contains { $0 == .draft || $0.isUnsentNotes } }
        if keepsTyping { stays.append(QuitText.notesAndDraftStay) }
        let projects = windows.filter { !$0.name.isEmpty }.count
        if stops.isEmpty, projects > 0 { stays.insert(QuitText.sessionsEnd(projects), at: 0) }
        if let reopenCount, reopenCount > 0 { stays.append(QuitText.reopen(reopenCount)) }
        for block in [stops, lost, stays] where !block.isEmpty { paragraphs.append(block.joined(separator: "\n")) }
        return QuitPrompt(title: QuitText.title, message: paragraphs.joined(separator: "\n\n"),
                          confirm: CloseGuardText.quitButton, cancel: CloseGuardText.cancelButton,
                          offersSuppression: !needsCare, cancelIsDefault: windows.contains(where: \.loses))
    }

    /// Closing one window that is not the last one: asks only while something would stop or be lost (and "Ask before
    /// closing while Claude works" is on). The title says why — Claude working, Claude waiting, or the window's other work.
    public static func close(_ window: WindowQuitState, confirmWhileWorking: Bool) -> QuitPrompt? {
        guard confirmWhileWorking, window.needsCare else { return nil }
        return guardPrompt(window, lead: { CloseGuardText.message($0) }, confirm: CloseGuardText.closeButton)
    }

    /// P1-chrome-03: switching or closing the window's project stops its session — asks while something would stop or be
    /// lost, like a window's close. The pending-review question comes after it only when this one did not ask.
    public static func projectChange(_ window: WindowQuitState, _ change: ProjectChange, confirmWhileWorking: Bool) -> QuitPrompt? {
        guard confirmWhileWorking, window.needsCare else { return nil }
        switch change {
        case .switchProject:
            return guardPrompt(window, lead: { _ in QuitText.switchStops }, confirm: QuitText.switchButton)
        case .closeProject:
            return guardPrompt(window, lead: { _ in QuitText.closeProjectStops }, confirm: QuitText.closeProjectButton)
        }
    }

    /// One window's question: the title by the reason (waiting wins), `lead` for a turn that would stop, every other thing
    /// that would stop or be lost line by line, then what stays.
    private static func guardPrompt(_ window: WindowQuitState, lead: (CloseGuardReason) -> String, confirm: String) -> QuitPrompt {
        let title: String
        var paragraphs: [String] = []
        if window.reasons.contains(.waiting) {
            title = CloseGuardText.title(for: .waiting)
            paragraphs.append(lead(.waiting))
        } else if window.reasons.contains(.working) {
            title = CloseGuardText.title(for: .working)
            paragraphs.append(lead(.working))
        } else {
            title = QuitText.closeWindowTitle
        }
        let other = window.reasons.filter { ($0.stops || $0.loses) && $0 != .working && $0 != .waiting }
        let lines = other.map { QuitText.line($0, window: nil) } + window.unsavedLines
        if !lines.isEmpty { paragraphs.append(lines.joined(separator: "\n")) }
        paragraphs.append(QuitText.whatStays)
        return QuitPrompt(title: title, message: paragraphs.joined(separator: "\n\n"), confirm: confirm,
                          cancel: CloseGuardText.cancelButton, offersSuppression: true, cancelIsDefault: window.loses)
    }
}

private extension QuitReason {
    var isUnsentNotes: Bool {
        if case .unsentNotes = self { return true }
        return false
    }
}

/// The words (Mac and Windows use the same English keys).
public enum QuitText {
    public static var title: String { String(localized: "Quit ReviewGate?", bundle: .module) }
    public static var lastWindowQuits: String { String(localized: "Closing the last window quits ReviewGate.", bundle: .module) }
    public static var closeWindowTitle: String { String(localized: "Close this window?", bundle: .module) }
    public static var notesAndDraftStay: String {
        String(localized: "Unsent notes and the message you were typing are kept", bundle: .module)
    }
    public static var whatStays: String {
        String(localized: "Pending reviews, notes and drafts come back when you reopen.", bundle: .module)
    }
    public static var switchStops: String { String(localized: "Switching projects stops this turn.", bundle: .module) }
    public static var closeProjectStops: String { String(localized: "Closing the project stops this turn.", bundle: .module) }
    public static var switchButton: String { String(localized: "Switch", bundle: .module) }
    public static var closeProjectButton: String { String(localized: "Close Project", bundle: .module) }
    /// A commit or push the window started (its sheet registers this line while it runs — `.registersUnsavedWork`).
    public static var gitOperationRunning: String { String(localized: "A commit or push is still running", bundle: .module) }
    /// P4-composer-07: the paused queue a project finds when it opens again (`AppState.queueKeepChanged`).
    public static var keptQueuePaused: String { String(localized: "Kept from before — Resume to send", bundle: .module) }

    public static func reopen(_ count: Int) -> String {
        String(localized: "\(count) projects reopen next time", bundle: .module)
    }

    /// Nothing runs: the open projects' sessions just end.
    public static func sessionsEnd(_ count: Int) -> String {
        String(localized: "The Claude sessions of \(count) open projects end.", bundle: .module)
    }

    /// `line` under the window's name ("acme-api: …"); as it is for a window without one.
    static func named(_ line: String, window: String?) -> String {
        guard let window, !window.isEmpty else { return line }
        return "\(window): \(line)"
    }

    /// One line of the dialog; `window` names the project (nil: the window being closed).
    public static func line(_ reason: QuitReason, window: String?) -> String {
        if let name = window, !name.isEmpty {
            switch reason {
            case .working: return String(localized: "\(name): Claude is working — quitting stops this turn", bundle: .module)
            case .waiting: return String(localized: "\(name): Claude is waiting for your answer — quitting stops this turn", bundle: .module)
            case .pendingReview(let n): return String(localized: "\(name): \(n) files wait for review — they come back when you reopen it", bundle: .module)
            case .queued(let n): return String(localized: "\(name): \(n) queued messages come back paused when you reopen it", bundle: .module)
            default: break
            }
        }
        let text: String
        switch reason {
        case .working: text = CloseGuardText.message(.working)
        case .waiting: text = CloseGuardText.message(.waiting)
        case .backgroundTasks(let n): text = String(localized: "\(n) background commands stop", bundle: .module)
        case .backgroundAgents(let n): text = String(localized: "\(n) background agents stop", bundle: .module)
        case .sideQuestions(let n): text = String(localized: "\(n) side questions stop", bundle: .module)
        case .creatingWorkbench: text = String(localized: "A workbench is still being created", bundle: .module)
        case .images(let n): text = String(localized: "\(n) attached images are not kept", bundle: .module)
        case .prDrafts(let n): text = String(localized: "\(n) PR review comments not submitted yet are lost", bundle: .module)
        case .pendingReview(let n): text = String(localized: "\(n) files wait for review — they come back when you reopen it", bundle: .module)
        case .queued(let n): text = String(localized: "\(n) queued messages come back paused when you reopen it", bundle: .module)
        case .unsentNotes, .draft: text = notesAndDraftStay
        }
        return named(text, window: window)
    }

    /// What stays of one window, said once: files waiting for review (with the unsent notes when there are both — P2-review-21)
    /// and the queue.
    static func stayLines(_ w: WindowQuitState) -> [String] {
        var pending = 0, notes = 0, queued = 0
        for reason in w.reasons {
            switch reason {
            case .pendingReview(let n): pending = n
            case .unsentNotes(let n): notes = n
            case .queued(let n): queued = n
            default: break
            }
        }
        var lines: [String] = []
        if pending > 0, notes > 0 {
            lines.append(named(String(localized: "\(notes) unsent notes and \(pending) pending files stay — they are here when you reopen", bundle: .module), window: w.name))
        } else if pending > 0 {
            lines.append(line(.pendingReview(pending), window: w.name))
        }
        if queued > 0 { lines.append(line(.queued(queued), window: w.name)) }
        return lines
    }
}

extension CloseGuardText {
    /// P1-chrome-04: the title says why — working, or waiting for the user's answer.
    public static func title(for reason: CloseGuardReason) -> String {
        switch reason {
        case .working: title
        case .waiting: String(localized: "Claude is waiting for your answer", bundle: .module)
        }
    }
}

// MARK: - The confirmation's facts, read from a window's store

extension AppState {
    /// What closing this window now would stop, lose or leave behind. `draft` / `draftImages`: the composer's text and the
    /// images attached to it (the window keeps the composer).
    public func quitReasons(draft: Bool = false, draftImages: Int = 0) -> [QuitReason] {
        var reasons: [QuitReason] = []
        if let reason = closeGuardReason { reasons.append(reason == .waiting ? .waiting : .working) }
        if !backgroundTasks.isEmpty { reasons.append(.backgroundTasks(backgroundTasks.count)) }
        // Subagents of a turn that runs stop with that turn (`working`); after it, they are background agents.
        if !isRunning, liveAgentCount > 0 { reasons.append(.backgroundAgents(liveAgentCount)) }
        if side.runningCount > 0 { reasons.append(.sideQuestions(side.runningCount)) }
        if flow.creatingBranch != nil { reasons.append(.creatingWorkbench) }
        let images = draftImages + queuedMessages.reduce(0) { $0 + $1.images.count }
        if images > 0 { reasons.append(.images(images)) }
        if !pr.draftComments.isEmpty { reasons.append(.prDrafts(pr.draftComments.count)) }
        if !queuedMessages.isEmpty { reasons.append(.queued(queuedMessages.count)) }
        let pending = pendingFiles.count + changesRequestedFiles.count
        if pending > 0 { reasons.append(.pendingReview(pending)) }
        let unsent = reviewNotes.filter { $0.sent == nil }.count
        if unsent > 0 { reasons.append(.unsentNotes(unsent)) }
        if draft { reasons.append(.draft) }
        return reasons
    }

    /// The name the dialog gives this window's project ("acme-api"); "" without one.
    public var quitDisplayName: String { projectURL == nil ? "" : repoDisplayName }
}

// MARK: - PX-14: a logout, restart or shut down never waits on the question

/// The `kAEQuitReason` of the system's Quit Apple event (AERegistry.h): a logout, restart or shut down quits without a
/// question — one would hold the logout back ("ReviewGate 때문에 로그아웃이 취소됨").
public enum SystemQuit {
    /// `kAEQuitReason` ('why?').
    public static let quitReasonKeyword = fourCharCode("why?")
    /// `kAELogOut`, `kAEReallyLogOut`, `kAEShowRestartDialog`, `kAERestart`, `kAEShowShutdownDialog`, `kAEShutDown`.
    public static let reasons: Set<UInt32> = Set(["logo", "rlgo", "rrst", "rest", "rsdn", "shut"].map(fourCharCode))

    public static func isSystemQuit(_ reason: UInt32?) -> Bool {
        reason.map(reasons.contains) ?? false
    }

    /// 'logo' → 0x6C6F676F.
    public static func fourCharCode(_ text: String) -> UInt32 {
        text.utf8.prefix(4).reduce(0) { $0 << 8 | UInt32($1) }
    }
}

// MARK: - P1-chrome-02 / P5-sheets-52: the window list keeps the last window

/// The `openWindows` list to write when the windows change — nil: keep the one written. Nothing is written while the app
/// quits (the list was written before any engine stopped) or once the last window has gone (its project comes back at the
/// next launch); a window that closed its project but stays writes the shorter list (the user closed it).
public enum OpenWindowList {
    public static func toWrite(_ windows: [AppSettings.OpenWindowState?], terminating: Bool) -> [AppSettings.OpenWindowState]? {
        guard !terminating, !windows.isEmpty else { return nil }
        return windows.compactMap { $0 }
    }
}
