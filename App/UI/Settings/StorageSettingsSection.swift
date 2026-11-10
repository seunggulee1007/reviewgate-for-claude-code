import SwiftUI
import ReviewGateCore

// MARK: wave4b w4b-bigturn
/// Settings › General › "Disk space" (docs/PROTOCOL.md §39.1, robustness-11 ① ④): the large-file limit (untracked files
/// from this size are stubs in snapshots; live for every open window) and [오래된 리뷰 기록 정리] — counts first, says how
/// many rounds / checkpoints go and about how much space comes back, and removes only after the confirmation. The open
/// review and the newest 20 stay; only the app's own refs are deleted (never a branch, tag or stash).
struct StorageSettingsSection: View {
    @Environment(AppState.self) private var store
    @AppStorage(AppSettings.largeFileMBKey) private var largeFileMB = AppSettings.defaultLargeFileMB
    @State private var plan: HistoryCleanupReply?
    @State private var confirming = false
    @State private var working = false
    @State private var outcome: String?

    var body: some View {
        Section("Disk space") {
            Stepper(value: $largeFileMB, in: AppSettings.largeFileMBRange, step: 10) {
                LabeledContent("Leave untracked files out of snapshots from") {
                    Text(verbatim: "\(largeFileMB) MB").monospacedDigit()
                }
            }
            .accessibilityIdentifier("Large file limit")
            Text("Such a file (a heap dump, an archive) stays in the review list but its content is not stored: it cannot be reverted and the app does not commit it. Files git tracks are always stored.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Clean Up Old Review History…") { count() }
                    .disabled(store.projectURL == nil || working || store.isRunning)
                    .accessibilityIdentifier("Clean up review history")
                if working { ProgressView().controlSize(.small) }
            }
            if store.projectURL == nil {
                Text("Open a project to clean up its review history.").font(.caption).foregroundStyle(.secondary)
            } else if store.isRunning {
                Text("Claude is working — clean up after the turn ends.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Keeps the open review and the newest \(AppSettings.defaultCleanupKeep) review rounds and checkpoints per chat of this project; removes only what the app pinned (never your branches, tags or stash).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let outcome {
                Text(verbatim: outcome).font(.caption).accessibilityIdentifier("Clean up outcome")
            }
        }
        .onChange(of: largeFileMB) { _, _ in for s in WorkbenchRegistry.shared.allStores { s.pushLargeFileMB() } }
        .confirmationDialog("Clean up old review history?", isPresented: $confirming, titleVisibility: .visible, presenting: plan) { _ in
            Button("Clean Up", role: .destructive) { apply() }
                .accessibilityIdentifier("Clean up confirm")
            Button("Cancel", role: .cancel) {}
        } message: { plan in
            Text(verbatim: StorageText.cleanupConfirm(plan))
        }
    }

    private func count() {
        working = true
        outcome = nil
        Task {
            defer { working = false }
            do {
                let reply = try await store.historyCleanup(apply: false)
                if reply.isEmpty {
                    outcome = StorageText.cleanupNothing(reply)
                } else {
                    plan = reply
                    confirming = true
                }
            } catch {
                outcome = error.localizedDescription
            }
        }
    }

    private func apply() {
        working = true
        Task {
            defer { working = false }
            do {
                outcome = StorageText.cleanupDone(try await store.historyCleanup(apply: true))
            } catch {
                outcome = error.localizedDescription
            }
        }
    }
}
