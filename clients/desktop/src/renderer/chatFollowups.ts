/**
 * MARK: wave4 w4-check3
 * Two 0.2.3 follow-ups, word for word as on the Mac (Core `ChatFollowups.swift`):
 * - a side question about a subagent's call (the Agent details sheet's "Ask in a side thread") offers questions about the
 *   agent's work instead of the usual chips;
 * - the main chat's ReportFindings call (docs/PROTOCOL.md §36.13, `/code-review` reporting through the tool) reads as its
 *   findings in one line instead of an empty row whose only detail is the raw input in a tooltip.
 */
import type { AgentNode, SideAnchor } from "@reviewgate/engine";
import { t } from "./i18n";
import { quickQuestions } from "./sideThreads";

/** A subagent's call: `Agent`, or `Task` from older CLIs. */
export const isAgentTool = (name: string | null | undefined): boolean => name === "Agent" || name === "Task";

/** The questions about a subagent's work (the Mac's `SideQuestionText.agentSuggestions`). */
export function agentQuestions(): string[] {
  return [t("What did this agent change?"), t("Did this agent do what it was asked?"), t("What are the key points of this report, and what should I check?")];
}

/** The one-click questions under a new question: an agent's call gets `agentQuestions()`, anything else `quickQuestions()`. */
export function newQuestionChips(anchor: SideAnchor | null, toolName: string | undefined): string[] {
  if (anchor?.toolUseId && anchor.path === undefined && anchor.pr === undefined && isAgentTool(toolName)) return agentQuestions();
  return quickQuestions();
}

/** The anchored call's tool: its tool_use row in the chat, else a HUD agent card with that id (its row went with a restart). */
export function anchorToolName(
  anchor: SideAnchor | null,
  transcript: readonly { kind: string; toolUseId?: string; name?: string }[],
  agents: readonly Pick<AgentNode, "toolUseId">[],
): string | undefined {
  const id = anchor?.toolUseId;
  if (!id) return undefined;
  const row = transcript.find((item) => item.kind === "toolUse" && item.toolUseId === id);
  if (row?.name) return row.name;
  return agents.some((a) => a.toolUseId === id) ? "Agent" : undefined;
}

/**
 * §36.13: a `ReportFindings` call's input (`{level, findings: [{file, line, summary, …}]}`) in one line — "3 findings ·
 * Svc.java:42, app.ts" (each file's last path component and its first finding's line; up to three, then "+N"); "No
 * findings" for an empty list; null when the input has no findings list.
 */
export function reportFindingsLine(input: Record<string, unknown>): string | null {
  const list = input.findings;
  if (!Array.isArray(list)) return null;
  const findings = list.filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && !Array.isArray(f));
  if (findings.length === 0) return t("No findings");
  const places: string[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    const file = typeof f.file === "string" ? f.file.trim() : "";
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const name = file.replace(/\\/g, "/").split("/").filter((s) => s.length > 0).pop() ?? file;
    const line = f.line;
    places.push(typeof line === "number" && Number.isFinite(line) && line >= 1 ? `${name}:${Math.trunc(line)}` : name);
  }
  const count = t("{0} findings", findings.length);
  if (places.length === 0) return count;
  const shown = places.slice(0, 3).join(", ");
  return places.length > 3 ? `${count} · ${shown} +${places.length - 3}` : `${count} · ${shown}`;
}
