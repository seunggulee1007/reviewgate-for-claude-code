import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §57.5: files dropped on a terminal go in as shell-escaped absolute paths (Terminal.app's form); "Mention
/// in Chat" pastes `@path` into a terminal chat — both one bracketed paste, never Enter.
@Suite @MainActor struct TerminalDropTests {
    @Test func pathsAreEscapedAsTerminalAppWritesThem() {
        #expect(TerminalPathText.shellEscaped("/Users/dev/acme/notes.md") == "/Users/dev/acme/notes.md")
        #expect(TerminalPathText.shellEscaped("/Users/dev/Screenshot 2026-11-23 at 10.00.00.png")
                == #"/Users/dev/Screenshot\ 2026-11-23\ at\ 10.00.00.png"#)
        #expect(TerminalPathText.shellEscaped(#"/tmp/it's "quoted".txt"#) == #"/tmp/it\'s\ \"quoted\".txt"#)
        #expect(TerminalPathText.shellEscaped("/tmp/a(1)&b;$c`d`|e*?[x]{y}~!#<>=^,") ==
                ##"/tmp/a\(1\)\&b\;\$c\`d\`\|e\*\?\[x\]\{y\}\~\!\#\<\>\=\^\,"##)
        #expect(TerminalPathText.shellEscaped(#"/tmp/back\slash"#) == #"/tmp/back\\slash"#)
        // Unicode (Korean, precomposed or not, an emoji) stays as it is; only the space is escaped.
        #expect(TerminalPathText.shellEscaped("/Users/dev/문서/스크린샷 1.png") == #"/Users/dev/문서/스크린샷\ 1.png"#)
        let decomposed = "/tmp/\u{1112}\u{1161}\u{11AB}.png"
        #expect(TerminalPathText.shellEscaped(decomposed) == decomposed)
        #expect(TerminalPathText.shellEscaped("/tmp/🙂.txt") == "/tmp/🙂.txt")
        // A newline in a name: single-quoted whole (a backslash before it would join the lines).
        #expect(TerminalPathText.shellEscaped("/tmp/a\nb's") == "'/tmp/a\nb'\\''s'")
    }

    @Test func aDropIsThePathsSeparatedBySpaces() {
        #expect(TerminalPathText.dropText([]) == "")
        #expect(TerminalPathText.dropText(["/tmp/a.png"]) == "/tmp/a.png ")
        #expect(TerminalPathText.dropText(["/tmp/a b.png", "/tmp/c.txt"]) == #"/tmp/a\ b.png /tmp/c.txt "#)
    }

    @Test func mentionsAreAtPaths() {
        #expect(TerminalPathText.mentions([]) == "")
        #expect(TerminalPathText.mentions(["Sources/App.swift"]) == "@Sources/App.swift ")
        #expect(TerminalPathText.mentions(["docs/", "my notes.md"]) == #"@docs/ @"my notes.md" "#)
    }

    @Test func mentionInATerminalChatPastes() {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "TerminalDropTests.\(UUID().uuidString)")!)
        app.commandSink = { _ in }
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "t1", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        var term = SessionMeta(id: "t1", title: "In the terminal")
        term.kind = .terminal
        s.sessions = SessionsInfo(list: [term], currentId: "t1", openTabIds: ["t1"])
        app.handle(.state(s))
        var pasted: [String] = []
        app.onTerminalPaste = { pasted.append($0); return nil }
        #expect(app.mentionInTerminal([]) == nil)
        #expect(app.mentionInTerminal(["src/a.ts", "src/b c.ts"]) == nil)
        #expect(pasted == [#"@src/a.ts @"src/b c.ts" "#])
    }
}
