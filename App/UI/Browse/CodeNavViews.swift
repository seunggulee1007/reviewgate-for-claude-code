import SwiftUI
import AppKit
import ReviewGateCore

// MARK: code-nav — docs/PROTOCOL.md §62 on the Mac: ⌘-click a name in any diff or project file (an underline and a pointing
// hand while ⌘ is held over one) → `find_definition`; one candidate opens, several show a peek list at the click, none a
// short note. Find References lists the hits by file in a sheet; Back / Forward (⌃- / ⌃⇧-) walk the jumps; Open in IDE
// (⌥⌘O) hands the file and line to the user's editor (`ExternalEditor`). The rules are Core `CodeNav` (tested there).

/// The file the code rows below show: which view, and its repo-relative path.
struct CodeNavContext: Equatable {
    var path: String
    var view: CodeNavLocation.View
}

private struct CodeNavContextKey: EnvironmentKey {
    static let defaultValue: CodeNavContext? = nil
}

extension EnvironmentValues {
    /// §62: the file whose rows navigate (nil: they do not — a deleted row, a chat preview).
    var codeNavContext: CodeNavContext? {
        get { self[CodeNavContextKey.self] }
        set { self[CodeNavContextKey.self] = newValue }
    }
}

extension View {
    /// The code rows below go to definitions from `path` (nil: they do not).
    func codeNavigation(path: String?, view: CodeNavLocation.View) -> some View {
        environment(\.codeNavContext, path.map { CodeNavContext(path: $0, view: view) })
    }
}

// MARK: - The pointer

/// The name under the mouse in whichever code row it is over, ⌘ held or not, and the clicks that act on it. One for the
/// app (there is one pointer); a local event monitor takes ⌘-click before the row's own click handling sees it.
@MainActor
@Observable
final class CodeNavPointer {
    static let shared = CodeNavPointer()
    /// The popover hangs from the diff pane instead of a row (a name picked from a row's menu).
    static let paneAnchor = 0

    struct Target: Equatable {
        let token: Int
        let symbol: String
        /// UTF-16 offsets into the row's text.
        let range: Range<Int>
        /// §65.6: `user` of `user.save()`.
        let receiver: String?
        let from: CodeNavLocation
        /// The row's drawn text (§65.8: the peek band hangs under the row drawing it).
        let text: String
        weak var store: AppState?

        static func == (a: Target, b: Target) -> Bool {
            a.token == b.token && a.symbol == b.symbol && a.range == b.range && a.receiver == b.receiver && a.from == b.from
                && a.text == b.text && a.store === b.store
        }

        /// The row's place with the name's column (§65.6: `find_definition`'s `column`).
        var clickedAt: CodeNavLocation {
            var at = from
            at.column = range.lowerBound + 1
            return at
        }
    }

    /// The name last pointed at (kept after the pointer leaves, for the row's context menu).
    private(set) var target: Target?
    /// ⌘ alone is held.
    private(set) var commandDown = false
    /// Where the peek popover hangs from in the clicked row (its coordinates).
    private(set) var anchorPoint: CGPoint = .zero
    /// §65.8: where the hover card hangs from (the row's coordinates where the pointer came to rest on the name).
    @ObservationIgnored private(set) var hoverPoint: CGPoint = .zero
    /// The window the hover card was last asked for (told when the pointer leaves the name).
    @ObservationIgnored private weak var hoverStore: AppState?
    @ObservationIgnored private var hoveringToken: Int?
    @ObservationIgnored private var lastPoint: CGPoint = .zero
    @ObservationIgnored private var monitor: Any?
    @ObservationIgnored private var swallowMouseUp = false
    @ObservationIgnored private var tokens = 0

    func nextToken() -> Int {
        tokens += 1
        return tokens
    }

    /// The pointer is at `point` of row `token` (drawing `text`), over `hit` (nil: not over a name).
    func hover(token: Int, hit: CodeNavSymbol?, point: CGPoint, from: CodeNavLocation, text: String, store: AppState) {
        installIfNeeded()
        hoveringToken = token
        lastPoint = point
        let down = Self.isCommandOnly(NSEvent.modifierFlags)
        if down != commandDown { commandDown = down }
        let next = hit.map { Target(token: token, symbol: $0.symbol, range: $0.range, receiver: $0.receiver, from: from, text: text, store: store) }
        if next != target {
            target = next
            hoverPoint = point
        }
        updateHover()
    }

    func leave(token: Int) {
        if hoveringToken == token {
            hoveringToken = nil
            updateHover()
        }
    }

    /// §65.8: ⌘ held over a name asks for the hover card (after a rest, Core `CodeNavHoverStore`); anything else stops it.
    private func updateHover() {
        guard commandDown, let target, let store = target.store, hoveringToken == target.token else {
            hoverStore?.hoverDefinition(nil, receiver: nil)
            return
        }
        if hoverStore !== store { hoverStore?.hoverDefinition(nil, receiver: nil) }
        hoverStore = store
        store.hoverDefinition(CodeNavHoverDebounce.Key(symbol: target.symbol, at: target.clickedAt, anchor: target.token), receiver: target.receiver)
    }

    /// The part of row `token` to underline: the name under the pointer while ⌘ is held.
    func underline(for token: Int) -> Range<Int>? {
        guard commandDown, let target, target.token == token else { return nil }
        return target.range
    }

    /// The name last pointed at on the row at `from` (its context menu), if any.
    func target(on from: CodeNavLocation) -> Target? {
        guard let target, target.from == from else { return nil }
        return target
    }

    /// Go to Definition on `target`, the popover hanging from where the pointer last was over its row.
    func goToDefinition(_ target: Target) {
        guard let store = target.store else { return }
        anchorPoint = lastPoint
        store.codeNav.caret = target.from
        Task { await store.goToDefinition(target.symbol, from: target.clickedAt, anchor: target.token, receiver: target.receiver) }
    }

    /// §65.8: Peek Definition on `target` — the band under its row; the place being read stays where it is.
    func peek(_ target: Target) {
        guard let store = target.store else { return }
        Task { await store.peekDefinition(target.symbol, row: target.from, rowText: target.text, from: target.clickedAt, receiver: target.receiver) }
    }

    /// Navigate › Peek Definition (⌥F12): the name under the pointer.
    func peekUnderPointer(in store: AppState) -> Bool {
        guard let target, target.store === store, hoveringToken == target.token else { return false }
        peek(target)
        return true
    }

    /// Navigate › Go to Definition (F12): the name under the pointer, if the pointer is over one in `store`'s window.
    func goToDefinitionUnderPointer(in store: AppState) -> Bool {
        guard let target, target.store === store, hoveringToken == target.token else { return false }
        goToDefinition(target)
        return true
    }

    /// Navigate › Find References (⇧F12): the name under the pointer.
    func findReferencesUnderPointer(in store: AppState) -> Bool {
        guard let target, target.store === store, hoveringToken == target.token else { return false }
        Task { await store.findReferences(target.symbol, from: target.from) }
        return true
    }

    private static func isCommandOnly(_ flags: NSEvent.ModifierFlags) -> Bool {
        flags.intersection([.command, .option, .control, .shift]) == .command
    }

    private func installIfNeeded() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .leftMouseDown, .leftMouseUp]) { event in
            MainActor.assumeIsolated { CodeNavPointer.shared.swallows(event) } ? nil : event
        }
    }

    /// True for the ⌘-click this takes (and its mouse-up); the rest go on.
    private func swallows(_ event: NSEvent) -> Bool {
        switch event.type {
        case .flagsChanged:
            let down = Self.isCommandOnly(event.modifierFlags)
            if down != commandDown {
                commandDown = down
                if down, target != nil { hoverPoint = lastPoint }
                updateHover()
            }
        case .leftMouseDown:
            hoverStore?.codeNav.hover.dismiss()   // §65.8: a click never leaves the hover card behind
            guard Self.isCommandOnly(event.modifierFlags), event.clickCount == 1, let target, hoveringToken == target.token else { break }
            swallowMouseUp = true
            // §65.8: Settings › Review › Diff › ⌘-click — the peek band (default) or the jump.
            if CodeNavCommandClick.current() == .peek { peek(target) } else { goToDefinition(target) }
            return true   // the row's own click (picking the line) never sees it
        case .leftMouseUp:
            if swallowMouseUp {
                swallowMouseUp = false
                return true
            }
        default:
            break
        }
        return false
    }
}

/// Which character of a code row is at a point: the row's text laid out as `DiffCodeText` draws it (the code font, the
/// pane's width when wrapping).
enum CodeNavHitTest {
    @MainActor static let font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)

    /// The UTF-16 offset of the character drawn at `point`, nil past the end of the text or between lines.
    @MainActor
    static func offset(at point: CGPoint, in text: String, width: CGFloat?) -> Int? {
        guard !text.isEmpty, point.x >= 0, point.y >= 0 else { return nil }
        let storage = NSTextStorage(string: text, attributes: [.font: font])
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: width.map { max(1, $0) } ?? .greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        var fraction: CGFloat = 0
        let glyph = manager.glyphIndex(for: point, in: container, fractionOfDistanceThroughGlyph: &fraction)
        guard glyph < manager.numberOfGlyphs else { return nil }
        let rect = manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        guard rect.insetBy(dx: -0.5, dy: -1).contains(point) else { return nil }
        return manager.characterIndexForGlyph(at: glyph)
    }
}

// MARK: - A code row's hot spot

/// Wraps a code row's text: tracks the name under the pointer, underlines it (and shows a pointing hand) while ⌘ is held,
/// and hangs the peek popover from the click. Without a context (`from` nil) it is the text alone.
struct CodeNavHotspot<Content: View>: View {
    @Environment(AppState.self) private var store: AppState?
    /// The drawn text (`DiffLineText.shown`).
    let text: String
    let from: CodeNavLocation?
    let wrap: Bool
    /// Not wrapping: how far the row is scrolled sideways.
    let offset: CGFloat
    @ViewBuilder let content: (Range<Int>?) -> Content
    @State private var token = 0
    @State private var hovered = false
    @State private var width: CGFloat = 0

    var body: some View {
        if let from, let store {
            active(from, store: store)
        } else {
            content(nil)
        }
    }

    private func active(_ from: CodeNavLocation, store: AppState) -> some View {
        let pointer = CodeNavPointer.shared
        let underline = hovered ? pointer.underline(for: token) : nil
        return content(underline)
            // MARK: ide-nav (§65.8): the hover card, from where the pointer rests on the name.
            .popover(isPresented: hoverShown(store), attachmentAnchor: .rect(.rect(CGRect(origin: pointer.hoverPoint, size: CGSize(width: 1, height: 14)))),
                     arrowEdge: .bottom) {
                if let card = store.codeNav.hover.card { CodeNavHoverCard(card: card) }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .onContinuousHover(coordinateSpace: .local) { phase in
                switch phase {
                case let .active(point):
                    let mine = token == 0 ? pointer.nextToken() : token
                    if token == 0 { token = mine }
                    if !hovered { hovered = true }
                    let x = wrap ? point.x : point.x + offset
                    let hit = CodeNavHitTest.offset(at: CGPoint(x: x, y: point.y), in: text, width: wrap ? width : nil)
                        .flatMap { CodeNavText.symbol(in: text, at: $0, path: from.path) }
                    pointer.hover(token: mine, hit: hit, point: point, from: from, text: text, store: store)
                case .ended:
                    if hovered { hovered = false }
                    pointer.leave(token: token)
                }
            }
            .pointerStyle(underline != nil ? .link : nil)
            .popover(isPresented: popupShown(store), attachmentAnchor: .rect(.rect(CGRect(origin: pointer.anchorPoint, size: CGSize(width: 1, height: 14)))),
                     arrowEdge: .bottom) {
                CodeNavPopupView()
                    .environment(store)
            }
    }

    private func hoverShown(_ store: AppState) -> Binding<Bool> {
        Binding(get: { token != 0 && store.codeNav.hover.card?.key.anchor == token },
                set: { if !$0, store.codeNav.hover.card?.key.anchor == token { store.codeNav.hover.dismiss() } })
    }

    private func popupShown(_ store: AppState) -> Binding<Bool> {
        Binding(get: { token != 0 && store.codeNav.popup?.anchor == token },
                set: { if !$0, store.codeNav.popup?.anchor == token { store.codeNav.dismissPopup() } })
    }
}

// MARK: - The popover

/// The peek list (several candidates), "looking…", or the note when nothing was found.
struct CodeNavPopupView: View {
    @Environment(AppState.self) private var store

    var body: some View {
        Group {
            if let popup = store.codeNav.popup {
                switch popup.content {
                case .looking:
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Looking for \(popup.symbol)…").font(.callout)
                    }
                    .padding(12)
                case let .peek(reply):
                    CodeNavPeekList(popup: popup, reply: reply)
                case .notFound:
                    CodeNavNote(popup: popup, message: String(localized: "No definition found for \(popup.symbol)"))
                case let .failed(message):
                    CodeNavNote(popup: popup, message: message)
                }
            }
        }
        .accessibilityIdentifier("Go to definition popover")
    }
}

/// Nothing found (or the search failed): one line and the next steps.
private struct CodeNavNote: View {
    @Environment(AppState.self) private var store
    let popup: CodeNavStore.Popup
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "questionmark.circle")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Find References") {
                    let from = popup.from
                    let symbol = popup.symbol
                    store.codeNav.dismissPopup()
                    Task { await store.findReferences(symbol, from: from) }
                }
                .help("Every line that holds this name as a whole word")
                .accessibilityIdentifier("Not found Find references")
                Button("Find in Project") {
                    let symbol = popup.symbol
                    store.codeNav.dismissPopup()
                    Task { await store.searchProject(word: CodeNavPeekText.bare(symbol)) }
                }
                .help("Search the project for this word (⇧⌘F)")
                .accessibilityIdentifier("Not found Find in project")
            }
            .controlSize(.small)
        }
        .padding(12)
        .frame(maxWidth: 360, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Definition not found")
    }
}

enum CodeNavPeekText {
    /// The part of a symbol a line shows: `C` of `a.b.C`, `out` of `c:out`, the file name of a path.
    static func bare(_ symbol: String) -> String {
        if symbol.contains("/") { return (symbol as NSString).lastPathComponent }
        if let colon = symbol.lastIndex(of: ":") { return String(symbol[symbol.index(after: colon)...]) }
        if let dot = symbol.lastIndex(of: "."), !CodeNavPeekText.looksLikeFile(symbol) { return String(symbol[symbol.index(after: dot)...]) }
        return symbol
    }

    private static func looksLikeFile(_ symbol: String) -> Bool {
        ["jsp", "jspf", "jspx", "vue", "js", "ts", "tag", "tagx", "html"].contains((symbol as NSString).pathExtension.lowercased())
    }

    /// `preview` with every whole-word `word` in it bold on the accent colour.
    static func marked(_ preview: String, word: String) -> AttributedString {
        var out = AttributedString(preview)
        guard !word.isEmpty else { return out }
        var search = preview.startIndex..<preview.endIndex
        while let r = preview.range(of: word, range: search) {
            let before = r.lowerBound > preview.startIndex ? preview[preview.index(before: r.lowerBound)] : " "
            let after = r.upperBound < preview.endIndex ? preview[r.upperBound] : " "
            let isWord = { (c: Character) in c.isLetter || c.isNumber || c == "_" || c == "$" }
            if !isWord(before) || word.first.map({ !isWord($0) }) == true, !isWord(after) || word.last.map({ !isWord($0) }) == true,
               let ar = Range<AttributedString.Index>(r, in: out) {
                out[ar].swiftUI.font = .body.monospaced().weight(.bold)
                out[ar].swiftUI.foregroundColor = .accentColor
            }
            search = r.upperBound..<preview.endIndex
        }
        return out
    }
}

/// Several candidates: file name, folder, line, kind and the line itself — the first one picked; ↑ / ↓ / ↩ / Esc.
private struct CodeNavPeekList: View {
    @Environment(AppState.self) private var store
    let popup: CodeNavStore.Popup
    let reply: DefinitionsReply
    @State private var selected = 0
    @FocusState private var focused: Bool

    var body: some View {
        let word = CodeNavPeekText.bare(popup.symbol)
        VStack(alignment: .leading, spacing: 0) {
            Text("\(reply.candidates.count) definitions of \(popup.symbol)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 4)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(reply.candidates.enumerated()), id: \.offset) { index, candidate in
                            row(candidate, word: word, isSelected: index == selected)
                                .id(index)
                                .contentShape(Rectangle())
                                .onTapGesture { open(candidate) }
                                .onHover { if $0 { selected = index } }
                        }
                    }
                }
                .frame(maxHeight: 320)
                .onChange(of: selected) { _, index in proxy.scrollTo(index) }
            }
            ForEach(CodeNavText.limits(reply), id: \.self) { line in
                Text(verbatim: line).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.top, 4)
            }
            Divider().padding(.top, 6)
            HStack {
                Button("Find References") {
                    let from = popup.from
                    let symbol = popup.symbol
                    store.codeNav.dismissPopup()
                    Task { await store.findReferences(symbol, from: from) }
                }
                .buttonStyle(.link)
                .help("Every line that holds this name as a whole word")
                .accessibilityIdentifier("Peek Find references")
                Spacer()
                Text("Search-based: may list look-alikes")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
        .frame(width: 520)
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onAppear { focused = true }
        .onKeyPress(.upArrow) { selected = max(0, selected - 1); return .handled }
        .onKeyPress(.downArrow) { selected = min(reply.candidates.count - 1, selected + 1); return .handled }
        .onKeyPress(.return) {
            if reply.candidates.indices.contains(selected) { open(reply.candidates[selected]) }
            return .handled
        }
        .onKeyPress(.escape) { store.codeNav.dismissPopup(); return .handled }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Definitions peek")
    }

    private func row(_ c: DefinitionCandidate, word: String, isSelected: Bool) -> some View {
        let name = (c.path as NSString).lastPathComponent
        let folder = (c.path as NSString).deletingLastPathComponent
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(verbatim: "\(name):\(c.line)").font(.callout.weight(.medium)).lineLimit(1)
                if !c.kind.rawValue.isEmpty {
                    Text(verbatim: c.kind.rawValue)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                        .foregroundStyle(.secondary)
                }
                Text(verbatim: folder).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 0)
            }
            Text(CodeNavPeekText.marked(c.preview, word: word))
                .font(.body.monospaced())
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
        .help(c.path)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("Definition \(c.path):\(c.line)")
    }

    private func open(_ c: DefinitionCandidate) {
        store.openNavPlace(path: c.path, line: c.line, column: c.column, kind: c.kind, from: popup.from)
    }
}

// MARK: - Find References

/// The references of a name, by file: "N references in M files", each file's lines with the name marked; a click opens.
struct CodeNavReferencesSheet: View {
    @Environment(AppState.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let nav = store.codeNav
        let word = CodeNavPeekText.bare(nav.referencesSymbol)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "text.magnifyingglass").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text("References to \(nav.referencesSymbol)").font(.headline).lineLimit(1).truncationMode(.middle)
                    if let reply = nav.references {
                        Text(verbatim: CodeNavText.summary(reply)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if nav.referencesLoading { ProgressView().controlSize(.small) }
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("Close references")
            }
            .padding(12)
            Divider()
            content(nav, word: word)
            Divider()
            Text("Search-based: lines holding the name as a whole word — may list look-alikes")
                .font(.caption2).foregroundStyle(.tertiary)
                .padding(.horizontal, 12).padding(.vertical, 6)
        }
        .frame(minWidth: 560, idealWidth: 680, minHeight: 360, idealHeight: 520)
        .accessibilityIdentifier("References sheet")
    }

    @ViewBuilder
    private func content(_ nav: CodeNavStore, word: String) -> some View {
        if let error = nav.referencesError {
            ContentUnavailableView("Could not find references", systemImage: "exclamationmark.triangle", description: Text(verbatim: error))
                .frame(maxHeight: .infinity)
        } else if nav.referencesLoading, nav.references == nil {
            VStack(spacing: 8) {
                ProgressView()
                Text("Looking for references…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if nav.referenceGroups.isEmpty {
            ContentUnavailableView("No references", systemImage: "magnifyingglass")
                .frame(maxHeight: .infinity)
        } else {
            List {
                ForEach(nav.referenceGroups) { group in
                    Section {
                        ForEach(group.hits, id: \.self) { hit in
                            Button { open(hit) } label: { row(hit, word: word) }
                                .buttonStyle(.plain)
                                .help(hit.kind != nil ? Text("Open the definition at line \(hit.line)") : Text("Open at line \(hit.line)"))
                                .accessibilityIdentifier("Reference \(hit.path):\(hit.line)")
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Text(verbatim: (group.path as NSString).lastPathComponent).font(.callout.weight(.semibold))
                            Text(verbatim: (group.path as NSString).deletingLastPathComponent)
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                            Spacer()
                            Text(verbatim: String(group.hits.count)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        .help(group.path)
                    }
                }
            }
            .listStyle(.inset)
        }
    }

    private func row(_ hit: ReferenceHit, word: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: String(hit.line))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .trailing)
            Text(CodeNavPeekText.marked(hit.preview, word: word))
                .font(.body.monospaced())
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            if hit.kind != nil {
                Text("definition")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.accentColor.opacity(0.18), in: Capsule())
            }
        }
        .contentShape(Rectangle())
    }

    private func open(_ hit: ReferenceHit) {
        store.openNavPlace(path: hit.path, line: hit.line, column: hit.column, kind: hit.kind, from: store.codeNav.referencesFrom)
        store.codeNav.referencesShown = false
    }
}

// MARK: - Menus

/// A code row's context menu: Go to Definition / Find References on the name under the pointer (else a list of the line's
/// names), and Open in IDE at the line.
struct CodeNavMenuItems: View {
    @Environment(AppState.self) private var store
    @Environment(\.codeNavContext) private var context
    /// The row's line number in the context's file; nil: no navigation from this row.
    let line: Int?
    /// The row's code (its names, when the pointer was not on one).
    let text: String

    init(line: Int?, text: String) {
        self.line = line
        self.text = text
    }

    /// A diff row's: its line number on the side it is drawn for (a split side's own; else the new side's, else the old).
    init(_ diffLine: DiffLine, side: DiffSide?) {
        self.init(line: Self.number(diffLine, side: side), text: diffLine.text)
    }

    static func number(_ line: DiffLine, side: DiffSide?) -> Int? {
        guard line.kind != .hunkHeader else { return nil }
        switch side {
        case .old: return line.oldNo
        case .new: return line.newNo
        case nil: return line.newNo ?? line.oldNo
        }
    }

    var body: some View {
        if let context, let line {
            let from = CodeNavLocation(view: context.view, path: context.path, line: line)
            let pointer = CodeNavPointer.shared
            if let target = pointer.target(on: from) {
                Button("Peek Definition", systemImage: "eye") { pointer.peek(target) }   // MARK: ide-nav (§65.8)
                    .help(String(localized: "\(target.symbol)'s definition under this line, without leaving it (⌥F12)"))
                    .accessibilityIdentifier("Row Peek definition")
                Button("Go to Definition", systemImage: "arrow.right.circle") { pointer.goToDefinition(target) }
                    .help(String(localized: "Where \(target.symbol) is declared (F12)"))
                    .accessibilityIdentifier("Row Go to definition")
                Button("Find References", systemImage: "text.magnifyingglass") {
                    Task { await store.findReferences(target.symbol, from: from) }
                }
                .help(String(localized: "Every line that holds \(target.symbol) as a whole word"))
                .accessibilityIdentifier("Row Find references")
            } else {
                let words = CodeBrowserText.identifiers(in: text)
                if !words.isEmpty {
                    Menu("Go to Definition") {
                        ForEach(words, id: \.self) { word in
                            Button(word) {
                                store.codeNav.caret = from
                                Task { await store.goToDefinition(word, from: from, anchor: CodeNavPointer.paneAnchor) }
                            }
                        }
                    }
                    Menu("Find References") {
                        ForEach(words, id: \.self) { word in
                            Button(word) { Task { await store.findReferences(word, from: from) } }
                        }
                    }
                }
            }
            Button("Open in IDE", systemImage: "arrow.up.forward.app") { CodeNavActions.openInIDE(store, path: context.path, line: line) }
                .help(String(localized: "Open this file at line \(line) in \(ExternalEditor.preferred(for: store).title)"))
                .accessibilityIdentifier("Row Open in IDE")
            Divider()
        }
    }
}

@MainActor
enum CodeNavActions {
    /// Opens `path` (repo-relative) at `line` in the project's IDE (`ExternalEditor.preferred(for:)`).
    static func openInIDE(_ store: AppState, path: String, line: Int?, column: Int = 1) {
        guard let root = store.projectInfo?.root ?? store.projectURL?.path else { return }
        ExternalEditor.preferred(for: store).open(IDELink.absolutePath(root: root, relative: path), line: line ?? 1, column: column)
    }

    /// The file on screen in the diff pane and the line the user is at: the project file, else the review's, a past
    /// round's or the live diff's file; the line where the user last clicked or jumped in it.
    static func current(_ store: AppState) -> (path: String, line: Int?)? {
        let path = store.codeBrowser.selection?.path ?? store.historySelection?.path ?? store.liveSelection ?? store.selectedFile?.path
        guard let path else { return nil }
        if let caret = store.codeNav.caret, caret.path == path { return (path, caret.line) }
        if store.codeBrowser.selection?.path == path { return (path, store.codeBrowser.selection?.line) }
        return (path, nil)
    }
}

/// Navigate: Go to Definition (F12), Find References (⇧F12), Back (⌃-), Forward (⌃⇧-), Open in IDE (⌥⌘O).
struct CodeNavCommands: Commands {
    let focused: WorkbenchWindowEntry?

    private static let f12 = KeyEquivalent(Character(UnicodeScalar(UInt32(NSF12FunctionKey))!))
    private static let f4 = KeyEquivalent(Character(UnicodeScalar(UInt32(NSF4FunctionKey))!))

    var body: some Commands {
        CommandMenu("Navigate") {
            let store = focused?.store
            let hasProject = store?.menuState.hasProject == true
            // MARK: ide-nav (§65.8): the definition in a band under the line.
            Button("Peek Definition") {
                if let store, !CodeNavPointer.shared.peekUnderPointer(in: store) { NSSound.beep() }
            }
            .keyboardShortcut(Self.f12, modifiers: .option)
            .disabled(!hasProject)
            .help(hasProject ? Text("The definition of the name under the pointer, in a band under its line") : Text("Open a project first"))
            .accessibilityIdentifier("Navigate menu Peek definition")
            Button("Go to Definition") {
                if let store, !CodeNavPointer.shared.goToDefinitionUnderPointer(in: store) { NSSound.beep() }
            }
            .keyboardShortcut(Self.f12, modifiers: [])
            .disabled(!hasProject)
            .accessibilityIdentifier("Navigate menu Go to definition")
            Button("Find References") {
                if let store, !CodeNavPointer.shared.findReferencesUnderPointer(in: store) { NSSound.beep() }
            }
            .keyboardShortcut(Self.f12, modifiers: .shift)
            .disabled(!hasProject)
            .accessibilityIdentifier("Navigate menu Find references")
            // MARK: ide-nav (§65.8): the References tab's hits, one after the other.
            let hasHits = store.map { !$0.codeNav.referenceGroups.isEmpty } ?? false
            Button("Next Reference") { if let store { Task { await store.stepReference(1) } } }
                .keyboardShortcut(Self.f4, modifiers: [])
                .disabled(!hasHits)
                .help(hasHits ? Text("Open the next reference of the References tab") : Text("No references to step through — Find References (⇧F12) on a name first"))
                .accessibilityIdentifier("Navigate menu Next reference")
            Button("Previous Reference") { if let store { Task { await store.stepReference(-1) } } }
                .keyboardShortcut(Self.f4, modifiers: .shift)
                .disabled(!hasHits)
                .help(hasHits ? Text("Open the previous reference of the References tab") : Text("No references to step through — Find References (⇧F12) on a name first"))
                .accessibilityIdentifier("Navigate menu Previous reference")
            Divider()
            Button("Back") { store?.codeNav.goBack() }
                .keyboardShortcut("-", modifiers: .control)
                .disabled(store?.codeNav.history.canGoBack != true)
                .accessibilityIdentifier("Navigate menu Back")
            Button("Forward") { store?.codeNav.goForward() }
                .keyboardShortcut("-", modifiers: [.control, .shift])
                .disabled(store?.codeNav.history.canGoForward != true)
                .accessibilityIdentifier("Navigate menu Forward")
            Divider()
            Button("Open in IDE") {
                guard let store, let current = CodeNavActions.current(store) else { return }
                CodeNavActions.openInIDE(store, path: current.path, line: current.line)
            }
            .keyboardShortcut("o", modifiers: [.command, .option])
            // Not `current(_:)`: the caret moves with every click, and the menu bar should not be rebuilt for it.
            .disabled(store.map { $0.codeBrowser.selection == nil && $0.historySelection == nil && $0.liveSelection == nil && $0.selectedPath == nil } ?? true)
            .accessibilityIdentifier("Navigate menu Open in IDE")
        }
    }
}

/// Back / Forward for a header, each saying why it is off.
struct CodeNavHistoryButtons: View {
    @Environment(AppState.self) private var store

    var body: some View {
        let history = store.codeNav.history
        HStack(spacing: 2) {
            Button("Back", systemImage: "chevron.left") { store.codeNav.goBack() }
                .disabled(!history.canGoBack)
                .help(history.canGoBack ? Text("Back to where you jumped from (⌃-)") : Text("Nothing to go back to — ⌘-click a name to jump to its definition"))
                .accessibilityIdentifier("Navigate back")
            Button("Forward", systemImage: "chevron.right") { store.codeNav.goForward() }
                .disabled(!history.canGoForward)
                .help(history.canGoForward ? Text("Forward again (⌃⇧-)") : Text("Nothing to go forward to — go Back first"))
                .accessibilityIdentifier("Navigate forward")
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .fixedSize()
    }
}

// MARK: - The window

/// The window's side of code navigation: opens what a jump names (the review's diff at the line, or the file read-only),
/// shows Find References, keeps the caret, and hangs a popover from the diff pane when no row asked for it.
struct CodeNavObservers: ViewModifier {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    /// §65.8: the window shows the bottom panel (not on the PRs tab) — Find References fills its 참조 tab; else the sheet.
    let panelAvailable: Bool

    func body(content: Content) -> some View {
        @Bindable var nav = store.codeNav
        content
            .sheet(isPresented: $nav.referencesShown) { CodeNavReferencesSheet() }
            .onChange(of: nav.referencesTick) { _, _ in
                if panelAvailable { model.shell.show(.references) } else { nav.referencesShown = true }
            }
            .onChange(of: nav.openRequest?.tick) { _, _ in
                if let request = nav.openRequest { open(request.location) }
            }
            .popover(isPresented: Binding(get: { nav.popup?.anchor == CodeNavPointer.paneAnchor },
                                          set: { if !$0, nav.popup?.anchor == CodeNavPointer.paneAnchor { nav.dismissPopup() } }),
                     attachmentAnchor: .point(.top), arrowEdge: .top) {
                CodeNavPopupView()
            }
    }

    private func open(_ location: CodeNavLocation) {
        switch location.view {
        case .review:
            if store.selectFile(path: location.path) {
                model.showReviewDiff(path: location.path, line: location.line, orFile: true)
            } else {
                store.openProjectFile(path: location.path, line: location.line)
            }
        case .projectFile:
            store.openProjectFile(path: location.path, line: location.line)
        case .other:
            store.closeProjectFile()
        }
    }
}
