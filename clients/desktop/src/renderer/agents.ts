/**
 * Shared helpers for subagent views (Transcript nesting, AgentPanel, diff → cause): the transcript
 * index (tool rows by id, results, children per parent), agent status labels / tones, the tick hook.
 */
import { useEffect, useState } from "react";
import type { AgentNode, AgentStatus, ChangedFileState } from "@reviewgate/engine";
import { t } from "./i18n";
import { relativeToRoot } from "./paths";
import { formatElapsed } from "./elapsed";
import type { ChatItem } from "./store";

export type ToolUseItem = Extract<ChatItem, { kind: "toolUse" }>;
export type ToolResultItem = Extract<ChatItem, { kind: "toolResult" }>;

export const isAgentTool = (name: string): boolean => name === "Agent" || name === "Task";
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export type TranscriptIndex = {
  uses: Map<string, ToolUseItem>;
  results: Map<string, ToolResultItem>;
  /** Rows (tool use + result) that ran under an Agent/Task call, keyed by that call's id, in order. */
  children: Map<string, ChatItem[]>;
  /** The rows shown at the top level (everything whose parent call is not in the transcript). */
  top: ChatItem[];
};

const parentOf = (item: ChatItem): string | undefined =>
  item.kind === "toolUse" || item.kind === "toolResult" ? item.parentToolUseId : undefined;

export function indexTranscript(items: ChatItem[]): TranscriptIndex {
  const uses = new Map<string, ToolUseItem>();
  const results = new Map<string, ToolResultItem>();
  for (const it of items) {
    if (it.kind === "toolUse") uses.set(it.toolUseId, it);
    else if (it.kind === "toolResult") results.set(it.toolUseId, it);
  }
  const children = new Map<string, ChatItem[]>();
  const top: ChatItem[] = [];
  for (const it of items) {
    const parent = parentOf(it);
    if (parent && uses.has(parent) && parent !== (it.kind === "toolUse" ? it.toolUseId : undefined)) {
      const list = children.get(parent);
      if (list) list.push(it);
      else children.set(parent, [it]);
    } else top.push(it);
  }
  return { uses, results, children, top };
}

/** Every tool_use id nested (at any depth) under `id`. */
export function descendantIds(index: TranscriptIndex, id: string, out = new Set<string>()): Set<string> {
  for (const c of index.children.get(id) ?? []) {
    if (c.kind !== "toolUse" || out.has(c.toolUseId)) continue;
    out.add(c.toolUseId);
    descendantIds(index, c.toolUseId, out);
  }
  return out;
}

/** Number of tool calls (not results) nested under `id`, at any depth. */
export function nestedCallCount(index: TranscriptIndex, id: string): number {
  return descendantIds(index, id).size;
}

/** The transcript's view of an agent when `hud.agents` no longer lists it (older engine / dropped at the next turn). */
export function derivedStatus(result: ToolResultItem | undefined, running: boolean): AgentStatus {
  if (result) return result.isError ? "failed" : "completed";
  return running ? "running" : "stopped";
}

export const isLive = (s: AgentStatus): boolean => s === "running" || s === "pending" || s === "paused";

export function statusLabel(s: AgentStatus): string {
  switch (s) {
    case "pending":
      return t("Pending");
    case "running":
      return t("Running");
    case "paused":
      return t("Paused");
    case "completed":
      return t("Completed");
    case "failed":
      return t("Failed");
    case "stopped":
      return t("Stopped");
  }
}

/** CSS tone class (`.agent-chip.<tone>`, timeline bars). */
export function statusTone(s: AgentStatus): "blue" | "green" | "red" | "gray" | "amber" {
  switch (s) {
    case "running":
    case "pending":
      return "blue";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "paused":
      return "amber";
    case "stopped":
      return "gray";
  }
}

/** `950` ms → `0.9s`, `75_000` → `1m 15s`, `3_725_000` → `1h 02m` ("1분 15초" in Korean: `formatElapsed`). */
export function formatDuration(ms: number): string {
  return formatElapsed(ms / 1000);
}

export function agentElapsed(a: AgentNode, now: number): number {
  if (a.endedAt) return a.endedAt - a.startedAt;
  if (isLive(a.status)) return now - a.startedAt;
  return a.durationMs ?? 0;
}

/** `Date.now()` that re-renders every `ms` while `active`. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** Changed files a tool call touched (`ChangedFile.toolUseIds`; an older engine without the field → by `file`). */
export function filesForToolUse(files: ChangedFileState[], toolUseId: string, file: string | undefined, root: string | null | undefined): ChangedFileState[] {
  const hit = files.filter((f) => (f.toolUseIds ?? []).includes(toolUseId));
  if (hit.length > 0 || !file) return hit;
  const rel = relativeToRoot(file, root) ?? file.replace(/\\/g, "/");
  return files.filter((f) => f.path === rel);
}

/** `agent.type` without the plugin prefix (`oh-my-claudecode:executor` → `executor`). */
export function agentTypeLabel(type: string): string {
  const i = type.lastIndexOf(":");
  return i >= 0 ? type.slice(i + 1) : type;
}
