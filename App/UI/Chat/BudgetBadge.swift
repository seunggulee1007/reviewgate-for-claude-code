import SwiftUI
import ReviewGateCore

struct BudgetBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let usage: BudgetUsage
    let budget: Budget

    /// White on `systemRed` only reaches ~3.4:1 in either appearance; this fixed deep red clears 4.5:1
    /// on both grounds, and an alert fill wants the same weight light or dark anyway.
    private static let deniedFill = Color(red: 0.68, green: 0.13, blue: 0.11)

    private var overFiles: Bool { usage.files > budget.maxFiles }
    private var overLines: Bool { usage.lines > budget.maxLines }
    private var tint: Color {
        if usage.denied { return .red }
        if overFiles || overLines { return .orange }
        return .secondary
    }

    var body: some View {
        HStack(spacing: 6) {
            Label("\(usage.files)/\(budget.maxFiles)", systemImage: "doc")
            Label("\(usage.lines)/\(budget.maxLines)", systemImage: "text.line.first.and.arrowtriangle.forward")
            if usage.denied {
                Text("DENIED").fontWeight(.bold)
            }
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(usage.denied ? Color.white : tint)
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(usage.denied ? Self.deniedFill : tint.wash(colorScheme, light: 0.12, dark: 0.16), in: Capsule())
        .help("Per-turn change budget: files / lines")
    }
}
