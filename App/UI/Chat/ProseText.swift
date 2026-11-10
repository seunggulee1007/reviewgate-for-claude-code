import SwiftUI
import AppKit
import ReviewGateCore

// The prose of a markdown reply — paragraphs, headings, lists — as AppKit text (user report: "복붙도 안되고… 링크도 제대로
// 안 열리고"). SwiftUI's selectable `Text` selects within one paragraph and takes a click on a link as the start of a
// selection; one `NSTextView` per run of prose blocks selects across them and opens a link on the first click, and the
// bare URLs and file references in it (`Foo.java:42`, `ChatLinks`) are links too. Code blocks, tables, quotes and rules
// stay SwiftUI views (`MarkdownText`).

/// How a run of prose is set: the body size (the `.font` around the markdown — callout in the agent and side panes) and
/// whether it is secondary (an answer Claude Code ran on its own, a quote).
struct ProseStyle: Hashable {
    var size: CGFloat
    var secondary: Bool

    /// The point size on macOS of the text style the markdown is shown in; the body's otherwise.
    static func size(for font: Font?) -> CGFloat {
        switch font {
        case .callout?: 12
        case .subheadline?: 11
        case .footnote?, .caption?, .caption2?: 10
        default: NSFont.systemFontSize
        }
    }
}

/// What file references resolve against: the project root and, for a bare `Foo.java`, the paths the app knows (the
/// review's files, the files the chat touched) — read only when a reference needs them, once per build.
@MainActor
final class ProseLinks {
    let root: String?
    private let load: () -> [String]
    private var known: [String]?

    init(root: String?, candidates: @escaping () -> [String]) {
        self.root = root
        load = candidates
    }

    /// The repo-relative path of an existing file `ref` names under the root.
    func resolve(_ ref: ChatLinks.FileRef) -> String? {
        guard let root else { return nil }
        return ChatLinks.resolve(ref, root: root, candidates: { known ?? { known = load(); return known ?? [] }() }, exists: { path in
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && !isDirectory.boolValue
        })
    }

    /// The link a markdown link keeps: a web one as it is, one naming an existing project file as the in-app file link;
    /// nil (no link) otherwise.
    func target(ofMarkdownLink url: URL) -> URL? {
        if ChatLinks.isWeb(url) { return url }
        guard let ref = ChatLinks.fileRef(linkDestination: url.absoluteString), let path = resolve(ref) else { return nil }
        return ChatLinks.fileURL(path: path, line: ref.line)
    }

    /// The link of a scanned match: a web URL, or the in-app link of a file that exists.
    func target(of match: ChatLinks.Match) -> (url: URL, tip: String)? {
        switch match.target {
        case let .web(url):
            return (url, url.absoluteString)
        case let .file(ref):
            guard let path = resolve(ref), let url = ChatLinks.fileURL(path: path, line: ref.line) else { return nil }
            return (url, ref.line.map { "\(path):\($0)" } ?? path)
        }
    }
}

/// Opens a chat link: a project file in the review's diff, at its line, when it is under review, else read-only in the code
/// viewer at its line (the external editor when no project is open); a web link in the default browser. Anything else is not
/// opened.
@MainActor
enum ChatLinkOpener {
    @discardableResult
    static func open(_ url: URL, store: AppState?, model: WindowModel?) -> Bool {
        if let target = ChatLinks.fileTarget(url) {
            openFile(target.path, line: target.line, store: store, model: model)
            return true
        }
        guard ChatLinks.isWeb(url) else { return false }
        NSWorkspace.shared.open(url)
        return true
    }

    private static func openFile(_ path: String, line: Int?, store: AppState?, model: WindowModel?) {
        guard let store else { return }
        if store.changedFiles.contains(where: { $0.path == path }) {
            // As a side question's "Show diff": back from the history to the current review, on that file.
            store.closeHistoryDiff()
            if let model, model.tab != .changes { model.tab = .changes }
            store.selectFile(path: path)   // closes the code viewer too; a no-op for the file already selected
            model?.showReviewDiff(path: path, line: line)   // so the pane opens and the line shows even then
            return
        }
        // code-browser (§47): any other project file opens read-only in the diff pane, at its line.
        if store.openProjectFile(path: path, line: line) { return }
        guard let root = store.projectInfo?.root ?? store.projectURL?.path else { return }
        let absolute = (root as NSString).appendingPathComponent(path)
        // The editor "Open in Editor" uses (remembered, else the first installed); without one, the file's default app.
        if let editor = ExternalEditor.preferred ?? ExternalEditor.installed.first(where: { $0 != .finder }) {
            editor.open(absolute, line: line ?? 1)
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: absolute))
        }
    }
}

// MARK: - Building the text

/// The attributed text of a run of prose blocks, cached per run, style and root (a row drawn again gets the same object,
/// so its text view is not set again).
@MainActor
enum ProseBuilder {
    private static let cache: NSCache<NSString, NSAttributedString> = {
        let cache = NSCache<NSString, NSAttributedString>()
        cache.countLimit = 600
        return cache
    }()

    static func text(_ blocks: [MarkdownBlocks.Block], style: ProseStyle, links: ProseLinks) -> NSAttributedString {
        let key = "\(links.root ?? "")\u{1}\(style.size)\u{1}\(style.secondary)\u{1}\(String(describing: blocks))" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        let built = build(blocks, style: style, links: links)
        cache.setObject(built, forKey: key)
        return built
    }

    private static func build(_ blocks: [MarkdownBlocks.Block], style: ProseStyle, links: ProseLinks) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let color: NSColor = style.secondary ? .secondaryLabelColor : .labelColor
        let body = NSFont.systemFont(ofSize: style.size)

        /// One paragraph: a newline before it (but the first), `spacing` above it, the indents of a list item.
        func paragraph(_ content: NSAttributedString, spacing: CGFloat, indent: CGFloat = 0, head: CGFloat? = nil) {
            let para = NSMutableParagraphStyle()
            para.paragraphSpacingBefore = out.length == 0 ? 0 : spacing
            para.firstLineHeadIndent = indent
            para.headIndent = head ?? indent
            if let head { para.tabStops = [NSTextTab(textAlignment: .left, location: head)] }
            let start = out.length
            if start > 0 { out.append(NSAttributedString(string: "\n", attributes: [.font: body, .foregroundColor: color])) }
            out.append(content)
            out.addAttribute(.paragraphStyle, value: para, range: NSRange(location: start, length: out.length - start))
        }

        for (index, block) in blocks.enumerated() {
            let gap: CGFloat = index == 0 ? 0 : 8
            switch block {
            case let .paragraph(lines):
                for (i, line) in lines.enumerated() {
                    paragraph(inline(line, font: body, color: color, links: links), spacing: i == 0 ? gap : 2)
                }
            case let .heading(level, text):
                let font = level <= 1 ? NSFont.systemFont(ofSize: 15, weight: .bold)   // .title3.bold
                    : level == 2 ? NSFont.systemFont(ofSize: 13, weight: .bold)   // .headline
                    : NSFont.systemFont(ofSize: 11, weight: .semibold)   // .subheadline.semibold
                paragraph(inline(text, font: font, color: color, links: links), spacing: gap + 2)
            case let .list(items):
                let column = markerColumn(items, font: body)
                for (i, item) in items.enumerated() {
                    let indent = CGFloat(item.indent) * 16
                    let line = NSMutableAttributedString(attributedString: marker(item.marker, font: body))
                    line.append(NSAttributedString(string: "\t", attributes: [.font: body]))
                    line.append(inline(item.text, font: body, color: color, links: links))
                    paragraph(line, spacing: i == 0 ? gap : 3, indent: indent, head: indent + column)
                    if !item.code.isEmpty {   // 4-space indented lines under the item, as written
                        let code = NSAttributedString(string: item.code.joined(separator: "\n"), attributes: [
                            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor,
                        ])
                        paragraph(code, spacing: 2, indent: indent + 18)
                    }
                }
            case .code, .table, .quote, .rule:
                break   // not prose: drawn by `MarkdownText`
            }
        }
        return out
    }

    /// Where a list's text starts after its markers: the widest marker and a gap.
    private static func markerColumn(_ items: [MarkdownBlocks.ListItem], font: NSFont) -> CGFloat {
        let widest = items.map { marker($0.marker, font: font).size().width }.max() ?? 0
        return ceil(widest) + 6
    }

    private static func marker(_ marker: MarkdownBlocks.ListItem.Marker, font: NSFont) -> NSAttributedString {
        switch marker {
        case .bullet:
            NSAttributedString(string: "•", attributes: [.font: font, .foregroundColor: NSColor.secondaryLabelColor])
        case let .ordered(number):
            NSAttributedString(string: number, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: font.pointSize, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor,
            ])
        case let .task(done):
            NSAttributedString(string: done ? "☑" : "☐", attributes: [
                .font: font, .foregroundColor: done ? NSColor.controlAccentColor : NSColor.secondaryLabelColor,
            ])
        }
    }

    /// A line's inline markdown (bold, italic, code, strikethrough, links) in `font`, then its bare URLs and the file
    /// references that exist linked.
    static func inline(_ source: String, font: NSFont, color: NSColor, links: ProseLinks) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let parsed = try? AttributedString(markdown: source, options: options) {
            for run in parsed.runs {
                var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: color]
                var traits: NSFontDescriptor.SymbolicTraits = []
                var runFont = font
                if let intent = run.inlinePresentationIntent {
                    if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
                    if intent.contains(.emphasized) { traits.insert(.italic) }
                    if intent.contains(.code) {
                        runFont = NSFont.monospacedSystemFont(ofSize: font.pointSize, weight: traits.contains(.bold) ? .bold : .regular)
                    }
                    if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                }
                if !traits.isEmpty, !(run.inlinePresentationIntent?.contains(.code) ?? false) {
                    runFont = NSFont(descriptor: font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(traits)),
                                     size: font.pointSize) ?? font
                }
                attributes[.font] = runFont
                let text = String(parsed[run.range].characters)
                // A written link keeps its target; the parser's own bare-URL links are left to the scan below.
                if let link = run.link, !ChatLinks.isAutolink(text: text, url: link), let target = links.target(ofMarkdownLink: link) {
                    attributes[.link] = target
                    attributes[.toolTip] = ChatLinks.fileTarget(target).map { t in t.line.map { "\(t.path):\($0)" } ?? t.path }
                        ?? target.absoluteString
                }
                out.append(NSAttributedString(string: text, attributes: attributes))
            }
        } else {
            out.append(NSAttributedString(string: source, attributes: [.font: font, .foregroundColor: color]))
        }
        for match in ChatLinks.scan(out.string) where !hasLink(out, in: match.range) {
            guard let target = links.target(of: match) else { continue }
            out.addAttributes([.link: target.url, .toolTip: target.tip], range: match.range)
        }
        return out
    }

    private static func hasLink(_ text: NSAttributedString, in range: NSRange) -> Bool {
        var found = false
        text.enumerateAttribute(.link, in: range) { value, _, stop in
            if value != nil {
                found = true
                stop.pointee = true
            }
        }
        return found
    }
}

// MARK: - The view

/// Items a prose text's own right-click menu starts with (an answer's "Copy message", "Ask about this answer…"): the
/// AppKit text takes the right-click, so the row's SwiftUI menu does not open over it.
struct ProseMenuItem {
    var title: String
    var isEnabled: () -> Bool = { true }
    var action: () -> Void
}

extension EnvironmentValues {
    @Entry var proseMenuItems: [ProseMenuItem] = []
}

/// Selectable, non-editable text that wraps to the width it is offered and hugs a shorter text, like `Text`. Its size comes
/// from a TextKit stack of its own, from the text and the width alone — never from the view's current frame — so laying
/// it out cannot feed back into another layout pass.
struct ProseTextView: NSViewRepresentable {
    let text: NSAttributedString
    let onLink: (URL) -> Void
    @Environment(\.proseMenuItems) private var menuItems

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> ProseNSTextView {
        let view = ProseNSTextView(usingTextLayoutManager: false)   // TextKit 1, as the coordinator measures
        view.isEditable = false
        view.isSelectable = true
        view.isRichText = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.autoresizingMask = []
        view.isAutomaticLinkDetectionEnabled = false
        view.linkTextAttributes = [
            .foregroundColor: NSColor.linkColor, .underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand,
        ]
        view.delegate = context.coordinator
        return view
    }

    func updateNSView(_ view: ProseNSTextView, context: Context) {
        context.coordinator.onLink = onLink
        view.extraMenuItems = menuItems
        if context.coordinator.shown !== text {
            context.coordinator.shown = text
            view.textStorage?.setAttributedString(text)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ProseNSTextView, context: Context) -> CGSize? {
        context.coordinator.size(of: text, proposedWidth: proposal.width)
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var onLink: (URL) -> Void = { _ in }
        /// The text the view shows (compared by identity: the builder caches it).
        var shown: NSAttributedString?
        private let storage = NSTextStorage()
        private let layout = NSLayoutManager()
        private let container = NSTextContainer(size: .zero)
        private var measured: NSAttributedString?
        private var idealWidth: CGFloat = 0
        private var heights: [CGFloat: CGFloat] = [:]

        override init() {
            super.init()
            container.lineFragmentPadding = 0
            layout.addTextContainer(container)
            storage.addLayoutManager(layout)
        }

        /// The offered width (at most the unwrapped text's, at least a sliver) and the height the text wraps to in it.
        func size(of text: NSAttributedString, proposedWidth: CGFloat?) -> CGSize {
            if measured !== text {
                measured = text
                storage.setAttributedString(text)
                heights = [:]
                idealWidth = ceil(usedRect(width: 100_000).width) + 1   // +1: a pixel-rounded frame never wraps the widest line
            }
            var width = idealWidth
            if let proposed = proposedWidth, proposed.isFinite { width = min(max(proposed, 24), idealWidth) }
            if let height = heights[width] { return CGSize(width: width, height: height) }
            if heights.count > 32 { heights = [:] }   // a window being resized offers many widths
            let height = ceil(usedRect(width: width).height)
            heights[width] = height
            return CGSize(width: width, height: height)
        }

        private func usedRect(width: CGFloat) -> NSRect {
            container.size = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
            layout.ensureLayout(for: container)
            return layout.usedRect(for: container)
        }

        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:)) { onLink(url) }
            return true
        }
    }
}

final class ProseNSTextView: NSTextView {
    var extraMenuItems: [ProseMenuItem] = []

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        guard !extraMenuItems.isEmpty else { return menu }
        menu.insertItem(.separator(), at: 0)
        for (index, extra) in extraMenuItems.enumerated() {
            let handler = ProseMenuHandler(extra.action, enabled: extra.isEnabled())
            let item = NSMenuItem(title: extra.title, action: #selector(ProseMenuHandler.run), keyEquivalent: "")
            item.target = handler
            item.representedObject = handler   // the item keeps its handler alive (`target` is weak)
            menu.insertItem(item, at: index)
        }
        return menu
    }
}

private final class ProseMenuHandler: NSObject, NSMenuItemValidation {
    private let action: () -> Void
    private let enabled: Bool

    init(_ action: @escaping () -> Void, enabled: Bool) {
        self.action = action
        self.enabled = enabled
    }

    @objc func run() { action() }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { enabled }
}
