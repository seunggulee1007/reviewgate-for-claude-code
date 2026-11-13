import Foundation

// MARK: composer parity — docs/PROTOCOL.md §56.3: ⌃G edits the message box's draft in an external editor, as Ctrl+G in the
// terminal: the draft goes to a .md file in the app's own temp folder, the editor opens it, and each save comes back into
// the box. Which editor, decided here (the app launches and watches it).

/// How the draft's editor is started for one file.
public struct DraftEditorLaunch: Sendable, Equatable {
    /// Shown while editing: "Editing in <name>…".
    public let name: String
    public let executable: String
    public let arguments: [String]
    /// The process ends when editing ends (its exit finishes the editing); false: it hands the file to an app and returns
    /// (the user finishes with Done).
    public let waits: Bool

    public init(name: String, executable: String, arguments: [String], waits: Bool) {
        self.name = name
        self.executable = executable
        self.arguments = arguments
        self.waits = waits
    }
}

public enum DraftEditor {
    /// Editors that need a terminal: the app has none to give them, so $VISUAL / $EDITOR naming one is passed over.
    static let terminalOnly: Set<String> = ["vi", "vim", "nvim", "view", "nano", "pico", "emacs", "ed", "ex", "micro", "hx", "helix",
                                             "kak", "joe", "ne", "mg", "jed", "less", "more", "vis", "amp"]
    /// GUI editors and the flag that makes their command wait until the file is closed.
    static let waitFlags: [String: [String]] = [
        "code": ["--wait", "-w"], "code-insiders": ["--wait", "-w"], "cursor": ["--wait", "-w"], "windsurf": ["--wait", "-w"],
        "zed": ["--wait", "-w"], "subl": ["-w", "--wait"], "mate": ["-w", "--wait"], "bbedit": ["--wait", "-w"],
        "atom": ["--wait", "-w"], "mvim": ["-f"], "gvim": ["-f"],
    ]

    /// The temp folder the drafts are written to (the app's own, under the system's temp folder).
    public static func folder(temp: URL = FileManager.default.temporaryDirectory) -> URL {
        temp.appendingPathComponent("ReviewGate", isDirectory: true).appendingPathComponent("drafts", isDirectory: true)
    }

    /// The editor for `file`: $VISUAL, else $EDITOR — when it can open a window (a terminal editor cannot open from the
    /// app; a known GUI editor gets the flag that makes it wait) —, else VS Code's `code --wait`, else the system's default
    /// text editor (`open -t`, which does not wait). `findExecutable` finds a command on the PATH (nil: none).
    public static func launch(file: String, env: [String: String], findExecutable: (String) -> String?,
                              defaultEditorName: String) -> DraftEditorLaunch {
        for key in ["VISUAL", "EDITOR"] {
            guard let value = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty,
                  let command = guiCommand(value) else { continue }
            return DraftEditorLaunch(name: command.name, executable: "/bin/sh", arguments: ["-c", command.line + " \"$1\"", "sh", file], waits: true)
        }
        if let code = findExecutable("code") {
            return DraftEditorLaunch(name: "VS Code", executable: code, arguments: ["--wait", file], waits: true)
        }
        return DraftEditorLaunch(name: defaultEditorName, executable: "/usr/bin/open", arguments: ["-t", file], waits: false)
    }

    /// `$VISUAL` / `$EDITOR` as a shell command line that opens a window and waits; nil for a terminal editor.
    static func guiCommand(_ value: String) -> (name: String, line: String)? {
        let words = value.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let first = words.first else { return nil }
        let program = (first.trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) as NSString).lastPathComponent
        if program == "emacsclient" {
            // A frame of its own (-c) is a window; otherwise it edits in the terminal it was started from.
            return words.contains("-c") || words.contains("--create-frame") ? (program, value) : nil
        }
        guard !terminalOnly.contains(program) else { return nil }
        guard let flags = waitFlags[program], let flag = flags.first, !words.contains(where: flags.contains) else { return (program, value) }
        return (program, value + " " + flag)
    }
}
