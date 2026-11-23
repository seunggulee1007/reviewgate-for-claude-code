import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §57.4: Esc in a terminal chat's PTY while a turn runs shows "Review now" once no hook followed it for
/// 2 s; an Esc between turns (a TUI menu closing) or one a hook followed shows nothing.
@Suite struct TerminalEscapeTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test func whichBytesAreTheEscKey() {
        #expect(TerminalEscapeKey.isEscape([0x1b]))
        #expect(TerminalEscapeKey.isEscape(Array("\u{1b}[27u".utf8)))
        #expect(TerminalEscapeKey.isEscape(Array("\u{1b}[27;1u".utf8)))
        #expect(TerminalEscapeKey.isEscape(Array("\u{1b}[27;1:1u".utf8)))
        // A release or a repeat (kitty event types), Esc with a modifier, a paste, an arrow, a reply, ESC ESC: not one press.
        #expect(!TerminalEscapeKey.isEscape(Array("\u{1b}[27;1:3u".utf8)))
        #expect(!TerminalEscapeKey.isEscape(Array("\u{1b}[27;1:2u".utf8)))
        #expect(!TerminalEscapeKey.isEscape(Array("\u{1b}[27;5u".utf8)))
        #expect(!TerminalEscapeKey.isEscape(TerminalPaste.start))
        #expect(!TerminalEscapeKey.isEscape(Array("\u{1b}[A".utf8)))
        #expect(!TerminalEscapeKey.isEscape(Array("\u{1b}[?1;2c".utf8)))
        #expect(!TerminalEscapeKey.isEscape([0x1b, 0x1b]))
        #expect(!TerminalEscapeKey.isEscape([UInt8]()))
    }

    @Test func aLoneEscFollowedAtOnceIsAMetaPrefix() {
        var filter = EscapeKeyFilter()
        // ⌥Return: ESC, then CR right after — not the Esc key.
        #expect(filter.input([0x1b], at: t0) == nil)
        #expect(filter.input([0x0d], at: t0.addingTimeInterval(0.001)) == nil)
        #expect(filter.flush(now: t0.addingTimeInterval(1)) == nil)
        // Esc alone: confirmed once the window passed.
        #expect(filter.input([0x1b], at: t0.addingTimeInterval(2)) == nil)
        #expect(filter.flush(now: t0.addingTimeInterval(2.01)) == nil)
        #expect(filter.flush(now: t0.addingTimeInterval(2.1)) == t0.addingTimeInterval(2))
        #expect(filter.flush(now: t0.addingTimeInterval(3)) == nil)
        // Esc, then a key well after it: the Esc is confirmed by that key.
        #expect(filter.input([0x1b], at: t0.addingTimeInterval(4)) == nil)
        #expect(filter.input(Array("a".utf8), at: t0.addingTimeInterval(4.5)) == t0.addingTimeInterval(4))
        // The kitty form never prefixes anything: at once.
        #expect(filter.input(Array("\u{1b}[27u".utf8), at: t0.addingTimeInterval(5)) == t0.addingTimeInterval(5))
    }

    @Test func reviewNowAfterAnEscWithNoHook() {
        let running = TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1", hookCount: 4)
        let mark = TerminalEscapeMark(at: t0, hookCount: 4, chatId: "t1")
        func shows(turn: Bool = true, info: TerminalSessionInfo? = running, chat: String = "t1", escape: TerminalEscapeMark? = mark,
                   at seconds: TimeInterval, idleSince: Date? = nil) -> Bool {
            TerminalReviewNowRules.shows(turnRunning: turn, info: info, chatId: chat, escape: escape,
                                         lastActivity: idleSince ?? t0, now: t0.addingTimeInterval(seconds))
        }
        #expect(!shows(at: 1.9))
        #expect(shows(at: 2))
        // A hook came after the Esc (Claude Code went on — it closed a menu): only the old rules.
        let later = TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1", hookCount: 5)
        #expect(!shows(info: later, at: 10))
        // No Esc, another chat's Esc, no turn, a terminal that does not run: nothing.
        #expect(!shows(escape: nil, at: 10))
        #expect(!shows(chat: "t2", at: 10))
        #expect(!shows(turn: false, at: 10))
        #expect(!shows(info: TerminalSessionInfo(running: false, hooksSeen: true, hookCount: 4), at: 10))
        // The rules before: an interrupted tool call, or 60 s with nothing.
        let interrupted = TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1", interruptSuspected: true, hookCount: 5)
        #expect(shows(info: interrupted, escape: nil, at: 0))
        #expect(shows(info: later, escape: nil, at: 60))
        #expect(!shows(info: later, escape: nil, at: 59))
    }

    @Test func anEscIsRecordedOnlyWhileATurnRuns() {
        let info = TerminalSessionInfo(running: true, hooksSeen: true, promptId: "p1")
        #expect(TerminalReviewNowRules.recordsEscape(turnRunning: true, info: info))
        #expect(!TerminalReviewNowRules.recordsEscape(turnRunning: false, info: info))
        #expect(!TerminalReviewNowRules.recordsEscape(turnRunning: true, info: TerminalSessionInfo(running: false, hooksSeen: true)))
        #expect(!TerminalReviewNowRules.recordsEscape(turnRunning: true, info: nil))
    }
}
