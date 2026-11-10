import SwiftUI
import ReviewGateCore

// MARK: wave4c w4c-commit
// docs/PROTOCOL.md §41.1 on the Mac (as on Electron): the commit sheet's "팀 형식: …" line with [형식 바꾸기], the learned
// format offered in the template editor, and the PR sheet's metadata fields. An engine without §41.1 shows none of the
// format lines (its `commit_format` is refused) and ignores the metadata.

/// "팀 형식: PAY-1800: {title} - {summary}" (+ "(최근 커밋에서 배움)") and [형식 바꾸기].
struct TeamFormatLineView: View {
    @Environment(AppState.self) private var store
    let template: String
    let reply: CommitFormatReply?
    let onChange: () -> Void

    var body: some View {
        if let line = TeamFormat.line(template: template, branch: store.projectInfo?.branch, reply: reply) {
            HStack(spacing: 6) {
                Text("Team format:").foregroundStyle(.secondary)
                Text(verbatim: line.text)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(line.text)
                if line.learned {
                    Text("(learned from recent commits)").foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
                Button("Change format", action: onChange)
                    .buttonStyle(.link)
                    .controlSize(.small)
                    .accessibilityIdentifier("Change team format")
            }
            .font(.caption)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("Team format")
        }
    }
}

/// In the template editor: the learned format and [이 형식 쓰기] (when it is not what is typed).
struct LearnedFormatRow: View {
    let template: String
    let reply: CommitFormatReply?
    let onUse: (String) -> Void

    var body: some View {
        if let learned = TeamFormat.suggestion(template: template, reply: reply) {
            HStack(spacing: 6) {
                Text("Learned from recent commits:").foregroundStyle(.secondary)
                Text(verbatim: learned)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help((reply?.examples ?? []).joined(separator: "\n"))
                Spacer(minLength: 4)
                Button("Use this format") { onUse(learned) }
                    .buttonStyle(.link)
                    .controlSize(.small)
                    .accessibilityIdentifier("Use learned format")
            }
            .font(.caption)
            .accessibilityIdentifier("Learned format")
        }
    }
}

/// The PR sheet's assignees / labels / reviewers / projects (comma-separated; kept per repository after a create).
struct PRMetaFields: View {
    @Binding var meta: PRMetaText

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            field("Assignees", text: $meta.assignees, prompt: "@me", id: "PR assignees")
            field("Labels", text: $meta.labels, prompt: String(localized: "comma-separated"), id: "PR labels")
            field("Reviewers", text: $meta.reviewers, prompt: String(localized: "comma-separated"), id: "PR reviewers")
            field("Projects", text: $meta.projects, prompt: String(localized: "comma-separated"), id: "PR projects")
        }
    }

    /// §51: the field's name on the left — outside a Form a macOS text field shows only its placeholder.
    private func field(_ label: LocalizedStringKey, text: Binding<String>, prompt: String, id: String) -> some View {
        PRSheetRow(label) {
            TextField(label, text: text, prompt: Text(verbatim: prompt))
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier(id)
        }
    }
}

/// §51: the PR sheet's title and description, as Claude's fill found them (for "Restore what I had").
struct PRSheetText: Equatable {
    var title: String
    var body: String
}

/// §51: one row of the PR sheet — its name in a fixed column on the left (a placeholder is an example, not a name).
struct PRSheetRow<Content: View>: View {
    let label: LocalizedStringKey
    var alignment: VerticalAlignment = .firstTextBaseline
    @ViewBuilder let content: () -> Content

    init(_ label: LocalizedStringKey, alignment: VerticalAlignment = .firstTextBaseline, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.alignment = alignment
        self.content = content
    }

    var body: some View {
        HStack(alignment: alignment, spacing: 8) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 76, alignment: .trailing)
                .padding(.top, alignment == .top ? 4 : 0)
                .accessibilityHidden(true)
            content()
        }
    }
}
