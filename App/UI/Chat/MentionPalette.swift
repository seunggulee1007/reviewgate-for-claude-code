import SwiftUI
import ReviewGateCore

/// One row of the @-mention popover.
enum MentionEntry: Identifiable, Hashable {
    /// "@변경된 파일": every file of the current review at once.
    case changedFiles(count: Int)
    case item(FileItem)

    var id: String {
        switch self {
        case .changedFiles: "@changed"
        case let .item(item): item.path
        }
    }
}

/// The fuzzy file list `@` opens above the composer (`list_files`, §23): ↑ ↓ to move, ↩ / ⇥ to pick, ⎋ to close.
struct MentionPalette: View {
    @Environment(\.colorScheme) private var colorScheme
    let query: String
    let entries: [MentionEntry]
    let selection: Int
    let isLoading: Bool
    /// polish P4-composer-22: why the file list could not be read (nil: it answered).
    var error: String? = nil
    var onPick: (MentionEntry) -> Void
    /// polish P4-composer-21: the pointer moves the selection, as ↑ / ↓ do.
    var onHover: (Int) -> Void = { _ in }
    /// polish P4-composer-22: "다시 시도" after a failed list.
    var onRetry: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "at").foregroundStyle(.secondary)
                Text(query.isEmpty ? String(localized: "Mention a file or folder") : String(localized: "Files matching “\(query)”"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                if isLoading { ProgressView().controlSize(.mini) }
                Text("↑↓ move · ↩/⇥ add · esc close").font(.caption2).foregroundStyle(.secondary)   // polish P4-composer-21
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            Divider()
            if entries.isEmpty, let error, !isLoading {
                // polish P4-composer-22: the list could not be read — said, with a retry (not "no matching files").
                HStack(spacing: 8) {
                    Label(String(localized: "Could not list files: \(error)"), systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.orange)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Button("Retry", action: onRetry)
                        .controlSize(.small)
                        .help("Load the file list again")
                }
                .padding(10)
                .accessibilityIdentifier("Mention list error")
            } else if entries.isEmpty {
                Text(isLoading ? String(localized: "Searching…") : String(localized: "No matching files"))
                    .font(.callout).foregroundStyle(.secondary)
                    .padding(10)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                                row(entry, selected: index == selection)
                                    .id(entry.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture { onPick(entry) }
                                    // polish P4-composer-21: the pointer selects; a button to VoiceOver (the whole path: the
                                    // row's name, below).
                                    .onHover { if $0 { onHover(index) } }
                                    .accessibilityAddTraits(.isButton)
                                    .accessibilityAction { onPick(entry) }
                            }
                        }
                        .padding(4)
                    }
                    .frame(maxHeight: 264)
                    .fixedSize(horizontal: false, vertical: true)
                    .onChange(of: selection) { _, new in
                        if entries.indices.contains(new) { proxy.scrollTo(entries[new].id) }
                    }
                }
            }
        }
        .frame(width: 400)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.white.opacity(colorScheme == .dark ? 0.1 : 0.0)))
        .shadow(color: .black.opacity(0.35), radius: 14, y: 4)
        .padding(12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Mention popover")
    }

    private func help(_ entry: MentionEntry) -> String {
        switch entry {
        case let .changedFiles(count): String(localized: "Mention all \(count) files of the current review")
        case let .item(item): item.path + (item.isDirectory ? "/" : "")
        }
    }

    @ViewBuilder
    private func row(_ entry: MentionEntry, selected: Bool) -> some View {
        HStack(spacing: 8) {
            switch entry {
            case let .changedFiles(count):
                Image(systemName: "checklist").foregroundStyle(.orange).frame(width: 16)
                HStack(spacing: 8) {
                    Text("@Changed files").fontWeight(.medium)
                    Text("\(count) files in the current review").font(.caption).foregroundStyle(.secondary)
                }
                .help(help(entry))   // polish P4-composer-21
                Spacer()
            case let .item(item):
                Image(systemName: item.isDirectory ? "folder.fill" : "doc.text")
                    .foregroundStyle(item.isDirectory ? Color.accentColor : .secondary)
                    .frame(width: 16)
                let name = ComposerMentions.displayName(item.path) + (item.isDirectory ? "/" : "")
                HStack(spacing: 8) {
                    Text(verbatim: name).fontWeight(.medium).lineLimit(1)
                    let parent = (item.path as NSString).deletingLastPathComponent
                    if !parent.isEmpty {
                        Text(verbatim: parent + "/").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                    }
                }
                // polish P4-composer-21: the whole path (its folder is cut at the head) — on the name, not the row, whose tooltip
                // would hide "Changed"'s own.
                .help(help(entry))
                Spacer(minLength: 4)
                if item.changed {
                    Text("Changed")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.orange.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
                        .foregroundStyle(.orange)
                        .help("In the current review")
                }
            }
        }
        .font(.callout)
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(selected ? Color.accentColor.wash(colorScheme, light: 0.18, dark: 0.32) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
