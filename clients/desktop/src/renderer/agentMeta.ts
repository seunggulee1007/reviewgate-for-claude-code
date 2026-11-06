/**
 * MARK: wave3 desktop-agents — the §36 fields a tool row keeps (docs/PROTOCOL.md §36.1–36.3): a SendMessage call that
 * continues a known subagent (`tool_use.continues`) and an Agent / Task result's parsed `<usage>` block, `agentId:` line and
 * `stoppedBy`. Read leniently (known shapes only), from the live events and the restored transcript rows alike: an engine
 * before §36 sends none of them and the rows look as they did. No imports beyond types: store.ts uses it.
 */
import type { AgentContinuation, AgentStoppedBy, AgentUsage } from "@reviewgate/engine";

export type AgentUseMeta = { continues?: AgentContinuation };
export type AgentResultMeta = {
  agentUsage?: AgentUsage;
  cliAgentId?: string;
  stoppedBy?: AgentStoppedBy;
  /** §52.2: the call's agent went to work in the background — no report (its own result comes when it ends). */
  agentLaunched?: true;
  /** §52.2: that agent's own result when it ended (the call's last result; `preview` is its report). */
  agentEnded?: true;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** `tool_use` (event or row) → `continues` when it names the Agent call and its type. */
export function agentUseMetaOf(ev: { continues?: unknown }): AgentUseMeta {
  const c = ev.continues;
  if (!isObject(c) || !text(c["agentToolUseId"]) || !text(c["agentType"])) return {};
  return { continues: { agentToolUseId: c["agentToolUseId"], agentType: c["agentType"] } };
}

/** `tool_result` (event or row) → `agentUsage` (all three numbers), `cliAgentId`, `stoppedBy: "user"`, §52.2's flags. */
export function agentResultMetaOf(ev: { agentUsage?: unknown; cliAgentId?: unknown; stoppedBy?: unknown; agentLaunched?: unknown; agentEnded?: unknown }): AgentResultMeta {
  const out: AgentResultMeta = {};
  const u = ev.agentUsage;
  if (isObject(u) && count(u["tokens"]) && count(u["toolUses"]) && count(u["durationMs"])) out.agentUsage = { tokens: u["tokens"], toolUses: u["toolUses"], durationMs: u["durationMs"] };
  if (text(ev.cliAgentId)) out.cliAgentId = ev.cliAgentId;
  if (ev.stoppedBy === "user") out.stoppedBy = "user";
  if (ev.agentLaunched === true) out.agentLaunched = true;
  if (ev.agentEnded === true) out.agentEnded = true;
  return out;
}

/** §52.2: an Agent call's result as shown: "launched in the background" is none (the agent's own comes when it ends). */
export function shownAgentResult<T extends AgentResultMeta>(result: T | undefined): T | undefined {
  return result?.agentLaunched ? undefined : result;
}
