import Foundation
import Testing
@testable import ReviewGateCore

@Suite struct MarkdownBlocksTests {

    // MARK: - Tables

    @Test func tableWithoutAlignmentMarkers() {
        let blocks = MarkdownBlocks.parse("""
        | Name | Size |
        | --- | --- |
        | a.txt | 12 |
        | b.txt | 340 |
        """)
        #expect(blocks == [
            .table(header: ["Name", "Size"],
                   alignments: [.none, .none],
                   rows: [["a.txt", "12"], ["b.txt", "340"]]),
        ])
    }

    @Test func tableAlignmentsPerColumn() {
        let blocks = MarkdownBlocks.parse("""
        | L | C | R |
        |:---|:---:|---:|
        | 1 | 2 | 3 |
        """)
        guard case let .table(header, aligns, rows) = blocks.first else {
            Issue.record("expected a table, got \(blocks)")
            return
        }
        #expect(header == ["L", "C", "R"])
        #expect(aligns == [.left, .center, .right])
        #expect(rows == [["1", "2", "3"]])
    }

    @Test func raggedRowsArePaddedAndTruncated() {
        let blocks = MarkdownBlocks.parse("""
        | a | b | c |
        | - | - | - |
        | 1 |
        | 1 | 2 | 3 | 4 |
        """)
        guard case let .table(_, _, rows) = blocks.first else {
            Issue.record("expected a table, got \(blocks)")
            return
        }
        #expect(rows == [["1", "", ""], ["1", "2", "3"]])
    }

    @Test func escapedPipeStaysInsideTheCell() {
        let blocks = MarkdownBlocks.parse("""
        | expr | meaning |
        | --- | --- |
        | a \\| b | a or b |
        """)
        guard case let .table(_, _, rows) = blocks.first else {
            Issue.record("expected a table, got \(blocks)")
            return
        }
        #expect(rows == [["a | b", "a or b"]])
    }

    @Test func tableRightAfterAParagraphWithNoBlankLine() {
        let blocks = MarkdownBlocks.parse("""
        Here are the files:
        | Name | Size |
        | --- | --- |
        | a.txt | 12 |
        """)
        #expect(blocks.count == 2)
        #expect(blocks.first == .paragraph(lines: ["Here are the files:"]))
        guard case let .table(header, _, rows) = blocks.last else {
            Issue.record("expected a table, got \(blocks)")
            return
        }
        #expect(header == ["Name", "Size"])
        #expect(rows == [["a.txt", "12"]])
    }

    @Test func pipesInProseAreNotATable() {
        let blocks = MarkdownBlocks.parse("""
        Use `a | b` for alternation, and a || b for or.
        The next line has no separator | at all.
        """)
        #expect(blocks == [.paragraph(lines: [
            "Use `a | b` for alternation, and a || b for or.",
            "The next line has no separator | at all.",
        ])])
    }

    @Test func tableEndsAtTheFirstNonRowLine() {
        let blocks = MarkdownBlocks.parse("""
        | a | b |
        | --- | --- |
        | 1 | 2 |
        Done.
        """)
        #expect(blocks.count == 2)
        guard case let .table(_, _, rows) = blocks.first else {
            Issue.record("expected a table, got \(blocks)")
            return
        }
        #expect(rows == [["1", "2"]])
        #expect(blocks.last == .paragraph(lines: ["Done."]))
    }

    // MARK: - Rules

    @Test func ruleVersusTableSeparatorAmbiguity() {
        // A bare `---` under a paragraph is a thematic break (we do not do setext headings) …
        #expect(MarkdownBlocks.parse("intro\n---\nrest") == [
            .paragraph(lines: ["intro"]),
            .rule,
            .paragraph(lines: ["rest"]),
        ])
        // … but the same dashes inside pipes are a table separator, not a rule.
        let table = MarkdownBlocks.parse("| a |\n| --- |\n| 1 |")
        #expect(table == [.table(header: ["a"], alignments: [.none], rows: [["1"]])])
        #expect(!table.contains(.rule))
    }

    @Test func allThreeRuleSpellings() {
        #expect(MarkdownBlocks.parse("---\n***\n___\n- - -") == [.rule, .rule, .rule, .rule])
        // Two dashes are not a rule.
        #expect(MarkdownBlocks.parse("--") == [.paragraph(lines: ["--"])])
    }

    // MARK: - Lists

    @Test func nestedListKeepsLevels() {
        let blocks = MarkdownBlocks.parse("""
        - one
          - one a
            - one a i
        - two
        """)
        guard case let .list(items) = blocks.first, blocks.count == 1 else {
            Issue.record("expected one list, got \(blocks)")
            return
        }
        #expect(items.map(\.indent) == [0, 1, 2, 0])
        #expect(items.map(\.text) == ["one", "one a", "one a i", "two"])
        #expect(items.allSatisfy { $0.marker == .bullet })
    }

    @Test func taskListItems() {
        let blocks = MarkdownBlocks.parse("""
        - [x] shipped
        - [ ] pending
        1. plain ordered
        """)
        guard case let .list(items) = blocks.first else {
            Issue.record("expected a list, got \(blocks)")
            return
        }
        #expect(items.map(\.marker) == [.task(done: true), .task(done: false), .ordered("1.")])
        #expect(items.map(\.text) == ["shipped", "pending", "plain ordered"])
    }

    @Test func indentedCodeInsideAListItemIsNotAList() {
        let blocks = MarkdownBlocks.parse("""
        1. Run it:

               npm install
               - not a bullet

        2. Done
        """)
        guard case let .list(items) = blocks.first, blocks.count == 1 else {
            Issue.record("expected one list, got \(blocks)")
            return
        }
        #expect(items.count == 2)
        #expect(items[0].code == ["npm install", "- not a bullet"])
        #expect(items[1].text == "Done")
        #expect(items[1].code.isEmpty)
    }

    // MARK: - Quotes

    @Test func consecutiveQuoteLinesGroupIntoOneBlock() {
        let blocks = MarkdownBlocks.parse("""
        > first line
        > second line

        after
        """)
        #expect(blocks == [
            .quote(blocks: [.paragraph(lines: ["first line", "second line"])]),
            .paragraph(lines: ["after"]),
        ])
    }

    @Test func nestedQuoteGoesOneLevelDeeper() {
        let blocks = MarkdownBlocks.parse("""
        > outer
        >> inner
        """)
        #expect(blocks == [
            .quote(blocks: [
                .paragraph(lines: ["outer"]),
                .quote(blocks: [.paragraph(lines: ["inner"])]),
            ]),
        ])
    }

    // MARK: - Code fences

    @Test func tildeFenceWithLanguage() {
        let blocks = MarkdownBlocks.parse("""
        ~~~swift
        let x = 1
        ~~~
        after
        """)
        #expect(blocks == [
            .code(language: "swift", text: "let x = 1"),
            .paragraph(lines: ["after"]),
        ])
    }

    @Test func backtickFenceKeepsPipesAndDashesVerbatim() {
        let blocks = MarkdownBlocks.parse("""
        ```
        | a | b |
        | --- | --- |
        ---
        ```
        """)
        #expect(blocks == [.code(language: "", text: "| a | b |\n| --- | --- |\n---")])
    }

    // MARK: - Headings and mixed documents

    @Test func headingsAndAMixedDocument() {
        let blocks = MarkdownBlocks.parse("""
        ## Summary

        | a | b |
        |:-:|--:|
        | 1 | 2 |

        ---

        - [x] done
        - [ ] open

        > note
        """)
        #expect(blocks.count == 5)
        #expect(blocks[0] == .heading(level: 2, text: "Summary"))
        #expect(blocks[1] == .table(header: ["a", "b"], alignments: [.center, .right], rows: [["1", "2"]]))
        #expect(blocks[2] == .rule)
        #expect(blocks[3] == .list(items: [
            MarkdownBlocks.ListItem(indent: 0, marker: .task(done: true), text: "done"),
            MarkdownBlocks.ListItem(indent: 0, marker: .task(done: false), text: "open"),
        ]))
        #expect(blocks[4] == .quote(blocks: [.paragraph(lines: ["note"])]))
    }

    @Test func emptyAndWhitespaceOnlyInputProduceNoBlocks() {
        #expect(MarkdownBlocks.parse("") == [])
        #expect(MarkdownBlocks.parse("\n\n   \n") == [])
    }
}
