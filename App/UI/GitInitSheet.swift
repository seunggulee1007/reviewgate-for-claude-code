import SwiftUI
import ReviewGateCore

/// The opened folder is not a git repository (`state.gitInit`): track it without git (§59, the recommended way — the
/// folder is left as it is), initialize git in it, open one of the repositories inside it, or choose another folder.
struct GitInitSheet: View {
    @Environment(AppState.self) private var store
    @State private var confirmUnsafeInit = false
    @State private var confirmUnsafeTrack = false
    /// `track_without_git` is taking the folder's first snapshot (a large folder takes a while).
    @State private var tracking = false

    private var path: String { store.projectURL?.path ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("This folder is not a git repository", systemImage: "exclamationmark.triangle")
                .font(.headline)
            Text(verbatim: path)
                .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            Text("Track without git: ReviewGate keeps a hidden copy outside this folder to show what Claude changed. The folder itself is not touched; commit, branches, workbenches and PRs are off.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("Track without git explanation")
            if tracking {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Taking a snapshot of the folder…").font(.callout).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("Track without git progress")
            } else if let problem = store.gitInitProblem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("Track without git problem")
            }

            if !store.gitCandidates.isEmpty {
                Text("Git repositories inside this folder:").font(.subheadline.weight(.medium))
                List(store.gitCandidates, id: \.self) { url in
                    Button {
                        ProjectOpener.open(url, store: store)
                    } label: {
                        Label(url.lastPathComponent, systemImage: "folder.badge.gearshape")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(tracking)
                    .help(url.path)
                    .accessibilityIdentifier("Git candidate \(url.lastPathComponent)")
                }
                .listStyle(.bordered)
                .frame(minHeight: 120, maxHeight: 240)
                .accessibilityIdentifier("Git candidates")
            }

            HStack {
                Button("Initialize git here", role: .destructive) {
                    if store.gitInitLooksUnsafe {
                        confirmUnsafeInit = true
                    } else {
                        Task { await store.initRepository() }
                    }
                }
                .disabled(tracking)
                .help(tracking ? String(localized: "Wait for the snapshot to finish")
                      : String(localized: "Makes this folder a git repository (git init) — commit, branches, workbenches and PRs work as usual"))
                .accessibilityIdentifier("Initialize git")
                Spacer()
                Button("Choose another folder…") {
                    store.cancelGitInit()
                    ProjectOpener.choose(store: store)
                }
                .disabled(tracking)
                .help(tracking ? String(localized: "Wait for the snapshot to finish") : String(localized: "Open another folder instead"))
                .accessibilityIdentifier("Choose another folder")
                Button("Cancel", role: .cancel) { store.cancelGitInit() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(tracking)
                    .help(tracking ? String(localized: "Wait for the snapshot to finish") : String(localized: "Close this folder"))
                    .accessibilityIdentifier("Cancel git init")
                Button("Track without git") {
                    if store.gitInitLooksUnsafe { confirmUnsafeTrack = true } else { track(confirm: false) }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(tracking)
                .help(tracking ? String(localized: "Wait for the snapshot to finish")
                      : String(localized: "Recommended: review this folder as it is — ReviewGate keeps a hidden copy outside it; the folder gets no .git"))
                .accessibilityIdentifier("Track without git")
            }
        }
        .padding(20)
        .frame(width: 580)
        .alert("Initialize git in this folder?", isPresented: $confirmUnsafeInit) {
            Button("Initialize anyway", role: .destructive) { Task { await store.initRepository() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This looks like a large or personal folder (\(path)). Initializing git here is probably a mistake.")
        }
        .background {
            // A second alert of its own view: one view's alerts may shadow each other.
            Color.clear
                .alert("Track this folder without git?", isPresented: $confirmUnsafeTrack) {
                    Button("Track anyway") { track(confirm: true) }
                        .accessibilityIdentifier("Track anyway")
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This looks like a large or personal folder (\(path)). ReviewGate would keep a hidden copy of everything in it, which can take a while and use a lot of disk space.")
                }
        }
    }

    /// `track_without_git`: on success the prompt goes away (`gitInit` is cleared); `folder_unsafe` asks first; any other
    /// refusal stays here as `gitInitProblem`.
    private func track(confirm: Bool) {
        tracking = true
        Task {
            let outcome = await store.trackWithoutGit(confirm: confirm)
            tracking = false
            if outcome == .needsConfirm { confirmUnsafeTrack = true }
        }
    }
}
