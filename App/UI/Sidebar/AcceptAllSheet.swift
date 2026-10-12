import SwiftUI
import ReviewGateCore

/// "Accept all" summary (audit 1.9): every pending file with its line counts and tool badges, a "sensitive" marker
/// for agent config / workflow / env files, and how many files were never opened in this turn — then Confirm → `accept_all`.
struct AcceptAllSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss

    private var files: [ChangedFile] { store.pendingFiles }
    /// wave2 mac-flow (§34.5): by content — a file that changed after it was viewed is not "viewed".
    /// wave3 check-clients: counted once — "not yet viewed" are the files never opened, "changed since viewed" the others
    /// (before, a viewed-then-changed file was in both numbers; Electron counts them apart).
    private var unviewed: Int { store.neverViewedPendingFiles.count }
    private var changedSinceViewed: Int { store.changedSinceViewedPendingFiles.count }
    private var sensitive: Int { files.filter { AppState.isSensitivePath($0.path) }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Accept all pending files?").font(.headline)
            Text("Accepting keeps every change on disk and closes the review for these files. Claude is told what was accepted.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            List(files) { file in
                // A row opens its diff (the sheet closes): the summary is where a file still to look at shows up.
                Button { show(file) } label: { row(file) }
                    .buttonStyle(.plain)
                    .help("Show this diff")
            }
            .listStyle(.bordered)
            .frame(minHeight: 140, maxHeight: 320)
            .accessibilityIdentifier("Accept all files")

            HStack(spacing: 12) {
                Text("\(files.count) file(s) · +\(files.reduce(0) { $0 + $1.added }) −\(files.reduce(0) { $0 + $1.deleted })")
                    .font(.caption).foregroundStyle(.secondary)
                if unviewed > 0 {
                    Label("\(unviewed) file(s) not yet viewed", systemImage: "eye.slash")
                        .font(.caption.weight(.medium)).foregroundStyle(.orange)
                        .accessibilityIdentifier("Accept all unviewed")
                    Button("Review unviewed first") { if let first = store.neverViewedPendingFiles.first { show(first) } }
                        .buttonStyle(.link)
                        .font(.caption)
                        .accessibilityIdentifier("Accept all review unviewed")
                }
                if changedSinceViewed > 0 {
                    Label("\(changedSinceViewed) changed since viewed", systemImage: "eye.trianglebadge.exclamationmark")
                        .font(.caption.weight(.medium)).foregroundStyle(.blue)
                        .accessibilityIdentifier("Accept all changed since viewed")
                }
                if sensitive > 0 {
                    Label("\(sensitive) sensitive file(s)", systemImage: "exclamationmark.shield")
                        .font(.caption.weight(.medium)).foregroundStyle(.orange)
                        .accessibilityIdentifier("Accept all sensitive")
                }
                Spacer()
            }
            if store.isRunning, !store.isAcceptLocked {
                // wave3 check-clients (§34.2, as Electron): accepting while Claude works is not final for a file the turn changes.
                Text("Claude is still working: a file this turn changes again comes back as pending (Changed after accept).")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("Accept all during turn")
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("Accept all cancel")
                Button("Accept all") {
                    store.acceptAll()
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(files.isEmpty || store.isAcceptLocked)   // wave2 mac-flow: also during a turn (§34.2)
                .accessibilityIdentifier("Accept all confirm")
            }
            if let reason = store.acceptLockReason {
                // wave2 mac-flow: a blocked confirm says why (a collection or a revert in flight).
                Text(verbatim: reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityIdentifier("Accept all locked reason")
            }
        }
        .padding(20)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Accept all sheet")
    }

    /// Closes the sheet on `file`'s diff (the list selects it; the diff pane opens for it).
    private func show(_ file: ChangedFile) {
        dismiss()
        store.selectFile(path: file.path)
    }

    private func row(_ file: ChangedFile) -> some View {
        let viewed = store.isViewed(file)
        let isSensitive = AppState.isSensitivePath(file.path)
        return HStack(spacing: 6) {
            Text(file.status.rawValue)
                .font(.caption.weight(.bold).monospaced())
                .foregroundStyle(.secondary)
                .frame(width: 14)
            Text(file.path).font(.callout).lineLimit(1).truncationMode(.middle)
            if isSensitive {
                Text("sensitive")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.orange.wash(colorScheme, light: 0.20, dark: 0.28), in: Capsule())
                    .foregroundStyle(.orange)
                    .help("Agent configuration, workflow or environment file — check it before accepting")
                    .accessibilityIdentifier("Sensitive \(file.path)")
            }
            if store.changedSinceViewed(file) {
                ChangedSinceViewedChip()
            } else if !viewed {
                Image(systemName: "eye.slash").font(.caption2).foregroundStyle(.orange)
                    .help("Not viewed in this turn")
                    .accessibilityLabel("Not viewed")
            }
            Spacer(minLength: 4)
            // §31 (M2): who changed it comes from `origin` — no tools is not "Bash", it is a change from outside the app.
            ForEach(file.risk, id: \.self) { ModsRiskChip(risk: $0) }
            if file.isExternal {
                ExternalChip()
            } else {
                ForEach(file.tools, id: \.self) { tool in
                    Text(tool)
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.accentColor.wash(colorScheme, light: 0.15, dark: 0.25), in: Capsule())
                }
            }
            Text("+\(file.added)").font(.caption.monospacedDigit()).foregroundStyle(.green)
            Text("−\(file.deleted)").font(.caption.monospacedDigit()).foregroundStyle(.red)
        }
        .contentShape(Rectangle())   // the whole row opens the diff, not only its words
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Accept all row \(file.path)")
    }
}
