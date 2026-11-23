import Foundation
import Testing
@testable import ReviewGateCore

/// code-nav: go to definition, find references, Back / Forward and Open in IDE on the Mac (docs/PROTOCOL.md §62).
@Suite @MainActor struct CodeNavTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "CodeNavTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, root: String = "/repo", changed: [String] = []) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: root, root: root, name: "repo", branch: "main", remoteURL: nil)
        s.changedFiles = changed.map { ChangedFile(path: $0, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .pending) }
        return s
    }

    /// The symbol clicked at the first occurrence of `marker` in `line` (its first character).
    private func click(_ line: String, on marker: String, in path: String = "A.java", plus: Int = 0) -> String? {
        guard let r = line.range(of: marker) else { Issue.record("no \(marker)"); return nil }
        let offset = line.utf16.distance(from: line.utf16.startIndex, to: r.lowerBound.samePosition(in: line.utf16)!) + plus
        return CodeNavText.symbol(in: line, at: offset, path: path)?.symbol
    }

    // MARK: The name under the pointer

    @Test func javaAndKotlinNames() {
        let java = "    private final CartService cartService = new CartService(repo);"
        #expect(click(java, on: "CartService") == "CartService")
        #expect(click(java, on: "cartService", plus: 4) == "cartService")
        #expect(click(java, on: "new") == nil)   // a keyword
        #expect(click(java, on: "private") == nil)
        #expect(click(java, on: " = ", plus: 1) == nil)   // not on a name
        // a.b.C: the package parts before a capitalised name.
        #expect(click("import com.acme.cart.CartService;", on: "CartService", plus: 3) == "com.acme.cart.CartService")
        #expect(click("a.b.C x;", on: "C") == "a.b.C")
        #expect(click("import com.acme.cart.CartService;", on: "acme") == "acme")
        #expect(click("this.cartService.save(item);", on: "save") == "save")   // a member, not a package
        #expect(click("return 42;", on: "42") == nil)
        let kotlin = "fun List<Item>.totalPrice(): Long = sumOf { it.price }"
        #expect(click(kotlin, on: "totalPrice", in: "Cart.kt") == "totalPrice")
        #expect(click(kotlin, on: "fun", in: "Cart.kt") == nil)
        // The underline covers the clicked part only.
        let line = "import com.acme.Cart;"
        let hit = CodeNavText.symbol(in: line, at: 17, path: "A.java")
        #expect(hit == CodeNavSymbol(symbol: "com.acme.Cart", range: 16..<20))
        #expect(CodeNavText.symbol(in: line, at: 999, path: "A.java") == nil)
        #expect(CodeNavText.symbol(in: "// 장바구니 total", at: 3, path: "A.java") == nil)   // Hangul is not a name
    }

    @Test func javascriptVueAndJspNames() {
        #expect(click("const total = items.reduce((s, i) => s + i.price, 0)", on: "reduce", in: "cart.js") == "reduce")
        #expect(click("this.$store.dispatch('load')", on: "$store", in: "App.vue") == "$store")
        // Vue templates: kebab-case and PascalCase tags, open or closing.
        let vue = #"    <my-widget :items="items" @select="onSelect"></my-widget>"#
        #expect(click(vue, on: "widget", in: "Page.vue") == "my-widget")
        #expect(click(vue, on: "my-widget>", in: "Page.vue") == "my-widget")
        #expect(click(vue, on: "onSelect", in: "Page.vue") == "onSelect")
        #expect(click("<CartRow v-for=\"row in rows\" />", on: "CartRow", in: "Page.vue") == "CartRow")
        #expect(click("import MyWidget from './MyWidget.vue'", on: "MyWidget.vue", in: "Page.vue") == "./MyWidget.vue")
        #expect(click("components: { 'my-widget': MyWidget }", on: "widget", in: "Page.vue") == "my-widget")
        // The minus of an expression is not a kebab name outside a tag.
        #expect(click("const n = total-discount", on: "discount", in: "cart.js") == "discount")
        // JSP: custom tags, includes, scriptlets.
        #expect(click(#"<c:out value="${cart.total}"/>"#, on: "out", in: "cart.jsp") == "c:out")
        #expect(click(#"<c:out value="${cart.total}"/>"#, on: "c:", in: "cart.jsp") == "c:out")
        #expect(click(#"<ui:panel title="x">"#, on: "panel", in: "list.jsp") == "ui:panel")
        #expect(click(#"<%@ include file="/WEB-INF/x.jsp" %>"#, on: "x.jsp", in: "list.jsp") == "/WEB-INF/x.jsp")
        #expect(click(#"<jsp:include page="row.jsp"/>"#, on: "row", in: "list.jsp") == "row.jsp")
        #expect(click(#"<% CartService svc = (CartService) ctx.getBean("cartService"); %>"#, on: "getBean", in: "list.jsp") == "getBean")
        #expect(click(#"<c:set var="total" value="${0}"/>"#, on: "total", in: "list.jsp") == "total")   // a word in quotes
        #expect(click(#"<a href="https://example.com/x.jsp">"#, on: "example", in: "list.jsp") == "example")   // not a path
        // In Java, '<' is a generic, not a tag.
        #expect(click("List<my-thing> x", on: "thing", in: "A.java") == "thing")
    }

    // MARK: What a reply leads to

    @Test func oneOpensSeveralPeekNoneSaysSo() {
        let a = DefinitionCandidate(path: "src/A.java", line: 3, column: 14, kind: .class, preview: "public class A {", score: 120)
        let b = DefinitionCandidate(path: "test/A.java", line: 1, kind: .class, preview: "class A", score: 80)
        #expect(CodeNavText.outcome(DefinitionsReply(symbol: "A", candidates: [a])) == .open(a))
        #expect(CodeNavText.outcome(DefinitionsReply(symbol: "A", candidates: [a, b])) == .peek([a, b]))
        #expect(CodeNavText.outcome(DefinitionsReply(symbol: "A", candidates: [])) == .notFound)
        #expect(CodeNavText.limits(DefinitionsReply(symbol: "A", candidates: [a, b])).isEmpty)
        #expect(CodeNavText.limits(DefinitionsReply(symbol: "A", candidates: [a, b], truncated: true, timedOut: true)).count == 2)
        let refs = ReferencesReply(symbol: "A", hits: [ReferenceHit(path: "x", line: 1, preview: "A"), ReferenceHit(path: "y", line: 2, preview: "A"),
                                                       ReferenceHit(path: "x", line: 9, preview: "A")])
        #expect(refs.files == 2)
        #expect(CodeNavText.groups(refs.hits).map(\.path) == ["x", "y"] && CodeNavText.groups(refs.hits)[0].hits.map(\.line) == [1, 9])
        #expect(CodeNavText.summary(refs).hasPrefix("3 references in 2 files"))
        #expect(CodeNavText.summary(ReferencesReply(symbol: "A", hits: [])) == "No references")
        #expect(CodeNavText.refusal(code: "bad_symbol", fallback: "x") != "x")
        #expect(CodeNavText.refusal(code: "unknown_command", fallback: "x") == SessionToolsSupport.updateReason)
        let failed = CodeNavText.message(EngineClientError.refused("search_failed:fatal: bad", code: "search_failed"))
        #expect(failed.hasSuffix("fatal: bad") && !failed.hasPrefix("search_failed"))
    }

    @Test func wireDecodesLenientlyAndCommandsEncode() throws {
        let json = #"{"type":"definitions","id":"d1","symbol":"A","candidates":[{"path":"a/A.java","line":3,"column":14,"kind":"class","preview":"class A","score":120},{"line":2},{"path":"b.vue","kind":"brand-new"}],"truncated":true}"#
        guard case let .definitions(defs) = try JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8)) else { Issue.record("not definitions"); return }
        #expect(defs.candidates.count == 2 && defs.candidates[0].kind == .class && defs.candidates[1].kind.rawValue == "brand-new")
        #expect(defs.candidates[1].line == 1 && defs.truncated && !defs.timedOut && EngineEvent.definitions(defs).replyId == "d1")
        let refsJSON = #"{"type":"references","id":"r1","symbol":"A","hits":[{"path":"x","line":4,"column":2,"preview":"A a","kind":"field"},{"path":"y","line":1,"preview":"A"}],"files":2,"truncated":false,"timedOut":true}"#
        guard case let .references(refs) = try JSONDecoder().decode(EngineEvent.self, from: Data(refsJSON.utf8)) else { Issue.record("not references"); return }
        #expect(refs.hits.map(\.kind) == [DefinitionKind(rawValue: "field"), nil] && refs.files == 2 && refs.timedOut)

        let def = try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommand.findDefinition(symbol: "a.b.C", fromPath: "src/X.java", line: 7))) as! [String: Any]
        #expect(def["type"] as? String == "find_definition" && def["symbol"] as? String == "a.b.C" && def["fromPath"] as? String == "src/X.java" && def["line"] as? Int == 7)
        let ref = try JSONSerialization.jsonObject(with: JSONEncoder().encode(EngineCommand.findReferences(symbol: "C"))) as! [String: Any]
        #expect(ref["type"] as? String == "find_references" && ref["fromPath"] == nil && ref["limit"] == nil)
    }

    // MARK: History

    @Test func backAndForwardWalkTheJumps() {
        var h = CodeNavHistory()
        let a = CodeNavLocation(view: .review, path: "A.java", line: 10)
        let b = CodeNavLocation(view: .projectFile, path: "B.java", line: 3)
        let c = CodeNavLocation(view: .projectFile, path: "C.java", line: 8)
        #expect(!h.canGoBack && h.goBack(from: a) == nil)
        h.push(a)   // A → B
        h.push(a)   // the same place twice is kept once
        #expect(h.back == [a])
        #expect(h.goBack(from: b) == a && h.forward == [b] && !h.canGoBack)
        #expect(h.goForward(from: a) == b && h.back == [a] && !h.canGoForward)
        h.push(b)   // B → C
        #expect(h.goBack(from: c) == b && h.canGoForward)
        h.push(b)   // a new jump from B forgets Forward
        #expect(!h.canGoForward)
        for i in 0..<(CodeNavHistory.limit + 5) { h.push(CodeNavLocation(view: .review, path: "f\(i)", line: i)) }
        #expect(h.back.count == CodeNavHistory.limit && h.back.last?.path == "f\(CodeNavHistory.limit + 4)")
    }

    // MARK: Open in IDE

    @Test func ideLinksEncodeSpacesAndHangul() {
        let path = "/Users/dev/My Project/한글 & co/Cart+Item.java"
        #expect(IDELink.vscode(path: path, line: 12, column: 5)?.absoluteString
                == "vscode://file/Users/dev/My%20Project/%ED%95%9C%EA%B8%80%20&%20co/Cart+Item.java:12:5")
        #expect(IDELink.intellij(path: path, line: 12)?.absoluteString
                == "idea://open?file=/Users/dev/My%20Project/%ED%95%9C%EA%B8%80%20%26%20co/Cart%2BItem.java&line=12")
        #expect(IDELink.vscode(path: "/a/#b?.js", line: 0)?.absoluteString == "vscode://file/a/%23b%3F.js:1:1")
        #expect(IDELink.vscode(path: "relative/A.java", line: 1) == nil)
        #expect(IDELink.xedArguments(path: path, line: 3) == ["--line", "3", path])
        #expect(IDELink.absolutePath(root: "/work/acme", relative: "src/A.java") == "/work/acme/src/A.java")
        #expect(IDELink.absolutePath(root: "/work/acme/", relative: "src/A.java") == "/work/acme/src/A.java")
        #expect(IDELink.prefersJetBrains(rootEntries: ["pom.xml", "src"], paths: []))
        #expect(IDELink.prefersJetBrains(rootEntries: ["package.json"], paths: ["web/WEB-INF/list.jsp"]))
        #expect(!IDELink.prefersJetBrains(rootEntries: ["package.json"], paths: ["src/App.vue", "src/main.ts"]))
    }

    // MARK: The store

    @Test func oneCandidateOpensAndBackReturns() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, changed: ["src/Cart.java"])))
        var asked: [EngineCommand] = []
        app.replySink = { command in
            asked.append(command)
            guard case let .findDefinition(symbol, _, _, _, _) = command else { throw EngineClientError.unexpectedReply("x") }
            let path = symbol == "Cart" ? "src/Cart.java" : "src/Other.java"
            return .definitions(DefinitionsReply(symbol: symbol, candidates: [DefinitionCandidate(path: path, line: 4, column: 14, kind: .class, preview: "class \(symbol)")]))
        }
        let from = CodeNavLocation(view: .projectFile, path: "src/Use.java", line: 9)
        app.codeNav.caret = from
        await app.goToDefinition("Cart", from: from, anchor: 1)
        #expect(asked == [.findDefinition(symbol: "Cart", fromPath: "src/Use.java", line: 9)])
        #expect(app.codeNav.popup == nil)
        // A changed file opens in the review's diff.
        #expect(app.codeNav.openRequest?.location == CodeNavLocation(view: .review, path: "src/Cart.java", line: 4, column: 14))
        await app.goToDefinition("Other", from: CodeNavLocation(view: .review, path: "src/Cart.java", line: 4), anchor: 2)
        #expect(app.codeNav.openRequest?.location.view == .projectFile)
        // From a past round's diff, even a changed file opens read-only (Back closes it again).
        await app.goToDefinition("Cart", from: CodeNavLocation(view: .other, path: "src/Old.java", line: 1), anchor: 3)
        #expect(app.codeNav.openRequest?.location.view == .projectFile)
        let tick = app.codeNav.openRequest?.tick ?? 0
        #expect(app.codeNav.goBack()?.view == .other && app.codeNav.openRequest?.tick == tick + 1)
        #expect(app.codeNav.goBack()?.path == "src/Cart.java")
        #expect(app.codeNav.goBack() == from && !app.codeNav.history.canGoBack)
        #expect(app.codeNav.goForward()?.path == "src/Cart.java")
    }

    @Test func severalPeekNoneSaysSoAndARefusalSaysWhy() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        let a = DefinitionCandidate(path: "a/A.kt", line: 2, kind: .class, preview: "class A")
        let b = DefinitionCandidate(path: "b/A.kt", line: 5, kind: .class, preview: "class A")
        app.replySink = { command in
            guard case let .findDefinition(symbol, _, _, _, _) = command else { throw EngineClientError.unexpectedReply("x") }
            switch symbol {
            case "A": return .definitions(DefinitionsReply(symbol: symbol, candidates: [a, b], truncated: true))
            case "Z": return .definitions(DefinitionsReply(symbol: symbol, candidates: []))
            default: throw EngineClientError.refused("bad_symbol", code: "bad_symbol")
            }
        }
        let from = CodeNavLocation(view: .review, path: "x/Use.kt", line: 3)
        await app.goToDefinition("A", from: from, anchor: 7)
        guard case let .peek(reply)? = app.codeNav.popup?.content else { Issue.record("no peek"); return }
        #expect(reply.candidates == [a, b] && app.codeNav.popup?.anchor == 7 && app.codeNav.openRequest == nil)
        app.openNavPlace(path: b.path, line: b.line, from: app.codeNav.popup?.from)
        #expect(app.codeNav.popup == nil && app.codeNav.openRequest?.location.path == "b/A.kt" && app.codeNav.history.back == [from])
        await app.goToDefinition("Z", from: from, anchor: 8)
        #expect(app.codeNav.popup?.content == .notFound)
        await app.goToDefinition("bad name", from: from, anchor: 9)
        #expect(app.codeNav.popup?.content == .failed(CodeNavText.refusal(code: "bad_symbol", fallback: "")))
        app.codeNav.dismissPopup()
        #expect(app.codeNav.popup == nil)
    }

    @Test func referencesFillThePanelAndAnotherProjectClearsEverything() async {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1)))
        var asked: [EngineCommand] = []
        app.replySink = { command in
            asked.append(command)
            return .references(ReferencesReply(symbol: "total", hits: [ReferenceHit(path: "a.js", line: 1, preview: "total"),
                                                                        ReferenceHit(path: "b.js", line: 3, preview: "total", kind: .function)]))
        }
        await app.findReferences("total", from: CodeNavLocation(view: .projectFile, path: "a.js", line: 1))
        #expect(asked == [.findReferences(symbol: "total", fromPath: "a.js")])
        #expect(app.codeNav.referencesShown && app.codeNav.referenceGroups.map(\.path) == ["a.js", "b.js"] && !app.codeNav.referencesLoading)
        app.replySink = { _ in throw EngineClientError.refused("unknown command: find_references", code: "unknown_command") }
        await app.findReferences("total", from: nil)
        #expect(app.codeNav.referencesError == SessionToolsSupport.updateReason && app.codeNav.references == nil)
        app.codeNav.caret = CodeNavLocation(view: .review, path: "a.js")
        app.handle(.state(snapshot(seq: 2, root: "/other")))
        #expect(!app.codeNav.referencesShown && app.codeNav.caret == nil && !app.codeNav.history.canGoBack)
    }
}
