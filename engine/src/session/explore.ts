import type { TranscriptItem } from "../protocol.js";
import { isReadOnlyCommand } from "./bashClass.js";

/**
 * MARK: wave4b w4b-tabs — docs/PROTOCOL.md §39.2: an exploration call — one that only reads or searches (Read, Glob,
 * Grep, LS, a read-only Bash command, an MCP lookup). The engine marks its `tool_use` event and transcript row
 * `explore: true`; both clients fold a run of them into one "탐색: …" row. Display only: nothing here allows, denies or
 * skips a call (the permission hooks keep their own rules).
 */

/** Built-in tools that only read or search. */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "ListMcpResourcesTool", "ReadMcpResourceTool"]);

/** The verb an MCP lookup's tool name starts with (`mcp__elasticsearch__search`, `mcp__filesystem__read_file`). */
const MCP_LOOKUP_RE = /^(get|list|search|read|query|find|fetch|describe|show|lookup|view|resolve)(?:[-_]|$)/i;

/** The tool part of an MCP tool name (`mcp__<server>__<tool>`); null for any other name. */
export function mcpToolPart(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  return parts.length >= 3 && parts[parts.length - 1] ? parts[parts.length - 1]! : null;
}

/**
 * Whether a call only explores: a read-only built-in tool, a Bash command the read-only classifier accepts (never one in
 * the background) or an MCP tool whose name starts with a lookup verb. A false negative only shows the row unfolded.
 */
export function isExploreCall(name: string, input: Record<string, unknown>): boolean {
  if (EXPLORE_TOOLS.has(name)) return true;
  if (name === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return command.trim() !== "" && input.run_in_background !== true && isReadOnlyCommand(command);
  }
  const tool = mcpToolPart(name);
  return tool !== null && MCP_LOOKUP_RE.test(tool);
}

/**
 * Rows saved before the mark existed: a `tool_use` row without `explore` gets it when the call explores (for
 * `transcript_restore` / `transcript_page`; the file is not rewritten). Every other row is returned as it was.
 */
export function markExplore(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((r) => {
    if (r.kind !== "tool_use" || r.explore !== undefined || !r.input || typeof r.input !== "object") return r;
    return isExploreCall(r.name, r.input) ? { ...r, explore: true as const } : r;
  });
}
