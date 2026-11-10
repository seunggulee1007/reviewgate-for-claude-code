import Foundation
import Testing
@testable import ReviewGateCore

/// polish p-foundation — P3-transcript-07: a tool row's tooltip says what the call did, in words, and what a click does —
/// not its input as raw JSON. (Expected texts are built from the same keys, so the test reads in any UI language.)
@Suite struct ToolRowTooltipTests {
    private let root = URL(fileURLWithPath: "/work/acme")

    private func tip(_ name: String, _ input: [String: JSONValue], linked: Bool = false) -> String {
        ToolRowTooltip.text(name: name, input: .object(input), root: root, linked: linked)
    }

    @Test func aCommandSaysWhatItRunsAndWhy() {
        #expect(tip("Bash", ["command": .string("npm test -- --watch=false")])
                == String(localized: "Runs: \("npm test -- --watch=false")", bundle: .module))
        #expect(tip("Bash", ["command": .string("git status"), "description": .string("Show the working tree")])
                == String(localized: "Runs: \("git status")", bundle: .module) + "\n"
                    + String(localized: "Description: \("Show the working tree")", bundle: .module))
        // A command that changed reviewed files: a click shows their diff.
        #expect(tip("Bash", ["command": .string("./gradlew spotlessApply")], linked: true)
                == String(localized: "Runs: \("./gradlew spotlessApply")", bundle: .module) + "\n"
                    + String(localized: "Click to show the diff of the files it changed", bundle: .module))
    }

    @Test func filesReadRelativeToTheProject() {
        #expect(tip("Read", ["file_path": .string("/work/acme/src/main/Svc.java")])
                == String(localized: "Reads \("src/main/Svc.java")", bundle: .module))
        // Outside the project the path stays whole.
        #expect(tip("Read", ["file_path": .string("/Users/dev/notes.md")]) == String(localized: "Reads \("/Users/dev/notes.md")", bundle: .module))
    }

    @Test func anEditSaysAClickShowsItsDiff() {
        #expect(tip("Edit", ["file_path": .string("/work/acme/src/Svc.java"), "old_string": .string("a"), "new_string": .string("b")], linked: true)
                == String(localized: "Edits \("src/Svc.java") — click to show its diff", bundle: .module))
        #expect(tip("Write", ["file_path": .string("/work/acme/README.md"), "content": .string("# acme")])
                == String(localized: "Edits \("README.md")", bundle: .module))
        #expect(tip("NotebookEdit", ["notebook_path": .string("/work/acme/nb.ipynb"), "new_source": .string("x = 1")])
                == String(localized: "Edits \("nb.ipynb")", bundle: .module))
    }

    @Test func searchesSayWhatAndWhere() {
        #expect(tip("Grep", ["pattern": .string("TODO"), "path": .string("/work/acme/src")])
                == String(localized: "Searches for \("TODO") in \("src")", bundle: .module))
        #expect(tip("Grep", ["pattern": .string("TODO"), "glob": .string("*.ts")])
                == String(localized: "Searches for \("TODO") in \("*.ts")", bundle: .module))
        #expect(tip("Grep", ["pattern": .string("TODO")]) == String(localized: "Searches for \("TODO")", bundle: .module))
        #expect(tip("Glob", ["pattern": .string("**/*.swift")]) == String(localized: "Finds files: \("**/*.swift")", bundle: .module))
        #expect(tip("Glob", ["pattern": .string("*.md"), "path": .string("/work/acme/docs")])
                == String(localized: "Finds files: \("*.md") in \("docs")", bundle: .module))
    }

    @Test func theWebAgentsSkillsAndMcpSayTheirOwnWords() {
        #expect(tip("WebFetch", ["url": .string("https://tasks.example.com/acme/42"), "prompt": .string("summary")])
                == String(localized: "Reads the web page \("https://tasks.example.com/acme/42")", bundle: .module))
        #expect(tip("WebSearch", ["query": .string("swift testing")]) == String(localized: "Searches the web for \("swift testing")", bundle: .module))
        #expect(tip("Task", ["description": .string("Review the mapper"), "subagent_type": .string("reviewer")])
                == String(localized: "Starts an agent: \("Review the mapper")", bundle: .module))
        #expect(tip("TodoWrite", ["todos": .array([])]) == String(localized: "Updates the to-do list", bundle: .module))
        #expect(tip("Skill", ["skill": .string("acme-tools:smoke"), "args": .string("--fast")])
                == String(localized: "Skill: \("acme-tools:smoke --fast")", bundle: .module))
        #expect(tip("mcp__tracker__get_task", ["issueNumber": .number(42)]) == "tracker · get task\n42")
    }

    @Test func anythingElseShowsItsInputAsBefore() {
        let input: JSONValue = .object(["answer": .string("yes")])
        #expect(ToolRowTooltip.text(name: "SomeFutureTool", input: input, root: root, linked: false) == input.prettyPrinted(limit: 4_000))
        // A call missing the field its words need falls back too.
        #expect(tip("Bash", ["description": .string("no command")]) == JSONValue.object(["description": .string("no command")]).prettyPrinted(limit: 4_000))
    }

    @Test func aLongCommandIsCut() {
        let long = String(repeating: "x", count: 2_000)
        let text = tip("Bash", ["command": .string(long)])
        #expect(text == String(localized: "Runs: \(String(repeating: "x", count: ToolRowTooltip.valueLimit) + "…")", bundle: .module))
    }
}
