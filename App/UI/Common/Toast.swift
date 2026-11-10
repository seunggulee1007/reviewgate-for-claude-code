import SwiftUI
import AppKit

// MARK: polish p-foundation — P1-chrome-13 / P3-transcript-12: a copy (or any quick action without a visible result) says
// it happened — "복사됨", "복사됨: src/Svc.java", "경로 복사됨" — in a capsule at the top of the window it was done in, for
// a moment. One AppKit child window over the key window: no view, model or window state anywhere else takes part, so any
// view, menu item or command can call it.
//
//   Clipboard.copy(path)                          // "복사됨: <path>" (one line, middle-cut past 80 characters)
//   Clipboard.copy(text, toast: String(localized: "\(n) lines copied"))
//   Toast.show(String(localized: "Saved"))

@MainActor
enum Toast {
    /// How long a toast stays (a click closes it sooner).
    static let duration: Duration = .seconds(1.8)

    private static var panel: ToastPanel?
    private static var hideTask: Task<Void, Never>?

    /// How long a toast with an action stays (time to reach its button; Electron's `showToast` keeps it 6 s too).
    static let actionDuration: Duration = .seconds(6)

    /// r2-review-flow M28: a toast's one button ("파일 3개를 수락했어요 · [실행 취소]") — runs once, then the toast goes.
    struct Action {
        let title: String
        let run: @MainActor () -> Void
    }

    /// Shows `text` over the key window (the main window when no window is key) and announces it to VoiceOver. A newer
    /// toast replaces the one shown. With no window it is only announced. `action`: a button in the capsule (the toast
    /// stays `actionDuration`; a click elsewhere on it still closes it).
    static func show(_ text: String, systemImage: String = "checkmark.circle.fill", action: Action? = nil) {
        AccessibilityNotification.Announcement(action.map { "\(text) — \($0.title)" } ?? text).post()
        guard let parent = NSApp.keyWindow ?? NSApp.mainWindow, parent.isVisible else { return }
        dismiss(animated: false)
        let panel = ToastPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.fill(text, systemImage: systemImage, action: action)
        panel.appearance = parent.effectiveAppearance
        panel.place(over: parent)
        parent.addChildWindow(panel, ordered: .above)
        panel.alphaValue = 0
        panel.orderFront(nil)
        animate(panel, to: 1)
        self.panel = panel
        hideTask = Task {
            try? await Task.sleep(for: action == nil ? duration : actionDuration)
            guard !Task.isCancelled else { return }
            dismiss(animated: true)
        }
    }

    /// Closes the shown toast (a click on it does).
    static func dismiss(animated: Bool = true) {
        hideTask?.cancel()
        hideTask = nil
        guard let panel else { return }
        self.panel = nil
        guard animated, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { close(panel); return }
        animate(panel, to: 0)
        Task {
            try? await Task.sleep(for: .milliseconds(200))
            close(panel)
        }
    }

    private static func close(_ panel: NSPanel) {
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }

    private static func animate(_ panel: NSPanel, to alpha: CGFloat) {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { panel.alphaValue = alpha; return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            panel.animator().alphaValue = alpha
        }
    }
}

/// Puts text on the general pasteboard and confirms it with a `Toast`.
@MainActor
enum Clipboard {
    /// A copied value shown in "복사됨: …" is cut in the middle past this many characters.
    static let shownLimit = 80

    /// Copies `text`. The toast says `toast` when given; else "복사됨: <text>" for one line (middle-cut past `shownLimit`),
    /// "복사됨" for several lines.
    static func copy(_ text: String, toast: String? = nil) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        Toast.show(toast ?? confirmation(for: text))
    }

    /// "복사됨: <text>" / "복사됨" — what `copy` shows when it is given no words of its own.
    static func confirmation(for text: String) -> String {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty, !line.contains(where: \.isNewline) else { return String(localized: "Copied") }
        return String(localized: "Copied: \(middleTruncated(line, limit: shownLimit))")
    }

    /// `text` with its middle replaced by "…" when it is longer than `limit` characters (the start and the end stay).
    static func middleTruncated(_ text: String, limit: Int) -> String {
        guard text.count > limit, limit > 1 else { return text }
        let head = (limit - 1) / 2
        let tail = limit - 1 - head
        return String(text.prefix(head)) + "…" + String(text.suffix(tail))
    }
}

/// The toast's borderless child window: never key, never in the window list, a click closes it.
private final class ToastPanel: NSPanel {
    /// The capsule for `text` (with `action`'s button), the window sized to it.
    func fill(_ text: String, systemImage: String, action: Toast.Action? = nil) {
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        dismissesOnClick = action == nil
        let host = FirstClickHostingView(rootView: ToastCapsule(text: text, systemImage: systemImage, action: action))
        host.setFrameSize(host.fittingSize)
        contentView = host
        setContentSize(host.fittingSize)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Centred at the top of `parent`'s content, below its toolbar (the capsule's own margin is the gap).
    func place(over parent: NSWindow) {
        let content = parent.contentLayoutRect
        let top = parent.convertToScreen(NSRect(x: content.minX, y: content.maxY, width: content.width, height: 0))
        let size = frame.size
        setFrameOrigin(NSPoint(x: (top.midX - size.width / 2).rounded(), y: (top.minY - size.height).rounded()))
    }

    /// False with an action: the click belongs to its button (the toast goes after it, or by itself).
    var dismissesOnClick = true

    override func mouseDown(with event: NSEvent) {
        if dismissesOnClick { Toast.dismiss() } else { super.mouseDown(with: event) }
    }
}

/// The toast never becomes key: its button takes the first click (no click just to "activate" the panel).
private final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The capsule: the same look as the chat's permission notice (`PermissionToast`).
private struct ToastCapsule: View {
    @Environment(\.colorScheme) private var colorScheme
    let text: String
    let systemImage: String
    var action: Toast.Action?

    var body: some View {
        HStack(spacing: 10) {
            Label(text, systemImage: systemImage)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action.title) {
                    action.run()
                    Toast.dismiss()
                }
                .buttonStyle(.borderless)
                .fontWeight(.semibold)
                .accessibilityIdentifier("Toast action")
            }
        }
            .font(.callout)
            .foregroundStyle(.primary)
            .frame(maxWidth: 520, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35)))
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.45 : 0.15), radius: 6, y: 2)
            .padding(10)   // room for the shadow inside the borderless window
            .accessibilityHidden(action == nil)   // announced when shown (`Toast.show`); a button stays reachable
    }
}
