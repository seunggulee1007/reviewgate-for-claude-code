import SwiftUI

// MARK: polish p-foundation — P3-transcript-18: the chat's ⌘F match handed down to text drawn deep inside a row (a
// finished answer's markdown, a tool's output, an agent's report), so it can mark the matched words itself instead of
// only the row getting a yellow frame.
//
//   row.environment(\.transcriptFindMatch, match)        // the row that matches (TranscriptRows)
//   @Environment(\.transcriptFindMatch) private var match // the text view that draws the words

extension EnvironmentValues {
    /// The find bar's query and whether this row holds the current match; nil when the row does not match.
    @Entry var transcriptFindMatch: RowMatch? = nil
}
