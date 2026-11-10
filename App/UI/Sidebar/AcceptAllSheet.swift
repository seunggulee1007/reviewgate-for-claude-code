import AppKit
import SwiftUI
import ReviewGateCore

/// r2-review-flow M28: "Accept all" (the list's button, Review › Accept All ⌥⌘⇧A) applies at once with an undo toast — the
/// summary sheet below opens only when a pending file was never looked at, changed since, or is sensitive.
@MainActor
enum AcceptAllAction {
    static func run(store: AppState, model: WindowModel) {
        if store.acceptAllNeedsSheet { model.showAcceptAll = true } else { acceptNow(store: store) }
    }

    /// Accepts every pending file; the toast's 실행 취소 makes them pending again (accepting wrote nothing on disk), as does
    /// Edit › Undo (polish P2-review-23).
    static func acceptNow(store: AppState) {
        guard let paths = store.acceptAllNow() else { return }
        Toast.show(AcceptAllRules.acceptedToast(paths.count),
                   action: Toast.Action(title: AcceptAllRules.undoTitle) { [weak store] in store?.unaccept(paths: paths) })
        ReviewUndo.accepted(paths, store: store, name: String(localized: "Accept all"))
    }
}

/// polish P2-review-23: Edit › Undo (⌘Z, outside a text field) takes a review decision back, as the menu names it
/// ("수락 실행 취소" / "거절 실행 취소"): an accept makes the files pending again (nothing on disk changed); a reject brings the
/// file back while the engine still can — the reject banner's "거절 취소". A reject made while Claude works only waits for
/// the turn's end (M32; its chip offers Accept to keep the file), so it registers nothing.
///
///     ReviewUndo.accept(file, store: store)                          // a button in the key window
///     ReviewUndo.reject(file, store: store, window: entry.window)    // the menu bar acts on its window
@MainActor
enum ReviewUndo {
    static func accept(_ file: ChangedFile, store: AppState, window: NSWindow? = NSApp.keyWindow) {
        let applies = file.state == .pending && !store.isAcceptLocked
        store.accept(file)
        if applies { accepted([file.path], store: store, window: window) }
    }

    static func reject(_ file: ChangedFile, store: AppState, window: NSWindow? = NSApp.keyWindow) {
        let reverts = file.state == .pending && !store.isRejectLocked && !file.uncaptured && !file.rejectScheduled && !store.isRunning
        store.reject(file)
        guard reverts, let undo = undoManager(window) else { return }
        let path = file.path
        undo.registerUndo(withTarget: store) { store in
            MainActor.assumeIsolated {
                guard let offer = store.rejectUndoOffer, offer.path == path else { NSSound.beep(); return }
                if let blocked = offer.blocked { Toast.show(blocked, systemImage: "exclamationmark.triangle.fill"); return }
                store.undoLastReject()
            }
        }
        undo.setActionName(String(localized: "Reject"))
    }

    /// After `paths` were accepted: Undo makes those still accepted pending again.
    static func accepted(_ paths: [String], store: AppState, window: NSWindow? = NSApp.keyWindow, name: String = String(localized: "Accept")) {
        guard !paths.isEmpty, let undo = undoManager(window) else { return }
        undo.registerUndo(withTarget: store) { store in
            MainActor.assumeIsolated { store.unaccept(paths: paths) }
        }
        undo.setActionName(name)
    }

    /// A sheet's undo goes to the window under it.
    private static func undoManager(_ window: NSWindow?) -> UndoManager? { (window?.sheetParent ?? window)?.undoManager }
}

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
                    AcceptAllAction.acceptNow(store: store)   // r2-review-flow M28: with the same undo toast
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
            // polish P2-review-16 / PX-01: the full path and what a click does — on the path, not the whole row (that hid the
            // "sensitive" and "not viewed" tooltips).
            Text(file.path).font(.callout).lineLimit(1).truncationMode(.middle)
                .help(String(localized: "\(file.path) — click to show its diff"))
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
                        .help(String(localized: "Changed with Claude's \(tool) tool"))   // polish P2-review-16
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
