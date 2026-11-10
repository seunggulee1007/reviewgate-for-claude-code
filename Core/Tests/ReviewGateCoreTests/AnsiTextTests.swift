import Foundation
import SwiftUI
import Testing
@testable import ReviewGateCore

/// MARK: wave6 w6-statusline — §44.2: the status line's ANSI rules, checked against the vectors Electron's
/// renderer/ansi.test.ts reads too (`engine/test/fixtures/ansiVectors.json`).
@Suite struct AnsiTextTests {
    private static let url: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/test/fixtures/ansiVectors.json")
    }()

    private static var fixture: [String: Any] {
        let data = (try? Data(contentsOf: url)) ?? Data()
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private static func color(_ v: Any?) -> AnsiColor? {
        if let n = v as? Int { return .index(n) }
        if let s = v as? String, s.hasPrefix("#"), let x = UInt32(s.dropFirst(), radix: 16) {
            return .rgb(UInt8((x >> 16) & 0xFF), UInt8((x >> 8) & 0xFF), UInt8(x & 0xFF))
        }
        return nil
    }

    /// A fixture run (`{text, fg?, bg?, bold?, …, link?}`) as an `AnsiRun`.
    private static func run(_ o: [String: Any]) -> AnsiRun {
        let flag = { (k: String) in o[k] as? Bool ?? false }
        return AnsiRun(o["text"] as? String ?? "", AnsiStyle(fg: color(o["fg"]), bg: color(o["bg"]), bold: flag("bold"), dim: flag("dim"),
                                                            italic: flag("italic"), underline: flag("underline"), strike: flag("strike"),
                                                            inverse: flag("inverse"), hidden: flag("hidden"), link: o["link"] as? String))
    }

    @Test func parseVectors() throws {
        let cases = try #require(Self.fixture["parse"] as? [[String: Any]])
        #expect(cases.count >= 20)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let lines = try #require(c["lines"] as? [String])
            let want = try #require(c["runs"] as? [[[String: Any]]]).map { $0.map(Self.run) }
            #expect(AnsiText.parseLines(lines) == want, "parse: \(name)")
        }
    }

    @Test func widthVectors() throws {
        let cases = try #require(Self.fixture["width"] as? [[Any]])
        #expect(cases.count >= 10)
        for c in cases {
            let text = try #require(c[0] as? String)
            let width = try #require(c[1] as? Int)
            #expect(AnsiText.width(text) == width, "width of \(text.unicodeScalars.map { String($0.value, radix: 16) })")
        }
    }

    @Test func truncateVectors() throws {
        let cases = try #require(Self.fixture["truncate"] as? [[String: Any]])
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let line = try #require(c["line"] as? String)
            let columns = try #require(c["columns"] as? Int)
            let want = try #require(c["runs"] as? [[String: Any]]).map(Self.run)
            #expect(AnsiText.truncate(AnsiText.parse(line).runs, columns: columns) == want, "truncate: \(name)")
        }
    }

    @Test func paletteIsTheFixtures() throws {
        let palette = try #require(Self.fixture["palette"] as? [String: [String]])
        #expect(AnsiPalette.dark == palette["dark"])
        #expect(AnsiPalette.light == palette["light"])
        for entry in try #require(Self.fixture["xterm256"] as? [[Any]]) {
            let index = try #require(entry[0] as? Int)
            #expect(AnsiPalette.hex(.index(index), dark: true) == entry[1] as? String, "xterm \(index)")
        }
        #expect(AnsiPalette.hex(.index(1), dark: false) == palette["light"]?[1])
        #expect(AnsiPalette.hex(.rgb(16, 32, 48), dark: true) == "#102030")
    }

    @Test func onlyWebLinksOpen() {
        #expect(AnsiText.openableLink("https://github.com/o/r/pull/1")?.absoluteString == "https://github.com/o/r/pull/1")
        #expect(AnsiText.openableLink("HTTP://x.y") != nil)
        #expect(AnsiText.openableLink("file:///Users/me/dev") == nil)
        #expect(AnsiText.openableLink("vscode://file/x") == nil)
        #expect(AnsiText.openableLink(nil) == nil)
        let runs = AnsiText.parse("\u{1b}]8;;https://a.b/c\u{1b}\\PR\u{1b}]8;;\u{1b}\\ \u{1b}]8;;file:///tmp\u{1b}\\here\u{1b}]8;;\u{1b}\\").runs
        let text = AnsiText.attributed(runs, dark: true, font: .body, boldFont: .body.bold(), base: .secondary, background: .black)
        let links = text.runs.compactMap { $0.link?.absoluteString }
        #expect(links == ["https://a.b/c"])
        #expect(String(text.characters) == "PR here")
    }
}
