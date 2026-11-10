import SwiftUI
import AppKit

// MARK: polish p-foundation — P4-composer-31 / PX-18: a sheet fits the window it opens on. In a 1000×637 window a sheet
// has about 580 pt of height: fixed 620–760 pt sheets hung their buttons below the window. The sheet asks for its usual
// size, never more than the window has (less a margin), can be made larger or smaller by dragging, and opens at the size
// it was last dragged to.
//
//   .adaptiveSheetFrame(width: 640, height: 560, key: "instructionsEditor")
//
// Keep the sheet's body in a ScrollView with its buttons below it, so a short window shrinks the body, not the buttons.

extension View {
    /// The sheet's frame: `width`×`height` when the window has room, at least `minWidth` (0.8 × `width`) × `minHeight`,
    /// resizable; `key` remembers the size the user gave it (nil: not remembered).
    func adaptiveSheetFrame(width: CGFloat, height: CGFloat, minWidth: CGFloat? = nil, minHeight: CGFloat = 320,
                            key: String? = nil) -> some View {
        modifier(AdaptiveSheetFrame(width: width, height: height, minWidth: minWidth ?? (width * 0.8).rounded(),
                                    minHeight: minHeight, key: key))
    }
}

private struct AdaptiveSheetFrame: ViewModifier {
    let width: CGFloat
    let height: CGFloat
    let minWidth: CGFloat
    let minHeight: CGFloat
    let key: String?
    /// The window the sheet opened on: measured once, when the sheet is made.
    @State private var room = AdaptiveSheet.room()

    func body(content: Content) -> some View {
        let size = AdaptiveSheet.size(width: width, height: height, minWidth: minWidth, minHeight: minHeight,
                                      remembered: key.flatMap(AdaptiveSheet.remembered), room: room)
        content
            .frame(minWidth: size.min.width, idealWidth: size.ideal.width, maxWidth: .infinity,
                   minHeight: size.min.height, idealHeight: size.ideal.height, maxHeight: .infinity)
            .onGeometryChange(for: CGSize.self, of: \.size) { new in
                // Only a size the user gave it: the one it opened at may be cut to a small window.
                guard let key, abs(new.width - size.ideal.width) > 1 || abs(new.height - size.ideal.height) > 1 else { return }
                AdaptiveSheet.remember(new, key: key)
            }
    }
}

enum AdaptiveSheet {
    /// What a sheet leaves of its window: room for the window's title bar and edges.
    static let margin = CGSize(width: 40, height: 60)
    private static let defaultsPrefix = "sheetSize."

    /// The content size of the window a sheet opens on — the key window's, or its parent's when the key window is a sheet;
    /// nil without a window.
    @MainActor static func room() -> CGSize? {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else { return nil }
        return (window.sheetParent ?? window).contentLayoutRect.size
    }

    /// The sheet's ideal size — the remembered one, else `width`×`height` — and its minimum, both within `room` less the
    /// margin (the minimum gives way first).
    static func size(width: CGFloat, height: CGFloat, minWidth: CGFloat, minHeight: CGFloat, remembered: CGSize?,
                     room: CGSize?) -> (ideal: CGSize, min: CGSize) {
        let wanted = remembered ?? CGSize(width: width, height: height)
        guard let room else { return (wanted, CGSize(width: min(minWidth, wanted.width), height: min(minHeight, wanted.height))) }
        let most = CGSize(width: max(200, room.width - margin.width), height: max(200, room.height - margin.height))
        let ideal = CGSize(width: min(wanted.width, most.width), height: min(wanted.height, most.height))
        return (ideal, CGSize(width: min(minWidth, ideal.width), height: min(minHeight, ideal.height)))
    }

    /// The size the sheet under `key` was last given.
    static func remembered(_ key: String) -> CGSize? {
        guard let parts = UserDefaults.standard.array(forKey: defaultsPrefix + key) as? [Double], parts.count == 2,
              parts[0] > 0, parts[1] > 0 else { return nil }
        return CGSize(width: parts[0], height: parts[1])
    }

    static func remember(_ size: CGSize, key: String) {
        guard size.width > 0, size.height > 0 else { return }
        UserDefaults.standard.set([Double(size.width.rounded()), Double(size.height.rounded())], forKey: defaultsPrefix + key)
    }
}
