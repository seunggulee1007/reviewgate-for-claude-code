import AppKit
@preconcurrency import SwiftTerm

// MARK: terminal-chat (§57.5)
/// SwiftTerm's LocalProcessTerminalView with the host-side fixes the terminal chat and the shell panel need (hand-tested in
/// the M0 spike): IUTF8 on the PTY, ⌘C that never beeps or clears the clipboard, Hanja (⌥Return) conversion, a commit on
/// focus loss mid-composition, and the marked-text overlay that neither blanks the rest of the line (SwiftTerm#825) nor
/// stays behind the caret (#826).
final class ReviewTerminalView: LocalProcessTerminalView {
    private var caretObserver: NSObjectProtocol?

    /// Terminal.app and iTerm2 set IUTF8 on the PTY so the kernel's cooked-mode erase removes a whole UTF-8 character;
    /// SwiftTerm leaves it off (Backspace after 한 in `cat` or `read` deletes one byte). Call after `startProcess`.
    func enableUTF8LineEditing() {
        let fd = process.childfd
        guard fd >= 0 else { return }
        var t = termios()
        guard tcgetattr(fd, &t) == 0 else { return }
        t.c_iflag |= tcflag_t(IUTF8)
        tcsetattr(fd, TCSANOW, &t)
    }

    // MARK: terminal-friction — what goes to the PTY, files dropped on it (§57.4 / §57.5)

    /// Every write to the PTY — the user's keys, a paste, the terminal's own replies — before it goes (the Esc rule).
    var onInput: ((ArraySlice<UInt8>) -> Void)?

    override func send(source: TerminalView, data: ArraySlice<UInt8>) {
        onInput?(data)
        super.send(source: source, data: data)
    }

    /// Files dropped from Finder (or a screenshot's thumbnail): true when they went in. Nil: drops are not taken.
    var onDropFiles: (([URL]) -> Bool)? {
        didSet { onDropFiles == nil ? unregisterDraggedTypes() : registerForDraggedTypes([.fileURL]) }
    }

    private static func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        onDropFiles != nil && !Self.fileURLs(sender).isEmpty ? .copy : []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        draggingEntered(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = Self.fileURLs(sender)
        guard !urls.isEmpty, let onDropFiles else { return false }
        return onDropFiles(urls)
    }

    // MARK: Copy

    /// The terminal's own selection (not Claude Code's in-app selection, which it copies itself on select).
    var hasLocalSelection: Bool { !(getSelection() ?? "").isEmpty }

    /// SwiftTerm enables Copy only for its own selection. Claude Code's fullscreen view draws its own selection (mouse
    /// tracking) and copies it on select, so ⌘C must not beep then.
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(copy(_:)) { return true }
        return super.validateUserInterfaceItem(item)
    }

    /// With no terminal selection the clipboard stays as it is (what Claude Code copied stays there).
    override func copy(_ sender: Any) {
        if hasLocalSelection { super.copy(sender) }
    }

    // MARK: Hanja conversion (⌥Return)
    //
    // The 2-Set Korean input method commits the syllable, reads up to 10 characters before the caret
    // (attributedSubstring), then replaces them (setMarkedText / insertText with a replacementRange). SwiftTerm only exposes
    // marked text, so the input method gave up and passed the Return on. Outside a composition the document here is the
    // cursor row's text left of the cursor, in UTF-16 units; replacing its tail sends one DEL per character.

    /// The cursor row's text left of the cursor, one string per occupied cell.
    func textBeforeCursor() -> String {
        guard let snap = terminalContentSnapshot(region: .history(maximumScrollbackRows: 0)),
              let row = snap.rows.first(where: { $0.absoluteRow == snap.cursorRow }) else { return "" }
        var text = ""
        for cell in row.cells.prefix(max(0, snap.cursorColumn)) where cell.width != 0 {
            text += cell.text.isEmpty ? " " : cell.text
        }
        return text
    }

    /// What the input method last read before the cursor (`attributedSubstring`): a replacement deletes only that text.
    private var lastRead: (range: NSRange, text: String)?

    /// Deletes the end of the line before the cursor when `range` is its tail and still holds what the input method read
    /// there — the row may have changed since (the program redrew it), and other text of the same length must not go.
    /// False when the range is not something we can replace (then the caller does what SwiftTerm does).
    private func deleteBeforeCursor(_ range: NSRange) -> Bool {
        guard !hasMarkedText(), range.location != NSNotFound, range.length > 0 else { return false }
        let before = textBeforeCursor() as NSString
        guard range.location + range.length == before.length,
              let read = lastRead, range.location >= read.range.location, NSMaxRange(range) <= NSMaxRange(read.range) else { return false }
        let doomed = before.substring(with: range)
        let wasRead = (read.text as NSString).substring(with: NSRange(location: range.location - read.range.location, length: range.length))
        guard doomed == wasRead else { return false }
        lastRead = nil
        send(data: ArraySlice(Array(repeating: UInt8(0x7f), count: doomed.count)))
        return true
    }

    override func selectedRange() -> NSRange {
        hasMarkedText() ? super.selectedRange() : NSRange(location: (textBeforeCursor() as NSString).length, length: 0)
    }

    override func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        guard !hasMarkedText(), range.location != NSNotFound else {
            return super.attributedSubstring(forProposedRange: range, actualRange: actualRange)
        }
        let before = textBeforeCursor() as NSString
        let lo = min(range.location, before.length)
        let hi = min(range.location + range.length, before.length)
        guard hi > lo else { return nil }
        let clamped = NSRange(location: lo, length: hi - lo)
        actualRange?.pointee = clamped
        let text = before.substring(with: clamped)
        lastRead = (clamped, text)
        return NSAttributedString(string: text)
    }

    override func insertText(_ string: Any, replacementRange: NSRange) {
        if deleteBeforeCursor(replacementRange) {
            super.insertText(string, replacementRange: NSRange(location: NSNotFound, length: 0))
            return
        }
        super.insertText(string, replacementRange: replacementRange)
    }

    // MARK: IME overlay

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { startCaretObservation() }
    }

    /// The marked-text overlay SwiftTerm adds (internal DictationOverlayTextView).
    var markedOverlay: NSTextView? {
        subviews.compactMap { $0 as? NSTextView }.first { String(describing: type(of: $0)).contains("Overlay") }
    }

    /// SwiftTerm's caret view (internal `caretView`). It leaves the view hierarchy while the cursor is hidden, so find it
    /// by reflection rather than among subviews.
    lazy var caretSubview: NSView? = {
        var mirror: Mirror? = Mirror(reflecting: self)
        while let m = mirror {
            for child in m.children where child.label == "caretView" {
                if let v = child.value as? NSView { return v }
                if let o = child.value as? NSView? { return o }
            }
            mirror = m.superclassMirror
        }
        return nil
    }()

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        if deleteBeforeCursor(replacementRange) {
            super.setMarkedText(string, selectedRange: selectedRange, replacementRange: NSRange(location: NSNotFound, length: 0))
        } else {
            super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        }
        lastMarkedSelectedRange = selectedRange
        applyOverlayClip()
    }

    private var lastMarkedSelectedRange = NSRange(location: NSNotFound, length: 0)

    /// Apple: "The text view should accept the marked text as if it had been inserted normally." SwiftTerm 1.99.3 drops
    /// it. AppKit calls this when focus leaves mid-composition (a click in the diff, ⌘-Tab).
    override func unmarkText() {
        if hasMarkedText(),
           let text = attributedSubstring(forProposedRange: markedRange(), actualRange: nil)?.string, !text.isEmpty {
            insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            return
        }
        super.unmarkText()
    }

    /// #825: the overlay spans to the right edge and its per-fragment fill blanks the rest of the line. Mask the overlay's
    /// layer to the cells the composed text covers. (Narrowing the frame moves NSTextView's textContainerOrigin; narrowing
    /// the container pushes line 1 below the exclusion path.)
    private func applyOverlayClip() {
        guard let overlay = markedOverlay, let container = overlay.textContainer,
              let lm = overlay.layoutManager, hasMarkedText(), cellWidth > 0 else { return }
        overlay.wantsLayer = true
        var lines = 0
        if lm.numberOfGlyphs > 0 {
            lm.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: lm.numberOfGlyphs)) { _, _, _, _, _ in lines += 1 }
        }
        // A long composition that wraps keeps SwiftTerm's own layout.
        guard lines == 1 else { overlay.layer?.mask = nil; return }
        let exclusion = container.exclusionPaths.first?.bounds.width ?? 0
        let cells = overlay.string.unicodeScalars.reduce(0) { $0 + Self.cellCount($1) }
        let mask = overlay.layer?.mask ?? CALayer()
        mask.backgroundColor = NSColor.black.cgColor
        mask.frame = CGRect(x: 0, y: 0, width: ceil(exclusion + CGFloat(max(1, cells)) * cellWidth), height: overlay.bounds.height)
        overlay.layer?.mask = mask
    }

    /// One cell's width in points (0 before the first layout).
    var cellWidth: CGFloat {
        let size = getWindowSize()
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        guard size.ws_col > 0 else { return 0 }
        return CGFloat(size.ws_xpixel) / scale / CGFloat(size.ws_col)
    }

    /// Cells a scalar takes in the overlay (wide East Asian characters 2, combining marks 0).
    static func cellCount(_ s: Unicode.Scalar) -> Int {
        let v = s.value
        if v == 0x200B || (0x0300...0x036F).contains(v) || (0x1160...0x11FF).contains(v) { return 0 }
        if (0x1100...0x115F).contains(v) || (0x2E80...0xA4CF).contains(v) || (0xAC00...0xD7A3).contains(v)
            || (0xF900...0xFAFF).contains(v) || (0xFE30...0xFE4F).contains(v) || (0xFF00...0xFF60).contains(v)
            || (0xFFE0...0xFFE6).contains(v) || (0x1F300...0x1FAFF).contains(v) || (0x20000...0x3FFFD).contains(v) {
            return 2
        }
        return 1
    }

    /// #826: SwiftTerm positions the overlay only inside setMarkedText / insertText / unmarkText. When the echo of a
    /// just-committed syllable moves the caret, re-deliver the marked text.
    private func startCaretObservation() {
        guard caretObserver == nil, let caret = caretSubview else { return }
        caret.postsFrameChangedNotifications = true
        caretObserver = NotificationCenter.default.addObserver(
            forName: NSView.frameDidChangeNotification, object: caret, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.followCaret() }
        }
    }

    /// Stops following the caret (the view is going away).
    func stopCaretObservation() {
        if let caretObserver { NotificationCenter.default.removeObserver(caretObserver) }
        caretObserver = nil
    }

    private var redelivering = false
    private func followCaret() {
        guard !redelivering, hasMarkedText(),
              let marked = attributedSubstring(forProposedRange: markedRange(), actualRange: nil) else { return }
        redelivering = true
        defer { redelivering = false }
        let sel = lastMarkedSelectedRange.location == NSNotFound
            ? NSRange(location: marked.length, length: 0) : lastMarkedSelectedRange
        setMarkedText(marked, selectedRange: sel, replacementRange: NSRange(location: NSNotFound, length: 0))
    }
}
