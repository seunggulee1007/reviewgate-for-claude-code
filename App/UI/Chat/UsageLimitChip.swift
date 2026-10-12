import SwiftUI
import ReviewGateCore

// MARK: wave4 w4-longwork
/// HUD (docs/PROTOCOL.md §38.2): "사용량 한도 — 15:00에 풀려요" while a usage limit is in force — a click turns
/// "풀리면 이어서 하기" on / off — else the five-hour / weekly use when the CLI reports it ("5시간 72% · 주간 41%",
/// orange from 80 %). Nothing on an engine that reports neither.
struct UsageLimitChip: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isUsageLimited {
            let reset = store.activeLimitReset
            let label = LongWorkText.limitChip(resetTime: reset.map(LongWorkText.resetTime), armed: store.longWork.resumeArmed)
            Button {
                store.toggleLimitResume()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: store.longWork.resumeArmed ? "clock.arrow.circlepath" : "hourglass")
                    Text(verbatim: label).lineLimit(1)
                }
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.22), in: Capsule())
                .foregroundStyle(Color.orange)
            }
            .buttonStyle(.plain)
            .disabled(!store.canArmLimitResume && !store.longWork.resumeArmed)
            .fixedSize()
            .help(store.longWork.resumeArmed ? LongWorkText.resumeCancelTitle : LongWorkText.resumeTitle + " — " + LongWorkText.resumeHelp)
            .accessibilityLabel(Text(verbatim: label))
            .accessibilityHint(Text(verbatim: store.longWork.resumeArmed ? LongWorkText.resumeCancelTitle : LongWorkText.resumeTitle))
            .accessibilityIdentifier("HUD usage limit")
        } else if let meter = meterText {
            Text(verbatim: meter.text)
                .foregroundStyle(meter.high ? Color.orange : Color.secondary)
                .fixedSize()
                .help("Claude subscription use: the five-hour and weekly limits")
                .accessibilityIdentifier("HUD usage meter")
        }
    }

    private var meterText: (text: String, high: Bool)? {
        let windows = store.state.hud.rateLimits
        let five = UsageMeter.fiveHour(windows)
        let week = UsageMeter.weekly(windows)
        let parts = [five.map(LongWorkText.fiveHour), week.map(LongWorkText.weekly)].compactMap { $0 }
        guard !parts.isEmpty else { return nil }
        return (parts.joined(separator: " · "), UsageMeter.isHigh(five) || UsageMeter.isHigh(week))
    }
}
