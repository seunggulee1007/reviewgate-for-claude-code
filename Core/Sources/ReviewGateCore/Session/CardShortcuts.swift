import Foundation

// wave1 mac-perms — audit polish-01: the chat's card shortcuts (⌘↩ / ⌥⌘↩ / ⌘⌫ / Esc) act only where the keyboard focus
// is — the main composer or the card itself — never from the side-question field, the find bar, a note editor or any
// other input. The views route keys here: the composer's text view for the composer, each card's own key handler for
// a focused card; every other input reaches no handler at all (`.elsewhere` documents that rule for the tests).

/// A card shortcut key.
public enum CardShortcutKey: Sendable, Equatable {
    /// ⌘↩
    case commandReturn
    /// ⌥⌘↩
    case optionCommandReturn
    /// ⌘⌫
    case commandDelete
    /// Esc
    case escape
    /// r2-chats-cards M24: 1…9 without modifiers on a focused card (from the composer a digit is text, never a key here).
    case digit(Int)
}

/// Where the keyboard focus is when a shortcut key is pressed.
public enum CardShortcutFocus: Sendable, Equatable {
    /// The main composer; `draft` is its text as typed.
    case composer(draft: String)
    /// A permission card itself (not its deny-instruction field).
    case permissionCard(requestId: String)
    /// A question card itself (not its "Other…" field).
    case questionCard(requestId: String)
    /// The plan card itself (not its note field).
    case planCard
    /// Anything else: the side-question field, the find bar, a note editor, a card's own text field, nothing focused.
    case elsewhere
}

public enum CardShortcutAction: Sendable, Equatable {
    case none
    /// ⌘↩ with text in the composer: send it (or queue it while Claude works) — exactly as before.
    case sendDraft
    case allowOnce(requestId: String)
    /// "세션 동안 허용" (`remember`).
    case allowForSession(requestId: String)
    case deny(requestId: String)
    case answerQuestions(requestId: String)
    case skipQuestions(requestId: String)
    case keepPlanning
    /// Esc on a focused permission card: back to the composer; nothing is answered.
    case focusComposer
    // MARK: wave4d w4d-windows
    /// ⌥⌘↩ with text in the composer: "중단하고 보내기" while Claude works (§28), else a plain send / queue.
    case stopAndSendDraft
    // MARK: r2-chats-cards M24 (§33.10)
    /// The send key with text while a permission card waits: that card is denied with the text as the instruction — Claude
    /// follows it in the same turn (as "거절하고 지시…"); the text never waits behind the card.
    case denyWithDraft(requestId: String)
    /// 3 on a focused permission card: its "거절하고 지시…" field opens.
    case openDenyInstruction(requestId: String)
    /// polish P4-composer-26: 1…9 on a focused question card — that option of its current question.
    case pickQuestionOption(requestId: String, number: Int)
    /// polish P4-composer-28: ⌘↩ on the focused plan card — approve it.
    case approvePlan
}

public enum CardShortcuts {
    /// The action of `key` pressed with the focus at `focus`.
    /// - Parameter target: from the composer, the request the shortcuts answer — the oldest open one that is not a
    ///   question (`AppState.shortcutPermission`); for a focused permission card, that card's request while it is open.
    public static func action(for key: CardShortcutKey, focus: CardShortcutFocus, target: PermissionRequest?) -> CardShortcutAction {
        switch focus {
        case .elsewhere:
            return .none
        case let .composer(draft):
            let hasText = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            switch key {
            case .commandReturn:
                // r2-chats-cards M24: with a card waiting the text answers it — a deny with this instruction.
                if hasText { return target.map { .denyWithDraft(requestId: $0.requestId) } ?? .sendDraft }
                return target.map { .allowOnce(requestId: $0.requestId) } ?? .none
            case .optionCommandReturn:
                // MARK: wave4d w4d-windows — polish-08: with text, the stronger ⌘↩ — stop the turn and send this (Windows'
                // Ctrl+Alt+Enter, docs/SHORTCUTS.md). Only with an empty draft does ⌥⌘↩ answer a card.
                if hasText { return .stopAndSendDraft }
                guard let target, PermissionCardOptions(request: target).allowsRemember else { return .none }
                return .allowForSession(requestId: target.requestId)
            case .commandDelete:
                // Any character in the composer (spaces too) keeps ⌘⌫ a text deletion.
                guard draft.isEmpty, let target else { return .none }
                return .deny(requestId: target.requestId)
            case .escape, .digit:
                // Esc in the composer closes its palettes; it never keeps planning or skips a question. A digit is text.
                return .none
            }
        case let .permissionCard(requestId):
            guard let target, target.requestId == requestId else { return key == .escape ? .focusComposer : .none }
            switch key {
            case .commandReturn: return .allowOnce(requestId: requestId)
            case .optionCommandReturn:
                return PermissionCardOptions(request: target).allowsRemember ? .allowForSession(requestId: requestId) : .none
            case .commandDelete: return .deny(requestId: requestId)
            case .escape: return .focusComposer
            case let .digit(n):
                // r2-chats-cards M24: the terminal's 1 / 2 / 3 — never an allow on a red card (⌘↩ only there).
                let options = PermissionCardOptions(request: target)
                let danger = target.reason.map { PermissionReasonText.level($0) == .danger } ?? false
                switch n {
                case 1: return danger ? .none : .allowOnce(requestId: requestId)
                case 2: return !danger && options.allowsRemember ? .allowForSession(requestId: requestId) : .none
                case 3: return options.layout == .sendMessage ? .none : .openDenyInstruction(requestId: requestId)
                default: return .none
                }
            }
        case let .questionCard(requestId):
            switch key {
            case .commandReturn: return .answerQuestions(requestId: requestId)
            case .escape: return .skipQuestions(requestId: requestId)
            case let .digit(n): return n >= 1 ? .pickQuestionOption(requestId: requestId, number: n) : .none   // polish P4-composer-26
            case .optionCommandReturn, .commandDelete: return .none
            }
        case .planCard:
            switch key {
            case .escape: return .keepPlanning
            case .commandReturn: return .approvePlan   // polish P4-composer-28
            case .optionCommandReturn, .commandDelete, .digit: return .none
            }
        }
    }
}
