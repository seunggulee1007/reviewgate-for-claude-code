import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FileWhy, ReviewHistoryEntry, ReviewHistoryFile, TranscriptItem, TranscriptSearchMatch, TurnSummaryEvent, TurnSummaryRow } from "../protocol.js";

/**
 * MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 "History that lasts": older transcript rows page by page
 * (`transcript_page`), the turn summary as a transcript row, a search over every chat's messages (`transcript_search`)
 * and the reason of a past round's file (`history_diff.why`). Pure readers of the session NDJSON files; nothing here
 * writes one.
 *
 * Row index: the position of a row's line among the file's non-empty lines (a torn line keeps its place, so an index
 * never moves while rows are appended). `transcript_restore.start` and `transcript_page.start` / `before` use it.
 */
export const TRANSCRIPT_PAGE_ROWS = 200;
export const TRANSCRIPT_PAGE_MAX = 2000;
export const TRANSCRIPT_SEARCH_MAX_QUERY = 200;
export const TRANSCRIPT_SEARCH_HITS = 50;
/** The matched line as shown under the chat's title. */
export const SEARCH_LINE_CHARS = 160;

/** The bounds of a `turn_summary` row (§38.3): what one row may carry at most. */
export const SUMMARY_ROW_MAX_FILES = 300;
export const SUMMARY_ROW_MAX_COMMANDS = 100;
export const SUMMARY_ROW_MAX_STEPS = 100;
export const SUMMARY_ROW_TEXT_CHARS = 2000;
export const SUMMARY_ROW_COMMAND_CHARS = 1000;
export const SUMMARY_ROW_MAX_IDS = 50;
/** The whole row's JSON; beyond it files are dropped from the end until it fits. */
export const SUMMARY_ROW_MAX_BYTES = 128 * 1024;

export type TranscriptWindow = { items: TranscriptItem[]; start: number; end: number };

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0 && l !== "\r");
}

function parseRow(line: string): TranscriptItem | null {
  try {
    const o = JSON.parse(line) as TranscriptItem;
    return o && typeof o === "object" && typeof o.kind === "string" ? o : null;
  } catch {
    return null;
  }
}

/**
 * Up to `limit` parsable rows that end right before row `before` (null: the end of the file), oldest first. `start` is
 * the index of the first returned row (= `end` when none). `beforeAt` (the `at` of the row the client holds at
 * `before`) re-finds that row when the file was rotated since (its oldest rows dropped): the window then ends at the row
 * now carrying that `at`; when no row does any more, everything older is gone too (empty window, start 0).
 */
export function transcriptWindow(text: string, before: number | null, limit: number, beforeAt?: string): TranscriptWindow {
  const lines = nonEmptyLines(text);
  let end = before === null ? lines.length : Math.min(Math.max(0, Math.floor(before)), lines.length);
  if (before !== null && beforeAt !== undefined && beforeAt !== "") {
    const atOf = (i: number) => parseRow(lines[i]!)?.at;
    if (end >= lines.length || atOf(end) !== beforeAt) {
      let found = -1;
      for (let i = Math.min(end, lines.length - 1); i >= 0; i--) {
        if (atOf(i) === beforeAt) {
          found = i;
          break;
        }
      }
      if (found === -1) return { items: [], start: 0, end: 0 };
      while (found > 0 && atOf(found - 1) === beforeAt) found--;
      end = found;
    }
  }
  const max = Math.max(1, Math.floor(limit));
  const items: TranscriptItem[] = [];
  let start = end;
  for (let i = end - 1; i >= 0 && items.length < max; i--) {
    const row = parseRow(lines[i]!);
    start = i;
    if (row) items.push(row);
  }
  return { items: items.reverse(), start, end };
}

/** `transcriptWindow` over a session file; a missing file reads as an empty one. */
export function readTranscriptWindow(path: string, before: number | null, limit: number, beforeAt?: string): TranscriptWindow {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // no rows yet
  }
  return transcriptWindow(text, before, limit, beforeAt);
}

/** All parsable rows of a session file (oldest first); [] when it is missing. */
export function readTranscriptRows(path: string): TranscriptItem[] {
  try {
    return transcriptWindow(readFileSync(path, "utf8"), null, Number.MAX_SAFE_INTEGER).items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- search

/** What a chat's newest matching message says (`transcript_search` adds the chat's id and title). */
export type SearchMatch = Omit<TranscriptSearchMatch, "sessionId" | "title">;

/** The line of `text` that holds `needle` (lower-cased), cut to SEARCH_LINE_CHARS around the match. */
export function matchedLine(text: string, needle: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const lower = raw.toLowerCase();
    const at = lower.indexOf(needle);
    if (at === -1) continue;
    const line = raw.trim();
    if (line.length <= SEARCH_LINE_CHARS) return line;
    const lead = raw.length - raw.trimStart().length;
    const from = Math.max(0, Math.min(at - lead - 40, line.length - SEARCH_LINE_CHARS));
    const cut = line.slice(from, from + SEARCH_LINE_CHARS);
    return `${from > 0 ? "…" : ""}${cut}${from + SEARCH_LINE_CHARS < line.length ? "…" : ""}`;
  }
  return null;
}

/**
 * The newest user message or Claude answer of `text` (a session's NDJSON) that contains `query` (case-insensitive,
 * trimmed). A file whose raw text cannot contain it is not parsed at all (the query has no character JSON escapes).
 */
export function searchTranscriptText(text: string, query: string): SearchMatch | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  // JSON escapes quotes, backslashes and control characters: only a query without them can be pre-checked on raw text.
  if (!/["\\\u0000-\u001f]/.test(needle) && !text.toLowerCase().includes(needle)) return null;
  const lines = nonEmptyLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = parseRow(lines[i]!);
    if (!row || (row.kind !== "user_message" && row.kind !== "assistant_text") || typeof row.text !== "string") continue;
    const line = matchedLine(row.text, needle);
    if (line !== null) return { row: i, turn: row.turn, at: row.at, kind: row.kind, line };
  }
  return null;
}

export async function searchTranscriptFile(path: string, query: string): Promise<SearchMatch | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return searchTranscriptText(text, query);
}

// ---------------------------------------------------------------- turn_summary rows

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The `turn_summary` row of a summary event: the event without `type` / `turn`, every list and text bounded. */
export function summaryRow(ev: TurnSummaryEvent): TurnSummaryRow {
  const { type: _type, turn: _turn, ...rest } = ev;
  let truncated = false;
  const text = (s: string | null | undefined): string | null | undefined => {
    if (typeof s !== "string" || s.length <= SUMMARY_ROW_TEXT_CHARS) return s;
    truncated = true;
    return cut(s, SUMMARY_ROW_TEXT_CHARS);
  };
  const ids = (xs: string[]): string[] => {
    if (xs.length <= SUMMARY_ROW_MAX_IDS) return [...xs];
    truncated = true;
    return xs.slice(0, SUMMARY_ROW_MAX_IDS);
  };
  if (rest.files.length > SUMMARY_ROW_MAX_FILES || rest.commands.length > SUMMARY_ROW_MAX_COMMANDS) truncated = true;
  let files = rest.files.slice(0, SUMMARY_ROW_MAX_FILES).map((f) => {
    const out = { ...f, why: text(f.why) ?? null, tools: ids(f.tools), toolUseIds: ids(f.toolUseIds) };
    if (f.whyDetail) {
      out.whyDetail = { ...f.whyDetail, text: text(f.whyDetail.text) ?? null };
      if (f.whyDetail.delegation !== undefined) out.whyDetail.delegation = text(f.whyDetail.delegation) ?? undefined;
    }
    return out;
  });
  const commands = rest.commands.slice(0, SUMMARY_ROW_MAX_COMMANDS).map((c) => {
    if (c.command.length <= SUMMARY_ROW_COMMAND_CHARS) return { ...c };
    truncated = true;
    return { ...c, command: cut(c.command, SUMMARY_ROW_COMMAND_CHARS) };
  });
  let plan = rest.plan;
  if (plan) {
    if (plan.steps.length > SUMMARY_ROW_MAX_STEPS || plan.unplannedFiles.length > SUMMARY_ROW_MAX_FILES) truncated = true;
    plan = {
      path: plan.path,
      steps: plan.steps.slice(0, SUMMARY_ROW_MAX_STEPS).map((s) => ({ ...s, text: text(s.text) ?? "", files: ids(s.files) })),
      unplannedFiles: plan.unplannedFiles.slice(0, SUMMARY_ROW_MAX_FILES),
      ...(plan.source ? { source: plan.source } : {}), // MARK: wave4d w4d-plan (§42.1)
      ...(plan.title ? { title: text(plan.title) ?? "" } : {}),
    };
  }
  const lastTest = rest.lastTest ? { ...rest.lastTest, command: cut(rest.lastTest.command, SUMMARY_ROW_COMMAND_CHARS) } : rest.lastTest;
  const build = (): TurnSummaryRow => ({
    ...rest,
    files,
    commands,
    plan,
    ...(lastTest !== undefined ? { lastTest } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  });
  let row = build();
  while (files.length > 1 && Buffer.byteLength(JSON.stringify(row)) > SUMMARY_ROW_MAX_BYTES) {
    files = files.slice(0, Math.ceil(files.length / 2));
    truncated = true;
    row = build();
  }
  return row;
}

// ---------------------------------------------------------------- history why

/**
 * §38.3 `history_diff.why`: why a past round changed `file`, from its chat's rows — the newest `turn_summary` row of the
 * round's turns that explains the path (its §34.8 `whyDetail`, else its `why`), else the first of the file's tool calls
 * whose `tool_use` row has a rationale. null when the rows say nothing (an older chat, a file nothing of Claude's touched).
 */
export function historyWhy(rows: readonly TranscriptItem[], entry: Pick<ReviewHistoryEntry, "turns">, file: Pick<ReviewHistoryFile, "path" | "toolUseIds">): FileWhy | null {
  const turns = new Set(entry.turns);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind !== "turn_summary" || (turns.size > 0 && !turns.has(r.turn))) continue;
    const f = r.files?.find((x) => x.path === file.path);
    if (!f) continue;
    if (f.whyDetail && typeof f.whyDetail.text === "string" && f.whyDetail.text) return { ...f.whyDetail, turn: f.whyDetail.turn ?? r.turn };
    if (typeof f.why === "string" && f.why) return { text: f.why, source: "same_message", ...(f.whyToolUseId ? { toolUseId: f.whyToolUseId } : {}), turn: r.turn };
  }
  const uses = new Map<string, Extract<TranscriptItem, { kind: "tool_use" }>>();
  for (const r of rows) if (r.kind === "tool_use") uses.set(r.id, r);
  for (const id of file.toolUseIds) {
    const u = uses.get(id);
    if (u && typeof u.rationale === "string" && u.rationale.trim()) {
      return { text: u.rationale, source: u.rationaleSource ?? "same_message", toolUseId: id, turn: u.turn, ...(typeof u.rationaleAge === "number" ? { age: u.rationaleAge } : {}) };
    }
  }
  return null;
}
