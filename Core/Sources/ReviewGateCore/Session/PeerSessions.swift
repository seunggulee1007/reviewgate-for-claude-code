import Foundation

// MARK: wave4d w4d-peers
// docs/PROTOCOL.md §42.2 on the client (audit peer-05, peer-07): the SendMessage card names the session a message goes to
// (its registry name, where it runs, whether it is a terminal) instead of a socket path, and the sidebar says how the
// user's other sessions see this window — the name to tell a terminal Claude, with its address — with a copy action.

public enum PeerSessionText {
    /// The SendMessage card's receiving session: its registry name, else what the call named (`to`), else "?".
    public static func recipientTitle(_ content: SendMessageCardContent) -> String {
        content.toSession?.name ?? content.to ?? "?"
    }

    /// The line under it: a terminal or an app, the folder (home as `~`) and the state — empty without a known session.
    public static func recipientDetail(_ info: PeerSessionInfo?, home: String = NSHomeDirectory()) -> String {
        guard let info else { return "" }
        let kind = info.isTerminal ? String(localized: "Terminal", bundle: .module) : String(localized: "App", bundle: .module)
        return [kind, info.cwd.map { abbreviated($0, home: home) }, CliSessionText.status(info.status)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The address under the name — only when the name is the registry's (else the title already is the address).
    public static func recipientAddress(_ content: SendMessageCardContent) -> String? {
        guard let info = content.toSession, info.name != nil, !info.address.isEmpty else { return nil }
        return info.address
    }

    /// What "copy" puts on the clipboard for this window: `name (address)`, or whichever of them is known.
    public static func selfCopyText(_ me: PeerSelf) -> String? {
        switch (me.name, me.address) {
        case let (name?, address?): "\(name) (\(address))"
        case let (name?, nil): name
        case let (nil, address?): address
        case (nil, nil): nil
        }
    }

    static func abbreviated(_ path: String, home: String) -> String {
        let h = home.hasSuffix("/") ? String(home.dropLast()) : home
        guard !h.isEmpty else { return path }
        if path == h { return "~" }
        return path.hasPrefix(h + "/") ? "~" + path.dropFirst(h.count) : path
    }
}
