import SwiftUI
import ReviewGateCore

/// wave2 mac-diff — one file's reason as `WhyDisplay` resolved it (PROTOCOL §34.8; audit comp-01, agents-03): the
/// "Claude 보고" tag for the turn-end report, the subagent's chip when the text is a subagent's, the text itself — an
/// earlier sentence of the agent dimmed as "앞선 설명: …" (how far back in its tooltip) — or "원인 기록 없음", and the main
/// agent's delegation sentence on a line of its own ("위임 이유: …"). The diff header and the turn summary card use it.
struct WhyLineView: View {
    let line: WhyLine
    var lineLimit = 2
    /// The text on one line, whitespace collapsed (a summary row).
    var oneLine = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if line.source == .reported {
                    TagChip(Text(verbatim: WhyText.reported), systemImage: "text.quote", tint: .accentColor)
                        .accessibilityIdentifier("Why reported")
                }
                if let agent = line.agent {
                    TagChip(Text(verbatim: agent), systemImage: "person.2.fill", tint: .purple)
                        .help("Made by a subagent")
                }
                reason
            }
            if let delegation = line.delegation {
                Text(verbatim: WhyText.delegated(oneLine ? TurnSummary.oneLine(delegation) ?? delegation : delegation))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(oneLine ? 1 : lineLimit)
                    .truncationMode(.tail)
                    .help(delegation)
                    .accessibilityIdentifier("Why delegated")
            }
        }
    }

    private var text: String {
        (oneLine ? line.oneLine() : line.text) ?? ""
    }

    @ViewBuilder
    private var reason: some View {
        switch line.source {
        case .noRecord:
            Text(verbatim: WhyText.noRecord)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("Why none")
        case .earlier:
            Text(verbatim: WhyText.earlier(text))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(lineLimit)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: !oneLine)
                .helpIfPresent(line.age.map(WhyText.callsEarlier))
                .accessibilityIdentifier("Why earlier")
        case .reported, .direct:
            Text(verbatim: text)
                .font(.caption)
                .foregroundStyle(Color.primary.opacity(0.85))
                .lineLimit(lineLimit)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: !oneLine)
        }
    }
}
