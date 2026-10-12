import Foundation

// MARK: wave5 w5-fixes — docs/PROTOCOL.md §43.5: the basis of "plan vs actual" chosen from a menu (Electron planBasis.ts)
//
// `state.session.planSource` (§42.1) says what the next turn summary compares against and which plan files there are;
// `plan_follow {path}` chooses one for the chat (null: back to the automatic sources). An older engine sends no
// `planSource`: no menu. A plan approved in ReviewGate comes first in the engine, so the menu is shown but cannot change it.

/// The "기준" menu on the newest turn summary card.
public struct PlanBasisMenu: Sendable, Equatable {
    public struct Item: Sendable, Equatable, Identifiable {
        public var id: String { path ?? "\u{0}automatic" }
        /// nil: the automatic sources (the plan file the chat names, Claude's to-do list, the first message's list).
        public var path: String?
        public var title: String
        /// The full path, or what the automatic sources are.
        public var help: String
        public var checked: Bool
    }

    /// The button: "기준: 자동 · db-plan.md".
    public var label: String
    /// Automatic first, then the plan files.
    public var items: [Item]
    /// Why nothing can be chosen now (a plan approved in ReviewGate); nil = the items work.
    public var blocker: String?
    /// The line under the items.
    public var note: String

    /// The plan file the chat chose (nil: automatic, or a plan approved here).
    public var chosenPath: String? { items.first(where: \.checked)?.path }
}

public enum PlanBasis {
    /// The menu for `planSource` (nil on an older engine / without a chat). `home` abbreviates absolute paths as `~/…`.
    public static func menu(_ source: PlanSourceState?, home: String = NSHomeDirectory()) -> PlanBasisMenu? {
        guard let source else { return nil }
        let approved = source.kind == .approved
        let chosen = source.chosen && source.kind == .file ? source.path : nil
        var files = source.candidates
        if let chosen, !files.contains(chosen) { files.insert(chosen, at: 0) }
        var items = [PlanBasisMenu.Item(path: nil,
                                        title: String(localized: "Choose automatically", bundle: .module),
                                        help: String(localized: "The plan file the chat names, Claude's to-do list, then your first message's list", bundle: .module),
                                        checked: !approved && chosen == nil)]
        items += files.map { PlanBasisMenu.Item(path: $0, title: fileTitle($0, home: home), help: $0, checked: !approved && $0 == chosen) }
        return PlanBasisMenu(
            label: String(localized: "Basis: \(current(source, chosen: chosen))", bundle: .module),
            items: items,
            blocker: approved ? String(localized: "This chat follows the plan you approved in ReviewGate", bundle: .module) : nil,
            note: files.isEmpty
                ? String(localized: "No plan files yet — .omc/plans, .claude/plans and plan files under docs/ show up here", bundle: .module)
                : String(localized: "The next turn summary compares against it", bundle: .module))
    }

    /// What the chat follows now, in a few words.
    static func current(_ source: PlanSourceState, chosen: String?) -> String {
        if source.kind == .approved { return String(localized: "Approved plan", bundle: .module) }
        if let chosen { return name(chosen) }
        let what: String? = switch source.kind {
        case .file?: source.path.map(name)
        case .todos?: String(localized: "Claude's to-do list", bundle: .module)
        case .message?: String(localized: "Your first message's list", bundle: .module)
        case .request?: String(localized: "Request scope", bundle: .module)
        case .approved?, nil: nil
        }
        guard let what else { return String(localized: "Automatic", bundle: .module) }
        return String(localized: "Automatic · \(what)", bundle: .module)
    }

    /// "db-plan.md  ·  .omc/plans" — the name, then its folder (`~/…` under the home folder; none at the root).
    public static func fileTitle(_ path: String, home: String) -> String {
        let shown = abbreviated(path, home: home)
        let folder = (shown as NSString).deletingLastPathComponent
        return folder.isEmpty ? name(shown) : "\(name(shown))  ·  \(folder)"
    }

    static func name(_ path: String) -> String {
        let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
        return trimmed.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? trimmed
    }

    static func abbreviated(_ path: String, home: String) -> String {
        let h = home.hasSuffix("/") ? String(home.dropLast()) : home
        guard !h.isEmpty, path.hasPrefix(h + "/") else { return path }
        return "~" + path.dropFirst(h.count)
    }

    /// A refused `plan_follow` in words (`invalid_plan_file`: the file is gone or no longer Markdown).
    public static func refusal(code: String?, fallback: String) -> String {
        switch code {
        case "invalid_plan_file": String(localized: "That plan file cannot be read any more — choose another one", bundle: .module)
        default: fallback
        }
    }
}

extension AppState {
    /// The basis menu of the live chat (nil on an older engine / without a chat).
    public var planBasisMenu: PlanBasisMenu? { PlanBasis.menu(sessionInfo.planSource) }

    /// `plan_follow {path}` from the menu (nil: the automatic sources). Nothing is sent for the basis already followed or
    /// while an approved plan decides; a refusal becomes an error row with its reason.
    public func choosePlanBasis(path: String?) async {
        guard let menu = planBasisMenu, menu.blocker == nil, menu.chosenPath != path else { return }
        do {
            try await request(.planFollow(path: path))
        } catch let error as EngineClientError {
            appendLog("[warn] plan_follow: \(error.localizedDescription)")
            fail(PlanBasis.refusal(code: error.refusalCode, fallback: error.userMessage), fatal: false)
        } catch {
            fail(error.localizedDescription, fatal: false)
        }
    }
}
