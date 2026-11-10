import Foundation

// MARK: wave1 mac-session
// docs/PROTOCOL.md §29 (peer messages) and §30 (session start and recovery) on the wire; TypeScript source of truth:
// engine/src/protocol.ts. Everything here decodes leniently: an unknown value reads as `.other` / nil and one malformed
// peer message never fails the snapshot it rides on.

/// §29 `settings.peerInbound`, `peer_set.mode` and `state.session.peerInbound`: what happens to a message another Claude
/// session of the user sends to this one (SendMessage).
public enum PeerInboundMode: String, Codable, Sendable, CaseIterable, Identifiable {
    /// The CLI holds the message and the user decides (a card).
    case ask
    /// Held, then run by the engine itself once Claude can take a message (a waiting review too) — for a sender the user's
    /// registry lists (`PeerMessage.sender`). The engine default since r2-peers.
    case auto
    /// Refused (the sender gets a "not delivered" receipt).
    case off

    public var id: String { rawValue }

    /// nil for anything a newer engine might send.
    public init?(wire: String?) {
        guard let wire, let mode = PeerInboundMode(rawValue: wire) else { return nil }
        self = mode
    }

    /// The setting's name in the global picker and the project menu.
    public var displayName: String {
        switch self {
        // wave3 check-clients: Electron's key ("물어보기(기본)") — a plain "Ask" is the side question's button ("묻기"), and
        // the two met in one key when Electron's catalog is generated from both of the Mac's.
        // MARK: r2-peers — auto is the default now: the labels say which one is.
        case .ask: String(localized: "Ask first", bundle: .module)
        case .auto: String(localized: "Handle on arrival (default)", bundle: .module)
        case .off: String(localized: "Don't accept", bundle: .module)
        }
    }
}

/// §29 `PeerMessage.state`: held → (peer_accept) delivering → delivered, or dropped. A value a newer engine adds is kept
/// as `.other` instead of failing the inbox.
public enum PeerMessageState: Sendable, Hashable {
    case held, delivering, delivered, dropped
    case other(String)

    public init(wire: String) {
        switch wire {
        case "held": self = .held
        case "delivering": self = .delivering
        case "delivered": self = .delivered
        case "dropped": self = .dropped
        default: self = .other(wire)
        }
    }

    public var wire: String {
        switch self {
        case .held: "held"
        case .delivering: "delivering"
        case .delivered: "delivered"
        case .dropped: "dropped"
        case let .other(value): value
        }
    }
}

/// §29: one message another Claude session sent to this one. `from` / `fromName` are what the SENDER claims;
/// `verifiedPeerPid` (kernel-verified) is known once the message was delivered, and so is `body`. Also the shape of the
/// `peer_message` transcript row (which has no `cause` / `receivedAt`).
public struct PeerMessage: Sendable, Hashable, Identifiable {
    /// The CLI's message uuid (`peer_accept.ids` / `peer_dismiss.ids`).
    public var id: String
    /// Reply address the sender gave (`uds:/tmp/cc-socks/<pid>.sock`).
    public var from: String
    public var fromName: String?
    public var verifiedPeerPid: Int?
    /// Why the CLI held it: `explicit-setting` (ReviewGate's hold), `mode-mismatch`, …
    public var cause: String?
    /// ISO-8601; "" when unknown (a transcript row).
    public var receivedAt: String
    public var state: PeerMessageState
    /// dropped: `refused`, `expired`, `discarded`, or the CLI's own word.
    public var outcome: String?
    public var body: String?
    /// The transcript turn it runs in, once accepted.
    public var turn: Int?
    /// Delivered without being held (an older CLI / a policy that accepts): it ran outside the review, its changes blocked.
    public var unprompted: Bool
    /// MARK: r2-peers — the live session of the user's registry the `from` address names (the engine's lookup); nil while
    /// unknown or when none lists it. In mode `auto` only messages with it run by themselves.
    public var sender: PeerSessionInfo?

    public init(id: String, from: String, fromName: String? = nil, verifiedPeerPid: Int? = nil, cause: String? = nil,
                receivedAt: String = "", state: PeerMessageState, outcome: String? = nil, body: String? = nil, turn: Int? = nil,
                unprompted: Bool = false, sender: PeerSessionInfo? = nil) {
        self.id = id
        self.from = from
        self.fromName = fromName
        self.verifiedPeerPid = verifiedPeerPid
        self.cause = cause
        self.receivedAt = receivedAt
        self.state = state
        self.outcome = outcome
        self.body = body
        self.turn = turn
        self.unprompted = unprompted
        self.sender = sender
    }

    /// The name to show: the sender's own (`fromName`), else its pid from the reply address, else the address.
    public var senderName: String {
        if let name = fromName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        if let pid = Self.pid(inAddress: from) { return "pid \(pid)" }
        return from
    }

    /// `uds:/tmp/cc-socks/1234.sock` → 1234.
    static func pid(inAddress address: String) -> Int? {
        guard let slash = address.lastIndex(of: "/") else { return nil }
        let file = address[address.index(after: slash)...]
        guard file.hasSuffix(".sock") else { return nil }
        return Int(file.dropLast(".sock".count))
    }
}

extension PeerMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, from, fromName, verifiedPeerPid, cause, receivedAt, state, outcome, body, turn, unprompted, sender
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func string(_ key: CodingKeys) -> String? { try? c.decodeIfPresent(String.self, forKey: key) }
        self.init(
            id: string(.id) ?? "",
            from: string(.from) ?? "",
            fromName: string(.fromName),
            verifiedPeerPid: try? c.decodeIfPresent(Int.self, forKey: .verifiedPeerPid),
            cause: string(.cause),
            receivedAt: string(.receivedAt) ?? "",
            state: PeerMessageState(wire: string(.state) ?? ""),
            outcome: string(.outcome),
            body: string(.body),
            turn: try? c.decodeIfPresent(Int.self, forKey: .turn),
            unprompted: (try? c.decodeIfPresent(Bool.self, forKey: .unprompted)) ?? false,
            sender: try? c.decodeIfPresent(PeerSessionInfo.self, forKey: .sender))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(from, forKey: .from)
        try c.encode(fromName, forKey: .fromName)
        try c.encode(verifiedPeerPid, forKey: .verifiedPeerPid)
        try c.encode(cause, forKey: .cause)
        try c.encode(receivedAt, forKey: .receivedAt)
        try c.encode(state.wire, forKey: .state)
        try c.encodeIfPresent(outcome, forKey: .outcome)
        try c.encodeIfPresent(body, forKey: .body)
        try c.encodeIfPresent(turn, forKey: .turn)
        if unprompted { try c.encode(true, forKey: .unprompted) }
        try c.encodeIfPresent(sender, forKey: .sender)
    }
}

/// §29 `state.session.externalTurn`: a turn the CLI runs that is not ours (a peer message it delivered by itself, …).
/// `canSend` is false meanwhile (`blockedReason: "running"`) and a `send` is refused `gate_closed:external_turn`.
public struct ExternalTurn: Sendable, Hashable, Codable {
    public struct Peer: Sendable, Hashable, Codable {
        public var from: String
        public var fromName: String?
        public var verifiedPeerPid: Int?

        public init(from: String, fromName: String? = nil, verifiedPeerPid: Int? = nil) {
            self.from = from
            self.fromName = fromName
            self.verifiedPeerPid = verifiedPeerPid
        }

        private enum CodingKeys: String, CodingKey { case from, fromName, verifiedPeerPid }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(from: (try? c.decodeIfPresent(String.self, forKey: .from)) ?? "",
                      fromName: try? c.decodeIfPresent(String.self, forKey: .fromName),
                      verifiedPeerPid: try? c.decodeIfPresent(Int.self, forKey: .verifiedPeerPid))
        }
    }

    public var commandUuid: String?
    /// ISO-8601.
    public var since: String
    /// Filled once the turn's echo shows a peer origin.
    public var peer: Peer?

    public init(commandUuid: String? = nil, since: String = "", peer: Peer? = nil) {
        self.commandUuid = commandUuid
        self.since = since
        self.peer = peer
    }

    private enum CodingKeys: String, CodingKey { case commandUuid, since, peer }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(commandUuid: try? c.decodeIfPresent(String.self, forKey: .commandUuid),
                  since: (try? c.decodeIfPresent(String.self, forKey: .since)) ?? "",
                  peer: try? c.decodeIfPresent(Peer.self, forKey: .peer))
    }
}

extension EngineErrorDetail {
    /// §30 / §33.4 fields together (`detail` is required here so `EngineErrorDetail(code:)` stays the §19.6 initializer).
    public init(code: String?, detail: String?, exitCode: Int? = nil, signal: String? = nil, sessionId: String? = nil,
                toolName: String? = nil, path: String? = nil, branch: String? = nil) {
        self.init(code: code)
        self.detail = detail
        self.exitCode = exitCode
        self.signal = signal
        self.sessionId = sessionId
        self.toolName = toolName
        self.path = path
        self.branch = branch
    }
}
