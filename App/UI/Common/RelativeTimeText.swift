import SwiftUI

// MARK: polish p-foundation — PX-21: "3분 전" keeps up while the window stays open (worked out again every 30 s —
// `Text(date, format: .relative(…))` alone is computed once and then stands still), and the exact time shows on hover
// ("2026. 11. 6. 오후 3:42").
//
//   RelativeTimeText(pr.updatedAt)
//   RelativeTimeText(entry.date).font(.caption).foregroundStyle(.secondary)

/// `date` relative to now ("지금", "3분 전", "어제"), refreshed every 30 s, with the date and time as its tooltip.
struct RelativeTimeText: View {
    let date: Date

    init(_ date: Date) {
        self.date = date
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(verbatim: Self.relative(date, now: context.date))
        }
        .help(Self.absolute(date))
    }

    @MainActor private static let formatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .named
        formatter.unitsStyle = .full
        return formatter
    }()

    /// "3분 전" from `now` — named ("어제", "지금") where the language has a word for it.
    @MainActor static func relative(_ date: Date, now: Date = .now) -> String {
        formatter.localizedString(for: date, relativeTo: now)
    }

    /// The tooltip: "2026. 11. 6. 오후 3:42".
    static func absolute(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }
}
