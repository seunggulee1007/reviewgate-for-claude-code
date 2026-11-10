/**
 * Find in the transcript (Ctrl/⌘F) — the data side (pure, unit-tested): which rows match, which collapsed agent
 * groups must open and which tool results must unfold so the DOM highlighter (Transcript.tsx, CSS Custom
 * Highlight API) can reach every hit. Searches user / assistant text, tool inputs and tool output previews.
 */
import type { ChatItem } from "./store";

const MAX_INPUT_TEXT = 20_000;

function inputText(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const v of Object.values(input)) {
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
  }
  return parts.join("\n").slice(0, MAX_INPUT_TEXT);
}

/** The searchable text of one row (empty for rows without text). */
export function itemText(item: ChatItem): string {
  switch (item.kind) {
    case "user":
    case "assistant":
      return item.text;
    case "toolUse":
      return `${item.name}\n${item.file ?? ""}\n${inputText(item.input)}\n${item.rationale ?? ""}`;
    case "toolResult":
      return item.preview;
    case "permission":
      return `${item.request.toolName}\n${item.request.file ?? ""}\n${inputText(item.request.input)}`;
    case "error":
      return item.message;
    case "peer":
      return item.body ?? "";
    case "turnEnd":
      return item.summary;
    case "planProposed":
      return item.plan;
    default:
      return "";
  }
}

/** Case-insensitive start offsets of `query` in `text` (non-overlapping). */
export function matchOffsets(text: string, query: string): number[] {
  const q = query.toLocaleLowerCase();
  if (q.length === 0) return [];
  const hay = text.toLocaleLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) out.push(i);
  return out;
}

export type FindPlan = {
  /** Row ids with at least one hit, in transcript order. */
  rows: number[];
  /** Agent/Task `toolUseId`s whose group must be open (an ancestor of a hit, or the agent's own report matched). */
  expand: string[];
  /** `toolUseId`s whose result `<details>` must be open (the preview matched). */
  openResults: string[];
};

export const EMPTY_FIND: FindPlan = { rows: [], expand: [], openResults: [] };

export function planFind(items: ChatItem[], query: string, isAgentTool: (name: string) => boolean): FindPlan {
  if (query.trim().length === 0) return EMPTY_FIND;
  const parent = new Map<string, string | undefined>();
  const agentIds = new Set<string>();
  for (const it of items) {
    if (it.kind === "toolUse") {
      parent.set(it.toolUseId, it.parentToolUseId);
      if (isAgentTool(it.name)) agentIds.add(it.toolUseId);
    }
  }
  const rows: number[] = [];
  const expand = new Set<string>();
  const openResults = new Set<string>();
  const openAncestors = (start: string | undefined) => {
    for (let p = start, guard = 0; p && guard < 64; p = parent.get(p), guard++) if (agentIds.has(p)) expand.add(p);
  };
  for (const it of items) {
    if (matchOffsets(itemText(it), query).length === 0) continue;
    rows.push(it.id);
    if (it.kind === "toolUse") openAncestors(it.parentToolUseId);
    if (it.kind === "toolResult") {
      openResults.add(it.toolUseId);
      // An agent's own report sits inside its group; any other result sits next to its call.
      openAncestors(agentIds.has(it.toolUseId) ? it.toolUseId : it.parentToolUseId);
    }
  }
  return { rows, expand: [...expand], openResults: [...openResults] };
}

/** Next / previous hit index with wrap-around (-1 when there are none). */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}
