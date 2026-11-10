import SwiftUI
import AppKit
import ReviewGateCore

/// M18: the `appearance` setting, applied to everything the app draws.
extension Appearance {
    /// `nil` for `.system`, so `.preferredColorScheme(nil)` leaves the window following macOS.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// `NSApp.appearance`: what the menu bar, sheets, alerts, popovers, toolbars and the Settings
    /// window follow. `nil` hands them back to the system setting.
    var nsAppearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }
}

/// Applies the appearance setting to one scene. `@AppStorage` observes the stored value, so changing
/// it in Settings repaints every open window and the menu bar at once — no relaunch.
private struct AppearanceModifier: ViewModifier {
    @AppStorage(AppSettings.Key.appearance) private var raw = Appearance.system.rawValue

    private var appearance: Appearance { Appearance(rawValue: raw) ?? .system }

    func body(content: Content) -> some View {
        content
            .preferredColorScheme(appearance.colorScheme)
            .onChange(of: raw, initial: true) { _, _ in
                NSApplication.shared.appearance = appearance.nsAppearance
            }
    }
}

extension View {
    /// Put this on every scene's root so windows, sheets and the menu bar share one appearance.
    func appAppearance() -> some View { modifier(AppearanceModifier()) }
}

/// An icon-only button whose hit area is a small control, not the glyph. With `.plain` only the glyph's frame is
/// clickable — the chat strip's `+` was 9×9 pt and a click beside it did nothing; padding outside a button never counts.
/// polish p-foundation (P1-chrome-14): it answers the pointer — a rounded wash under it while hovered, a stronger one while
/// pressed (the glyph still dims), none while disabled — so an icon reads as a button before its tooltip shows.
struct IconButtonStyle: ButtonStyle {
    var padding: CGFloat = 4

    func makeBody(configuration: Configuration) -> some View {
        IconButtonBody(configuration: configuration, padding: padding)
    }
}

private struct IconButtonBody: View {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorScheme) private var colorScheme
    let configuration: ButtonStyleConfiguration
    let padding: CGFloat
    /// The button's own hover flag (a list of icon buttons never redraws for the pointer moving over one).
    @State private var hovering = false

    var body: some View {
        configuration.label
            .frame(minWidth: 16, minHeight: 16)
            .padding(padding)
            .opacity(isEnabled ? (configuration.isPressed ? 0.5 : 1) : 0.4)
            .background(RoundedRectangle(cornerRadius: 5).fill(Color.primary.opacity(wash)))
            .contentShape(Rectangle())
            .onHover { inside in
                if hovering != inside { hovering = inside }
            }
    }

    /// The wash under the glyph: pressed 0.16, hovered 0.08 (0.12 in dark appearance, where the same alpha reads weaker).
    private var wash: Double {
        guard isEnabled else { return 0 }
        if configuration.isPressed { return 0.16 }
        return hovering ? (colorScheme == .dark ? 0.12 : 0.08) : 0
    }
}

extension ButtonStyle where Self == IconButtonStyle {
    /// `IconButtonStyle` with its default padding (a 24 pt target).
    static var icon: IconButtonStyle { IconButtonStyle() }
}

extension Color {
    /// A translucent surface wash. The same alpha reads much weaker over a dark ground, so every
    /// tinted surface names both values instead of hardcoding the light-mode one; `light` is what the
    /// surface always had, `dark` the alpha that matches its weight in dark appearance.
    func wash(_ scheme: ColorScheme, light: Double, dark: Double) -> Color {
        opacity(scheme == .dark ? dark : light)
    }

    /// A card raised off the pane behind it (chat bubbles, the chat empty state). `windowBackgroundColor`,
    /// `controlBackgroundColor` and `textBackgroundColor` all resolve to the *same* value in both
    /// appearances (#FFFFFF / #1E1E1E), so a card painted with one of them on a pane painted with another
    /// has no visible surface at all; a neutral wash steps away from the pane either way.
    static func cardFill(_ scheme: ColorScheme) -> Color {
        Color.secondary.opacity(scheme == .dark ? 0.10 : 0.08)
    }

    /// A panel inset into a card (fenced code blocks, markdown tables). Recessed — darker than the card
    /// in both appearances — which also keeps `.secondary` text on it legible.
    static func panelFill(_ scheme: ColorScheme) -> Color {
        Color.black.opacity(scheme == .dark ? 0.22 : 0.05)
    }

    /// The chrome strip along the top of a panel (a code block's language label + Copy).
    static func panelHeaderFill(_ scheme: ColorScheme) -> Color {
        Color.black.opacity(0.10)
    }
}
