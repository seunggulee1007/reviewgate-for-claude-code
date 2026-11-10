import SwiftUI
import ReviewGateCore

/// wave2 mac-diff — the folded mini diff under a chat Edit / MultiEdit / Write row (PROTOCOL §34.6; audit comp-03,
/// market-13): "+N −M" that opens the lines Claude replaced and wrote (`ToolEditPreview`, from `tool_use.input`), so a
/// change reads in the chat while the turn still runs — long before the review lists the file.
struct ToolEditPreviewView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(TranscriptViewState.self) private var view
    /// The tool row's id: open / closed is the chat column's (`TranscriptViewState.editPreviewExpansion`).
    let rowID: UUID
    let preview: ToolEditPreview
    /// The file's path while it is in the review: "N more lines" then opens its diff (`onOpen`), as the row's title does.
    var openPath: String?
    var onOpen: () -> Void = {}

    private var expanded: Bool { view.editPreviewExpansion[rowID] ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Button {
                let open = !expanded
                withAnimation(.easeInOut(duration: 0.12)) { view.editPreviewExpansion[rowID] = open }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 10)
                        .foregroundStyle(.secondary)
                    Text(verbatim: "+\(preview.added)").foregroundStyle(.green)
                    Text(verbatim: "−\(preview.removed)").foregroundStyle(.red)
                }
                .font(.caption.monospacedDigit())
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(expanded ? "Collapse" : "Expand")
            .accessibilityLabel(expanded ? "Collapse" : "Expand")
            .accessibilityIdentifier("Tool row mini diff toggle")
            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(preview.diffLines) { line in
                        if line.kind == .hunkHeader {
                            Divider().padding(.vertical, 2)
                        } else {
                            MiniDiffRow(line: line)
                        }
                    }
                    if preview.hiddenLines > 0 {
                        if let openPath {
                            Button("\(preview.hiddenLines) more lines", action: onOpen)
                                .buttonStyle(.link)
                                .font(.caption2)
                                .padding(.leading, 16).padding(.top, 2)
                                .help(String(localized: "Show the diff of \(openPath)"))
                                .accessibilityIdentifier("Tool row mini diff more")
                        } else {
                            Text("\(preview.hiddenLines) more lines")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .padding(.leading, 16).padding(.top, 2)
                        }
                    }
                }
                .padding(4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.panelFill(colorScheme), in: RoundedRectangle(cornerRadius: 6))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("Tool row mini diff")
            }
        }
        .padding(.leading, 22)
    }
}

/// One line of a mini diff: marker, tint, the changed part of a pair marked; one line each, the whole in a tooltip.
private struct MiniDiffRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let line: DiffLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(verbatim: marker)
                .foregroundStyle(.secondary)
                .frame(width: 14)
            Text(DiffLineText.styled(line, base: nil, emphasis: emphasis, find: [], findColor: nil))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .font(.caption.monospaced())
        .padding(.vertical, 0.5)
        .background(background)
        .help(DiffLineText.tooltip(line.text))
    }

    private var marker: String {
        switch line.kind {
        case .add: "+"
        case .del: "−"
        case .context, .hunkHeader: " "
        }
    }

    private var background: Color {
        switch line.kind {
        case .add: Color.green.wash(colorScheme, light: 0.15, dark: 0.14)
        case .del: Color.red.wash(colorScheme, light: 0.15, dark: 0.14)
        case .context, .hunkHeader: Color.clear
        }
    }

    private var emphasis: Color? {
        switch line.kind {
        case .add: Color.green.wash(colorScheme, light: 0.32, dark: 0.36)
        case .del: Color.red.wash(colorScheme, light: 0.30, dark: 0.36)
        case .context, .hunkHeader: nil
        }
    }
}
