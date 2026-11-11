/**
 * Events a `ClaudeSession` emits (the transcript events of docs/PROTOCOL.md §2, before `ReviewEngine`
 * adds `id`/`scope`), plus `closed`, which reports that the SDK query loop ended.
 */
import type { ActivityKind, Budget, BudgetUsage, ErrorDetails, LogLevel, MemoryFile, PermissionRequest, RationaleSource, TestOutcome, TurnUsage } from "../protocol.js";
import type { AgentContinuation, AgentStoppedBy, AgentUsage } from "../protocol.js";
import type { AgentSignal } from "./agents.js";
import type { ToolWindow } from "./provenance.js";
import type { ScopeNotice } from "./reviewScope.js";
import type { RateLimitWindow } from "../protocol.js"; // MARK: wave4 w4-longwork
import type { PermissionMode } from "../protocol.js"; // MARK: wave6 w6-terminal
import type { AutoTurnInfo, BackgroundTask } from "../protocol.js"; // §52
import type { HeadInfo } from "../protocol.js"; // MARK: r1-git

/**
 * A file the turn's tools touched: tool names plus the tool_use ids that touched it (edit tools by their
 * `file_path`, Bash by the post-Bash snapshot). `toolUseIds` is optional only for older test doubles.
 */
export type ToolFileEntry = { path: string; tools: string[]; count: number; toolUseIds?: string[] };

export type SessionInfoEvent = {
  type: "session_info";
  sessionId: string;
  model: string;
  cwd: string;
  slashCommands: string[];
  skills: string[];
  plugins: { name: string; path: string; version?: string }[];
  mcpServers: { name: string; status: string }[];
  /** Model context window in tokens; only known once a `result` exposed `modelUsage`. */
  contextWindow?: number;
  /** MARK: wave3 engine-session — §36.8: `system/init` `claude_code_version`. */
  cliVersion?: string;
};

/**
 * MARK: wave3 engine-session — §36.7: a progress signal of the starting CLI (before initialize answered): a hook started /
 * ran / ended (`hook`, `id` = its hook id, `name` = its hook name or event), a plugin install step (`plugin`), a status line
 * (`status`). `done`: that hook / install ended.
 */
export type StartProgress = { kind: "hook" | "plugin" | "status"; id?: string; name: string | null; done?: boolean };

/**
 * MARK: r1-git — §46: what one of Claude's git commands did (hooks.ts `postGitCommand`): files a `git stash` took out of the
 * working tree (`stashed`, repo-relative); HEAD moved `from` → `to` — `ownCommits`: the commits its `git commit` made (full
 * shas, oldest first; the reflog's `commit:` / `commit (amend):` entries written while it ran); `amended`: the commits its
 * `git commit --amend` replaced; `foreign`: the reflog also shows a move from before the command ran (someone else's, e.g.
 * while its card waited).
 */
export type GitCommandResult = { toolUseId: string; stashed?: string[]; from?: HeadInfo; to?: HeadInfo; ownCommits?: string[]; amended?: string[]; foreign?: true };

export type SessionEvent =
  | SessionInfoEvent
  | { type: "text_delta"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      file?: string;
      /** The Agent/Task tool_use this call runs under (subagent inner call); absent at top level. */
      parentToolUseId?: string;
      /** Assistant text right before this call in the same API message (trimmed, ≤ 400 chars). */
      rationale?: string;
      /** §34.8: `rationale` is this API message's text (`same_message`) or the agent's latest earlier text (`earlier`). */
      rationaleSource?: RationaleSource;
      /** §34.8: the agent's tool calls between that text and this call (0 = the first after it). */
      rationaleAge?: number;
      /** MARK: wave3 engine-agents — §36.3: set by the engine on a SendMessage that continues a subagent it knows. */
      continues?: AgentContinuation;
      /** MARK: wave4b w4b-tabs — §39.2: set by the engine on a call that only reads or searches (session/explore.ts). */
      explore?: true;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      isError: boolean;
      preview: string;
      parentToolUseId?: string;
      /** The result is longer than `preview`. */
      truncated?: boolean;
      /** Bash only, when longer than the preview: the output (≤ ~20k chars, `truncated` when cut) kept by the engine for `tool_output`; never sent on the wire. */
      output?: { text: string; truncated: boolean };
      testOutcome?: TestOutcome;
      /** §34.8 Agent / Task calls: the subagent's report (the result text, ≤ 4 000 chars) for `why`; never sent on the wire. */
      agentReport?: string;
      // MARK: wave3 engine-agents
      /** §36.1 Agent / Task results (and §36.3 SendMessage continuations): the parsed `<usage>` block / `agentId:` line. */
      agentUsage?: AgentUsage;
      cliAgentId?: string;
      /** §36.2: set by the engine (the agent was stopped with `stop_agent`); a session never sets it. */
      stoppedBy?: AgentStoppedBy;
      /** §36.1: the cleaned report (≤ 50 000 chars, `truncated` beyond) for the transcript row and `agent_report`; never sent on the wire. */
      keptReport?: { text: string; truncated: boolean };
      /** §52.2: the call's subagent went to work in the background (no report yet). */
      agentLaunched?: true;
      /** §52.2: the call's subagent worked in the background and ended — this is its result (a second one for the call). */
      agentEnded?: true;
      /** §38.2: a user or plugin PreToolUse hook denied the call (its name, what it said). */
      hookDenied?: { hook: string; reason: string };
    }
  /**
   * §34.6: the tree a post-Bash snapshot took (`root`: the repository it is of) — the engine reuses it as the live tree
   * while no other call could have changed the worktree since.
   */
  | { type: "bash_snapshot"; toolUseId: string; tree: string; root: string }
  /** Files the post-Bash snapshot attributed to that Bash call (absolute paths). */
  | { type: "tool_files"; toolUseId: string; files: string[] }
  /** Subagent lifecycle from the SDK's task_* / tool_progress messages, folded by `AgentTracker`. */
  | { type: "agent_signal"; signal: AgentSignal }
  | ({ type: "permission_request" } & PermissionRequest)
  /** §33: a request the session answered itself (the CLI aborted the call, interrupt, shutdown): it is no longer open. */
  | { type: "permission_cancelled"; requestId: string }
  /** §33.4: work outside this window's review was blocked (EnterWorktree, isolated agents) or happened (approved). */
  | ({ type: "scope_notice" } & ScopeNotice)
  | { type: "budget_event"; kind: "warn" | "deny"; toolName: string; file?: string; files: number; lines: number; budget: Budget }
  /** `ExitPlanMode` was called: the plan text it carried (already capped) plus the turn's plan files (docs/M20-MODES.md). */
  | { type: "plan_exit"; plan: string; planFiles: string[] }
  /** MARK: wave6 w6-terminal — §44.1: the CLI entered plan mode on its own (EnterPlanMode, a resume); `prePlanMode`: the mode before. */
  | { type: "permission_mode"; mode: PermissionMode; prePlanMode: PermissionMode | null }
  /**
   * `lastUuid`: chain uuid of the turn's last top-level assistant message — where a side question forks (§21).
   * `toolWindows`: the finished Bash / MCP execution windows of the turn (§31); optional for older test doubles.
   */
  | { type: "turn_end"; stopReason: string; sessionId: string; usage: TurnUsage; toolFiles: ToolFileEntry[]; budget: BudgetUsage; changedOutside: string[]; planFiles: string[]; lastUuid?: string; toolWindows?: ToolWindow[] }
  | { type: "activity"; kind: ActivityKind; toolName?: string; detail?: string }
  /** `initializationResult()` did not resolve within `settings.initTimeoutMs` (user settings loaded; §16). */
  | { type: "init_timeout"; afterMs: number }
  /** §30: the CLI answered initialize — it accepted the start (`--resume` found the conversation); a death from here on is a crash, not a start failure. */
  | { type: "session_ready" }
  /** Probed right after the CLI initialized (best effort): loaded memory files, MCP server status. */
  | { type: "extensions_info"; memoryFiles?: MemoryFile[]; mcpServers?: { name: string; status: string }[] }
  /** `Query.supportedModels()` answered right after initialization (raw `ModelInfo[]`; §25). */
  | { type: "models_info"; models: unknown[] }
  /** MARK: wave3 engine-session — §36.5: the CLI's commands (raw `SlashCommand[]`): `initializationResult().commands`, then every `system/commands_changed`. */
  | { type: "commands_info"; commands: unknown[] }
  /** MARK: composer — §50.2: the CLI started a message `steerUser` put into the turn (its uuid): Claude reads it now. */
  | { type: "steer_read"; uuid: string }
  /** MARK: wave4d w4d-config — §42.3: the subagents (raw `AgentInfo[]`) of `initializationResult().agents`. */
  | { type: "agents_info"; agents: unknown[] }
  /** MARK: wave3 engine-session — §36.7: the starting CLI made progress (the init watchdog restarted). */
  | ({ type: "start_progress" } & StartProgress)
  /** A tool call was denied because no engine-started turn was running (Claude Code continued on its own; §18). */
  | { type: "unprompted_denied"; toolName: string }
  /** A `result` arrived without an engine-started turn: not a turn_end — nothing to collect or count (§18). */
  | { type: "unprompted_turn_end"; sessionId: string }
  /** §52: the live background tasks changed (REPLACE: the whole list, oldest first). */
  | { type: "background_tasks"; tasks: BackgroundTask[] }
  /**
   * §52: the CLI started a turn itself (a background task ended, `/loop`, …). The session counts it as active; every tool
   * call waits until the engine answers `autoTurnReady` (true: a review turn; false: §18 denies its changes).
   */
  | ({ type: "auto_turn_start"; commandUuid?: string } & AutoTurnInfo)
  /** §29: the CLI's `system/peer_message_hold` — a peer message parked (`held`), let through (`released`) or gone (`dropped` + `outcome`). */
  | { type: "peer_hold"; state: "held" | "released" | "dropped"; messageUuid: string; from: string; fromName?: string; cause?: string; outcome?: string }
  /**
   * §29: a peer message reached the model (its `--replay-user-messages` echo or, without one, the turn's `result.origin`).
   * `owned`: it runs in a turn this session released (`releasePeers`) — a review turn; otherwise the CLI ran it on its own.
   */
  | { type: "peer_delivered"; messageUuid: string | null; owned: boolean; origin: PeerOrigin }
  /** §29: a command that is not ours (a peer message the CLI delivered by itself, …) started / ended (`command_lifecycle`). */
  | { type: "external_turn"; running: boolean; commandUuid?: string }
  /** `code` / details: docs/PROTOCOL.md §19.6 (`auth_required`, `usage_limit`, `rate_limited`, `api_retrying`, `api_error`, `cli_start_slow`). */
  | ({ type: "error"; message: string; fatal: boolean } & ErrorDetails)
  /** MARK: r1-git — §46: what a git command of Claude's did (`GitCommandResult`). */
  | ({ type: "git_result" } & GitCommandResult)
  // MARK: wave4 w4-longwork — §38.2: a usage window of the subscription changed (`rate_limit_event`).
  | { type: "rate_limit_info"; window: RateLimitWindow }
  | { type: "closed"; code: number };

export type SessionLog = (level: LogLevel, message: string) => void;

/**
 * §29: who sent a peer message, as the CLI reports it (`origin.kind: "peer"`). `from` / `name` are what the SENDER claims;
 * `verifiedPeerPid` is the kernel-verified pid of the connecting process (absent when unverifiable).
 */
export type PeerOrigin = { from: string; name?: string; verifiedPeerPid?: number; body?: string; fromMode?: string; msgId?: string };
