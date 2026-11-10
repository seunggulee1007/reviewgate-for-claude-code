/**
 * Subagent activity (docs/PROTOCOL.md §13): folds the SDK's task_* / tool_progress system messages and
 * the Agent/Task `tool_use` / `tool_result` pairs into `state.hud.agents`. The main agent is implicit.
 *
 * Primary source: `task_started` / `task_progress` / `task_updated` / `task_notification` (local_agent
 * tasks). Fallback for CLIs that send none of them: a node is created from the Agent/Task `tool_use` and
 * closed by its `tool_result`, exactly like the HUD's subagent_start / subagent_end.
 */
import type { AgentContinuation, AgentNode, AgentReportEvent, AgentStatus, AgentUsage, WaitingOnAgents } from "../protocol.js";
import { AGENT_PROMPT_CHARS, AGENT_REPORT_KEPT_CHARS, AGENT_REPORT_PREVIEW_CHARS, AgentReportStore } from "./agentReport.js";
// MARK: wave4b w4b-agents
import { activityDetail } from "./claude.js";

const SUBAGENT_TOOL_RE = /^(Agent|Task)$/;
/** Tools whose `file` counts as a file the agent changed (same set as the budget's edit tools). */
const EDIT_TOOL_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const LIVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["pending", "running", "paused"]);
/** §36.2: how long `stop_agent` waits for `query.stopTask` (the CLI answers in ~0.1 s). */
export const STOP_AGENT_TIMEOUT_MS = 5_000;
/** §36.3: finished agents remembered for a continuation (the oldest unlisted ones go first). */
const MAX_REMEMBERED_AGENTS = 200;
// MARK: wave4b w4b-agents
/** §39.3: finished agents of earlier turns kept in `hud.agentHistory`. */
export const AGENT_HISTORY_MAX = 50;
/** §39.3: a history entry's report / summary start and file list, cut (the snapshot carries all 50). */
const HISTORY_TEXT_CHARS = 200;
const HISTORY_FILES = 20;
/** §39.3: progress of the same call moves `activeAt` on the wire at most this often (clients warn after 2 minutes). */
const ACTIVE_REPORT_MS = 10_000;

type Usage = { tokens: number; toolUses: number; durationMs: number };

/** The SDK messages, normalized by claude.ts (no SDK types leak into the engine). */
export type AgentSignal =
  | {
      kind: "task_started";
      taskId: string;
      toolUseId?: string;
      description: string;
      subagentType?: string;
      taskType?: string;
      isBackground?: boolean;
      depth?: number;
      /** ambient / skip_transcript housekeeping tasks: never shown. */
      ambient?: boolean;
      /** §36.1: the task's instructions (the Agent call's `prompt` wins). */
      prompt?: string;
    }
  | { kind: "task_progress"; taskId: string; toolUseId?: string; description?: string; subagentType?: string; usage: Usage; lastTool?: string; summary?: string }
  | {
      kind: "task_updated";
      taskId: string;
      status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
      description?: string;
      endTime?: number;
      error?: string;
      isBackground?: boolean;
    }
  | { kind: "task_notification"; taskId: string; toolUseId?: string; status: "completed" | "failed" | "stopped"; summary?: string; usage?: Usage }
  | {
      kind: "tool_progress";
      toolUseId: string;
      toolName: string;
      parentToolUseId: string | null;
      taskId?: string;
      // MARK: wave4b w4b-agents — §39.3
      elapsedSeconds?: number;
      retry?: { attempt: number; max: number; status: number | null; agentId?: string };
    }
  // MARK: wave4d w4d-agents2 — §42.4: the model an agent's API answers came from (its assistant messages' `message.model`).
  | { kind: "agent_model"; toolUseId: string; model: string };

export class AgentTracker {
  private nodes: AgentNode[] = [];
  /** Whether any task_* message arrived in this session (else the tool_use / tool_result fallback decides alone). */
  private sawTasks = false;
  /** tool_use id → its parentToolUseId (null at top level), for nested file attribution. */
  private parents = new Map<string, string | null>();
  /** §36.1: the instructions and reports `agent_report` reads (this engine's lifetime, bounded). */
  private readonly reports = new AgentReportStore();
  /** §36.2: Agent / Task calls (tool_use ids) whose node got its task id from a task message — only those can be stopped one by one. */
  private tasked = new Set<string>();
  /** §36.2: `stop_agent` asked the CLI to stop these (tool_use ids) and their end was not seen yet. */
  private stopRequested = new Set<string>();
  /** §36.3: task id → its node, also after the next turn dropped it (the session's lifetime, bounded): what a continuation brings back. */
  private remembered = new Map<string, AgentNode>();
  /** §36.3: SendMessage calls (tool_use ids) without their result yet — the main agent blocks on them. */
  private pendingSends = new Set<string>();
  /** §36.3 / §36.4: tool_use id → when a continued agent's current run started (epoch ms). */
  private runStarts = new Map<string, number>();
  // MARK: wave4b w4b-agents
  /** §39.3: agent (tool_use id) → the call its `lastStep` is. */
  private stepCalls = new Map<string, string>();
  /** §39.3: finished agents of earlier turns, newest first (slim copies). */
  private past: AgentNode[] = [];
  /** §39.3: the user turn new agents start in (`setTurn`). */
  private turnNo: number | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    /** Path as reported in `files` (the engine makes repo paths repo-relative). */
    private readonly displayPath: (abs: string) => string = (p) => p,
  ) {}

  /** The live list (the engine deep-copies it into each snapshot), in start order. */
  get list(): readonly AgentNode[] {
    return this.nodes;
  }

  /** Foreground subagents still running: `state.hud.subagentDepth`. */
  get foregroundRunning(): number {
    return this.nodes.filter((n) => !n.isBackground && LIVE.has(n.status)).length;
  }

  /**
   * MARK: wave3 engine-agents — §36.4 `hud.waitingOnAgents` (the engine sends it only while a turn runs): the live
   * foreground top-level subagents (a blocking continuation included) and the one running longest — by its current
   * run's start for a continued one; null when there is none.
   */
  waitingOn(): WaitingOnAgents | null {
    let count = 0;
    let longest: WaitingOnAgents["longest"] | null = null;
    for (const n of this.nodes) {
      if (n.depth !== 1 || n.isBackground || !LIVE.has(n.status)) continue;
      count += 1;
      const startedAt = this.runStarts.get(n.toolUseId) ?? n.startedAt;
      if (!longest || startedAt < longest.startedAt) longest = { toolUseId: n.toolUseId, type: n.type, startedAt };
    }
    return longest ? { count, longest } : null;
  }

  /** Start of a user turn: finished agents are dropped (§39.3: into `history`), still-running (background) ones stay. */
  beginTurn(): void {
    const dropped = this.nodes.filter((n) => !LIVE.has(n.status));
    if (dropped.length > 0) this.past = [...dropped.reverse().map(historyEntry), ...this.past].slice(0, AGENT_HISTORY_MAX); // MARK: wave4b w4b-agents
    this.nodes = this.nodes.filter((n) => LIVE.has(n.status));
    const keep = new Set(this.nodes.map((n) => n.toolUseId));
    this.parents = new Map([...this.parents].filter(([id, parent]) => keep.has(id) || (parent !== null && keep.has(parent))));
    this.pendingSends = new Set();
    this.runStarts = new Map([...this.runStarts].filter(([id]) => keep.has(id)));
  }

  /**
   * End of a turn: foreground agents cannot outlive it, so any still marked running are `stopped`
   * (an interrupted turn, a lost notification). Background agents keep running.
   */
  endTurn(): boolean {
    let changed = false;
    for (const n of this.nodes) {
      if (!n.isBackground && LIVE.has(n.status)) changed = this.finish(n, "stopped") || changed;
    }
    return changed;
  }

  /** The CLI is gone: nothing it ran can still be running. */
  stopAll(): boolean {
    let changed = false;
    for (const n of this.nodes) if (LIVE.has(n.status)) changed = this.finish(n, "stopped") || changed;
    return changed;
  }

  reset(): void {
    this.nodes = [];
    this.parents = new Map();
    this.sawTasks = false;
    this.tasked = new Set();
    this.stopRequested = new Set();
    this.remembered = new Map();
    this.pendingSends = new Set();
    this.runStarts = new Map();
    this.stepCalls = new Map(); // MARK: wave4b w4b-agents
    this.past = [];
    this.turnNo = undefined;
  }

  // MARK: wave4b w4b-agents
  /** §39.3 `hud.agentHistory`: finished agents of this chat's earlier turns, newest first. */
  get history(): readonly AgentNode[] {
    return this.past;
  }

  // MARK: wave4d w4d-agents2
  /**
   * §42.4: the earlier turns' agents rebuilt from the chat's rows (an engine restart, a chat opened): taken only while
   * this tracker has no history and no agent of its own (right after `reset`). True when taken.
   */
  restoreHistory(nodes: readonly AgentNode[]): boolean {
    if (this.past.length > 0 || this.nodes.length > 0 || nodes.length === 0) return false;
    this.past = nodes.slice(0, AGENT_HISTORY_MAX).map((n) => ({ ...n, files: [...n.files] }));
    return true;
  }

  /** §39.3: the user turn agents started from now on belong to (`user_message.turn`). */
  setTurn(turn: number): void {
    this.turnNo = turn;
  }

  /**
   * §39.3: where an isolated agent worked (§33.4's `worktree_outside_review` for its call: the CLI's `worktreePath` /
   * `worktreeBranch`). False when the call is no listed agent or nothing changed.
   */
  noteWorktree(toolUseId: string, path: string | undefined, branch: string | undefined): boolean {
    const n = this.byToolUseId(toolUseId);
    if (!n || (!path && !branch) || ((!path || n.worktreePath === path) && (!branch || n.worktreeBranch === branch))) return false;
    if (path) n.worktreePath = path;
    if (branch) n.worktreeBranch = branch;
    return true;
  }

  // ------------------------------------------------------------------ tool calls

  onToolUse(ev: { id: string; name: string; input: Record<string, unknown>; file?: string; parentToolUseId?: string }): boolean {
    const parent = ev.parentToolUseId ?? null;
    this.parents.set(ev.id, parent);
    let changed = false;
    const pick = (k: string) => (typeof ev.input[k] === "string" && (ev.input[k] as string).length > 0 ? (ev.input[k] as string) : undefined);
    if (SUBAGENT_TOOL_RE.test(ev.name) && !this.byToolUseId(ev.id)) {
      this.nodes.push({
        id: ev.id,
        toolUseId: ev.id,
        ...(parent !== null ? { parentToolUseId: parent } : {}),
        type: pick("subagent_type") ?? "general-purpose",
        description: pick("description") ?? "",
        status: "running",
        isBackground: ev.input.run_in_background === true,
        depth: this.depthUnder(parent),
        startedAt: this.now(),
        files: [],
        ...(this.turnNo !== undefined ? { turn: this.turnNo } : {}), // MARK: wave4b w4b-agents
        ...(pick("isolation") !== undefined ? { isolation: pick("isolation")! } : {}),
      });
      changed = true;
    }
    // MARK: wave3 engine-agents — §36.1: what it was told and on which model (null: the call named none).
    const spawned = SUBAGENT_TOOL_RE.test(ev.name) ? this.byToolUseId(ev.id) : undefined;
    if (spawned) {
      const prompt = pick("prompt");
      const model = pick("model") ?? null;
      if (prompt !== undefined) spawned.prompt = prompt.slice(0, AGENT_PROMPT_CHARS);
      spawned.model = model;
      this.reports.noteCall(ev.id, prompt?.slice(0, AGENT_REPORT_KEPT_CHARS) ?? null, model, true);
      changed = true;
    }
    // §36.3: the main agent waits on its SendMessage; one that continues a known agent is kept like an agent call
    // (`agent_report` on it: its message, the agent's model, the continued run's report).
    if (ev.name === "SendMessage") {
      this.pendingSends.add(ev.id);
      const target = this.continued(ev.input);
      if (target) this.reports.noteCall(ev.id, pick("message")?.slice(0, AGENT_REPORT_KEPT_CHARS) ?? null, target.model ?? null, true);
    }
    const owner = parent !== null ? this.byToolUseId(parent) : undefined;
    if (owner && LIVE.has(owner.status) && owner.lastTool !== ev.name) {
      owner.lastTool = ev.name;
      changed = true;
    }
    // MARK: wave4b w4b-agents — §39.3: what it is doing now.
    if (owner && LIVE.has(owner.status)) {
      this.step(owner, ev.id, ev.name, activityDetail(ev.name, ev.input, ev.file), this.now());
      changed = true;
    }
    if (ev.file && EDIT_TOOL_RE.test(ev.name)) changed = this.attributeFiles(parent, [ev.file]) || changed;
    return changed;
  }

  /** Closes a fallback / foreground node; a backgrounded agent's tool_result is only the "launched" placeholder. */
  onToolResult(toolUseId: string, isError: boolean): boolean {
    const stepEnded = this.endStep(toolUseId); // MARK: wave4b w4b-agents
    const n = this.byToolUseId(toolUseId);
    if (!n || !LIVE.has(n.status)) return stepEnded;
    if (n.isBackground && this.sawTasks) return stepEnded;
    // §36.2: the "[Request interrupted by user for tool use]" of an agent `stop_agent` stopped (before its notification).
    const stopped = isError && this.stopRequested.has(toolUseId);
    return this.finish(n, stopped ? "stopped" : isError ? "failed" : "completed") || stepEnded;
  }

  /** Files a Bash call changed (post-Bash snapshot): credited to the agent that ran it and its ancestors. */
  onToolFiles(toolUseId: string, files: string[]): boolean {
    const parent = this.parents.get(toolUseId);
    return parent ? this.attributeFiles(parent, files) : false;
  }

  // MARK: wave3 engine-agents
  /**
   * §36.1: what an Agent / Task call's result says — the cleaned report (`reportPreview`, kept for `agent_report`), its
   * `<usage>` (final numbers: they override the task messages') and the CLI's agent id. Called for every tool_result.
   */
  onAgentResult(r: { toolUseId: string; isError: boolean; report?: { text: string; truncated: boolean }; usage?: AgentUsage; cliAgentId?: string }): boolean {
    let changed = false;
    // §36.3: the SendMessage returned — a continuation still running goes on in the background from here (an
    // interrupted call — the agent being stopped — is no such return).
    if (this.pendingSends.delete(r.toolUseId)) {
      const resumed = this.nodes.find((x) => x.resumedBy === r.toolUseId);
      if (resumed && !r.isError && LIVE.has(resumed.status) && !resumed.isBackground) {
        resumed.isBackground = true;
        changed = true;
      }
      if (resumed && r.usage) changed = this.setUsage(resumed, r.usage) || changed;
    }
    const n = this.byToolUseId(r.toolUseId);
    if (!n && !this.reports.get(r.toolUseId)) return changed;
    // A background agent's result is only the "launched" placeholder (§13): no report.
    const placeholder = n !== undefined && n.isBackground && this.sawTasks && LIVE.has(n.status);
    const report = r.isError || placeholder ? undefined : r.report;
    this.reports.noteResult(r.toolUseId, { text: report?.text ?? null, truncated: report?.truncated ?? false, usage: r.usage ?? null });
    if (!n) return changed;
    if (report) n.reportPreview = report.text.slice(0, AGENT_REPORT_PREVIEW_CHARS);
    if (r.usage) this.setUsage(n, r.usage);
    if (r.cliAgentId) n.cliAgentId = r.cliAgentId;
    return changed || report !== undefined || r.usage !== undefined || r.cliAgentId !== undefined;
  }

  /**
   * §36.3: `tool_use.continues` for a SendMessage whose `to` names a subagent this session knows — by the CLI's agent
   * id or its task id; undefined for other calls and targets (another session, a named teammate).
   */
  continuationOf(name: string, input: Record<string, unknown>): AgentContinuation | undefined {
    if (name !== "SendMessage") return undefined;
    const n = this.continued(input);
    return n ? { agentToolUseId: n.toolUseId, agentType: n.type } : undefined;
  }

  /**
   * §36.1 `agent_report` from memory: the reply, `no_report` (still running, an error result, no text), or undefined
   * when this engine does not know the call (the transcript decides).
   */
  report(toolUseId: string): AgentReportEvent | "no_report" | undefined {
    const kept = this.reports.get(toolUseId);
    const n = this.byToolUseId(toolUseId);
    if (!kept && !n) return undefined;
    const text = kept?.result?.text;
    if (!kept?.result || !text) return "no_report";
    return {
      type: "agent_report",
      toolUseId,
      text,
      truncated: kept.result.truncated,
      usage: kept.result.usage ?? (n ? usageOf(n) : null),
      model: kept.model ?? n?.model ?? null,
      prompt: kept.prompt ?? n?.prompt ?? null,
    };
  }

  // ------------------------------------------------------------------ SDK task messages

  onSignal(sig: AgentSignal): boolean {
    switch (sig.kind) {
      case "task_started": {
        if (sig.ambient) return false;
        const byTool = sig.toolUseId ? this.byToolUseId(sig.toolUseId) : undefined;
        // Only subagents: local_bash / mcp_task / workflow tasks are not agents.
        const isAgent = sig.taskType === "local_agent" || (sig.taskType === undefined && (byTool !== undefined || sig.subagentType !== undefined));
        if (!isAgent) return false;
        this.sawTasks = true;
        // §36.3: the same task id again for an agent that had finished — SendMessage continued it.
        const prior = this.byTaskId(sig.taskId) ?? this.remembered.get(sig.taskId);
        if (prior && this.tasked.has(prior.toolUseId) && (!LIVE.has(prior.status) || !this.nodes.includes(prior))) return this.resume(prior, sig);
        const n = byTool ?? this.byTaskId(sig.taskId) ?? this.create(sig.taskId, sig.toolUseId);
        this.setTaskId(n, sig.taskId);
        // MARK: wave3 engine-agents — §36.1: the instructions, unless the Agent call gave them already.
        if (sig.prompt) {
          if (n.prompt === undefined) n.prompt = sig.prompt.slice(0, AGENT_PROMPT_CHARS);
          this.reports.noteCall(n.toolUseId, sig.prompt.slice(0, AGENT_REPORT_KEPT_CHARS), null);
        }
        if (sig.description) n.description = sig.description;
        if (sig.subagentType) n.type = sig.subagentType;
        if (sig.isBackground !== undefined) n.isBackground = sig.isBackground;
        if (sig.depth !== undefined && sig.depth > 0) n.depth = sig.depth;
        return true;
      }
      case "task_progress": {
        let n = this.byTaskId(sig.taskId) ?? (sig.toolUseId ? this.byToolUseId(sig.toolUseId) : undefined);
        if (!n) {
          if (sig.subagentType === undefined) return false;
          n = this.create(sig.taskId, sig.toolUseId);
          n.type = sig.subagentType;
        }
        this.sawTasks = true;
        this.setTaskId(n, sig.taskId);
        if (sig.description && !n.description) n.description = sig.description;
        n.tokens = sig.usage.tokens;
        n.toolUses = sig.usage.toolUses;
        n.durationMs = sig.usage.durationMs;
        if (sig.lastTool) n.lastTool = sig.lastTool;
        if (sig.summary) n.summary = sig.summary;
        return true;
      }
      case "task_updated": {
        const n = this.byTaskId(sig.taskId);
        if (!n) return false;
        this.sawTasks = true;
        if (sig.description) n.description = sig.description;
        // §36.3: a continuation stays in the foreground while the main agent blocks on its SendMessage.
        if (sig.isBackground !== undefined && !(sig.isBackground && this.blocking(n))) n.isBackground = sig.isBackground;
        if (sig.error) n.error = sig.error;
        if (sig.status !== undefined) {
          const status: AgentStatus = sig.status === "killed" ? "stopped" : sig.status;
          if (LIVE.has(status)) {
            n.status = status;
            delete n.endedAt;
          } else this.finish(n, status, sig.endTime);
        } else if (sig.endTime !== undefined && !LIVE.has(n.status)) n.endedAt = sig.endTime;
        return true;
      }
      case "task_notification": {
        const n = this.byTaskId(sig.taskId) ?? (sig.toolUseId ? this.byToolUseId(sig.toolUseId) : undefined);
        if (!n) return false;
        this.sawTasks = true;
        this.setTaskId(n, sig.taskId);
        if (sig.summary) n.summary = sig.summary;
        if (sig.usage) {
          n.tokens = sig.usage.tokens;
          n.toolUses = sig.usage.toolUses;
          n.durationMs = sig.usage.durationMs;
        }
        // The notification is the final word, also over a fallback "completed" from the tool_result.
        this.finish(n, sig.status, undefined, true);
        return true;
      }
      case "tool_progress": {
        // MARK: wave4b w4b-agents — §39.3: a retry of the agent's request; a progress line of one of its calls.
        if (sig.retry) return this.onRetry(sig);
        const n = sig.parentToolUseId ? this.byToolUseId(sig.parentToolUseId) : undefined;
        if (!n || !LIVE.has(n.status)) return false;
        const now = this.now();
        if (this.stepCalls.get(n.toolUseId) !== sig.toolUseId) {
          const since = sig.elapsedSeconds !== undefined && sig.elapsedSeconds >= 0 ? now - Math.round(sig.elapsedSeconds * 1000) : now;
          this.step(n, sig.toolUseId, sig.toolName, undefined, since);
          n.lastTool = sig.toolName;
          return true;
        }
        const moved = n.activeAt === undefined || now - n.activeAt >= ACTIVE_REPORT_MS;
        n.activeAt = now;
        if (n.lastTool === sig.toolName) return moved;
        n.lastTool = sig.toolName;
        return true;
      }
      // MARK: wave4d w4d-agents2 — §42.4
      case "agent_model": {
        const n = this.byToolUseId(sig.toolUseId);
        if (!n || n.apiModel === sig.model) return false;
        n.apiModel = sig.model;
        return true;
      }
    }
  }

  /**
   * The subagent behind a permission request (§33): by the SDK's `agentID` (= the task id, `AgentNode.id`), else
   * through the asking call's parent tool_use (CLIs without task messages). Undefined for the main agent / unknown ids.
   */
  ownerOf(agentId: string | undefined, toolUseId: string | undefined): AgentNode | undefined {
    const byTask = agentId ? this.byTaskId(agentId) : undefined;
    if (byTask) return byTask;
    const parent = toolUseId ? this.parents.get(toolUseId) : undefined;
    return parent ? this.byToolUseId(parent) : undefined;
  }

  // ------------------------------------------------------------------ helpers

  private byToolUseId(id: string): AgentNode | undefined {
    return this.nodes.find((n) => n.toolUseId === id);
  }

  private byTaskId(id: string): AgentNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  private create(taskId: string, toolUseId: string | undefined): AgentNode {
    const parent = toolUseId ? this.parents.get(toolUseId) ?? null : null;
    const n: AgentNode = {
      id: taskId,
      toolUseId: toolUseId ?? taskId,
      ...(parent !== null ? { parentToolUseId: parent } : {}),
      type: "general-purpose",
      description: "",
      status: "running",
      isBackground: false,
      depth: this.depthUnder(parent),
      startedAt: this.now(),
      files: [],
    };
    this.nodes.push(n);
    return n;
  }

  /** Depth of an agent spawned by a call whose parent is `parent`: 1 at top level, N+1 inside a depth-N agent. */
  private depthUnder(parent: string | null): number {
    const owner = parent !== null ? this.byToolUseId(parent) : undefined;
    return owner ? owner.depth + 1 : 1;
  }

  private finish(n: AgentNode, status: AgentStatus, endedAt?: number, force = false): boolean {
    if (!force && !LIVE.has(n.status)) return false;
    // §36.2: stopped after `stop_agent` asked for it is the user's stop; any other end drops the request.
    const byUser = status === "stopped" && (this.stopRequested.has(n.toolUseId) || n.stoppedBy === "user");
    this.stopRequested.delete(n.toolUseId);
    if (n.status === status && n.endedAt !== undefined && endedAt === undefined && (n.stoppedBy === "user") === byUser) return false;
    n.status = status;
    n.endedAt = endedAt ?? n.endedAt ?? this.now();
    if (byUser) n.stoppedBy = "user";
    else delete n.stoppedBy;
    // MARK: wave4b w4b-agents — §39.3: "doing now" ends with it (a finished card shows its result, not its last call).
    for (const k of ["lastStep", "retry", "activeAt"] as const) delete n[k];
    this.stepCalls.delete(n.toolUseId);
    return true;
  }

  /** The node of that Agent / Task call, if listed. */
  node(toolUseId: string): AgentNode | undefined {
    return this.byToolUseId(toolUseId);
  }

  /** §52.2: that Agent / Task call's subagent still works (pending, running or paused). */
  isLive(toolUseId: string): boolean {
    const n = this.byToolUseId(toolUseId);
    return n !== undefined && LIVE.has(n.status);
  }

  /** §52.2: the Agent / Task call of a live subagent's task (`task_stop` from the background list stops an agent too). */
  callOfTask(taskId: string): string | undefined {
    const n = this.byTaskId(taskId);
    return n && LIVE.has(n.status) ? n.toolUseId : undefined;
  }

  /**
   * §36.2 `stop_agent`: the task id `query.stopTask` takes, or why that agent cannot be stopped — no node
   * (`unknown_agent`), not pending / running / paused (`not_running`), no task id (`not_supported`: a CLI without task
   * messages, where `id` is the tool_use id).
   */
  stopTarget(toolUseId: string): { taskId: string } | "unknown_agent" | "not_running" | "not_supported" {
    const n = this.byToolUseId(toolUseId);
    if (!n) return "unknown_agent";
    if (!LIVE.has(n.status)) return "not_running";
    if (!this.tasked.has(n.toolUseId)) return "not_supported";
    return { taskId: n.id };
  }

  /** §36.2: `stopTask` is on its way — however the agent's end arrives (notification, interrupted result, the call returning), it was the user's. */
  requestStop(toolUseId: string): void {
    this.stopRequested.add(toolUseId);
  }

  /** §36.2: `stopTask` failed. */
  cancelStop(toolUseId: string): void {
    this.stopRequested.delete(toolUseId);
  }

  /** §36.2: `stopTask` returned: the node is `stopped` by the user now (unless it ended on its own first). */
  confirmStop(toolUseId: string): boolean {
    const n = this.byToolUseId(toolUseId);
    const changed = n !== undefined && LIVE.has(n.status) && this.finish(n, "stopped");
    this.stopRequested.delete(toolUseId);
    return changed;
  }

  /**
   * §36.2: whether this tool_result is the end of an agent the user stopped (its event and row carry `stoppedBy`) — the
   * Agent call's, or the interrupted SendMessage that was running it again (§36.3).
   */
  stoppedByUser(toolUseId: string, isError: boolean): boolean {
    if (this.byToolUseId(toolUseId)?.stoppedBy === "user" || (isError && this.stopRequested.has(toolUseId))) return true;
    const resumed = isError ? this.nodes.find((x) => x.resumedBy === toolUseId) : undefined;
    return resumed !== undefined && (resumed.stoppedBy === "user" || this.stopRequested.has(resumed.toolUseId));
  }

  private setTaskId(n: AgentNode, taskId: string): void {
    n.id = taskId;
    this.tasked.add(n.toolUseId);
    if (this.remembered.get(taskId) === n) return;
    this.remembered.set(taskId, n);
    for (const [id, old] of this.remembered) {
      if (this.remembered.size <= MAX_REMEMBERED_AGENTS) break;
      if (!this.nodes.includes(old)) this.remembered.delete(id);
    }
  }

  /** §36.3: the agent a SendMessage `to` names — the CLI's agent id, else the task id (they are the same in CLI 2.1.30x). */
  private continued(input: Record<string, unknown>): AgentNode | undefined {
    const to = typeof input.to === "string" ? input.to.trim() : "";
    if (!to) return undefined;
    const byTask = this.remembered.get(to);
    if (byTask) return byTask;
    for (const n of this.remembered.values()) if (n.cliAgentId === to) return n;
    return this.nodes.find((n) => n.cliAgentId === to);
  }

  /**
   * §36.3: a finished agent runs again (its task_started came back, `toolUseId` = the SendMessage call): running, no end,
   * `resumeCount` + 1, `resumedBy`; in the foreground while that call has no result. One the next turn had dropped comes
   * back into this turn's list as a new card (`startedAt` now, no files, no usage yet) under its original toolUseId.
   */
  private resume(n: AgentNode, sig: Extract<AgentSignal, { kind: "task_started" }>): boolean {
    if (!this.nodes.includes(n)) {
      n.startedAt = this.now();
      n.files = [];
      delete n.tokens;
      delete n.toolUses;
      delete n.durationMs;
      this.nodes.push(n);
    }
    this.stopRequested.delete(n.toolUseId);
    n.status = "running";
    for (const k of ["endedAt", "stoppedBy", "error", "summary", "lastTool"] as const) delete n[k];
    // MARK: wave4b w4b-agents — §39.3: its new run starts without a step; back in this turn it leaves the history.
    for (const k of ["lastStep", "retry"] as const) delete n[k];
    this.stepCalls.delete(n.toolUseId);
    this.past = this.past.filter((x) => x.toolUseId !== n.toolUseId);
    if (this.turnNo !== undefined) n.turn = this.turnNo;
    n.resumeCount = (n.resumeCount ?? 0) + 1;
    if (sig.toolUseId && sig.toolUseId !== n.toolUseId) n.resumedBy = sig.toolUseId;
    else delete n.resumedBy;
    n.isBackground = this.blocking(n) ? false : sig.isBackground ?? n.isBackground;
    if (sig.description) n.description = sig.description;
    this.runStarts.set(n.toolUseId, this.now());
    return true;
  }

  /** §36.3: the main agent is blocked on the SendMessage that continued `n` (no result yet). */
  private blocking(n: AgentNode): boolean {
    return n.resumedBy !== undefined && this.pendingSends.has(n.resumedBy);
  }

  private setUsage(n: AgentNode, u: AgentUsage): boolean {
    if (n.tokens === u.tokens && n.toolUses === u.toolUses && n.durationMs === u.durationMs) return false;
    n.tokens = u.tokens;
    n.toolUses = u.toolUses;
    n.durationMs = u.durationMs;
    return true;
  }

  // MARK: wave4b w4b-agents
  /** §39.3: `n`'s latest call is `callId` (a running one: no end, no retry since). */
  private step(n: AgentNode, callId: string, tool: string, detail: string | undefined, since: number): void {
    n.lastStep = { tool, ...(detail !== undefined ? { detail } : {}), since };
    delete n.retry;
    n.activeAt = this.now();
    this.stepCalls.set(n.toolUseId, callId);
  }

  /** §39.3: the result of an agent's current call ends its step. */
  private endStep(callId: string): boolean {
    const ownerId = this.parents.get(callId);
    const owner = ownerId ? this.byToolUseId(ownerId) : undefined;
    if (!owner || this.stepCalls.get(owner.toolUseId) !== callId || !owner.lastStep || owner.lastStep.endedAt !== undefined) return false;
    const now = this.now();
    owner.lastStep = { ...owner.lastStep, endedAt: now };
    owner.activeAt = now;
    return true;
  }

  /** §39.3 `tool_progress.subagent_retry`: on the agent's own call, else the agent around the call, its task or its CLI id. */
  private onRetry(sig: Extract<AgentSignal, { kind: "tool_progress" }>): boolean {
    const r = sig.retry!;
    const n =
      this.byToolUseId(sig.toolUseId) ??
      (sig.parentToolUseId ? this.byToolUseId(sig.parentToolUseId) : undefined) ??
      (sig.taskId ? this.byTaskId(sig.taskId) : undefined) ??
      (r.agentId ? this.nodes.find((x) => x.cliAgentId === r.agentId || x.id === r.agentId) : undefined);
    if (!n || !LIVE.has(n.status)) return false;
    const now = this.now();
    n.retry = { attempt: r.attempt, max: r.max, at: now, status: r.status };
    n.activeAt = now;
    return true;
  }

  /** Adds `files` to the agent running `parent` and to every agent above it. */
  private attributeFiles(parent: string | null, files: string[]): boolean {
    let changed = false;
    const seen = new Set<string>();
    let cur = parent;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const n = this.byToolUseId(cur);
      if (!n) break;
      for (const f of files) {
        const p = this.displayPath(f);
        if (!n.files.includes(p)) {
          n.files.push(p);
          changed = true;
        }
      }
      cur = n.parentToolUseId ?? null;
    }
    return changed;
  }
}

// MARK: wave4b w4b-agents
/** §39.3: a finished node as `hud.agentHistory` keeps it — no instructions, texts and files cut. */
function historyEntry(n: AgentNode): AgentNode {
  const { prompt: _prompt, ...rest } = n;
  const cut = (v: string) => (v.length > HISTORY_TEXT_CHARS ? v.slice(0, HISTORY_TEXT_CHARS - 1) + "…" : v);
  return {
    ...rest,
    files: n.files.slice(0, HISTORY_FILES),
    ...(n.reportPreview !== undefined ? { reportPreview: cut(n.reportPreview) } : {}),
    ...(n.summary !== undefined ? { summary: cut(n.summary) } : {}),
  };
}

/** A node's usage as the task messages / `<usage>` left it; null unless all three numbers are known. */
function usageOf(n: AgentNode): AgentUsage | null {
  return n.tokens !== undefined && n.toolUses !== undefined && n.durationMs !== undefined ? { tokens: n.tokens, toolUses: n.toolUses, durationMs: n.durationMs } : null;
}
