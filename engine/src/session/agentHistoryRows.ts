/**
 * MARK: wave4d w4d-agents2 — docs/PROTOCOL.md §42.4: `hud.agentHistory` after an engine restart. §39.3 kept the finished
 * agents of earlier turns in memory only; the chat's rows (§38.3 keeps them) already hold each Agent / Task call, its
 * result (`agentUsage`, `stoppedBy`, `cliAgentId`, the report's start) and the edits made under it, so the list is rebuilt
 * from them when a chat is opened. Nothing new is stored.
 */
import type { AgentNode, AgentStatus, TranscriptItem } from "../protocol.js";

const AGENT_TOOL_RE = /^(Agent|Task)$/;
const EDIT_TOOL_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
/** As `hud.agentHistory` keeps them (§39.3): the report's / summary's start and the file list, cut. */
const TEXT_CHARS = 200;
const FILES = 20;
const MAX = 50;

type ToolUseRow = Extract<TranscriptItem, { kind: "tool_use" }>;
type ToolResultRow = Extract<TranscriptItem, { kind: "tool_result" }>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const cut = (v: string) => (v.length > TEXT_CHARS ? v.slice(0, TEXT_CHARS - 1) + "…" : v);
const epoch = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/**
 * The finished subagents in `rows` (a chat's transcript rows, oldest first), newest first, at most 50. A call without a
 * result ended with the engine (`stopped`); a background agent (its result is only the launch) is left out — its end is
 * not in the rows. `displayPath` makes the edited files repo-relative, as the live tracker does.
 */
export function agentHistoryFromRows(rows: readonly TranscriptItem[], displayPath: (abs: string) => string): AgentNode[] {
  const calls: ToolUseRow[] = [];
  const results = new Map<string, ToolResultRow>();
  const parents = new Map<string, string | undefined>();
  const edits: ToolUseRow[] = [];
  for (const r of rows) {
    if (r.kind === "tool_use") {
      parents.set(r.id, r.parentToolUseId);
      if (AGENT_TOOL_RE.test(r.name)) calls.push(r);
      else if (EDIT_TOOL_RE.test(r.name) && r.file) edits.push(r);
    } else if (r.kind === "tool_result") results.set(r.toolUseId, r);
  }
  const agentIds = new Set(calls.map((c) => c.id));
  const files = new Map<string, string[]>();
  for (const e of edits) {
    const path = displayPath(e.file!);
    // The edit counts for the agent that made it and every agent above it (as the live tracker credits it).
    const seen = new Set<string>();
    for (let cur = e.parentToolUseId; cur && agentIds.has(cur) && !seen.has(cur); cur = parents.get(cur)) {
      seen.add(cur);
      const list = files.get(cur) ?? [];
      if (!list.includes(path)) list.push(path);
      files.set(cur, list);
    }
  }
  const depthOf = (id: string): number => {
    let depth = 1;
    const seen = new Set<string>([id]);
    for (let p = parents.get(id); p && agentIds.has(p) && !seen.has(p); p = parents.get(p)) {
      seen.add(p);
      depth += 1;
    }
    return depth;
  };
  const out: AgentNode[] = [];
  for (const c of calls) {
    const input = c.input ?? {};
    if (input.run_in_background === true) continue;
    const res = results.get(c.id);
    const status: AgentStatus = !res || res.stoppedBy === "user" ? "stopped" : res.isError ? "failed" : "completed";
    const parent = c.parentToolUseId && agentIds.has(c.parentToolUseId) ? c.parentToolUseId : undefined;
    const isolation = str(input.isolation);
    const node: AgentNode = {
      id: c.id,
      toolUseId: c.id,
      ...(parent ? { parentToolUseId: parent } : {}),
      type: str(input.subagent_type) ?? "general-purpose",
      description: str(input.description) ?? "",
      status,
      isBackground: false,
      depth: depthOf(c.id),
      startedAt: epoch(c.at),
      endedAt: res ? epoch(res.at) : epoch(c.at),
      files: (files.get(c.id) ?? []).slice(0, FILES),
      model: str(input.model) ?? null,
      turn: c.turn,
      ...(isolation ? { isolation } : {}),
    };
    if (res?.agentUsage) {
      node.tokens = res.agentUsage.tokens;
      node.toolUses = res.agentUsage.toolUses;
      node.durationMs = res.agentUsage.durationMs;
    }
    if (res?.cliAgentId) node.cliAgentId = res.cliAgentId;
    if (res?.stoppedBy === "user") node.stoppedBy = "user";
    if (res && status === "failed" && res.preview) node.error = cut(res.preview);
    if (res && status === "completed" && res.preview) node.reportPreview = cut(res.preview);
    out.push(node);
  }
  return out.reverse().slice(0, MAX);
}
