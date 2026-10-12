import Foundation

// MARK: wave4 w4-longwork
// docs/PROTOCOL.md §38.2 on the wire: `state.hud.rateLimits` and the `max_turns` / `hook_failed` details of an `error`
// event (and of its transcript row). Every field is lenient — an older engine sends none of them.

/// One usage window of the subscription (`state.hud.rateLimits[]`).
public struct RateLimitWindow: Sendable, Equatable, Decodable {
    /// The CLI's `rateLimitType`: `five_hour`, `seven_day`, `seven_day_opus`, … (kept as sent).
    public var kind: String
    /// `allowed`, `allowed_warning` or `rejected` (an unknown value is kept and reads as allowed).
    public var status: String
    /// Utilization 0–100 when the CLI reports it.
    public var percent: Int?
    /// ISO-8601.
    public var resetsAt: String?

    public init(kind: String, status: String, percent: Int? = nil, resetsAt: String? = nil) {
        self.kind = kind
        self.status = status
        self.percent = percent
        self.resetsAt = resetsAt
    }

    private enum CodingKeys: String, CodingKey { case kind, status, percent, resetsAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        status = lenientValue(String.self, c, .status) ?? "allowed"
        percent = lenientValue(Int.self, c, .percent) ?? lenientValue(Double.self, c, .percent).map { Int($0.rounded()) }
        resetsAt = lenientValue(String.self, c, .resetsAt)
    }

    public var isRejected: Bool { status == "rejected" }

    public var resetDate: Date? { resetsAt.flatMap(LongWorkWire.date) }
}

enum LongWorkWire {
    private enum HudKeys: String, CodingKey { case rateLimits }
    private enum ErrorKeys: String, CodingKey { case maxTurns, hookName }

    /// `hud.rateLimits`, element by element (a window without `kind` is dropped); [] when absent.
    static func rateLimits(from decoder: Decoder) -> [RateLimitWindow] {
        guard let c = try? decoder.container(keyedBy: HudKeys.self) else { return [] }
        return lenientElements(RateLimitWindow.self, c, .rateLimits)
    }

    /// The §38.2 details of an `error` event / row (`maxTurns`, `hookName`).
    static func applyErrorFacts(from decoder: Decoder, to detail: inout EngineErrorDetail) {
        guard let c = try? decoder.container(keyedBy: ErrorKeys.self) else { return }
        detail.maxTurns = lenientValue(Int.self, c, .maxTurns)
        detail.hookName = lenientValue(String.self, c, .hookName)
    }

    static func date(_ text: String) -> Date? {
        if let d = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(text, strategy: Date.ISO8601FormatStyle())
    }
}
