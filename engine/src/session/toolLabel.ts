/**
 * MARK: wave4b w4b-agents — §39.3: how an MCP or Skill call reads ("dooray · get posts · 4821", "스킬 acme-tools:smoke")
 * instead of its raw name with an empty detail. One rule on three sides — this file (the engine's step detail), Electron's
 * `renderer/toolLabel.ts` and the Mac's `ToolLabel` (Core `AgentGlance.swift`) — checked against `engine/test/fixtures/toolLabels.json`.
 */

export type ToolLabel = {
  /** `mcp`: `mcp__<server>__<tool>`; `skill`: the Skill tool; `tool`: anything else (shown as before). */
  kind: "mcp" | "skill" | "tool";
  /** mcp: the tool without the server's prefix, `_` / `-` as spaces; skill: the skill's name ("" when none); tool: the raw name. */
  name: string;
  /** mcp: the server as configured. */
  server?: string;
  /** mcp: the representative argument; skill: its `args`. One line, at most 60 characters + "…". */
  arg?: string;
};

/** The input keys that say what an MCP call is about, most telling first. */
export const REPRESENTATIVE_KEYS = [
  "postNumber",
  "postId",
  "taskNumber",
  "issueNumber",
  "number",
  "query",
  "sql",
  "q",
  "index",
  "url",
  "path",
  "file_path",
  "name",
  "title",
  "id",
  "pattern",
  "command",
  "prompt",
] as const;

const MAX_ARG = 60;

/** Whitespace runs to one space, trimmed, cut at 60 characters with "…" (as `activityDetail`). */
export function oneLine(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > MAX_ARG ? s.slice(0, MAX_ARG) + "…" : s;
}

/** The first non-empty string (or finite number) among `REPRESENTATIVE_KEYS`. */
export function representativeArg(input: Record<string, unknown> | null | undefined): string | undefined {
  if (!input) return undefined;
  for (const k of REPRESENTATIVE_KEYS) {
    const v = input[k];
    if (typeof v === "string") {
      const s = oneLine(v);
      if (s) return s;
    } else if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

export function toolLabel(name: string, input?: Record<string, unknown> | null): ToolLabel {
  if (name === "Skill") {
    const skill = typeof input?.skill === "string" ? input.skill.trim() : "";
    const args = typeof input?.args === "string" ? oneLine(input.args) : "";
    return { kind: "skill", name: skill, ...(args ? { arg: args } : {}) };
  }
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.indexOf("__");
    const server = i > 0 ? rest.slice(0, i) : "";
    let tool = i > 0 ? rest.slice(i + 2) : "";
    if (server && tool) {
      if (tool.startsWith(server + "_") && tool.length > server.length + 1) tool = tool.slice(server.length + 1);
      const readable = tool.replace(/[_-]+/g, " ").trim();
      const arg = representativeArg(input);
      return { kind: "mcp", server, name: readable || tool, ...(arg ? { arg } : {}) };
    }
  }
  return { kind: "tool", name };
}
