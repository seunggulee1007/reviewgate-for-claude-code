import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type McpServerConfig,
  type McpServerStatus,
  type McpSetServersResult,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Platform } from "../platform/index.js";
import { isBatchFile, realShimFs, resolveCmdShim, type ShimFs } from "../platform/winShell.js";
import { MAX_PLAN_BYTES, type ActivityKind, type Budget, type EffortLevel, type ImageMediaType, type PermissionMode, type PermissionReason, type TurnCompaction, type TurnUsage } from "../protocol.js";
import type { PeerSessionInfo } from "../protocol.js"; // MARK: wave4d w4d-peers
import { BudgetState, resolveToolPath } from "./budget.js";
import type { PeerOrigin, SessionEvent, SessionLog, ToolFileEntry } from "./events.js";
import {
  autoAllowReason,
  buildHooks,
  configScopeReason,
  containmentRoot,
  EDIT_TOOLS_MATCHER,
  GIT_INTERNAL_REASON,
  gitCommandReason,
  isGitInternalEdit,
  isOutsideRoot,
  isPlanFile,
  otherWorktrees,
  planModeBlocked,
  plansDir,
  readOnlyContextOf,
  UNPROMPTED_REASON,
  unpromptedBlocked,
  type HookContext,
} from "./hooks.js";
import { AsyncQueue } from "./queue.js";
import { defaultScratchDirs, editScopeReason, GIT_INSTRUCTION, isolatedCall, SCOPE_MESSAGES, scopeInstruction, worktreeToolBlocked } from "./reviewScope.js";
import { allowPatternSuggestions, mcpToolName, type McpToolHints, type UserRules } from "./permissionRules.js";
import { normalizeForCompare } from "../platform/paths.js";
import { API_ERROR_MESSAGES, codeOfAssistantError, codeOfErrorText, codeOfStatus, firstLineOf, isoFromEpoch, type ApiErrorCode } from "./apiErrors.js";
import { codeOfStartFailure, redactDetail, START_FAILURE_MESSAGES, type StartFailureCode } from "./cliRecords.js";
import { extensionQueryOptions } from "./extensions.js";
import { chromeEnabledByDefault } from "./localSettings.js";
import { detectTestOutcome, keptOutput, PREVIEW_CHARS } from "./toolOutput.js";
import { AGENT_REPORT_KEPT_CHARS, cleanAgentReport } from "./agentReport.js";
import { toolLabel } from "./toolLabel.js"; // MARK: wave4b w4b-agents
// MARK: wave3 engine-session
import { StallWatchdog } from "./startWatch.js";
import type { StartProgress } from "./events.js";
// MARK: wave4 w4-longwork
import { clampMaxTurns, hookFailureNotice, hookTerminalNotice, informationalNotice, maxTurnsNotice, maxTurnsOption, rateLimitWindowsOf, type LongWorkNotice } from "./longWork.js";
// MARK: wave4b w4b-auto
import { autoModeDeniedNotice, autoModeRefusal, autoModeUnavailableNotice, type AutoModeNotice } from "./autoMode.js";
// MARK: wave4d w4d-agents2 — §42.4
import type { ModelCost } from "../protocol.js";
import { modelCostDelta } from "./modelCost.js";
import type { StatusUsage } from "../statusline/input.js"; // MARK: wave6 w6-statusline (§44.2)
import type { AutoTurnInfo, BackgroundTask } from "../protocol.js"; // §52
import { envTruthy, liveTasksOf, outputPathOf, taskKind } from "./background.js"; // §52

/** What a session needs from the client settings (`Settings` minus the PR / toolchain fields). */
export type SessionSettings = {
  budget: Budget;
  ignorePatterns: string[];
  autoAllowTools: string[];
  loadUserSettings: boolean;
  systemPromptAppend: string;
  model?: string;
  /** Read-only Bash commands run without a prompt (default true; docs/M16-FRICTION.md §1). */
  autoAllowReadOnlyBash?: boolean;
  /** Claude-style allow patterns (`Bash(npm test:*)`, `Bash(git *)`) evaluated before `ask` (§2). */
  bashAllowPatterns?: string[];
  /** Mode the session starts in (docs/M20-MODES.md; default `"default"`). */
  permissionMode?: PermissionMode;
  /** MARK: wave6 w6-terminal — §44.1: with `permissionMode: "plan"`, the mode before it (a chat restarted in plan mode). */
  prePlanMode?: PermissionMode;
  /** Plugin ids (`name@marketplace`) kept off through the flag settings (§16). */
  disabledPlugins?: string[];
  /** Flag `disableAllHooks`: settings-file + plugin hooks off; ReviewGate's SDK hooks still run (§16). */
  disableUserHooks?: boolean;
  /** With user settings loaded: emit `init_timeout` when the CLI has not initialized after this many ms (0/absent = off). */
  initTimeoutMs?: number;
  /** Non-fatal `error{code:"cli_start_slow"}` when the CLI has not initialized after this many ms (default 8000; 0 = off). */
  startSlowHintMs?: number;
  resumeSessionId?: string;
  /** Pre-chosen id for a NEW session (`--session-id`; ignored when `resumeSessionId` is set unless `forkSession`). */
  sessionId?: string;
  /** §26 rewind: with `resumeSessionId`, start a fork of that session (new id `sessionId`) cut after this chain uuid. */
  forkAt?: string;
  /** Reasoning effort the session starts with (§25; the SDK's `effort` option). */
  effort?: EffortLevel;
  /**
   * §29: the flag setting `crossSessionInbound` — `hold` parks messages from the user's other Claude sessions until the
   * engine releases them (`releasePeers`), `refuse` turns them away. Set → also `--replay-user-messages` (the peer body).
   */
  crossSessionInbound?: "hold" | "refuse";
  /** §29: `--name`: how this session is listed to the user's other sessions (and in `/resume`). */
  sessionName?: string;
  /** §29: how long `releasePeers` / `dismissPeers` wait for the CLI's frames (default 3000 ms; test seam). */
  peerReleaseTimeoutMs?: number;
  /** §33.4: Workflow / isolated agents get a card instead of a deny. */
  allowWorktreeIsolation?: boolean;
  /** §33.5: the user's Claude Code allow / deny+ask rules (applied to tools that cannot change files). */
  userRules?: UserRules;
  /** MARK: wave3 engine-session — §36.6: `settingSources` + "local" (`.claude/settings.local.json`, local-scope MCP servers). */
  loadLocalSettings?: boolean;
  // MARK: wave4 w4-longwork
  /** §38.2: the CLI's `maxTurns` (round trips of one message; 0 / unset = no limit, the default; else clamped to 10–1000). */
  maxTurns?: number;
  /** §52: background tasks on (default) and turns Claude starts itself taken as review turns; false: the §18 behavior. */
  backgroundWork?: boolean;
  /**
   * §52.2: subagents finish inside the turn that started them (every Agent / Task call gets `run_in_background: false`), as
   * before 0.6. Off (the default): they run as in the terminal — in the background unless Claude says not — and the main
   * agent answers meanwhile. Only with background work on (off, every subagent runs in the turn anyway).
   */
  subagentsInTurn?: boolean;
};

/** An image content block of a user message (§24). */
export type SessionImage = { mediaType: ImageMediaType; dataBase64: string };

export type ClaudeSessionOptions = {
  cwd: string;
  settings: SessionSettings;
  /** Absolute path of the `claude` executable (or npm `.cmd` shim on Windows). */
  claudePath: string;
  /** Merged over `process.env` for the CLI child (PATH from the client). */
  env: Record<string, string | undefined>;
  platform: Pick<Platform, "killTree" | "isWindows">;
  /** Live set of `permission_response { remember: true }` keys (bashClass.ts rememberKey); owned by the engine. */
  rememberedAllows?: ReadonlySet<string>;
  /** §34.9: the live `settings.testCommandPatterns` (read for every Bash result); owned by the engine. */
  testCommandPatterns?: () => readonly string[];
  emit: (event: SessionEvent) => void;
  log: SessionLog;
  /** Test seam: stands in for the SDK's `query` (default the real one). */
  queryFn?: typeof query;
  // MARK: wave4d w4d-peers
  /** §42.2: the live session a SendMessage `to` address reaches (the user's session registry); owned by the engine. */
  resolvePeer?: (address: string) => Promise<PeerSessionInfo | null>;
  /** MARK: r1-git — §46: repo-relative paths still under review (the hooks' git card); owned by the engine. */
  reviewPaths?: () => ReadonlySet<string>;
};

// MARK: wave4d w4d-peers
/** §42.2: a registry lookup slower than this leaves the SendMessage card without the receiving session's name. */
const PEER_LOOKUP_MS = 400;
/** §42.2 (audit peer-08): the SDK's provenance of keyboard input — absent, the CLI treats a message as unattributed. */
const HUMAN_ORIGIN = { kind: "human" } as const;

/** The permission settings a running session takes live (`set_settings`). */
export type PermissionSettings = Pick<SessionSettings, "autoAllowReadOnlyBash" | "bashAllowPatterns" | "userRules">;

/** The surface `ReviewEngine` drives; `FakeClaudeSession` in tests implements it too. */
export interface ClaudeSessionLike {
  start(): Promise<void>;
  /** `images` (§24) go out as image content blocks before the text. */
  sendUser(text: string, checkpointTree?: string, images?: readonly SessionImage[]): void;
  /**
   * §50: a message into the turn that runs — the CLI hands it to Claude once the current tool call is done, as in the
   * terminal; a turn that ended meanwhile runs it as its own command, still one review turn. Absent on doubles without it.
   */
  steerUser?(text: string): void;
  interrupt(): Promise<void>;
  respondPermission(requestId: string, allow: boolean, message?: string, updatedInput?: Record<string, unknown>): void;
  setBudget(budget: Budget): void;
  /** Applies `autoAllowReadOnlyBash` / `bashAllowPatterns` to the running session. */
  setPermissionSettings(settings: PermissionSettings): void;
  /** Switches the permission mode of the running session (`query.setPermissionMode`; docs/M20-MODES.md). */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Aborts the query and kills the CLI child (≤ 2.5s); no events after it resolves except `closed`. */
  dispose(): Promise<void>;
  readonly isTurnActive: boolean;
  /** The CLI child's pid once spawned (§31: never reported as another Claude in the worktree); optional for test doubles. */
  readonly pid?: number;
  /** §22 MCP management of the live session (optional: test doubles may not implement it). */
  mcpServerStatus?(): Promise<McpServerStatus[]>;
  reconnectMcpServer?(name: string): Promise<void>;
  toggleMcpServer?(name: string, enabled: boolean): Promise<void>;
  setMcpServers?(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  /** §25: `Query.setModel` (null = the CLI's default model). */
  setModel?(model: string | null): Promise<void>;
  /** §25: the flag-settings `effortLevel` (null = the model's default). */
  setEffort?(effort: EffortLevel | null): Promise<void>;
  /**
   * §29: lets every held peer message through as this session's own turn (the review gate collects it like a send):
   * `crossSessionInbound` accept, straight back to hold; resolves with the ids the CLI released (rejects when none was).
   */
  releasePeers?(ids: readonly string[], checkpointTree?: string): Promise<string[]>;
  /** §29: turns every held peer message away (refuse, then back); resolves with the ids the CLI dropped. */
  dismissPeers?(ids: readonly string[]): Promise<string[]>;
  /** §29: the live `crossSessionInbound` (hold / refuse). */
  setPeerInbound?(value: "hold" | "refuse"): Promise<void>;
  /** MARK: wave2 check-engine — §35.7: the MCP tool annotations the hooks judge with (the engine answers the queue alike). */
  readonly mcpToolHints?: McpToolHints;
  /** MARK: wave3 engine-agents — §36.2: stops one running task (a subagent, by its task id); the turn goes on. */
  stopTask?(taskId: string): Promise<void>;
  /** §52: Ctrl+B — `Query.backgroundTasks(toolUseId)`; true when a task moved. Rejects when background work is off. */
  backgroundTasks?(toolUseId?: string): Promise<boolean>;
  /** §52: the output file the CLI named for a background task (null: none known / not a task of this process). */
  taskOutputFile?(taskId: string): string | null;
  /** §52: whether that background task is still live. */
  isTaskLive?(taskId: string): boolean;
  /** §52: background work is on in this process (the setting, and no `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` in the environment). */
  readonly backgroundWorkOn?: boolean;
  /**
   * §52: the engine's answer to `auto_turn_start` — true: the turn is a review turn (snapshot A taken; the calls waiting
   * go on); false: §18 applies (its changes are denied).
   */
  autoTurnReady?(ok: boolean, checkpointTree?: string): void;
  /** MARK: wave6 w6-statusline — §44.2: what the status line's stdin takes from the live session (optional: test doubles). */
  readonly statusUsage?: SessionStatusUsage;
}

/**
 * MARK: wave6 w6-statusline — §44.2: the last main-agent API answer's usage and model (`context_window.current_usage`,
 * `model.id`) and the session's API time so far (`cost.total_api_duration_ms`, the results' `duration_api_ms`).
 */
export type SessionStatusUsage = { usage: StatusUsage | null; model: string | null; apiDurationMs: number };

/** A file the turn's calls touched: the tools, how often, and the calls that changed it (§12). */
type TouchedFile = { path: string; tools: Set<string>; count: number; toolUseIds: string[] };

/** `cancelled`: the session answered it itself (abort, interrupt) — reported as `permission_cancelled` (§33). */
type PendingPermission = { resolve: (r: PermissionResult, cancelled?: boolean) => void; outsideFile?: string };

const SUBAGENT_TOOL_RE = /^(Agent|Task)$/;
/** Tools §33.4 decides on (EnterWorktree, Workflow, isolated agents). */
const WORKTREE_TOOLS_RE = /^(EnterWorktree|Workflow|Agent|Task)$/;
const DETAIL_KEY_RE = /"(file_path|notebook_path|command|skill|pattern|query|url|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
/** Edit tools are auto-allowed here; the PreToolUse budget hook still gates them. */
const AUTO_ALLOW_RE = new RegExp(`^(${EDIT_TOOLS_MATCHER})$`);

/** The CLI's plan-mode exit tool; handled by `canUseTool`, never shown as a permission card (docs/M20-MODES.md). */
const EXIT_PLAN_MODE_TOOL = "ExitPlanMode";
export const EXIT_PLAN_MODE_DENY = "Plan received. The user approves plans in ReviewGate; stay in plan mode and wait.";
const DISPOSE_CAP_MS = 2500;
/** `tool_use.rationale` cap: the last N chars of the preceding text block. */
export const RATIONALE_CHARS = 400;
/** §34.8: an Agent / Task result kept as the subagent's report (its first N chars). */
export const AGENT_REPORT_CHARS = 4000;
const KILL_AFTER_ABORT_MS = 1000;
/** Each post-initialize probe (`getContextUsage`, `mcpServerStatus`) gives up after this long. */
const PROBE_TIMEOUT_MS = 5000;
/** Default of `SessionSettings.startSlowHintMs`. */
export const START_SLOW_HINT_MS = 8000;
/** §29: default of `SessionSettings.peerReleaseTimeoutMs` (the CLI answers a flag switch in ~40 ms). */
export const PEER_RELEASE_TIMEOUT_MS = 3000;
/** §29: own message uuids remembered for routing (the CLI echoes them in `command_lifecycle` / `result`). */
const MAX_OWN_COMMANDS = 200;
/** §52.2: calls remembered until their result (`openCalls`) — a call that never got one is forgotten oldest first. */
const MAX_OPEN_CALLS = 2000;
/** §29: a review turn over several released peer messages ends when the next one has not started this long after a result. */
const PEER_TURN_GAP_MS = 10_000;

/**
 * One Claude Code streaming session: the query driver around `@anthropic-ai/claude-agent-sdk`.
 * Emits `SessionEvent`s through `emit`; never touches stdout or exits the process.
 */
export class ClaudeSession implements ClaudeSessionLike {
  private readonly opts: ClaudeSessionOptions;
  private readonly inbox = new AsyncQueue<SDKUserMessage>();
  private readonly abortController = new AbortController();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly budget: BudgetState;
  private readonly hookCtx: HookContext;
  private autoAllowTools: Set<string>;

  private q: Query | undefined;
  /** The `claude` CLI child (spawned by us so dispose can force-kill it; see spawnClaude). */
  private cliChild: ChildProcess | undefined;
  private currentSessionId: string | undefined;
  private currentModel: string | undefined;
  private turnActive = false;
  private interruptRequested = false;
  private disposing = false;
  private disposed: Promise<void> | undefined;
  private closedEmitted = false;
  /** Keyed by `normalizeForCompare` (one entry per file however it was spelled); `path` is the first spelling seen. */
  private turnToolFiles = new Map<string, TouchedFile>();
  /**
   * Files edit tools touched since the last post-Bash snapshot (`normalizeForCompare` keys): a file the
   * snapshot sees changed is attributed to that Bash call only when no edit tool touched it in between.
   */
  private editsSinceBash = new Set<string>();
  /** Bash tool_use id → command (+ backgrounded) for `tool_result.testOutcome`. */
  private bashCalls = new Map<string, { command: string; background: boolean }>();
  /** API message id → its latest text block (subagents included): the `rationale` of the tool_use blocks after it. */
  private lastTextByMessage = new Map<string, string>();
  /**
   * Agent (parent tool_use id, "" for the main agent) → its latest text block this turn: the `rationale`
   * of a call in a message without text. Real CLIs (2.1.303) mostly explain, Read, then Edit in a separate
   * API message, so the same-message rule alone left nearly every edit without a why.
   */
  private lastTextByAgent = new Map<string, string>();
  /** §34.8: agent (as in `lastTextByAgent`) → its tool calls since its latest text block (`tool_use.rationaleAge`). */
  private callsSinceText = new Map<string, number>();
  /** Edits outside the checkpoint root the user approved this turn (absolute paths). */
  private turnChangedOutside = new Set<string>();
  /** Model context window (tokens) from the last `result.modelUsage`; sent with turn_end. */
  private contextWindow: number | undefined;
  /** `result.total_cost_usd` is cumulative across turns of a streaming session; turn_end.usage.costUsd is the delta. */
  private lastTotalCostUsd = 0;
  // MARK: wave4d w4d-agents2 — §42.4
  /** `result.modelUsage` of the last owned result (cumulative like the total): turn_end.usage.models is the delta. */
  private lastModelUsage: ReadonlyMap<string, ModelCost> = new Map();
  /** Agent (its Agent / Task tool_use id) → the model its answers came from, as last reported (`agent_model`). */
  private agentModels = new Map<string, string>();
  /** API-failure codes already reported this turn (one `error` per code per turn). */
  private reportedApiErrors = new Set<string>();
  /** `code|resetAt` of the last reported `rate_limit_event` rejection (reported once per window). */
  private lastLimitKey = "";
  /** MARK: wave4 w4-longwork — §38.2: a `hook_blocked` notice went out this turn (the result's terminal reason adds none). */
  private hookBlockedThisTurn = false;
  /**
   * MARK: wave4c w4c-trust — §41.2: a prompt / stop hook's block this turn was already one row — from its `hook_response`
   * (`named`) or the CLI's `informational{prevent_continuation}` (`cli`); the other report of the same block adds none.
   */
  private continuationBlock: "named" | "cli" | null = null;
  /** The CLI's last stderr bytes (≤ 2 KB), consulted when the query loop dies. */
  private stderrTail = "";
  /** §30: the CLI answered initialize (`session_ready` went out): a death from here on is a crash, not a start failure. */
  private initialized = false;
  /** §30: how the CLI child ended (`close`), and a promise for it (its last stderr chunk can land after `exit`). */
  private cliExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private cliClosed: Promise<void> | null = null;
  /** §30: `errors[]` of an error result the CLI sent before initialize (`--resume` of an unknown id): never a turn. */
  private startFailureText = "";
  // ---- §29 peer messages / turn ownership (command uuids)
  /** Uuids stamped on the messages this session sent (≤ MAX_OWN_COMMANDS): `command_lifecycle` / `result` echo them. */
  private readonly ownCommands = new Set<string>();
  /** Held peer messages released into the current turn (`releasePeers`): that turn is ours. */
  private releasedPeers = new Set<string>();
  /** §50: our messages put into the running turn (`steerUser`): like released peers, they belong to it. */
  private steered = new Set<string>();
  /** Released peer messages whose command started / delivered its body this turn. */
  private peerStarted = new Set<string>();
  private peerDelivered = new Set<string>();
  /** `releasePeers` is switching the flag: a `released` frame now is ours, whatever its id. */
  private releasing = false;
  /** Commands the CLI started that are not ours (lifecycle `started` → a terminal state). */
  private readonly externalCommands = new Set<string>();
  /** The command of ours (own message / released peer) the CLI is running (lifecycle). */
  private ownRunning: string | null = null;
  /** The CLI sends `command_lifecycle` frames (CLI 2.1.30x does): turn ownership is exact. */
  private sawLifecycle = false;
  /** Usage of the earlier results of a review turn that spans several released peer messages. */
  private peerTurnUsage: { inputTokens: number; outputTokens: number; durationMs: number } | null = null;
  private peerTurnDeferred: { sessionId: string; subtype: string; totalCostUsd: number; modelUsage?: Record<string, unknown> } | null = null;
  private peerTurnTimer: NodeJS.Timeout | null = null;
  /** The external turn running now already reported its peer message (from the echo): its result does not again. */
  private externalPeerSeen = false;
  /** What `releasePeers` / `dismissPeers` wait for. */
  private peerWaiters: { state: "released" | "dropped"; ids: Set<string>; got: string[]; done: () => void }[] = [];
  /** The live `crossSessionInbound` (what a release / refuse switches back to). */
  private inbound: "hold" | "refuse" | undefined;
  /** input + cache_read + cache_creation of the last top-level assistant message of the turn (= context size). */
  private turnContextUsage = { contextTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  // MARK: wave6 w6-statusline — §44.2
  private lastMainUsage: StatusUsage | null = null;
  private lastMainModel: string | null = null;
  private apiDurationTotal = 0;
  /** MARK: wave4c w4c-commit — §41.1: this turn's `compact_boundary` (`turn_end.usage.compacted`). */
  private turnCompacted: TurnCompaction | undefined;
  /** tool_use id → tool name for this turn (activity tool_end / subagent_end need the name). */
  private turnToolNames = new Map<string, string>();
  /**
   * tool_use ids of intercepted `ExitPlanMode` calls: the CLI's deny response still arrives as an
   * ordinary `tool_result { is_error: true }`, which would render as a red "tool error" row right
   * under the plan card. Both the `tool_use` and the matching `tool_result` are swallowed (M20 follow-up);
   * everything else about the turn — `plan_exit`, the deny sent to the CLI, HUD activity — is unchanged.
   */
  private suppressedToolUseIds = new Set<string>();
  /** tool_use ids of Agent/Task calls still running. */
  private activeSubagents = new Set<string>();
  /** Top-level tool_use block whose input JSON is still streaming and has not yielded a detail yet. */
  private streamingTool: { name: string; json: string } | undefined;
  /**
   * Top-level text streamed per API message id: one entry per text block (opened at `content_block_start`,
   * grown by `text_delta`), in order. The `assistant` message re-delivers each block in full; only what was
   * not streamed is emitted from it — everything for messages the CLI never streams (built-in slash commands
   * such as `/help` / `/context` / `/compact` answer with a `<synthetic>` assistant message and no stream events).
   */
  private streamedText = new Map<string, string[]>();
  /** `message.id` of the API message whose stream events are arriving (from `message_start`). */
  private streamingMessageId = "";
  /** Chain uuid of the turn's last top-level assistant message (`turn_end.lastUuid`, the side-question fork point, §21). */
  private turnLastUuid: string | undefined;
  /** §33.5: MCP tool annotations seen in `mcpServerStatus()` answers (the engine polls them every 10 s, §22). */
  readonly mcpToolHints = new Map<string, { readOnly?: boolean; destructive?: boolean }>();
  /** MARK: wave3 engine-session — §36.7: the init watchdog while the CLI starts (restarted by every progress signal). */
  private initWatchdog: StallWatchdog | null = null;
  // MARK: wave4b w4b-auto (§39.5)
  /** tool_use id → input of this turn's calls while in auto mode: the row of a call the classifier blocks names it. */
  private autoCallInputs = new Map<string, Record<string, unknown>>();
  /** The session asked for auto mode and the CLI runs another one: said once per session (`auto_mode_unavailable`). */
  private autoUnavailableNoticed = false;
  /** MARK: wave6 w6-terminal — §44.1: `setPermissionMode` is waiting for the CLI (its own mode report is no news). */
  private modeSwitching = false;
  // ---- §52 background work
  /** Background tasks on in this process (setting, environment). */
  private bgOn = false;
  /** The live background tasks (`background_tasks_changed`, oldest first) with what `task_started` added. */
  private bgTasks = new Map<string, BackgroundTask>();
  /** task id → its output file; Bash tool_use id → the output file its result named. */
  private bgOutputFiles = new Map<string, string>();
  private bgOutputByCall = new Map<string, string>();
  /** task_started details that came before (or without) the list's entry. */
  private bgStarted = new Map<string, { toolUseId: string | null }>();
  /** task id → the tool call that started it (every `task_started`). */
  private taskCalls = new Map<string, string | null>();
  /** The last background task notification since our last turn ended (`auto_turn.task`). */
  private bgNotice: NonNullable<AutoTurnInfo["task"]> | null = null;
  /** A turn of ours has run in this process (a turn the CLI starts before that is never taken). */
  private hadOwnTurn = false;
  /** §52: the engine is taking a turn the CLI started (every call waits for `ready`). */
  private adopting: { resolve: () => void; commandUuid: string | null } | null = null;
  // ---- §52.2 subagents in the background
  /**
   * Live subagents that work in the background (task id → the task they run under, null at the top): every `local_agent`
   * task started — or moved — to the background, and every agent task started under one of them. Their calls are no
   * unprompted turn (hooks.ts `backgroundAgent`).
   */
  private bgAgents = new Map<string, string | null>();
  /** Every subagent task id this process started (`task_started` of a `local_agent`). */
  private agentTaskIds = new Set<string>();
  /** Agent / Task calls whose background subagent's own result went out (`emitAgentEnd`): once per call. */
  private agentEndedCalls = new Set<string>();
  /** Agent / Task tool_use id → the call it ran under (its assistant message's `parent_tool_use_id`; null at the top). */
  private agentCallParents = new Map<string, string | null>();
  /** Agent / Task tool_use id → the task id the CLI gave it (`task_started`). */
  private agentTaskOfCall = new Map<string, string>();
  /**
   * What edit tools and Bash calls changed while no turn of ours ran (a background subagent's work): kept for the next
   * turn, whose review holds them (A is kept, §52.1) — with these calls as their cause.
   */
  private idleToolFiles = new Map<string, TouchedFile>();
  /**
   * Every call whose result has not come yet: its name and the agent call it runs under (null on the main thread) — a
   * subagent's call can end after its turn did, and only a subagent works on while no turn of ours runs.
   */
  private openCalls = new Map<string, { name: string; parent: string | null }>();
  /**
   * Our sent messages (`sendUser`) whose command has not started: a `result` the CLI sends before it (a turn it ran
   * itself while ours waited in its queue — a background task's notification, a subagent's hand-back) is not our turn's end.
   */
  private queuedOwn = new Set<string>();

  constructor(opts: ClaudeSessionOptions) {
    this.opts = opts;
    this.budget = new BudgetState(opts.settings.budget);
    this.autoAllowTools = new Set(opts.settings.autoAllowTools);
    this.hookCtx = {
      budget: this.budget,
      cwd: opts.cwd,
      ignorePatterns: opts.settings.ignorePatterns,
      autoAllowTools: this.autoAllowTools,
      autoAllowReadOnlyBash: opts.settings.autoAllowReadOnlyBash,
      bashAllowPatterns: opts.settings.bashAllowPatterns ?? [],
      rememberedAllows: opts.rememberedAllows,
      permissionMode: opts.settings.permissionMode ?? "default",
      // MARK: wave6 w6-terminal — §44.1
      ...(opts.settings.permissionMode === "plan" && opts.settings.prePlanMode && opts.settings.prePlanMode !== "plan" ? { prePlanMode: opts.settings.prePlanMode } : {}),
      onCliMode: (mode) => this.followCliMode(mode),
      plansDir: plansDir(),
      planFiles: new Set<string>(),
      scratchDirs: defaultScratchDirs(),
      turnActive: false,
      allowWorktreeIsolation: opts.settings.allowWorktreeIsolation === true,
      ...(opts.settings.userRules ? { userRules: opts.settings.userRules } : {}),
      mcpToolHints: this.mcpToolHints,
      scopeReasons: new Map(),
      onScopeNotice: (notice) => this.emit({ type: "scope_notice", ...notice }),
      onOutsideEdit: (file) => this.turnChangedOutside.add(file), // §8 / §39.5: an edit the review does not see
      onUnprompted: (toolName) => this.onUnprompted(toolName),
      onBashFiles: (toolUseId, files) => this.attributeBashFiles(toolUseId, files),
      onBashSnapshot: (toolUseId, tree, root) => this.emit({ type: "bash_snapshot", toolUseId, tree, root }),
      ...(opts.reviewPaths ? { reviewPaths: opts.reviewPaths } : {}), // MARK: r1-git (§46)
      onGitCommand: (result) => this.emit({ type: "git_result", ...result }), // MARK: r1-git (§46)
      toolWindows: new Map(),
      emit: (m) => this.emit(m),
      log: opts.log,
    };
  }

  get isTurnActive(): boolean {
    return this.turnActive;
  }

  get pid(): number | undefined {
    return this.cliChild?.pid;
  }

  /** MARK: wave6 w6-statusline — §44.2 */
  get statusUsage(): SessionStatusUsage {
    return { usage: this.lastMainUsage ? { ...this.lastMainUsage } : null, model: this.lastMainModel, apiDurationMs: this.apiDurationTotal };
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (this.q) throw new Error("session already started");
    const s = this.opts.settings;
    const loadUserSettings = s.loadUserSettings !== false;
    this.inbound = s.crossSessionInbound;
    const ext = extensionQueryOptions({ loadUserSettings, loadLocalSettings: s.loadLocalSettings === true, disabledPlugins: s.disabledPlugins, disableUserHooks: s.disableUserHooks, crossSessionInbound: s.crossSessionInbound });
    // §29: the peer message's body arrives with the CLI's echo of the user message (`origin.kind: "peer"`).
    const extraArgs: Record<string, string | null> = {
      ...(s.crossSessionInbound ? { "replay-user-messages": null } : {}),
      ...(s.sessionName ? { name: s.sessionName } : {}),
    };
    const env: Record<string, string | undefined> = { ...process.env, ...this.opts.env };
    // CLI 2.1.303 runs every Agent call as a background task in a streaming-input (SDK) session
    // (task_started.is_backgrounded: true without run_in_background): the main turn can end while the
    // subagent still edits, and the CLI then continues on its own with another `result` — edits made
    // after our turn_end never reach the review and the next send's snapshot A swallows them. Subagents
    // and Bash must run inside the turn the gate collects, so background tasks are off unless the
    // environment explicitly says otherwise (verified: is_backgrounded false, one result per send).
    // §52: with background work on (the default) they run as in the terminal, and a turn the CLI starts itself afterwards is
    // taken as a review turn. §52.2: so do subagents — the main agent answers while they work, their calls pass the §18
    // guard, what they change reaches the next review; `subagentsInTurn` (opt-in) keeps them in the turn as before.
    if (s.backgroundWork === false) env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ??= "1";
    this.bgOn = !envTruthy(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);
    this.hookCtx.keepAgentsInTurn = this.bgOn && s.subagentsInTurn === true;
    this.hookCtx.backgroundAgent = (agentId) => this.isBackgroundAgent(agentId);
    // MARK: wave3 engine-flow — §36.13: `/code-review` in this chat reports its findings through ReportFindings (a
    // read-only tool, hooks.ts) and the engine shows them on the diff lines; an explicit value in the environment wins.
    env.CLAUDE_CODE_REPORT_FINDINGS ??= "1";
    const exe = resolveClaudeExecutable(this.opts.claudePath, this.opts.platform.isWindows);
    // §36.6: Claude in Chrome as in the terminal — on when Claude Code's own "Enabled by default" is. Not without user
    // settings: the §36.7 fallback starts bare, and the Chrome connection is one more thing that could hold the start.
    if (loadUserSettings && chromeEnabledByDefault(env)) extraArgs.chrome = null;

    this.q = (this.opts.queryFn ?? query)({
      prompt: this.inbox,
      options: {
        cwd: this.opts.cwd,
        abortController: this.abortController,
        pathToClaudeCodeExecutable: exe.path,
        ...(exe.executable ? { executable: exe.executable as "node", executableArgs: [] } : {}),
        // The client's text, then the engine's own instructions: stay in this folder, no worktrees (§33.4); git when asked (§46).
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: [s.systemPromptAppend, scopeInstruction(this.opts.cwd, s.allowWorktreeIsolation === true), GIT_INSTRUCTION].filter((t) => t.trim()).join("\n\n"),
        },
        permissionMode: s.permissionMode ?? "default",
        // loadUserSettings (default): ~/.claude/settings.json too, so the user's skills, plugins,
        // slash commands and MCP servers exist in app sessions. Its `permissions.allow` rules would
        // bypass canUseTool, so the PreToolUse hooks return `ask` for every non-edit/non-read-only
        // tool (hooks.ts needsAsk) — that runs before rule evaluation and forces the prompt.
        // `.claude/settings.local.json` loads with `loadLocalSettings` (§36.6; its allow rules are bypassed the same
        // way). See docs/PROTOCOL.md "Settings".
        // disabledPlugins / disableUserHooks ride on the flag-settings layer (extensions.ts).
        settingSources: ext.settingSources,
        ...(ext.skills ? { skills: ext.skills } : {}),
        ...(ext.settings ? { settings: ext.settings } : {}),
        includePartialMessages: true,
        // task_progress carries a model-written one-line summary per running subagent (state.hud.agents).
        agentProgressSummaries: true,
        // §34.8: a subagent's text (and thinking) blocks arrive as assistant messages with parent_tool_use_id — the
        // rationale of its own calls and its report; without it only its tool_use / tool_result blocks do. Never streamed.
        forwardSubagentText: true,
        ...maxTurnsOption(s.maxTurns), // MARK: wave4 w4-longwork — §38.2 (was a fixed 60; none — no cap — unless the user sets one)
        // MARK: wave4 w4-longwork — §38.2: every hook's started / response, so a failing hook reaches the chat (SessionStart's come anyway).
        includeHookEvents: true,
        hooks: buildHooks(this.hookCtx),
        canUseTool: this.canUseTool,
        resume: s.resumeSessionId,
        // §26: a rewind forks the session at a chain uuid into a new, pre-named session.
        ...(s.resumeSessionId && s.forkAt ? { forkSession: true, resumeSessionAt: s.forkAt, ...(s.sessionId ? { sessionId: s.sessionId } : {}) } : {}),
        ...(!s.resumeSessionId && s.sessionId ? { sessionId: s.sessionId } : {}),
        model: s.model,
        ...(s.effort ? { effort: s.effort } : {}),
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
        env: exe.env ? { ...env, ...exe.env } : env,
        spawnClaudeCodeProcess: (o) => this.spawnClaude(o),
      },
    });
    void this.runLoop(this.q);
    // MARK: wave3 engine-session — §36.7: the local settings' hooks / MCP servers can hang a start as well.
    this.watchInitialization(this.q, loadUserSettings || s.loadLocalSettings === true ? s.initTimeoutMs ?? 0 : 0);
    this.watchCommands(this.q); // MARK: wave3 engine-session (§36.5)
  }

  /**
   * MARK: wave3 engine-session — §36.7: a progress signal while the CLI starts (it runs SessionStart hooks, installs plugins
   * before it answers initialize): the stall watchdog starts over and the engine learns what the start waits on. After
   * initialize the same messages (a SessionStart hook after a compaction) are ignored as before.
   */
  private onStartProgress(p: StartProgress, subtype: string): void {
    if (this.initialized || !this.q) {
      this.opts.log("debug", `system message ignored: ${subtype}`);
      return;
    }
    this.initWatchdog?.restart();
    if (!this.disposing) this.emit({ type: "start_progress", ...p });
  }

  /** MARK: wave3 engine-session — §36.5: the commands (description, argument hint) once the CLI answered initialize: no message needed. */
  private watchCommands(q: Query): void {
    const init = typeof q.initializationResult === "function" ? q.initializationResult() : null;
    init?.then(
      (r) => {
        const commands = (r as { commands?: unknown } | undefined)?.commands;
        if (!this.disposing && Array.isArray(commands)) this.emit({ type: "commands_info", commands });
        const agents = (r as { agents?: unknown } | undefined)?.agents; // MARK: wave4d w4d-config (§42.3)
        if (!this.disposing && Array.isArray(agents)) this.emit({ type: "agents_info", agents });
      },
      () => undefined,
    );
  }

  /**
   * The CLI answers the SDK's initialize request once settings, plugins and MCP config are loaded;
   * a user extension that hangs there leaves the session dead in the water. With user settings
   * loaded, `init_timeout` tells the engine to restart without them (§16). Once initialized, the
   * loaded memory files and MCP status are probed (best effort, ≤ 5 s each) → `extensions_info`.
   */
  private watchInitialization(q: Query, timeoutMs: number): void {
    let settled = false;
    // MARK: wave3 engine-session — §36.7: a stall timer — every progress signal of the start restarts it (onStartProgress).
    const timer = timeoutMs > 0
      ? new StallWatchdog(timeoutMs, () => {
          if (!settled && !this.disposing) this.emit({ type: "init_timeout", afterMs: timeoutMs });
        })
      : undefined;
    this.initWatchdog = timer ?? null;
    const init = typeof q.initializationResult === "function" ? q.initializationResult() : null;
    if (!init) {
      timer?.stop();
      this.initWatchdog = null;
      this.markInitialized(); // nothing to wait for (a query without the handshake): never a start failure
      return;
    }
    // A hint only (§19.6): the session keeps waiting; `init_timeout` above is what restarts it.
    const slowMs = this.opts.settings.startSlowHintMs ?? START_SLOW_HINT_MS;
    const slow = slowMs > 0
      ? setTimeout(() => {
          if (settled || this.disposing) return;
          this.emit({ type: "error", message: API_ERROR_MESSAGES.cli_start_slow, fatal: false, code: "cli_start_slow" });
        }, slowMs)
      : undefined;
    slow?.unref?.();
    const done = () => {
      settled = true;
      timer?.stop();
      if (this.initWatchdog === timer) this.initWatchdog = null;
      if (slow) clearTimeout(slow);
    };
    init.then(
      () => {
        done();
        this.markInitialized();
        void this.probeExtensions(q);
      },
      () => done(),
    );
  }

  /** §30: the CLI accepted the start (initialize answered) → `session_ready`, once. */
  private markInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.disposing) this.emit({ type: "session_ready" });
  }

  /** Waits (≤ 500 ms) for the CLI child's `close`: its last stderr chunk and exit status land there. */
  private async cliSettled(): Promise<void> {
    if (this.cliClosed) await Promise.race([this.cliClosed, new Promise<void>((r) => setTimeout(r, 500).unref?.())]);
  }

  /** §30: why the CLI refused to start, from its own words — only before initialize (a start failure). */
  private startFailure(thrown?: string): StartFailureCode | null {
    if (this.initialized) return null;
    return codeOfStartFailure(thrown) ?? codeOfStartFailure(this.stderrTail) ?? codeOfStartFailure(this.startFailureText);
  }

  /** §30: `detail` (stderr's first line, masked) / `exitCode` / `signal` for a fatal session error. */
  private exitDetails(): { detail?: string; exitCode?: number | null; signal?: string | null } {
    const detail = redactDetail(this.stderrTail);
    return { ...(detail ? { detail } : {}), ...(this.cliExit ? { exitCode: this.cliExit.code, signal: this.cliExit.signal } : {}) };
  }

  private async probeExtensions(q: Query): Promise<void> {
    const within = <T>(p: Promise<T> | undefined): Promise<T | undefined> =>
      p ? Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), PROBE_TIMEOUT_MS).unref?.())]) : Promise.resolve(undefined);
    const [usage, mcp, models] = await Promise.all([
      within(typeof q.getContextUsage === "function" ? q.getContextUsage({ detail: "summary" }) : undefined),
      within(typeof q.mcpServerStatus === "function" ? q.mcpServerStatus() : undefined),
      within(typeof q.supportedModels === "function" ? q.supportedModels() : undefined),
    ]);
    if (this.disposing) return;
    this.noteMcpTools(mcp);
    if (Array.isArray(models)) this.emit({ type: "models_info", models });
    const memoryFiles = Array.isArray(usage?.memoryFiles) ? usage.memoryFiles.map((m) => ({ path: m.path, type: m.type, ...(typeof m.tokens === "number" ? { tokens: m.tokens } : {}) })) : undefined;
    const mcpServers = Array.isArray(mcp) ? mcp.map((m) => ({ name: m.name, status: m.status })) : undefined;
    if (memoryFiles === undefined && mcpServers === undefined) return;
    this.emit({ type: "extensions_info", ...(memoryFiles ? { memoryFiles } : {}), ...(mcpServers ? { mcpServers } : {}) });
  }

  sendUser(text: string, checkpointTree?: string, images: readonly SessionImage[] = []): void {
    if (!this.q) throw new Error("session not started");
    if (this.disposing) throw new Error("session closed");
    this.resetTurn();
    this.takeIdleWork(); // §52.2: what a background subagent changed since the last turn is this turn's
    this.reportedApiErrors = new Set();
    this.hookBlockedThisTurn = false; // MARK: wave4 w4-longwork
    this.continuationBlock = null; // MARK: wave4c w4c-trust
    this.hookCtx.checkpointTree = checkpointTree;
    this.hadOwnTurn = true;
    this.bgNotice = null;
    this.queuedOwn = new Set();
    this.setTurnActive(true);
    // Images first, then the text (the order the Messages API recommends); a text-only message stays a plain string.
    const content: SDKUserMessage["message"]["content"] = images.length === 0
      ? text
      : [
          ...images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.dataBase64 } })),
          { type: "text" as const, text },
        ];
    // §29: a uuid of our own — `command_lifecycle` / `result.user_message_uuid` tell this message's turn from anyone else's.
    const uuid = randomUUID();
    this.ownCommands.add(uuid);
    if (this.ownCommands.size > MAX_OWN_COMMANDS) this.ownCommands.delete(this.ownCommands.values().next().value!);
    // §52: a send that slipped in while a turn Claude started is being taken joins it — the turn waits for this command.
    if (this.adopting) this.steered.add(uuid);
    // §52.2: a turn the CLI runs itself before this command starts (a subagent's hand-back) does not end ours.
    this.queuedOwn.add(uuid);
    this.inbox.push({
      type: "user",
      uuid,
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.currentSessionId ?? "",
      origin: HUMAN_ORIGIN, // MARK: wave4d w4d-peers — §42.2: the user typed it (peers' messages carry their own origin)
    });
  }

  /** §50: see `ClaudeSessionLike.steerUser`. Only while our turn runs: the turn's end waits for this command (`peerTurnWaits`). */
  steerUser(text: string): void {
    if (!this.q) throw new Error("session not started");
    if (this.disposing) throw new Error("session closed");
    if (!this.turnActive) throw new Error("no turn is running");
    const uuid = randomUUID();
    this.ownCommands.add(uuid);
    if (this.ownCommands.size > MAX_OWN_COMMANDS) this.ownCommands.delete(this.ownCommands.values().next().value!);
    this.steered.add(uuid);
    this.inbox.push({
      type: "user",
      uuid,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.currentSessionId ?? "",
      origin: HUMAN_ORIGIN,
      // Into the running turn, said explicitly: without a priority the CLI's default (next or later) follows a flag of its own.
      priority: "next",
    });
  }

  // MARK: wave4d w4d-peers
  /** §42.2: whom a SendMessage reaches — the engine's registry lookup, bounded; null for a name, an unknown address, a failure. */
  private async peerRecipient(input: Record<string, unknown>): Promise<PeerSessionInfo | null> {
    const to = input.to;
    const resolve = this.opts.resolvePeer;
    if (typeof to !== "string" || !to || !resolve) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        resolve(to),
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), PEER_LOOKUP_MS);
        }),
      ]);
    } catch (e) {
      this.opts.log("warn", `SendMessage recipient lookup: ${String(e)}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    this.interruptRequested = true;
    // A permission card still open would hold the turn until answered: the interrupt answers it (deny).
    for (const p of [...this.pendingPermissions.values()]) p.resolve({ behavior: "deny", message: "Interrupted by user", interrupt: true }, true);
    try {
      await this.q.interrupt();
    } catch (e) {
      this.opts.log("warn", `interrupt failed: ${String(e)}`);
    }
  }

  respondPermission(requestId: string, allow: boolean, message?: string, updatedInput?: Record<string, unknown>): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      this.opts.log("warn", `permission_response for unknown requestId ${requestId}`);
      return;
    }
    if (allow) {
      if (pending.outsideFile) this.turnChangedOutside.add(pending.outsideFile);
      pending.resolve({ behavior: "allow", ...(updatedInput ? { updatedInput } : {}) });
    } else pending.resolve({ behavior: "deny", message: message ?? "Denied by user" });
  }

  setBudget(budget: Budget): void {
    this.budget.setBudget(budget);
  }

  setPermissionSettings(settings: PermissionSettings): void {
    if (settings.autoAllowReadOnlyBash !== undefined) this.hookCtx.autoAllowReadOnlyBash = settings.autoAllowReadOnlyBash;
    if (settings.bashAllowPatterns !== undefined) this.hookCtx.bashAllowPatterns = [...settings.bashAllowPatterns];
    if (settings.userRules !== undefined) this.hookCtx.userRules = { allow: [...settings.userRules.allow], block: [...settings.userRules.block] };
  }

  // ------------------------------------------------------------------ MCP (§22)

  private requireQuery(): Query {
    if (!this.q || this.disposing) throw new Error("session not started");
    return this.q;
  }

  mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.requireQuery().mcpServerStatus().then((list) => {
      this.noteMcpTools(list);
      return list;
    });
  }

  /** §33.5: keeps each MCP tool's readOnly / destructive annotations (the user's rules apply to read tools only). */
  private noteMcpTools(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const server of list as McpServerStatus[]) {
      if (!server || typeof server.name !== "string" || !Array.isArray(server.tools)) continue;
      for (const tool of server.tools) {
        if (!tool || typeof tool.name !== "string") continue;
        const a = tool.annotations;
        this.mcpToolHints.set(mcpToolName(server.name, tool.name), {
          ...(typeof a?.readOnly === "boolean" ? { readOnly: a.readOnly } : {}),
          ...(typeof a?.destructive === "boolean" ? { destructive: a.destructive } : {}),
        });
      }
    }
  }

  reconnectMcpServer(name: string): Promise<void> {
    return this.requireQuery().reconnectMcpServer(name);
  }

  toggleMcpServer(name: string, enabled: boolean): Promise<void> {
    return this.requireQuery().toggleMcpServer(name, enabled);
  }

  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> {
    return this.requireQuery().setMcpServers(servers);
  }

  /** §25: the model of the next request (`Query.setModel`; null = the CLI's default). */
  async setModel(model: string | null): Promise<void> {
    await this.requireQuery().setModel(model ?? undefined);
  }

  /** §25: `effortLevel` in the flag settings layer, applied live (null = the model's default). */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.requireQuery().applyFlagSettings({ effortLevel: effort });
  }

  /**
   * MARK: wave3 engine-agents — §36.2: `Query.stopTask` — the CLI stops that one subagent (task_notification `stopped`,
   * its Agent call returns "[Request interrupted by user for tool use]") while the turn and the other agents go on.
   */
  async stopTask(taskId: string): Promise<void> {
    const q = this.requireQuery() as Query & { stopTask?: unknown };
    if (typeof q.stopTask !== "function") throw new Error("this Claude Agent SDK cannot stop one task");
    await q.stopTask(taskId);
  }

  /** Our PreToolUse rules (the budget deny, the git card of §46) run before mode evaluation, so they apply in every mode. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.q) throw new Error("session not started");
    const before = this.hookCtx.permissionMode ?? "default";
    // MARK: wave6 w6-terminal — §44.1: the CLI's report of this very switch (`system/status`) is not Claude's own.
    this.modeSwitching = true;
    try {
      // MARK: wave4b w4b-auto — §39.5: a CLI that cannot run auto mode for this model refuses; say so by code.
      await this.q.setPermissionMode(mode).catch((e: unknown) => {
        throw autoModeRefusal(mode, e) ?? e;
      });
    } finally {
      this.modeSwitching = false;
    }
    // §44.1: into plan mode the mode before it is kept (what approving the plan returns to); out of it, forgotten.
    if (mode !== "plan") delete this.hookCtx.prePlanMode;
    else if (before !== "plan") this.hookCtx.prePlanMode = before;
    this.hookCtx.permissionMode = mode;
    if (mode === "auto") this.autoUnavailableNoticed = false;
  }

  /**
   * MARK: wave6 w6-terminal — §44.1: the CLI entered plan mode on its own — Claude's EnterPlanMode (allowed by the CLI in
   * auto mode, by the user's card otherwise) or a conversation resumed in it — as `system/status.permissionMode`, a turn's
   * `system/init` or a main-thread hook input says. From then on the plan rules apply (no edits, read-only commands, the
   * plan file allowed and proposed), the mode before is kept (`prePlanMode`) and the engine is told (`permission_mode`).
   * Only the way into plan mode is followed: leaving it stays the user's (plan approval, the mode menu) — an engine that
   * kept plan mode where the CLI left it only denies more — and auto ↔ default is the CLI's fallback for a model without
   * auto mode (§39.5: the notice; the user's mode stays). Only while a turn of ours runs: Claude can call EnterPlanMode only
   * then (outside one the unprompted-turn guard denies it), and the engine switches into plan mode only between turns (a
   * switch during a turn is among default / acceptEdits / auto, §39.5) — so a late report of the engine's own switch is
   * never taken for Claude's (a conversation resumed in plan mode says so at the next turn's init).
   */
  private followCliMode(reported: unknown): void {
    if (reported !== "plan" || this.modeSwitching || this.disposing || !this.turnActive) return;
    const before = this.hookCtx.permissionMode ?? "default";
    if (before === "plan") return;
    this.hookCtx.prePlanMode = before;
    this.hookCtx.permissionMode = "plan";
    this.opts.log("info", `the CLI entered plan mode (was ${before})`);
    this.emit({ type: "permission_mode", mode: "plan", prePlanMode: before });
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.disposed;
    this.disposing = true;
    this.disposed = this.doDispose();
    return this.disposed;
  }

  private async doDispose(): Promise<void> {
    this.initWatchdog?.stop(); // MARK: wave3 engine-session (§36.7)
    this.inbox.end();
    for (const p of this.pendingPermissions.values()) p.resolve({ behavior: "deny", message: "shutting down" });
    this.pendingPermissions.clear();
    for (const w of [...this.peerWaiters]) w.done();
    if (this.peerTurnTimer) clearTimeout(this.peerTurnTimer);
    if (this.adopting) this.autoTurnReady(false); // §52: nothing waits on a session that is going away
    this.abortController.abort();
    const q = this.q;
    if (!q) return;
    const child = this.cliChild;
    // The abort above closes the CLI's stdin; if it is still running 1s later (e.g. it was blocked
    // on a permission prompt when the app died), force it so nothing outlives the engine.
    const killTimer = setTimeout(() => {
      if (child && childAlive(child) && child.pid) {
        this.opts.log("warn", `claude (pid ${child.pid}) still alive ${KILL_AFTER_ABORT_MS}ms after abort; killing`);
        void this.opts.platform.killTree(child.pid);
        child.kill("SIGKILL");
      }
    }, KILL_AFTER_ABORT_MS);
    killTimer.unref();
    const childExited = new Promise<void>((resolve) => {
      if (!child || !childAlive(child)) resolve();
      else child.once("exit", () => resolve());
    });
    const queryClosed = (q.return?.(undefined) ?? Promise.resolve()).then(() => {}, () => {});
    // Hard cap: never hang on a stuck SDK/CLI.
    const cap = new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_CAP_MS).unref());
    await Promise.race([Promise.all([childExited, queryClosed]).then(() => {}), cap]);
    clearTimeout(killTimer);
    if (child && childAlive(child) && child.pid) {
      void this.opts.platform.killTree(child.pid);
      child.kill("SIGKILL");
    }
  }

  // ------------------------------------------------------------------ query loop

  private async runLoop(query: Query): Promise<void> {
    let code = 0;
    try {
      for await (const m of query) this.handleSdkMessage(m);
      if (this.turnActive) {
        this.emitTurnEnd({ stopReason: this.wasInterrupted() ? "interrupted" : "ended", sessionId: this.currentSessionId ?? "" });
      }
      this.opts.log("info", "query loop ended");
      if (!this.disposing) {
        code = 1;
        // The CLI quit by itself: say why when its stderr tells (not logged in, usage limit, a refused start, …);
        // before initialize it is always reported (§30: a start failure is never silent).
        await this.cliSettled();
        const failure = this.startFailure();
        const api = failure ? null : codeOfErrorText(this.stderrTail);
        if (failure) this.emit({ type: "error", message: START_FAILURE_MESSAGES[failure], fatal: true, code: failure, ...this.exitDetails() });
        else if (api) this.emit({ type: "error", message: `${API_ERROR_MESSAGES[api]} (${firstLineOf(this.stderrTail)})`, fatal: true, code: api, ...this.exitDetails() });
        else if (!this.initialized) this.emit({ type: "error", message: START_FAILURE_MESSAGES.session_start_failed, fatal: true, code: "session_start_failed", ...this.exitDetails() });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (this.turnActive) {
        this.emitTurnEnd({ stopReason: this.disposing ? "interrupted" : "error", sessionId: this.currentSessionId ?? "" });
      }
      if (!this.disposing) {
        await this.cliSettled();
        // §30: a refused start (stderr), an API failure, else a start failure before initialize / a crash after it.
        const why = this.startFailure(message) ?? codeOfErrorText(message) ?? codeOfErrorText(this.stderrTail) ?? (this.initialized ? "session_crashed" : "session_start_failed");
        this.emit({ type: "error", message, fatal: true, code: why, ...this.exitDetails() });
        code = 1;
      } else this.opts.log("info", `query ended during shutdown: ${message}`);
    } finally {
      await this.dispose().catch(() => undefined);
      if (!this.closedEmitted) {
        this.closedEmitted = true;
        this.emit({ type: "closed", code });
      }
    }
  }

  private emit(event: SessionEvent): void {
    this.opts.emit(event);
  }

  private resetTurn(): void {
    this.budget.reset();
    this.turnToolFiles = new Map();
    this.editsSinceBash = new Set();
    this.bashCalls = new Map();
    this.lastTextByMessage = new Map();
    this.lastTextByAgent = new Map();
    this.callsSinceText = new Map();
    this.hookCtx.bashBaseTree = undefined;
    this.hookCtx.readOnlyBash = new Set();
    this.hookCtx.toolWindows = new Map();
    this.hookCtx.scopeReasons = new Map();
    this.hookCtx.scopeWatches = new Map();
    this.hookCtx.worktrees = undefined;
    this.turnChangedOutside = new Set();
    this.hookCtx.planFiles = new Set();
    this.turnToolNames = new Map();
    this.suppressedToolUseIds = new Set();
    this.autoCallInputs = new Map(); // MARK: wave4b w4b-auto (§39.5)
    this.activeSubagents = new Set();
    this.streamingTool = undefined;
    this.streamedText = new Map();
    this.streamingMessageId = "";
    this.turnLastUuid = undefined;
    this.turnContextUsage = { contextTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    this.turnCompacted = undefined; // MARK: wave4c w4c-commit
    this.interruptRequested = false;
  }

  /** The app interrupted the turn (§54: the budget never does). */
  private wasInterrupted(): boolean {
    return this.interruptRequested;
  }

  /** Plan files are excluded: they are bookkeeping, not part of the review or the budget (docs/M20-MODES.md). */
  private toolFilesArray(): ToolFileEntry[] {
    const plan = new Set([...(this.hookCtx.planFiles ?? [])].map(normalizeForCompare));
    return [...this.turnToolFiles.entries()]
      .filter(([key]) => !plan.has(key))
      .map(([, v]) => ({ path: v.path, tools: [...v.tools], count: v.count, toolUseIds: [...v.toolUseIds] }));
  }

  /**
   * `toolUseId` only for calls that change the file (edit tools, Bash via the snapshot): a Read is not a cause (§12).
   * §52.2: while no turn of ours runs (a background subagent works on), the next turn takes it (`idleToolFiles`).
   */
  private touchFile(file: string, toolName: string, toolUseId: string | undefined): void {
    const key = normalizeForCompare(file);
    // Between turns only a subagent's call is kept (the main thread's are denied, §18).
    if (!this.turnActive && (toolUseId === undefined || (this.openCalls.get(toolUseId)?.parent ?? null) === null)) return;
    const files = this.turnActive ? this.turnToolFiles : this.idleToolFiles;
    const entry = files.get(key) ?? { path: file, tools: new Set<string>(), count: 0, toolUseIds: [] };
    entry.tools.add(toolName);
    entry.count++;
    if (toolUseId !== undefined && !entry.toolUseIds.includes(toolUseId)) entry.toolUseIds.push(toolUseId);
    files.set(key, entry);
  }

  /** Removes `toolUseId` from every file it touched (the tool name stays: it still says what was tried). */
  private dropToolUseId(toolUseId: string): void {
    for (const entry of [...this.turnToolFiles.values(), ...this.idleToolFiles.values()]) {
      const i = entry.toolUseIds.indexOf(toolUseId);
      if (i >= 0) entry.toolUseIds.splice(i, 1);
    }
  }

  /**
   * §52.2: at a turn's start, what calls changed while no turn of ours ran (a background subagent's edits and commands)
   * becomes this turn's — the review keeps A while background work runs (§52.1), so those files are in it, with these
   * calls as their cause. Files no call changed (a read, a failed edit) are left out.
   */
  private takeIdleWork(): void {
    for (const [key, idle] of this.idleToolFiles) {
      if (idle.toolUseIds.length === 0) continue;
      const entry = this.turnToolFiles.get(key) ?? { path: idle.path, tools: new Set<string>(), count: 0, toolUseIds: [] };
      for (const t of idle.tools) entry.tools.add(t);
      entry.count += idle.count;
      for (const id of idle.toolUseIds) if (!entry.toolUseIds.includes(id)) entry.toolUseIds.push(id);
      this.turnToolFiles.set(key, entry);
    }
    this.idleToolFiles = new Map();
  }

  /** Post-Bash snapshot (hooks.ts): files changed since the previous one that no edit tool explains. */
  private attributeBashFiles(toolUseId: string, files: string[]): void {
    const attributed = files.filter((file) => !this.editsSinceBash.has(normalizeForCompare(file)));
    for (const file of attributed) this.touchFile(file, "Bash", toolUseId);
    this.editsSinceBash = new Set();
    if (attributed.length > 0) this.emit({ type: "tool_files", toolUseId, files: attributed });
  }

  private emitTurnEnd(opts: {
    stopReason: string;
    sessionId: string;
    usage?: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; models?: ModelCost[] };
  }): void {
    const usage: TurnUsage = {
      ...(opts.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }),
      ...this.turnContextUsage,
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      ...(this.turnCompacted ? { compacted: this.turnCompacted } : {}), // MARK: wave4c w4c-commit (§41.1)
    };
    const planFiles = [...(this.hookCtx.planFiles ?? [])];
    this.emit({
      type: "turn_end",
      stopReason: opts.stopReason,
      sessionId: opts.sessionId,
      usage,
      toolFiles: this.toolFilesArray(),
      budget: this.budget.snapshot(),
      changedOutside: [...this.turnChangedOutside].filter((p) => !planFiles.includes(p)).sort(),
      planFiles,
      ...(this.turnLastUuid ? { lastUuid: this.turnLastUuid } : {}),
      // §31: only calls that finished have a window (a denied or interrupted call never ran to its PostToolUse).
      toolWindows: [...(this.hookCtx.toolWindows?.values() ?? [])].filter((w) => w.end !== null).map((w) => ({ ...w })),
    });
    this.activity({ kind: "idle" });
    // §29: released peer messages belong to the turn that ends here (§50: so do messages put into it).
    this.releasedPeers = new Set();
    this.steered = new Set();
    this.queuedOwn = new Set();
    this.peerStarted = new Set();
    this.peerDelivered = new Set();
    this.takePeerTurnUsage();
    this.setTurnActive(false);
    this.resetTurn();
  }

  private setTurnActive(active: boolean): void {
    this.turnActive = active;
    this.syncGuard();
  }

  /** §29: the unprompted-turn guard is lifted for our turn only — not while a command of someone else runs in it. */
  private syncGuard(): void {
    this.hookCtx.turnActive = this.turnActive && this.adopting === null && (this.externalCommands.size === 0 || this.ownRunning !== null);
  }

  /** The unprompted-turn guard (hooks.ts `unpromptedBlocked`) denied a call: log it and tell the engine. */
  private onUnprompted(toolName: string): void {
    this.opts.log("warn", `blocked ${toolName}: Claude Code ran it outside a user turn (unprompted turn)`);
    this.emit({ type: "unprompted_denied", toolName });
  }

  /**
   * An assistant message carrying an API failure (`error`, or a `<synthetic>` message from older CLIs such as
   * "Invalid API key · Please run /login"): classified from the SDK's error value, refined by its text.
   */
  private classifyAssistant(msg: Extract<SDKMessage, { type: "assistant" }>): void {
    const synthetic = msg.message?.model === "<synthetic>";
    if (!msg.error && !synthetic) return;
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    const text = content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const byError = codeOfAssistantError(msg.error);
    const byText = codeOfErrorText(text);
    // "rate_limit" is also what a subscription's usage limit looks like; the text tells them apart.
    const code = byError === "rate_limited" && byText === "usage_limit" ? "usage_limit" : byError ?? byText;
    if (code) this.reportApiError(code, text);
  }

  /** A turn that ended on an API error (`is_error`), or an `error_during_execution` whose `errors[]` say why. */
  private classifyResult(msg: Extract<SDKMessage, { type: "result" }>): void {
    this.classifyLongWork(msg); // MARK: wave4 w4-longwork (§38.2)
    if (msg.subtype === "success") {
      if (!msg.is_error) return;
      const text = typeof msg.result === "string" ? msg.result : "";
      const byText = codeOfErrorText(text);
      const byStatus = codeOfStatus(msg.api_error_status);
      const code = byText === "usage_limit" || byText === "auth_required" ? byText : byStatus ?? byText ?? "api_error";
      this.reportApiError(code, text, msg.api_error_status !== undefined ? { status: msg.api_error_status } : {});
      return;
    }
    if (msg.subtype !== "error_during_execution") return;
    const text = (msg.errors ?? []).join("\n");
    const code = codeOfErrorText(text);
    if (code) this.reportApiError(code, text);
  }

  /**
   * Reports a classified API failure as a non-fatal `error{code}` (§19.6), once per code per turn. `detail` is the
   * CLI's own text (first line), appended to the English fallback message.
   */
  private reportApiError(code: ApiErrorCode, detail: string, extra: { resetAt?: string; status?: number | null } = {}): void {
    if (this.reportedApiErrors.has(code)) return;
    this.reportedApiErrors.add(code);
    const line = firstLineOf(detail);
    this.emit({
      type: "error",
      message: line ? `${API_ERROR_MESSAGES[code]} (${line})` : API_ERROR_MESSAGES[code],
      fatal: false,
      code,
      ...(extra.resetAt ? { resetAt: extra.resetAt } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
    });
  }

  // MARK: wave4 w4-longwork — §38.2

  /** A turn that stopped at the tool-call limit, or that a hook ended without saying why → a notice. */
  private classifyLongWork(msg: Extract<SDKMessage, { type: "result" }>): void {
    if (msg.subtype === "error_max_turns") {
      this.emitNotice(maxTurnsNotice(clampMaxTurns(this.opts.settings.maxTurns)));
      return;
    }
    const hook = this.hookBlockedThisTurn ? null : hookTerminalNotice((msg as { terminal_reason?: unknown }).terminal_reason);
    if (hook) this.emitNotice(hook);
  }

  /** `system/informational`: a hook's block reason, the CLI's warnings and notices → a notice; `info` only to the log. */
  private onInformational(msg: { content?: unknown; level?: unknown; prevent_continuation?: unknown; tool_use_id?: unknown }): void {
    const notice = informationalNotice(msg);
    if (!notice) {
      this.opts.log("debug", `informational (${String(msg.level)}): ${firstLineOf(typeof msg.content === "string" ? msg.content : "")}`);
      return;
    }
    if (notice.code === "hook_blocked") this.hookBlockedThisTurn = true;
    // MARK: wave4c w4c-trust — §41.2: the hook's own named row already said it.
    if (notice.code === "hook_blocked" && msg.prevent_continuation === true) {
      if (this.continuationBlock === "named") return;
      this.continuationBlock = "cli";
    }
    this.emitNotice(notice);
  }

  /**
   * `hook_started` / `hook_progress` / `hook_response`: a failed hook (`outcome: "error"`) is a notice, before initialize
   * too (a SessionStart hook). True when the message is handled here — every one after initialize; before it the §36.7
   * start watchdog still gets it.
   */
  private onLongWorkHook(msg: { subtype?: unknown }): boolean {
    if (msg.subtype !== "hook_started" && msg.subtype !== "hook_progress" && msg.subtype !== "hook_response") return false;
    if (msg.subtype === "hook_response") {
      const notice = hookFailureNotice(msg as Parameters<typeof hookFailureNotice>[0]);
      // MARK: wave4c w4c-trust — §41.2: a prompt / stop hook's block is one row with the CLI's `informational` line.
      if (notice?.code === "hook_blocked" && isContinuationHook(msg as { hook_event?: unknown; hook_name?: unknown })) {
        this.hookBlockedThisTurn = true;
        if (this.continuationBlock === "cli") return this.initialized;
        this.continuationBlock = "named";
      }
      if (notice) this.emitNotice(notice);
    }
    return this.initialized;
  }

  // MARK: wave4b w4b-auto — §39.5

  /**
   * `system/init` (every turn): asked for auto mode while the CLI runs another one → `auto_mode_unavailable`, once. Plan
   * mode is no fallback (wave6 w6-terminal, §44.1: `followCliMode` took it first).
   */
  private noteCliPermissionMode(cliMode: unknown): void {
    if (this.hookCtx.permissionMode !== "auto" || typeof cliMode !== "string" || cliMode === "auto" || cliMode === "plan" || this.autoUnavailableNoticed) return;
    this.autoUnavailableNoticed = true;
    this.emitAutoNotice(autoModeUnavailableNotice(cliMode));
  }

  /** `system/permission_denied`: what the auto-mode classifier blocked → a gray row naming the call and the reason. */
  private onPermissionDenied(msg: Record<string, unknown>): void {
    const id = typeof msg.tool_use_id === "string" ? msg.tool_use_id : "";
    const notice = autoModeDeniedNotice(msg, this.autoCallInputs.get(id));
    if (!notice) {
      this.opts.log("debug", `permission denied (${String(msg.decision_reason_type)}): ${String(msg.tool_name)}`);
      return;
    }
    this.emitAutoNotice(notice);
  }

  private emitAutoNotice(n: AutoModeNotice): void {
    if (this.disposing) return;
    const { code, message, ...rest } = n;
    this.emit({ type: "error", message, fatal: false, code, ...rest });
  }

  private emitNotice(n: LongWorkNotice): void {
    if (this.disposing) return;
    const { code, message, ...rest } = n;
    this.emit({ type: "error", message, fatal: false, code, ...rest });
  }

  private activity(a: { kind: ActivityKind; toolName?: string; detail?: string }): void {
    this.emit({ type: "activity", ...a });
  }

  // MARK: wave4d w4d-agents2 — §42.4
  /**
   * This turn's share of the cumulative `modelUsage` (`{ models }`, or nothing when the CLI sent none / it was all
   * unchanged); moves the baseline. `total` below the last one is a reset (as for `costUsd`).
   */
  private turnModels(modelUsage: unknown, total: number): { models?: ModelCost[] } {
    const raw = modelUsage && typeof modelUsage === "object" ? (modelUsage as Record<string, Record<string, unknown>>) : undefined;
    const { models, next } = modelCostDelta(this.lastModelUsage, raw, total < this.lastTotalCostUsd);
    this.lastModelUsage = next;
    return models.length > 0 ? { models } : {};
  }

  /** §42.4: a subagent's answer names its model — reported once per agent and model (`<synthetic>` rows are not a model). */
  private noteAgentModel(toolUseId: string | null, model: unknown): void {
    if (!toolUseId || typeof model !== "string" || !model || model.startsWith("<") || this.agentModels.get(toolUseId) === model) return;
    this.agentModels.set(toolUseId, model);
    if (this.agentModels.size > 500) this.agentModels.delete(this.agentModels.keys().next().value!);
    this.emit({ type: "agent_signal", signal: { kind: "agent_model", toolUseId, model } });
  }

  /** Picks the context window of the session model from `result.modelUsage` (largest entry as fallback). */
  private contextWindowFrom(modelUsage: Record<string, { contextWindow: number }> | undefined): number | undefined {
    if (!modelUsage) return undefined;
    const own = this.currentModel ? modelUsage[this.currentModel]?.contextWindow : undefined;
    if (own && own > 0) return own;
    let max = 0;
    for (const u of Object.values(modelUsage)) if (u.contextWindow > max) max = u.contextWindow;
    return max > 0 ? max : undefined;
  }

  private fileOf(input: Record<string, unknown>): string | undefined {
    const p = input.file_path ?? input.notebook_path;
    return typeof p === "string" && p.length > 0 ? resolveToolPath(p, this.hookCtx.cwd) : undefined;
  }

  private streamedBlocks(messageId: string): string[] {
    let blocks = this.streamedText.get(messageId);
    if (!blocks) this.streamedText.set(messageId, (blocks = []));
    return blocks;
  }

  /** `activityDetail` from partially streamed input JSON: the first complete string value of a detail key, if any. */
  private streamingDetail(toolName: string, partialJson: string): string | undefined {
    const m = DETAIL_KEY_RE.exec(partialJson);
    if (!m) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(`"${m[2]}"`);
    } catch {
      return undefined;
    }
    const input = { [m[1]!]: value };
    return activityDetail(toolName, input, this.fileOf(input));
  }

  // ------------------------------------------------------------------ SDK → events

  private handleSdkMessage(msg: SDKMessage): void {
    // §29: a frame the SDK's types do not name (CLI 2.1.30x): which command — ours, a released peer's, someone else's — runs.
    if ((msg as { type: string }).type === "command_lifecycle") {
      this.onLifecycle(msg as unknown as { command_uuid?: unknown; state?: unknown });
      return;
    }
    switch (msg.type) {
      case "system": {
        if ((msg as { subtype?: string }).subtype === "peer_message_hold") {
          this.onPeerHold(msg as unknown as Record<string, unknown>);
          return;
        }
        if (msg.subtype === "init") {
          // §52: a CLI turn nobody asked for (no turn of ours, no command of someone else's): a background task ended
          // (task-notification) or Claude goes on by itself (`/goal`) — taken as a review turn.
          if (this.canAdopt() && !this.turnActive && this.externalCommands.size === 0) this.beginAutoTurn(this.bgNotice ? "background" : "continue", null);
          this.currentSessionId = msg.session_id;
          this.currentModel = msg.model;
          this.followCliMode(msg.permissionMode); // MARK: wave6 w6-terminal (§44.1)
          this.noteCliPermissionMode(msg.permissionMode); // MARK: wave4b w4b-auto (§39.5)
          this.emit({
            type: "session_info",
            sessionId: msg.session_id,
            model: msg.model,
            cwd: msg.cwd,
            slashCommands: msg.slash_commands ?? [],
            skills: msg.skills ?? [],
            plugins: (msg.plugins ?? []).map((p) => ({ name: p.name, path: p.path, ...(p.version ? { version: p.version } : {}) })),
            mcpServers: (msg.mcp_servers ?? []).map((m) => ({ name: m.name, status: m.status })),
            contextWindow: this.contextWindow,
            ...(msg.claude_code_version ? { cliVersion: msg.claude_code_version } : {}), // MARK: wave3 engine-session (§36.8)
          });
        } else if (msg.subtype === "status") {
          // MARK: wave6 w6-terminal — §44.1: CLI 2.1.310 reports every mode change as `status: null, permissionMode`.
          if (msg.permissionMode !== undefined) this.followCliMode(msg.permissionMode);
          if (!this.initialized && this.q) this.onStartProgress({ kind: "status", name: msg.status ?? null }, msg.subtype); // MARK: wave3 engine-session (§36.7)
          // "compacting" (/compact or auto-compaction) and "requesting" (waiting for the model); null clears it.
          if (msg.status) this.activity({ kind: "thinking", detail: msg.status });
          else if (msg.compact_result) this.opts.log("debug", `compaction ${msg.compact_result}${msg.compact_error ? `: ${msg.compact_error}` : ""}`);
        } else if (msg.subtype === "api_retry") {
          const cause = msg.error ? ` (${msg.error}${msg.error_status ? ` ${msg.error_status}` : ""})` : "";
          this.emit({
            type: "error",
            message: `${API_ERROR_MESSAGES.api_retrying}${cause} Attempt ${msg.attempt}/${msg.max_retries}, next in ${Math.round(msg.retry_delay_ms / 1000)}s.`,
            fatal: false,
            code: "api_retrying",
            attempt: msg.attempt,
            maxRetries: msg.max_retries,
            retryDelayMs: msg.retry_delay_ms,
            status: msg.error_status,
          });
        } else if (msg.subtype === "compact_boundary") {
          // The context after the compaction (§27): a `/compact` turn has no assistant message to measure it by.
          const post = (msg as { compact_metadata?: { post_tokens?: unknown } }).compact_metadata?.post_tokens;
          if (typeof post === "number" && post >= 0) {
            this.turnContextUsage = { contextTokens: post, cacheReadTokens: 0, cacheCreationTokens: 0 };
            // The status line's context follows the compaction too, not the last answer before it.
            this.lastMainUsage = { input_tokens: post, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
          }
          // MARK: wave4c w4c-commit — §41.1 (SME-11): the chat keeps a "대화를 줄였어요" row at this turn's end.
          const meta = (msg as { compact_metadata?: { trigger?: unknown; pre_tokens?: unknown } }).compact_metadata;
          const pre = meta?.pre_tokens;
          this.turnCompacted = { trigger: meta?.trigger === "auto" ? "auto" : "manual", ...(typeof pre === "number" && pre >= 0 ? { preTokens: pre } : {}) };
          this.activity({ kind: "thinking", detail: "compacted" });
        } else if (msg.subtype === "task_started") {
          this.taskCalls.set(msg.task_id, msg.tool_use_id ?? null);
          if (msg.is_backgrounded === true) this.noteBackgroundStart(msg.task_id, msg.tool_use_id ?? null);
          this.noteAgentTask(msg as unknown as Record<string, unknown>); // §52.2
          this.emit({
            type: "agent_signal",
            signal: {
              kind: "task_started",
              taskId: msg.task_id,
              ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}),
              description: msg.description,
              ...(msg.subagent_type ? { subagentType: msg.subagent_type } : {}),
              ...(msg.task_type ? { taskType: msg.task_type } : {}),
              ...(msg.is_backgrounded !== undefined ? { isBackground: msg.is_backgrounded } : {}),
              ...(msg.spawn_depth !== undefined ? { depth: msg.spawn_depth } : {}),
              ...(msg.ambient || msg.skip_transcript ? { ambient: true } : {}),
              ...(typeof msg.prompt === "string" && msg.prompt ? { prompt: msg.prompt } : {}), // MARK: wave3 engine-agents (§36.1)
            },
          });
        } else if (msg.subtype === "task_progress") {
          this.emit({
            type: "agent_signal",
            signal: {
              kind: "task_progress",
              taskId: msg.task_id,
              ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}),
              ...(msg.description ? { description: msg.description } : {}),
              ...(msg.subagent_type ? { subagentType: msg.subagent_type } : {}),
              usage: { tokens: msg.usage.total_tokens, toolUses: msg.usage.tool_uses, durationMs: msg.usage.duration_ms },
              ...(msg.last_tool_name ? { lastTool: msg.last_tool_name } : {}),
              ...(msg.summary ? { summary: msg.summary } : {}),
            },
          });
        } else if (msg.subtype === "task_updated") {
          const p = msg.patch;
          // §52: Ctrl+B (`backgroundTasks`) moved a foreground task to the background.
          if (p.is_backgrounded === true) this.noteBackgroundStart(msg.task_id, this.taskCalls.get(msg.task_id) ?? null);
          // §52.2: a subagent moved to the background works on after the turn; one that ended does not.
          if (p.is_backgrounded === true && this.agentTaskIds.has(msg.task_id) && !this.bgAgents.has(msg.task_id)) this.bgAgents.set(msg.task_id, null);
          if (p.status === "completed" || p.status === "failed" || p.status === "killed") this.bgAgents.delete(msg.task_id);
          this.emit({
            type: "agent_signal",
            signal: {
              kind: "task_updated",
              taskId: msg.task_id,
              ...(p.status ? { status: p.status } : {}),
              ...(p.description ? { description: p.description } : {}),
              ...(p.end_time !== undefined ? { endTime: p.end_time } : {}),
              ...(p.error ? { error: p.error } : {}),
              ...(p.is_backgrounded !== undefined ? { isBackground: p.is_backgrounded } : {}),
            },
          });
        } else if (msg.subtype === "task_notification") {
          this.noteBackgroundEnd(msg as unknown as Record<string, unknown>);
          this.bgAgents.delete(msg.task_id); // §52.2
          // §52.2: a subagent that reported through SubagentHandback: its report, not the CLI's pointer to the message.
          const summary = handbackReportOf(msg) ?? msg.summary;
          this.emit({
            type: "agent_signal",
            signal: {
              kind: "task_notification",
              taskId: msg.task_id,
              ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}),
              status: msg.status,
              ...(summary ? { summary } : {}),
              ...(msg.usage ? { usage: { tokens: msg.usage.total_tokens, toolUses: msg.usage.tool_uses, durationMs: msg.usage.duration_ms } } : {}),
            },
          });
          this.emitAgentEnd(msg as unknown as Record<string, unknown>); // §52.2
        } else if ((msg as { subtype?: string }).subtype === "background_tasks_changed") {
          this.onBackgroundTasks((msg as { tasks?: unknown }).tasks); // §52
        } else if (msg.subtype === "commands_changed") {
          // MARK: wave3 engine-session — §36.5: the whole list again (skills found while working); it replaces the old one.
          this.emit({ type: "commands_info", commands: Array.isArray(msg.commands) ? msg.commands : [] });
        } else if ((msg as { subtype?: string }).subtype === "permission_denied") {
          this.onPermissionDenied(msg as unknown as Record<string, unknown>); // MARK: wave4b w4b-auto (§39.5)
        } else if (msg.subtype === "informational") {
          this.onInformational(msg); // MARK: wave4 w4-longwork (§38.2)
        } else if (this.onLongWorkHook(msg)) {
          // MARK: wave4 w4-longwork — §38.2: after initialize every hook message is ours (a failed one is a notice)
        } else if (msg.subtype === "hook_started" || msg.subtype === "hook_progress" || msg.subtype === "hook_response") {
          // MARK: wave3 engine-session — §36.7
          this.onStartProgress({ kind: "hook", id: msg.hook_id, name: msg.hook_name || msg.hook_event || null, ...(msg.subtype === "hook_response" ? { done: true } : {}) }, msg.subtype);
        } else if (msg.subtype === "plugin_install") {
          this.onStartProgress({ kind: "plugin", name: msg.name ?? null, ...(msg.status === "completed" ? { done: true } : {}) }, msg.subtype);
        } else {
          this.opts.log("debug", `system message ignored: ${msg.subtype}`);
        }
        return;
      }
      case "stream_event": {
        if (msg.parent_tool_use_id !== null) return;
        const ev = msg.event;
        if (ev.type === "message_start") {
          this.streamingMessageId = ev.message.id;
        } else if (ev.type === "content_block_start" && ev.content_block.type === "text") {
          this.streamedBlocks(this.streamingMessageId).push("");
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          const blocks = this.streamedBlocks(this.streamingMessageId);
          if (blocks.length === 0) blocks.push("");
          blocks[blocks.length - 1] += ev.delta.text;
          this.emit({ type: "text_delta", text: ev.delta.text });
        } else if (ev.type === "content_block_start" && ev.content_block.type === "thinking") {
          this.activity({ kind: "thinking" });
        } else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use"
          && !SUBAGENT_TOOL_RE.test(ev.content_block.name)) {
          // Announce the tool as soon as its block starts streaming: the `assistant` message (which
          // carries the full input and re-emits tool_start with the detail) only arrives after the
          // input finished streaming, and a fast tool such as Write then runs for ~200ms — too short
          // for the HUD to be seen. This widens "Running X" to cover the input streaming as well.
          this.streamingTool = { name: ev.content_block.name, json: "" };
          this.activity({ kind: "tool_start", toolName: ev.content_block.name });
        } else if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta" && this.streamingTool) {
          this.streamingTool.json += ev.delta.partial_json;
          const detail = this.streamingDetail(this.streamingTool.name, this.streamingTool.json);
          if (detail) {
            this.activity({ kind: "tool_start", toolName: this.streamingTool.name, detail });
            this.streamingTool = undefined;
          }
        } else if (ev.type === "content_block_stop") {
          this.streamingTool = undefined;
        }
        return;
      }
      case "assistant": {
        const topLevel = msg.parent_tool_use_id === null;
        this.classifyAssistant(msg);
        if (!topLevel) this.noteAgentModel(msg.parent_tool_use_id, (msg.message as { model?: unknown }).model); // MARK: wave4d w4d-agents2 (§42.4)
        if (topLevel && typeof msg.uuid === "string" && msg.uuid) this.turnLastUuid = msg.uuid;
        const u = msg.message.usage;
        if (topLevel && u) {
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const cacheCreation = u.cache_creation_input_tokens ?? 0;
          this.turnContextUsage = {
            contextTokens: (u.input_tokens ?? 0) + cacheRead + cacheCreation,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
          };
          // MARK: wave6 w6-statusline — §44.2: the status line's current_usage / model.id follow every main answer.
          const model = (msg.message as { model?: unknown }).model;
          if (model !== "<synthetic>") {
            this.lastMainUsage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead };
            if (typeof model === "string" && model) this.lastMainModel = model;
          }
        }
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        const streamed = this.streamedText.get(msg.message.id);
        const parentToolUseId = msg.parent_tool_use_id ?? undefined;
        for (const block of content) {
          if (block.type === "text") {
            if (block.text.trim()) {
              this.lastTextByMessage.set(msg.message.id, block.text);
              this.lastTextByAgent.set(msg.parent_tool_use_id ?? "", block.text);
              this.callsSinceText.set(msg.parent_tool_use_id ?? "", 0);
            }
            if (!topLevel) continue;
            // Emit what the stream did not deliver: the whole block when nothing was streamed for it
            // (synthetic / non-streamed messages), the tail when the stream was cut short, nothing otherwise.
            const seen = streamed?.shift() ?? "";
            if (block.text.length > seen.length && block.text.startsWith(seen)) {
              this.emit({ type: "text_delta", text: block.text.slice(seen.length) });
            }
            continue;
          }
          if (block.type !== "tool_use") continue;
          const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
          const file = this.fileOf(input);
          // Never surface the intercepted ExitPlanMode call in the transcript (see suppressedToolUseIds).
          const agentKey = msg.parent_tool_use_id ?? "";
          const ownText = this.lastTextByMessage.get(msg.message.id);
          const rationale = rationaleOf(ownText ?? this.lastTextByAgent.get(agentKey));
          // §34.8: which text it is, and how many of the agent's calls came between it and this one.
          const why = rationale === undefined ? {} : { rationale, rationaleSource: ownText !== undefined ? ("same_message" as const) : ("earlier" as const), rationaleAge: this.callsSinceText.get(agentKey) ?? 0 };
          if (block.name === EXIT_PLAN_MODE_TOOL) this.suppressedToolUseIds.add(block.id);
          else {
            this.emit({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input,
              file,
              ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
              ...why,
            });
            if (this.callsSinceText.has(agentKey)) this.callsSinceText.set(agentKey, this.callsSinceText.get(agentKey)! + 1);
          }
          this.turnToolNames.set(block.id, block.name);
          this.openCalls.set(block.id, { name: block.name, parent: msg.parent_tool_use_id ?? null });
          if (this.openCalls.size > MAX_OPEN_CALLS) this.openCalls.delete(this.openCalls.keys().next().value!);
          // §52.2: an agent started by a subagent working in the background works in the background too.
          if (SUBAGENT_TOOL_RE.test(block.name)) this.agentCallParents.set(block.id, msg.parent_tool_use_id ?? null);
          // MARK: wave4b w4b-auto (§39.5); wave6 w6-terminal (§44.1): plan mode entered from auto is judged by the classifier too
          if (this.hookCtx.permissionMode === "auto" || (this.hookCtx.permissionMode === "plan" && this.hookCtx.prePlanMode === "auto")) this.autoCallInputs.set(block.id, input);
          if (block.name === "Bash") {
            this.bashCalls.set(block.id, { command: typeof input.command === "string" ? input.command : "", background: input.run_in_background === true });
          }
          const detail = activityDetail(block.name, input, file);
          if (SUBAGENT_TOOL_RE.test(block.name)) {
            this.activeSubagents.add(block.id);
            this.activity({ kind: "subagent_start", toolName: block.name, detail });
          } else if (topLevel) {
            this.activity({ kind: "tool_start", toolName: block.name, detail });
          }
          if (file) {
            const edits = AUTO_ALLOW_RE.test(block.name);
            this.touchFile(file, block.name, edits ? block.id : undefined);
            if (edits) this.editsSinceBash.add(normalizeForCompare(file));
          }
        }
        if (streamed?.length === 0) this.streamedText.delete(msg.message.id);
        return;
      }
      case "user": {
        if ((msg as { isReplay?: boolean }).isReplay === true) {
          // §29: `--replay-user-messages` echoes every user message: ours (no origin) are ignored, a peer's carries its body.
          this.onReplay(msg as unknown as { uuid?: unknown; origin?: unknown });
          return;
        }
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          if (!this.suppressedToolUseIds.delete(block.tool_use_id)) this.emitToolResult(block.tool_use_id, block.is_error === true, block.content, msg.parent_tool_use_id);
          // §52.2: a background subagent's call can end after the turn it started in.
          const name = this.turnToolNames.get(block.tool_use_id) ?? this.openCalls.get(block.tool_use_id)?.name;
          this.openCalls.delete(block.tool_use_id);
          // A failed edit (denied, old_string not found) changed nothing: it is no cause of the file (§12, §31).
          if (block.is_error === true && name !== undefined && AUTO_ALLOW_RE.test(name)) this.dropToolUseId(block.tool_use_id);
          if (this.activeSubagents.delete(block.tool_use_id)) {
            this.activity({ kind: "subagent_end", toolName: name });
          } else if (msg.parent_tool_use_id === null) {
            this.activity({ kind: "tool_end", toolName: name });
          }
        }
        return;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        // MARK: wave4 w4-longwork — §38.2: every window the CLI reports reaches state.hud.rateLimits (allowed ones too).
        for (const window of rateLimitWindowsOf(info, Date.now())) this.emit({ type: "rate_limit_info", window });
        if (info?.status !== "rejected") return;
        const resetAt = isoFromEpoch(info.resetsAt);
        const key = `usage_limit|${resetAt ?? ""}|${info.rateLimitType ?? ""}`;
        if (key === this.lastLimitKey) return;
        this.lastLimitKey = key;
        this.reportedApiErrors.delete("usage_limit");
        this.reportApiError("usage_limit", info.rateLimitType ? `${info.rateLimitType} limit` : "", resetAt ? { resetAt } : {});
        return;
      }
      case "auth_status": {
        if (msg.error) this.reportApiError("auth_required", msg.error);
        return;
      }
      case "tool_progress": {
        if (msg.heartbeat && !msg.subagent_retry) return; // MARK: wave4b w4b-agents — §39.3: a retry on a heartbeat still counts
        const retry = msg.subagent_retry;
        this.emit({
          type: "agent_signal",
          signal: {
            kind: "tool_progress",
            toolUseId: msg.tool_use_id,
            toolName: msg.tool_name,
            parentToolUseId: msg.parent_tool_use_id,
            ...(msg.task_id ? { taskId: msg.task_id } : {}),
            // MARK: wave4b w4b-agents — §39.3: how long the call has run; the CLI retrying the agent's API request.
            ...(typeof msg.elapsed_time_seconds === "number" ? { elapsedSeconds: msg.elapsed_time_seconds } : {}),
            ...(retry && typeof retry.attempt === "number"
              ? { retry: { attempt: retry.attempt, max: retry.max_retries, status: retry.error_status ?? null, ...(retry.agent_id ? { agentId: retry.agent_id } : {}) } }
              : {}),
          },
        });
        return;
      }
      case "result": {
        if (this.q && !this.initialized && msg.subtype !== "success") {
          // §30: the CLI's answer to a refused start (`--resume` of an unknown id) — never a turn, its text says why.
          this.startFailureText = (msg.errors ?? []).join("\n");
          this.opts.log("debug", `error result before initialize: ${firstLineOf(this.startFailureText)}`);
          return;
        }
        this.currentSessionId = msg.session_id;
        this.contextWindow = this.contextWindowFrom(msg.modelUsage) ?? this.contextWindow;
        // MARK: wave6 w6-statusline — §44.2: every result's API time (the CLI's total_api_duration_ms counts them all).
        if (typeof msg.duration_api_ms === "number" && Number.isFinite(msg.duration_api_ms) && msg.duration_api_ms > 0) this.apiDurationTotal += msg.duration_api_ms;
        const peer = peerOriginOf((msg as { origin?: unknown }).origin);
        if (!this.ownsResult(msg, peer !== null)) {
          // A turn the CLI ran on its own (no sendUser — or a command of someone else's while ours waits, §29): it is
          // not ours to end or count. Its cost stays in `total_cost_usd` and lands in the next turn's delta.
          this.opts.log("warn", `result (${msg.subtype}) without a user turn ignored (unprompted turn)`);
          if (peer && !this.externalPeerSeen) this.emit({ type: "peer_delivered", messageUuid: null, owned: false, origin: peer });
          this.externalPeerSeen = false;
          this.resetTurn();
          this.activity({ kind: "idle" });
          this.emit({ type: "unprompted_turn_end", sessionId: msg.session_id });
          this.endOfCliTurn();
          return;
        }
        const running = this.ownRunning;
        this.endOfCliTurn();
        // §52.2: a message of ours this result echoes is done, whether or not its command was seen starting.
        for (const u of echoedUuids(msg)) if (this.queuedOwn.has(u)) this.peerStarted.add(u);
        // §29: a released peer message without an echo (no replay): its result says who sent it.
        if (peer && this.releasedPeers.size > 0) {
          const id = running !== null && this.releasedPeers.has(running) ? running : [...this.releasedPeers].find((p) => !this.peerDelivered.has(p));
          if (id !== undefined && !this.peerDelivered.has(id)) {
            this.peerDelivered.add(id);
            this.emit({ type: "peer_delivered", messageUuid: id, owned: true, origin: peer });
          }
        }
        this.classifyResult(msg);
        const total = msg.total_cost_usd ?? 0;
        // §29: one review turn over several released peer messages — the CLI runs the next one as its own command.
        if (this.peerTurnWaits()) {
          this.deferPeerResult(msg.session_id, msg.subtype, total, msg.usage.input_tokens, msg.usage.output_tokens, msg.duration_ms, msg.modelUsage);
          return;
        }
        const earlier = this.takePeerTurnUsage();
        const costUsd = total >= this.lastTotalCostUsd ? total - this.lastTotalCostUsd : total;
        const models = this.turnModels(msg.modelUsage, total); // MARK: wave4d w4d-agents2 (§42.4)
        this.lastTotalCostUsd = total;
        this.emitTurnEnd({
          stopReason: this.wasInterrupted() ? "interrupted" : msg.subtype,
          sessionId: msg.session_id,
          usage: {
            inputTokens: msg.usage.input_tokens + earlier.inputTokens,
            outputTokens: msg.usage.output_tokens + earlier.outputTokens,
            costUsd,
            durationMs: msg.duration_ms + earlier.durationMs,
            ...models,
          },
        });
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ §52 background work

  get backgroundWorkOn(): boolean {
    return this.bgOn;
  }

  /** A turn the CLI starts itself may be taken: background work on, a turn of ours ran in this process, still alive. */
  private canAdopt(): boolean {
    return this.bgOn && this.hadOwnTurn && this.initialized && !this.disposing && this.adopting === null;
  }

  /**
   * §52: the CLI runs a turn nobody asked for. It counts as active at once (its text is not `unprompted`), but every tool
   * call waits (hooks / canUseTool) until the engine answers `autoTurnReady` — snapshot A comes first.
   */
  private beginAutoTurn(trigger: AutoTurnInfo["trigger"], commandUuid: string | null, wakeupSource?: string): void {
    this.resetTurn();
    this.takeIdleWork(); // §52.2
    this.queuedOwn = new Set();
    this.reportedApiErrors = new Set();
    this.hookBlockedThisTurn = false;
    this.continuationBlock = null;
    const task = trigger === "background" ? this.bgNotice : null;
    this.bgNotice = null;
    let resolve!: () => void;
    this.hookCtx.adoption = new Promise<void>((r) => (resolve = r));
    this.adopting = { resolve, commandUuid };
    if (commandUuid) this.ownRunning = commandUuid;
    this.setTurnActive(true);
    this.opts.log("info", `Claude Code started a turn itself (${trigger}${wakeupSource ? `, ${wakeupSource}` : ""}): taking it as a review turn`);
    this.emit({ type: "auto_turn_start", trigger, ...(commandUuid ? { commandUuid } : {}), ...(task ? { task: { ...task } } : {}), ...(wakeupSource ? { wakeupSource } : {}) });
  }

  autoTurnReady(ok: boolean, checkpointTree?: string): void {
    const a = this.adopting;
    if (!a) return;
    this.adopting = null;
    this.hookCtx.adoption = undefined;
    if (ok) {
      // The turn may already have ended (a short answer before the engine was ready): it stays ended.
      this.hookCtx.checkpointTree = checkpointTree;
      this.hadOwnTurn = true;
      this.syncGuard();
    } else {
      // §18 as before: its changes are denied; a scheduled run is someone else's command again.
      if (a.commandUuid) {
        this.ownCommands.delete(a.commandUuid);
        if (this.ownRunning === a.commandUuid) this.ownRunning = null;
        if (!this.externalCommands.has(a.commandUuid)) {
          this.externalCommands.add(a.commandUuid);
          if (this.externalCommands.size === 1) this.emit({ type: "external_turn", running: true, commandUuid: a.commandUuid });
        }
      }
      this.setTurnActive(false);
    }
    a.resolve();
  }

  async backgroundTasks(toolUseId?: string): Promise<boolean> {
    if (!this.bgOn) throw new Error("background work is off");
    const q = this.requireQuery() as Query & { backgroundTasks?: unknown };
    if (typeof q.backgroundTasks !== "function") throw new Error("this Claude Agent SDK cannot move a task to the background");
    return await (q.backgroundTasks as (id?: string) => Promise<boolean>).call(q, toolUseId);
  }

  taskOutputFile(taskId: string): string | null {
    return this.bgOutputFiles.get(taskId) ?? null;
  }

  isTaskLive(taskId: string): boolean {
    return this.bgTasks.has(taskId);
  }

  /** `background_tasks_changed`: the whole live set (REPLACE), ambient tasks left out. */
  private onBackgroundTasks(raw: unknown): void {
    const next = new Map<string, BackgroundTask>();
    for (const t of liveTasksOf(raw)) {
      const had = this.bgTasks.get(t.taskId);
      const started = this.bgStarted.get(t.taskId);
      const toolUseId = had?.toolUseId ?? started?.toolUseId ?? null;
      next.set(t.taskId, {
        taskId: t.taskId,
        kind: taskKind(t.taskType),
        description: t.description || had?.description || "",
        toolUseId,
        turn: had?.turn ?? null,
        startedAt: had?.startedAt ?? new Date().toISOString(),
        hasOutput: this.bgOutputFiles.has(t.taskId) || (toolUseId !== null && this.bgOutputByCall.has(toolUseId)),
      });
      if (toolUseId !== null && !this.bgOutputFiles.has(t.taskId)) {
        const out = this.bgOutputByCall.get(toolUseId);
        if (out) this.bgOutputFiles.set(t.taskId, out);
      }
    }
    const same = next.size === this.bgTasks.size && [...next].every(([id, t]) => JSON.stringify(this.bgTasks.get(id)) === JSON.stringify(t));
    this.bgTasks = next;
    if (!same) this.emitBackgroundTasks();
  }

  private noteBackgroundStart(taskId: string, toolUseId: string | null): void {
    this.bgStarted.set(taskId, { toolUseId });
    const t = this.bgTasks.get(taskId);
    if (t && t.toolUseId === null && toolUseId !== null) {
      this.bgTasks.set(taskId, { ...t, toolUseId, hasOutput: t.hasOutput || this.bgOutputByCall.has(toolUseId) });
      this.emitBackgroundTasks();
    }
  }

  private noteBackgroundOutput(toolUseId: string, path: string): void {
    this.bgOutputByCall.set(toolUseId, path);
    for (const [id, t] of this.bgTasks) {
      if (t.toolUseId !== toolUseId) continue;
      this.bgOutputFiles.set(id, path);
      if (!t.hasOutput) {
        this.bgTasks.set(id, { ...t, hasOutput: true });
        this.emitBackgroundTasks();
      }
    }
  }

  /** `task_notification` of a background task: its output file, and what the next turn Claude starts is about. */
  private noteBackgroundEnd(m: Record<string, unknown>): void {
    const id = typeof m.task_id === "string" ? m.task_id : "";
    if (!id || !this.bgStarted.has(id)) return;
    if (typeof m.output_file === "string" && m.output_file) this.bgOutputFiles.set(id, m.output_file);
    const task = this.bgTasks.get(id);
    const description = task?.description ?? "";
    // §52.2: a subagent's report — what it handed back, else the CLI's summary (the agent's last words).
    const summary = handbackReportOf(m) ?? (typeof m.summary === "string" && m.summary ? m.summary : undefined);
    const kind = task?.kind ?? (this.agentTaskIds.has(id) ? "agent" : undefined);
    const toolUseId = task?.toolUseId ?? this.bgStarted.get(id)?.toolUseId ?? null;
    this.bgNotice = {
      taskId: id,
      description,
      status: typeof m.status === "string" ? m.status : "completed",
      ...(summary ? { summary } : {}),
      ...(kind ? { kind } : {}),
      ...(toolUseId ? { toolUseId } : {}),
    };
  }

  // ------------------------------------------------------------------ §52.2 subagents in the background

  /**
   * `task_started` of a subagent (`local_agent`): one that works in the background (`is_backgrounded`), and every agent
   * started under one of them (`parent_task_id`, else the subagent whose call started it), is a background agent until it
   * ends — its calls pass the §18 guard (`isBackgroundAgent`).
   */
  private noteAgentTask(m: Record<string, unknown>): void {
    const id = typeof m.task_id === "string" ? m.task_id : "";
    const isAgent = m.task_type === "local_agent" || (m.task_type === undefined && typeof m.subagent_type === "string");
    if (!id || !isAgent) return;
    this.agentTaskIds.add(id);
    const call = typeof m.tool_use_id === "string" && m.tool_use_id ? m.tool_use_id : null;
    if (call) this.agentTaskOfCall.set(call, id);
    const parentTask = typeof m.parent_task_id === "string" && m.parent_task_id ? m.parent_task_id : this.taskOfParentCall(call);
    if (m.is_backgrounded === true) this.bgAgents.set(id, null);
    else if (parentTask !== null && this.bgAgents.has(parentTask)) this.bgAgents.set(id, parentTask);
  }

  /** The task of the subagent whose turn made `call` (the call's assistant message names it); null at the top or unknown. */
  private taskOfParentCall(call: string | null): string | null {
    const parent = call === null ? null : this.agentCallParents.get(call) ?? null;
    return parent === null ? null : this.agentTaskOfCall.get(parent) ?? null;
  }

  /**
   * hooks.ts `backgroundAgent`: a live subagent working in the background (or under one). An agent no task frame named,
   * while one works in the background, is taken to be under it: only background work runs between our turns.
   */
  private isBackgroundAgent(agentId: string): boolean {
    if (this.bgAgents.has(agentId)) return true;
    return !this.agentTaskIds.has(agentId) && this.bgAgents.size > 0;
  }

  /** The result of Agent / Task call `toolUseId` is the CLI's "launched in the background" answer, not a report. */
  private launchedInBackground(toolUseId: string, raw: string): boolean {
    const task = this.agentTaskOfCall.get(toolUseId);
    return (task !== undefined && this.bgAgents.has(task)) || /^Async agent launched/.test(raw.trimStart());
  }

  /**
   * A subagent that worked in the background ended (`task_notification`, or its hand-back without one): its call gets its
   * own result — the report, `isError` when it failed or was stopped — once. Its group in the chat closes with it, and the
   * engine keeps the report (`agent_report`, `why`).
   */
  private emitAgentEnd(m: Record<string, unknown>): void {
    const taskId = typeof m.task_id === "string" ? m.task_id : "";
    if (!taskId || !this.agentTaskIds.has(taskId) || !this.bgStarted.has(taskId)) return;
    const call = (typeof m.tool_use_id === "string" && m.tool_use_id ? m.tool_use_id : null) ?? this.taskCalls.get(taskId) ?? null;
    if (call === null || this.agentEndedCalls.has(call)) return;
    this.agentEndedCalls.add(call);
    const status = typeof m.status === "string" ? m.status : "completed";
    const report = handbackReportOf(m) ?? (typeof m.summary === "string" ? m.summary : "");
    const usage = m.usage && typeof m.usage === "object" ? (m.usage as { total_tokens?: unknown; tool_uses?: unknown; duration_ms?: unknown }) : undefined;
    const agentUsage = usage && typeof usage.total_tokens === "number" && typeof usage.tool_uses === "number" && typeof usage.duration_ms === "number"
      ? { tokens: usage.total_tokens, toolUses: usage.tool_uses, durationMs: usage.duration_ms }
      : undefined;
    const parent = this.agentCallParents.get(call) ?? null;
    const isError = status !== "completed";
    const truncated = report.length > PREVIEW_CHARS;
    this.emit({
      type: "tool_result",
      toolUseId: call,
      isError,
      preview: truncated ? report.slice(0, PREVIEW_CHARS) : report,
      ...(parent !== null ? { parentToolUseId: parent } : {}),
      agentEnded: true,
      ...(truncated ? { truncated } : {}),
      ...(report.trim() ? { agentReport: report.slice(0, AGENT_REPORT_CHARS) } : {}),
      ...(agentUsage ? { agentUsage } : {}),
      ...(!isError && report.trim() ? { keptReport: { text: report.slice(0, AGENT_REPORT_KEPT_CHARS), truncated: report.length > AGENT_REPORT_KEPT_CHARS } } : {}),
    });
  }

  private emitBackgroundTasks(): void {
    this.emit({ type: "background_tasks", tasks: [...this.bgTasks.values()].map((t) => ({ ...t })) });
  }

  // ------------------------------------------------------------------ §29 peer messages, turn ownership

  /**
   * Whether this `result` ends the turn we are running: our uuid echoed (`user_message_uuid(s)`), else the command the
   * lifecycle frames say runs (ours / a released peer's vs someone else's), else — a CLI without those frames — a peer
   * message we did not release is not ours, anything else is when our turn is active (the §18 rule).
   */
  private ownsResult(msg: Extract<SDKMessage, { type: "result" }>, fromPeer: boolean): boolean {
    if (!this.turnActive) return false;
    if (echoedUuids(msg).some((u) => this.ownCommands.has(u))) return true;
    if (this.ownRunning !== null) return true;
    if (this.externalCommands.size > 0) return false;
    if (fromPeer && this.releasedPeers.size === 0) return false;
    return true;
  }

  /**
   * One `result` per CLI turn: every command of that turn is over with it (its `completed` frame follows). Clearing here
   * means a lost frame can never leave an external turn "running" — and the input closed — for good.
   */
  private endOfCliTurn(): void {
    this.ownRunning = null;
    if (this.externalCommands.size > 0) {
      const last = [...this.externalCommands].at(-1)!;
      this.externalCommands.clear();
      this.emit({ type: "external_turn", running: false, commandUuid: last });
    }
    this.syncGuard();
  }

  /** Released peer messages whose command has not started yet: the review turn goes on through their results. */
  private peerTurnWaits(): boolean {
    // §52.2: so does a message of ours the CLI still holds in its queue behind a turn it ran itself.
    return this.sawLifecycle && [...this.releasedPeers, ...this.steered, ...this.queuedOwn].some((id) => !this.peerStarted.has(id));
  }

  private deferPeerResult(sessionId: string, subtype: string, totalCostUsd: number, inputTokens: number, outputTokens: number, durationMs: number, modelUsage?: Record<string, unknown>): void {
    const u = this.peerTurnUsage ?? { inputTokens: 0, outputTokens: 0, durationMs: 0 };
    this.peerTurnUsage = { inputTokens: u.inputTokens + inputTokens, outputTokens: u.outputTokens + outputTokens, durationMs: u.durationMs + durationMs };
    this.peerTurnDeferred = { sessionId, subtype, totalCostUsd, ...(modelUsage ? { modelUsage } : {}) };
    if (this.peerTurnTimer) clearTimeout(this.peerTurnTimer);
    // Should the next released message never start, the turn still ends (and is collected).
    this.peerTurnTimer = setTimeout(() => this.finishDeferredPeerTurn(), PEER_TURN_GAP_MS);
    this.peerTurnTimer.unref?.();
  }

  private finishDeferredPeerTurn(): void {
    const d = this.peerTurnDeferred;
    if (!d || !this.turnActive) return;
    const modelUsage = d.modelUsage;
    const earlier = this.takePeerTurnUsage();
    const costUsd = d.totalCostUsd >= this.lastTotalCostUsd ? d.totalCostUsd - this.lastTotalCostUsd : d.totalCostUsd;
    const models = this.turnModels(modelUsage, d.totalCostUsd); // MARK: wave4d w4d-agents2 (§42.4)
    this.lastTotalCostUsd = d.totalCostUsd;
    this.emitTurnEnd({ stopReason: this.wasInterrupted() ? "interrupted" : d.subtype, sessionId: d.sessionId, usage: { ...earlier, costUsd, ...models } });
  }

  private takePeerTurnUsage(): { inputTokens: number; outputTokens: number; durationMs: number } {
    const u = this.peerTurnUsage ?? { inputTokens: 0, outputTokens: 0, durationMs: 0 };
    this.peerTurnUsage = null;
    this.peerTurnDeferred = null;
    if (this.peerTurnTimer) clearTimeout(this.peerTurnTimer);
    this.peerTurnTimer = null;
    return u;
  }

  /** `command_lifecycle {command_uuid, state}`: queued → started → completed / cancelled. */
  private onLifecycle(f: { command_uuid?: unknown; state?: unknown; wakeup_source?: unknown }): void {
    const id = typeof f.command_uuid === "string" ? f.command_uuid : "";
    const state = typeof f.state === "string" ? f.state : "";
    if (!id || !state) return;
    this.sawLifecycle = true;
    if (state === "queued") return;
    if (state === "started") {
      const wakeup = typeof f.wakeup_source === "string" && f.wakeup_source ? f.wakeup_source : null;
      if (wakeup !== null && !this.ownCommands.has(id) && !this.releasedPeers.has(id) && this.canAdopt()) {
        // §52: a scheduled run (`/loop`, cron, ScheduleWakeup) is ours: it joins the turn that runs, or becomes a review turn.
        this.ownCommands.add(id);
        if (!this.turnActive) {
          this.beginAutoTurn("schedule", id, wakeup);
          return;
        }
      }
      if (this.ownCommands.has(id) || this.releasedPeers.has(id)) {
        this.ownRunning = id;
        if (this.releasedPeers.has(id) || this.steered.has(id) || this.queuedOwn.has(id)) this.peerStarted.add(id);
      } else if (!this.externalCommands.has(id)) {
        this.externalCommands.add(id);
        if (this.externalCommands.size === 1) this.emit({ type: "external_turn", running: true, commandUuid: id });
      }
      this.syncGuard();
      return;
    }
    // completed / cancelled (any terminal state)
    this.ownCommands.delete(id);
    if (this.ownRunning === id) this.ownRunning = null;
    if (this.releasedPeers.has(id) || this.steered.has(id) || this.queuedOwn.has(id)) this.peerStarted.add(id); // folded into a running turn without a `started` of its own
    if (this.externalCommands.delete(id) && this.externalCommands.size === 0) this.emit({ type: "external_turn", running: false, commandUuid: id });
    this.syncGuard();
    if (this.peerTurnDeferred && !this.peerTurnWaits()) this.finishDeferredPeerTurn();
  }

  /** `system/peer_message_hold {state, message_uuid, from, from_name, cause | outcome}` (no body: that comes with the release). */
  private onPeerHold(f: Record<string, unknown>): void {
    const id = typeof f.message_uuid === "string" ? f.message_uuid : "";
    const state = f.state === "held" || f.state === "released" || f.state === "dropped" ? f.state : null;
    if (!id || !state) {
      this.opts.log("debug", `peer_message_hold ignored: ${JSON.stringify(f).slice(0, 200)}`);
      return;
    }
    if (state === "released" && this.releasing) this.releasedPeers.add(id); // let through by our accept
    const str = (k: string) => (typeof f[k] === "string" && f[k] ? (f[k] as string) : undefined);
    const fromName = str("from_name");
    const cause = str("cause");
    const outcome = str("outcome");
    this.emit({ type: "peer_hold", state, messageUuid: id, from: str("from") ?? "", ...(fromName ? { fromName } : {}), ...(cause ? { cause } : {}), ...(outcome ? { outcome } : {}) });
    for (const w of [...this.peerWaiters]) {
      if (w.state !== state || !(w.ids.has(id) || (state === "released" && this.releasing))) continue;
      if (!w.got.includes(id)) w.got.push(id);
      if ([...w.ids].every((x) => w.got.includes(x))) w.done();
    }
  }

  /** A replayed user message: a peer's (`origin.kind: "peer"`) is reported with its body, ours is ignored. */
  private onReplay(m: { uuid?: unknown; origin?: unknown }): void {
    // §52.2: a subagent's hand-back (SubagentHandback) comes as a message "from another session" — it is the agent's
    // result, never a peer message: its call's result says it (when the notification did not already).
    const handback = handbackOf(m.origin);
    if (handback) {
      this.emitAgentEnd({ task_id: handback.taskId, status: "completed", handback_report: { text: handback.report } });
      return;
    }
    const origin = peerOriginOf(m.origin);
    if (!origin) return;
    const id = typeof m.uuid === "string" ? m.uuid : null;
    const owned = this.turnActive && id !== null && this.releasedPeers.has(id);
    if (owned) {
      if (this.peerDelivered.has(id!)) return;
      this.peerDelivered.add(id!);
    } else this.externalPeerSeen = true;
    this.emit({ type: "peer_delivered", messageUuid: id, owned, origin });
  }

  /** Resolves with the ids that reached `state` — all of `ids`, or what came within the timeout. */
  private waitPeerFrames(state: "released" | "dropped", ids: readonly string[]): Promise<string[]> {
    const timeoutMs = this.opts.settings.peerReleaseTimeoutMs ?? PEER_RELEASE_TIMEOUT_MS;
    return new Promise<string[]>((resolve) => {
      const w = { state, ids: new Set(ids), got: [] as string[], done: () => {} };
      const timer = setTimeout(() => w.done(), timeoutMs);
      timer.unref?.();
      w.done = () => {
        clearTimeout(timer);
        this.peerWaiters = this.peerWaiters.filter((x) => x !== w);
        resolve([...w.got]);
      };
      this.peerWaiters.push(w);
    });
  }

  async releasePeers(ids: readonly string[], checkpointTree?: string): Promise<string[]> {
    const q = this.requireQuery();
    if (this.turnActive) throw new Error("a turn is running");
    this.resetTurn();
    this.takeIdleWork(); // §52.2
    this.queuedOwn = new Set();
    this.reportedApiErrors = new Set();
    this.hookBlockedThisTurn = false; // MARK: wave4 w4-longwork
    this.continuationBlock = null; // MARK: wave4c w4c-trust
    this.hookCtx.checkpointTree = checkpointTree;
    this.releasedPeers = new Set();
    this.peerStarted = new Set();
    this.peerDelivered = new Set();
    this.takePeerTurnUsage();
    // Active before the release: the peer turn's first tool call must already pass as ours.
    this.setTurnActive(true);
    const waited = this.waitPeerFrames("released", ids);
    this.releasing = true;
    try {
      await q.applyFlagSettings({ crossSessionInbound: "accept" });
    } finally {
      // Straight back: a message arriving now would otherwise run unasked (the window is the call's ~40 ms round trip).
      await q.applyFlagSettings({ crossSessionInbound: this.inbound ?? "hold" }).catch((e) => this.opts.log("warn", `crossSessionInbound back to ${this.inbound ?? "hold"} failed: ${String(e)}`));
      this.releasing = false;
    }
    const got = await waited;
    const released = [...new Set([...got, ...this.releasedPeers])];
    if (released.length === 0) {
      this.setTurnActive(false);
      this.resetTurn();
      throw new Error(`no held peer message was released within ${this.opts.settings.peerReleaseTimeoutMs ?? PEER_RELEASE_TIMEOUT_MS} ms`);
    }
    this.releasedPeers = new Set(released);
    return released;
  }

  async dismissPeers(ids: readonly string[]): Promise<string[]> {
    const q = this.requireQuery();
    if (ids.length === 0) return [];
    const waited = this.waitPeerFrames("dropped", ids);
    try {
      await q.applyFlagSettings({ crossSessionInbound: "refuse" });
    } finally {
      if (this.inbound !== "refuse") {
        await q.applyFlagSettings({ crossSessionInbound: this.inbound ?? "hold" }).catch((e) => this.opts.log("warn", `crossSessionInbound back to ${this.inbound ?? "hold"} failed: ${String(e)}`));
      }
    }
    return waited;
  }

  async setPeerInbound(value: "hold" | "refuse"): Promise<void> {
    await this.requireQuery().applyFlagSettings({ crossSessionInbound: value });
    this.inbound = value;
  }

  private emitToolResult(toolUseId: string, isError: boolean, content: unknown, parent: string | null): void {
    const raw = resultText(content);
    // MARK: wave3 engine-agents — §36.1: an Agent / Task result is its subagent's report, shown and kept without the CLI's
    // hand-back frame; §36.3: so is a SendMessage continuation's (a JSON status line, then the same frame).
    const toolName = this.turnToolNames.get(toolUseId) ?? this.openCalls.get(toolUseId)?.name ?? "";
    const agentCall = SUBAGENT_TOOL_RE.test(toolName);
    // §52.2: a subagent launched in the background answers its call at once ("Async agent launched …"): that is no report —
    // its own result comes when it ends (`emitAgentEnd`).
    const launched = agentCall && !isError && this.launchedInBackground(toolUseId, raw);
    const report = (agentCall && !launched) || toolName === "SendMessage" ? cleanAgentReport(raw, { jsonLead: !agentCall }) : undefined;
    const text = report?.cleaned ? report.text : raw;
    const keep = !launched && !isError && text.trim() !== "" && (agentCall || report?.cleaned === true);
    const truncated = text.length > PREVIEW_CHARS;
    const bash = this.bashCalls.get(toolUseId);
    this.bashCalls.delete(toolUseId);
    // §52: a Bash call that went to the background (run_in_background, Ctrl+B) names its output file.
    if (bash && !isError) {
      const out = outputPathOf(raw);
      if (out) this.noteBackgroundOutput(toolUseId, out);
    }
    const kept = bash && truncated ? keptOutput(text) : undefined;
    const testOutcome = bash ? detectTestOutcome(bash.command, isError, text, bash.background, this.opts.testCommandPatterns?.() ?? []) : undefined;
    // §34.8: what an Agent / Task call returns is its subagent's report — kept for the turn's `why` (never on the wire).
    const agentReport = agentCall && !launched && text.trim() ? text.slice(0, AGENT_REPORT_CHARS) : undefined;
    this.emit({
      type: "tool_result",
      toolUseId,
      isError,
      preview: truncated ? text.slice(0, PREVIEW_CHARS) : text,
      ...(parent !== null ? { parentToolUseId: parent } : {}),
      ...(launched ? { agentLaunched: true as const } : {}),
      ...(truncated ? { truncated } : {}),
      ...(kept !== undefined ? { output: { text: kept.output, truncated: kept.truncated } } : {}),
      ...(testOutcome !== undefined ? { testOutcome } : {}),
      ...(agentReport !== undefined ? { agentReport } : {}),
      ...(report?.usage ? { agentUsage: report.usage } : {}),
      ...(report?.cliAgentId ? { cliAgentId: report.cliAgentId } : {}),
      ...(keep ? { keptReport: { text: text.slice(0, AGENT_REPORT_KEPT_CHARS), truncated: text.length > AGENT_REPORT_KEPT_CHARS } } : {}),
    });
  }

  // ------------------------------------------------------------------ permissions

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    if (this.hookCtx.adoption) await this.hookCtx.adoption; // §52: nothing runs before the engine took the turn
    // §19.3: a Bash command is judged where it runs (the session's folder; `cd` / `git -C` into the repository's worktrees) —
    // only a command that moves at all needs the repository's worktrees.
    const moves = toolName === "Bash" && typeof input.command === "string" && /\b(?:cd|pushd)\b|-C\b/.test(input.command);
    const ro = moves ? await readOnlyContextOf(this.hookCtx, this.hookCtx.cwd) : undefined;
    // `ExitPlanMode` (CLI 2.1.275+) must never reach a permission card: allowing it lets the very
    // same turn leave plan mode and implement. We take its plan text, hand it to the engine as a
    // proposal and deny the tool, so the turn ends with the plan awaiting `plan_response`.
    // Outside an engine-started turn nothing may change (the PreToolUse hooks already deny; safety net) — §52.2: but a
    // subagent working in the background may.
    const askingAgent = typeof options.agentID === "string" && options.agentID ? options.agentID : undefined;
    if (unpromptedBlocked(toolName, input, this.hookCtx, ro, askingAgent)) {
      this.onUnprompted(toolName);
      return { behavior: "deny", message: UNPROMPTED_REASON };
    }
    if (toolName === EXIT_PLAN_MODE_TOOL) {
      const raw = input.plan;
      this.emit({
        type: "plan_exit",
        plan: typeof raw === "string" ? raw.slice(0, MAX_PLAN_BYTES) : "",
        planFiles: [...(this.hookCtx.planFiles ?? [])],
      });
      return { behavior: "deny", message: EXIT_PLAN_MODE_DENY };
    }
    const file = this.fileOf(input);
    // An edit into `.git/` (hooks, config) is denied outright, never even offered on the permission
    // card — same rule as the PreToolUse hook, should the CLI still reach this callback.
    if (file !== undefined && AUTO_ALLOW_RE.test(toolName) && (await isGitInternalEdit(file, this.hookCtx))) {
      return { behavior: "deny", message: GIT_INTERNAL_REASON };
    }
    // Plan mode's own writes under `<home>/.claude/plans/` never reach the permission card; the
    // PreToolUse hook already allowed them, this is the safety net should the CLI still ask.
    if (file !== undefined && AUTO_ALLOW_RE.test(toolName) && isPlanFile(file, this.hookCtx)) {
      this.hookCtx.planFiles?.add(file);
      return { behavior: "allow", updatedInput: input };
    }
    // Plan mode: no edits (except the plan file above) and no non-read-only Bash — same rule as the PreToolUse hooks.
    const planDeny = planModeBlocked(toolName, input, this.hookCtx, ro);
    if (planDeny) return { behavior: "deny", message: planDeny };
    // Only edit tools and the worktree tools need the containment root (resolved lazily through git).
    const needsRoot = (AUTO_ALLOW_RE.test(toolName) && file !== undefined) || WORKTREE_TOOLS_RE.test(toolName);
    const root = needsRoot ? await containmentRoot(this.hookCtx) : this.hookCtx.root ?? this.hookCtx.cwd;
    // §33.4: EnterWorktree, and isolated agents / Workflow unless allowed — same rule as the PreToolUse hook.
    const worktreeDeny = worktreeToolBlocked(toolName, input, root, this.hookCtx.allowWorktreeIsolation === true);
    if (worktreeDeny) return { behavior: "deny", message: worktreeDeny };
    // §33: parallel subagents hold several requests at once; each carries its call and the asking agent.
    const toolUseId = typeof options.toolUseID === "string" && options.toolUseID ? options.toolUseID : undefined;
    const agentId = typeof options.agentID === "string" && options.agentID ? options.agentID : undefined;
    // Edit tools are auto-allowed only where the review sees them — inside the checkpoint root and not in a nested
    // repository under it (§33.3) — and never for Claude Code's own settings files (§33.9); the PreToolUse hook answered
    // `ask` for the rest (hooks.ts) and the user decides on the permission card, whose `reason` says why. A call the hooks
    // put on a card for working outside the review (a worktree command, another worktree, an isolated agent; §33.4), for
    // naming a settings file (Bash, a writing MCP tool; §33.9) or for a git command that throws away uncommitted work or
    // rewrites the remote (§46) — found here too should the hook not have seen the call — keeps that reason and is never
    // auto-allowed either.
    const outsideRoot = AUTO_ALLOW_RE.test(toolName) && file !== undefined && isOutsideRoot(file, root);
    const scope: PermissionReason | null =
      (toolUseId ? this.hookCtx.scopeReasons?.get(toolUseId) : undefined) ??
      (AUTO_ALLOW_RE.test(toolName) && file !== undefined ? editScopeReason(file, root, isOutsideRoot, outsideRoot ? await otherWorktrees(this.hookCtx) : [], this.hookCtx.scratchDirs) : null) ??
      (isolatedCall(toolName, input, root) ? { code: "worktree_isolation", message: SCOPE_MESSAGES.worktree_isolation } : null) ??
      configScopeReason(toolName, input, this.hookCtx.cwd, root, this.hookCtx, ro) ??
      (await gitCommandReason(toolName, input, this.hookCtx)); // MARK: r1-git (§46): destructive git only
    const outside = scope !== null;
    // An approved edit the snapshot never sees goes to changedOutside (§8); a settings file is the review's own business
    // (mods group, or `local_settings_changed` for .claude/settings.local.json — §32).
    const unreviewedFile = scope !== null && scope.code !== "claude_config" ? file : undefined;
    if (!outside && (AUTO_ALLOW_RE.test(toolName) || this.autoAllowTools.has(toolName))) {
      return { behavior: "allow", updatedInput: input };
    }
    // Same rules as the PreToolUse hooks (read-only Bash, allow patterns, session-remembered allows):
    // a hook `allow` normally skips this callback, but never re-ask should the CLI still reach it.
    if (!outside && autoAllowReason(toolName, input, this.hookCtx, ro)) {
      return { behavior: "allow", updatedInput: input };
    }
    // §33.6: what "always allow in this project" may store for this call (never for a call outside the review).
    const allowPatterns = scope ? [] : allowPatternSuggestions(toolName, input);
    // MARK: wave4d w4d-peers — §42.2: the SendMessage card names the session its address reaches; a call the CLI
    // withdrew meanwhile gets no card (its abort already fired).
    const toSession = toolName === "SendMessage" ? await this.peerRecipient(input) : null;
    if (options.signal.aborted) return { behavior: "deny", message: "aborted" };
    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      const finish = (r: PermissionResult, cancelled = false) => {
        if (!this.pendingPermissions.delete(requestId)) return; // already answered
        resolve(r);
        if (cancelled && !this.disposing) this.emit({ type: "permission_cancelled", requestId });
      };
      this.pendingPermissions.set(requestId, { resolve: finish, ...(unreviewedFile ? { outsideFile: unreviewedFile } : {}) });
      options.signal.addEventListener("abort", () => finish({ behavior: "deny", message: "aborted" }, true), { once: true });
      this.emit({
        type: "permission_request",
        requestId,
        toolName,
        input,
        file,
        ...(toolUseId ? { toolUseId } : {}),
        ...(agentId ? { agent: { agentId } } : {}),
        ...(scope ? { reason: scope } : {}),
        ...(allowPatterns.length > 0 ? { allowPatterns } : {}),
        ...(toSession ? { toSession } : {}), // MARK: wave4d w4d-peers
      });
    });
  };

  // ------------------------------------------------------------------ spawn

  /**
   * Same as the SDK's local spawn, but we keep the ChildProcess: the SDK's graceful close
   * (stdin EOF → SIGTERM) left `claude` alive when it was killed mid permission prompt, so
   * dispose() escalates to a kill on this handle.
   */
  private spawnClaude(opts: SpawnOptions): SpawnedProcess {
    const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
      windowsHide: true,
    });
    this.cliChild = child;
    this.cliExit = null;
    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
      this.stderrTail = stderrTail;
    });
    child.stderr.on("error", () => {});
    // "close" fires after exit AND after the stdio streams have closed, so the final stderr chunk
    // (which can arrive after "exit") is part of the tail.
    this.cliClosed = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        this.cliExit = { code, signal };
        if ((code !== 0 || signal) && stderrTail.trim()) {
          this.opts.log("warn", `claude exited (code=${code} signal=${signal}): ${stderrTail.trim()}`);
        }
        resolve();
      });
    });
    return child;
  }
}

// ------------------------------------------------------------------ helpers

function childAlive(c: ChildProcess): boolean {
  return c.exitCode === null && c.signalCode === null;
}

/**
 * §29: `origin` of a replayed user message / a result when it is a peer's (`kind: "peer"`); null otherwise. §52.2: a
 * subagent's hand-back (`handback: true`, CLI 2.1.318) is no peer message — see `handbackOf`.
 */
export function peerOriginOf(o: unknown): PeerOrigin | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.kind !== "peer" || typeof r.from !== "string") return null;
  if (r.handback === true) return null;
  const str = (k: string) => (typeof r[k] === "string" && r[k] ? (r[k] as string) : undefined);
  const name = str("name");
  const body = typeof r.body === "string" ? r.body : undefined;
  const fromMode = str("fromMode");
  const msgId = str("msg_id");
  return {
    from: r.from,
    ...(name ? { name } : {}),
    ...(typeof r.verifiedPeerPid === "number" ? { verifiedPeerPid: r.verifiedPeerPid } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(fromMode ? { fromMode } : {}),
    ...(msgId ? { msgId } : {}),
  };
}

/** The uuids of the messages a `result` says it answered (`user_message_uuid(s)`). */
function echoedUuids(msg: unknown): string[] {
  const r = msg as { user_message_uuid?: unknown; user_message_uuids?: unknown };
  return [...(Array.isArray(r.user_message_uuids) ? r.user_message_uuids : []), r.user_message_uuid].filter((u): u is string => typeof u === "string");
}

/**
 * §52.2: a subagent's final report delivered through its SubagentHandback tool, as the CLI stamps the message
 * (`origin {kind: "peer", from, senderTaskId, name?, body, handback: true, handbackReportText?, handbackNote?, flagged?}`);
 * null for anything else. `taskId`: the subagent's task; `report`: its words, without the harness's frame.
 */
export function handbackOf(o: unknown): { taskId: string; name?: string; report: string } | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.kind !== "peer" || r.handback !== true) return null;
  const taskId = typeof r.senderTaskId === "string" && r.senderTaskId ? r.senderTaskId : typeof r.from === "string" ? r.from : "";
  if (!taskId) return null;
  const report = typeof r.handbackReportText === "string" ? r.handbackReportText : typeof r.body === "string" ? r.body : "";
  return { taskId, ...(typeof r.name === "string" && r.name ? { name: r.name } : {}), report };
}

/** §52.2: the report a subagent's SubagentHandback delivered (`task_notification.handback_report.text`); undefined without one. */
export function handbackReportOf(m: unknown): string | undefined {
  const report = m && typeof m === "object" ? (m as { handback_report?: unknown }).handback_report : undefined;
  const text = report && typeof report === "object" ? (report as { text?: unknown }).text : undefined;
  return typeof text === "string" && text.trim() ? text : undefined;
}

/**
 * The SDK spawns `pathToClaudeCodeExecutable` without a shell, and Node refuses a `.cmd` / `.bat`
 * there (EINVAL). On Windows a batch shim is looked through (platform/winShell.ts `resolveCmdShim`):
 * the native `.exe` it launches is spawned directly, a `.js` (npm's `cli.js`) runs under the current
 * node (`ELECTRON_RUN_AS_NODE=1` covers Electron). Native `claude` / `claude.exe` is spawned as is.
 * A shim with nothing runnable behind it stays unresolved — `claudeLaunchProblem` reports it.
 */
export function resolveClaudeExecutable(
  claudePath: string,
  isWindows: boolean,
  fs: ShimFs = realShimFs,
): { path: string; executable?: string; env?: Record<string, string> } {
  if (isWindows && isBatchFile(claudePath)) {
    const shim = resolveCmdShim(claudePath, fs);
    if (shim?.kind === "exe") return { path: shim.path };
    if (shim?.kind === "node") return { path: shim.script, executable: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { path: claudePath };
}

/**
 * Why `claudePath` cannot be started without a shell (Windows: a `.cmd` / `.bat` whose target was not
 * found), or `null`. The engine refuses the session start with `cli_not_executable` instead of letting
 * the SDK fail with a bare `spawn EINVAL`.
 */
export function claudeLaunchProblem(claudePath: string, isWindows: boolean, fs: ShimFs = realShimFs): string | null {
  if (!isWindows || !isBatchFile(claudePath)) return null;
  if (resolveCmdShim(claudePath, fs)) return null;
  return `claude resolves to the batch file ${claudePath}, which cannot be started without a shell and does not point at a claude.exe or cli.js. Install the native Claude Code (claude.exe) or set its path in Settings.`;
}

/** Short human-readable hint for the HUD: file basename, first 60 chars of a command, skill/agent name. */
export function activityDetail(toolName: string, input: Record<string, unknown>, file: string | undefined): string | undefined {
  if (file) return basename(file);
  // MARK: wave4b w4b-agents — §39.3: an MCP call's detail is its representative argument (one rule with the clients).
  if (toolName.startsWith("mcp__")) {
    const label = toolLabel(toolName, input);
    if (label.kind === "mcp") return label.arg;
  }
  const pick = (k: string) => (typeof input[k] === "string" && (input[k] as string).length > 0 ? (input[k] as string) : undefined);
  const raw =
    toolName === "Bash" ? pick("command")
    : SUBAGENT_TOOL_RE.test(toolName) ? pick("description") ?? pick("subagent_type")
    : pick("skill") ?? pick("pattern") ?? pick("query") ?? pick("url") ?? pick("path");
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : imagePlaceholder(b) ?? JSON.stringify(b)))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/**
 * An image block of a tool result (a `Read` of a .png, an MCP screenshot) as a short placeholder: its base64 must
 * never reach the wire preview or the transcript (§24 — images live in the attachment store, not in rows).
 */
function imagePlaceholder(b: unknown): string | undefined {
  if (!b || typeof b !== "object" || (b as { type?: unknown }).type !== "image") return undefined;
  const src = (b as { source?: { media_type?: unknown; data?: unknown } }).source;
  const type = typeof src?.media_type === "string" ? src.media_type : "image";
  const bytes = typeof src?.data === "string" ? Math.floor((src.data.length * 3) / 4) : null;
  return `[${type}${bytes !== null ? `, ${bytes} bytes` : ""}]`;
}

/**
 * MARK: wave4c w4c-trust — §41.2: a `hook_response` of a hook whose block the CLI also reports as
 * `informational{prevent_continuation}` (a UserPromptSubmit / Stop / SubagentStop hook — not a PreToolUse deny).
 */
function isContinuationHook(msg: { hook_event?: unknown; hook_name?: unknown }): boolean {
  const event = typeof msg.hook_event === "string" && msg.hook_event ? msg.hook_event : typeof msg.hook_name === "string" ? msg.hook_name.split(":")[0]! : "";
  return event === "UserPromptSubmit" || event === "Stop" || event === "SubagentStop";
}

/** The trimmed text block before a tool_use; its last `RATIONALE_CHARS` (where "Let me …" sits) when longer. */
export function rationaleOf(text: string | undefined): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  return t.length > RATIONALE_CHARS ? "…" + t.slice(-(RATIONALE_CHARS - 1)).trimStart() : t;
}
