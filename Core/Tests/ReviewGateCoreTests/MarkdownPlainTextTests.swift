import Foundation
import Testing
@testable import ReviewGateCore

/// r2-review-flow — polish P3-transcript-10: "텍스트로 복사" gives an answer as it reads.
@Suite struct MarkdownPlainTextTests {
    @Test func headingsEmphasisCodeAndLinksLoseTheirMarks() {
        let text = """
        ## Fix the **login** test
        Run `npm test` and read [the guide](https://tasks.example.com/guide) *first*.
        """
        #expect(MarkdownBlocks.plainText(text) == "Fix the login test\n\nRun npm test and read the guide first.")
    }

    @Test func listsKeepTheirMarkersAndNesting() {
        let text = """
        - one
          - two
        1. first
        - [x] done
        - [ ] open
        """
        #expect(MarkdownBlocks.plainText(text) == "• one\n  • two\n1. first\n☑ done\n☐ open")
    }

    @Test func codeBlocksKeepTheirTextWithoutFences() {
        let text = """
        Before

        ```swift
        let a = "**not bold**"
        ```
        """
        #expect(MarkdownBlocks.plainText(text) == "Before\n\nlet a = \"**not bold**\"")
    }

    @Test func tablesBecomeTabSeparatedRowsAndRulesDisappear() {
        let text = """
        | Name | Size |
        | --- | --- |
        | `a.txt` | 12 |

        ---

        > quoted **text**
        """
        #expect(MarkdownBlocks.plainText(text) == "Name\tSize\na.txt\t12\n\nquoted text")
    }

    @Test func plainTextStaysAsItIs() {
        #expect(MarkdownBlocks.plainText("Nothing to strip here.\nSecond line.") == "Nothing to strip here.\nSecond line.")
    }
}
