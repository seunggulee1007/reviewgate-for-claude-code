import SwiftUI

// MARK: polish p-foundation — PX-12: one text size for the whole app (View › 확대 ⌘+ / 축소 ⌘− / 실제 크기 ⌘0), kept
// across launches. The diff's code font, the chat's prose and the message box multiply their point size by it.
//
//   @AppStorage(TextScale.key) private var textScale = TextScale.standard
//   .font(.system(size: 13 * textScale))
//   Button("Zoom In") { textScale = TextScale.larger(textScale) }.disabled(!TextScale.canEnlarge(textScale))

enum TextScale {
    /// `UserDefaults` key (Double).
    static let key = "textScale"
    static let standard = 1.0
    static let range: ClosedRange<Double> = 0.8...1.6
    static let step = 0.1

    /// The stored scale, within `range` (the standard one when none was stored).
    static var current: Double {
        clamped(UserDefaults.standard.object(forKey: key) as? Double ?? standard)
    }

    static func clamped(_ value: Double) -> Double {
        // Rounded to the step, so ten steps up and down land on 1.0 again.
        let rounded = (value / step).rounded() * step
        return min(range.upperBound, max(range.lowerBound, (rounded * 100).rounded() / 100))
    }

    static func larger(_ value: Double) -> Double { clamped(value + step) }
    static func smaller(_ value: Double) -> Double { clamped(value - step) }
    static func canEnlarge(_ value: Double) -> Bool { clamped(value) < range.upperBound }
    static func canShrink(_ value: Double) -> Bool { clamped(value) > range.lowerBound }
}
