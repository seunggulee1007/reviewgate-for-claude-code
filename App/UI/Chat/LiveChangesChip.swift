import SwiftUI
import ReviewGateCore

/// wave2 mac-flow — §34.6 (comp-03): the HUD's "진행 중: 파일 N개 · +A −D" while a turn runs and has changed files; a
/// click lists them (read-only) and a file opens its live diff in the diff pane.
/// wave3 check-clients: shown from `hud.turnFiles` on, as in Electron — the +/− once a `live_changes` list has every file
/// (before, the chip waited for a list with files, and stayed away when the first one came back empty).
struct LiveChangesChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @State private var showList = false

    var body: some View {
        if let chip = store.liveChip {
            Button {
                showList.toggle()
                if showList { Task { await store.refreshLiveChanges() } }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "hammer")
                    ViewThatFits(in: .horizontal) {
                        Text(verbatim: chip.text).fixedSize()
                        Text(verbatim: String(chip.files)).fixedSize()
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Color.orange.wash(colorScheme, light: 0.13, dark: 0.22), in: Capsule())
                .foregroundStyle(.orange)
            }
            .buttonStyle(.plain)
            .fixedSize().layoutPriority(1)
            .help("In progress (can't accept yet)")
            .accessibilityLabel(chip.text)
            .accessibilityIdentifier("HUD live changes")
            .popover(isPresented: $showList, arrowEdge: .top) {
                LiveChangesPopover { path in
                    showList = false
                    if model.tab != .changes { model.tab = .changes }
                    Task { await store.openLiveDiff(path) }
                }
            }
        }
    }
}
