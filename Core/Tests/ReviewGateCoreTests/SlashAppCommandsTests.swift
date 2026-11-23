import Foundation
import Testing
@testable import ReviewGateCore

/// b-slash: the terminal's built-ins typed in a classic chat (docs/PROTOCOL.md §56.5) — what each does, the user's own
/// command of the same name winning, the built-ins only a terminal chat has, and the palette's lines.
@Suite @MainActor struct SlashAppCommandsTests {
    private func caps(_ commands: [SlashCommandInfo]) -> SessionCapabilities {
        var caps = SessionCapabilities(slashCommands: [], skills: [], plugins: [], mcpServers: [])
        caps.commands = commands
        caps.state = .ready
        return caps
    }

    @Test func eachAppCommandParses() {
        let expected: [String: SlashAppCommand] = [
            "/model": .model(""), "/resume": .resume, "/rewind": .rewind, "/context": .context, "/cost": .cost,
            "/permissions": .permissions, "/agents": .agents, "/memory": .memory, "/config": .config, "/help": .help,
            "/status": .status, "/exit": .exit, "/rename": .rename,
        ]
        for (text, command) in expected { #expect(SlashAppCommand.parse(text, entries: []) == command, "\(text)") }
        #expect(Set(SlashAppCommand.names) == Set(expected.keys.map { String($0.dropFirst()) }))
    }

    @Test func modelTakesItsArgument() {
        #expect(SlashAppCommand.parse("/model sonnet", entries: []) == .model("sonnet"))
        #expect(SlashAppCommand.parse("  /model   opus  ", entries: []) == .model("opus"))
        #expect(SlashAppCommand.parse("/MODEL", entries: []) == .model(""))
    }

    @Test func terminalAliasesMapToTheSameCommand() {
        #expect(SlashAppCommand.parse("/quit", entries: []) == .exit)
        #expect(SlashAppCommand.parse("/continue", entries: []) == .resume)
        #expect(SlashAppCommand.parse("/settings", entries: []) == .config)
        #expect(SlashAppCommand.parse("/checkpoint", entries: []) == .rewind)
        #expect(SlashAppCommand.parse("/allowed-tools", entries: []) == .permissions)
    }

    @Test func terminalOnlyBuiltinsAreNotSent() {
        #expect(SlashAppCommand.parse("/hooks", entries: []) == .terminalOnly("hooks"))
        #expect(SlashAppCommand.parse("/vim", entries: []) == .terminalOnly("vim"))
        #expect(SlashAppCommand.parse("/add-dir ../other", entries: []) == .terminalOnly("add-dir"))
    }

    @Test func everythingElseGoesToClaudeAsBefore() {
        for text in ["/clear", "/compact focus", "/btw what?", "/mcp", "/init", "/review", "/security-review", "/my-skill arg",
                     "hello /model", "/", "/model\nsecond line", "/modelx", "plain text"] {
            #expect(SlashAppCommand.parse(text, entries: []) == nil, "\(text)")
        }
    }

    @Test func theUsersOwnCommandOfTheSameNameWins() {
        let own = [SlashCommandEntry(name: "status", group: .project), SlashCommandEntry(name: "hooks", group: .mine),
                   SlashCommandEntry(name: "model", group: .plugin("acme")), SlashCommandEntry(name: "help", group: .builtin)]
        #expect(SlashAppCommand.parse("/status", entries: own) == nil)
        #expect(SlashAppCommand.parse("/hooks", entries: own) == nil)
        #expect(SlashAppCommand.parse("/model", entries: own) == nil)
        #expect(SlashAppCommand.parse("/help", entries: own) == .help)   // the CLI's own built-in: the app's
    }

    @Test func paletteListsTheAppCommandsInAClassicChat() {
        let session = caps([SlashCommandInfo(name: "model", description: "Set the AI model", source: .builtin),
                            SlashCommandInfo(name: "hooks", description: "Manage hook configurations", source: .builtin),
                            SlashCommandInfo(name: "status", description: "Project status", source: .project)])
        let entries = SlashCommandCatalog.entries(session, offersAppCommands: true)
        let byName = Dictionary(entries.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        for name in SlashAppCommand.names where name != "status" {
            #expect(byName[name]?.group == .builtin, "\(name)")
            #expect(byName[name]?.description == SlashAppCommand.description(name), "\(name)")
        }
        #expect(byName["model"]?.argumentHint == "[model]")
        #expect(byName["exit"]?.aliases == ["quit"])
        #expect(byName["status"]?.group == .project)   // the project's own, untouched
        #expect(byName["status"]?.description == "Project status")
        #expect(byName["hooks"]?.description == SlashAppCommand.terminalOnlyDescription("Manage hook configurations"))
        #expect(entries.map(\.name) == entries.map(\.name).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending })
    }

    @Test func paletteLeavesThemOutWhenNotOffered() {
        let entries = SlashCommandCatalog.entries(caps([SlashCommandInfo(name: "hooks", description: "Manage hooks", source: .builtin)]))
        #expect(!entries.contains { $0.name == "model" })
        #expect(entries.first { $0.name == "hooks" }?.description == "Manage hooks")
    }

    @Test func typedAliasFindsTheCommandInThePalette() {
        let entries = SlashCommandCatalog.entries(caps([]), offersAppCommands: true)
        let shown = SlashCommandCatalog.flatten(SlashCommandCatalog.sections(entries: entries, query: "quit", recents: []))
        #expect(shown.first?.name == "exit")
    }
}
