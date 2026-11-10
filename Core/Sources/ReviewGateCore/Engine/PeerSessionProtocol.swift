import Foundation

// MARK: wave4d w4d-peers
// docs/PROTOCOL.md §42.2 (audit peer-05, peer-07): whom a SendMessage reaches (`permission_request.toSession`) and how the
// user's other Claude sessions see this window (`cli_sessions.self`). Both optional: an older engine sends neither and
// the card shows `input.to` as before.

/// The Claude session a cross-session address (`uds:<socket>`) names, as the user's session registry lists it.
public struct PeerSessionInfo: Codable, Sendable, Hashable {
    /// The address as the call named it.
    public var address: String
    public var pid: Int
    /// The registry's name (`acme-b4`, `ReviewGate · acme`).
    public var name: String?
    public var cwd: String?
    public var status: CliSessionStatus
    /// `cli` (a terminal), `sdk-ts` (an app such as ReviewGate), …
    public var entrypoint: String?
    /// MARK: r2-peers — §33.2: the conversation the registry says that process runs; a SendMessage card to it can be
    /// remembered for the session ("이 세션으로 보내는 메시지는 세션 동안 허용") only with it.
    public var sessionId: String?

    public init(address: String, pid: Int, name: String? = nil, cwd: String? = nil, status: CliSessionStatus = .unknown, entrypoint: String? = nil,
                sessionId: String? = nil) {
        self.address = address
        self.pid = pid
        self.name = name
        self.cwd = cwd
        self.status = status
        self.entrypoint = entrypoint
        self.sessionId = sessionId
    }

    /// A terminal (`cli`) rather than an app or a script.
    public var isTerminal: Bool { entrypoint == nil || entrypoint == "cli" }

    private enum CodingKeys: String, CodingKey { case address, pid, name, cwd, status, entrypoint, sessionId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String? {
            guard let v = (try? c.decodeIfPresent(String.self, forKey: key))?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
            return v
        }
        self.init(address: text(.address) ?? "",
                  pid: try c.decode(Int.self, forKey: .pid),
                  name: text(.name),
                  cwd: text(.cwd),
                  status: text(.status).flatMap(CliSessionStatus.init(rawValue:)) ?? .unknown,
                  entrypoint: text(.entrypoint),
                  sessionId: text(.sessionId))
    }
}

/// This window's main session as the user's other sessions see it.
public struct PeerSelf: Codable, Sendable, Equatable {
    public var pid: Int
    /// The `--name` the registry lists (`ReviewGate · <project>…`).
    public var name: String?
    /// `uds:<socket>` other sessions send to; nil when the registry lists no socket.
    public var address: String?

    public init(pid: Int, name: String? = nil, address: String? = nil) {
        self.pid = pid
        self.name = name
        self.address = address
    }

    private enum CodingKeys: String, CodingKey { case pid, name, address }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = (try? c.decodeIfPresent(String.self, forKey: .name))?.trimmingCharacters(in: .whitespacesAndNewlines)
        let address = (try? c.decodeIfPresent(String.self, forKey: .address))?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(pid: try c.decode(Int.self, forKey: .pid), name: name?.isEmpty == false ? name : nil, address: address?.isEmpty == false ? address : nil)
    }
}

/// The wire keys of the §42.2 fields, decoded beside each type's own keys.
enum PeerWireKeys: String, CodingKey {
    case toSession
    case selfSession = "self"
}
