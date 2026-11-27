import Foundation

// MARK: b-slash — docs/PROTOCOL.md §56.5: the terminal's built-in slash commands typed in a classic chat. The CLI runs in
// stream-json there, where its interactive built-ins (/model, /resume, /config …) do nothing visible — so the app answers
// them with its own screens, and a built-in it has no screen for is not sent: the notice offers a terminal chat. /clear,
// /compact, /btw and /mcp keep their own paths; prompt built-ins (/init, /review …) and the user's own commands go to Claude.

/// What a typed built-in does in a classic chat.
public enum SlashAppCommand: Equatable, Sendable {
    /// `/model` alone: the model picker; `/model <name>`: that model at once.
    case model(String)
    case resume, rewind, context, permissions, agents, memory, config, help, status, exit, rename
    /// §71.1 `/usage` (the terminal's `/cost` and `/stats` are its aliases): the usage sheet.
    case usage
    /// §71.2 `/todos`: Claude's to-do checklist over the box (as ⌃T). The CLI has no such command any more; the app keeps it.
    case todos
    /// §71.3 `/tasks` (the terminal's `/bashes` is its alias): the background work — shells, monitors, agents — with stop.
    case tasks
    /// §72.1 `/hooks`: the hooks in effect, read-only, with Open in Editor.
    case hooks
    /// §67.1 `/add-dir <path>`: the directory joins the chat (`add_dir`); `/add-dir` alone (an empty path) opens the folder picker.
    case addDir(String)
    /// §70.3 `/export [file]`: written to that file, or (no file) the export sheet — copy or save.
    case export(String)
    /// §70.3 `/copy [N]`: Claude's Nth-latest answer to the clipboard (the argument as typed: "" is the latest).
    case copy(String)
    /// A built-in of the terminal's screen the app has none for (`/hooks`, `/vim` …): never sent.
    case terminalOnly(String)

    /// The app's commands, as the palette lists them (each the terminal's name).
    public static let names = ["add-dir", "agents", "config", "context", "copy", "exit", "export", "help", "hooks", "memory", "model",
                               "permissions", "rename", "resume", "rewind", "status", "tasks", "todos", "usage"]

    /// The terminal's other names for them.
    static let aliases: [String: String] = [
        "continue": "resume", "quit": "exit", "settings": "config", "checkpoint": "rewind", "allowed-tools": "permissions",
        "cost": "usage", "stats": "usage",   // §71.1: the commands reference — "`/cost` and `/stats` are aliases"
        "bashes": "tasks",   // §71.3: "`/tasks` … Also available as `/bashes`"
    ]

    /// The terminal's built-ins that only its own screen has (CLI 2.x) — the app has nothing to show for them.
    public static let terminalOnly: Set<String> = [
        "bug", "doctor", "extra-usage", "feedback", "ide", "install-github-app",
        "install-slack-app", "keybindings", "login", "logout", "migrate-installer", "output-style", "plugin", "privacy-settings",
        "release-notes", "sandbox", "statusline", "terminal-setup", "theme", "upgrade", "vim",
    ]

    /// `text` (one line, `/name [args]`) as the app's command; nil when it goes to Claude as before — another command, a
    /// message, or a command of the same name that is the user's own (theirs wins: a project's `/status` keeps working).
    public static func parse(_ text: String, entries: [SlashCommandEntry]) -> SlashAppCommand? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), !trimmed.contains(where: \.isNewline) else { return nil }
        let token = trimmed.dropFirst().prefix { !$0.isWhitespace }
        guard !token.isEmpty else { return nil }
        let typed = String(token).lowercased()
        if let own = entries.first(where: { $0.name.lowercased() == typed }) {
            switch own.group {
            case .builtin, .other, .recent, .matches: break
            case .mine, .project, .plugin, .mcp: return nil
            }
        }
        let name = aliases[typed] ?? typed
        let argument = trimmed.dropFirst(1 + token.count).trimmingCharacters(in: .whitespaces)
        switch name {
        case "model": return .model(argument)
        case "resume": return .resume
        case "rewind": return .rewind
        case "context": return .context
        case "usage": return .usage   // §71.1
        case "todos": return .todos   // §71.2
        case "tasks": return .tasks   // §71.3
        case "hooks": return .hooks   // §72.1
        case "permissions": return .permissions
        case "agents": return .agents
        case "memory": return .memory
        case "config": return .config
        case "help": return .help
        case "status": return .status
        case "exit": return .exit
        case "rename": return .rename
        case "add-dir": return .addDir(argument)   // §67.1
        case "export": return .export(argument)   // §70.3
        case "copy": return .copy(argument)
        default: return terminalOnly.contains(name) ? .terminalOnly(name) : nil
        }
    }

    /// The palette's line for one of `names`; nil for any other name.
    public static func description(_ name: String) -> String? {
        switch name {
        case "add-dir": AddDirText.description   // §67.1
        case "copy": ChatExportText.copyDescription   // §70.3
        case "export": ChatExportText.exportDescription
        case "agents": String(localized: "Show the agent panel", bundle: .module)
        case "config": String(localized: "Open Settings", bundle: .module)
        case "context": String(localized: "Show how full the context is — and compact it", bundle: .module)
        case "exit": String(localized: "Close this chat tab — it stays in the chat history", bundle: .module)
        case "help": String(localized: "Show the keyboard shortcuts", bundle: .module)
        case "hooks": HooksText.description   // §72.1
        case "memory": String(localized: "Show CLAUDE.md and the memory files Claude reads", bundle: .module)
        case "model": String(localized: "Choose the model — or type one: /model sonnet", bundle: .module)
        case "permissions": String(localized: "Open Settings › permissions", bundle: .module)
        case "rename": String(localized: "Rename this chat", bundle: .module)
        case "resume": String(localized: "Open the chat history to resume an earlier chat", bundle: .module)
        case "rewind": String(localized: "Rewind to before your last message", bundle: .module)
        case "status": String(localized: "Show the model, effort, session and MCP servers", bundle: .module)
        case "todos": TodoText.description   // §71.2
        case "tasks", "bashes": BackgroundText.tasksDescription   // §71.3
        case "usage", "cost", "stats": UsageText.description   // §71.1 (the terminal lists its aliases too)
        default: nil
        }
    }

    /// The palette's argument hint for one of `names`.
    public static func argumentHint(_ name: String) -> String {
        switch name {
        case "model": "[model]"
        case "add-dir": AddDirText.argumentHint
        case "copy": "[N]"   // §70.3
        case "export": "[file]"
        default: ""
        }
    }

    /// The palette's line for a built-in only the terminal has.
    public static func terminalOnlyDescription(_ original: String) -> String {
        let note = String(localized: "Terminal chats only", bundle: .module)
        return original.isEmpty ? note : "\(note) — \(original)"
    }

    /// The notice for a built-in only the terminal has.
    public static var terminalOnlyNotice: String {
        String(localized: "This command works in a terminal chat", bundle: .module)
    }
}
