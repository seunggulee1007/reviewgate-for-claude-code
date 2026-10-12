// MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the status line's text as a terminal draws it — SGR styles
// (bold, dim, italic, underline, strike, inverse, hidden; 16 / bright / 256 / truecolor) and OSC 8 links as runs;
// every other escape and control dropped; styles carried from line to line (the CLI prefixes every line with the
// escapes above it); display columns per grapheme; Ink's truncation ("…"). Electron's renderer/ansi.ts follows the
// same rules — engine/test/fixtures/ansiVectors.json holds both to them.
import Foundation
import SwiftUI

/// A palette index 0–255 or a truecolor value.
public enum AnsiColor: Sendable, Hashable {
    case index(Int)
    case rgb(UInt8, UInt8, UInt8)
}

public struct AnsiStyle: Sendable, Hashable {
    public var fg: AnsiColor?
    public var bg: AnsiColor?
    public var bold = false
    public var dim = false
    public var italic = false
    public var underline = false
    public var strike = false
    public var inverse = false
    public var hidden = false
    /// The OSC 8 URI the text links to.
    public var link: String?

    public init(fg: AnsiColor? = nil, bg: AnsiColor? = nil, bold: Bool = false, dim: Bool = false, italic: Bool = false, underline: Bool = false,
                strike: Bool = false, inverse: Bool = false, hidden: Bool = false, link: String? = nil) {
        self.fg = fg
        self.bg = bg
        self.bold = bold
        self.dim = dim
        self.italic = italic
        self.underline = underline
        self.strike = strike
        self.inverse = inverse
        self.hidden = hidden
        self.link = link
    }
}

public struct AnsiRun: Sendable, Equatable {
    public var text: String
    public var style: AnsiStyle

    public init(_ text: String, _ style: AnsiStyle = AnsiStyle()) {
        self.text = text
        self.style = style
    }
}

public enum AnsiText {
    // MARK: Parsing

    /// Every line's runs; a style (or link) still open at a line's end goes on into the next.
    public static func parseLines(_ lines: [String]) -> [[AnsiRun]] {
        var state = AnsiStyle()
        return lines.map { line in
            let r = parse(line, from: state)
            state = r.end
            return r.runs
        }
    }

    /// One line's runs, starting in `start` (the style the line above ended in); `end` is the style it ends in.
    public static func parse(_ line: String, from start: AnsiStyle = AnsiStyle()) -> (runs: [AnsiRun], end: AnsiStyle) {
        let s = Array(line.unicodeScalars)
        func code(_ i: Int) -> UInt32 { i < s.count ? s[i].value : UInt32.max }
        var runs: [AnsiRun] = []
        var style = start
        var text = String.UnicodeScalarView()
        var plain = ""   // the line's text so far (tab stops)
        func flush() {
            push(&runs, AnsiRun(String(text), style))
            text = String.UnicodeScalarView()
        }
        func restyle(_ next: AnsiStyle) {
            guard next != style else { return }
            flush()
            style = next
        }
        let isParam = { (c: UInt32) in c >= 0x30 && c <= 0x3F }
        let isInter = { (c: UInt32) in c >= 0x20 && c <= 0x2F }
        let isFinal = { (c: UInt32) in c >= 0x40 && c <= 0x7E }
        var i = 0
        scan: while i < s.count {
            let c = code(i)
            if c == 0x1B {
                let n = code(i + 1)
                if n == UInt32.max { break scan }
                if n == 0x5B {   // CSI
                    var j = i + 2
                    var params = ""
                    while isParam(code(j)) { params.unicodeScalars.append(s[j]); j += 1 }
                    var inter = ""
                    while isInter(code(j)) { inter.unicodeScalars.append(s[j]); j += 1 }
                    if j >= s.count { break scan }   // unterminated: the rest goes
                    if !isFinal(code(j)) { i = j; continue }
                    if code(j) == 0x6D, inter.isEmpty, !(params.first.map { "<=>?".contains($0) } ?? false) {
                        restyle(applySGR(style, params))
                    }
                    i = j + 1
                    continue
                }
                if n == 0x5D {   // OSC, ended by BEL or ST
                    var j = i + 2
                    var body = ""
                    var ended = false
                    while j < s.count {
                        if code(j) == 0x07 { ended = true; j += 1; break }
                        if code(j) == 0x1B, code(j + 1) == 0x5C { ended = true; j += 2; break }
                        body.unicodeScalars.append(s[j])
                        j += 1
                    }
                    if !ended { break scan }
                    // `8;<params>;<uri>`, by scalars (a mark after a ';' must not join it into one Character).
                    let b = Array(body.unicodeScalars)
                    if b.count >= 2, b[0] == "8", b[1] == ";", let semi = b[2...].firstIndex(of: ";") {
                        var uri = String.UnicodeScalarView()
                        uri.append(contentsOf: b[(semi + 1)...])
                        var next = style
                        next.link = uri.isEmpty ? nil : String(uri)
                        restyle(next)
                    }
                    i = j
                    continue
                }
                if n == 0x50 || n == 0x58 || n == 0x5E || n == 0x5F {   // DCS / SOS / PM / APC, ended by ST
                    var j = i + 2
                    var ended = false
                    while j < s.count {
                        if code(j) == 0x1B, code(j + 1) == 0x5C { ended = true; j += 2; break }
                        j += 1
                    }
                    if !ended { break scan }
                    i = j
                    continue
                }
                var j = i + 1
                while isInter(code(j)) { j += 1 }
                if j >= s.count { break scan }
                i = j + 1
                continue
            }
            if c == 0x09 {
                let pad = 8 - width(plain) % 8
                let spaces = String(repeating: " ", count: pad)
                text.append(contentsOf: spaces.unicodeScalars)
                plain += spaces
                i += 1
                continue
            }
            if c < 0x20 || c == 0x7F || (c >= 0x80 && c <= 0x9F) {
                i += 1
                continue
            }
            text.append(s[i])
            plain.unicodeScalars.append(s[i])
            i += 1
        }
        flush()
        return (runs, style)
    }

    /// One SGR's parameters applied to `from` (the link is not SGR's: it stays).
    static func applySGR(_ from: AnsiStyle, _ params: String) -> AnsiStyle {
        var s = from
        let list = params.isEmpty ? ["0"] : params.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        var k = 0
        while k < list.count {
            let p = list[k]
            defer { k += 1 }
            if p.contains(":") {
                let sub = p.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
                switch sub[0] {
                case "38": if let c = extendedColon(sub) { s.fg = c }
                case "48": if let c = extendedColon(sub) { s.bg = c }
                case "4": s.underline = sub.count > 1 ? sub[1] != "0" : true
                default: break
                }
                continue
            }
            let code: Int = p.isEmpty ? 0 : (p.allSatisfy(\.isASCIIDigit) ? Int(p) ?? -1 : -1)
            switch code {
            case 0:
                let link = s.link
                s = AnsiStyle()
                s.link = link
            case 1: s.bold = true
            case 2: s.dim = true
            case 3: s.italic = true
            case 4, 21: s.underline = true
            case 7: s.inverse = true
            case 8: s.hidden = true
            case 9: s.strike = true
            case 22: s.bold = false; s.dim = false
            case 23: s.italic = false
            case 24: s.underline = false
            case 27: s.inverse = false
            case 28: s.hidden = false
            case 29: s.strike = false
            case 30...37: s.fg = .index(code - 30)
            case 39: s.fg = nil
            case 40...47: s.bg = .index(code - 40)
            case 49: s.bg = nil
            case 90...97: s.fg = .index(code - 90 + 8)
            case 100...107: s.bg = .index(code - 100 + 8)
            case 38, 48, 58:
                let (color, used) = extended(list, at: k + 1)
                if code == 38, let color { s.fg = color }
                if code == 48, let color { s.bg = color }
                k += used
            default: break
            }
        }
        return s
    }

    private static func byte(_ v: String?) -> UInt8? {
        guard let v, !v.isEmpty, v.allSatisfy(\.isASCIIDigit), let n = Int(v), n <= 255 else { return nil }
        return UInt8(n)
    }

    /// `5;n` / `2;r;g;b` after a 38 / 48 (semicolon form): the color and how many parameters it took (nil color: ignored).
    private static func extended(_ list: [String], at: Int) -> (AnsiColor?, Int) {
        let mode = at < list.count ? list[at] : nil
        let item = { (i: Int) -> String? in i < list.count ? list[i] : nil }
        if mode == "5" { return (byte(item(at + 1)).map { .index(Int($0)) }, 2) }
        if mode == "2" {
            if let r = byte(item(at + 1)), let g = byte(item(at + 2)), let b = byte(item(at + 3)) { return (.rgb(r, g, b), 4) }
            return (nil, 4)
        }
        return (nil, list.count)
    }

    /// The colon form (`38:5:n`, `38:2::r:g:b`, `38:2:r:g:b`).
    private static func extendedColon(_ sub: [String]) -> AnsiColor? {
        guard sub.count > 1 else { return nil }
        if sub[1] == "5" { return byte(sub.count > 2 ? sub[2] : nil).map { .index(Int($0)) } }
        if sub[1] == "2" {
            let rest = Array(sub.dropFirst(2))
            let rgb = rest.count >= 4 ? Array(rest.suffix(3)) : rest
            guard rgb.count == 3, let r = byte(rgb[0]), let g = byte(rgb[1]), let b = byte(rgb[2]) else { return nil }
            return .rgb(r, g, b)
        }
        return nil
    }

    /// Appends `run`, joining it to the last one when they look the same.
    private static func push(_ runs: inout [AnsiRun], _ run: AnsiRun) {
        guard !run.text.isEmpty else { return }
        if let last = runs.indices.last, runs[last].style == run.style {
            runs[last].text += run.text
        } else {
            runs.append(run)
        }
    }

    // MARK: Columns

    /// East Asian wide / fullwidth and emoji-presentation code points (two columns).
    static let wide: [ClosedRange<UInt32>] = [
        0x1100...0x115F, 0x231A...0x231B, 0x2329...0x232A, 0x23E9...0x23EC, 0x23F0...0x23F0, 0x23F3...0x23F3,
        0x25FD...0x25FE, 0x2614...0x2615, 0x2648...0x2653, 0x267F...0x267F, 0x2693...0x2693, 0x26A1...0x26A1,
        0x26AA...0x26AB, 0x26BD...0x26BE, 0x26C4...0x26C5, 0x26CE...0x26CE, 0x26D4...0x26D4, 0x26EA...0x26EA,
        0x26F2...0x26F3, 0x26F5...0x26F5, 0x26FA...0x26FA, 0x26FD...0x26FD, 0x2705...0x2705, 0x270A...0x270B,
        0x2728...0x2728, 0x274C...0x274C, 0x274E...0x274E, 0x2753...0x2755, 0x2757...0x2757, 0x2795...0x2797,
        0x27B0...0x27B0, 0x27BF...0x27BF, 0x2B1B...0x2B1C, 0x2B50...0x2B50, 0x2B55...0x2B55,
        0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xA000...0xA4CF, 0xA960...0xA97F,
        0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE10...0xFE19, 0xFE30...0xFE6F, 0xFF00...0xFF60, 0xFFE0...0xFFE6,
        0x16FE0...0x16FE4, 0x17000...0x18CFF, 0x1B000...0x1B2FF,
        0x1F004...0x1F004, 0x1F0CF...0x1F0CF, 0x1F18E...0x1F18E, 0x1F191...0x1F19A, 0x1F200...0x1F202, 0x1F210...0x1F23B,
        0x1F240...0x1F248, 0x1F250...0x1F251, 0x1F260...0x1F265, 0x1F300...0x1F320, 0x1F32D...0x1F335, 0x1F337...0x1F37C,
        0x1F37E...0x1F393, 0x1F3A0...0x1F3CA, 0x1F3CF...0x1F3D3, 0x1F3E0...0x1F3F0, 0x1F3F4...0x1F3F4, 0x1F3F8...0x1F43E,
        0x1F440...0x1F440, 0x1F442...0x1F4FC, 0x1F4FF...0x1F53D, 0x1F54B...0x1F54E, 0x1F550...0x1F567, 0x1F57A...0x1F57A,
        0x1F595...0x1F596, 0x1F5A4...0x1F5A4, 0x1F5FB...0x1F64F, 0x1F680...0x1F6C5, 0x1F6CC...0x1F6CC, 0x1F6D0...0x1F6D2,
        0x1F6D5...0x1F6D7, 0x1F6DC...0x1F6DF, 0x1F6EB...0x1F6EC, 0x1F6F4...0x1F6FC, 0x1F7E0...0x1F7EB, 0x1F7F0...0x1F7F0,
        0x1F90C...0x1F93A, 0x1F93C...0x1F945, 0x1F947...0x1F9FF, 0x1FA70...0x1FAFF,
        0x20000...0x2FFFD, 0x30000...0x3FFFD,
    ]

    /// Joiners, variation selectors, tags and marks that never start a cluster's width of their own.
    static let zero: [ClosedRange<UInt32>] = [
        0x0300...0x036F, 0x1160...0x11FF, 0x1AB0...0x1AFF, 0x1DC0...0x1DFF, 0x200B...0x200F, 0x2060...0x2064, 0x20D0...0x20FF,
        0xFE00...0xFE0F, 0xFE20...0xFE2F, 0xFEFF...0xFEFF, 0xE0000...0xE007F, 0xE0100...0xE01EF,
    ]

    private static func inRanges(_ cp: UInt32, _ ranges: [ClosedRange<UInt32>]) -> Bool {
        var lo = 0
        var hi = ranges.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if cp < ranges[mid].lowerBound { hi = mid - 1 } else if cp > ranges[mid].upperBound { lo = mid + 1 } else { return true }
        }
        return false
    }

    /// One cluster's columns: 2 for an emoji presentation (VS16, a flag) or a wide base, 0 for marks alone, else 1.
    public static func graphemeWidth(_ ch: Character) -> Int {
        let cps = ch.unicodeScalars.map(\.value)
        if cps.contains(0xFE0F) || cps.contains(where: { $0 >= 0x1F1E6 && $0 <= 0x1F1FF }) { return 2 }
        guard let base = cps.first(where: { !inRanges($0, zero) }) else { return 0 }
        return inRanges(base, wide) ? 2 : 1
    }

    /// Display columns of `text`.
    public static func width(_ text: String) -> Int {
        text.reduce(0) { $0 + graphemeWidth($1) }
    }

    public static func width(of runs: [AnsiRun]) -> Int {
        runs.reduce(0) { $0 + width($1.text) }
    }

    /// Ink's `wrap="truncate"`: a line wider than `columns` keeps what fits in columns − 1 and ends with an unstyled "…".
    public static func truncate(_ runs: [AnsiRun], columns: Int) -> [AnsiRun] {
        guard columns > 0 else { return [] }
        guard width(of: runs) > columns else { return runs }
        let budget = columns - 1
        var out: [AnsiRun] = []
        var used = 0
        var full = false
        for run in runs {
            var kept = ""
            for ch in run.text {
                let w = graphemeWidth(ch)
                if used + w > budget { full = true; break }
                kept.append(ch)
                used += w
            }
            push(&out, AnsiRun(kept, run.style))
            if full { break }
        }
        push(&out, AnsiRun("…"))
        return out
    }

    // MARK: Drawing

    /// A link the status line may open: http(s) only (a `file://` or custom scheme stays text, as in Electron).
    public static func openableLink(_ link: String?) -> URL? {
        guard let link, let url = URL(string: link), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    /// The runs as SwiftUI text: their colors in this appearance (`base` = the default foreground, the CLI's dim one;
    /// `background` = what inverse puts behind it), bold / italic in `font`, underline / strike, dim at 55 %, http(s) links.
    public static func attributed(_ runs: [AnsiRun], dark: Bool, font: Font, boldFont: Font, base: Color, background: Color) -> AttributedString {
        var out = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            let st = run.style
            var fg = st.fg.map { AnsiPalette.color($0, dark: dark) }
            var bg = st.bg.map { AnsiPalette.color($0, dark: dark) }
            if st.inverse {
                let swappedFg = bg ?? background
                bg = fg ?? base
                fg = swappedFg
            }
            var color = fg ?? base
            if st.dim { color = color.opacity(0.55) }
            if st.hidden { color = .clear }
            piece.swiftUI.foregroundColor = color
            if let bg { piece.swiftUI.backgroundColor = bg }
            var f = st.bold ? boldFont : font
            if st.italic { f = f.italic() }
            piece.swiftUI.font = f
            if st.underline { piece.swiftUI.underlineStyle = .single }
            if st.strike { piece.swiftUI.strikethroughStyle = .single }
            if let url = openableLink(st.link) { piece.link = url }
            out.append(piece)
        }
        return out
    }
}

/// The 16 basic colors per appearance (VS Code's terminal colors; Electron's `ANSI_PALETTE` is the same) and the xterm cube.
public enum AnsiPalette {
    public static let dark = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
                              "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]
    public static let light = ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
                               "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"]
    private static let cube: [UInt8] = [0, 95, 135, 175, 215, 255]

    /// The xterm color of 256-color index 16–255 (the 6×6×6 cube, then 24 grays).
    public static func xterm256(_ index: Int) -> (UInt8, UInt8, UInt8) {
        if index >= 232 {
            let v = UInt8(8 + 10 * (index - 232))
            return (v, v, v)
        }
        let i = max(0, index - 16)
        return (cube[(i / 36) % 6], cube[(i / 6) % 6], cube[i % 6])
    }

    /// A color as `#rrggbb` in this appearance.
    public static func hex(_ color: AnsiColor, dark: Bool) -> String {
        switch color {
        case let .rgb(r, g, b): return String(format: "#%02x%02x%02x", r, g, b)
        case let .index(i) where i < 16: return (dark ? self.dark : light)[max(0, i)]
        case let .index(i):
            let (r, g, b) = xterm256(i)
            return String(format: "#%02x%02x%02x", r, g, b)
        }
    }

    public static func color(_ color: AnsiColor, dark: Bool) -> Color {
        let h = hex(color, dark: dark)
        let v = UInt32(h.dropFirst(), radix: 16) ?? 0
        return Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}
