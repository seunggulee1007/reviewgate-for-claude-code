import SwiftUI
import ReviewGateCore

/// wave3 check-clients — Settings › General › "테스트 명령 패턴" (`settings.testCommandPatterns`, docs/PROTOCOL.md §34.9), as in
/// Electron: the user's own test commands, one glob per line, sent to every open window's engine when the box loses the
/// focus (a half-typed `*` never counts every command as a test run), with the commands the engine already knows.
struct TestCommandSettingsSection: View {
    @AppStorage(AppSettings.Key.testCommandPatterns) private var patterns = ""
    @FocusState private var focused: Bool
    /// What the engines have — the window closing pushes only an edit they have not seen.
    @State private var pushed: String?

    var body: some View {
        Section("Test command patterns") {
            TextEditor(text: $patterns)
                .font(.body.monospaced())
                .frame(minHeight: 50)
                .focused($focused)
                .accessibilityLabel("Test command patterns")
                .accessibilityIdentifier("Test command patterns")
            Text("One per line, matched against each command of a Bash call as typed — * is any run of characters, ? one character. A matching command counts as a test run in the turn summary. Applied when you leave this box.")
                .font(.caption).foregroundStyle(.secondary)
            Text("Recognized without a pattern: \(AppSettings.builtInTestCommands)")
                .font(.caption).foregroundStyle(.secondary)
                .textSelection(.enabled)
                .accessibilityIdentifier("Built-in test commands")
            Text("Maven and Gradle count when the goal or task runs tests (test, verify, check, …Test).")
                .font(.caption).foregroundStyle(.secondary)
        }
        .onAppear { pushed = patterns }
        .onChange(of: focused) { _, isFocused in if !isFocused { push() } }
        .onDisappear { push() }
    }

    private func push() {
        guard patterns != pushed else { return }
        pushed = patterns
        for store in WorkbenchRegistry.shared.allStores { store.pushTestCommandPatterns() }
    }
}
