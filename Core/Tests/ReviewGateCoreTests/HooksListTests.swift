import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §72.1 on the Mac: `/hooks` — the hooks in effect, read-only.
@Suite struct HooksListTests {
    private let json = #"""
    {"type":"hooks_list","off":"settings",
     "hooks":[
       {"event":"PreToolUse","matcher":"Bash","type":"command","text":"guard.sh","if":"Bash(rm *)","timeout":30,"source":"project","path":"/work/acme/.claude/settings.json","active":false},
       {"event":"PostToolUse","matcher":"","type":"command","text":"fmt.sh","async":true,"source":"plugin","plugin":"fmt","path":"/p/fmt/hooks/hooks.json","active":false},
       {"event":"Stop","matcher":"","type":"prompt","text":"Done?","source":"newer-source","path":"x"},
       {"event":"Stop","matcher":"","type":"http","text":"https://hooks.example.com","statusMessage":"Telling the team","source":"user","path":"/Users/dev/.claude/settings.json"}
     ],
     "files":[{"source":"user","path":"/Users/dev/.claude/settings.json","exists":true,"count":1},{"source":"local","path":"/work/acme/.claude/settings.local.json","exists":false,"count":0}]}
    """#

    @Test func theReplyOnTheWire() throws {
        let reply = try NDJSON.decode(EngineEvent.self, from: json.replacingOccurrences(of: "\n", with: ""))
        guard case let .hooksList(list) = reply else { Issue.record("not hooks_list: \(reply)"); return }
        // A source a newer engine adds is skipped, the rest kept.
        #expect(list.hooks.map(\.text) == ["guard.sh", "fmt.sh", "https://hooks.example.com"])
        #expect(list.hooks[0] == HookEntry(event: "PreToolUse", matcher: "Bash", text: "guard.sh", condition: "Bash(rm *)", timeout: 30,
                                           source: .project, path: "/work/acme/.claude/settings.json", active: false))
        #expect(list.hooks[1].plugin == "fmt" && list.hooks[1].async)
        #expect(list.hooks[2].active)   // absent: it runs
        #expect(list.off == .settings)
        #expect(list.files == [HookFile(source: .user, path: "/Users/dev/.claude/settings.json", count: 1),
                               HookFile(source: .local, path: "/work/acme/.claude/settings.local.json", exists: false)])
        #expect(EngineCommand.hooksList.type == "hooks_list")
    }

    @Test func groupedByEventAsTheTerminalLists() {
        let list = HooksList(hooks: [HookEntry(event: "PreToolUse", text: "a", source: .user, path: "u"),
                                     HookEntry(event: "PreToolUse", text: "b", source: .project, path: "p"),
                                     HookEntry(event: "Custom", text: "c", source: .user, path: "u")], files: [])
        #expect(list.byEvent().map(\.event) == ["PreToolUse", "Custom"])
        #expect(list.byEvent().first?.hooks.map(\.text) == ["a", "b"])
        let all = list.byEvent(allEvents: true)
        #expect(all.count == HooksText.events.count + 1)
        #expect(all.first?.event == "SessionStart" && all.first?.hooks.isEmpty == true)
        #expect(all.last?.event == "Custom")
    }

    @Test func theWords() {
        #expect(HooksText.matcher("") == HooksText.anyMatcher)
        #expect(HooksText.matcher("Edit|Write") == "Edit|Write")
        #expect(HooksText.source(.plugin, plugin: "fmt") == String(localized: "Plugin \("fmt")", bundle: .module))
        let h = HookEntry(event: "PreToolUse", text: "x", condition: "Bash(git *)", timeout: 30, async: true, source: .user, path: "u")
        #expect(HooksText.details(h) == [String(localized: "if \("Bash(git *)")", bundle: .module), String(localized: "\(30) s timeout", bundle: .module),
                                        String(localized: "runs in the background", bundle: .module)].joined(separator: " · "))
        #expect(HooksText.details(HookEntry(event: "Stop", text: "x", source: .user, path: "u")) == "")
        #expect(HooksText.off(nil) == nil)
        for off in [HooksOff.app, .settings, .managedOnly, .managed] { #expect(HooksText.off(off)?.isEmpty == false) }
    }

    @Test func slashHooksOpensTheBrowser() {
        #expect(SlashAppCommand.parse("/hooks", entries: []) == .hooks)
        #expect(SlashAppCommand.parse("/HOOKS", entries: []) == .hooks)
        #expect(SlashAppCommand.description("hooks") == HooksText.description)
    }
}
