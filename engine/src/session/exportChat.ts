import { writeFile } from "node:fs/promises";
import { CommandRefused } from "../errors.js";
import type { TranscriptItem } from "../protocol.js";
import { resolveDirInput } from "./addedDirs.js";

/**
 * docs/PROTOCOL.md §70.3 — `/export` and `/copy` in a classic chat. `/export` writes the conversation as plain text (the
 * terminal's "Export the current conversation as plain text"); `/copy [N]` hands back the Nth-latest answer of Claude. The
 * text is made from the chat's transcript rows: the user's messages, Claude's text, one line per tool call (with the first
 * line of its result), the `!` commands and the errors the user saw.
 */

/** A typed file name longer than this is refused (`export_path_too_long`). */
export const MAX_EXPORT_PATH = 4096;
/** `/copy N`: N from 1 (the latest answer) up to this. */
export const MAX_COPY_N = 1000;

/** The tool call's argument as the terminal prints it: `Edit(src/a.ts)`, `Bash(npm test)`. */
function toolArgument(row: Extract<TranscriptItem, { kind: "tool_use" }>): string {
  const input = row.input ?? {};
  const pick = (k: string): string | null => (typeof input[k] === "string" && (input[k] as string).trim() ? (input[k] as string) : null);
  const arg = row.file ?? pick("file_path") ?? pick("command") ?? pick("pattern") ?? pick("url") ?? pick("description") ?? pick("query") ?? "";
  const line = arg.split(/\r?\n/)[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const firstLine = (s: string): string => (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
const indent = (s: string, prefix: string, rest: string): string =>
  s.split(/\r?\n/).map((l, i) => (i === 0 ? prefix : rest) + l).join("\n");

/**
 * The conversation as plain text, oldest first, in the terminal's shapes: `> ` before the user's lines, `⏺ ` before
 * Claude's text and tool calls, `  ⎿  ` before a result's first line. A subagent's own calls are left out (as the
 * terminal folds them into the Agent line).
 */
export function chatExportText(rows: readonly TranscriptItem[]): string {
  const blocks: string[] = [];
  const tools = new Map<string, number>();
  for (const row of rows) {
    switch (row.kind) {
      case "user_message":
        if (row.text.trim()) blocks.push(indent(row.text.trimEnd(), "> ", "  "));
        break;
      case "assistant_text":
        if (row.text.trim()) blocks.push(indent(row.text.trim(), "⏺ ", "  "));
        break;
      case "tool_use": {
        if (row.parentToolUseId) break;
        const arg = toolArgument(row);
        tools.set(row.id, blocks.length);
        blocks.push(`⏺ ${row.name}${arg ? `(${arg})` : ""}`);
        break;
      }
      case "tool_result": {
        const at = tools.get(row.toolUseId);
        if (at === undefined) break;
        const line = firstLine(row.preview ?? "");
        if (line) blocks[at] += `\n  ⎿  ${row.isError ? "Error: " : ""}${line.length > 200 ? `${line.slice(0, 199)}…` : line}`;
        break;
      }
      case "shell":
        blocks.push(indent(`! ${row.command}`, "", "  ") + (row.output.trim() ? `\n${indent(row.output.trimEnd(), "  ⎿  ", "     ")}` : ""));
        break;
      case "error":
        blocks.push(`⏺ Error: ${row.message}`);
        break;
      default:
        break;
    }
  }
  return blocks.length > 0 ? blocks.join("\n\n") + "\n" : "";
}

/** Claude's answers, oldest first: the text of each turn's own (not a subagent's) `assistant_text` rows, joined. */
export function responses(rows: readonly TranscriptItem[]): string[] {
  const byTurn = new Map<number, string[]>();
  for (const row of rows) {
    if (row.kind !== "assistant_text" || !row.text.trim()) continue;
    const list = byTurn.get(row.turn) ?? [];
    list.push(row.text.trim());
    byTurn.set(row.turn, list);
  }
  return [...byTurn.values()].map((parts) => parts.join("\n\n"));
}

/** `/copy [N]`: the Nth-latest answer (1 = the latest); refused `invalid_copy_n`, `no_response` (none that far back). */
export function nthResponse(rows: readonly TranscriptItem[], n: unknown): string {
  const k = n === undefined || n === null ? 1 : n;
  if (typeof k !== "number" || !Number.isInteger(k) || k < 1 || k > MAX_COPY_N) {
    throw new CommandRefused(`invalid_copy_n:${String(n).slice(0, 40)}`, { code: "invalid_copy_n" });
  }
  const all = responses(rows);
  const text = all[all.length - k];
  if (text === undefined) throw new CommandRefused(`no_response:${k}`, { code: "no_response" });
  return text;
}

/** The file name a save dialog proposes: `2026-11-26-143005-fix-the-login-test.txt` (the first message's words). */
export function exportFileName(rows: readonly TranscriptItem[], now: Date): string {
  const p = (v: number) => String(v).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const first = rows.find((r): r is Extract<TranscriptItem, { kind: "user_message" }> => r.kind === "user_message" && r.text.trim() !== "");
  const slug = (first?.text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return `${stamp}${slug ? `-${slug}` : "-conversation"}.txt`;
}

/**
 * `/export <file>`: writes `text` to `input` (absolute, `~/…`, or relative to the project folder `root`) and returns the
 * absolute path. An existing file is refused `export_exists:<path>` (as the terminal since v2.1.327) unless `replace` —
 * a save dialog asked already. Other failures: `export_empty_path`, `export_path_too_long`, `export_failed:<why>`.
 */
export async function writeExport(input: unknown, root: string, text: string, replace: boolean, home?: string): Promise<string> {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) throw new CommandRefused("export_empty_path", { code: "export_empty_path" });
  if (raw.length > MAX_EXPORT_PATH) throw new CommandRefused("export_path_too_long", { code: "export_path_too_long" });
  const path = resolveDirInput(raw, root, home);
  try {
    await writeFile(path, text, { encoding: "utf8", flag: replace ? "w" : "wx" });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") throw new CommandRefused(`export_exists:${path}`, { code: "export_exists" });
    throw new CommandRefused(`export_failed:${err.code ?? ""} ${err.message ?? String(e)}`.slice(0, 300), { code: "export_failed" });
  }
  return path;
}
