/**
 * What a subagent reported (docs/PROTOCOL.md §36.1, §36.3): an `Agent` / `Task` call's result — and a SendMessage
 * continuation's — without the CLI's hand-back frame, the reports the engine keeps for `agent_report`, and reading
 * them back from a chat's transcript rows after a restart.
 */
import type { AgentReportEvent, AgentUsage, TranscriptItem, TranscriptRestoreEvent } from "../protocol.js";

const SUBAGENT_TOOL_RE = /^(Agent|Task)$/;

/** `AgentNode.prompt`: the instructions' first N chars. */
export const AGENT_PROMPT_CHARS = 8_000;
/** `AgentNode.reportPreview`: the cleaned report's first N chars. */
export const AGENT_REPORT_PREVIEW_CHARS = 600;
/** What is kept of a report (memory, the transcript row) and of the instructions `agent_report` answers with. */
export const AGENT_REPORT_KEPT_CHARS = 50_000;

export type CleanedReport = {
  /** The report — or the input itself, untouched, when it carried none of the markers (another CLI). */
  text: string;
  /** A marker was found: the frame's preamble, the `agentId:` line or the `<usage>` block. */
  cleaned: boolean;
  /** The `<usage>` block, when it had all three numbers. */
  usage?: AgentUsage;
  /** The `agentId:` line's id — what SendMessage `to` names. */
  cliAgentId?: string;
};

const HAND_BACK = "[Subagent hand-back]";
const REPORT_FOLLOWS_RE = /The report follows:\s*$/;
/** At column 0: the harness indents every line of the report itself, so a trailer-like line inside it is not one. */
const AGENT_ID_RE = /^agentId:\s*([A-Za-z0-9][\w-]*)/;
const JSON_LINE_RE = /^\s*\{.*\}\s*$/;
const BLANK_RE = /^\s*$/;

/**
 * §36.1: the report of an Agent / Task result (its text blocks joined): (1) a leading `[Subagent hand-back] …` preamble
 * is removed through the line ending in `The report follows:`; (3) a trailing `agentId: <id> (…)` line and `<usage>…</usage>`
 * block (either order) are parsed and removed; (2) when every non-blank line left starts with two spaces, two are
 * removed from each (the trailer is taken off first: it is not indented); blank lines at both ends are trimmed. A result
 * with none of the markers is returned as it came. `jsonLead` (§36.3, a SendMessage continuation): a JSON status line
 * right before the frame goes too.
 */
export function cleanAgentReport(raw: string, opts: { jsonLead?: boolean } = {}): CleanedReport {
  let lines = raw.split("\n");
  let cleaned = false;
  if (opts.jsonLead && lines.length > 1 && JSON_LINE_RE.test(lines[0]!) && lines[1]!.trimStart().startsWith(HAND_BACK)) lines = lines.slice(1);
  const first = lines.findIndex((l) => !BLANK_RE.test(l));
  if (first !== -1 && lines[first]!.trimStart().startsWith(HAND_BACK)) {
    const end = lines.findIndex((l, i) => i >= first && REPORT_FOLLOWS_RE.test(l));
    if (end !== -1) {
      lines = lines.slice(end + 1);
      cleaned = true;
    }
  }
  let usage: AgentUsage | undefined;
  let cliAgentId: string | undefined;
  let sawUsage = false;
  let sawId = false;
  for (;;) {
    dropBlankEnd(lines);
    const last = lines[lines.length - 1];
    if (last === undefined) break;
    if (!sawUsage && last.trimEnd().endsWith("</usage>")) {
      let start = lines.length - 1;
      while (start >= 0 && !lines[start]!.startsWith("<usage>")) start--;
      if (start < 0) break;
      usage = parseUsage(lines.slice(start).join("\n"));
      lines = lines.slice(0, start);
      sawUsage = true;
      continue;
    }
    const id = sawId ? null : AGENT_ID_RE.exec(last);
    if (id) {
      cliAgentId = id[1];
      lines = lines.slice(0, -1);
      sawId = true;
      continue;
    }
    break;
  }
  if (!cleaned && !sawUsage && !sawId) return { text: raw, cleaned: false };
  const body = lines.filter((l) => !BLANK_RE.test(l));
  if (body.length > 0 && body.every((l) => l.startsWith("  "))) lines = lines.map((l) => l.replace(/^ {1,2}/, ""));
  while (lines.length > 0 && BLANK_RE.test(lines[0]!)) lines.shift();
  dropBlankEnd(lines);
  // The last line's CR belonged to the line break before the trailer.
  const text = lines.join("\n").replace(/\r$/, "");
  return { text, cleaned: true, ...(usage ? { usage } : {}), ...(cliAgentId ? { cliAgentId } : {}) };
}

/** One Agent / Task call (or §36.3 continuation) as `agent_report` reads it from memory. */
export type KeptAgentCall = {
  /** The instructions (Agent `prompt` / SendMessage `message`), ≤ AGENT_REPORT_KEPT_CHARS; null when unknown. */
  prompt: string | null;
  model: string | null;
  /** Once the call's result arrived: the kept report (null: an error result or no text) and its `<usage>`. */
  result?: { text: string | null; truncated: boolean; usage: AgentUsage | null };
};

/**
 * §36.1: the reports of this engine's agent calls (`agent_report` asks here before the transcript): oldest entries are
 * evicted beyond `maxEntries` or `maxChars` in total.
 */
export class AgentReportStore {
  private readonly items = new Map<string, KeptAgentCall>();
  private chars = 0;

  constructor(
    private readonly maxEntries = 200,
    private readonly maxChars = 4_000_000,
  ) {}

  get(toolUseId: string): KeptAgentCall | undefined {
    return this.items.get(toolUseId);
  }

  /**
   * What the call was told and on which model. `authoritative` (the call's own tool_use) overrides what an earlier note
   * (`task_started.prompt`) said; otherwise a note only fills what is still unknown.
   */
  noteCall(toolUseId: string, prompt: string | null, model: string | null, authoritative = false): void {
    const old = this.items.get(toolUseId);
    const entry: KeptAgentCall = authoritative
      ? { prompt: prompt ?? old?.prompt ?? null, model }
      : { prompt: old?.prompt ?? prompt, model: old?.model ?? model };
    this.put(toolUseId, old?.result ? { ...entry, result: old.result } : entry);
  }

  noteResult(toolUseId: string, result: NonNullable<KeptAgentCall["result"]>): void {
    const old = this.items.get(toolUseId);
    this.put(toolUseId, { prompt: old?.prompt ?? null, model: old?.model ?? null, result });
  }

  private put(toolUseId: string, entry: KeptAgentCall): void {
    const old = this.items.get(toolUseId);
    if (old) {
      this.items.delete(toolUseId);
      this.chars -= sizeOf(old);
    }
    this.items.set(toolUseId, entry);
    this.chars += sizeOf(entry);
    for (const [id, e] of this.items) {
      if ((this.items.size <= this.maxEntries && this.chars <= this.maxChars) || id === toolUseId) break;
      this.items.delete(id);
      this.chars -= sizeOf(e);
    }
  }
}

function sizeOf(e: KeptAgentCall): number {
  return (e.prompt?.length ?? 0) + (e.result?.text?.length ?? 0);
}

/**
 * §36.1 `agent_report` from a chat's transcript rows (after a restart): the tool_use row gives `prompt` / `model`, the
 * result row the rest — its kept `report`, or for a row from before §36 its preview, cleaned. A §36.3 SendMessage
 * continuation (a row with `continues`) answers with its own report; `prompt` is its message, `model` the agent's.
 */
export function agentReportFromRows(toolUseId: string, rows: readonly TranscriptItem[]): AgentReportEvent | "unknown_agent" | "no_report" {
  let call: Extract<TranscriptItem, { kind: "tool_use" }> | undefined;
  let result: Extract<TranscriptItem, { kind: "tool_result" }> | undefined;
  for (const r of rows) {
    if (r.kind === "tool_use" && r.id === toolUseId) call = r;
    else if (r.kind === "tool_result" && r.toolUseId === toolUseId) result = r;
  }
  if (!call) return "unknown_agent";
  const isAgent = SUBAGENT_TOOL_RE.test(call.name);
  const continues = call.name === "SendMessage" ? call.continues : undefined;
  if (!isAgent && !continues) return "unknown_agent";
  const prompt = nonEmpty(isAgent ? call.input.prompt : call.input.message)?.slice(0, AGENT_REPORT_KEPT_CHARS) ?? null;
  const spawn = continues ? rows.find((r): r is Extract<TranscriptItem, { kind: "tool_use" }> => r.kind === "tool_use" && r.id === continues.agentToolUseId) : call;
  const model = nonEmpty(spawn?.input.model) ?? null;
  if (!result || result.isError) return "no_report";
  const text = result.report ?? cleanAgentReport(result.preview, { jsonLead: !isAgent }).text;
  if (!text.trim()) return "no_report";
  const truncated = result.report !== undefined ? result.reportTruncated === true : result.truncated === true;
  return { type: "agent_report", toolUseId, text, truncated, usage: result.agentUsage ?? null, model, prompt };
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** §36.1: the transcript row's `report` / `reportTruncated` for a kept report. */
export function reportRowFields(kept: { text: string; truncated: boolean } | undefined): { report?: string; reportTruncated?: true } {
  if (!kept) return {};
  return kept.truncated ? { report: kept.text, reportTruncated: true } : { report: kept.text };
}

/** §36.1: `transcript_restore` leaves the kept reports out of the rows (restores stay small; `agent_report` reads them). */
export function withoutReports(ev: TranscriptRestoreEvent): TranscriptRestoreEvent {
  if (!ev.items.some((r) => r.kind === "tool_result" && (r.report !== undefined || r.reportTruncated !== undefined))) return ev;
  return {
    ...ev,
    items: ev.items.map((r) => {
      if (r.kind !== "tool_result" || (r.report === undefined && r.reportTruncated === undefined)) return r;
      const { report: _report, reportTruncated: _truncated, ...rest } = r;
      return rest;
    }),
  };
}

function dropBlankEnd(lines: string[]): void {
  while (lines.length > 0 && BLANK_RE.test(lines[lines.length - 1]!)) lines.pop();
}

/** `subagent_tokens` (or `total_tokens`), `tool_uses`, `duration_ms`; undefined unless all three are there. */
function parseUsage(block: string): AgentUsage | undefined {
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(block);
    return m ? Number(m[1]) : undefined;
  };
  const tokens = num(/\bsubagent_tokens\s*[:=]\s*(\d+)/) ?? num(/\btotal_tokens\s*[:=]\s*(\d+)/);
  const toolUses = num(/\btool_uses\s*[:=]\s*(\d+)/);
  const durationMs = num(/\bduration_ms\s*[:=]\s*(\d+)/);
  return tokens !== undefined && toolUses !== undefined && durationMs !== undefined ? { tokens, toolUses, durationMs } : undefined;
}
