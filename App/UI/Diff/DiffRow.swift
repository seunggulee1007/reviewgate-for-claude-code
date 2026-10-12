import SwiftUI
import ReviewGateCore

/// One line of a unified diff: two line-number gutters, a +/− marker and the monospaced text.
/// The code column takes an optional pre-highlighted `AttributedString` (computed off-main by
/// `SyntaxHighlighter`); until it arrives the row renders plain `Text` so 20k-line lists stay smooth.
/// wave2 mac-diff: the line wraps or scrolls sideways with the list (`DiffCodeLayout`), the changed parts of a paired
/// line are marked (`DiffLine.segments`), a whitespace-only change is faint, and find-in-diff matches are marked.
struct DiffRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let line: DiffLine
    var highlighted: AttributedString? = nil
    // MARK: wave2 mac-diff
    /// Find in diff: the query whose matches are marked ("" = none) and whether this row is the current match.
    var findQuery = ""
    var isCurrentMatch = false
    /// Part of the lines picked for copying (`DiffLineSelection`): drawn tinted.
    var selected = false

    static let font = Font.system(.body, design: .monospaced)
    static let gutterWidth: CGFloat = 44
    /// A picked line's tint, under the line's own.
    static let selectionFill = Color.accentColor.opacity(0.24)

    var body: some View {
        rowContent
            // MARK: wave4d w4d-speed — polish-10: one VoiceOver element per line, "Added line 42: …" (the numbers, the
            // sign and the code were read apart, and nothing said whether the line was added, removed or unchanged).
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: ReviewSpeech.line(line)))
    }

    @ViewBuilder
    private var rowContent: some View {
        if line.kind == .hunkHeader {
            Text(line.text)
                .font(Self.font)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.blue.wash(colorScheme, light: 0.08, dark: 0.16))
                .help(line.text)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                gutter(line.oldNo)
                gutter(line.newNo)
                Text(marker)
                    .font(Self.font)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                DiffCodeText(text: line.text, styled: styled, faint: line.wsOnly)
                    .font(Self.font)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background)
            .background(selected ? Self.selectionFill : Color.clear)
        }
    }

    /// The drawn text: the highlighter's colours (or plain), the changed parts and the find matches marked.
    private var styled: AttributedString {
        let find = findQuery.isEmpty ? [] : DiffFind.ranges(of: findQuery, in: DiffLineText.shown(line.text).text)
        return DiffLineText.styled(line, base: highlighted, emphasis: emphasis, find: find,
                                   findColor: Color.yellow.opacity(isCurrentMatch ? 0.85 : 0.45))
    }

    private var marker: String {
        switch line.kind {
        case .add: "+"
        case .del: "−"
        case .context, .hunkHeader: " "
        }
    }

    /// `Color.green` / `.red` resolve far brighter in dark appearance, so the same alpha lands heavier
    /// there: dark asks for *less* of it, or the wash swamps the syntax colours drawn on top.
    private var background: Color {
        switch line.kind {
        case .add: Color.green.wash(colorScheme, light: 0.15, dark: 0.14)
        case .del: Color.red.wash(colorScheme, light: 0.15, dark: 0.14)
        case .context, .hunkHeader: Color.clear
        }
    }

    /// The changed parts of a paired line, over the row's own tint (§34.7).
    private var emphasis: Color? {
        switch line.kind {
        case .add: Color.green.wash(colorScheme, light: 0.32, dark: 0.36)
        case .del: Color.red.wash(colorScheme, light: 0.30, dark: 0.36)
        case .context, .hunkHeader: nil
        }
    }

    private func gutter(_ number: Int?) -> some View {
        Text(number.map(String.init) ?? "")
            .font(Self.font)
            .foregroundStyle(.secondary)
            .frame(width: Self.gutterWidth, alignment: .trailing)
            .padding(.trailing, 6)
    }

    /// Per-line highlight of a diff for `path`, indexed like `FileDiff.allLines` (i.e. by `DiffLine.id`).
    /// Runs on the `SyntaxHighlighter` actor; callers keep rendering plain text until it returns.
    static func highlight(_ lines: [DiffLine], path: String, dark: Bool) async -> [AttributedString] {
        let language = await SyntaxHighlighter.shared.language(forPath: path)
        return await SyntaxHighlighter.shared.highlightLines(lines.map(\.text), language: language, dark: dark)
    }
}
