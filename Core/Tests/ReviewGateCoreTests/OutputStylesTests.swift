import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §72.2 on the Mac: `/output-style` — the styles, the current one, a switch as the terminal's.
@Suite struct OutputStylesTests {
    @Test func theReplyOnTheWire() throws {
        let json = #"{"type":"output_styles","styles":[{"name":"default","description":null,"source":"builtin"},{"name":"Concise","description":null,"source":"builtin"},{"name":"Diagrams first","description":"Lead with a diagram","source":"user","path":"/Users/dev/.claude/output-styles/diagrams.md"},{"name":"tutor","description":"Step by step","source":"plugin","plugin":"teach","path":"/p/tutor.md"},{"name":"Mystery","description":null,"source":"from-the-future"}],"current":"Concise","setIn":{"source":"local","path":"/work/acme/.claude/settings.local.json","value":"Concise"},"canSet":true}"#
        let event = try NDJSON.decode(EngineEvent.self, from: json)
        guard case let .outputStyles(reply) = event else { Issue.record("not output_styles: \(event)"); return }
        #expect(reply.styles.map(\.name) == ["default", "Concise", "Diagrams first", "tutor", "Mystery"])
        #expect(reply.styles[2] == OutputStyleInfo(name: "Diagrams first", description: "Lead with a diagram", source: .user, path: "/Users/dev/.claude/output-styles/diagrams.md"))
        #expect(reply.styles[4].source == .other)   // a source a newer engine adds
        #expect(reply.current == "Concise" && reply.canSet && reply.why == nil)
        #expect(reply.setIn == OutputStyleSetIn(source: "local", path: "/work/acme/.claude/settings.local.json", value: "Concise"))
        #expect(EngineCommand.outputStyles.type == "output_styles")
        #expect(EngineCommand.outputStyleSet(name: "Learning").type == "output_style_set")
        let encoded = String(decoding: try JSONEncoder().encode(EngineCommand.outputStyleSet(name: "Learning")), as: UTF8.self)
        #expect(encoded.contains(#""name":"Learning""#))
    }

    @Test func whatCanBePicked() {
        let reply = OutputStylesReply(styles: [OutputStyleInfo(name: "default", source: .builtin), OutputStyleInfo(name: "Concise", source: .builtin)],
                                      current: "concise", canSet: true)
        #expect(reply.blocker(for: "Concise") == OutputStyleText.isCurrent)   // any case
        #expect(reply.blocker(for: "default") == nil)
        let off = OutputStylesReply(styles: [], current: nil, canSet: false, why: "local_settings_off")
        #expect(off.blocker(for: "default") == OutputStyleText.why("local_settings_off"))
        #expect(OutputStyleText.why(nil) == OutputStyleText.why("no_session"))
    }

    @Test func theWords() {
        #expect(OutputStyleText.displayName("default") == String(localized: "Default", bundle: .module))
        #expect(OutputStyleText.displayName("Concise") == "Concise")
        for name in ["default", "Proactive", "Concise", "Explanatory", "Learning"] { #expect(OutputStyleText.builtinDescription(name) != nil, "\(name)") }
        #expect(OutputStyleText.builtinDescription("Diagrams first") == nil)
        #expect(OutputStyleText.description(of: OutputStyleInfo(name: "x", description: "Mine", source: .project)) == "Mine")
        #expect(OutputStyleText.setIn(nil) == nil)
        #expect(OutputStyleText.setIn(OutputStyleSetIn(source: "managed", path: "/m", value: "Concise"))?.contains("Concise") == true)
        #expect(OutputStyleText.refusal(code: "unknown_output_style", detail: "nope")?.contains("nope") == true)
        #expect(OutputStyleText.refusal(code: "something_else", detail: "") == nil)
        #expect(EngineMessages.refusal(error: "unknown_output_style:Nope") == OutputStyleText.refusal(code: "unknown_output_style", detail: "Nope"))
    }

    @Test func theSessionsStyleInTheSnapshot() throws {
        struct Holder: Decodable { let session: SessionInfo }
        let with = try JSONDecoder().decode(Holder.self, from: Data(#"{"session":{"open":true,"starting":false,"outputStyle":"Explanatory"}}"#.utf8))
        #expect(with.session.outputStyle == "Explanatory")
        let none = try JSONDecoder().decode(Holder.self, from: Data(#"{"session":{"open":true,"starting":false,"outputStyle":null}}"#.utf8))
        #expect(none.session.outputStyle == nil)
        let older = try JSONDecoder().decode(Holder.self, from: Data(#"{"session":{"open":true,"starting":false}}"#.utf8))
        #expect(older.session.outputStyle == nil)
    }

    @Test func slashOutputStyle() {
        #expect(SlashAppCommand.parse("/output-style", entries: []) == .outputStyle(""))
        #expect(SlashAppCommand.parse("/output-style concise", entries: []) == .outputStyle("concise"))
        #expect(SlashAppCommand.argumentHint("output-style") == "[style]")
        #expect(!SlashAppCommand.terminalOnly.contains("output-style"))
    }
}
