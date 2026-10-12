import SwiftUI
import AppKit
import ReviewGateCore

// MARK: wave5 w5-board
// docs/PROTOCOL.md §43.1 — an agent's round face on the agent board: a pastel ring and the type's icon (Core `AgentAvatar`;
// Electron draws the same faces as SVG), a little mood badge (working "…", a raised hand waiting for a permission, a turning
// arrow while retrying, a check and a sparkle when done, a red X and dizzy stars when it failed, "z" while it rests) and a
// small bounce while it works. Reduce Motion keeps the still picture.

extension AgentAvatarTone {
    /// The ring / icon color in this appearance.
    func color(_ scheme: ColorScheme) -> Color {
        Self.color(scheme == .dark ? hex.dark : hex.light)
    }

    /// The same color, following the appearance by itself (for views without the scheme at hand).
    var dynamic: Color {
        let (light, dark) = hex
        return Color(nsColor: NSColor(name: nil) { appearance in
            let v = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
        })
    }

    static func color(_ v: UInt32) -> Color {
        Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

extension AgentMood {
    /// Read out with the agent's name.
    var spoken: Text {
        switch self {
        case .working: Text("working now")
        case .waiting: Text("waiting for permission")
        case .retrying: Text("retrying")
        case .done: Text("finished")
        case .failed: Text("failed")
        case .stopped: Text("stopped")
        case .idle: Text("resting")
        }
    }
}

/// The face: ring, icon, mood badge.
struct AgentAvatarView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let avatar: AgentAvatar
    let mood: AgentMood
    var size: CGFloat = 46
    /// false: the face alone, still (no mood badge, sparkle, dizzy stars or bounce) — the sub-brain's "who wrote it".
    var showsMood = true

    var body: some View {
        let tone = avatar.tone.color(colorScheme)
        let moving = showsMood && mood.moves && !reduceMotion
        ZStack {
            Circle().fill(tone.opacity(colorScheme == .dark ? 0.22 : 0.16))
            Circle().strokeBorder(tone, lineWidth: max(showsMood ? 2 : 1.5, size * 0.06))
            face(tone)
                .rotationEffect(.degrees(showsMood && mood == .failed ? -14 : 0))
                .opacity(showsMood && mood == .stopped ? 0.55 : 1)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .top) { if showsMood && mood == .failed { DizzyStars(size: size) } }
        .overlay(alignment: .topLeading) { if showsMood && mood == .done { DoneSparkle(size: size, animate: !reduceMotion) } }
        .overlay(alignment: .bottomTrailing) {
            if showsMood { MoodBadge(mood: mood, size: size * 0.44, animate: !reduceMotion).offset(x: size * 0.08, y: size * 0.06) }
        }
        .modifier(Bounce(active: moving && mood == .working, height: size * 0.06))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: avatar.name.isEmpty ? String(localized: "Main agent") : avatar.name) + Text(verbatim: ", ") + mood.spoken)
    }

    @ViewBuilder
    private func face(_ tone: Color) -> some View {
        switch avatar.icon {
        case .claude: ClaudeSpark().stroke(tone, style: StrokeStyle(lineWidth: size * 0.085, lineCap: .round)).frame(width: size * 0.58, height: size * 0.58)
        case .robot: RobotFace(tone: tone, size: size * 0.6, dizzy: mood == .failed)
        default:
            Image(systemName: avatar.icon.symbol ?? "sparkles")
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(tone)
        }
    }
}

/// A small bounce while the agent works ("살짝 통통").
private struct Bounce: ViewModifier {
    let active: Bool
    let height: CGFloat

    func body(content: Content) -> some View {
        if active {
            content.phaseAnimator([false, true]) { view, up in
                view.offset(y: up ? -height : 0)
            } animation: { up in
                up ? .easeOut(duration: 0.32) : .easeIn(duration: 0.38).delay(0.5)
            }
        } else {
            content
        }
    }
}

/// The mood in a little bubble at the face's lower right.
struct MoodBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let mood: AgentMood
    let size: CGFloat
    var animate = true

    var body: some View {
        let (symbol, tint) = look
        Image(systemName: symbol)
            .font(.system(size: size * 0.52, weight: .bold))
            .foregroundStyle(mood == .working ? Color.secondary : tint)
            .modifier(MoodEffect(mood: mood, animate: animate))
            .frame(width: size, height: size)
            .background(Circle().fill(Color(nsColor: .windowBackgroundColor)))
            .overlay(Circle().strokeBorder(tint.opacity(colorScheme == .dark ? 0.75 : 0.6), lineWidth: 1.2))
            .accessibilityHidden(true)
    }

    private var look: (String, Color) {
        switch mood {
        case .working: ("ellipsis", .blue)
        case .waiting: ("hand.raised.fill", .orange)
        case .retrying: ("arrow.triangle.2.circlepath", .blue)
        case .done: ("checkmark", .green)
        case .failed: ("xmark", .red)
        case .stopped: ("stop.fill", .gray)
        case .idle: ("zzz", .gray)
        }
    }
}

/// The badge's own little movement: the dots run, the hand waves, the arrow turns, the z breathes.
private struct MoodEffect: ViewModifier {
    let mood: AgentMood
    let animate: Bool

    func body(content: Content) -> some View {
        switch mood {
        case .working: content.symbolEffect(.variableColor.iterative, options: .repeating, isActive: animate)
        case .waiting: content.symbolEffect(.wiggle, options: .repeating, isActive: animate)
        case .retrying: content.symbolEffect(.rotate, options: .repeating, isActive: animate)
        case .idle: content.symbolEffect(.breathe, options: .repeating, isActive: animate)
        default: content
        }
    }
}

/// "반짝": a sparkle over a finished agent.
private struct DoneSparkle: View {
    let size: CGFloat
    let animate: Bool

    var body: some View {
        Image(systemName: "sparkle")
            .font(.system(size: size * 0.26, weight: .bold))
            .foregroundStyle(.yellow)
            .shadow(color: .orange.opacity(0.4), radius: 1)
            .symbolEffect(.bounce, options: .nonRepeating, isActive: animate)
            .offset(x: -size * 0.04, y: -size * 0.04)
            .accessibilityHidden(true)
    }
}

/// Three little stars over a failed agent ("어지러운 표정").
private struct DizzyStars: View {
    let size: CGFloat

    var body: some View {
        HStack(spacing: size * 0.06) {
            ForEach(0..<3, id: \.self) { i in
                Image(systemName: "star.fill")
                    .font(.system(size: size * (i == 1 ? 0.17 : 0.13), weight: .bold))
                    .foregroundStyle(.orange)
                    .offset(y: i == 1 ? -size * 0.05 : 0)
            }
        }
        .offset(y: -size * 0.16)
        .accessibilityHidden(true)
    }
}

/// Claude's star: rays of two lengths around the middle.
struct ClaudeSpark: Shape {
    var rays = 10

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2
        for i in 0..<rays {
            let a = Double(i) / Double(rays) * 2 * .pi - .pi / 2
            let outer = r * (i.isMultiple(of: 2) ? 1 : 0.74)
            let inner = r * 0.2
            p.move(to: CGPoint(x: c.x + cos(a) * inner, y: c.y + sin(a) * inner))
            p.addLine(to: CGPoint(x: c.x + cos(a) * outer, y: c.y + sin(a) * outer))
        }
        return p
    }
}

/// The sparkle robot of `general-purpose` and the types the table does not know (SF Symbols has no robot).
struct RobotFace: View {
    let tone: Color
    let size: CGFloat
    var dizzy = false

    var body: some View {
        let w = size, h = size * 0.74
        ZStack {
            // antenna
            Capsule().fill(tone).frame(width: w * 0.07, height: h * 0.26).offset(y: -h * 0.58)
            Circle().fill(tone).frame(width: w * 0.16, height: w * 0.16).offset(y: -h * 0.72)
            // head
            RoundedRectangle(cornerRadius: w * 0.2).fill(tone).frame(width: w * 0.86, height: h * 0.78)
            // eyes
            HStack(spacing: w * 0.2) {
                eye
                eye
            }
            .offset(y: -h * 0.06)
            // smile
            Capsule().fill(Color.white.opacity(0.92)).frame(width: w * 0.3, height: h * 0.08).offset(y: h * 0.2)
            // sparkle
            Image(systemName: "sparkle")
                .font(.system(size: w * 0.32, weight: .bold))
                .foregroundStyle(tone)
                .offset(x: w * 0.56, y: -h * 0.56)
        }
        .frame(width: w, height: h)
        .offset(y: h * 0.08)
    }

    @ViewBuilder
    private var eye: some View {
        if dizzy {
            Image(systemName: "xmark").font(.system(size: size * 0.16, weight: .heavy)).foregroundStyle(.white)
        } else {
            Circle().fill(Color.white).frame(width: size * 0.15, height: size * 0.15)
        }
    }
}

/// The small icon of the tool an agent runs.
struct AgentToolGlyph: View {
    let tool: String?
    var tint: Color = .secondary

    var body: some View {
        Image(systemName: tool.map { AgentToolIcon.of(tool: $0).symbol } ?? "circle.dotted")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .frame(width: 14)
            .accessibilityHidden(true)
    }
}
