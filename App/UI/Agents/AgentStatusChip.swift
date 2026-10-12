import SwiftUI
import ReviewGateCore

/// The `AppStorage` key of the agent activity panel's visibility.
enum AgentPanel {
    static let storageKey = "showAgentPanel"
}

extension AgentStatus {
    /// running = blue, completed = green, failed = red, paused = orange, pending / stopped = gray.
    var tint: Color {
        switch self {
        case .pending: .gray
        case .running: .blue
        case .paused: .orange
        case .completed: .green
        case .failed: .red
        case .stopped: .gray
        }
    }

    var label: LocalizedStringKey {
        switch self {
        case .pending: "Pending"
        case .running: "Running"
        case .paused: "Paused"
        case .completed: "Completed"
        case .failed: "Failed"
        case .stopped: "Stopped"
        }
    }

    var symbol: String {
        switch self {
        case .pending: "clock"
        case .running: "circle.fill"
        case .paused: "pause.circle.fill"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .stopped: "stop.circle.fill"
        }
    }
}

/// A dot that breathes while `active` (live agents).
struct PulseDot: View {
    let color: Color
    var active: Bool = true
    var size: CGFloat = 7
    @State private var on = false

    var body: some View {
        ZStack {
            if active {
                Circle()
                    .fill(color.opacity(0.35))
                    .frame(width: size, height: size)
                    .scaleEffect(on ? 2.2 : 1)
                    .opacity(on ? 0 : 1)
            }
            Circle().fill(color).frame(width: size, height: size)
        }
        .frame(width: size * 2.2, height: size * 2.2)
        .onAppear {
            guard active else { return }
            withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { on = true }
        }
        .onChange(of: active) { _, live in
            on = false
            if live { withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { on = true } }
        }
        .accessibilityHidden(true)
    }
}

/// Status capsule: pulsing dot + label, tinted by status.
struct AgentStatusChip: View {
    @Environment(\.colorScheme) private var colorScheme
    let status: AgentStatus
    var compact = false
    /// wave3 mac-agents (§36.2): a `stopped` agent the user stopped reads "사용자가 중지".
    var stoppedByUser = false

    private var label: LocalizedStringKey { status == .stopped && stoppedByUser ? "Stopped by you" : status.label }

    var body: some View {
        HStack(spacing: 3) {
            if status == .running {
                PulseDot(color: status.tint, size: 6)
                    .frame(width: 10, height: 10)
            } else {
                Image(systemName: status == .stopped && stoppedByUser ? "hand.raised.fill" : status.symbol)
                    .font(.system(size: 9, weight: .bold))
            }
            if !compact { Text(label) }
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(status.tint)
        .padding(.horizontal, compact ? 4 : 6).padding(.vertical, 1)
        .background(status.tint.wash(colorScheme, light: 0.14, dark: 0.22), in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(label))
    }
}

/// A small capsule label (risk badges, subagent markers, test outcomes).
struct TagChip: View {
    @Environment(\.colorScheme) private var colorScheme
    let text: Text
    var systemImage: String?
    var tint: Color = .secondary

    init(_ text: Text, systemImage: String? = nil, tint: Color = .secondary) {
        self.text = text
        self.systemImage = systemImage
        self.tint = tint
    }

    init(_ key: LocalizedStringKey, systemImage: String? = nil, tint: Color = .secondary) {
        self.init(Text(key), systemImage: systemImage, tint: tint)
    }

    var body: some View {
        HStack(spacing: 3) {
            if let systemImage { Image(systemName: systemImage).font(.system(size: 8, weight: .bold)) }
            text.lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, 5).padding(.vertical, 1)
        .background(tint.wash(colorScheme, light: 0.13, dark: 0.22), in: Capsule())
        .fixedSize()
    }
}

enum AgentFormat {
    /// 12.3s, 4m 05s, 1h 02m — "4분 5초" in Korean (wave4 w4-input, polish-14: `ElapsedFormat`).
    static func duration(ms: Double) -> String {
        ElapsedFormat.text(seconds: ms / 1000)
    }

    static func nowMs(_ date: Date = Date()) -> Double { date.timeIntervalSince1970 * 1000 }
}
