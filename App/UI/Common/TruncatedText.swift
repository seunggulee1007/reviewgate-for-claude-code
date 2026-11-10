import SwiftUI

// MARK: polish p-foundation — PX-10: a value cut to one line (a path, a branch, a command) shows all of it on hover.
//
//   TruncatedText(file.path)                     // middle-cut: the folder's start and the file name stay
//   TruncatedText(branch, mode: .tail).font(.caption)
//
// Put no `.help` on a row around it: the outer one hides this one (and every tooltip inside the row).

/// `value` on one line, cut in the middle (or where `mode` says), with the whole value as its tooltip. Verbatim: a value
/// is never looked up as a localization key.
struct TruncatedText: View {
    let value: String
    var mode: Text.TruncationMode = .middle

    init(_ value: String, mode: Text.TruncationMode = .middle) {
        self.value = value
        self.mode = mode
    }

    var body: some View {
        Text(verbatim: value)
            .lineLimit(1)
            .truncationMode(mode)
            .help(value)
    }
}
