import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §70.1: ⌃R over the prompt history.
@Suite struct PromptHistorySearchTests {
    let entries = ["fix the login test", "add a README", "Fix the build", "run the tests"]

    @Test func nothingTypedShowsNothing() {
        let s = PromptHistorySearch(entries: entries, original: "draft")
        #expect(s.match == nil)
        #expect(!s.failing)
        #expect(s.position == nil)
        #expect(s.accepted == "draft")
    }

    @Test func newestMatchFirstCaseInsensitive() {
        var s = PromptHistorySearch(entries: entries, original: "")
        s.setQuery("fix")
        #expect(s.match == "Fix the build")
        #expect(s.position?.index == 1 && s.position?.count == 2)
        let o = s.older(); #expect(o)
        #expect(s.match == "fix the login test")
        #expect(s.position?.index == 2 && s.position?.count == 2)
        let o2 = s.older(); #expect(!o2)   // the oldest: stays
        #expect(s.match == "fix the login test")
        let n = s.newer(); #expect(n)
        #expect(s.match == "Fix the build")
        let n2 = s.newer(); #expect(!n2)
    }

    @Test func typingMoreStartsOverAtTheNewest() {
        var s = PromptHistorySearch(entries: entries, original: "")
        s.setQuery("t")
        s.older()
        s.setQuery("te")
        #expect(s.match == "run the tests")
        s.setQuery("te")   // the same text: the place is kept
        #expect(s.position!.index == 1)
    }

    @Test func failingSearchGivesTheDraftBack() {
        var s = PromptHistorySearch(entries: entries, original: "half typed")
        s.setQuery("nothing like it")
        #expect(s.failing)
        #expect(s.match == nil)
        #expect(s.accepted == "half typed")
    }

    @Test func highlightsTheFirstPlace() {
        let text = "Fix the build, fix it"
        let r = PromptHistorySearch.highlight(in: text, query: "FIX")
        #expect(r.map { String(text[$0]) } == "Fix")
        #expect(PromptHistorySearch.highlight(in: text, query: "") == nil)
    }
}
