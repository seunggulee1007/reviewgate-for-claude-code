import SwiftUI
import AppKit
import UniformTypeIdentifiers
import ReviewGateCore

/// Keys the composer hands to SwiftUI before AppKit edits the text (the palettes and the prompt history use them).
extension AppSettings.Key {
    /// ↩ sends the message and ⇧↩ starts a new line (default); off: ↩ is a new line and ⌘↩ sends.
    static let returnSends = "composerReturnSends"
}

enum ComposerKey: Equatable {
    /// MARK: wave6 w6-terminal — §44.1: ↑ / ↓ say whether the caret is on the first / last line (the prompt history, as in
    /// the terminal, only walks from there; elsewhere the caret moves).
    case up(caretOnFirstLine: Bool), down(caretOnLastLine: Bool)
    case enter, tab, escape
    /// ⇧⇥ — the next permission mode (wave6 w6-terminal, §44.1).
    case backtab
    /// ⌘/ — the slash palette.
    case commandSlash
    /// ⌘⇧↩ — "Accept N & Send".
    case commandShiftEnter
    // MARK: wave1 mac-perms — polish-01: the card shortcuts reach the chat only from this text view (no window-wide keys).
    /// ⌘↩ — send / queue the draft, or allow the oldest permission card when the draft is empty.
    case commandEnter
    /// ⌥⌘↩ — allow the oldest card for the session (empty draft only).
    case optionCommandEnter
    /// ⌘⌫ — deny the oldest card (empty draft only; otherwise the text view deletes to the line start).
    case commandDelete
    /// §52: ⌃B in an empty message box — the running command goes on in the background (as in the terminal); with text
    /// typed it moves the caret back, as everywhere on the Mac.
    case controlB
    // MARK: r1-composer M08 — Claude's open question answered from the message box
    /// ⌥↩ — while Claude's question is open, the text goes to Claude apart from the question (otherwise a new line).
    case optionEnter
    /// 1…9 typed into an empty message box — while Claude's question is open, an option of it (otherwise the digit).
    case digit(Int)
}

/// What a paste or a drop brought into the composer (§23 mentions / §24 images).
enum ComposerDrop {
    /// Files (Finder, the changed-files list, a copied file).
    case files([URL])
    /// Raw image bytes (a screenshot on the clipboard, an image dragged from a browser).
    case image(Data, name: String)
}

/// The chat composer: a plain-text `NSTextView` (the SwiftUI `TextEditor` cannot take an image paste or tell a file drop
/// from text) that reports the caret for the @-mention popover and routes ↑ ↓ ↩ ⇥ ⎋ to the palettes.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    /// UTF-16 caret offset (written by the view; a new value from SwiftUI moves the caret once).
    @Binding var caret: Int
    /// Set to place the caret after SwiftUI rewrote the text (a picked mention); cleared by the view.
    @Binding var caretRequest: Int?
    @Binding var contentHeight: CGFloat
    var placeholder: String
    /// Returns true when SwiftUI handled the key (AppKit then does nothing).
    var onKey: (ComposerKey) -> Bool
    /// Returns true when the paste / drop was taken (images, files); false lets AppKit insert it as text.
    var onDrop: (ComposerDrop) -> Bool
    /// Called while a drag that `onDrop` would take hovers over the field.
    var onDragHover: (Bool) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let view = ComposerNSTextView()
        view.coordinator = context.coordinator
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.drawsBackground = false
        view.font = NSFont.preferredFont(forTextStyle: .body)
        view.textColor = .labelColor
        view.textContainerInset = NSSize(width: 2, height: 4)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.minSize = .zero
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.placeholder = placeholder
        view.delegate = context.coordinator
        view.string = text
        view.registerForDraggedTypes([.fileURL, .png, .tiff, NSPasteboard.PasteboardType(UTType.jpeg.identifier),
                                      NSPasteboard.PasteboardType(UTType.gif.identifier), NSPasteboard.PasteboardType(UTType.webP.identifier),
                                      .string])
        view.setAccessibilityIdentifier("Composer")
        view.setAccessibilityLabel(String(localized: "Message"))
        scroll.documentView = view
        context.coordinator.textView = view
        DispatchQueue.main.async { context.coordinator.reportHeight() }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let view = coordinator.textView else { return }
        view.placeholder = placeholder
        if view.string != text {
            coordinator.isApplying = true
            view.string = text
            let target = min(caretRequest ?? (text as NSString).length, (text as NSString).length)
            view.setSelectedRange(NSRange(location: target, length: 0))
            coordinator.isApplying = false
            view.needsDisplay = true
            coordinator.reportHeight()
            if caretRequest != nil { DispatchQueue.main.async { caretRequest = nil } }
            DispatchQueue.main.async { caret = target }
        } else if let request = caretRequest {
            view.setSelectedRange(NSRange(location: min(request, (text as NSString).length), length: 0))
            DispatchQueue.main.async { caretRequest = nil; caret = request }
        }
        if isFocused, let window = view.window, window.firstResponder !== view {
            DispatchQueue.main.async { window.makeFirstResponder(view) }
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        weak var textView: ComposerNSTextView?
        var isApplying = false

        init(_ parent: ComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard !isApplying, let view = textView else { return }
            parent.text = view.string
            parent.caret = view.selectedRange().location
            reportHeight()
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard !isApplying, let view = textView else { return }
            let location = view.selectedRange().location
            if parent.caret != location { parent.caret = location }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            // wave4 w4-input (polish-11): a key the input method still composes with (Korean / Japanese marked text) is
            // the IME's — it commits the syllable first, so Return never picks or sends half-typed text.
            if textView.hasMarkedText() { return false }
            // ⇧↩ is always a new line — ↩ itself sends when "Return sends" is on (`AppSettings.Key.returnSends`).
            if selector == #selector(NSResponder.insertNewline(_:)), NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            }
            // r1-composer M08: ⌥↩ (AppKit's new line that ignores the field editor) is the chat's when it wants it.
            if selector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)),
               NSApp.currentEvent?.modifierFlags.contains(.option) == true, parent.onKey(.optionEnter) {
                return true
            }
            let key: ComposerKey? = switch selector {
            case #selector(NSResponder.moveUp(_:)): .up(caretOnFirstLine: Self.caretLines(textView).first)
            case #selector(NSResponder.moveDown(_:)): .down(caretOnLastLine: Self.caretLines(textView).last)
            case #selector(NSResponder.insertNewline(_:)): .enter
            case #selector(NSResponder.insertTab(_:)): .tab
            case #selector(NSResponder.insertBacktab(_:)): .backtab   // wave6 w6-terminal (§44.1)
            case #selector(NSResponder.cancelOperation(_:)): .escape
            case #selector(NSResponder.moveBackward(_:)) where textView.string.isEmpty: .controlB   // §52
            default: nil
            }
            guard let key else { return false }
            return parent.onKey(key)
        }

        /// MARK: wave6 w6-terminal — §44.1: whether the caret is on the first / last visual line of the text (an empty text
        /// is both; a selection is neither — the arrows collapse it first).
        static func caretLines(_ view: NSTextView) -> (first: Bool, last: Bool) {
            let text = view.string as NSString
            let selection = view.selectedRange()
            guard selection.length == 0 else { return (false, false) }
            guard text.length > 0, let layout = view.layoutManager, let container = view.textContainer else { return (true, true) }
            layout.ensureLayout(for: container)
            func lineTop(_ index: Int) -> CGFloat {
                if index >= text.length {
                    // After a final newline the caret sits on the empty extra line.
                    if text.character(at: text.length - 1) == 0x0A, !layout.extraLineFragmentRect.isEmpty { return layout.extraLineFragmentRect.minY }
                    return layout.lineFragmentRect(forGlyphAt: layout.glyphIndexForCharacter(at: text.length - 1), effectiveRange: nil).minY
                }
                return layout.lineFragmentRect(forGlyphAt: layout.glyphIndexForCharacter(at: index), effectiveRange: nil).minY
            }
            let here = lineTop(min(selection.location, text.length))
            return (here <= lineTop(0) + 0.5, here >= lineTop(text.length) - 0.5)
        }

        func focusChanged(_ focused: Bool) {
            if parent.isFocused != focused { parent.isFocused = focused }
        }

        func reportHeight() {
            guard let view = textView, let layout = view.layoutManager, let container = view.textContainer else { return }
            layout.ensureLayout(for: container)
            let height = ceil(layout.usedRect(for: container).height + view.textContainerInset.height * 2)
            if abs(parent.contentHeight - height) > 0.5 {
                let parent = parent
                DispatchQueue.main.async { parent.contentHeight = height }
            }
        }
    }
}

/// The composer's text view: images and files from paste / drop go to SwiftUI, text stays text.
final class ComposerNSTextView: NSTextView {
    weak var coordinator: ComposerTextView.Coordinator?
    var placeholder = "" { didSet { if oldValue != placeholder { needsDisplay = true } } }

    /// A new width wraps the text anew (the window resized, the diff pane opened or closed beside the chat): the composer's
    /// height follows it, as it follows the text.
    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(newSize.width - frame.width) > 0.5
        super.setFrameSize(newSize)
        if widthChanged { coordinator?.reportHeight() }
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { coordinator?.focusChanged(true) }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { coordinator?.focusChanged(false) }
        return ok
    }

    /// r1-composer M08: 1…9 typed into an empty box go to the chat first (an option of Claude's open question); a digit it
    /// does not take is typed as usual.
    override func keyDown(with event: NSEvent) {
        if string.isEmpty, !hasMarkedText(), let coordinator,
           event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty,
           let typed = event.charactersIgnoringModifiers, typed.count == 1, let digit = Int(typed), (1...9).contains(digit),
           coordinator.parent.onKey(.digit(digit)) {
            return
        }
        super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self, let coordinator else { return super.performKeyEquivalent(with: event) }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == .command, event.charactersIgnoringModifiers == "/", coordinator.parent.onKey(.commandSlash) { return true }
        if flags == [.command, .shift], event.keyCode == 36 || event.keyCode == 76, coordinator.parent.onKey(.commandShiftEnter) { return true }
        // wave1 mac-perms (polish-01): ⌘↩ / ⌥⌘↩ / ⌘⌫ act for the chat only while this composer has the focus.
        let modifiers = flags.intersection([.command, .option, .shift, .control])
        if event.keyCode == 36 || event.keyCode == 76 {
            if modifiers == .command, coordinator.parent.onKey(.commandEnter) { return true }
            if modifiers == [.command, .option], coordinator.parent.onKey(.optionCommandEnter) { return true }
        }
        if event.keyCode == 51, modifiers == .command, coordinator.parent.onKey(.commandDelete) { return true }
        return super.performKeyEquivalent(with: event)
    }

    // MARK: Paste

    override func paste(_ sender: Any?) {
        if let drop = Self.drop(from: .general, forPaste: true), coordinator?.parent.onDrop(drop) == true { return }
        pasteAsPlainText(sender)
    }

    // MARK: Drop

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        if Self.drop(from: sender.draggingPasteboard, forPaste: false) != nil {
            coordinator?.parent.onDragHover(true)
            return .copy
        }
        return super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        if Self.drop(from: sender.draggingPasteboard, forPaste: false) != nil { return .copy }
        return super.draggingUpdated(sender)
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) {
        coordinator?.parent.onDragHover(false)
        super.draggingExited(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        coordinator?.parent.onDragHover(false)
        if let drop = Self.drop(from: sender.draggingPasteboard, forPaste: false) {
            return coordinator?.parent.onDrop(drop) ?? false
        }
        return super.performDragOperation(sender)
    }

    override func concludeDragOperation(_ sender: (any NSDraggingInfo)?) {
        coordinator?.parent.onDragHover(false)
        super.concludeDragOperation(sender)
    }

    /// Files first (a Finder copy also carries the icon as TIFF and the name as text), then image bytes; plain text → nil.
    static func drop(from pasteboard: NSPasteboard, forPaste: Bool) -> ComposerDrop? {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL], !urls.isEmpty {
            return .files(urls)
        }
        let types = pasteboard.types ?? []
        // A text paste that also carries a rendering (rich text from a browser) stays text.
        if forPaste, types.contains(.string), !types.contains(.png), !types.contains(.tiff) { return nil }
        for (type, ext) in [(NSPasteboard.PasteboardType.png, "png"), (NSPasteboard.PasteboardType(UTType.jpeg.identifier), "jpg"),
                            (NSPasteboard.PasteboardType(UTType.gif.identifier), "gif"), (NSPasteboard.PasteboardType(UTType.webP.identifier), "webp")] {
            if let data = pasteboard.data(forType: type) { return .image(data, name: "clipboard.\(ext)") }
        }
        if let tiff = pasteboard.data(forType: .tiff), let png = ImageEncoding.png(fromTIFF: tiff) {
            return .image(png, name: "clipboard.png")
        }
        return nil
    }

    // MARK: Placeholder

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let attributes: [NSAttributedString.Key: Any] = [.font: font ?? NSFont.preferredFont(forTextStyle: .body),
                                                         .foregroundColor: NSColor.placeholderTextColor]
        let origin = NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 5), y: textContainerInset.height)
        (placeholder as NSString).draw(at: origin, withAttributes: attributes)
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }
}

/// Image re-encoding for the composer: a clipboard TIFF becomes PNG (or JPEG when the PNG is over the 5 MB limit).
enum ImageEncoding {
    static func png(fromTIFF tiff: Data) -> Data? {
        guard let rep = NSBitmapImageRep(data: tiff) else { return nil }
        if let png = rep.representation(using: .png, properties: [:]), png.count <= 5 * 1024 * 1024 { return png }
        return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    }
}
