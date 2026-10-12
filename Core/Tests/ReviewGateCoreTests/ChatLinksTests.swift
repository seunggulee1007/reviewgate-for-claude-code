import Foundation
import Testing
@testable import ReviewGateCore

/// Links in chat text: bare web URLs, file references (`Foo.java:42`, `src/…/Foo.java#L42`) and markdown link
/// destinations, resolved against the project root only when the file is there.
@Suite struct ChatLinksTests {
    private func found(_ text: String) -> [(String, ChatLinks.Target)] {
        let ns = text as NSString
        return ChatLinks.scan(text).map { (ns.substring(with: $0.range), $0.target) }
    }

    private func files(_ text: String) -> [ChatLinks.FileRef] {
        ChatLinks.scan(text).compactMap { if case let .file(ref) = $0.target { ref } else { nil } }
    }

    private func urls(_ text: String) -> [String] {
        ChatLinks.scan(text).compactMap { if case let .web(url) = $0.target { url.absoluteString } else { nil } }
    }

    // MARK: Web URLs

    @Test func bareURLsAreFoundWithoutTheirTrailingPunctuation() {
        #expect(urls("See https://example.com/a/b?x=1.") == ["https://example.com/a/b?x=1"])
        #expect(urls("(docs: http://go.dev/doc), then") == ["http://go.dev/doc"])
        #expect(urls("https://en.wikipedia.org/wiki/Swift_(language) is it") == ["https://en.wikipedia.org/wiki/Swift_(language)"])
        #expect(urls("two: https://a.io, https://b.io!") == ["https://a.io", "https://b.io"])
        #expect(urls("HTTPS://Example.com/Path") == ["HTTPS://Example.com/Path"])
    }

    @Test func aURLEndsAtKoreanTextAndNeedsAHost() {
        #expect(urls("https://ghe.example.com/org/repo/pull/12에서 확인") == ["https://ghe.example.com/org/repo/pull/12"])
        #expect(urls("https:// nothing") == [])
        #expect(urls("xhttps://glued.example") == [])   // not at a word start
        #expect(urls("ftp://files.example") == [])
    }

    @Test func theRangeCoversTheURLInUTF16() throws {
        let text = "한글 https://a.io/p 끝"
        let match = try #require(ChatLinks.scan(text).first)
        #expect((text as NSString).substring(with: match.range) == "https://a.io/p")
    }

    // MARK: File references

    @Test func fileReferencesKeepTheirLineAndColumn() {
        #expect(files("at src/main/java/com/acme/Foo.java:42 and Bar.kt:7:3") == [
            ChatLinks.FileRef(path: "src/main/java/com/acme/Foo.java", line: 42),
            ChatLinks.FileRef(path: "Bar.kt", line: 7, column: 3),
        ])
        #expect(files("App/UI/Diff/DiffView.swift#L120") == [ChatLinks.FileRef(path: "App/UI/Diff/DiffView.swift", line: 120)])
        #expect(files("lines Foo.ts:10-20.") == [ChatLinks.FileRef(path: "Foo.ts", line: 10)])
        #expect(files("plain README.md, .env and ./scripts/run.sh") == [
            ChatLinks.FileRef(path: "README.md"), ChatLinks.FileRef(path: ".env"), ChatLinks.FileRef(path: "./scripts/run.sh"),
        ])
    }

    @Test func aReferenceEndsAtKoreanAndPunctuation() {
        #expect(found("AppState.swift:1186에서 바뀜").map(\.0) == ["AppState.swift:1186"])
        #expect(found("(Foo.java:42), [Bar.java]").map(\.0) == ["Foo.java:42", "Bar.java"])
        #expect(found("끝은 Foo.java.").map(\.0) == ["Foo.java"])
    }

    @Test func numbersAndVersionsAreNotFiles() {
        #expect(files("version 0.4.9, v2.0 and 1.5x") == [])
        #expect(files("Foo.java:42abc") == [])
        #expect(files("a dir src/main/") == [])
        // A name without an extension only counts with a line after it.
        #expect(files("Makefile:12 but not Makefile") == [ChatLinks.FileRef(path: "Makefile", line: 12)])
    }

    @Test func aURLIsNotAlsoAFile() {
        let all = found("https://example.com/src/Foo.java:42 then Foo.java:42")
        #expect(all.map(\.0) == ["https://example.com/src/Foo.java:42", "Foo.java:42"])
        if case .web = all.first?.1 {} else { Issue.record("the first match should be the URL") }
    }

    // MARK: Markdown link destinations

    @Test func linkDestinationsNamingAFile() {
        #expect(ChatLinks.fileRef(linkDestination: "src/Foo.java#L42") == ChatLinks.FileRef(path: "src/Foo.java", line: 42))
        #expect(ChatLinks.fileRef(linkDestination: "./Foo.java:42:7") == ChatLinks.FileRef(path: "./Foo.java", line: 42, column: 7))
        #expect(ChatLinks.fileRef(linkDestination: "docs/My%20Notes.md") == ChatLinks.FileRef(path: "docs/My Notes.md"))
        #expect(ChatLinks.fileRef(linkDestination: "file:///repo/a.swift") == ChatLinks.FileRef(path: "/repo/a.swift"))
        #expect(ChatLinks.fileRef(linkDestination: "https://example.com/a.swift") == nil)
        #expect(ChatLinks.fileRef(linkDestination: "mailto:me@example.com") == nil)
        #expect(ChatLinks.fileRef(linkDestination: "src/") == nil)
    }

    // MARK: Resolve

    @Test func resolveFindsTheFileUnderTheRootOnly() {
        let disk: Set<String> = ["/repo/src/Foo.java", "/repo/.env", "/elsewhere/x.swift"]
        func resolve(_ path: String, _ candidates: [String] = []) -> String? {
            ChatLinks.resolve(ChatLinks.FileRef(path: path), root: "/repo/", candidates: { candidates }, exists: { disk.contains($0) })
        }
        #expect(resolve("src/Foo.java") == "src/Foo.java")
        #expect(resolve("./src/../src/Foo.java") == "src/Foo.java")
        #expect(resolve("/repo/src/Foo.java") == "src/Foo.java")
        #expect(resolve(".env") == ".env")
        #expect(resolve("/elsewhere/x.swift") == nil)   // outside the root
        #expect(resolve("../elsewhere/x.swift") == nil)
        #expect(resolve("~/x.swift") == nil)
        #expect(resolve("src/Missing.java") == nil)
    }

    @Test func aBareNameResolvesThroughTheOneKnownPathEndingWithIt() {
        let disk: Set<String> = ["/repo/a/Foo.java", "/repo/b/Foo.java", "/repo/main/java/Bar.java"]
        func resolve(_ path: String, _ candidates: [String]) -> String? {
            ChatLinks.resolve(ChatLinks.FileRef(path: path), root: "/repo", candidates: { candidates }, exists: { disk.contains($0) })
        }
        #expect(resolve("Bar.java", ["main/java/Bar.java", "x/NotBar.java"]) == "main/java/Bar.java")
        #expect(resolve("java/Bar.java", ["main/java/Bar.java"]) == "main/java/Bar.java")   // a partial path
        #expect(resolve("Foo.java", ["a/Foo.java", "b/Foo.java"]) == nil)   // two of them: none is linked
        #expect(resolve("Foo.java", ["a/Foo.java", "a/Foo.java"]) == "a/Foo.java")
        #expect(resolve("Gone.java", ["old/Gone.java"]) == nil)   // known, but no longer on disk
        #expect(resolve("Bar.java", ["/abs/main/java/Bar.java"]) == nil)   // absolute candidates are not the root's
    }

    // MARK: In-app links

    @Test func fileLinksRoundTripTheirPathAndLine() throws {
        let url = try #require(ChatLinks.fileURL(path: "src/My File.java", line: 42))
        #expect(url.scheme == ChatLinks.fileScheme)
        let target = try #require(ChatLinks.fileTarget(url))
        #expect(target.path == "src/My File.java" && target.line == 42)
        let plain = try #require(ChatLinks.fileURL(path: "README.md", line: nil))
        #expect(ChatLinks.fileTarget(plain)?.path == "README.md" && ChatLinks.fileTarget(plain)?.line == nil)
        #expect(ChatLinks.fileTarget(URL(string: "https://example.com/a")!) == nil)
    }

    @Test func theParsersAutolinksAreToldFromWrittenLinks() throws {
        // What `AttributedString(markdown:)` makes of "…/pull/12에서 확인": the Korean inside the link.
        let runOn = try #require(URL(string: "https://ghe.example.com/org/repo/pull/12%EC%97%90%EC%84%9C"))
        #expect(ChatLinks.isAutolink(text: "https://ghe.example.com/org/repo/pull/12에서", url: runOn))
        #expect(ChatLinks.isAutolink(text: "www.example.com", url: URL(string: "http://www.example.com")!))
        #expect(!ChatLinks.isAutolink(text: "the docs", url: URL(string: "https://example.com/docs")!))
        #expect(!ChatLinks.isAutolink(text: "me@example.com", url: URL(string: "mailto:me@example.com")!))   // kept: a mail link
        // The parser's bare text, scanned, ends at the Korean.
        #expect(urls("https://ghe.example.com/org/repo/pull/12에서") == ["https://ghe.example.com/org/repo/pull/12"])
    }

    @Test func onlyWebAndMailLinksGoToTheSystem() {
        #expect(ChatLinks.isWeb(URL(string: "https://example.com")!))
        #expect(ChatLinks.isWeb(URL(string: "HTTP://example.com")!))
        #expect(ChatLinks.isWeb(URL(string: "mailto:me@example.com")!))
        #expect(!ChatLinks.isWeb(URL(string: "vscode://file/a")!))
        #expect(!ChatLinks.isWeb(URL(string: "reviewgate-file:a.swift")!))
    }
}
