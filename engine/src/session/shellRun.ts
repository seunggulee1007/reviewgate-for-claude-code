import { CommandRefused } from "../errors.js";
import type { ShellResult } from "../protocol.js";

/**
 * docs/PROTOCOL.md §67.2 — `!` in a classic chat, as Claude Code's bash mode: the user's own command runs in the project
 * folder between turns (the engine runs it, `runSetupCommand`: the login shell, Windows `cmd.exe /d /s /c`, no stdin), its
 * row joins the chat, and command + output go to Claude with the next message — Claude does not run it. What it changes
 * in the project reaches the next review as an outside change (`external`, §31.1), never a fresh start that swallows it.
 */

/** A command still running after this long is stopped (`timedOut`). */
export const SHELL_TIMEOUT_MS = 10 * 60_000;
/** The row and Claude's context keep the last this many characters of the output (Claude Code's bash output limit). */
export const SHELL_OUTPUT_CHARS = 30_000;
/** `shell_output` carries the last this many characters. */
export const SHELL_LIVE_CHARS = 4_000;
/** `shell_output` goes out at most this often. */
export const SHELL_OUTPUT_MS = 300;
/** A longer command is refused (`command_too_long`). */
export const SHELL_COMMAND_MAX = 10_000;
/** Results waiting for the next message, per chat (the oldest go first). */
export const SHELL_PENDING_MAX = 5;
/** A row lists at most this many changed files (`filesTruncated` past it). */
export const SHELL_FILES_MAX = 50;

/** `command` trimmed, or refused: `empty_command`, `command_too_long`. A leading `!` (the box's own) is dropped. */
export function shellCommandOf(command: unknown): string {
  let c = typeof command === "string" ? command.trim() : "";
  if (c.startsWith("!")) c = c.slice(1).trim();
  if (!c) throw new CommandRefused("empty_command", { code: "empty_command" });
  if (c.length > SHELL_COMMAND_MAX) throw new CommandRefused("command_too_long", { code: "command_too_long" });
  return c;
}

// CSI (colors, cursor moves), OSC (titles, links) and the other two-byte escapes.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Terminal output as text: escapes removed, CRLF as LF, and a line a progress bar redrew with `\r` as its last drawing
 * (what a terminal would show).
 */
export function cleanShellOutput(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const t = line.replace(/\r+$/, "");
      const i = t.lastIndexOf("\r");
      return i >= 0 ? t.slice(i + 1) : t;
    })
    .join("\n");
}

/**
 * What goes in front of the next message for the `!` results that wait (oldest first) — Claude Code's own bash-mode
 * tags, with a line saying the user ran them (not Claude) and the exit code.
 */
export function shellContext(results: readonly ShellResult[]): string {
  if (results.length === 0) return "";
  const blocks = results.map((r) => {
    const status = r.cancelled ? "stopped by the user" : r.timedOut ? "stopped: timed out" : r.exitCode === null ? "did not run" : `exit code ${r.exitCode}`;
    const out = r.truncated ? `[… earlier output cut]\n${r.output}` : r.output;
    return `<bash-input>${r.command}</bash-input>\n<bash-stdout>${out}</bash-stdout>\n<bash-exit-code>${status}</bash-exit-code>`;
  });
  const lead = results.length === 1
    ? "The user ran this shell command in the project folder themselves (ReviewGate's `!` mode, as in Claude Code); you did not run it. Its output is context for the message below — do not run it again unless asked."
    : "The user ran these shell commands in the project folder themselves (ReviewGate's `!` mode, as in Claude Code); you did not run them. Their output is context for the message below — do not run them again unless asked.";
  return [lead, ...blocks].join("\n\n");
}

/** `pending` with `result` added — at most `SHELL_PENDING_MAX`, the oldest dropped. */
export function withPendingShell(pending: readonly ShellResult[], result: ShellResult): ShellResult[] {
  return [...pending, result].slice(-SHELL_PENDING_MAX);
}
