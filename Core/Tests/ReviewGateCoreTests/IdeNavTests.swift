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
