import SwiftUI
import ReviewGateCore

// MARK: wave3 mac-session
/// §36.5: the floating list above the composer — each command with its dimmed argument hint and a one-line description,
/// grouped by where it comes from (recently used first), the selected row highlighted; "Starting session…" while the CLI
/// starts.
struct SlashCommandPalette: View {
    @Environment(\.colorScheme) private var colorScheme
    let sections: [SlashCommandSection]
    let selection: Int
    /// Why nothing is listed; nil when there is something.
    let emptyState: SlashPaletteEmptyState?
    /// The entries come from a cache (an earlier session's) until this session's arrive.
    let cached: Bool
    /// The CLI has not answered initialize yet.
    let starting: Bool
    let onPick: (SlashCommandEntry) -> Void

    /// Rows with their index in the flattened order (what ↑ / ↓ and `selection` count).
    private var indexed: [(section: SlashCommandSection, rows: [(index: Int, entry: SlashCommandEntry)])] {
        var next = 0
        return sections.map { section in
            let rows = section.entries.map { entry in
                defer { next += 1 }
                return (index: next, entry: entry)
            }
            return (section: section, rows: rows)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let emptyState {
                HStack(spacing: 6) {
                    if emptyState == .starting { ProgressView().controlSize(.small) }
                    Text(verbatim: emptyState.text)
                }
                .font(.callout).foregroundStyle(.secondary)
                .padding(10)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(emptyState == .starting ? "Slash palette starting" : "Slash palette empty")
            } else {
                list
                Divider()
                footer
            }
        }
        .frame(maxWidth: 460, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.50 : 0.18), radius: 8, y: 2)
        .padding(12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Slash palette")
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(indexed, id: \.section.id) { group in
                        Section {
                            ForEach(group.rows, id: \.entry.id) { row in
                                SlashCommandRow(entry: row.entry, selected: row.index == selection) { onPick(row.entry) }
                                    .id(row.index)
                            }
                        } header: {
                            if let title = headerTitle(group.section) {
                                Text(verbatim: title)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 3)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(.regularMaterial)
                                    .accessibilityAddTraits(.isHeader)
                            }
                        }
                    }
                }
                .padding(4)
            }
            .frame(maxHeight: 300)
            .onChange(of: selection, initial: true) { _, index in proxy.scrollTo(index) }
        }
    }

    /// No header for ranked matches or a lone unknown-source group (an engine before §36: names only).
    private func headerTitle(_ section: SlashCommandSection) -> String? {
        if section.group == .other, sections.count == 1 { return nil }
        return section.group.title
    }

    private var footer: some View {
        HStack(spacing: 4) {
            Text("↑↓ select · ↩/⇥ insert · esc close")
            if cached { Text("(cached)").accessibilityIdentifier("Slash palette cached") }
            if starting {
                Text(verbatim: "· " + SlashPaletteEmptyState.starting.text).accessibilityIdentifier("Slash palette starting footer")
            }
        }
        .font(.caption2).foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal, 10).padding(.vertical, 4)
    }
}

/// `/name <hint>` with a "skill" capsule, and the description below it.
private struct SlashCommandRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let entry: SlashCommandEntry
    let selected: Bool
    let onPick: () -> Void

    var body: some View {
        Button(action: onPick) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: "/" + entry.name)
                        .font(.callout.monospaced())
                        .lineLimit(1).truncationMode(.middle)
                        .layoutPriority(1)
                    if !entry.argumentHint.isEmpty {
                        Text(verbatim: entry.argumentHint)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.tail)
                    }
                    if entry.isSkill {
                        Text("skill")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.28), in: Capsule())
                    }
                    Spacer(minLength: 0)
                }
                if !entry.description.isEmpty {
                    Text(verbatim: entry.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(selected ? Color.accentColor.wash(colorScheme, light: 0.22, dark: 0.32) : .clear,
                        in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .help(entry.description.isEmpty ? "/" + entry.name : entry.description)
        .accessibilityLabel(Text(verbatim: ["/" + entry.name, entry.argumentHint, entry.description].filter { !$0.isEmpty }.joined(separator: ", ")))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("Slash \(entry.name)")
    }
}
