/**
 * MARK: wave3 desktop-agents — the pure part of the agent screens (docs/PROTOCOL.md §36.1–36.4, the §36.10 chip): one view
 * of a subagent merged from its live node (`hud.agents`) and its transcript rows (the Agent call and its result — what is
 * left after the next turn dropped the node, and all an engine before §36 gives), the model chip, the words for a stopped /
 * continued agent, the composer's "main is waiting" line, refusals, the side thread's running-turn chip and the one OS
 * notification per turn when the subagents the main turn waited on have all finished. Unit-tested (agentDetails.test.ts).
 */
import type { AgentContinuation, AgentNode, AgentStatus, ReviewState, SideFork, WaitingOnAgents } from "@reviewgate/engine";
import type { NotifyRequest } from "../shared/ipc";
import { agentTypeLabel, derivedStatus, formatDuration, isLive, statusLabel, type ToolResultItem, type ToolUseItem } from "./agents";
import { t } from "./i18n";
import type { ChatItem } from "./store";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The first non-empty line, markdown markers off, cut at `max`. */
export function firstLine(s: string, max = 120): string {
  const line = s.split(/\r?\n/).map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

// ---------------------------------------------------------------- model chip

export type ModelTone = "purple" | "blue" | "green" | "gray";

/** opus purple, sonnet blue, haiku green, anything else gray (also a full model id: `claude-opus-4-5-…`). */
export function modelTone(model: string): ModelTone {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "purple";
  if (m.includes("sonnet")) return "blue";
  if (m.includes("haiku")) return "green";
  return "gray";
}

/**
 * The chip's text, as the Mac's `AgentModelText.label` (wave4d w4d-agents2: was `sonnet-4-5`): `opus` → "opus",
 * `claude-opus-4-1-20250805` → "opus 4.1", `claude-3-5-haiku-20241022` → "haiku 3.5", `claude-sonnet-4-5[1m]` → "sonnet 4.5";
 * a name without a known family stays as it is.
 */
export function modelLabel(model: string): string {
  let m = model.trim().toLowerCase();
  const bracket = m.indexOf("[");
  if (bracket >= 0) m = m.slice(0, bracket);
  if (m.startsWith("claude-")) m = m.slice("claude-".length);
  const parts = m.split("-");
  if (parts.length > 0 && /^\d{8}$/.test(parts[parts.length - 1]!)) parts.pop();
  const name = parts.find((p) => p === "opus" || p === "sonnet" || p === "haiku");
  if (!name) return model;
  const version = parts.filter((p) => p.length > 0 && /^\d+$/.test(p)).join(".");
  return version ? `${name} ${version}` : name;
}

// ---------------------------------------------------------------- one agent

export type AgentUsageView = { tokens?: number; toolUses?: number; durationMs?: number };

export type AgentView = {
  toolUseId: string;
  /** `subagent_type` as named (plugin prefix kept) and without it. */
  type: string;
  label: string;
  description: string;
  /** The instructions: the longer of the node's (≤ 8 000 chars) and the Agent call's input; "" when unknown. */
  prompt: string;
  /** null: none named (the agent definition's or the default model). */
  model: string | null;
  status: AgentStatus;
  live: boolean;
  /** §36.2 `stoppedBy: "user"` (node or result row). */
  stoppedByUser: boolean;
  /** §36.3: SendMessage continuations so far (0 = never continued). */
  resumeCount: number;
  isBackground: boolean;
  /** The node's numbers, else the result's parsed `<usage>`; null when nothing is known. */
  usage: AgentUsageView | null;
  /** The cleaned report's start (§36) — or an older engine's raw preview; "" before the result. */
  reportPreview: string;
  /** The engine keeps the whole cleaned report (`agent_report` answers): a §36 result that is not a stop. */
  reportKept: boolean;
  cliAgentId: string | null;
  files: string[];
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  summary: string | null;
  node: AgentNode | undefined;
};

/**
 * `node`: the live `hud.agents` entry (absent after the next turn dropped it, or never listed by an older engine);
 * `use` / `result`: the transcript rows; `running`: a turn runs (an unlisted agent without a result counts as running);
 * `continuations`: SendMessage rows that continue it (the resume count once the node is gone).
 */
export function agentViewOf(args: { node?: AgentNode; use?: ToolUseItem; result?: ToolResultItem; running: boolean; continuations: number }): AgentView {
  const { node, use, result } = args;
  const input = use?.input ?? {};
  const type = node?.type ?? (str(input["subagent_type"]) || "general-purpose");
  const inputPrompt = str(input["prompt"]);
  const nodePrompt = node?.prompt ?? "";
  // wave4d w4d-agents2 (§42.4): the model it ran on first, then the one its call named.
  const model = node?.apiModel || (node && node.model !== undefined ? node.model : str(input["model"]) || null);
  const stoppedByUser = node?.stoppedBy === "user" || result?.stoppedBy === "user";
  const status: AgentStatus = node?.status ?? (result?.stoppedBy === "user" ? "stopped" : derivedStatus(result, args.running));
  const usage: AgentUsageView = {};
  const tokens = node?.tokens ?? result?.agentUsage?.tokens;
  const toolUses = node?.toolUses ?? result?.agentUsage?.toolUses;
  const durationMs = node?.durationMs ?? result?.agentUsage?.durationMs;
  if (tokens !== undefined) usage.tokens = tokens;
  if (toolUses !== undefined) usage.toolUses = toolUses;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  const cleaned = result !== undefined && (result.agentUsage !== undefined || result.cliAgentId !== undefined || node?.reportPreview !== undefined);
  return {
    toolUseId: node?.toolUseId ?? use?.toolUseId ?? result?.toolUseId ?? "",
    type,
    label: agentTypeLabel(type),
    description: node?.description ?? str(input["description"]),
    prompt: inputPrompt.length > nodePrompt.length ? inputPrompt : nodePrompt,
    model,
    status,
    live: isLive(status),
    stoppedByUser,
    // The live node counts real resumes (a message to an agent still running resumes nothing); the rows once it is gone.
    resumeCount: node ? (node.resumeCount ?? 0) : args.continuations,
    isBackground: node?.isBackground ?? false,
    usage: Object.keys(usage).length > 0 ? usage : null,
    reportPreview: node?.reportPreview ?? result?.preview ?? "",
    reportKept: cleaned && !stoppedByUser,
    cliAgentId: node?.cliAgentId ?? result?.cliAgentId ?? null,
    files: node?.files ?? [],
    startedAt: node?.startedAt ?? null,
    endedAt: node?.endedAt ?? null,
    error: node?.error ?? null,
    summary: node?.summary ?? null,
    node,
  };
}

/** The status chip's words: "사용자가 중지" for an agent the user stopped (§36.2), else the status. */
export function statusText(v: Pick<AgentView, "status" | "stoppedByUser">): string {
  return v.status === "stopped" && v.stoppedByUser ? t("Stopped by you") : statusLabel(v.status);
}

/** §36.3 "재개됨(N회차)" — N = `resumeCount` + 1; null for an agent never continued. */
export function resumedLabel(resumeCount: number): string | null {
  return resumeCount > 0 ? t("Resumed (run {0})", resumeCount + 1) : null;
}

/** §36.3: SendMessage rows per Agent call they continue (`tool_use.continues`) — the resume count once the node is gone. */
export function continuationCounts(items: readonly ChatItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== "toolUse" || !it.continues) continue;
    const id = it.continues.agentToolUseId;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** §36.3: the subagent of this session a SendMessage `to` names (its `agentId:` or its task id), else null. */
export function continuedAgentOf(agents: readonly AgentNode[], to: string): AgentNode | null {
  if (!to) return null;
  return agents.find((a) => a.cliAgentId === to || (a.id === to && a.id !== a.toolUseId)) ?? null;
}

/** The SendMessage card's line for a message that continues a subagent of this session (§36.3). */
export function continuesAgentText(agent: Pick<AgentNode, "type">): string {
  return t("This continues the subagent {0} — it works again under its original group", agentTypeLabel(agent.type));
}

/** §36.3 the SendMessage row: "executor에게 이어서: <the message's first line>". */
export function continueText(c: AgentContinuation, input: Record<string, unknown>): string {
  const line = firstLine(str(input["message"])) || firstLine(str(input["summary"]));
  return t("Continue {0}: {1}", agentTypeLabel(c.agentType), line);
}

// ---------------------------------------------------------------- §36.4 waiting

/** `hud.waitingOnAgents` when it is whole (an engine before §36 sends nothing). */
export function waitingOf(hud: { waitingOnAgents?: unknown }): WaitingOnAgents | null {
  const w = hud.waitingOnAgents;
  if (typeof w !== "object" || w === null) return null;
  const { count, longest } = w as { count?: unknown; longest?: unknown };
  if (typeof count !== "number" || !(count >= 1) || typeof longest !== "object" || longest === null) return null;
  const l = longest as { toolUseId?: unknown; type?: unknown; startedAt?: unknown };
  if (typeof l.toolUseId !== "string" || typeof l.type !== "string" || typeof l.startedAt !== "number" || !Number.isFinite(l.startedAt)) return null;
  return { count, longest: { toolUseId: l.toolUseId, type: l.type, startedAt: l.startedAt } };
}

/** "메인은 서브에이전트 2개를 기다리는 중 · executor 4m 12s" (the one running longest, its current run). */
export function waitingText(w: WaitingOnAgents, now: number): string {
  return t("Main is waiting for {0} subagents · {1} {2}", w.count, agentTypeLabel(w.longest.type), formatDuration(now - w.longest.startedAt));
}

// ---------------------------------------------------------------- §36.2 stop / §36.1 report refusals

/**
 * Why ■ is off, or null: only a live agent with a task id (`id` is the spawning tool_use id until `task_started`, and
 * forever with a CLI without task messages); `unsupported` = this engine refused `stop_agent` as an unknown command.
 */
export function stopBlockedReason(node: AgentNode | undefined, unsupported: boolean): string | null {
  if (!node || !isLive(node.status)) return t("This agent has already finished");
  if (unsupported) return t("This engine cannot stop one agent — update ReviewGate");
  if (node.id === node.toolUseId) return t("This agent cannot be stopped on its own yet — Claude Code has not reported its task id");
  return null;
}

/** A refused `stop_agent` / `agent_report` in words (`fallback`: the generic §19.6 text). */
export function agentRefusalText(cmd: "stop_agent" | "agent_report", code: string, fallback: string): string {
  switch (code) {
    case "not_running":
      return t("This agent has already finished");
    case "not_supported":
      return t("This Claude Code cannot stop one agent on its own — stop the whole turn instead");
    case "unknown_agent":
      return t("ReviewGate could not find this agent in this chat");
    case "no_report":
      return t("No report yet — the agent is still running or reported no text");
    case "unknown_command":
      return cmd === "stop_agent" ? t("This engine cannot stop one agent — update ReviewGate") : t("This engine does not keep agent reports — update ReviewGate");
    default:
      return fallback;
  }
}

/** A markdown report as plain lines for a small card (headings, list / quote markers, emphasis and table rules off). */
export function plainPreview(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s?|\d+[.)]\s+)/, "")
        .replace(/\*\*|__|`/g, "")
        .trim(),
    )
    .filter((l) => l.length > 0 && !/^\|?\s*:?-{3,}/.test(l))
    .join("\n");
}

/** "메인으로 보내기": the report as a quote with its agent named, a blank line after it for the user's own words. */
export function reportQuote(label: string, description: string, report: string): string {
  const head = `${t("Agent report")} · ${label}${description ? ` — ${description}` : ""}`;
  const body = report
    .replace(/\r\n?/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => (l.length > 0 ? `> ${l}` : ">"))
    .join("\n");
  return `> **${head}**\n>\n${body}\n\n`;
}

// ---------------------------------------------------------------- §36.10 side threads

/** `fork.runningTurn` when it is a turn number (an engine before §36 sends none). */
export function runningTurnOf(fork: SideFork | null | undefined): number | null {
  const n = fork?.runningTurn;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The thread head chip "턴 N 진행 중 — 요약만 전달됨", or null. */
export function runningTurnChip(fork: SideFork | null | undefined): string | null {
  const n = runningTurnOf(fork);
  return n === null ? null : t("Turn {0} in progress — only a summary was shared", n);
}

/** The chip's tooltip: what the side thread got. */
export function runningTurnHelp(fork: SideFork | null | undefined): string {
  const n = runningTurnOf(fork);
  if (n === null) return "";
  const at = fork?.atTurn;
  return typeof at === "number"
    ? t("Asked while turn {0} was running: this thread has the conversation up to turn {1} and only a summary of turn {0} — its request, the latest text and the tool calls so far.", n, at)
    : t("Asked while turn {0} was running, before any turn had finished: this thread has only a summary of turn {0} — its request, the latest text and the tool calls so far.", n);
}

/** What a new question started now would know — said only while a turn runs (between turns the fork holds the whole chat). */
export function newQuestionHint(running: boolean): string | null {
  return running ? t("Claude is working — a new side question gets the conversation up to the last finished turn and a summary of the turn in progress.") : null;
}

// ---------------------------------------------------------------- §36.4 notification

/** The turn whose notification was sent (`hud.turnStartedAt`). */
export type AgentsDoneMemory = { turnStartedAt: number | null };

/**
 * "서브에이전트가 모두 끝났어요 — Claude가 이어서 작업 중": the main turn stopped waiting on subagents and goes on, the window
 * is in the background, and this turn has not had one yet. A turn that ended with its agents has its own notification.
 */
export function agentsDoneNotification(prev: ReviewState, next: ReviewState, memory: AgentsDoneMemory, ctx: { project: string | null; focused: boolean }): NotifyRequest | null {
  if (!waitingOf(prev.hud) || waitingOf(next.hud) || next.gate.phase !== "running" || ctx.focused) return null;
  const turn = next.hud.turnStartedAt ?? prev.hud.turnStartedAt;
  if (turn === null || memory.turnStartedAt === turn) return null;
  memory.turnStartedAt = turn;
  const title = ctx.project ? `ReviewGate — ${ctx.project}` : "ReviewGate";
  return { kind: "agents_done", title, body: t("Subagents finished — Claude is continuing"), key: `agents:${turn}` };
}
