import Foundation

// docs/PROTOCOL.md §63 — review first: Claude's next work waits until the user reviewed its last changes. The engine
// denies the edits; the Mac's part is the setting (Settings › Review), the wire (`gate.reviewFirst`), the quiet row when a
// call was denied, the terminal strip's chip and — with `prompts` — the composer holding a message until the review is done.

/// `settings.reviewFirst`: what waits for the review.
public enum ReviewFirstMode: String, CaseIterable, Sendable, Decodable {
    /// Claude may answer and read, but not change files, while files wait (the default).
    case edits
    /// A new message waits too.
    case prompts
    /// Neither (a message during a review is a question that may edit, as before 0.5.22).
    case off

    /// The English key of the picker's choice.
    public var title: String {
        switch self {
        case .edits: "Block edits (default)"
        case .prompts: "Block prompts too"
        case .off: "Turn off"
        }
    }
}

/// `state.gate.reviewFirst`: the rule while it holds Claude back (nil: it does not, or an older engine).
public struct ReviewFirstInfo: Decodable, Sendable, Equatable {
    public var mode: ReviewFirstMode
    /// Files it waits on (pending + changes requested).
    public var waiting: Int
    /// Calls it denied in the current (between turns: the last) turn.
    public var blocked: Int

    public init(mode: ReviewFirstMode, waiting: Int, blocked: Int = 0) {
        self.mode = mode
        self.waiting = waiting
        self.blocked = blocked
    }

    private enum Keys: String, CodingKey { case mode, waiting, blocked }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        mode = ((try? c.decodeIfPresent(ReviewFirstMode.self, forKey: .mode)) ?? nil) ?? .edits
        waiting = ((try? c.decodeIfPresent(Int.self, forKey: .waiting)) ?? nil) ?? 0
        blocked = ((try? c.decodeIfPresent(Int.self, forKey: .blocked)) ?? nil) ?? 0
    }
}

/// The lenient read of `gate.reviewFirst` (absent, null or malformed → nil).
enum ReviewFirstWire {
    private enum GateKeys: String, CodingKey { case reviewFirst }

    static func info(from decoder: Decoder) -> ReviewFirstInfo? {
        guard let c = try? decoder.container(keyedBy: GateKeys.self) else { return nil }
        return (try? c.decodeIfPresent(ReviewFirstInfo.self, forKey: .reviewFirst)) ?? nil
    }
}

extension AppSettings.Key {
    /// §63: `edits` / `prompts` / `off`; unset → `edits`.
    public static let reviewFirst = "reviewFirst"
}

extension AppSettings {
    public static func reviewFirst(defaults: UserDefaults = .standard) -> ReviewFirstMode {
        defaults.string(forKey: Key.reviewFirst).flatMap(ReviewFirstMode.init(rawValue:)) ?? .edits
    }
}

/// The words of §63 (English keys, Korean in the catalog; Electron uses the same keys).
public enum ReviewFirstText {
    /// The engine's row when a call was denied: a gray chat row only (no banner, the queue goes on).
    public static let rowCode = "review_first_blocked"

    public static func isRowOnly(_ code: String?) -> Bool { code == rowCode }

    /// The row's (and the terminal chip's) words.
    public static var blockedText: String { String(localized: "Claude's edits are blocked while files wait for your review", bundle: .module) }

    /// The row's / chip's tooltip.
    public static var blockedHelp: String {
        String(localized: "Claude can answer questions, read and plan, but it may not change files until you accept or reject the files waiting for review. Settings › Review changes this.", bundle: .module)
    }

    /// [리뷰 열기]
    public static var openReviewTitle: String { String(localized: "Open Review", bundle: .module) }

    public static var openReviewHelp: String { String(localized: "Shows the first file waiting for your review", bundle: .module) }

    /// The composer's banner while a message waits (`prompts`).
    public static func holdTitle(_ waiting: Int) -> String {
        String(localized: "Finish the review first — \(waiting) waiting", bundle: .module)
    }

    public static var holdHelp: String {
        String(localized: "Settings › Review is set to hold new messages until you accept or reject the files waiting for review. Your message is kept and goes once nothing waits.", bundle: .module)
    }

    /// The queue's hold line.
    public static var queueHold: String { String(localized: "Waits until you finish the review", bundle: .module) }

    /// [N개 수락 후 보내기]
    public static func acceptAndSendTitle(_ pending: Int) -> String {
        String(localized: "Accept \(pending) & Send", bundle: .module)
    }

    public static var acceptAndSendHelp: String {
        String(localized: "Accepts every pending file, then sends the waiting message", bundle: .module)
    }

    /// Why [N개 수락 후 보내기] is off: a file sent back with notes is not accepted this way.
    public static var changesRequestedBlocker: String {
        String(localized: "A file has changes requested — send them with Request changes, or accept or reject it first", bundle: .module)
    }
}

public extension AppState {
    /// §63: the rule while it holds Claude back (`gate.reviewFirst`).
    var reviewFirst: ReviewFirstInfo? { gate.reviewFirst }

    /// §63 `prompts`: a plain message waits while files do (a slash command never: it starts no work on the code).
    func reviewFirstHolds(_ text: String) -> Bool {
        guard let rule = reviewFirst, rule.mode == .prompts, rule.waiting > 0 else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
    }

    /// §63: the composer's held message (`prompts`): the first queued one the rule holds.
    var reviewFirstHeldMessage: QueuedMessage? {
        guard let first = queuedMessages.first, reviewFirstHolds(first.text) else { return nil }
        return first
    }

    /// Why [N개 수락 후 보내기] is off (nil: it can go).
    var reviewFirstAcceptBlocker: String? {
        if !changesRequestedFiles.isEmpty { return ReviewFirstText.changesRequestedBlocker }
        if !canAcceptAndSend { return queueHoldReason ?? String(localized: "Claude can't take a message right now", bundle: .module) }
        return nil
    }

    /// [N개 수락 후 보내기]: the held message goes with `acceptPending` — every pending file accepted first (§10).
    @discardableResult
    func acceptAndSendHeld() -> Bool {
        guard reviewFirstAcceptBlocker == nil, let message = reviewFirstHeldMessage else { return false }
        queuedMessages.removeFirst()
        queuedSendInFlight = true
        deliver(message, acceptPending: true)
        return true
    }

    /// [리뷰 열기]: the first file waiting for the review.
    @discardableResult
    func openReviewFirstWaiting() -> Bool {
        guard let file = changedFiles.first(where: { $0.state == .pending || $0.state == .changesRequested }) else { return false }
        return selectFile(path: file.path)
    }

    /// `set_settings {reviewFirst}` after Settings changed it (live).
    func pushReviewFirst() {
        guard state.seq > 0 || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.reviewFirst = AppSettings.reviewFirst(defaults: settingsDefaults).rawValue
        fire(.setSettings(settings))
    }
}
