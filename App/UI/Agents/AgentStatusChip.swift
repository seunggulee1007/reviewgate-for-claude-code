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
/// The ring's breath is a Core Animation animation (`PulseRingView`), run by the window server: a SwiftUI `repeatForever`
/// animation made the window's whole view graph update and render every frame (the transcript's scroll view included) for as
/// long as one dot showed — 40–50 % of the main thread while an agent ran or Claude worked, in front or not (§45.1).
struct PulseDot: View {
    let color: Color
    var active: Bool = true
    var size: CGFloat = 7

    var body: some View {
        ZStack {
            if active {
                PulseRing(color: color, size: size)
            }
            Circle().fill(color).frame(width: size, height: size)
        }
        .frame(width: size * 2.2, height: size * 2.2)
        .accessibilityHidden(true)
    }
}

/// The breathing ring of `PulseDot`: a `size` circle at 35 % of `color` that grows to 2.2× and fades out every 1.2 s.
private struct PulseRing: NSViewRepresentable {
    let color: Color
    let size: CGFloat

    func makeNSView(context: Context) -> PulseRingView { PulseRingView() }

    func updateNSView(_ view: PulseRingView, context: Context) {
        view.color = NSColor(color)
        view.size = size
    }
}

final class PulseRingView: NSView {
    private let ring = CALayer()
    var color: NSColor = .systemBlue { didSet { if color != oldValue { applyColor() } } }
    var size: CGFloat = 7 { didSet { if size != oldValue { needsLayout = true } } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(ring)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        ring.cornerRadius = size / 2
        ring.position = CGPoint(x: bounds.midX, y: bounds.midY)
        CATransaction.commit()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyColor()
        breathe()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColor()
    }

    private func applyColor() {
        var cg: CGColor?
        effectiveAppearance.performAsCurrentDrawingAppearance { cg = color.withAlphaComponent(0.35).cgColor }
        ring.backgroundColor = cg
    }

    /// Added again whenever the view comes into a window (AppKit may drop a layer's animations when it leaves one).
    private func breathe() {
        guard window != nil, ring.animation(forKey: "breathe") == nil else { return }
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 1
        grow.toValue = 2.2
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = 1.2
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        group.repeatCount = .infinity
        group.isRemovedOnCompletion = false
        ring.add(group, forKey: "breathe")
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
