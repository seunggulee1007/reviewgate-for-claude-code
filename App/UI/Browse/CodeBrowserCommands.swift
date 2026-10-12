import SwiftUI
import ReviewGateCore

// MARK: code-browser — docs/PROTOCOL.md §47: the File menu's Go to File (⌘P) and Find in Project (⇧⌘F), and what the
// window does when a project file opens or another view takes the diff pane.

/// File › Go to File… / Find in Project… (in place of Print, which the app has nothing for).
struct CodeBrowserCommands: Commands {
    let focused: WorkbenchWindowEntry?

    var body: some Commands {
        CommandGroup(replacing: .printItem) {
            let store = focused?.store
            let hasProject = store?.menuState.hasProject == true
            Button("Go to File…") { store?.codeBrowser.quickOpenShown = true }
                .keyboardShortcut("p", modifiers: .command)
                .disabled(!hasProject)
                .accessibilityIdentifier("File menu Go to file")
            Button("Find in Project…") {
                focused?.model.tab = .search
                store?.codeBrowser.presentSearch()
            }
            .keyboardShortcut("f", modifiers: [.command, .shift])
            .disabled(!hasProject)
            .accessibilityIdentifier("File menu Find in project")
        }
    }
}

/// The window's side of the code browser: Go to File's sheet; an opened file shows the diff pane (expanded, on a review
/// tab); "Find in Project" brings the Search tab forward; a past round's or a live diff opened from elsewhere closes the file.
struct CodeBrowserObservers: ViewModifier {
    @Environment(AppState.self) private var store
    @Binding var tab: MainTab
    /// Expands a collapsed diff pane.
    let onShowFile: () -> Void

    func body(content: Content) -> some View {
        @Bindable var browser = store.codeBrowser
        content
            .sheet(isPresented: $browser.quickOpenShown) { QuickOpenSheet() }
            .onChange(of: browser.selection?.tick) { _, tick in
                guard tick != nil else { return }
                if !tab.showsReview { tab = .changes }
                onShowFile()
            }
            .onChange(of: browser.searchPresentTick) { _, _ in
                if tab != .search { tab = .search }
            }
            .onChange(of: store.historySelection) { _, selection in
                if selection != nil { store.closeProjectFile() }
            }
            .onChange(of: store.liveSelection) { _, selection in
                if selection != nil { store.closeProjectFile() }
            }
    }
}
