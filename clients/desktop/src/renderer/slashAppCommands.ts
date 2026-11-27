/**
 * MARK: b-slash — docs/PROTOCOL.md §56.5: the terminal's built-in slash commands typed in a classic chat. Its CLI runs in
 * stream-json, where the interactive built-ins (/model, /resume, /config …) do nothing visible — so the app answers them
 * with its own screens (src/renderer/slashAppRun.ts), and a built-in it has none for is never sent: the card over the box
 * offers a terminal chat. §67.1: /add-dir is the app's own (src/renderer/addedDirs.ts); §70.3 /export and /copy too (src/renderer/chatExport.ts). /clear, /compact, /btw and /mcp keep their own paths; prompt built-ins (/init, /review …) and the
 * user's own commands go to Claude. As on the Mac (Core SlashAppCommands.swift).
 */
import { copyDescription, exportDescription } from "./chatExport"; // §70.3
import { usageDescription } from "./usageReport"; // §71.1
import { todosDescription } from "./todoChecklist"; // §71.2
import { tasksDescription } from "./background"; // §71.3
import { hooksDescription } from "./hooksList"; // §72.1
import { outputStyleDescription } from "./outputStyles"; // §72.2
import { PLUGIN_HINT, pluginDescription, reloadPluginsDescription } from "./pluginManager"; // §72.3
import { t } from "./i18n";
import type { SlashEntry } from "./slashCommands";

export type SlashAppCommand =
  | { kind: "model"; name: string }
  /** §67.1 `/add-dir [path]`: "" opens the folder picker. */
  | { kind: "addDir"; path: string }
  /** §70.3 `/export [file]`: "" opens the export dialog. */
  | { kind: "export"; file: string }
  /** §70.3 `/copy [N]`: the argument as typed ("" is the latest answer). */
  | { kind: "copy"; arg: string }
  | { kind: "resume" | "rewind" | "context" | "permissions" | "agents" | "memory" | "config" | "help" | "status" | "exit" | "rename" }
  /** §71.1 `/usage` (the terminal's `/cost` and `/stats` are its aliases): the usage dialog. */
  | { kind: "usage" }
  /** §71.2 `/todos`: Claude's to-do checklist over the box. The CLI has no such command any more; the app keeps it. */
  | { kind: "todos" }
  /** §71.3 `/tasks` (the terminal's `/bashes` is its alias): the background work, with stop. */
  | { kind: "tasks" }
  /** §72.1 `/hooks`: the hooks in effect, read-only (components/dialogs/HooksDialog.tsx). */
  | { kind: "hooks" }
  /** §72.2 `/output-style [style]`: "" opens the style dialog; a name switches at once (any case, as the terminal's). */
  | { kind: "outputStyle"; name: string }
  /** §72.3 `/plugin [subcommand]` (the terminal's `/plugins` and `/marketplace` too): the plugin dialog (pluginManager.ts `parsePluginRequest`). */
  | { kind: "plugin"; arg: string }
  /** §72.3 `/reload-plugins [--force]`: the session's plugins again, with the terminal's summary. */
  | { kind: "reloadPlugins"; force: boolean }
  | { kind: "terminalOnly"; name: string };

/** The app's commands, as the palette lists them (each the terminal's name). */
export const APP_COMMAND_NAMES = ["add-dir", "agents", "config", "context", "copy", "exit", "export", "help", "hooks", "memory", "model", "output-style", "permissions", "plugin", "reload-plugins", "rename", "resume", "rewind", "status", "tasks", "todos", "usage"] as const;
type AppName = (typeof APP_COMMAND_NAMES)[number];

/** The terminal's other names for them. */
export const APP_COMMAND_ALIASES: Readonly<Record<string, AppName>> = {
  continue: "resume",
  quit: "exit",
  settings: "config",
  checkpoint: "rewind",
  "allowed-tools": "permissions",
  cost: "usage", // §71.1: the commands reference — "`/cost` and `/stats` are aliases"
  stats: "usage",
  bashes: "tasks", // §71.3: "`/tasks` … Also available as `/bashes`"
  plugins: "plugin", // §72.3: "`/plugins` and `/marketplace` are aliases for `/plugin`"
  marketplace: "plugin",
};

/** The terminal's built-ins that only its own screen has (CLI 2.x) — the app has nothing to show for them. */
export const TERMINAL_ONLY: ReadonlySet<string> = new Set([
  "bug", "doctor", "extra-usage", "feedback", "ide", "install-github-app",
  "install-slack-app", "keybindings", "login", "logout", "migrate-installer", "privacy-settings",
  "release-notes", "sandbox", "statusline", "terminal-setup", "theme", "upgrade", "vim",
]);

const isAppName = (name: string): name is AppName => (APP_COMMAND_NAMES as readonly string[]).includes(name);

/**
 * `text` (one line, `/name [args]`) as the app's command; null when it goes to Claude as before — another command, a
 * message, or a command of the same name that is the user's own (theirs wins: a project's `/status` keeps working).
 */
export function parseSlashAppCommand(text: string, entries: readonly SlashEntry[]): SlashAppCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || /[\r\n]/.test(trimmed)) return null;
  const m = /^\/(\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (!m) return null;
  const typed = m[1]!.toLowerCase();
  const own = entries.find((e) => e.name.toLowerCase() === typed);
  if (own && own.group.kind !== "builtin" && own.group.kind !== "other") return null;
  const name = APP_COMMAND_ALIASES[typed] ?? typed;
  if (isAppName(name)) {
    if (name === "model") return { kind: "model", name: (m[2] ?? "").trim() };
    if (name === "add-dir") return { kind: "addDir", path: (m[2] ?? "").trim() }; // §67.1
    if (name === "export") return { kind: "export", file: (m[2] ?? "").trim() }; // §70.3
    if (name === "copy") return { kind: "copy", arg: (m[2] ?? "").trim() };
    if (name === "output-style") return { kind: "outputStyle", name: (m[2] ?? "").trim() }; // §72.2
    if (name === "plugin") return { kind: "plugin", arg: (typed === "marketplace" ? `marketplace ${m[2] ?? ""}` : (m[2] ?? "")).trim() }; // §72.3
    if (name === "reload-plugins") return { kind: "reloadPlugins", force: ["--force", "force"].includes((m[2] ?? "").trim().toLowerCase()) };
    return { kind: name };
  }
  return TERMINAL_ONLY.has(name) ? { kind: "terminalOnly", name } : null;
}

/** The palette's line for one of `APP_COMMAND_NAMES`; null for any other name. */
export function appCommandDescription(name: string): string | null {
  switch (name) {
    case "add-dir": return t("Let Claude work in a directory outside the project too"); // §67.1
    case "agents": return t("Show the agent panel");
    case "config": return t("Open Settings");
    case "context": return t("Show how full the context is — and compact it");
    case "copy": return copyDescription(); // §70.3
    case "export": return exportDescription();
    case "exit": return t("Close this chat tab — it stays in the chat history");
    case "help": return t("Show the keyboard shortcuts");
    case "hooks": return hooksDescription(); // §72.1
    case "output-style": return outputStyleDescription(); // §72.2
    case "plugin": case "plugins": case "marketplace": return pluginDescription(); // §72.3
    case "reload-plugins": return reloadPluginsDescription();
    case "memory": return t("Show CLAUDE.md and the memory files Claude reads");
    case "model": return t("Choose the model — or type one: /model sonnet");
    case "permissions": return t("Open Settings › permissions");
    case "rename": return t("Rename this chat");
    case "resume": return t("Open the chat history to resume an earlier chat");
    case "rewind": return t("Rewind to before your last message");
    case "status": return t("Show the model, effort, session and MCP servers");
    case "todos": return todosDescription(); // §71.2
    case "tasks": case "bashes": return tasksDescription(); // §71.3
    case "usage": case "cost": case "stats": return usageDescription(); // §71.1 (the terminal lists its aliases too)
    default: return null;
  }
}

export const appCommandHint = (name: string): string =>
  name === "model" ? "[model]" : name === "add-dir" ? "[path]" : name === "export" ? "[file]" : name === "copy" ? "[N]" : name === "output-style" ? "[style]" : name === "plugin" ? PLUGIN_HINT : name === "reload-plugins" ? "[--force]" : "";

/** The palette's line for a built-in only the terminal has. */
export function terminalOnlyDescription(original: string): string {
  const note = t("Terminal chats only");
  return original ? `${note} — ${original}` : note;
}

/** The card's words for a built-in only the terminal has. */
export function terminalOnlyNotice(): string {
  return t("This command works in a terminal chat");
}

/** The palette's entries: the app's meaning over a built-in the CLI lists, the missing ones added (sorted by the caller). */
export function withAppCommands(entries: SlashEntry[]): SlashEntry[] {
  const builtin = (e: SlashEntry) => e.group.kind === "builtin" || e.group.kind === "other";
  const out = entries.map((e) => {
    if (!builtin(e)) return e;
    const app = appCommandDescription(e.name);
    if (app !== null) return { ...e, description: app, argumentHint: appCommandHint(e.name) };
    return TERMINAL_ONLY.has(e.name) ? { ...e, description: terminalOnlyDescription(e.description) } : e;
  });
  for (const name of APP_COMMAND_NAMES) {
    if (out.some((e) => e.name === name)) continue;
    const aliases = Object.keys(APP_COMMAND_ALIASES).filter((a) => APP_COMMAND_ALIASES[a] === name).sort();
    out.push({ name, description: appCommandDescription(name) ?? "", argumentHint: appCommandHint(name), isSkill: false, aliases, group: { kind: "builtin" } });
  }
  return out;
}
