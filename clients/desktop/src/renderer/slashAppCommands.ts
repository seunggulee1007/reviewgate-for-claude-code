/**
 * MARK: b-slash — docs/PROTOCOL.md §56.5: the terminal's built-in slash commands typed in a classic chat. Its CLI runs in
 * stream-json, where the interactive built-ins (/model, /resume, /config …) do nothing visible — so the app answers them
 * with its own screens (src/renderer/slashAppRun.ts), and a built-in it has none for is never sent: the card over the box
 * offers a terminal chat. /clear, /compact, /btw and /mcp keep their own paths; prompt built-ins (/init, /review …) and the
 * user's own commands go to Claude. As on the Mac (Core SlashAppCommands.swift).
 */
import { t } from "./i18n";
import type { SlashEntry } from "./slashCommands";

export type SlashAppCommand =
  | { kind: "model"; name: string }
  | { kind: "resume" | "rewind" | "context" | "cost" | "permissions" | "agents" | "memory" | "config" | "help" | "status" | "exit" | "rename" }
  | { kind: "terminalOnly"; name: string };

/** The app's commands, as the palette lists them (each the terminal's name). */
export const APP_COMMAND_NAMES = ["agents", "config", "context", "cost", "exit", "help", "memory", "model", "permissions", "rename", "resume", "rewind", "status"] as const;
type AppName = (typeof APP_COMMAND_NAMES)[number];

/** The terminal's other names for them. */
export const APP_COMMAND_ALIASES: Readonly<Record<string, AppName>> = {
  continue: "resume",
  quit: "exit",
  settings: "config",
  checkpoint: "rewind",
  "allowed-tools": "permissions",
};

/** The terminal's built-ins that only its own screen has (CLI 2.x) — the app has nothing to show for them. */
export const TERMINAL_ONLY: ReadonlySet<string> = new Set([
  "add-dir", "bashes", "bug", "doctor", "export", "extra-usage", "feedback", "hooks", "ide", "install-github-app",
  "install-slack-app", "keybindings", "login", "logout", "migrate-installer", "output-style", "plugin", "privacy-settings",
  "release-notes", "sandbox", "stats", "statusline", "tasks", "terminal-setup", "theme", "todos", "upgrade", "usage", "vim",
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
  if (name === "model") return { kind: "model", name: (m[2] ?? "").trim() };
  if (isAppName(name)) return { kind: name };
  return TERMINAL_ONLY.has(name) ? { kind: "terminalOnly", name } : null;
}

/** The palette's line for one of `APP_COMMAND_NAMES`; null for any other name. */
export function appCommandDescription(name: string): string | null {
  switch (name) {
    case "agents": return t("Show the agent panel");
    case "config": return t("Open Settings");
    case "context": return t("Show how full the context is — and compact it");
    case "cost": return t("Show the session cost by model");
    case "exit": return t("Close this chat tab — it stays in the chat history");
    case "help": return t("Show the keyboard shortcuts");
    case "memory": return t("Show CLAUDE.md and the memory files Claude reads");
    case "model": return t("Choose the model — or type one: /model sonnet");
    case "permissions": return t("Open Settings › permissions");
    case "rename": return t("Rename this chat");
    case "resume": return t("Open the chat history to resume an earlier chat");
    case "rewind": return t("Rewind to before your last message");
    case "status": return t("Show the model, effort, session and MCP servers");
    default: return null;
  }
}

export const appCommandHint = (name: string): string => (name === "model" ? "[model]" : "");

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
