/**
 * MARK: wave3 desktop-agents — what the agent screens do (docs/PROTOCOL.md §36.1–36.4), kept apart from the main store:
 * `stop_agent` (one subagent; the ■ of every view shows the same request in flight, and an engine that does not know the
 * command keeps ■ off with the reason), `agent_report` (the whole cleaned report for the details sheet), opening the details
 * sheet (`dialog: agentDetail`, so the card / review shortcuts stay off while it is up), the "open this agent's chat group"
 * request of a SendMessage continuation row and the one "subagents finished" OS notification per turn.
 */
import { create } from "zustand";
import type { AgentReportEvent, ReviewState } from "@reviewgate/engine";
import type { NotifyRequest } from "../shared/ipc";
import { agentRefusalText, agentsDoneNotification, type AgentsDoneMemory } from "./agentDetails";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { lastComponent, useStore } from "./store";
import { showToast } from "./toast";

type AgentUiState = {
  /** `stop_agent` requests waiting for their reply, by the Agent call's id. */
  stopping: Record<string, true>;
  /** This engine refused `stop_agent` as an unknown command (before §36). */
  stopUnsupported: boolean;
  /** Agents the engine refused to stop on their own (`not_supported`), with the reason. */
  stopRefused: Record<string, string>;
  /** "Open the chat group of this agent" (a SendMessage continuation row was clicked); `nonce` repeats the same id. */
  expand: { toolUseId: string; nonce: number } | null;
};

export const useAgentUi = create<AgentUiState>(() => ({ stopping: {}, stopUnsupported: false, stopRefused: {}, expand: null }));

/** §36.2 `stop_agent`: the reply comes once `stopTask` returned; the node turns `stopped` by the next state. Refusals → a toast. */
export async function stopAgent(toolUseId: string, request: typeof engineRequest = engineRequest): Promise<string | null> {
  if (useAgentUi.getState().stopping[toolUseId]) return null;
  useAgentUi.setState((s) => ({ stopping: { ...s.stopping, [toolUseId]: true } }));
  try {
    await request({ type: "stop_agent", toolUseId });
    return null;
  } catch (e) {
    const r = refusalOf(e);
    const text = agentRefusalText("stop_agent", r.code, refusalMessage(r));
    if (r.code === "unknown_command") useAgentUi.setState({ stopUnsupported: true });
    else if (r.code === "not_supported") useAgentUi.setState((s) => ({ stopRefused: { ...s.stopRefused, [toolUseId]: text } }));
    showToast(text);
    return text;
  } finally {
    useAgentUi.setState((s) => {
      const { [toolUseId]: _done, ...stopping } = s.stopping;
      return { stopping };
    });
  }
}

/** §36.1 `agent_report` → the reply, or the refusal (`code` + the words for the sheet). */
export async function fetchAgentReport(
  toolUseId: string,
  request: typeof engineRequest = engineRequest,
): Promise<{ ok: true; report: AgentReportEvent } | { ok: false; code: string; message: string }> {
  try {
    return { ok: true, report: await request({ type: "agent_report", toolUseId }) };
  } catch (e) {
    const r = refusalOf(e);
    return { ok: false, code: r.code, message: agentRefusalText("agent_report", r.code, refusalMessage(r)) };
  }
}

/** Opens the details sheet of the agent the Agent / Task call `toolUseId` started (wave4d w4d-agents2: at its report / instructions). */
export function openAgentDetail(toolUseId: string, focus?: "report" | "instructions"): void {
  useStore.getState().openDialog({ kind: "agentDetail", toolUseId, ...(focus ? { focus } : {}) });
}

type StateStore = {
  subscribe(listener: (s: { state: ReviewState }, prev: { state: ReviewState }) => void): () => void;
};

/**
 * §36.4: one OS notification per turn — "서브에이전트가 모두 끝났어요 — Claude가 이어서 작업 중" — when the subagents the
 * main turn waited on have all finished while the window is in the background (main checks focus and the setting again).
 * Returns the unsubscribe.
 */
export function notifyWhenAgentsFinish(
  store: StateStore,
  deps: { focused: () => boolean; notify: (n: NotifyRequest) => Promise<unknown> | undefined } = {
    focused: () => typeof document === "undefined" || document.hasFocus(),
    notify: (n) => window.rg.notify?.(n),
  },
): () => void {
  const memory: AgentsDoneMemory = { turnStartedAt: null };
  return store.subscribe((s, prev) => {
    if (s.state === prev.state) return;
    const root = s.state.project?.root ?? null;
    const n = agentsDoneNotification(prev.state, s.state, memory, { project: root ? lastComponent(root) : null, focused: deps.focused() });
    if (n) void deps.notify(n)?.catch(() => undefined);
  });
}

/** Opens (and scrolls to) the chat group of the agent `toolUseId` — the SendMessage row of a continuation. */
export function revealAgentGroup(toolUseId: string): void {
  useAgentUi.setState((s) => ({ expand: { toolUseId, nonce: (s.expand?.nonce ?? 0) + 1 } }));
  const store = useStore.getState();
  if (store.tab === "prs") store.setTab("changes");
  store.revealToolUse(toolUseId);
}
