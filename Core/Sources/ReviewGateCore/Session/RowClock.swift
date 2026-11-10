import Foundation

// MARK: polish p-foundation — P3-transcript-25: when each chat row was written, for the time on a message (its tooltip,
// "오후 3:42" before a turn's end line, the day separators). A side table by row id: `ChatItem` keeps its cases as they are
// (every view switches over them). A row that arrives live is stamped when it is appended; a restored row (the chat's
// record, an older page, another chat viewed read-only) with its `TranscriptItem.at`. The Windows client keeps the same
// table (clients/desktop/src/renderer/rowTimes.ts).

/// When each chat row was written, by row id. Rows get their id from `newID` where they are made (`AppState.handle`,
/// `restoreTranscript`, `viewedChatRows`); views read `time(of:)` — nil for a row without one (made before this table, or
/// a record whose time does not read).
@MainActor
public enum RowClock {
    /// A restored time is kept as the engine wrote it and read on first use (thousands of rows come back at once).
    private enum Stamp {
        case date(Date)
        case iso(String)
    }

    /// Rows per generation: the table keeps the last two (at most 2 × this rows, the newest), so it never grows without
    /// end in a window that stays open for weeks. A variable for the tests.
    static var generationSize = 50_000

    private static var current: [UUID: Stamp] = [:]
    private static var previous: [UUID: Stamp] = [:]

    /// A new row id, stamped `date` (now: a row that just arrived).
    public static func newID(at date: Date = Date()) -> UUID {
        let id = UUID()
        stamp(id, at: date)
        return id
    }

    /// A new row id stamped with a restored row's time (`TranscriptItem.at`, ISO-8601 as the engine writes it).
    public static func newID(at iso: String) -> UUID {
        let id = UUID()
        put(id, .iso(iso))
        return id
    }

    public static func stamp(_ id: UUID, at date: Date) {
        put(id, .date(date))
    }

    /// When row `id` was written; nil when it has no time.
    public static func time(of id: UUID) -> Date? {
        switch current[id] ?? previous[id] {
        case .date(let date)?:
            return date
        case .iso(let text)?:
            guard let date = isoDate(text) else { return nil }
            put(id, .date(date))
            return date
        case nil:
            return nil
        }
    }

    private static func put(_ id: UUID, _ stamp: Stamp) {
        if current[id] == nil, current.count >= generationSize {
            previous = current
            current = [:]
        }
        current[id] = stamp
    }

    #if DEBUG
    /// Tests: an empty table.
    static func reset() {
        current = [:]
        previous = [:]
    }
    #endif
}
