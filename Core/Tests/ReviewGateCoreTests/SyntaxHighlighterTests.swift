import Foundation
import SwiftUI
import Testing
@testable import ReviewGateCore

@Suite struct SyntaxHighlighterTests {
    // MARK: wave7 w7-state — §45.2
    @Test func theLineCacheIsBoundedByBytesAndClears() async {
        let highlighter = SyntaxHighlighter()
        let limit = await highlighter.costLimit
        #expect(limit == SyntaxHighlighter.cacheCostLimit)
        #expect(limit >= 16 * 1024 * 1024 && limit <= 32 * 1024 * 1024)
        #expect(SyntaxHighlighter.entryCost(line: String(repeating: "x", count: 200), runs: 4)
                > SyntaxHighlighter.entryCost(line: "x", runs: 4))
        #expect(SyntaxHighlighter.entryCost(line: "x", runs: 40) > SyntaxHighlighter.entryCost(line: "x", runs: 4))
        _ = await highlighter.highlightLines(["let answer = 42"], language: "swift", dark: false)
        #expect(await highlighter.isCached("let answer = 42", language: "swift", dark: false))
        await highlighter.clear()
        #expect(!(await highlighter.isCached("let answer = 42", language: "swift", dark: false)))
    }

    @Test func languageByExtensionAndFileName() async {
        let hl = SyntaxHighlighter.shared
        #expect(await hl.language(forPath: "Sources/A/B.swift") == "swift")
        #expect(await hl.language(forPath: "web/app.tsx") == "typescript")
        #expect(await hl.language(forPath: "x/main.kt") == "kotlin")
        #expect(await hl.language(forPath: "build.gradle") == "gradle")
        #expect(await hl.language(forPath: "Dockerfile") == "dockerfile")
        #expect(await hl.language(forPath: "Makefile") == "makefile")
        #expect(await hl.language(forPath: "conf/app.properties") == "properties")
        #expect(await hl.language(forPath: "Cargo.toml") == "toml")
        #expect(await hl.language(forPath: "src/App.vue") == "xml")
        #expect(await hl.language(forPath: "lib/x.dart") == "dart")
        #expect(await hl.language(forPath: "LICENSE") == nil)
        #expect(await hl.language(forPath: "weird.unknownext") == nil)
    }

    @Test func swiftLineGetsMultipleRuns() async {
        let lines = await SyntaxHighlighter.shared.highlightLines(["let x: Int = 42 // note"], language: "swift", dark: false)
        #expect(lines.count == 1)
        let runs = Array(lines[0].runs)
        #expect(runs.count > 1)
        #expect(String(lines[0].characters) == "let x: Int = 42 // note")
        #expect(runs.contains { $0.swiftUI.foregroundColor != nil })
        #expect(runs.allSatisfy { $0.swiftUI.font != nil })

        // Dark theme is a separate cache entry and also colours the line.
        let dark = await SyntaxHighlighter.shared.highlightLines(["let x: Int = 42 // note"], language: "swift", dark: true)
        #expect(Array(dark[0].runs).count > 1)
    }

    @Test func unknownLanguageIsPlain() async {
        let lines = await SyntaxHighlighter.shared.highlightLines(["let x = 1", ""], language: nil, dark: false)
        #expect(lines.count == 2)
        #expect(Array(lines[0].runs).count == 1)
        #expect(String(lines[0].characters) == "let x = 1")
    }

    @Test func documentSplitPreservesLineCountAndMultiLineTokens() async {
        let text = "/* a\nb */\nlet y = \"s\"\n"
        let lines = await SyntaxHighlighter.shared.highlightDocument(text, language: "swift", dark: false)
        #expect(lines.count == 3)
        #expect(lines.map { String($0.characters) } == ["/* a", "b */", "let y = \"s\""])
        // The comment colour carries over to the second line of the block comment.
        let c1 = Array(lines[0].runs).first?.swiftUI.foregroundColor
        let c2 = Array(lines[1].runs).first?.swiftUI.foregroundColor
        #expect(c1 != nil && c1 == c2)

        let empty = await SyntaxHighlighter.shared.highlightDocument("", language: "swift", dark: false)
        #expect(empty.count == 1)
        let noTrailing = await SyntaxHighlighter.shared.highlightDocument("a\n\nb", language: "swift", dark: false)
        #expect(noTrailing.map { String($0.characters) } == ["a", "", "b"])
    }

    /// Fresh lines every call (a run tag) so the cache never answers.
    private static func uniqueLines(_ sample: [String], _ n: Int, tag: String) -> [String] {
        (0..<n).map { "\(sample[$0 % sample.count]) // \(tag) \($0)" }
    }

    /// Intent: per-line highlighting of a 2000-line diff stays interactive (≈ linear, no per-line setup blow-up).
    /// wave2 mac-diff: measured so that load cannot fail it and a real regression still does. The wall clock counted
    /// everything else a parallel `swift test` ran — 7.4 s for 2000 lines there, 0.58 s alone — and the queue on the
    /// shared actor, so this times the CPU the actor's thread spends on the lines (`cpuTimedHighlightLines`), on a
    /// highlighter of its own, best of three interleaved runs. Bounds: 2000 lines at most 25× the 200-line run (linear
    /// is 10×, a quadratic step 100×) and 3 ms a line (10× today's ≈ 0.3 ms in a debug build; a per-line Highlightr /
    /// JSContext setup costs tens of ms a line).
    @Test func perLineHighlightingOf2000LinesIsFastEnough() async throws {
        let sample = [
            "import Foundation",
            "struct Point: Hashable { var x: Double; var y: Double }",
            "func dist(_ a: Point, _ b: Point) -> Double { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }",
            "// comment line \(Int.random(in: 0...9))",
            "let names = [\"a\", \"b\", \"c\"].map { $0.uppercased() }",
        ]
        let hl = SyntaxHighlighter()
        var small = Double.infinity, big = Double.infinity
        for run in 0..<3 {
            let tag = "\(run)-\(UUID().uuidString.prefix(8))"
            small = min(small, await hl.cpuTimedHighlightLines(Self.uniqueLines(sample, 200, tag: "s\(tag)"), language: "swift", dark: false).cpuSeconds)
            let result = await hl.cpuTimedHighlightLines(Self.uniqueLines(sample, 2000, tag: "b\(tag)"), language: "swift", dark: false)
            #expect(result.lines.count == 2000)
            big = min(big, result.cpuSeconds)
        }
        #expect(big < max(small, 0.001) * 25, "2000 lines took \(big)s of CPU, 200 lines \(small)s — no longer linear")
        #expect(big / 2000 < 0.003, "2000 lines took \(big)s of CPU (\(big / 2) ms a line)")
    }

    /// acme: Java lines of ~300 characters (a third of its added lines are over 70). `DiffDisplay.foldLineThreshold`
    /// (3 000 lines) has to stay within a few seconds of highlighting CPU for them — measured on 1 000 lines, best of two.
    @Test func acmeLengthJavaLinesFitTheFoldThreshold() async throws {
        let java = "    public ResponseEntity<List<SettlementSummaryDto>> findSettlementSummaries(@RequestParam(\"tenantId\") Long tenantId, "
            + "@RequestParam(value = \"from\", required = false) LocalDate from, @RequestParam(value = \"to\", required = false) LocalDate to, "
            + "Pageable pageable) throws BusinessException { // 주문 요약"
        #expect(java.count >= 290)
        let hl = SyntaxHighlighter()
        var best = Double.infinity
        for run in 0..<2 {
            let result = await hl.cpuTimedHighlightLines(Self.uniqueLines([java], 1_000, tag: "j\(run)-\(UUID().uuidString.prefix(6))"),
                                                         language: "java", dark: true)
            #expect(result.lines.count == 1_000)
            best = min(best, result.cpuSeconds)
        }
        let atThreshold = best / 1_000 * Double(DiffDisplay.foldLineThreshold)
        #expect(atThreshold < 6, "highlighting \(DiffDisplay.foldLineThreshold) acme-length lines would take \(atThreshold)s of CPU")
    }
}
