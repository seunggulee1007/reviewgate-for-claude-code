import Foundation
import Testing
@testable import ReviewGateCore

/// ide-nav on the Mac (docs/PROTOCOL.md §65): the symbol index on the wire, and the client-side glue of the peek, the hover
/// preview, the References tab and the palettes.
@Suite @MainActor struct IdeNavTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as! [String: Any]
    }

    private func event(_ text: String) throws -> EngineEvent {
        try JSONDecoder().decode(EngineEvent.self, from: Data(text.utf8))
    }

    // MARK: The wire

    @Test func commandsEncode() throws {
        let def = try json(.findDefinition(symbol: "save", fromPath: "src/A.java", line: 7, column: 14, receiver: "repo"))
        #expect(def["column"] as? Int == 14 && def["receiver"] as? String == "repo")
        let plain = try json(.findDefinition(symbol: "save"))
        #expect(plain["column"] == nil && plain["receiver"] == nil)
        #expect(try json(.listFiles(query: "Cart", limit: 50, filesOnly: true)) as NSDictionary
            == ["type": "list_files", "query": "Cart", "limit": 50, "filesOnly": true])
        #expect(try json(.listFiles(query: "rd"))["filesOnly"] == nil)
        #expect(try json(.documentSymbols(path: "src/A.kt")) as NSDictionary == ["type": "document_symbols", "path": "src/A.kt"])
        #expect(try json(.workspaceSymbols(query: "UsrSvc", limit: 100)) as NSDictionary
            == ["type": "workspace_symbols", "query": "UsrSvc", "limit": 100])
        #expect(try json(.definitionPreview(path: "a.ts", line: 9, after: 8)) as NSDictionary
            == ["type": "definition_preview", "path": "a.ts", "line": 9, "after": 8])
        #expect(try json(.navIndexBuild(full: true)) as NSDictionary == ["type": "nav_index_build", "full": true])
        #expect(try json(.navIndexBuild()) as NSDictionary == ["type": "nav_index_build"])
    }

    @Test func repliesDecodeLeniently() throws {
        guard case let .documentSymbols(doc) = try event(#"{"type":"document_symbols","id":"s1","path":"A.kt","language":"kotlin","symbols":[{"name":"Cart","kind":"class","path":"A.kt","line":3,"column":7,"endLine":40,"depth":0},{"name":"total","kind":"method","path":"A.kt","line":5,"column":9,"container":"Cart","signature":"fun total(): Long","depth":1},{"kind":"method"}],"truncated":false}"#)
        else { Issue.record("not document_symbols"); return }
        #expect(doc.symbols.count == 2 && doc.language == "kotlin" && doc.symbols[1].depth == 1)
        #expect(doc.symbols[1].symbol.qualifiedName == "Cart.total" && doc.symbols[0].symbol.endLine == 40)
        #expect(EngineEvent.documentSymbols(doc).replyId == "s1")

        guard case let .workspaceSymbols(ws) = try event(#"{"type":"workspace_symbols","query":"crt","symbols":[{"name":"Cart","kind":"class","path":"A.kt","line":3,"column":7,"matches":[0,2,3]}],"truncated":true,"index":{"status":"building","files":10,"symbols":99,"truncated":false,"builtAt":null,"filesTotal":40}}"#)
        else { Issue.record("not workspace_symbols"); return }
        #expect(ws.symbols.first?.matches == [0, 2, 3] && ws.truncated && ws.index.status == .building && ws.index.filesTotal == 40)

        guard case let .definitionPreview(p) = try event(#"{"type":"definition_preview","path":"A.kt","line":5,"startLine":3,"lines":["/** doc */","@Get","fun total() = 1"],"totalLines":80,"language":"kotlin","truncated":false,"symbol":{"name":"total","kind":"method","path":"A.kt","line":5,"column":5,"signature":"fun total() = 1"}}"#)
        else { Issue.record("not definition_preview"); return }
        #expect(p.focusIndex == 2 && p.symbol?.signature == "fun total() = 1" && p.totalLines == 80)

        guard case let .navIndex(n) = try event(#"{"type":"nav_index","index":{"status":"brand-new","files":"x"}}"#) else { Issue.record("not nav_index"); return }
        #expect(n.index.status == .idle && n.index.files == 0)

        guard case let .definitions(d) = try event(#"{"type":"definitions","symbol":"find","candidates":[{"path":"a/Repo.kt","line":3,"kind":"method","preview":"fun find()","score":1,"container":"CartRepository"}],"truncated":false}"#)
        else { Issue.record("not definitions"); return }
        #expect(d.candidates.first?.container == "CartRepository")
    }

    // MARK: The click's column and receiver (§65.6)

    private func hit(_ line: String, on marker: String, path: String = "A.java") -> CodeNavSymbol? {
        guard let r = line.range(of: marker) else { Issue.record("no \(marker)"); return nil }
        let offset = line.utf16.distance(from: line.utf16.startIndex, to: r.lowerBound.samePosition(in: line.utf16)!)
        return CodeNavText.symbol(in: line, at: offset, path: path)
    }

    @Test func theClickNamesItsReceiverAndColumn() {
        #expect(hit("    this.gate.refresh();", on: "refresh")?.receiver == "gate")
        #expect(hit("    this.gate.refresh();", on: "gate")?.receiver == "this")
        #expect(hit("    this.gate.refresh();", on: "refresh")?.column == 15)
        #expect(hit("val n = user?.name", on: "name", path: "A.kt")?.receiver == "user")
        #expect(hit("val n = user!!.name", on: "name", path: "A.kt")?.receiver == "user")
        #expect(hit("list.map(Repo::find)", on: "find", path: "A.kt")?.receiver == "Repo")
        #expect(hit("$row->save();", on: "save", path: "a.php")?.receiver == "$row")   // `$` is a JS name character
        #expect(hit("cartService.total(items)", on: "total")?.receiver == "cartService")
        #expect(hit("total(items)", on: "total")?.receiver == nil)   // unqualified
        #expect(hit("foo().bar()", on: "bar")?.receiver == nil)   // after `)`: nothing known
        #expect(hit("rows[0].name", on: "name")?.receiver == nil)
        #expect(hit("import com.acme.Cart;", on: "Cart")?.receiver == nil)   // a qualified name, not a member
        #expect(hit("1.5f.toInt()", on: "toInt", path: "A.kt")?.receiver == nil)
    }

    @Test func goToDefinitionSendsTheColumnAndReceiver() async {
        let store = CodeNavStore()
        var asked: [EngineCommand] = []
        await store.goToDefinition("save", from: CodeNavLocation(view: .review, path: "src/A.java", line: 9, column: 14), anchor: 1,
                                   receiver: "repo", sameReviewFile: { _ in false }) { command in
            asked.append(command)
            return .definitions(DefinitionsReply(symbol: "save", candidates: []))
        }
        #expect(asked == [.findDefinition(symbol: "save", fromPath: "src/A.java", line: 9, column: 14, receiver: "repo")])
    }

    // MARK: The peek band (§65.8)

    private func candidate(_ path: String, _ line: Int, container: String? = nil) -> DefinitionCandidate {
        DefinitionCandidate(path: path, line: line, kind: .method, preview: "fun total()", container: container)
    }

    private func preview(_ path: String, _ line: Int) -> SymbolPreviewReply {
        SymbolPreviewReply(path: path, line: line, startLine: max(1, line - 1), lines: ["/** doc */", "fun total() = 1"])
    }

    @Test func peekShowsTheFirstCandidateAndSwitches() async {
        let store = CodeNavPeekStore()
        var asked: [EngineCommand] = []
        let candidates = [candidate("a/Cart.kt", 10, container: "Cart"), candidate("b/Order.kt", 20), candidate("c/Line.kt", 5)]
        let request: (EngineCommand) async throws -> EngineEvent = { command in
            asked.append(command)
            switch command {
            case .findDefinition: return .definitions(DefinitionsReply(symbol: "total", candidates: candidates))
            case let .definitionPreview(path, line, _, _): return .definitionPreview(self.preview(path, line))
            default: throw EngineClientError.unexpectedReply("x")
            }
        }
        let row = CodeNavLocation(view: .review, path: "src/Use.kt", line: 9)
        var at = row
        at.column = 12
        await store.peek("total", row: row, rowText: "cart.total()", from: at, receiver: "cart", using: request)
        #expect(store.band?.status == .found && store.band?.selected == 0)
        #expect(store.band?.preview == .loaded(preview("a/Cart.kt", 10)))
        #expect(asked == [.findDefinition(symbol: "total", fromPath: "src/Use.kt", line: 9, column: 12, receiver: "cart"),
                          .definitionPreview(path: "a/Cart.kt", line: 10)])
        // The band hangs under that row only.
        #expect(store.shows(row: row, text: "cart.total()"))
        #expect(!store.shows(row: row, text: "other text on line 9"))
        #expect(!store.shows(row: CodeNavLocation(view: .review, path: "src/Use.kt", line: 10), text: "cart.total()"))
        // ↓ ↓ ↓ stops at the last; back up to the first: read once each.
        await store.move(1, using: request)
        await store.move(1, using: request)
        await store.move(1, using: request)
        #expect(store.band?.selected == 2 && store.band?.current?.path == "c/Line.kt")
        await store.move(-5, using: request)
        #expect(store.band?.selected == 0)
        #expect(asked.filter { if case .definitionPreview = $0 { true } else { false } }.count == 3)
        await store.select(1, using: request)
        #expect(store.band?.preview == .loaded(preview("b/Order.kt", 20)))
        #expect(IdeNavText.title(candidates[0], fallback: "total") == "Cart.kt:10 — Cart.total")
        store.close()
        #expect(store.band == nil)
    }

    @Test func peekSaysWhenNothingIsFoundAndDropsAnOlderReply() async {
        let store = CodeNavPeekStore()
        let row = CodeNavLocation(view: .projectFile, path: "A.java", line: 3)
        await store.peek("nope", row: row, rowText: "nope();", from: row, receiver: nil) { _ in
            .definitions(DefinitionsReply(symbol: "nope", candidates: []))
        }
        #expect(store.band?.status == .notFound && store.band?.preview == nil)
        await store.peek("bad", row: row, rowText: "x", from: row, receiver: nil) { _ in throw EngineClientError.refused("bad_symbol") }
        if case .failed = store.band?.status {} else { Issue.record("not failed: \(String(describing: store.band?.status))") }
        // A peek closed while it was looking leaves nothing behind.
        await store.peek("late", row: row, rowText: "late()", from: row, receiver: nil) { _ in
            store.close()
            return .definitions(DefinitionsReply(symbol: "late", candidates: [self.candidate("x.java", 1)]))
        }
        #expect(store.band == nil)
    }

    @Test func commandClickDefaultsToPeek() {
        let defaults = UserDefaults(suiteName: "IdeNavTests.\(UUID().uuidString)")!
        #expect(CodeNavCommandClick.current(defaults) == .peek)
        defaults.set("open", forKey: CodeNavCommandClick.defaultsKey)
        #expect(CodeNavCommandClick.current(defaults) == .open)
        defaults.set("odd", forKey: CodeNavCommandClick.defaultsKey)
        #expect(CodeNavCommandClick.current(defaults) == .peek)
    }

    // MARK: The hover card (§65.8)

    private func key(_ symbol: String, line: Int = 3, column: Int = 5) -> CodeNavHoverDebounce.Key {
        CodeNavHoverDebounce.Key(symbol: symbol, at: CodeNavLocation(view: .review, path: "A.kt", line: line, column: column), anchor: 7)
    }

    @Test func hoverWaitsRestartOnANewNameAndStopOnNone() {
        var d = CodeNavHoverDebounce()
        let first = d.update(key("total"))
        #expect(first == 1 && d.isCurrent(1))
        #expect(d.update(key("total")) == nil && d.isCurrent(1))   // still resting on the same name: nothing new
        let second = d.update(key("price"))
        #expect(second == 2 && !d.isCurrent(1) && d.isCurrent(2))   // a newer name: the older wait no longer counts
        #expect(d.update(nil) == nil && !d.isCurrent(2))            // off the name (or ⌘ up)
        #expect(d.update(nil) == nil)
        #expect(d.update(key("price")) == 4)                        // back on it: a fresh wait
    }

    @Test func hoverAsksOnceAfterTheRestAndDropsStaleAnswers() async throws {
        let store = CodeNavHoverStore()
        store.wait = .milliseconds(30)
        var asked: [EngineCommand] = []
        let request: @MainActor (EngineCommand) async throws -> EngineEvent = { command in
            asked.append(command)
            switch command {
            case let .findDefinition(symbol, _, _, _, _):
                return .definitions(DefinitionsReply(symbol: symbol, candidates: [self.candidate("a/\(symbol).kt", 4), self.candidate("b.kt", 1)]))
            case let .definitionPreview(path, line, _, _): return .definitionPreview(self.preview(path, line))
            default: throw EngineClientError.unexpectedReply("x")
            }
        }
        // Sliding over three names quickly: only the last one is asked for.
        store.pointer(key("a"), receiver: nil, using: request)
        store.pointer(key("b"), receiver: nil, using: request)
        store.pointer(key("c"), receiver: "repo", using: request)
        store.pointer(key("c"), receiver: "repo", using: request)
        try await Task.sleep(for: .milliseconds(250))
        #expect(asked == [.findDefinition(symbol: "c", fromPath: "A.kt", line: 3, column: 5, receiver: "repo"),
                          .definitionPreview(path: "a/c.kt", line: 4, after: CodeNavHoverStore.lines)])
        #expect(store.card?.key == key("c") && store.card?.others == 1)
        // Leaving the name takes the card away; nothing more is asked.
        store.pointer(nil, receiver: nil, using: request)
        #expect(store.card == nil)
        // Moving away before the rest is over asks nothing.
        store.pointer(key("d"), receiver: nil, using: request)
        store.pointer(nil, receiver: nil, using: request)
        try await Task.sleep(for: .milliseconds(120))
        #expect(asked.count == 2 && store.card == nil)
    }

    // MARK: The References tab (§65.8)

    @Test func f4StepsRoundTheEnds() {
        #expect(CodeNavText.step(from: nil, by: 1, count: 3) == 0)
        #expect(CodeNavText.step(from: nil, by: -1, count: 3) == 2)
        #expect(CodeNavText.step(from: 0, by: 1, count: 3) == 1)
        #expect(CodeNavText.step(from: 2, by: 1, count: 3) == 0)
        #expect(CodeNavText.step(from: 0, by: -1, count: 3) == 2)
        #expect(CodeNavText.step(from: 7, by: 1, count: 3) == 0)   // a stale pick starts over
        #expect(CodeNavText.step(from: nil, by: 1, count: 0) == nil)
    }

    @Test func referencesGroupByFileAndF4WalksThemInThatOrder() async {
        let store = CodeNavStore()
        var asked: [EngineCommand] = []
        let hits = [ReferenceHit(path: "src/Use.kt", line: 4, preview: "cart.total()"),
                    ReferenceHit(path: "src/Use.kt", line: 9, preview: "total()"),
                    ReferenceHit(path: "src/Cart.kt", line: 2, preview: "fun total()", kind: .method),
                    ReferenceHit(path: "test/CartTest.kt", line: 30, preview: "total()")]
        let request: (EngineCommand) async throws -> EngineEvent = { command in
            asked.append(command)
            switch command {
            case .findReferences: return .references(ReferencesReply(symbol: "total", hits: hits))
            case let .definitionPreview(path, line, _, _): return .definitionPreview(self.preview(path, line))
            default: throw EngineClientError.unexpectedReply("x")
            }
        }
        let reading = CodeNavLocation(view: .review, path: "src/Use.kt", line: 4)
        store.caret = reading
        await store.findReferences("total", from: reading, using: request)
        #expect(store.referenceGroups.map(\.path) == ["src/Use.kt", "src/Cart.kt", "test/CartTest.kt"])
        #expect(store.referenceGroups.map(\.hits.count) == [2, 1, 1])
        #expect(store.referenceSelection == 0 && store.referencePreview?.path == "src/Use.kt")
        #expect(store.referenceSearches == [ReferenceSearch(symbol: "total", from: reading)])

        // F4 from the first: the second, then the next file; Back once returns to where you were reading.
        let second = await store.stepReference(1, sameReviewFile: { $0.hasPrefix("src/") }, using: request)
        #expect(second?.line == 9 && store.openRequest?.location == CodeNavLocation(view: .review, path: "src/Use.kt", line: 9, column: 1))
        let third = await store.stepReference(1, sameReviewFile: { $0.hasPrefix("src/") }, using: request)
        #expect(third?.path == "src/Cart.kt" && store.referenceSelection == 2)
        let fourth = await store.stepReference(1, sameReviewFile: { $0.hasPrefix("src/") }, using: request)
        #expect(fourth?.path == "test/CartTest.kt" && store.openRequest?.location.view == .projectFile)
        let round = await store.stepReference(1, sameReviewFile: { _ in false }, using: request)
        #expect(round?.line == 4 && store.referenceSelection == 0)
        // ⇧F4 from the first goes round to the last.
        let last = await store.stepReference(-1, sameReviewFile: { _ in false }, using: request)
        #expect(last?.path == "test/CartTest.kt")
        #expect(store.history.back == [reading])
        #expect(store.goBack() == reading)

        // Picking a row reads its lines once; a newer search forgets the pick and keeps the history of searches.
        let previews = asked.filter { if case .definitionPreview = $0 { true } else { false } }.count
        await store.selectReference(3, using: request)
        #expect(asked.filter { if case .definitionPreview = $0 { true } else { false } }.count == previews)
        await store.findReferences("price", from: nil) { _ in .references(ReferencesReply(symbol: "price", hits: [])) }
        #expect(store.referenceSelection == nil && store.referenceHits.isEmpty)
        #expect(store.referenceSearches.map(\.symbol) == ["price", "total"])
    }

    // MARK: Matching for the palettes (§65.3 / §65.8)

    @Test func matchesRankAsTheEngineDoes() {
        func score(_ q: String, _ n: String) -> Int? { NavFuzzy.match(q, in: n)?.score }
        #expect(score("total", "total") == 1000)
        #expect(score("tot", "total") == 798)                // a prefix, minus the 2 characters beyond it
        #expect(score("TOTAL", "total") == 780)
        #expect(score("TOT", "total") == 758)
        #expect(score("UsrSvc", "UserService") == 595)       // camel humps
        #expect(NavFuzzy.match("UsrSvc", in: "UserService")?.offsets == [0, 1, 3, 4, 7, 9])
        #expect(NavFuzzy.match("uS", in: "userService")?.score == 751)   // a prefix ignoring case comes before humps
        #expect(NavFuzzy.match("uSvc", in: "userService")?.offsets == [0, 4, 7, 9])
        #expect(NavFuzzy.match("NPE", in: "NullPointerException")?.offsets == [0, 4, 11])
        #expect(score("Service", "UserService") == 446)      // a substring at a word start
        #expect(score("ervice", "UserService") == 395)       // inside a word
        #expect(score("usrv", "userService") == 193)         // the letters in order
        #expect(score("x", "userService") == nil)            // one character: no subsequence
        #expect(score("zz", "total") == nil)
        #expect(NavFuzzy.wordStarts(Array("HTTPServer".utf16)) == [0, 4])
        #expect(NavFuzzy.wordStarts(Array("cart_total2".utf16)) == [0, 5, 10])
    }

    @Test func goToFileMarksTheNameFirst() {
        #expect(NavFuzzy.fileMarks("cart", path: "src/cart/CartService.java").name == [0, 1, 2, 3])
        #expect(NavFuzzy.fileMarks("cart", path: "src/cart/CartService.java").folder.isEmpty)
        #expect(NavFuzzy.fileMarks("CS", path: "src/CartService.java").name == [0, 4])
        #expect(NavFuzzy.fileMarks("UsrSvc.java", path: "app/UserService.java").name.prefix(6) == [0, 1, 3, 4, 7, 9])
        let both = NavFuzzy.fileMarks("cart/svc", path: "src/cart/CartService.java")
        #expect(!both.folder.isEmpty && !both.name.isEmpty)
        #expect(NavFuzzy.fileMarks("", path: "a.java") == ([], []))
        let marked = NavFuzzy.emphasized("CartService.java", offsets: [0, 4])
        #expect(marked.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }.count == 2)
    }

    @Test func goToFileOpensAChangedFileInItsDiff() {
        let store = CodeNavStore()
        let reading = CodeNavLocation(view: .projectFile, path: "README.md", line: 3)
        store.caret = reading
        store.openFile("src/Cart.kt", line: nil, sameReviewFile: { $0 == "src/Cart.kt" })
        #expect(store.openRequest?.location == CodeNavLocation(view: .review, path: "src/Cart.kt"))
        store.openFile("docs/a.md", line: 12, sameReviewFile: { _ in false })
        #expect(store.openRequest?.location == CodeNavLocation(view: .projectFile, path: "docs/a.md", line: 12))
        #expect(store.history.back == [reading, CodeNavLocation(view: .review, path: "src/Cart.kt")])
    }

    @Test func symbolsInFileFilterInFileOrderAndPickTheBest() {
        func sym(_ name: String, _ line: Int, depth: Int, container: String? = nil) -> DocumentSymbol {
            DocumentSymbol(NavSymbol(name: name, kind: depth == 0 ? .class : .method, path: "Cart.kt", line: line, container: container), depth: depth)
        }
        let outline = [sym("CartService", 1, depth: 0), sym("totalPrice", 4, depth: 1, container: "CartService"),
                       sym("total", 9, depth: 1, container: "CartService"), sym("clear", 12, depth: 1, container: "CartService")]
        let all = NavFuzzy.filterOutline(outline, query: " ")
        #expect(all.rows.count == 4 && all.best == 0 && all.rows.allSatisfy { $0.offsets.isEmpty })
        let tot = NavFuzzy.filterOutline(outline, query: "total")
        #expect(tot.rows.map(\.symbol.symbol.name) == ["totalPrice", "total"])   // file order kept
        #expect(tot.best == 1 && tot.rows[1].offsets == [0, 1, 2, 3, 4])          // the exact one is picked
        let humps = NavFuzzy.filterOutline(outline, query: "tP")
        #expect(humps.rows.map(\.symbol.symbol.name) == ["totalPrice"] && humps.rows[0].offsets == [0, 5])
        #expect(NavFuzzy.filterOutline(outline, query: "zz").rows.isEmpty && NavFuzzy.filterOutline(outline, query: "zz").best == nil)
        #expect(NavFuzzy.filterOutline([], query: "").best == nil)
    }

    @Test func symbolsInProjectSayWhatIsMissing() {
        let building = NavIndexState(status: .building, files: 120, filesTotal: 800)
        #expect(NavFuzzy.projectNotes(nil, index: building).count == 1)
        let reply = WorkspaceSymbolsReply(query: "a", symbols: [], truncated: true, index: NavIndexState(status: .ready, truncated: true))
        #expect(NavFuzzy.projectNotes(reply, index: NavIndexState(status: .ready)).count == 2)
        #expect(NavFuzzy.projectNotes(WorkspaceSymbolsReply(query: "a", symbols: []), index: NavIndexState(status: .ready)).isEmpty)
        #expect(NavPalette.file("a.kt").id != NavPalette.project.id)
    }

    @Test func theStateSliceFollowsTheIndex() async {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "IdeNavTests.\(UUID().uuidString)")!)
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.nav = NavState(index: NavIndexState(status: .building, files: 1, filesTotal: 10))
        app.handle(.state(s))
        #expect(app.navIndex?.filesTotal == 10 && app.navIndexBuilding)
        s.seq = 2
        s.nav = NavState(index: NavIndexState(status: .ready, files: 10, symbols: 99))
        app.handle(.state(s))
        #expect(app.navIndex?.status == .ready && !app.navIndexBuilding)
    }

    @Test func stateCarriesTheIndex() throws {
        var s = ReviewState.empty
        s.nav = NavState(index: NavIndexState(status: .building, files: 3, filesTotal: 9))
        let back = try JSONDecoder().decode(ReviewState.self, from: JSONEncoder().encode(s))
        #expect(back.nav?.index.status == .building && back.nav?.index.filesTotal == 9)
        // An older engine sends no `nav`.
        let old = try JSONDecoder().decode(ReviewState.self, from: JSONEncoder().encode(ReviewState.empty))
        #expect(old.nav == nil)
    }
}
