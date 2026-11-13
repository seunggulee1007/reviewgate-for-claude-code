import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §56.3: which editor ⌃G opens the draft in. Electron: draftEditor.test.ts.
@Suite struct DraftEditorTests {
    private let file = "/tmp/ReviewGate/drafts/draft-1.md"
    private func launch(_ env: [String: String], code: String? = nil) -> DraftEditorLaunch {
        DraftEditor.launch(file: file, env: env, findExecutable: { $0 == "code" ? code : nil }, defaultEditorName: "TextEdit")
    }

    @Test func visualWinsThenEditor() {
        let l = launch(["VISUAL": "zed", "EDITOR": "subl"])
        #expect(l == DraftEditorLaunch(name: "zed", executable: "/bin/sh", arguments: ["-c", "zed --wait \"$1\"", "sh", file], waits: true))
        #expect(launch(["EDITOR": "subl"]).arguments == ["-c", "subl -w \"$1\"", "sh", file])
    }

    @Test func aTerminalEditorIsPassedOver() {
        #expect(launch(["VISUAL": "nvim", "EDITOR": "/usr/bin/vim"], code: "/usr/local/bin/code")
                == DraftEditorLaunch(name: "VS Code", executable: "/usr/local/bin/code", arguments: ["--wait", file], waits: true))
        #expect(launch(["EDITOR": "emacsclient -t"]).name == "TextEdit")
        #expect(launch(["EDITOR": "emacsclient -c"]).arguments == ["-c", "emacsclient -c \"$1\"", "sh", file])
    }

    @Test func aWaitFlagAlreadyThereIsKeptAndAnUnknownGuiCommandRunsAsGiven() {
        #expect(launch(["EDITOR": "code -w"]).arguments == ["-c", "code -w \"$1\"", "sh", file])
        #expect(launch(["EDITOR": "/usr/local/bin/subl"]).arguments == ["-c", "/usr/local/bin/subl -w \"$1\"", "sh", file])
        #expect(launch(["EDITOR": "myed --block"]).arguments == ["-c", "myed --block \"$1\"", "sh", file])
    }

    @Test func noneSetCodeElseTheDefaultTextEditor() {
        #expect(launch([:], code: "/opt/homebrew/bin/code").arguments == ["--wait", file])
        #expect(launch(["EDITOR": "  "]) == DraftEditorLaunch(name: "TextEdit", executable: "/usr/bin/open", arguments: ["-t", file], waits: false))
    }

    @Test func theAppsOwnTempFolder() {
        #expect(DraftEditor.folder(temp: URL(fileURLWithPath: "/private/var/tmp")).path == "/private/var/tmp/ReviewGate/drafts")
    }
}
