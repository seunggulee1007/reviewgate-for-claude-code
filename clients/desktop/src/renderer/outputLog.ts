/**
 * MARK: c-panel — docs/PROTOCOL.md §57.18: the bottom panel's Output tab, as on the Mac (Core OutputLog.swift). A
 * read-only log of the window's own lines ("ReviewGate": the engine's `log` events and what the store logs) and of the
 * Bash commands Claude ran in this window ("Claude commands": each Bash `tool_use` with its `tool_result` — the kept
 * `tool_output` when the preview was cut). At most `OUTPUT_LIMIT` lines, oldest dropped. The store feeds it
 * (store.ts: `appendLog`, `tool_use`, `tool_result`); the panel reads it (components/terminal/OutputPanel.tsx).
 */
import { create } from "zustand";
import { t } from "./i18n";

export type OutputSource = "reviewGate" | "claude";
export type OutputLine = { id: number; source: OutputSource; text: string };
export type OutputFilter = "all" | OutputSource;

export const OUTPUT_LIMIT = 5_000;

export type OutputBuffer = { lines: OutputLine[]; nextId: number };

export const EMPTY_OUTPUT: OutputBuffer = { lines: [], nextId: 0 };

/** `text` line by line (`\n`, `\r\n`; a trailing newline adds no empty line); past `limit` the oldest go. */
export function appendOutput(buf: OutputBuffer, source: OutputSource, text: string, limit = OUTPUT_LIMIT): OutputBuffer {
  let parts = text.replace(/\r\n/g, "\n").split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length > limit) parts = parts.slice(parts.length - limit);
  let id = buf.nextId;
  const added = parts.map((p) => ({ id: id++, source, text: p }));
  const lines = buf.lines.concat(added);
  return { lines: lines.length > limit ? lines.slice(lines.length - limit) : lines, nextId: id };
}

/** One Bash call: `$ <command>`, its output, and a closing line when it failed or the output was cut. */
export function bashBlock(command: string, output: string, isError: boolean, truncated: boolean): string {
  let block = `$ ${command.replace(/\n/g, "\n  ")}`;
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (body) block += `\n${body}`;
  if (truncated) block += `\n${t("… (the output was cut)")}`;
  if (isError) block += `\n${t("✗ The command failed")}`;
  return block;
}

/** The lines of the filter holding `query` (case-insensitive; empty: every line). */
export function filterOutput(lines: readonly OutputLine[], filter: OutputFilter, query: string): OutputLine[] {
  const q = query.trim().toLowerCase();
  return lines.filter((l) => (filter === "all" || l.source === filter) && (!q || l.text.toLowerCase().includes(q)));
}

export function outputText(lines: readonly OutputLine[]): string {
  return lines.map((l) => l.text).join("\n");
}

// ---------------------------------------------------------------- the window's buffer

export const useOutputLog = create<OutputBuffer>(() => EMPTY_OUTPUT);

/** The command of each Bash `tool_use` until its `tool_result` comes (results that never came: dropped past 200). */
const bashCommands = new Map<string, string>();

export function outputLogLine(line: string): void {
  useOutputLog.setState((s) => appendOutput(s, "reviewGate", line));
}

export function outputToolUse(id: string, name: string, input: unknown): void {
  if (name !== "Bash") return;
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return;
  if (bashCommands.size >= 200) bashCommands.clear();
  bashCommands.set(id, command);
}

/**
 * A Bash result joins the output — the kept full output (`fetchFull`, the engine's `tool_output`) when the preview was
 * cut, else the preview. A result whose `tool_use` this window did not see (a restored row) adds nothing.
 */
export function outputToolResult(
  ev: { toolUseId: string; isError: boolean; preview: string; truncated?: boolean },
  fetchFull: (toolUseId: string) => Promise<{ output: string | null; truncated: boolean }>,
): void {
  const command = bashCommands.get(ev.toolUseId);
  if (command === undefined) return;
  bashCommands.delete(ev.toolUseId);
  const add = (output: string, cut: boolean) => useOutputLog.setState((s) => appendOutput(s, "claude", bashBlock(command, output, ev.isError, cut)));
  if (!ev.truncated) {
    add(ev.preview, false);
    return;
  }
  void fetchFull(ev.toolUseId).then(
    (r) => add(r.output ?? ev.preview, r.output === null || r.truncated),
    () => add(ev.preview, true),
  );
}

/** Output › Clear: the window's output starts empty again (main's log file keeps its lines). */
export function clearOutputLog(): void {
  useOutputLog.setState({ lines: [] });
}
