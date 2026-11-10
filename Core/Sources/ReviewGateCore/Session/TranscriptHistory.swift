import Foundation

// MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 "History that lasts" on the Mac: the shown chat's paging state, the
// search-match jump and the review history filter, as pure values (TranscriptHistoryTests). AppState+History.swift
// drives them; an engine before §38.3 sends no `start` (no [이전 대화 더 보기]) and refuses the search (titles only).

/// Where the shown chat's rows start in its file, and which items its user messages and Claude answers became.
public struct TranscriptPaging: Sendable, Equatable {
    /// The chat the shown rows are of; nil: nothing to page (an older engine, an empty chat).
    public var sessionId: String?
    /// Row index of the oldest shown row; > 0: older rows exist.
    public var start: Int?
    /// `at` of that row (`transcript_page.beforeAt`: re-finds it after the file was rotated).
    public var oldestAt: String?
    public var loading = false
    /// The last [이전 대화 더 보기] failed (localized, one line).
    public var error: String?
    /// Row index → ChatItem id of the shown user messages and Claude answers (a search match scrolls to its row).
    public var rowIDs: [Int: UUID] = [:]
    /// Items put above the shown ones since the chat was shown ("Latest (N)" does not count them as new).
    public var prepended = 0

    public init(sessionId: String? = nil, start: Int? = nil, oldestAt: String? = nil) {
        self.sessionId = sessionId
        self.start = start
        self.oldestAt = oldestAt
    }

    public var canLoadEarlier: Bool { sessionId != nil && (start ?? 0) > 0 }
}

/// A chat-history search match to show once its chat's row is loaded (given up `TranscriptHistory.jumpWait` after `at`:
/// a chat that never says where its rows start — an older engine — leaves no jump pending).
public struct TranscriptJump: Sendable, Equatable {
    public var sessionId: String
    public var row: Int
    public var at: Date

    public init(sessionId: String, row: Int, at: Date = Date()) {
        self.sessionId = sessionId
        self.row = row
        self.at = at
    }
}

/// The item a jump landed on; `tick` changes on every jump (the chat view scrolls there).
public struct TranscriptJumpItem: Sendable, Equatable {
    public var id: UUID
    public var tick: Int
}

public enum TranscriptHistory {
    public static let pageRows = 200
    /// A match further up is loaded in one page at most (the engine's own cap is 2 000 rows).
    static let maxJumpRows = 2000
    /// How long a jump waits for its chat's rows.
    public static let jumpWait: TimeInterval = 15

    /// Pairs the user / assistant rows of a window with the user / assistant items made from them (one item each, in order).
    public static func rowIDs(items: [TranscriptItem], start: Int, chat: [ChatItem]) -> [Int: UUID] {
        var rows: [Int] = []
        for (i, item) in items.enumerated() {
            switch item.kind {
            case .userMessage, .assistantText: rows.append(start + i)
            default: continue
            }
        }
        let ids = chat.compactMap { item -> UUID? in
            switch item {
            case let .user(id, _, _), let .assistant(id, _, _, _): id
            default: nil
            }
        }
        var out: [Int: UUID] = [:]
        for (row, id) in zip(rows, ids) { out[row] = id }
        return out
    }

    /// What a pending jump does now: land on a shown item, load `load` rows above first, or give up (`done`).
    public enum JumpStep: Equatable, Sendable {
        case wait
        case land(UUID)
        case load(Int)
        case done
    }

    public static func step(_ jump: TranscriptJump?, paging: TranscriptPaging, now: Date = Date()) -> JumpStep {
        guard let jump, now.timeIntervalSince(jump.at) <= jumpWait else { return .done }
        // Its chat's rows are still on the way (the shown chat may be one with nothing to page).
        guard let sessionId = paging.sessionId, sessionId == jump.sessionId else { return .wait }
        if let id = paging.rowIDs[jump.row] { return .land(id) }
        if let start = paging.start, jump.row < start, !paging.loading {
            return .load(min(maxJumpRows, max(pageRows, start - jump.row + 1)))
        }
        return paging.loading ? .wait : .done
    }

    /// Review history search: rounds whose request, file paths (old names too), notes or commit subjects contain `query`.
    public static func filter(_ entries: [ReviewHistoryEntry], query: String) -> [ReviewHistoryEntry] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return entries }
        func has(_ s: String?) -> Bool { s?.lowercased().contains(q) ?? false }
        return entries.filter { e in
            has(e.prompt) || e.files.contains { has($0.path) || has($0.oldPath) || has($0.commit?.subject) } || e.notes.contains { has($0.body) }
        }
    }
}
