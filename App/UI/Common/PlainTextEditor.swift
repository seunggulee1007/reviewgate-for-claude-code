import SwiftUI
import AppKit

// MARK: polish p-foundation — PX-05: what is typed into a multi-line field reaches git, GitHub, CLAUDE.md and the allow
// patterns as typed. SwiftUI's `TextEditor` turns "quotes" into curly ones and -- into —, and applies the user's text
// replacements and spelling corrections: a commit message kept curly quotes, `npm test -- --watch` became
// `npm test — —watch` and no longer matched. The message box (`ComposerTextView`) already had them off.
//
//   TextEditor(text: $message).plainTextInput()
//   PlainTextEditor(text: $message)              // the same

extension View {
    /// The `TextEditor` this is put on keeps text as typed: no smart quotes or dashes, no text replacement, no spelling
    /// correction (undo stays on) — the message box's settings.
    func plainTextInput() -> some View {
        background(PlainTextInputFinder())
    }
}

/// A `TextEditor` that keeps text as typed (`plainTextInput()`).
struct PlainTextEditor: View {
    @Binding var text: String

    var body: some View {
        TextEditor(text: $text).plainTextInput()
    }
}

extension NSTextView {
    /// The message box's input settings (`ComposerTextView`), for any text view code or prose is typed into.
    func keepTextAsTyped() {
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        allowsUndo = true
    }
}

/// Finds the text view of the editor it lies behind — the one whose frame covers most of its own — and sets it to keep
/// text as typed; again whenever SwiftUI updates it (the editor may be made anew).
private struct PlainTextInputFinder: NSViewRepresentable {
    func makeNSView(context: Context) -> FinderView { FinderView() }

    func updateNSView(_ view: FinderView, context: Context) {
        view.applySoon()
    }

    final class FinderView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            applySoon()
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        /// After SwiftUI has placed the editor next to this view.
        func applySoon() {
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.apply() }
            }
        }

        private func apply() {
            guard window != nil, bounds.width > 0, bounds.height > 0 else { return }
            let mine = convert(bounds, to: nil)
            // The nearest ancestor with a text view over this frame: the editor's.
            var ancestor = superview
            while let container = ancestor {
                var best: (view: NSTextView, area: CGFloat)?
                for textView in Self.textViews(in: container) {
                    let frame = (textView.enclosingScrollView ?? textView)
                    let area = Self.area(frame.convert(frame.bounds, to: nil).intersection(mine))
                    if area > (best?.area ?? 0) { best = (textView, area) }
                }
                if let best {
                    best.view.keepTextAsTyped()
                    return
                }
                ancestor = container.superview
            }
        }

        private static func textViews(in view: NSView) -> [NSTextView] {
            var found: [NSTextView] = []
            var stack = [view]
            while let next = stack.popLast() {
                if let textView = next as? NSTextView, textView.isEditable { found.append(textView); continue }
                stack.append(contentsOf: next.subviews)
            }
            return found
        }

        private static func area(_ rect: CGRect) -> CGFloat {
            rect.isNull || rect.isEmpty ? 0 : rect.width * rect.height
        }
    }
}
