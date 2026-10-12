import Foundation
import SwiftUI
import Testing
@testable import ReviewGateCore

/// wave2 mac-diff — the diff pane's own work on an acme-sized change: a 20 000-line diff (the engine's cap) of ~300-char
/// Java lines. Thread CPU time, best of three, so a loaded machine does not fail it; the bounds are about 10× what a debug
/// build needs today (printed on failure), so a quadratic step or a per-line setup still does. Measured (debug, M-series):
/// plan 5 ms folded / 11 ms all open, max columns 98 ms, find 41 ms, 3 000 styled rows 163 ms.
@Suite struct DiffPerformanceTests {
    static func threadCPU() -> Double {
        var ts = timespec()
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts)
        return Double(ts.tv_sec) + Double(ts.tv_nsec) / 1e9
    }

    /// The best (lowest) thread-CPU seconds of `runs` runs of `body`.
    static func bestCPU(_ runs: Int = 3, _ body: () -> Void) -> Double {
        var best = Double.infinity
        for _ in 0..<runs {
            let start = threadCPU()
            body()
            best = min(best, threadCPU() - start)
        }
        return best
    }

    static let javaLine = "        final List<SettlementSummaryDto> summaries = settlementSummaryRepository.findByShopIdAndOrderDateBetween(shopId, "
        + "from, to, PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, \"orderDate\"))).stream().map(SettlementSummaryDto::from)"
        + ".collect(Collectors.toUnmodifiableList()); // 주문 요약 조회 결과 (페이지)"

    /// `count` diff lines in hunks of 2 000: context lines and del / add pairs whose changed part carries a segment.
    static func acmeDiff(lines count: Int) -> FileDiff {
        var hunks: [DiffHunk] = []
        var id = 0, no = 1
        while id < count {
            var lines = [DiffLine(id: id, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -\(no),1000 +\(no),1000 @@ class SettlementService")]
            id += 1
            while lines.count < 2_000, id < count {
                if id % 4 == 0, id + 1 < count {
                    let del = "\(javaLine) \(id)"
                    let add = "\(javaLine.replacingOccurrences(of: "DESC", with: "ASC")) \(id)"
                    let start = javaLine.utf16.distance(from: javaLine.utf16.startIndex, to: javaLine.range(of: "DESC")!.lowerBound.samePosition(in: javaLine.utf16)!)
                    lines.append(DiffLine(id: id, kind: .del, oldNo: no, newNo: nil, text: del, segments: [DiffSegment(start: start, end: start + 4)]))
                    lines.append(DiffLine(id: id + 1, kind: .add, oldNo: nil, newNo: no, text: add, segments: [DiffSegment(start: start, end: start + 3)]))
                    id += 2
                } else {
                    lines.append(DiffLine(id: id, kind: .context, oldNo: no, newNo: no, text: "\(javaLine) \(id)"))
                    id += 1
                }
                no += 1
            }
            hunks.append(DiffHunk(id: hunks.count, header: lines[0].text, lines: lines))
            no += 50
        }
        return FileDiff(oldPath: "api/SettlementService.java", newPath: "api/SettlementService.java", isBinary: false, hunks: hunks)
    }

    static let diff20k = acmeDiff(lines: 20_000)

    @Test func theFixtureIsAcmeSized() {
        #expect(Self.diff20k.allLines.count == 20_000)
        #expect(Self.javaLine.count >= 290)
        #expect(Self.diff20k.allLines.contains { !$0.segments.isEmpty })
    }

    @Test func planOfA20kLineDiff() {
        let diff = Self.diff20k
        var plan: DiffDisplayPlan?
        let folded = Self.bestCPU { plan = DiffDisplayPlan.make(diff: diff, generated: nil, fold: DiffFoldState(), fullFile: nil, truncated: true, contextEnabled: true) }
        #expect(plan?.isLarge == true && plan?.items.count == 1 + 2 * diff.hunks.count)
        var all = DiffFoldState()
        all.allOpen = true
        let open = Self.bestCPU { plan = DiffDisplayPlan.make(diff: diff, generated: nil, fold: all, fullFile: nil, truncated: true, contextEnabled: true) }
        #expect((plan?.items.count ?? 0) > 20_000)
        let generated = Self.bestCPU { plan = DiffDisplayPlan.make(diff: diff, generated: .generated, fold: DiffFoldState(), fullFile: nil, truncated: true, contextEnabled: true) }
        #expect(plan?.items.count == 1)
        #expect(folded < 0.1, "folded plan: \(folded)s")
        #expect(open < 0.15, "every hunk open: \(open)s")
        #expect(generated < 0.1, "generated fold: \(generated)s")
    }

    @Test func columnsOf20kLongLines() {
        let texts = Self.diff20k.allLines.map(\.text)
        var widest = 0
        let cpu = Self.bestCPU { widest = DiffLineText.maxColumns(texts) }
        #expect(widest >= Self.javaLine.count)
        #expect(cpu < 1.0, "max columns of 20 000 lines: \(cpu)s")
    }

    @Test func findIn20kLongLines() {
        let rows = Self.diff20k.allLines.map { DiffFind.Row(key: DiffDisplayItem.key($0), text: $0.text) }
        var hits: [String] = []
        let cpu = Self.bestCPU { hits = DiffFind.matches(query: "Direction.ASC", in: rows) }
        #expect(hits.count == Self.diff20k.allLines.count { $0.kind == .add })
        let miss = Self.bestCPU { hits = DiffFind.matches(query: "nowhere-to-be-found", in: rows) }
        #expect(hits.isEmpty)
        #expect(cpu < 0.5 && miss < 0.5, "find in 20 000 lines: \(cpu)s / \(miss)s")
    }

    /// What one screen of rows costs to draw, many times over: 3 000 rows styled with their segments and find matches.
    @Test func styledRows() {
        let lines = Array(Self.diff20k.allLines.prefix(3_000))
        var marked = 0
        let cpu = Self.bestCPU {
            marked = 0
            for line in lines {
                let find = DiffFind.ranges(of: "tenantId", in: line.text)
                let styled = DiffLineText.styled(line, base: nil, emphasis: .green, find: find, findColor: .yellow)
                marked += styled.runs.count
            }
        }
        #expect(marked > 3_000)
        #expect(cpu < 2.0, "styling 3 000 rows: \(cpu)s")
    }
}
