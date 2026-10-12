import Foundation

// MARK: wave4d w4d-agents2
// docs/PROTOCOL.md §42.4 — the Mac agent panel at its default width (audit agents-10): who is who at a glance (a color per
// agent type, the plugin as a small badge), what failed (a red card stronger than a running one), and parallel agents as
// compact rows instead of a column of full cards. Mac only for now (agents-10 is a Mac finding); a Windows panel that
// colors its agents takes `colorIndex` as it is.

public enum AgentIdentity {
    /// How many identity colors there are (the clients' palettes have this many entries, none of them a status color).
    public static let paletteSize = 8

    /// The identity color of an agent type: FNV-1a (32-bit) over the UTF-8 of its label without the plugin prefix, its bits
    /// from 13 up, modulo the palette (the low bits put executor, architect and Explore on one color) — `executor` is the
    /// same color in every turn, chat and client.
    public static func colorIndex(_ type: String) -> Int {
        var hash: UInt32 = 2_166_136_261
        for byte in AgentGlance.typeLabel(type).utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        return Int((hash >> 13) % UInt32(paletteSize))
    }

    /// The plugin an agent type comes from, as a small badge: `oh-my-claudecode:executor` → "OMC", `acme-tools:smoke`
    /// → "acme-tools"; nil without a prefix. Long names are cut to 12 characters.
    public static func pluginBadge(_ type: String) -> String? {
        guard let i = type.lastIndex(of: ":") else { return nil }
        let prefix = String(type[..<i]).trimmingCharacters(in: .whitespaces)
        guard !prefix.isEmpty else { return nil }
        if prefix == "oh-my-claudecode" || prefix == "omc" { return "OMC" }
        return prefix.count > 12 ? String(prefix.prefix(11)) + "…" : prefix
    }
}

/// How strongly a card's border speaks: a failure louder than a running agent, a stop quieter than a finished one.
public enum AgentCardEmphasis: Sendable, Equatable {
    case waiting, live, failed, done, stopped

    public static func of(_ agent: AgentNode, awaitingPermission: Bool) -> AgentCardEmphasis {
        if awaitingPermission, agent.status.isLive { return .waiting }
        switch agent.status {
        case .pending, .running, .paused: return .live
        case .failed: return .failed
        case .completed: return .done
        case .stopped: return .stopped
        }
    }

    /// Border opacity and width (points).
    public var border: (opacity: Double, width: Double) {
        switch self {
        case .failed: (0.85, 1.6)
        case .waiting: (0.75, 1.4)
        case .live: (0.55, 1.2)
        case .done: (0.22, 1)
        case .stopped: (0.18, 1)
        }
    }
}

public enum AgentPanelLayout {
    /// Agents side by side from this many on are shown as compact rows (one line each, a click opens the card).
    public static let compactFrom = 3

    /// Whether a batch of agents that ran at the same time is shown as compact rows.
    public static func compact(batch: Int) -> Bool { batch >= compactFrom }

    /// A compact row's second line: what a live agent does now (its step, else its tool), what a finished one left (its
    /// error, else its report's or summary's first line); nil when there is nothing (the row's first line has the
    /// description).
    public static func rowDetail(_ agent: AgentNode, nowMs: Double) -> String? {
        if agent.status.isLive {
            if let step = agent.lastStep { return AgentGlance.stepLine(step, nowMs: nowMs) }
            return agent.lastTool.map { AgentGlance.toolTitle($0, detail: nil) }
        }
        for text in [agent.error, agent.reportPreview, agent.summary] {
            if let line = firstLine(text) { return line }
        }
        return nil
    }

    private static func firstLine(_ text: String?) -> String? {
        guard let text else { return nil }
        let line = text.split(whereSeparator: \.isNewline).lazy
            .map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#*>- ")) }
            .first { !$0.isEmpty }
        return line.map { String($0.prefix(200)) }
    }
}
