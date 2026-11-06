/**
 * Protocol v2 wire types (docs/PROTOCOL.md). NDJSON over stdio (Mac) or the same objects over
 * Electron IPC. Commands may carry `id`; every command with an `id` gets exactly one reply carrying
 * that `id` (the typed reply listed for it, else `result`).
 */
import type { ChangedFile, ChangeStatus, SkippedPath } from "./git/checkpoint.js";
import type { BranchInfo, BranchSwitchBlocker } from "./git/branches.js";
import type { FileDiff } from "./diff/parse.js";
import type { DraftComment, GHAccount, PRComment, PRDetail, PRFileMeta, PRReview, PRSummary, ReviewEvent } from "./pr/models.js";
import type { DiffSide, NoteAnchor, ReviewNote } from "./review/notes.js";
import type { FileOrigin } from "./session/provenance.js";
import type { FileRiskKind } from "./review/fileRisk.js"; // MARK: wave4b w4b-files

export type { FileOrigin, NoteAnchor, SkippedPath };

export const PROTOCOL_VERSION = 2 as const;

/**
 * The per-turn change budget. §54: opt-in — 0 is no limit on that count, and the engine's default `{0, 0}` is no change
 * budget at all (nothing counted, warned of or denied; Claude is told nothing).
 */
export type Budget = {
  maxFiles: number;
  maxLines: number;
  /** default 1.5 when absent; the engine's default settings carry 2.0 (docs/M16-FRICTION.md §4) */
  hardMultiplier?: number;
};

/** `state.gate.reviewSummary`: totals over `changedFiles` (every state) for the composer label. */
export type ReviewSummary = { files: number; added: number; deleted: number };

export type BudgetUsage = { files: number; lines: number; denied: boolean };

export type LogLevel = "debug" | "info" | "warn" | "error";

/** `tool_result.testOutcome`: a recognizable test runner's verdict (docs/PROTOCOL.md §2). */
export type TestOutcome = "pass" | "fail";

export type ActivityKind = "tool_start" | "tool_end" | "subagent_start" | "subagent_end" | "thinking" | "idle";

/**
 * §33: the subagent whose tool call raised a permission request (absent for the main agent). `agentId` is the SDK's
 * `agentID` (= the task id, `AgentNode.id`); the rest comes from `state.hud.agents` when the engine knows the agent.
 */
export type PermissionAgent = {
  agentId: string;
  /** The Agent/Task tool_use that spawned it (`AgentNode.toolUseId`). */
  agentToolUseId?: string;
  /** Its `subagent_type`. */
  subagentType?: string;
  description?: string;
};

/**
 * §33.3 / §33.4 / §33.9 / §46: why ReviewGate puts this call on a card although it would otherwise run — it works somewhere
 * this window's review does not see, (`claude_config`) it changes Claude Code's own settings, or (`git_command`) it is a git
 * command that throws away uncommitted work or rewrites the remote (r1-git). `message` is the English fallback; clients
 * localize on `code` (and show `message` for a code they do not know).
 */
export type PermissionReason = {
  code: "outside_project" | "nested_repository" | "other_worktree" | "worktree_command" | "worktree_isolation" | "claude_config" | "git_command";
  message: string;
  /** The nested repository / worktree root concerned (absolute, native); for `claude_config` the settings file itself. */
  path?: string;
  /** §39.4 `worktree_command`: the worktree is another repository's (the command `cd`s / `-C`s there) — no chat can follow it. */
  otherRepository?: true;
};

export type PermissionRequest = {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** absolute path from file_path/notebook_path if present */
  file?: string;
  /** §33: the tool_use id of the call (`tool_use.id`). */
  toolUseId?: string;
  /** §33: set when a subagent asks. */
  agent?: PermissionAgent;
  /** §33.3: set when the call works outside what the review sees. */
  reason?: PermissionReason;
  /** §33.6: patterns "always allow in this project" may store for this call, most specific first (MCP tool / server, WebFetch domain, …). */
  allowPatterns?: string[];
  // MARK: wave4d w4d-peers
  /** §42.2: a SendMessage to another session's address — the live session it reaches (the registry); absent when none is known. */
  toSession?: PeerSessionInfo;
};

// MARK: wave4d w4d-peers
/** §42.2: the Claude session a cross-session address (`uds:<socket>`) names, as the user's session registry lists it (only read). */
export type PeerSessionInfo = {
  /** The address as the call named it. */
  address: string;
  pid: number;
  /** The registry's name (`acme-b4`, `ReviewGate · acme`); null when it has none. */
  name: string | null;
  cwd: string | null;
  status: CliSessionStatus;
  /** `cli` (a terminal), `sdk-ts` (an app such as ReviewGate), … */
  entrypoint: string | null;
};

/** §42.2: this window's main session as the user's other sessions see it (`cli_sessions.self`). */
export type PeerSelf = {
  pid: number;
  /** The `--name` the registry lists (`ReviewGate · <project>…`); null when it has none. */
  name: string | null;
  /** `uds:<socket>` other sessions send to; null when the registry lists no socket (an older CLI, messaging off). */
  address: string | null;
};

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  /** This turn's cost (the SDK's cumulative `total_cost_usd` differenced against the previous turn). */
  costUsd: number;
  durationMs: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + cache_read + cache_creation of the last top-level assistant message of the turn = current context size. */
  contextTokens: number;
  contextWindow?: number;
  // MARK: wave4c w4c-commit
  /** §41.1 (SME-11): the conversation was compacted in this turn (`/compact`, or the CLI's own auto-compaction); absent otherwise. */
  compacted?: TurnCompaction;
  // MARK: wave4d w4d-agents2
  /** §42.4: what each model cost this turn (the SDK's cumulative `modelUsage` differenced), most expensive first; absent when the CLI sent none. */
  models?: ModelCost[];
};

/** §41.1: a `compact_boundary` of the turn — `manual` (`/compact`) or `auto`; `preTokens` the context before it. */
export type TurnCompaction = { trigger: "manual" | "auto"; preTokens?: number };

export type SessionCapabilities = {
  slashCommands: string[];
  skills: string[];
  plugins: string[];
  mcpServers: { name: string; status: string }[];
  /** The plugins with install path and `name@marketplace` id (§16); absent in caches written before it. */
  pluginDetails?: { name: string; path: string; id: string | null; version?: string }[];
  /** §36.5: the commands with description and argument hint (`initializationResult().commands`, then `system/commands_changed`); absent from older engines / caches. */
  commands?: SlashCommandInfo[];
  /** §36.5: `starting` until the CLI answered initialize (the lists are cached or empty meanwhile); absent = `ready`. */
  state?: CapabilitiesState;
};

/** A plugin of `SessionExtensions` (§16): loaded (`enabled`) or turned off through `settings.disabledPlugins`. */
export type ExtensionPlugin = { name: string; id: string | null; path: string | null; version?: string; enabled: boolean };
/** A hooks source besides ReviewGate's own (§16). */
export type ExtensionHook = { source: "user" | "project" | "plugin"; plugin?: string; path: string; events: string[]; active: boolean };
/** A memory file (CLAUDE.md, auto memory) the CLI loaded (`getContextUsage().memoryFiles`). */
export type MemoryFile = {
  path: string;
  type: string;
  tokens?: number;
  // MARK: wave4d w4d-config — §42.3
  /** What the file is and so when Claude reads it (the engine's one rule); absent from older engines. */
  kind?: InstructionKind;
  /** `claude_md_write` can save it: a CLAUDE.md / CLAUDE.local.md inside the project. */
  editable?: true;
};

/** What the running session applied from the user's extensions (`state.session.extensions`, §16). */
export type SessionExtensions = {
  /** The CLI's `settingSources` (§36.6: `local` = `.claude/settings.local.json` + the local-scope MCP servers). */
  settingSources: ("user" | "project" | "local")[];
  /** The session was restarted without user settings because the CLI did not initialize in time. */
  fallback: { reason: "init_timeout"; timeoutMs: number; at: string } | null;
  plugins: ExtensionPlugin[];
  /** Plugin ids passed as `enabledPlugins: {id: false}`. */
  disabledPlugins: string[];
  /** `settings.disabledPlugins` entries without `@` that no known plugin matched (ignored). */
  unresolvedDisabledPlugins: string[];
  /** `settings.disableUserHooks` applied (`disableAllHooks`): settings-file and plugin hooks do not run. */
  userHooksDisabled: boolean;
  skills: string[];
  slashCommands: string[];
  mcpServers: { name: string; status: string }[];
  /** null until the CLI reported them (shortly after start). */
  memoryFiles: MemoryFile[] | null;
  claudeMd: { user: boolean; project: boolean; source: "cli" | "files" };
  hooks: ExtensionHook[];
  /** §36.6: what the local settings hold that this session does not apply (`settings.loadLocalSettings: false`); null when they apply / hold nothing. */
  notApplied?: NotAppliedLocalSettings | null;
  // MARK: wave4d w4d-config — §42.3
  /** The project's own instruction files the app can edit (`claude_md_write`), whether they exist yet or not. */
  projectInstructions?: ProjectInstructionFile[];
  /** The subagents Claude can start (`initializationResult().agents`); absent until the CLI answered initialize. */
  agents?: SubagentInfo[];
  // MARK: wave5 w5-graph — §43.3
  /** The user's Claude Code mods (dev-mods and `CLAUDE_CODE_PLUGIN_DIRS`), read only; absent when there are none. */
  mods?: UserMod[];
};

/**
 * The permission modes we expose (docs/M20-MODES.md). The SDK's `bypassPermissions` / `dontAsk`
 * are deliberately NOT exposed — they would defeat the gate's approval flow.
 */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as readonly string[]).includes(v);
}

/** Reasoning effort levels of `set_model` / `settings.effort` (the SDK's `EffortLevel`; §25). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** One entry of `state.session.availableModels` (the CLI's `supportedModels()`, else a static list; §25). */
export type ModelOption = {
  /** What `set_model.model` takes (an alias such as `sonnet`, or a full id). */
  value: string;
  displayName: string;
  description: string;
  /** The wire id the alias resolves to (`claude-sonnet-5-5`), when the CLI said. */
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
};

/** Image types `send.attachments` accepts (§24). */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
/** An image sent with `send` / `rewind` (§24): raw base64, no `data:` prefix. */
export type SendAttachment = { kind: "image"; mediaType: ImageMediaType; dataBase64: string };
/** What the transcript / `user_message` keep of an attachment: the bytes live in `<gitdir>/reviewgate/attachments/<hash>.<ext>` (`attachment_get`). */
export type AttachmentRef = { kind: "image"; hash: string; mediaType: ImageMediaType; bytes: number };

/** One `list_files` match (§23). `changed`: the file is in the current review (`changedFiles`). */
export type FileItem = { path: string; kind: "file" | "dir"; changed?: true };

/** `rewind.mode` (§26). */
export type RewindMode = "conversation" | "files" | "both";

/** One user turn of the current chat a client can rewind to (`state.session.checkpoints`, §26). */
export type TurnCheckpointView = {
  /** Transcript turn number (= `user_message.turn`). */
  turn: number;
  /** The user's text of that turn, ≤ 120 chars. */
  prompt: string;
  /** ISO-8601 */
  startedAt: string;
  /** ISO-8601; null while the turn runs or when it was never collected. */
  endedAt: string | null;
  /** Files the turn itself changed (its start tree → its end tree). */
  filesChanged: number;
  /** Files `rewind {mode: "files"}` to this turn would restore (changed by this turn and every later one). */
  filesSince: number;
  /** `rewind {mode: "files" | "both"}` is possible: this turn's start tree and every later end tree are known. */
  canRewindFiles: boolean;
  /** `rewind {mode: "conversation" | "both"}` is possible: the point right before this turn is known (or it is the chat's first turn). */
  canRewindConversation: boolean;
};

/** Largest plan file the engine reads back into `plan_proposed` / `state.session.pendingPlan`. */
export const MAX_PLAN_BYTES = 200 * 1024;

/**
 * The plan the last plan-mode turn proposed — through `ExitPlanMode` or by writing
 * `<home>/.claude/plans/<slug>.md` — waiting for `plan_response` (docs/M20-MODES.md).
 * Cleared by `plan_response` and by a plain `send`.
 */
export type PendingPlan = {
  /** Absolute path of the plan file, or `null` when the plan only came through `ExitPlanMode`. */
  path: string | null;
  /** Its content (truncated at `MAX_PLAN_BYTES`). */
  plan: string;
  /** ISO-8601 */
  at: string;
  // MARK: wave4d w4d-plan
  /** §42.1: the plan's steps (`parsePlanSteps`, §15) for per-step notes; absent from an older engine. */
  steps?: PlanStepBrief[];
};

export type Settings = {
  budget: Budget;
  /** Parsed, one entry per pattern. */
  ignorePatterns: string[];
  /** e.g. ["Bash"] */
  autoAllowTools: string[];
  loadUserSettings: boolean;
  /** Already rendered ({maxFiles}/{maxLines} substituted by the client). */
  systemPromptAppend: string;
  /** §36.8: also pins a CLI version (`~/.local/share/claude/versions/<ver>`); next session start. */
  claudePath?: string;
  ghPath?: string;
  gitPath?: string;
  /** PR browser host. */
  ghHost: string;
  model?: string;
  /** Base folder for managed workbenches (default `~/.reviewgate/worktrees`; docs/M10-WORKBENCHES.md). */
  worktreeRoot?: string;
  /** Default of `commit.push` when the command omits it (docs/M12-COMMIT.md; default false). */
  commitPushByDefault?: boolean;
  /** Appended to every commit message as a trailer line when non-empty (e.g. "Co-Authored-By: …"). */
  commitTrailer?: string;
  /** Restart the Claude session once (2 s backoff, at most once per turn) when it dies unexpectedly (default true). */
  autoRestartSession?: boolean;
  /** Read-only Bash commands (docs/M16-FRICTION.md §1) run without a permission_request (default true). */
  autoAllowReadOnlyBash?: boolean;
  /**
   * Claude-style allow patterns (`Bash(npm test:*)`, `Bash(git *)`) evaluated before asking (default []); since §33.6 also
   * `mcp__server__tool`, `mcp__server__*`, `WebFetch(domain:x)`, `WebSearch`, `Agent` for the other tools.
   */
  bashAllowPatterns?: string[];
  /** Permission mode a NEW session starts in (default `"default"`; docs/M20-MODES.md). Any other value refuses `invalid_mode`. */
  permissionMode?: PermissionMode;
  /**
   * With user settings loaded: restart without them when the CLI has not initialized after this many ms (default 20000; 0 = off; §16).
   * §36.7: a stall limit (every progress signal restarts it) and a floor: the engine waits max(this, the adaptive limit).
   */
  extensionsInitTimeoutMs?: number;
  /** Plugins to keep off (`name@marketplace`, or a bare name of a plugin seen before); next session start (§16). */
  disabledPlugins?: string[];
  /** Turn off every settings-file and plugin hook (ReviewGate's own hooks keep running); next session start (§16). */
  disableUserHooks?: boolean;
  /** Model of side-question sessions (§21; default: `model`). */
  sideModel?: string;
  /** §21, superseded by `sideWeb` (§40.3): `false` keeps the web off, `true` no longer turns it on. */
  sideAllowWeb?: boolean;
  /** Reasoning effort a NEW session starts with when the project has none stored (§25; default: the model's own). */
  effort?: EffortLevel;
  /** §29: messages from the user's other Claude sessions — `ask` (default), `auto` (accepted when idle) or `off`; a project's `peer_set` wins. */
  peerInbound?: PeerInboundMode;
  /** §33.4: the Workflow tool and agents with `isolation` / a `cwd` elsewhere get a card instead of a deny (default false; next session start). */
  allowWorktreeIsolation?: boolean;
  /** §33.5: the user's Claude Code `permissions.allow` rules apply to tools that cannot change files (default true; live). */
  applyUserAllowRules?: boolean;
  /** §33.7: `remember` allows are kept per worktree (`<gitdir>/reviewgate/allows.json`) and restored on `open_project` (default false). */
  persistSessionAllows?: boolean;
  /**
   * §34.9: extra test commands (`*` any run, `?` one char; whitespace collapsed) matched against every simple command of a
   * Bash call (split on `&&` `||` `;` `|` newlines), e.g. `./mvn25.sh*test*`; added to the built-in runners (default []; live).
   */
  testCommandPatterns?: string[];
  /** §36.6: also load `.claude/settings.local.json` and the local-scope MCP servers (per project in the clients; default true; next session start). */
  loadLocalSettings?: boolean;
  /** §36.11: the format `commit_draft` asks for; `{issue}` = the branch's issue number (§41.1: the number the recent subjects use, else the longest digit run), `{branch}` = the branch; without one the format learned from the subjects (per project; live). */
  commitTemplate?: string;
  /** §36.12: how `workbench_create` prepares a new workbench (per project; live). */
  workbenchSetup?: WorkbenchSetup;
  // MARK: wave4 w4-longwork
  /** §38.2: the tool-call limit of one message (the CLI's `maxTurns`; 10–1000, default 200; next session start). */
  maxTurns?: number;
  /**
   * §52: background Bash / Monitor / Ctrl+B and turns Claude starts itself (a finished background task, `/loop`, cron)
   * as review turns (default true; next session start). Off: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and §18.
   */
  backgroundWork?: boolean;
  // MARK: wave4b w4b-bigturn
  /** §39.1: an untracked file at least this large (MB) is kept out of snapshots as a stub (1–100000, default 50; live). */
  largeFileMB?: number;
  // MARK: wave4b w4b-side
  /**
   * §40.3: side questions on the web — `off` (the default), `rules` (only what the user's `WebFetch(domain:…)` / `WebSearch`
   * allow rules and the app's allow patterns allow), `on` (any site). `sideAllowWeb` no longer turns the web on (both clients
   * sent `true` as their default); absent or unknown = `off`.
   */
  sideWeb?: SideWebMode;
  // MARK: wave5 w5-model
  /** §43.4: `auto` picks the model of every message (default / unknown: `manual`, the chip's model; live). */
  modelMode?: ModelMode;
  /** §43.4: how auto picks — `cost`, `balanced` (default / unknown), `quality` (live). */
  modelAutoPolicy?: AutoModelPolicy;
  // MARK: wave6 w6-statusline
  /** §44.2: run the user's Claude Code status line (`statusLine` of their settings) for the clients to show (default true; live). */
  showStatusLine?: boolean;
  /**
   * §44.2: the sha256 (hex) of the project's own `statusLine` command (`.claude/settings(.local).json` — code from the
   * repository) the user allowed for THIS project; it runs only while its command hashes to this ("" / absent: none;
   * per project, as `loadLocalSettings`; live).
   */
  allowedProjectStatusLine?: string;
};

// ---------------------------------------------------------------- §34 review round 2

/**
 * §34.1: which part of a file's change a diff shows. The new side is always the review's B (`state.gate.reviewEndTree`);
 * the old side is A (`review`, the default), the last collected turn's own start tree (`turn`, "이번 턴"), B when the
 * last `request_changes` was sent (`request`, "요청 이후") or B when the file was accepted (`accepted`, "수락 이후").
 */
export const DIFF_SINCE = ["review", "turn", "request", "accepted"] as const;
export type DiffSince = (typeof DIFF_SINCE)[number];

export function isDiffSince(v: unknown): v is DiffSince {
  return typeof v === "string" && (DIFF_SINCE as readonly string[]).includes(v);
}

/** §34.1: a count of changed files with their added / deleted lines. */
export type ChangeTotals = { files: number; added: number; deleted: number };

/** §34.3: what the last collected turn itself changed (`changedThisTurn` files, its own start tree → B). */
export type LastTurnChanges = ChangeTotals & { turn: number };

/** §34.4: the last `request_changes` of the review in progress. `turn`: the follow-up turn; `notes`: how many it sent. */
export type ReviewRequestInfo = { turn: number; at: string; notes: number };

/** §34.7: why a file is folded by default — a lockfile, a generated file (gitattributes / marker), minified code. */
export type GeneratedKind = "lockfile" | "generated" | "minified";

/** §34.8: `tool_use.rationaleSource` — the text came from the call's own API message, or from earlier in the turn. */
export type RationaleSource = "same_message" | "earlier";

/** §34.8: where a file's `why` came from (`reported`: the turn-end report names the file; `none`: no record). */
export type WhySource = "reported" | "same_message" | "earlier" | "none";

/** §34.8: the best explanation the engine has for a file's change. */
export type FileWhy = {
  /** null with `source: "none"` ("원인 기록 없음"). */
  text: string | null;
  source: WhySource;
  /** `earlier`: tool calls of the same agent between the text and the change. */
  age?: number;
  /** `same_message` / `earlier`: the call whose rationale it is. */
  toolUseId?: string;
  /** The text is a subagent's (its own text before the call, or its report): the spawning Agent call. */
  agent?: { toolUseId: string; subagentType?: string };
  /** The change ran inside a subagent: the main agent's text before that Agent call ("위임 이유"). */
  delegation?: string;
  /** The transcript turn the text belongs to. */
  turn?: number;
};

/** §34.9: the last recognized test run of the turn, in execution order. */
export type LastTest = {
  verdict: TestOutcome;
  command: string;
  toolUseId: string;
  /** ISO-8601: when its tool_result arrived. */
  at: string;
  /** It ran after the turn's last file change (edit tool or file-changing Bash): "마지막 편집 이후 실행됨". */
  afterLastEdit: boolean;
  /** Recognized test runs in the turn (this one included). */
  runs: number;
};

/** §34.1–34.8: the review-round-2 fields of `state.changedFiles[]` (all optional; derived or kept by the engine). */
export type ChangedFileReview = {
  /** The last collected turn changed this file (its own start tree → B differ for it). */
  changedThisTurn?: true;
  /** With `changedThisTurn`: that turn's own +/- for the file. */
  turnAdded?: number;
  turnDeleted?: number;
  /** The tree entry id of `path` in B (absent for a deleted file): "봤음" is (path, blob). */
  blob?: string;
  /** Accepted earlier in this review, then a later turn changed it (it is pending again): `since: "accepted"` applies. */
  changedSinceAccepted?: true;
  /** Changed since the last `request_changes` of this review (or new since): `since: "request"` shows it. */
  changedSinceRequest?: true;
  generated?: GeneratedKind;
  /** Every changed line of the file differs only in whitespace. */
  whitespaceOnly?: true;
  /** Notes on the file already sent with `request_changes` (`noteCount` counts the unsent ones only). */
  sentNoteCount?: number;
  why?: FileWhy;
  // MARK: wave4b w4b-bigturn
  /** §39.1: an untracked file over `largeFileMB` on one side — its content was never stored (`uncaptured` too; not committed). */
  tooLarge?: true;
  /** §39.1: with `tooLarge`, the file's size in bytes as the newer snapshot recorded it. */
  largeBytes?: number;
  // MARK: wave4b w4b-files — §40.2 (comp-12): the risk badges, decided by the engine for both clients (`state.changedFiles[]`
  // only; derived whenever the state is built). Absent from an older engine: clients use their own rules.
  /** Badge kinds, most serious first (`FILE_RISK_KINDS` order); unknown kinds are ignored. */
  risks?: FileRiskKind[];
  /** The "risky first" order: higher first, ties in git order (sum of `FILE_RISK_WEIGHT`; a test file is below 0). */
  riskScore?: number;
  // MARK: wave4c w4c-trust
  /** §41.2: accepted by this repository's rule (state `accepted`); gone when the file is pending again. */
  autoAccepted?: AutoAcceptRule;
};

/** §34.6: one file of `live_changes` (the running turn's changes so far; never reviewable from here). */
export type LiveChangedFile = {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  added: number;
  deleted: number;
  isBinary: boolean;
  /** The file is also in the standing review (`changedFiles`). */
  inReview: boolean;
  generated?: GeneratedKind;
};

// ---------------------------------------------------------------- §29 peer messages

/** §29: `ask` parks peer messages for the user (a card), `auto` runs them when the engine is idle, `off` refuses them. */
export const PEER_INBOUND_MODES = ["ask", "auto", "off"] as const;
export type PeerInboundMode = (typeof PEER_INBOUND_MODES)[number];

export function isPeerInboundMode(v: unknown): v is PeerInboundMode {
  return typeof v === "string" && (PEER_INBOUND_MODES as readonly string[]).includes(v);
}

/**
 * §29: one message another Claude session of the user sent to this one (SendMessage). `from` / `fromName` are what the
 * SENDER claims; `verifiedPeerPid` (kernel-verified pid of the connecting process) is known once the message was
 * delivered. The body is only known after delivery (the CLI holds it without showing it).
 */
export type PeerMessage = {
  /** The CLI's message uuid (`peer_accept.ids` / `peer_dismiss.ids`). */
  id: string;
  /** Reply address the sender gave (`uds:/tmp/cc-socks/<pid>.sock`). */
  from: string;
  fromName: string | null;
  verifiedPeerPid: number | null;
  /** Why the CLI held it (`explicit-setting` = ReviewGate's hold, `mode-mismatch`, …); null when it was not held. */
  cause: string | null;
  /** ISO-8601 */
  receivedAt: string;
  /** held → (peer_accept) delivering → delivered; or dropped. */
  state: "held" | "delivering" | "delivered" | "dropped";
  /** dropped: `refused` (peer_dismiss / off), `expired`, `discarded` (the session ended first), or the CLI's own word. */
  outcome?: string;
  /** What the peer wrote (envelope stripped), once delivered. */
  body?: string;
  /** The transcript turn it runs in (a review turn of its own) once accepted. */
  turn?: number;
  /** Delivered without being held (a CLI without hold support, or a policy that accepts): it ran outside the review gate, its changes were blocked (§18). */
  unprompted?: true;
};

/** §29: a turn the CLI runs that is not ours (a peer message it delivered by itself, …): `send` waits (`gate_closed:external_turn`). */
export type ExternalTurn = { commandUuid: string | null; since: string; peer: { from: string; fromName: string | null; verifiedPeerPid: number | null } | null };

// ---------------------------------------------------------------- App → Engine

export type Cmd<T extends string, P = {}> = { type: T; id?: string } & P;

export type ClientKind = "mac" | "windows" | "test";

export type HelloCommand = Cmd<"hello", {
  protocolVersion: 2;
  client: ClientKind;
  env?: Record<string, string>;
  settings: Settings;
}>;

export type EngineCommand =
  | HelloCommand
  | Cmd<"set_settings", { settings: Partial<Settings> }>
  | Cmd<"open_project", { path: string; takeover?: boolean }>
  | Cmd<"switch_project", { path: string; takeover?: boolean }>
  | Cmd<"close_project">
  | Cmd<"init_repo">
  | Cmd<"cancel_git_init">
  | Cmd<"restart_session">
  /** `mentions`: repo-relative paths (§23); `attachments`: images (§24). */
  | Cmd<"send", { text: string; acceptPending?: boolean; mentions?: string[]; attachments?: SendAttachment[]
      /** MARK: wave5 w5-model — §43.4: this message only runs on this model (`set_model.model` rules); wins over auto. */
      model?: string }>
  | Cmd<"request_changes", { extra?: string; noteIds?: string[] }> // noteIds: only these unsent notes (default: all)
  | Cmd<"interrupt">
  | Cmd<"permission_response", { requestId: string; allow: boolean; message?: string; updatedInput?: Record<string, unknown>; remember?: boolean
      /** MARK: wave4b w4b-follow — §39.4: allow a worktree-creating command and hand this chat to the new worktree once it ran (`followUp` is sent there). */
      follow?: boolean; followUp?: string }>
  | Cmd<"forget_allows">
  | Cmd<"set_permission_mode", { mode: PermissionMode }>
  | Cmd<"plan_response", { approve: boolean; mode?: PermissionMode; message?: string
      /** MARK: wave4d w4d-plan — §42.1: implement in a fresh chat of this worktree, or in the workbench at `path` (approve only). */
      into?: PlanInto; path?: string }>
  /** MARK: wave4d w4d-plan — §42.1: the plan file this chat's "plan vs actual" follows (`null`: back to the automatic sources). */
  | Cmd<"plan_follow", { path: string | null }>
  | Cmd<"accept", { paths: string[] }>
  | Cmd<"unaccept", { paths: string[] }> // accepted → pending again (nothing on disk changes)
  | Cmd<"accept_all">
  /** `force: true` reverts even files the user edited after the review was collected (otherwise refused `file_changed_since_review`). */
  | Cmd<"reject", { paths: string[]; force?: boolean }>
  /** §31: without `includeExternal` only the pending files Claude changed (`origin` tool / bash) are reverted. */
  | Cmd<"reject_all", { force?: boolean; includeExternal?: boolean }>
  /**
   * Reverts only these hunks (`FileDiff.hunks[].id` of the file's current diff) of a pending modified file (§17).
   * §34.1 `expectedBaseTree`: the `file_diff.baseTree` the ids came from — anything but A refuses `stale_diff`.
   */
  | Cmd<"reject_hunks", { path: string; hunks: number[]; expectedEndTree?: string; expectedBaseTree?: string }>
  | Cmd<"retry_collect">
  | Cmd<"add_note", { path: string; line: number | null; side: DiffSide; excerpt: string; body: string }>
  | Cmd<"remove_note", { noteId: string }>
  | Cmd<"edit_note", { noteId: string; body: string }> // an unsent note's text
  /** §34.1 `since`: which part of the change (default `review`, A → B); also served while a turn runs (§34.2, `stale`). */
  | Cmd<"select_file", { path: string; since?: DiffSince; /** MARK: wave4c w4c-review — §41.3: the diff with whitespace ignored (`-w`); its hunk ids are not `reject_hunks` ids. */ ignoreWhitespace?: boolean }>
  | Cmd<"full_file", { path: string; since?: DiffSince }>
  /** §34.6: the running turn's changes so far (read-only); replies `live_changes`. */
  | Cmd<"live_changes">
  /** §34.6: one file of `live_changes`; replies `file_diff {scope: "live"}`. */
  | Cmd<"live_diff", { path: string }>
  /** The kept output of a Bash `tool_result` (≤ ~20k chars, this engine's lifetime only); replies `tool_output`. */
  | Cmd<"tool_output", { toolUseId: string }>
  | Cmd<"branches">
  | Cmd<"switch_branch", { name: string }>
  | Cmd<"create_branch", { name: string; from?: string }>
  | Cmd<"pr_list">
  | Cmd<"pr_open", { summaryId: string }>
  | Cmd<"pr_close">
  | Cmd<"pr_select_file", { filename: string }>
  | Cmd<"pr_add_draft", { path: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; body: string }>
  | Cmd<"pr_remove_draft", { draftId: string }>
  | Cmd<"pr_submit", { event: ReviewEvent; body: string }>
  | Cmd<"pr_reply", { commentId: number; body: string }>
  | Cmd<"pr_reload_comments">
  | Cmd<"accounts">
  | Cmd<"login_in_terminal", { host: string }>
  /** §50: a message into the turn that runs (as typing while Claude works in the terminal); `steer_unavailable:<why>` otherwise. */
  | Cmd<"steer", { text: string; mentions?: string[] }>
  /** §52: stops a background task (`Query.stopTask`). */
  | Cmd<"task_stop", { taskId: string }>
  /** §52: Ctrl+B — the running Bash call (all foreground tasks without an id) goes on in the background; replies `task_background`. */
  | Cmd<"task_background", { toolUseId?: string }>
  /** §52: the last 64 KiB of a background task's output; replies `task_output`. */
  | Cmd<"task_output", { taskId: string }>
  | Cmd<"workbench_list">
  /** §36.12: `from` may be a remote branch (`origin/develop`), fetched first unless `fetch: false`; `setup` (default true) copies files and runs the setup command; §36.14 `fromPr`. */
  /** §49: `task` — the new workbench's window starts a fresh chat with this message (in `mode`), apart from this chat. */
  | Cmd<"workbench_create", { branch: string; from?: string; path?: string; fetch?: boolean; setup?: boolean; location?: WorkbenchLocation; fromPr?: WorkbenchFromPr; task?: WorkbenchTask }>
  | Cmd<"workbench_remove", { path: string; force?: boolean }>
  | Cmd<"workbench_prune">
  | Cmd<"pr_create", { base: string; title?: string; body?: string; draft?: boolean } & PRCreateMeta>
  | Cmd<"commit", { message: string; paths?: string[]; push?: boolean }>
  | Cmd<"push">
  | Cmd<"refresh", { scope?: RefreshScope[] }>
  | Cmd<"session_list">
  | Cmd<"session_new">
  // `sessionId`, not `id`: `id` is the reply-correlation field of every command.
  | Cmd<"session_open", { sessionId: string }>
  | Cmd<"session_rename", { sessionId: string; title: string }>
  | Cmd<"session_archive", { sessionId: string; archived: boolean }>
  | Cmd<"session_delete", { sessionId: string }>
  | Cmd<"tabs_set", { openTabIds: string[] }>
  /** Past review rounds (docs/PROTOCOL.md §14); replies `review_history`. Default: the current session's; `all` = every session of the worktree. */
  | Cmd<"review_history", { sessionId?: string; all?: boolean }>
  /** Diff of one file of a history entry between its pinned trees; replies `history_diff`. */
  | Cmd<"history_diff", { entryId: string; path: string; final?: boolean }>
  // MARK: wave4c w4c-review — §41.3
  /** The new side of a history file's diff (the tree `history_diff` diffs to), for "20줄 더 보기"; replies `file_lines`. */
  | Cmd<"history_file_lines", { entryId: string; path: string; final?: boolean }>
  /** The open PR's file at its head commit, for "20줄 더 보기"; replies `file_lines`. */
  | Cmd<"pr_file_lines", { filename: string }>
  /** Both sides of a changed png / jpg / gif of the review (each ≤ 2 MB); replies `file_image`. */
  | Cmd<"file_image", { path: string }>
  // §21 side questions
  | Cmd<"side_ask", { threadId?: string; anchor?: SideAnchor; question: string; /** §40.3: fork the current main conversation again (with the thread's Q&A so far). */ refork?: boolean }>
  | Cmd<"side_list">
  | Cmd<"side_close", { threadId: string }>
  | Cmd<"side_cancel", { threadId: string }>
  | Cmd<"side_promote_draft", { threadId: string }>
  | Cmd<"side_promote", { threadId: string; as: "message" | "note"; text?: string; acceptPending?: boolean; /** §40.3: the client queued the text for the main conversation: only recorded. */ queued?: boolean }>
  // §22 MCP servers
  | Cmd<"mcp_status">
  | Cmd<"mcp_reconnect", { name: string }>
  | Cmd<"mcp_toggle", { name: string; enabled: boolean; /** §42.3: `repository` = every worktree of this repository; default this worktree. */ scope?: McpToggleScope }>
  | Cmd<"mcp_add", { name: string; scope: McpScope; config: McpAddConfig }>
  | Cmd<"mcp_remove", { name: string; scope: McpScope; /** §42.3: the `origin.file` the user confirmed — a folder above the project's `.mcp.json`. */ file?: string }>
  | Cmd<"mcp_auth", { name: string }>
  // §23–27
  /** Fuzzy file search for @-mentions; replies `files`. */
  | Cmd<"list_files", { query: string; limit?: number }>
  /** An image a transcript row references by hash; replies `attachment`. */
  | Cmd<"attachment_get", { hash: string }>
  /** Model / effort of the running session from its next request on; persisted per project. `effort: null` = the model's default. */
  | Cmd<"set_model", { model: string; effort?: EffortLevel | null }>
  /** Edit & retry: rewind the conversation and/or Claude's file changes to the start of `toTurn`; replies `rewound`. */
  | Cmd<"rewind", { toTurn: number; mode: RewindMode; editText?: string; mentions?: string[]; attachments?: SendAttachment[]; force?: boolean }>
  /** Runs the CLI's `/compact [focus]` as a turn. */
  | Cmd<"compact", { focus?: string }>
  // §29 peer messages
  /** Runs every held peer message as one review turn (gate rules of `send`); `ids` = the held ids the user saw (else `peer_inbox_changed`). */
  | Cmd<"peer_accept", { ids?: string[] }>
  /** Refuses every held peer message (the senders get a "not delivered" receipt); `ids` as for `peer_accept`. */
  | Cmd<"peer_dismiss", { ids?: string[] }>
  /** This project's peer mode, live and persisted (`settings.peerInbound` is the default). */
  | Cmd<"peer_set", { mode: PeerInboundMode }>
  // §31
  /** Empties the review list (notes too) without touching any file; what was pending stays on disk as it is. */
  | Cmd<"finish_review">
  /** Dismisses `state.gate.stale` ("이어서 리뷰"); the review is kept as it is. */
  | Cmd<"keep_review">
  /** §33.8: the user's Claude Code allow rules and what ReviewGate does with each; replies `permission_rules`. */
  | Cmd<"permission_rules">
  // §36 wave 3
  /** §36.1: a subagent's whole cleaned report (also after a restart: read back from the transcript); replies `agent_report`. */
  | Cmd<"agent_report", { toolUseId: string }>
  /** §36.2: stops that one subagent (`query.stopTask`); the main turn and the other agents go on. */
  | Cmd<"stop_agent", { toolUseId: string }>
  /** §36.7: after an init-timeout fallback, restart the session with the user's extensions again. */
  | Cmd<"retry_extensions">
  /** §36.8: the installed CLI versions; replies `cli_versions`. */
  | Cmd<"cli_versions">
  /** §36.9: the user's other Claude sessions of this repository; replies `cli_sessions`. */
  | Cmd<"cli_sessions">
  /** §36.9: resume a terminal Claude session as a new chat of this window (the review gate applies from then on). */
  | Cmd<"cli_session_import", { sessionId: string }>
  /** §36.11: a commit message drafted by a read-only fork; replies `commit_draft`. `paths` as `commit`. */
  | Cmd<"commit_draft", { paths?: string[] }>
  /** §36.12: where `workbench_create` would put the workbench and what it would copy; replies `workbench_preview`. */
  | Cmd<"workbench_preview", { branch: string; from?: string; location?: WorkbenchLocation }>
  /** §36.13: AI pre-review of the round in a read-only fork; replies `prereview` (status `running`). */
  | Cmd<"prereview_start", { scope: PreReviewScope; paths?: string[]; effort: PreReviewEffort }>
  | Cmd<"prereview_cancel", { prereviewId: string }>
  | Cmd<"prereview_dismiss", { prereviewId: string; findingId: string }>
  // MARK: wave4 w4-history — §38.3
  /** Older rows of a chat's transcript (default the current chat), ending before row `before`; replies `transcript_page`. */
  | Cmd<"transcript_page", { sessionId?: string; before: number; beforeAt?: string; limit?: number }>
  /** The user messages and Claude answers of every chat of the worktree that contain `query`; replies `transcript_search`. */
  | Cmd<"transcript_search", { query: string; limit?: number; /** MARK: wave4c w4c-review — §41.3: matches per chat (1–10, default 1); the rest are counted. */ perChat?: number }>
  // MARK: wave4b w4b-bigturn — §39.1
  /** Saves the review, its history and the chat's checkpoints again after a failure; refused `save_failed` while one still fails. */
  | Cmd<"retry_save">
  /** Old review rounds and checkpoints of this worktree: `apply` false (default) only counts; replies `history_cleanup`. */
  | Cmd<"history_cleanup", { keep?: number; apply?: boolean }>
  // MARK: wave4b w4b-follow — §39.4
  /** Hands this chat to another worktree of this repository (`interrupt`: stop the running turn first); emits `chat_moved`. */
  | Cmd<"chat_move", { path: string; interrupt?: boolean; followUp?: string }>
  /** Takes the chats handed to this worktree by `chat_move` and opens the newest one. */
  | Cmd<"chat_receive">
  // MARK: wave4c w4c-trust — §41.2
  /** This repository's auto-accept rules (every worktree of it; a rule left out is off); applies from the next collection. */
  | Cmd<"set_auto_accept", { rules: AutoAcceptRules }>
  /** Files a rule accepted go back to pending (`paths` absent: every such file); nothing on disk changes. */
  | Cmd<"auto_accept_undo", { paths?: string[] }>
  /** Puts back the last single-file reject (`state.gate.rejectUndo`): the proposal returns to disk and to the review, pending. */
  | Cmd<"reject_undo", { path: string }>
  // MARK: wave4c w4c-commit — §41.1
  /** The commit format learned from the recent subjects and the branch's issue number; replies `commit_format`. */
  | Cmd<"commit_format">
  /** A PR title / body from the branch's commits since `base`, whether the branch has an upstream, whether `gh` is ready; replies `pr_draft`. */
  | Cmd<"pr_draft", { base: string }>
  /** §51: the PR sheet's title / description written by a read-only fork from the branch's commits and diff since `base`, the repository's PR template and the sheet's `title` / `body`; replies `pr_ai_draft`. */
  | Cmd<"pr_ai_draft", { base: string; title?: string; body?: string }>
  // §53 commits in meaningful units
  /** §53: the accepted files as hunks of `git diff HEAD` (what a commit takes from the worktree); replies `commit_hunks`. `paths` as `commit`. */
  | Cmd<"commit_hunks", { paths?: string[] }>
  /** §53: the commits in order (hooks run, the worktree untouched), then one push when `push` (default `settings.commitPushByDefault`); replies `committed_series`. */
  | Cmd<"commit_series", { commits: CommitPlan[]; push?: boolean }>
  /** §53: Claude's proposal of the split in a read-only fork (side lane); replies `commit_split_draft`. `paths` as `commit`. */
  | Cmd<"commit_split_draft", { paths?: string[] }>
  // MARK: wave4d w4d-config — §42.3
  /** A CLAUDE.md / CLAUDE.local.md of this project (`path` project-relative, or absolute inside it); replies `claude_md`. */
  | Cmd<"claude_md_read", { path: string }>
  /** Saves it: `baseSha` = the read's `sha` (null = create a missing file); refused while Claude works or the file is in the review; replies `claude_md`. */
  | Cmd<"claude_md_write", { path: string; text: string; baseSha: string | null }>
  // MARK: wave5 w5-brain — §43.2
  /** The sub-brain (auto memory) of this repository; `watch` true / false starts / stops the 4 s re-read that sends each change as `brain`; replies `brain`. */
  | Cmd<"brain", { watch?: boolean }>
  /** One memory's text (`name` as listed, read only); replies `brain_memory`. */
  | Cmd<"brain_read", { name: string }>
  // MARK: wave5 w5-graph — §43.3
  /** The code graph's summary (`<root>/graphify-out/GRAPH_REPORT.md`, else the main worktree's) and its freshness; replies `code_graph`. */
  | Cmd<"code_graph">
  /** Runs `graphify update .` in the project root (one at a time, ≤ 10 minutes); replies `code_graph` with `build.running`, then emits `code_graph` while it runs and when it ends. */
  | Cmd<"code_graph_build">
  // MARK: wave6 w6-statusline — §44.2
  /**
   * The user's Claude Code status line: `columns` = how wide the client draws it (20–1000, default 120; the command's
   * `COLUMNS`), `visible` = it is on screen (default true; the command runs only then). Replies `status_line`, then emits
   * `status_line` (no id) whenever what it shows changes.
   */
  | Cmd<"status_line", { columns?: number; visible?: boolean }>
  // MARK: code-browser — §47
  /** Any file of the project, read-only (repo-relative, as `list_files` / `project_search` name it); replies `project_file`. */
  | Cmd<"project_file", { path: string }>
  /** `git grep` over the project's files (a fixed string, case ignored unless `caseSensitive`); replies `project_search`. */
  | Cmd<"project_search", { query: string; caseSensitive?: boolean; wholeWord?: boolean; limit?: number }>
  | Cmd<"shutdown">;

// ---------------------------------------------------------------- §21 side questions

/**
 * What a side question is about; every field optional. `entryId`: a review-history entry (§14) instead of the current review.
 * §36.14 `pr`: a line / hunk of the PR open in the PR tab (the other fields are then ignored).
 */
export type SideAnchor = { path?: string; hunkId?: number; line?: number; side?: DiffSide; toolUseId?: string; entryId?: string; pr?: SidePrAnchor; quote?: SideQuoteAnchor };
/** A tool call the side session made (read-only tools only; `denied` when the read-only policy refused it). */
export type SideToolCall = { id: string; name: string; input: Record<string, unknown>; isError?: boolean; preview?: string; denied?: true };
export type SideMessage = {
  role: "user" | "assistant";
  text: string;
  /** ISO-8601 */
  at: string;
  toolCalls?: SideToolCall[];
  /** assistant only */
  costUSD?: number;
  durationMs?: number;
  stopReason?: string;
};
export type SideThread = {
  id: string;
  /** The main chat (SessionMeta.id) the thread belongs to. */
  mainSessionId: string | null;
  anchor: SideAnchor | null;
  createdAt: string;
  updatedAt: string;
  /** First line of the first question, ≤ 60 chars. */
  title: string;
  messages: SideMessage[];
  status: "idle" | "running" | "error";
  error: string | null;
  /** The side Claude session (a fork of the main one); null until the CLI started it. */
  sessionId: string | null;
  /** How the first question was started: forked at the main session's last completed turn, a full fork, or fresh (no main conversation yet). §36.10: `atTurn`, `runningTurn`. */
  fork: SideFork | null;
  /** Accumulated cost of the thread (every question + promote drafts). */
  costUSD: number;
  /** `side_promote` calls (newest last, ≤ 20). */
  promotions?: { as: "message" | "note"; at: string; /** §40.3: put in the client's queue (the main turn was running), not sent yet. */ queued?: true }[];
};

// ---------------------------------------------------------------- §22 MCP servers

/** §36.6 `local`: `claude mcp add/remove --scope local` (this project, only this user: `~/.claude.json`). */
export type McpScope = "session" | "project" | "user" | "local";
export type McpAddConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };
export type McpServerInfo = {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  /** The SDK's raw scope string (project, user, local, claudeai, managed, dynamic, …), null when unknown. */
  scope: string | null;
  source: "user" | "project" | "local" | "plugin" | "claude.ai" | "managed" | "session" | "unknown";
  transport: "stdio" | "http" | "sse" | "sdk" | "claudeai-proxy" | "unknown";
  /** null when the server did not report tools (not connected). */
  toolCount: number | null;
  tools: string[];
  error: string | null;
  serverInfo: { name: string; version: string } | null;
  /** Redacted: env / header VALUES are never sent, only their keys; secret-looking args and URL query values read "***". */
  config: { command?: string; args?: string[]; url?: string; envKeys?: string[]; headerKeys?: string[] } | null;
  /** Turned off with `mcp_toggle {enabled:false}`; persisted per project and re-applied at every session start. */
  disabledByUser: boolean;
  /** Added with `mcp_add {scope:"session"}`. */
  sessionAdded: boolean;
  // MARK: wave4d w4d-config — §42.3
  /** The file that defines it and whether ReviewGate can remove it there; absent from older engines. */
  origin?: McpServerOrigin;
  /** Which choice turned it off (`disabledByUser`): this worktree's or the repository's (every worktree). */
  disabledIn?: McpToggleScope;
  /** `mcp_auth` opened a terminal for it: the engine reconnects it on its polls until it connects (at most 10 minutes). */
  authWaiting?: true;
};

/** What `refresh` re-reads (docs/M15-POLISH.md); omitted = every applicable scope. */
export type RefreshScope = "review" | "branches" | "workbenches" | "pr" | "accounts";

export type EngineCommandType = EngineCommand["type"];

// ---------------------------------------------------------------- Engine → App

export type GatePhase = "idle" | "starting" | "running" | "collecting" | "collect_failed" | "reverting" | "reviewing";

export type BlockedReason =
  | "git_init_needed"
  | "no_session"
  | "starting"
  | "running"
  | "awaiting_permission"
  | "collecting"
  | "reverting"
  | "collect_failed"
  | "pending_review"
  | "changes_requested";

export type HudActivity = {
  kind: "idle" | "working" | "thinking" | "tool" | "subagent";
  toolName?: string;
  detail?: string;
};

export type ProjectState = { path: string; root: string; name: string; branch: string | null; remoteURL: string | null };

export type GitInitState = { path: string; candidates: string[]; looksUnsafe: boolean };

export type SessionState = {
  open: boolean;
  starting: boolean;
  sessionId: string | null;
  model: string | null;
  capabilities: SessionCapabilities | null;
  /** `capabilities` come from `<gitdir>/reviewgate/capabilities.json` (last session) until the CLI reports fresh ones. */
  capabilitiesCached: boolean;
  /** The request that has waited longest (= `pendingPermissions[0]`); kept for clients that show one card at a time. */
  pendingPermission: PermissionRequest | null;
  /**
   * §33: every open permission request, oldest first (parallel subagents can ask at the same time). Always sent by
   * this engine; optional in the type so clients' hand-built placeholder states stay valid.
   */
  pendingPermissions?: PermissionRequest[];
  /** `restart_session` is available: a project is open and no session start is in flight. */
  canRestart: boolean;
  /** `permission_response { remember: true }` keys (`Bash:<first two words>` / `<tool>:<tool>`); cleared by `forget_allows`. */
  rememberedAllows: string[];
  /** Mode of the running session (docs/M20-MODES.md); persisted per project and restored on `open_project`. */
  permissionMode: PermissionMode;
  /** Plan proposed by the last plan-mode turn, awaiting `plan_response`; a plain `send` clears it. */
  pendingPlan: PendingPlan | null;
  /**
   * MARK: wave6 w6-terminal — §44.1: while `permissionMode` is `plan`, the mode before it — entered with
   * `set_permission_mode` or by Claude itself (EnterPlanMode); `plan_response {approve}` without `mode` goes back to `auto`
   * when it is `auto` (else `default`). null otherwise (also for a plan mode restored from the project's stored mode).
   * Always sent by this engine; absent from an older one.
   */
  prePlanMode?: PermissionMode | null;
  /**
   * What the session applied from the user's extensions (§16); null without a session start. Always
   * sent by this engine; optional in the type so clients' hand-built placeholder states stay valid.
   */
  extensions?: SessionExtensions | null;
  /** §25: the effort the session runs with (`set_model` / `settings.effort`); null = the model's default. */
  effort?: EffortLevel | null;
  /** §25: the model `set_model` / `settings.model` asked for (alias or id); `model` is what the CLI reports. null = the CLI default. */
  selectedModel?: string | null;
  /** §25: what `set_model.model` offers (the CLI's `supportedModels()`, else a static list). */
  availableModels?: ModelOption[];
  /** §26: the current chat's user turns, oldest first (≤ 50). */
  checkpoints?: TurnCheckpointView[];
  /** §30: the CLI answered initialize — it accepted the start (a resume found its conversation); false while starting and after a death. */
  ready?: boolean;
  /** §29: the effective peer mode of this project (`peer_set`, else `settings.peerInbound`, else `ask`). */
  peerInbound?: PeerInboundMode;
  /** §29: peer messages waiting for the user (`held`) or running (`delivering`), oldest first. */
  peerInbox?: PeerMessage[];
  /** §29: a turn the CLI runs that is not ours; `canSend` is false meanwhile (`blockedReason: "running"`). */
  externalTurn?: ExternalTurn | null;
  /** §52: the background tasks running now (Bash `run_in_background`, Monitor, …), oldest first. */
  backgroundTasks?: BackgroundTask[];
  /** §29: the running review turn is accepted peer messages (badge the permission card / HUD with the senders). */
  peerTurn?: { messageIds: string[]; fromNames: string[] } | null;
  /** §36.8: the CLI this session runs and whether ReviewGate verified it; null without a session start. */
  cli?: CliInfo | null;
  /** §36.7: what the starting CLI is waiting for (the latest progress signal); null once it initialized / outside a start. */
  extensionsWaitingOn?: ExtensionsWaitingOn | null;
  // MARK: wave4d w4d-plan
  /** §42.1: what the next turn summary's "plan vs actual" follows; absent without a chat (and from an older engine). */
  planSource?: PlanSourceState;
  // MARK: wave5 w5-model
  /** §43.4: the model the running / last turn was given (auto, this message's pick, or back to the chip's); absent before one. */
  autoModel?: AutoModelChoice | null;
};

export type ToolchainState = {
  claude: string | null;
  gh: string | null;
  git: string | null;
  claudeVersion: string | null;
  ghVersion: string | null;
};

export type GateState = {
  phase: GatePhase;
  canSend: boolean;
  canRequestChanges: boolean;
  blockedReason: BlockedReason | null;
  collectError: string | null;
  pendingCount: number;
  changesRequestedCount: number;
  isRequestingChanges: boolean;
  turnStartTree: string | null;
  turnEndTree: string | null;
  /** The "[Review gate] Accepted: …" prefix that the next send will use. */
  lastReviewSummary: string | null;
  /** Absolute paths of edits outside the checkpoint root — or inside a nested repository under it (§33.3) — the user approved this turn (not in the review). */
  changedOutside: string[];
  /** Repo-relative paths the turn's edit tools touched that are gitignored (written but invisible to the review). */
  ignoredTouched: string[];
  /** Repo-relative changed paths hidden from `changedFiles` by `settings.ignorePatterns`. */
  filteredByPattern: string[];
  /** True after `open_project` restored a persisted review (`<gitdir>/reviewgate-review.json`); cleared on the next turn. */
  restored: boolean;
  /** Totals over `changedFiles` (all states) for the composer's "Accept N & Send" label. */
  reviewSummary: ReviewSummary;
  /** §31: pending files with `origin: "external"` — what `reject_all` leaves out unless `includeExternal`. Always sent by this engine. */
  externalPendingCount?: number;
  /** §31: HEAD / the branch moved while the last turn ran (a commit, pull or checkout outside the app); cleared when the next turn starts. */
  headMoved?: HeadMove | null;
  /** §31: other Claude Code processes working in this worktree, as found when the project opened / the last message was sent. */
  concurrentClaude?: ConcurrentClaude[];
  /** §31: the review `open_project` restored is stale (HEAD moved / older than 12 h): clients ask "정리 / 이어서 리뷰". */
  stale?: StaleReview | null;
  /** §32: `.claude/settings.local.json` changed during the last turn (hash comparison only: it is never captured). Cleared at the next turn. */
  localSettingsChanged?: LocalSettingsChange | null;
  /** §32: nested repositories the last turn changed — outside this review ("리뷰 밖 변경"). Cleared at the next turn. */
  nestedChanges?: NestedChange[];
  /** §32 (robustness-09): files the turn's snapshots had to leave out (git could not read them). Cleared at the next turn. */
  snapshotSkipped?: SkippedPath[];
  /**
   * §34.2: the B the review list and its diffs refer to — `turnEndTree`, or while a turn runs / is collected on a standing
   * review the B it started from (read-only until the collection). null without a review. Key diff caches on this.
   */
  reviewEndTree?: string | null;
  /** §34.3: transcript turns the review in progress spans (first turn + question / request-changes follow-ups). */
  reviewTurns?: number[];
  /** §34.3: what the last collected turn itself changed; null before the first collection of a review. */
  lastTurnChanges?: LastTurnChanges | null;
  /** §34.4: the last `request_changes` of this review (`since: "request"`); null when there was none. */
  lastRequest?: ReviewRequestInfo | null;
  /** §36.13: the AI pre-reviews of the review in progress (round runs and the main chat's ReportFindings), newest first. */
  prereviews?: PreReviewRun[];
  // MARK: wave4c w4c-trust
  /** §41.2: the last single-file reject while [되돌리기] can put it back; absent otherwise. */
  rejectUndo?: RejectUndoState;
};

/** §32: which parts of `.claude/settings.local.json` the turn changed (a file created / deleted counts for every part it has). */
export type LocalSettingsChange = { path: string; hooks: boolean; permissions: boolean; env: boolean; mcp: boolean };

/** §32: a repository inside the project — a linked worktree of it, a submodule, or another clone. */
export type NestedKind = "worktree" | "submodule" | "repo";

/** §32: a nested repository the last turn touched; its changes are outside this review. */
export type NestedChange = {
  /** Repo-relative (POSIX) path of the nested repository. */
  path: string;
  kind: NestedKind;
  /** Its branch now (null: detached / unknown). */
  branch: string | null;
  /** Its HEAD moved during the turn (a commit / checkout inside it). */
  head: { from: string; to: string } | null;
  /** `git status` entries in it now; null when git did not answer within 3 s. */
  dirtyFiles: number | null;
  /** Repo-relative paths (from the project root) the turn's edit tools changed in it, ≤ 20. */
  touchedFiles: string[];
  /** How the turn reached it: an edit tool's file, a Bash / MCP call that ran there or named it. */
  via: ("edit" | "bash" | "mcp")[];
};

/**
 * §31: why a restored review is stale. `savedHead` / `head`: HEAD when the review was last saved / now (null when
 * unknown); `externalFiles`: restored files nothing of Claude's explains (changes made while the app was closed).
 */
export type StaleReview = { reasons: ("head_moved" | "old")[]; savedAt: string; savedHead: HeadInfo | null; head: HeadInfo | null; externalFiles: number };

/** §31: another Claude Code process whose cwd is in this worktree (its `<config>/sessions/<pid>.json` registry entry). */
export type ConcurrentClaude = {
  pid: number;
  sessionId: string | null;
  cwd: string;
  /** The CLI's session name (`acme-b4`), as `claude --resume` / peer messages show it. */
  name: string | null;
  kind: string | null;
  /** `cli` (a terminal), `sdk-cli` / `sdk-ts` (an app or script driving the SDK), … */
  entrypoint: string | null;
  /** `busy` / `idle` / … as the CLI last wrote it. */
  status: string | null;
  /** ISO-8601 */
  startedAt: string | null;
};

/** §31: a commit (`sha` null = unborn HEAD) and branch (null = detached). */
export type HeadInfo = { sha: string | null; branch: string | null };
export type HeadMove = {
  from: HeadInfo;
  to: HeadInfo;
  /**
   * MARK: r1-git — §31.3 / §46 (`head_moved` only): Claude's own git commands made every step of the move (a commit, a branch,
   * a pull, …): no `state.gate.headMoved`, a chat row instead. Absent: someone else's move (or an older engine).
   */
  explainedBy?: "claude_git";
  /** With `explainedBy`: the short shas of the commits Claude's `git commit` made in the turn, oldest first (none: no commit). */
  commits?: string[];
};

/**
 * `origin` (§31) is always sent by this engine; optional for clients' placeholder states. `group` (§32): set for mods files.
 * `noteCount`: the file's unsent notes (§34.4). The §34 fields: `ChangedFileReview`.
 */
export type ChangedFileState = ChangedFile & ChangedFileReview & { noteCount: number; origin?: FileOrigin; group?: "mods" };

/** `AgentNode.status`: the SDK's task states, `killed` folded into `stopped`. */
export type AgentStatus = "pending" | "running" | "paused" | "completed" | "failed" | "stopped";

/** One subagent of the session (`state.hud.agents`, docs/PROTOCOL.md §13); the main agent is implicit. */
export type AgentNode = {
  /** The SDK task id once `task_started` arrived, else the spawning tool_use id (older CLIs). Key on `toolUseId`. */
  id: string;
  /** The Agent/Task tool_use that spawned it; inner calls carry it as `parentToolUseId`. */
  toolUseId: string;
  /** The tool_use of the agent that spawned this one (nested subagent); absent for top-level spawns. */
  parentToolUseId?: string;
  /** `subagent_type` ("general-purpose" when the call named none). */
  type: string;
  description: string;
  status: AgentStatus;
  isBackground: boolean;
  /** 1 for a top-level spawn, N+1 inside a depth-N agent. */
  depth: number;
  lastTool?: string;
  /** Progress summary (`agentProgressSummaries`) or the final notification summary. */
  summary?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  /** epoch ms */
  startedAt: number;
  /** epoch ms; set once the status is completed / failed / stopped. */
  endedAt?: number;
  error?: string;
  /** Files its edit tools (and Bash calls, via the post-Bash snapshot) changed, nested agents included; repo-relative inside the repo. */
  files: string[];
  /** §36.1: the instructions (the Agent call's `prompt` / `task_started.prompt`), first 8 000 chars. */
  prompt?: string;
  /** §36.1: the Agent call's `model` (else a model the task messages report); null when none was named. */
  model?: string | null;
  /** §36.1: the cleaned report's first 600 chars, once the Agent call's result arrived. */
  reportPreview?: string;
  /** §36.1: the CLI's own agent id (the result's `agentId: …` line) — what SendMessage `to` names. */
  cliAgentId?: string;
  /** §36.2: set with `status: "stopped"` when `stop_agent` stopped it. */
  stoppedBy?: AgentStoppedBy;
  /** §36.3: how many times SendMessage continued it after it had finished. */
  resumeCount?: number;
  /** §36.3: the SendMessage tool_use of the latest continuation. */
  resumedBy?: string;
  // MARK: wave4b w4b-agents
  /** §39.3: its latest tool call — what it is doing now (absent before its first call). */
  lastStep?: AgentStep;
  /** §39.3: the CLI is retrying its API request (`tool_progress.subagent_retry`); cleared by its next call. */
  retry?: AgentRetry;
  /** §39.3: epoch ms anything was last heard from it (a call, a result, progress, a retry). */
  activeAt?: number;
  /** §39.3: the user turn it started in (the `user_message.turn` of that turn). */
  turn?: number;
  /** §39.3: the Agent call's `isolation` ("worktree", "remote", …) — its changes are outside this window's review. */
  isolation?: string;
  /** §39.3: the worktree an isolated agent worked in, and its branch (the CLI's `worktreePath` / `worktreeBranch`). */
  worktreePath?: string;
  worktreeBranch?: string;
  // MARK: wave4d w4d-agents2
  /** §42.4: the model its API answers came from (its assistant messages' `message.model`), absent until it answered once. */
  apiModel?: string;
};

// MARK: wave4b w4b-agents
/**
 * §39.3: a subagent's latest tool call. `detail` is the HUD's (`activityDetail`: file name, command start, skill, query)
 * or, for an MCP tool, its representative argument (`toolLabel`); `since` / `endedAt`: epoch ms (no `endedAt` while it runs).
 */
export type AgentStep = { tool: string; detail?: string; since: number; endedAt?: number };

/** §39.3: `tool_progress.subagent_retry` — attempt N of `max`; `status`: the HTTP status (null for a connection error). */
export type AgentRetry = { attempt: number; max: number; at: number; status?: number | null };

export type HudState = {
  contextTokens: number;
  contextWindow: number | null;
  sessionCostUSD: number;
  turnCount: number;
  lastTurnMs: number;
  activity: HudActivity;
  /** Foreground subagents still running (derived from `agents`). */
  subagentDepth: number;
  /** Subagents of the session: this turn's plus background ones still running from earlier turns. */
  agents: AgentNode[];
  /** epoch ms */
  turnStartedAt: number | null;
  /** Cost of side-question sessions (§21) since this session started; never part of `sessionCostUSD`. Optional for older clients' placeholder states. */
  sideCostUSD?: number;
  /** §34.6: distinct files the running turn's edit tools / Bash calls changed so far (0 between turns); `live_changes` lists them. */
  turnFiles?: number;
  /** §36.4: the main turn is blocked on foreground subagents; null otherwise. */
  waitingOnAgents?: WaitingOnAgents | null;
  // MARK: wave4 w4-longwork
  /** §38.2: the subscription's usage windows the CLI reported (`rate_limit_event`), one per kind; absent before the first. */
  rateLimits?: RateLimitWindow[];
  // MARK: wave4b w4b-agents
  /**
   * §39.3: finished subagents of this chat's earlier turns, newest first (at most 50; `turn` set; no `prompt` —
   * `agent_report` has it). Absent from older engines.
   */
  agentHistory?: AgentNode[];
  // MARK: wave4d w4d-agents2
  /** §42.4: the last finished turn's `usage.models` (absent when it had none). */
  turnModels?: ModelCost[];
  /** §42.4: `usage.models` summed per model over this chat's turns since the engine opened it (as `sessionCostUSD`). */
  sessionModels?: ModelCost[];
  // MARK: wave5 w5-model
  /** §43.4: messages auto sent to each family in this chat since the engine opened it, most first (reset with the HUD). */
  autoModelCounts?: AutoModelCount[];
};

// MARK: wave4 w4-longwork
/**
 * §38.2: one usage window of a claude.ai subscription (`rate_limit_event.rate_limit_info`). `kind`: the CLI's
 * `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, …, kept as sent); `percent`: utilization 0–100 when the
 * CLI reports it; `resetsAt`: ISO-8601; `at`: when the engine got it.
 */
export type RateLimitWindow = {
  kind: string;
  status: "allowed" | "allowed_warning" | "rejected";
  percent?: number;
  /** MARK: wave6 w6-statusline — §44.2: the CLI's utilization as sent (a 0–1 fraction; above 1 a percentage), for the status line's one-decimal `used_percentage`. */
  utilization?: number;
  resetsAt?: string;
  at: string;
};

export type BranchesState = {
  list: BranchInfo[];
  isWorktreeDirty: boolean;
  switchBlocker: BranchSwitchBlocker | null;
  /** §36.12: remote-tracking branches (`origin/develop`) as bases for `workbench_create`; never in `list` (no switching to them). */
  remotes?: RemoteBranchInfo[];
};

export type SubmitResultState = { reviewURL: string; inlineCount: number; event: ReviewEvent; submittedAt: string };

/** Another engine holds the worktree's `reviewgate.lock` (docs/M10-WORKBENCHES.md); `open_project{takeover:true}` overrides. */
export type LockConflictState = { path: string; pid: number; since: string; client: string };

/** One git worktree of the open project's repository. */
export type WorkbenchInfo = {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  isCurrent: boolean;
  /** The ReviewGate session lock of that worktree (live pid only), not git's `worktree lock`. */
  locked: { pid: number; since: string; client: string } | null;
  /** null = not computed yet / git did not answer within 2 s. */
  dirty: boolean | null;
};

export type WorkbenchesState = {
  list: WorkbenchInfo[];
  /** Path of this engine's worktree ("" without a project). */
  current: string;
  /** Where `workbench_create` puts worktrees by default ("" without a project). */
  managedRoot: string;
};

export type PRState = {
  host: string;
  mine: PRSummary[];
  reviewRequested: PRSummary[];
  selectedSummary: PRSummary | null;
  selected: PRDetail | null;
  /** PRFile WITHOUT `patch` (engine keeps patches; see pr_select_file). */
  files: PRFileMeta[];
  comments: PRComment[];
  reviews: PRReview[];
  draftComments: DraftComment[];
  accounts: GHAccount[];
  isLoading: boolean;
  isSubmitting: boolean;
  errorText: string | null;
  lastSubmitResult: SubmitResultState | null;
  /** Last successful `pr_create` of this engine. */
  lastCreatedPR: { url: string; branch: string } | null;
};

/** The last successful `commit` of this engine (docs/M12-COMMIT.md). */
export type LastCommitState = {
  sha: string;
  shortSha: string;
  message: string;
  branch: string | null;
  pushed: boolean;
  /** Refusal code of the failed push (`no_remote`, `push_failed:<line>`); null when pushed or not attempted. */
  pushError: string | null;
  files: string[];
  /** ISO-8601 */
  at: string;
};

export type CommitIdentity = { name: string | null; email: string | null };

export type CommitState = {
  lastCommit: LastCommitState | null;
  /** Accepted files exist and the gate is not running / collecting / reverting. */
  canCommit: boolean;
  /** Paths with state "accepted" in the current review (the default `commit.paths`). */
  acceptedPaths: string[];
  /** `suggestCommitMessage()`: first line of the last user instruction + the accepted file list. */
  suggestedMessage: string;
  /** `user.name` / `user.email`, read at open_project and again on every commit. */
  identity: CommitIdentity;
};

/** One chat session of the open project (`<gitdir>/reviewgate/sessions/index.json`; docs/M15-POLISH.md). */
export type SessionMeta = {
  /** The Claude session id (`resume`). */
  id: string;
  /** "New chat" until the first user message, then its first line (≤ 60 chars) unless renamed. */
  title: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601; bumped at every turn end / user message. */
  updatedAt: string;
  turns: number;
  costUSD: number;
  lastUserText: string | null;
  archived?: boolean;
  /** The CLI could not resume this session; a fresh one was started instead (the transcript stays readable). */
  resumeFailed?: boolean;
  /** §26: created by `rewind` from that chat, right before its turn `turn`. */
  forkedFrom?: { sessionId: string; turn: number };
  /**
   * §30: the CLI has a record of this conversation (it reported the id: a turn ran — also one it ran on its own, e.g. a
   * peer message). Such a chat is always resumed, never started again with `--session-id`.
   */
  cliKnown?: boolean;
  /** §36.9: made by `cli_session_import` from a terminal session (the review gate applies from `at` on). */
  imported?: ImportedSession;
  // MARK: wave4b w4b-follow — §39.4
  /** Handed to another worktree (`chat_move`): this window keeps it as a record; the conversation goes on there. */
  movedTo?: ChatMoveRef;
  /** Came from another worktree (`chat_move`): the review here starts at the move. */
  movedFrom?: ChatMoveRef;
  // MARK: wave4d w4d-plan
  /** §42.1: the plan file this chat's "plan vs actual" follows (`plan_follow`; absolute). */
  planFile?: string;
};

export type SessionsState = {
  /** Newest first (`updatedAt`). */
  list: SessionMeta[];
  /** The session the engine is running (or starting); null without a project. */
  currentId: string | null;
  /** Tabs the client keeps open (`tabs_set`); persisted per worktree. */
  openTabIds: string[];
};

export type ReviewState = {
  /** Monotonic; clients drop out-of-order snapshots. */
  seq: number;
  project: ProjectState | null;
  gitInit: GitInitState | null;
  session: SessionState;
  toolchain: ToolchainState;
  gate: GateState;
  changedFiles: ChangedFileState[];
  reviewNotes: ReviewNote[];
  budget: Budget;
  budgetUsage: BudgetUsage;
  hud: HudState;
  branches: BranchesState;
  pr: PRState;
  lastError: string | null;
  workbenches: WorkbenchesState;
  lockConflict: LockConflictState | null;
  commit: CommitState;
  sessions: SessionsState;
  // MARK: wave4b w4b-bigturn
  /** §39.1: saves that failed and the free space of the repository's volume; absent from an older engine. */
  storage?: StorageState;
  // MARK: wave4c w4c-trust
  /** §41.2: this repository's auto-accept rules — present only while a project is open and at least one rule is on. */
  autoAcceptRules?: AutoAcceptRules;
};

/** Final verdict of a file in a review round; `pending` only when the round ended unresolved. */
export type HistoryVerdict = "accepted" | "rejected" | "changes_requested";

export type ReviewHistoryFile = {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  verdict: HistoryVerdict | "pending";
  adds: number;
  dels: number;
  toolUseIds: string[];
  /** Times the file was sent back with notes during the round. */
  changesRequested?: number;
  /** Hunks rejected with `reject_hunks` (the rest was kept). */
  rejectedHunks?: number;
  /**
   * The turn-end tree that still held the file's proposal (`history_diff` uses it instead of the entry's): a rejected
   * file's B before the revert, a partially reverted file's B before its first `reject_hunks`.
   */
  endTree?: string;
  /** Left the review through `commit`. */
  committed?: true;
  // MARK: wave4 w4-history
  /** §38.3: the commit it left the review with (its subject line, ≤ 200 chars). */
  commit?: HistoryCommit;
  // MARK: wave4c w4c-trust
  /** §41.2: `accepted` by this rule, not by the user. */
  autoAccepted?: AutoAcceptRule;
};

export type ReviewHistoryNote = { path: string; line: number | null; side: DiffSide; body: string };

/** One completed review round (docs/PROTOCOL.md §14). */
export type ReviewHistoryEntry = {
  id: string;
  sessionId: string | null;
  /** Transcript turn numbers the round spans (first turn + answer / request-changes follow-ups). */
  turns: number[];
  /** ISO-8601 */
  startedAt: string;
  /** ISO-8601 */
  endedAt: string;
  /** The user's prompt of the round's first turn, ≤ 200 chars. */
  prompt: string;
  files: ReviewHistoryFile[];
  notes: ReviewHistoryNote[];
  /** Pinned by `refs/reviewgate/<ns>/history/<id>/start|end` until the entry is pruned. */
  turnStartTree: string;
  turnEndTree: string;
  /** §31: the round was closed by `finish_review` (its `pending` files were left on disk unreviewed). */
  finished?: true;
  /** §34.4: the round still in progress (`review_history.current`); `endedAt` = its last update. */
  inProgress?: true;
};

export type ErrorScope = "engine" | "session" | "git" | "pr";

export type ReadyEvent = { type: "ready"; id?: string; engineVersion: string; platform: "darwin" | "win32" | "linux"; protocolVersion: 2 };
export type StateEvent = { type: "state"; state: ReviewState };
/**
 * `code`: the stable refusal / failure id (docs/PROTOCOL.md "Error and refusal codes"), always set on `ok:false` from this
 * engine; `paths`: the files a refusal is about (`file_changed_since_review` from `reject` / `reject_all`).
 */
export type ResultEvent = { type: "result"; id: string; ok: true } | { type: "result"; id: string; ok: false; error: string; code?: string; paths?: string[]; partial?: PartialSeries };
/**
 * `endTree` (scope `turn`): the B the diff was computed for (`gate.reviewEndTree`) — what `reject_hunks.expectedEndTree` must
 * echo (§17); scope `live`: the live snapshot. §34: `since` echoes the range (absent = `review`), `baseTree` is the old side
 * (A for `review` — what `reject_hunks.expectedBaseTree` echoes; hunk ids of any other range are not valid for
 * `reject_hunks`), `stale` = served while a turn runs on the held B (read-only, §34.2).
 */
export type FileDiffEvent = {
  type: "file_diff";
  id?: string;
  scope: "turn" | "pr" | "live";
  path: string;
  diff: FileDiff;
  truncated: boolean;
  endTree?: string;
  since?: DiffSince;
  baseTree?: string;
  stale?: true;
  /** MARK: wave4c w4c-review — §41.3: `select_file {ignoreWhitespace}` — a `-w` diff (read-only: no `reject_hunks`, no hunk side question). */
  ignoreWhitespace?: true;
};
export type FullFileContentEvent = {
  type: "full_file_content";
  id?: string;
  path: string;
  lines: string[];
  changedNewLines: number[];
  deletedAfterNewLine: Record<string, string[]>;
  isBinary: boolean;
  isTooLarge: boolean;
  /** old/new for a side-by-side editor; null when binary/too large. */
  oldText: string | null;
  newText: string | null;
  /** §34.1: the range `changedNewLines` / `deletedAfterNewLine` / `oldText` describe (absent = `review`). */
  since?: DiffSince;
  /** §34.2: served while a turn runs — the content is the held B's, not the worktree's. */
  stale?: true;
  /** §34.2: the B the content and the changed lines belong to. */
  endTree?: string;
};
export type PRCreatedEvent = { type: "pr_created"; id?: string; url: string; branch: string };
export type CommittedEvent = {
  type: "committed";
  id?: string;
  sha: string;
  shortSha: string;
  pushed: boolean;
  branch: string | null;
  /**
   * MARK: r1-git — §46: paths that had no change against HEAD any more (Claude's own commit holds them): not staged again,
   * they left the review as committed. When every path was one, no commit was made and `sha` is HEAD's.
   */
  alreadyCommitted?: string[];
};
export type UserMessageEvent = { type: "user_message"; text: string; turn: number; mentions?: string[]; attachments?: AttachmentRef[]; /** MARK: wave5 w5-model — §43.4 */ autoModel?: AutoModelChoice; /** §50: put into the running turn (`steer`) */ steered?: true };
/** `unprompted`: Claude Code wrote it in a turn it ran on its own, outside any request (§18). */
export type TextDeltaEvent = { type: "text_delta"; text: string; unprompted?: true };
export type ToolUseEvent = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  file?: string;
  /** The Agent/Task tool_use this call runs under (a subagent's inner call); absent at top level. */
  parentToolUseId?: string;
  /** Assistant text right before this call in the same API message (trimmed; the last ≤ 400 chars). */
  rationale?: string;
  /** §34.8: where `rationale` came from — this API message, or the same agent's latest earlier text of the turn. */
  rationaleSource?: RationaleSource;
  /** §34.8: the agent's tool calls between that text and this call (0 = the first call after it). */
  rationaleAge?: number;
  /** §36.3: a SendMessage call that continues a subagent the engine knows. */
  continues?: AgentContinuation;
  // MARK: wave4b w4b-tabs
  /** §39.2: the call only reads or searches (Read, Glob, Grep, LS, read-only Bash, an MCP lookup); clients fold a run of them. */
  explore?: true;
};
export type ToolResultEvent = {
  type: "tool_result";
  toolUseId: string;
  isError: boolean;
  /** First 500 chars of the result. */
  preview: string;
  parentToolUseId?: string;
  /** The result is longer than `preview`; for Bash the engine keeps up to ~20k chars for `tool_output`. */
  truncated?: boolean;
  /** Bash running a recognizable test command (vitest/jest/npm test/pytest/swift test/go test/cargo test/xcodebuild test). */
  testOutcome?: TestOutcome;
  /** §36.1 (Agent / Task results): the parsed `<usage>` block. `preview` / `truncated` are about the cleaned report. */
  agentUsage?: AgentUsage;
  /** §36.1: the parsed `agentId: …` line. */
  cliAgentId?: string;
  /** §36.2: the agent was stopped with `stop_agent`. */
  stoppedBy?: AgentStoppedBy;
};
/** Reply to `tool_output`: `output` is null when the engine kept nothing for that id (not Bash, older run, evicted). */
export type ToolOutputEvent = { type: "tool_output"; id?: string; toolUseId: string; output: string | null; truncated: boolean };
/** One changed file of `turn_summary` (docs/PROTOCOL.md §15). */
export type TurnSummaryFile = {
  path: string;
  status: ChangeStatus;
  /** The file's review state right after the collection. */
  state: ChangedFile["state"];
  adds: number;
  dels: number;
  /** `rationale` (§12) of the first touching tool call that has one; null when none did. */
  why: string | null;
  whyToolUseId: string | null;
  tools: string[];
  toolUseIds: string[];
  /** §31: who changed it. */
  origin?: FileOrigin;
  /** §34.8: `why` with its source, age, agent and delegation (`why` / `whyToolUseId` mirror `whyDetail.text` / `.toolUseId`). */
  whyDetail?: FileWhy;
  /** §34.3: the file's +/- over the whole review (A → B); `adds` / `dels` are this turn's. */
  reviewAdds?: number;
  reviewDels?: number;
  // MARK: wave4b w4b-files — §40.2: the badges of `changedFiles[].risks` / `riskScore` (absent from an older engine).
  risks?: FileRiskKind[];
  riskScore?: number;
};
/** A Bash call of the turn (subagent calls included). */
export type TurnSummaryCommand = { toolUseId: string; command: string; isError: boolean; testOutcome?: TestOutcome; parentToolUseId?: string };
/** Approved plan ↔ changed files (heuristic: a step "mentions" a file by path, sub-path, basename or a distinctive stem). */
export type PlanVsActual = {
  /** The approved plan file, null when it only came through ExitPlanMode. */
  path: string | null;
  steps: { index: number; text: string; done?: boolean; files: string[] }[];
  unplannedFiles: string[];
  // MARK: wave4d w4d-plan
  /** §42.1: where the plan came from (absent: an older engine — the approved plan). `request`: `unplannedFiles` are outside the request. */
  source?: PlanSourceKind;
  /** §42.1: the plan file's name or the request's first sentence. */
  title?: string;
};
/**
 * After a collection whose turn changed files (§15; §34.3: `files` = the files THIS turn changed, none → no event): what
 * changed, why, the commands run, plan vs actual. §34: `review` = totals over the whole review list, `merged` = the turn
 * merged into a standing review, `lastTest` = the turn's last test run (§34.9).
 */
export type TurnSummaryEvent = {
  type: "turn_summary";
  turn: number;
  files: TurnSummaryFile[];
  commands: TurnSummaryCommand[];
  plan: PlanVsActual | null;
  review?: ChangeTotals;
  merged?: true;
  lastTest?: LastTest | null;
  // MARK: wave4c w4c-trust
  /** §41.2: the files this collection's rules accepted ("규칙으로 수락 N개"); absent when none. */
  autoAccepted?: AutoAcceptedFile[];
  // MARK: wave4d w4d-agents2
  /** §42.4: the turn's `usage.models` (absent when the CLI sent none). */
  models?: ModelCost[];
  // MARK: wave5 w5-model
  /** §43.4: the model the turn was given ("모델: opus (자동 · 설계 판단)"); absent when auto did not touch it. */
  autoModel?: AutoModelChoice;
};
/** The session was restarted without user settings (§16); also `state.session.extensions.fallback`. */
/** `resent`: a message sent before the timeout never reached a working CLI and was sent again after the restart (§16). */
export type ExtensionsFallbackEvent = { type: "extensions_fallback"; reason: "init_timeout"; timeoutMs: number; message: string; resent?: true };
/** Reply to `review_history`: newest first. §34.4 `current`: the round in progress (`inProgress: true`), never in `entries`. */
export type ReviewHistoryEvent = { type: "review_history"; id?: string; sessionId: string | null; entries: ReviewHistoryEntry[]; current?: ReviewHistoryEntry | null };
/** Reply to `history_diff`: same `diff` / `truncated` shape as `file_diff`. */
export type HistoryDiffEvent = { type: "history_diff"; id?: string; entryId: string; path: string; diff: FileDiff; truncated: boolean; final?: true } & HistoryDiffWhy;
export type PermissionRequestEvent = { type: "permission_request" } & PermissionRequest;
export type BudgetEventEvent = {
  type: "budget_event";
  kind: "warn" | "deny";
  toolName: string;
  file?: string;
  files: number;
  lines: number;
  budget: Budget;
};
export type ActivityEvent = { type: "activity"; kind: ActivityKind; toolName?: string; detail?: string };
/**
 * `external` (§31): how many of `files` nothing of Claude's explains (another writer during the turn). §34.3: `files` /
 * `added` / `deleted` count what THIS turn changed (its own start tree → B); `review` = totals over the whole review list;
 * `merged` = the turn merged into a standing review (a question / request-changes follow-up).
 */
export type TurnEndEvent = {
  type: "turn_end";
  stopReason: string;
  usage: TurnUsage;
  files: number;
  added: number;
  deleted: number;
  changedOutside: string[];
  external?: number;
  review?: ChangeTotals;
  merged?: true;
  // MARK: wave5 w5-model
  /** §43.4: the model the turn was given; absent when auto did not touch it. */
  autoModel?: AutoModelChoice;
};
/** One persisted transcript row (`<gitdir>/reviewgate-transcript.ndjson`); `at` is ISO-8601, `turn` the engine's turn counter. */
export type TranscriptItem = { at: string; turn: number } & (
  | { kind: "user_message"; text: string; mentions?: string[]; attachments?: AttachmentRef[]; /** MARK: wave5 w5-model (§43.4) */ autoModel?: AutoModelChoice; /** §50 */ steered?: true }
  | { kind: "assistant_text"; text: string; unprompted?: true }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown>; file?: string; parentToolUseId?: string; rationale?: string; rationaleSource?: RationaleSource; rationaleAge?: number; continues?: AgentContinuation; explore?: true /* MARK: wave4b w4b-tabs (§39.2) */ }
  /** §36.1: an Agent / Task result row also keeps the cleaned `report` (≤ 50 000 chars; never sent in `transcript_restore`, read with `agent_report`). */
  | { kind: "tool_result"; toolUseId: string; isError: boolean; preview: string; parentToolUseId?: string; truncated?: boolean; testOutcome?: TestOutcome; agentUsage?: AgentUsage; cliAgentId?: string; stoppedBy?: AgentStoppedBy; report?: string; reportTruncated?: true }
  | { kind: "permission"; requestId: string; toolName: string; allow: boolean; file?: string }
  | { kind: "budget_event"; event: "warn" | "deny"; toolName: string; file?: string; files: number; lines: number }
  | { kind: "turn_end"; stopReason: string; usage: TurnUsage; files: number; added: number; deleted: number; changedOutside: string[]; external?: number; review?: ChangeTotals; merged?: true; /** MARK: wave5 w5-model (§43.4) */ autoModel?: AutoModelChoice }
  /** §30: an `error` event the user saw (scopes session / git / engine; hints and PR errors are not rows). */
  | ({ kind: "error"; message: string; fatal: boolean; scope: ErrorScope; code?: string; detail?: string } & ErrorRowDetails)
  /** §29: a peer message once it was delivered (its turn's first row) or dropped. */
  | { kind: "peer_message"; id: string; from: string; fromName?: string; verifiedPeerPid?: number; state: "delivered" | "dropped"; outcome?: string; body?: string; unprompted?: true }
  /** §52: a turn Claude started itself (its first row). */
  | ({ kind: "auto_turn" } & AutoTurnInfo)
  /** MARK: wave4 w4-history — §38.3: the turn's `turn_summary` (bounded; `truncated`: lists or texts were cut). */
  | ({ kind: "turn_summary" } & TurnSummaryRow)
);
/** §31: HEAD / the branch moved between the start and the end of turn `turn` (mirrored in `state.gate.headMoved`). */
export type HeadMovedEvent = { type: "head_moved"; turn: number } & HeadMove;
/** §31: other Claude processes work in this worktree (only when there are any); mirrored in `state.gate.concurrentClaude`. */
export type ConcurrentClaudeEvent = { type: "concurrent_claude"; at: "open" | "send"; sessions: ConcurrentClaude[] };
/** §32: `.claude/settings.local.json` changed during turn `turn` (mirrored in `state.gate.localSettingsChanged`). */
export type LocalSettingsChangedEvent = { type: "local_settings_changed"; turn: number } & LocalSettingsChange;
/** §32: turn `turn` changed nested repositories (mirrored in `state.gate.nestedChanges`). */
export type NestedChangesEvent = { type: "nested_changes"; turn: number; repos: NestedChange[] };
/** Emitted after `open_project` / `session_new` / `session_open` with the last rows of the current session's transcript so clients can pre-fill. */
export type TranscriptRestoreEvent = { type: "transcript_restore"; items: TranscriptItem[] } & TranscriptRestorePaging;
/** A plan-mode turn proposed a plan (`ExitPlanMode` or a plan file); the client renders the plan card (docs/M20-MODES.md). */
export type PlanProposedEvent = { type: "plan_proposed"; path: string | null; plan: string; steps?: PlanStepBrief[] /* MARK: wave4d w4d-plan (§42.1) */ };
/** `plan_response { approve: true }` switched the mode; the follow-up `send` is issued right after. */
export type PlanApprovedEvent = { type: "plan_approved"; mode: PermissionMode; path: string | null
  /** MARK: wave4d w4d-plan — §42.1: `new_chat` (this is the fresh chat), `workbench` (`target`: handed to that workbench; `from`: received from it). */
  into?: PlanInto; target?: string; from?: string };
/**
 * §49: a task handed to this worktree by `workbench_create {task}` (in the window that made it), taken when the project
 * opened: `sent` — its text went out as the first message of a fresh chat; false — the session could not take a message,
 * the client puts `text` into the composer.
 */
export type TaskStartedEvent = { type: "task_started"; text: string; mode: PermissionMode; from: string; sent: boolean };
/**
 * Optional, additive detail of an `error` event (docs/PROTOCOL.md §19.6). `code` is the stable id clients localize on;
 * `message` stays the English fallback. `resetAt` (ISO-8601) for `usage_limit` / `rate_limited` when the CLI reports it;
 * `attempt` / `maxRetries` / `retryDelayMs` / `status` for `api_retrying`.
 */
export type ErrorDetails = {
  code?: string;
  /** §21: the side thread an error belongs to. */
  threadId?: string;
  /** §22: the MCP server an error belongs to (`mcp_auth_required`, `mcp_failed`). */
  server?: string;
  /** §33.4 (`worktree_blocked`, `worktree_outside_review`): the tool, the worktree / folder concerned, the branch Claude wanted. */
  toolName?: string;
  path?: string;
  branch?: string;
  /** §33.4 `worktree_outside_review` of a command: the files it changed in `path` (relative to it, POSIX, sorted, ≤ 100). */
  files?: string[];
  resetAt?: string;
  attempt?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  status?: number | null;
  /**
   * §30: the CLI's own words — the first line of its stderr (home folder as `~`, tokens masked, ≤ 300 chars) — on the
   * fatal session errors (`session_start_failed`, `session_crashed`, an API code the CLI died of). Stable for the same
   * failure, so clients can merge repeats on `code` + `detail`.
   */
  detail?: string;
  /** §30: the CLI's exit code / signal when it died (fatal session errors). */
  exitCode?: number | null;
  signal?: string | null;
  /** §30: the chat (`SessionMeta.id`) a notice is about (`resume_not_found` / `resume_failed`: the chat that could not be continued). */
  sessionId?: string;
  /** §36.8: the `cli_version_changed` notice. */
  cli?: CliVersionChange;
  // MARK: wave4 w4-longwork
  /** §38.2 `max_turns`: the limit the turn hit. */
  maxTurns?: number;
  /** §38.2 `hook_failed`: the hook's name (`PreToolUse:Bash`, its event when it has none). */
  hookName?: string;
};
export type ErrorEvent = { type: "error"; message: string; fatal: boolean; scope: ErrorScope } & ErrorDetails;
export type LogEvent = { type: "log"; level: LogLevel; message: string };
// MARK: wave2 check-engine
/**
 * §35.3: what a `kind: "error"` transcript row keeps of its event besides `code` / `detail` — only the fields the event
 * carried — so the banner restored after a restart says what the live one said.
 */
export type ErrorRowDetails = Pick<ErrorDetails, "toolName" | "path" | "branch" | "exitCode" | "signal" | "sessionId" | "resetAt" | "status" | "files">;
/** §35.2: a file `reject_all` left as it was — its content was never captured (§32), so there is nothing to put back. */
export type RejectSkip = { path: string; code: "not_captured" };
/** §35.2: the reply of a `reject_all` (with an `id`) that left uncaptured files pending: `skipped` lists them. */
export type RejectAllResultEvent = Extract<ResultEvent, { ok: true }> & { skipped?: RejectSkip[] };
/** §35.11: `rewound` of a file rewind that left files nothing of Claude's changed in those turns (`external`) as they are. */
export type RewoundKeptEvent = RewoundEvent & { keptFiles?: string[] };
/** §21: a thread snapshot (after every change; also the reply to `side_ask`). */
export type SideThreadEvent = { type: "side_thread"; id?: string; thread: SideThread };
/** §21: reply to `side_list`: the current chat's threads, newest first. */
export type SideThreadsEvent = { type: "side_threads"; id?: string; mainSessionId: string | null; threads: SideThread[] };
export type SideThreadClosedEvent = { type: "side_thread_closed"; threadId: string };
export type SideTextDeltaEvent = { type: "side_text_delta"; threadId: string; text: string };
export type SideToolUseEvent = { type: "side_tool_use"; threadId: string; id: string; name: string; input: Record<string, unknown> };
export type SideToolResultEvent = { type: "side_tool_result"; threadId: string; toolUseId: string; isError: boolean; preview: string; denied?: true };
export type SideTurnEndEvent = { type: "side_turn_end"; threadId: string; costUSD: number; durationMs: number; stopReason: string };
/** §21: reply to `side_promote_draft` (and `side_promote` without `text`): an editable instruction for the main agent. */
export type SidePromoteDraftEvent = { type: "side_promote_draft"; id?: string; threadId: string; text: string };
/** §23: reply to `list_files`. */
export type FilesEvent = { type: "files"; id?: string; query: string; items: FileItem[] };
/** §24: reply to `attachment_get`. */
export type AttachmentEvent = { type: "attachment"; id?: string; hash: string; mediaType: ImageMediaType; dataBase64: string };
/** §26: reply to `rewind`. `sessionId`: the chat that is current afterwards (the fork for a conversation rewind). */
export type RewoundEvent = { type: "rewound"; id?: string; toTurn: number; mode: RewindMode; restoredFiles: string[]; sessionId: string | null };
/** §27: the context use crossed 80 % of the window (once per crossing; again after it dropped below, e.g. after `compact`). */
export type ContextWarningEvent = { type: "context_warning"; percent: number; contextTokens: number; contextWindow: number };
/** §22: live MCP server list (reply to every `mcp_*` command but `mcp_auth`; also emitted whenever it changes). */
export type McpStatusEvent = {
  type: "mcp_status";
  id?: string;
  servers: McpServerInfo[];
  restartRequired: boolean;
  /** MARK: wave4d w4d-config — §42.3: `mcp_toggle {scope:"repository"}` works here (every worktree of the repository). */
  repositoryToggle?: true;
};
/** §29: a peer message arrived or changed state (held → delivering → delivered, or dropped). */
export type PeerMessageEvent = { type: "peer_message"; message: PeerMessage };

// MARK: §52 background work
/** §52: a background task of the session (`state.session.backgroundTasks`). */
export type BackgroundTask = {
  taskId: string;
  /** `task_type` local_bash → bash, a monitor → monitor, local_agent → agent, anything else → other. */
  kind: "bash" | "monitor" | "agent" | "other";
  description: string;
  /** The tool call that started it; null when the CLI did not say. */
  toolUseId: string | null;
  /** The transcript turn of that call; null when unknown. */
  turn: number | null;
  /** ISO-8601. */
  startedAt: string;
  /** Its output file is known (`task_output`). */
  hasOutput: boolean;
};
/** §52: why Claude started a turn itself — a background task ended, a scheduled job (`/loop`, cron) ran, or anything else (`/goal`). */
export type AutoTurnTrigger = "background" | "schedule" | "continue";
export type AutoTurnInfo = {
  trigger: AutoTurnTrigger;
  /** `background`: the task whose notification came last. */
  task?: { taskId: string; description: string; status: string; summary?: string };
  /** `schedule`: the lifecycle frame's `wakeup_source` (`schedule_wakeup`, …). */
  wakeupSource?: string;
};
/** §52: the turn `turn` was started by Claude itself; its row opens the turn. */
export type AutoTurnEvent = { type: "auto_turn"; turn: number } & AutoTurnInfo;
/** §52: reply to `task_background`. */
export type TaskBackgroundEvent = { type: "task_background"; id?: string; moved: boolean };
/** §52: reply to `task_output` — the last 64 KiB of the task's output (`truncated` when cut); `running: false` once it ended. */
export type TaskOutputEvent = { type: "task_output"; id?: string; taskId: string; text: string; truncated: boolean; running: boolean };
/**
 * §34.6: reply to `live_changes` — the running turn's changes so far: its own start tree (`baseTree`) → a snapshot taken now
 * (`liveTree`; reused for 2 s). Nothing here can be accepted. `running: false` (no turn): `files` is empty.
 */
export type LiveChangesEvent = {
  type: "live_changes";
  id?: string;
  running: boolean;
  turn: number | null;
  baseTree: string | null;
  liveTree: string | null;
  /** ISO-8601: when `liveTree` was taken. */
  at: string;
  files: LiveChangedFile[];
  /** More than 200 files changed: the first 200 (path order). */
  truncated?: true;
};
/** §33.8: one Claude Code settings file `permission_rules` read. */
export type PermissionRuleSource = { scope: "user" | "project" | "local"; path: string; exists: boolean; error?: string };
/** §33.8: one `permissions.allow` entry of the user's Claude Code settings and what ReviewGate does with it. */
export type UserPermissionRule = {
  rule: string;
  source: "user" | "project" | "local";
  status: "applied" | "ignored";
  why:
    | "non_mutating_tool"
    | "read_mcp_tool"
    | "read_mcp_tools"
    | "already_allowed"
    | "mutating_mcp_tool"
    | "bash"
    | "edit_tool"
    | "send_message"
    | "unsupported"
    | "invalid"
    | "rules_off"
    | "user_settings_off"
    // MARK: wave3 engine-session — §36.6: a local rule while `settings.loadLocalSettings` is off.
    | "local_settings_off";
  /** The app allow pattern importing it adds (`settings.bashAllowPatterns`, §33.6); null when it cannot be imported. */
  importAs: string | null;
};
/** §33.8: reply to `permission_rules`. */
export type PermissionRulesEvent = {
  type: "permission_rules";
  id?: string;
  sources: PermissionRuleSource[];
  rules: UserPermissionRule[];
  /** `permissions.defaultMode` of the most specific file that sets it (local > project > user). */
  defaultMode: string | null;
  /** `defaultMode` is one of the four modes ReviewGate offers (§11). */
  defaultModeSupported: boolean;
  applyUserAllowRules: boolean;
  loadUserSettings: boolean;
};

export type EngineEvent =
  | ReadyEvent
  | StateEvent
  | ResultEvent
  | FileDiffEvent
  | FullFileContentEvent
  | PRCreatedEvent
  | CommittedEvent
  | UserMessageEvent
  | TextDeltaEvent
  | ToolUseEvent
  | ToolResultEvent
  | ToolOutputEvent
  | ReviewHistoryEvent
  | HistoryDiffEvent
  | PermissionRequestEvent
  | BudgetEventEvent
  | ActivityEvent
  | TurnEndEvent
  | TurnSummaryEvent
  | ExtensionsFallbackEvent
  | TranscriptRestoreEvent
  | PlanProposedEvent
  | PlanApprovedEvent
  | TaskStartedEvent
  | ErrorEvent
  | LogEvent
  | SideThreadEvent
  | SideThreadsEvent
  | SideThreadClosedEvent
  | SideTextDeltaEvent
  | SideToolUseEvent
  | SideToolResultEvent
  | SideTurnEndEvent
  | SidePromoteDraftEvent
  | McpStatusEvent
  | FilesEvent
  | AttachmentEvent
  | RewoundEvent
  | ContextWarningEvent
  | PeerMessageEvent
  | AutoTurnEvent
  | TaskBackgroundEvent
  | TaskOutputEvent
  | HeadMovedEvent
  | ConcurrentClaudeEvent
  | LocalSettingsChangedEvent
  | NestedChangesEvent
  | PermissionRulesEvent
  | LiveChangesEvent
  | AgentReportEvent
  | CliVersionsEvent
  | CliSessionsEvent
  | CommitDraftEvent
  | PRAiDraftEvent
  | CommitHunksEvent // §53
  | CommittedSeriesEvent
  | CommitSplitDraftEvent
  | WorkbenchPreviewEvent
  | WorkbenchProgressEvent
  | PreReviewEvent
  | TranscriptPageEvent // MARK: wave4 w4-history (§38.3)
  | TranscriptSearchEvent
  | HistoryCleanupEvent // MARK: wave4b w4b-bigturn (§39.1)
  | ChatMovedEvent // MARK: wave4b w4b-follow (§39.4)
  | CommitFormatEvent // MARK: wave4c w4c-commit (§41.1)
  | PRDraftEvent
  | FileLinesEvent // MARK: wave4c w4c-review (§41.3)
  | FileImageEvent
  | ClaudeMdEvent // MARK: wave4d w4d-config (§42.3)
  | BrainEvent // MARK: wave5 w5-brain (§43.2)
  | BrainMemoryEvent
  | CodeGraphEvent // MARK: wave5 w5-graph (§43.3)
  | StatusLineEvent // MARK: wave6 w6-statusline (§44.2)
  | ProjectFileEvent // MARK: code-browser (§47)
  | ProjectSearchEvent;

/** The typed reply a command with an `id` receives (`result` for everything without a dedicated reply). */
export type ReplyFor<C extends EngineCommand> =
  C extends { type: "hello" } ? ReadyEvent
  : C extends { type: "select_file" | "pr_select_file" | "live_diff" } ? FileDiffEvent
  : C extends { type: "full_file" } ? FullFileContentEvent
  : C extends { type: "pr_create" } ? PRCreatedEvent
  : C extends { type: "commit" | "push" } ? CommittedEvent
  : C extends { type: "tool_output" } ? ToolOutputEvent
  : C extends { type: "review_history" } ? ReviewHistoryEvent
  : C extends { type: "history_diff" } ? HistoryDiffEvent
  : C extends { type: "history_file_lines" | "pr_file_lines" } ? FileLinesEvent // MARK: wave4c w4c-review (§41.3)
  : C extends { type: "file_image" } ? FileImageEvent
  : C extends { type: "side_ask" } ? SideThreadEvent
  : C extends { type: "side_list" } ? SideThreadsEvent
  : C extends { type: "side_promote_draft" } ? SidePromoteDraftEvent
  : C extends { type: "side_promote" } ? (ResultEvent & { ok: true }) | SidePromoteDraftEvent
  : C extends { type: "mcp_status" | "mcp_reconnect" | "mcp_toggle" | "mcp_add" | "mcp_remove" } ? McpStatusEvent
  : C extends { type: "list_files" } ? FilesEvent
  : C extends { type: "attachment_get" } ? AttachmentEvent
  : C extends { type: "rewind" } ? RewoundEvent
  : C extends { type: "permission_rules" } ? PermissionRulesEvent
  : C extends { type: "live_changes" } ? LiveChangesEvent
  : C extends { type: "agent_report" } ? AgentReportEvent
  : C extends { type: "cli_versions" } ? CliVersionsEvent
  : C extends { type: "cli_sessions" } ? CliSessionsEvent
  : C extends { type: "commit_draft" } ? CommitDraftEvent
  : C extends { type: "pr_ai_draft" } ? PRAiDraftEvent
  : C extends { type: "commit_hunks" } ? CommitHunksEvent // §53
  : C extends { type: "commit_series" } ? CommittedSeriesEvent
  : C extends { type: "commit_split_draft" } ? CommitSplitDraftEvent
  : C extends { type: "task_background" } ? TaskBackgroundEvent
  : C extends { type: "task_output" } ? TaskOutputEvent
  : C extends { type: "workbench_preview" } ? WorkbenchPreviewEvent
  : C extends { type: "prereview_start" } ? PreReviewEvent
  : C extends { type: "transcript_page" } ? TranscriptPageEvent // MARK: wave4 w4-history (§38.3)
  : C extends { type: "transcript_search" } ? TranscriptSearchEvent
  : C extends { type: "history_cleanup" } ? HistoryCleanupEvent // MARK: wave4b w4b-bigturn (§39.1)
  : C extends { type: "commit_format" } ? CommitFormatEvent // MARK: wave4c w4c-commit (§41.1)
  : C extends { type: "pr_draft" } ? PRDraftEvent
  : C extends { type: "claude_md_read" | "claude_md_write" } ? ClaudeMdEvent // MARK: wave4d w4d-config (§42.3)
  : C extends { type: "brain" } ? BrainEvent // MARK: wave5 w5-brain (§43.2)
  : C extends { type: "brain_read" } ? BrainMemoryEvent
  : C extends { type: "code_graph" | "code_graph_build" } ? CodeGraphEvent // MARK: wave5 w5-graph (§43.3)
  : C extends { type: "status_line" } ? StatusLineEvent // MARK: wave6 w6-statusline (§44.2)
  : C extends { type: "project_file" } ? ProjectFileEvent // MARK: code-browser (§47)
  : C extends { type: "project_search" } ? ProjectSearchEvent
  : ResultEvent & { ok: true };

export type ReplyEvent = ReadyEvent | ResultEvent | FileDiffEvent | FullFileContentEvent | PRCreatedEvent | CommittedEvent | ToolOutputEvent | ReviewHistoryEvent | HistoryDiffEvent
  | SideThreadEvent | SideThreadsEvent | SidePromoteDraftEvent | McpStatusEvent | FilesEvent | AttachmentEvent | RewoundEvent | PermissionRulesEvent
  | LiveChangesEvent
  | AgentReportEvent | CliVersionsEvent | CliSessionsEvent | CommitDraftEvent | PRAiDraftEvent | WorkbenchPreviewEvent | PreReviewEvent
  | CommitHunksEvent | CommittedSeriesEvent | CommitSplitDraftEvent // §53
  | TaskBackgroundEvent | TaskOutputEvent
  | TranscriptPageEvent | TranscriptSearchEvent // MARK: wave4 w4-history (§38.3)
  | HistoryCleanupEvent // MARK: wave4b w4b-bigturn (§39.1)
  | CommitFormatEvent | PRDraftEvent // MARK: wave4c w4c-commit (§41.1)
  | FileLinesEvent | FileImageEvent // MARK: wave4c w4c-review (§41.3)
  | ClaudeMdEvent // MARK: wave4d w4d-config (§42.3)
  | BrainEvent | BrainMemoryEvent // MARK: wave5 w5-brain (§43.2)
  | CodeGraphEvent // MARK: wave5 w5-graph (§43.3)
  | StatusLineEvent // MARK: wave6 w6-statusline (§44.2)
  | ProjectFileEvent | ProjectSearchEvent; // MARK: code-browser (§47)

// ---------------------------------------------------------------- §36 wave 3: agents, sessions and daily flow
// Types only (docs/PROTOCOL.md §36). Owners: engine-agents §36.1–36.4, engine-session §36.5–36.9, engine-flow §36.10–36.14.

/** §36.1: a subagent's usage — the `<usage>` block of its result (`subagent_tokens`, `tool_uses`, `duration_ms`). */
export type AgentUsage = { tokens: number; toolUses: number; durationMs: number };

/** §36.2: who stopped an agent (`stop_agent` is the only way the engine stops one by itself). */
export type AgentStoppedBy = "user";

/** §36.3: `tool_use.continues` of a SendMessage call whose `to` is a subagent the engine knows. */
export type AgentContinuation = {
  /** The Agent / Task call that started it (`AgentNode.toolUseId`): its group in the chat. */
  agentToolUseId: string;
  /** Its `subagent_type`. */
  agentType: string;
};

/**
 * §36.1: reply to `agent_report` — the subagent's whole report, cleaned (hand-back preamble, indentation, `agentId:` line
 * and `<usage>` block removed; another CLI's format is kept as it came). `truncated`: longer than the 50 000 chars kept.
 */
export type AgentReportEvent = {
  type: "agent_report";
  id?: string;
  toolUseId: string;
  text: string;
  truncated: boolean;
  usage: AgentUsage | null;
  model: string | null;
  /** The whole instructions (the Agent call's `prompt`, ≤ 50 000 chars); null when unknown. */
  prompt: string | null;
};

/** §36.4: the main turn waits on foreground subagents (`hud.waitingOnAgents`). */
export type WaitingOnAgents = {
  /** Live foreground top-level subagents (a blocking continuation included). */
  count: number;
  /** The one running longest. `startedAt`: epoch ms (of its current run when it was continued). */
  longest: { toolUseId: string; type: string; startedAt: number };
};

/** §36.5: `capabilities.state`. */
export type CapabilitiesState = "starting" | "ready";

/** §36.5: where a slash command comes from (palette groups). */
export type SlashCommandSource = "builtin" | "user" | "project" | "plugin" | "mcp" | "unknown";

/** §36.5: one command of `capabilities.commands` (the SDK's `SlashCommand` + its source). */
export type SlashCommandInfo = {
  /** Without the leading slash (`team-plugin:team-dev`). */
  name: string;
  description: string;
  /** "" when the command takes none. */
  argumentHint: string;
  source: SlashCommandSource;
  /** `plugin`: the plugin's name. */
  plugin?: string;
  /** `mcp`: the server's name. */
  server?: string;
  aliases?: string[];
};

/** §36.6: what `.claude/settings.local.json` and the local-scope MCP servers hold that the session does not apply. Names and counts only — never a value. */
export type NotAppliedLocalSettings = {
  hooks: { event: string; command: string }[];
  envKeys: string[];
  mcpServers: string[];
  allowRuleCount: number;
};

/** §36.7: what a starting CLI waits for (`session.extensionsWaitingOn`). */
export type ExtensionsWaitingOn = { kind: "hook" | "mcp" | "plugin" | "unknown"; name: string | null };

/** §36.8: the CLI versions ReviewGate verified (inclusive, `compareVersions` order); an engine constant. */
export type CliVersionRange = { min: string; max: string };

/** §36.8: `session.cli`. */
export type CliInfo = {
  /** What the running CLI reports (`system/init` `claude_code_version`, else `toolchain.claudeVersion`). */
  version: string | null;
  /** `version` is inside `verifiedRange`. */
  verified: boolean;
  verifiedRange: CliVersionRange;
  /** The version used before this one (app-wide record); `path` set while it is still installed (pinnable). */
  previous: { version: string; path: string | null } | null;
};

/** §36.8: `error{code: "cli_version_changed"}.cli` — the notice sent once when the version differs from the last one seen. */
export type CliVersionChange = { from: string | null; to: string; verified: boolean };

/** §36.8: one installed version (`~/.local/share/claude/versions/<ver>`). */
export type CliVersionEntry = { version: string; path: string; verified: boolean };

/** §36.8: reply to `cli_versions`, newest first. `pinnedPath`: `settings.claudePath` when set. */
export type CliVersionsEvent = { type: "cli_versions"; id?: string; versions: CliVersionEntry[]; current: string | null; pinnedPath: string | null };

/** §36.9: a running Claude process's state as its registry entry says (`waiting` = waiting for the user's input). */
export type CliSessionStatus = "idle" | "busy" | "waiting" | "unknown";

/** §36.9: another live Claude process in this repository or one of its worktrees (`<config>/sessions/<pid>.json`). */
export type CliRunningSession = {
  pid: number;
  sessionId: string | null;
  name: string | null;
  cwd: string;
  status: CliSessionStatus;
  /** `cli` (a terminal), `sdk-ts` / `sdk-cli` (an app or script), … */
  entrypoint: string | null;
  /** Its cwd is inside this window's worktree. */
  sameWorktree: boolean;
  // MARK: wave4d w4d-peers
  /** §42.2: `uds:<socket>` a SendMessage reaches it at; absent when the registry lists no socket. */
  address?: string;
};

/** §36.9: a CLI conversation of this repository that can be resumed here (SDK `listSessions`). */
export type CliResumableSession = {
  sessionId: string;
  /** Custom title, else the CLI's summary / first prompt (≤ 120 chars). */
  title: string;
  /** ISO-8601 */
  updatedAt: string;
  cwd: string | null;
};

/** §36.9: reply to `cli_sessions`. */
export type CliSessionsEvent = {
  type: "cli_sessions"; id?: string; running: CliRunningSession[]; resumable: CliResumableSession[];
  // MARK: wave4d w4d-peers
  /** §42.2: this window's own session as the others see it; absent before its CLI registered (or from older engines). */
  self?: PeerSelf;
};

/** §36.9: `SessionMeta.imported`. `at`: ISO-8601 of the import; `cwd`: the folder the terminal session ran in. */
export type ImportedSession = { at: string; cwd: string | null };

/** §21 / §36.10: how a side thread's first question started. */
export type SideFork = {
  mode: "fork_at" | "fork_full" | "fresh";
  fromSessionId: string | null;
  /** `fork_at`: the chain uuid forked at. */
  at: string | null;
  /** §36.10: the last main turn the fork contains (null: fresh). */
  atTurn?: number | null;
  /** §36.10: the main turn that was running and is only summarized in the first prompt; null when none. */
  runningTurn?: number | null;
};

/** §36.11: reply to `commit_draft` — a message for the commit sheet's field (nothing is committed). */
export type CommitDraftEvent = { type: "commit_draft"; id?: string; message: string };
/** §51: reply to `pr_ai_draft` — for the PR sheet's fields (nothing is pushed or created); `title` "" when the answer had none. */
export type PRAiDraftEvent = { type: "pr_ai_draft"; id?: string; title: string; body: string };

// ---------------------------------------------------------------- §53 commits in meaningful units

/** §53: one hunk of `git diff HEAD -- <path>` (3 lines of context); `text` = its lines after the header (`+` / `-` / ` `), ≤ 300. */
export type CommitHunk = { id: number; header: string; added: number; deleted: number; text: string };
/** §53: an accepted file as a commit takes it from the worktree; `hunks` [] → it can only go whole. */
export type CommitFile = { path: string; oldPath?: string; status: ChangeStatus; binary: boolean; hunks: CommitHunk[] };
/** §53: reply to `commit_hunks`. */
export type CommitHunksEvent = { type: "commit_hunks"; id?: string; files: CommitFile[] };
/** §53: one part of a planned commit — a file whole (no `hunks`) or the hunks of `commit_hunks` it takes, by id. */
export type CommitPart = { path: string; hunks?: number[] };
/** §53: one planned commit; `why` (from `commit_split_draft`) says why its parts belong together. */
export type CommitPlan = { message: string; parts: CommitPart[]; why?: string };
/** §53: a commit `commit_series` made (`message` with `settings.commitTrailer`; `files` the parts' paths). */
export type SeriesCommit = { sha: string; shortSha: string; message: string; files: string[] };
/** §53: reply to `commit_series`. */
export type CommittedSeriesEvent = { type: "committed_series"; id?: string; commits: SeriesCommit[]; branch: string | null; pushed: boolean };
/** §53: reply to `commit_split_draft` — the proposed commits (only valid parts) and what none of them took. Nothing is committed. */
export type CommitSplitDraftEvent = { type: "commit_split_draft"; id?: string; commits: CommitPlan[]; unassigned: CommitPart[] };
/** §53: what a `commit_series` that failed in the middle made — on its `commit_failed` refusal. */
export type PartialSeries = { commits: SeriesCommit[]; branch: string | null; pushed: false };

/** §36.12: where a new workbench goes — `managed` (`settings.worktreeRoot`) or `sibling` (`<parent of the main worktree>/<repo>-<branch tail>`). */
export type WorkbenchLocation = "managed" | "sibling";

/** §36.12: `settings.workbenchSetup`. */
export type WorkbenchSetup = {
  /** Globs (repo-relative, `*` / `**` / `?`) of untracked or ignored files copied from this worktree. */
  copy?: string[];
  /** Also copy what `.worktreeinclude` lists (default true). */
  useWorktreeInclude?: boolean;
  /** Run in the new worktree after the copy (the user's login shell); "" / absent = none. */
  setupCommand?: string;
  /** Fetch a remote base before creating (default true). */
  fetchBase?: boolean;
  /** Default `managed`. */
  location?: WorkbenchLocation;
};

/** §36.14: `workbench_create.fromPr` — check out the PR's head (`refs/pull/<number>/head`). */
export type WorkbenchFromPr = { number: number; headRef: string };

/** §49: `workbench_create.task` — the first message of the new workbench's fresh chat; `mode` its permission mode (else the default). */
export type WorkbenchTask = { text: string; mode?: PermissionMode };
/** §49: a task's text is at most this many characters (`invalid_task` beyond, or when empty). */
export const MAX_TASK_TEXT = 100_000;

/** §36.12: one file `workbench_create` would copy. */
export type WorkbenchCopyItem = { path: string; bytes: number };

/** §36.12: reply to `workbench_preview`. `copy`: at most 500 entries (`truncated`); `totalBytes` counts every file. */
/** `count`: every file the create would copy (`copy` lists at most 500 of them; `totalBytes` counts all). */
export type WorkbenchPreviewEvent = { type: "workbench_preview"; id?: string; path: string; copy: WorkbenchCopyItem[]; totalBytes: number; count?: number; truncated?: true };

/** §36.12: the steps of `workbench_create`. */
export type WorkbenchStep = "fetch" | "create" | "copy" | "setup" | "done";

/**
 * §36.12: progress of a `workbench_create` (keyed by the new worktree's `path` — an event's `id` is the reply id). `logTail`:
 * the step's last ≤ 4 000 chars of output; `exitCode`: of `fetch` / `setup` (null: killed / timed out); `done` repeats the
 * setup's (absent when no setup ran).
 */
export type WorkbenchProgressEvent = { type: "workbench_progress"; path: string; branch: string; step: WorkbenchStep; logTail?: string; exitCode?: number | null };

/** §36.12: one entry of `state.branches.remotes` (`name` = `origin/develop`). */
export type RemoteBranchInfo = BranchInfo & { remote: true };

/** §36.13 */
export type PreReviewScope = "round" | "files";
export type PreReviewEffort = "low" | "medium" | "high";
export type PreReviewStatus = "running" | "done" | "failed" | "cancelled";

/** §36.13: one finding of a ReportFindings call (`file` repo-relative; `line` on the new side, null: the whole file). */
export type PreReviewFinding = {
  id: string;
  file: string;
  line: number | null;
  summary: string;
  shortSummary: string;
  failureScenario: string;
  category?: string;
};

/** §36.13: one pre-review (`state.gate.prereviews[]`, the `prereview` event). */
export type PreReviewRun = {
  prereviewId: string;
  status: PreReviewStatus;
  /** `round`: `prereview_start`; `main`: the main chat's own ReportFindings call (`prereviewId` = its tool_use id). */
  source: "round" | "main";
  scope?: PreReviewScope;
  paths?: string[];
  effort?: PreReviewEffort;
  /** The B the findings' lines refer to (`gate.reviewEndTree` when it ran). */
  endTree: string | null;
  /** ISO-8601 */
  startedAt: string;
  endedAt?: string;
  /** Dismissed findings are removed. */
  findings: PreReviewFinding[];
  /** `failed`: why (English; `code` words as refusals). */
  error?: string;
  costUSD?: number;
};

/** §36.13: a pre-review started, progressed or ended (also the reply to `prereview_start`); mirrored in `state.gate.prereviews`. */
export type PreReviewEvent = { type: "prereview"; id?: string } & PreReviewRun;

/** §36.14: `SideAnchor.pr` — a line / hunk of a PR diff. */
export type SidePrAnchor = {
  number: number;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  /** The hunk's text (≤ 4 000 chars; the engine cuts longer). */
  hunk: string;
  commitId?: string;
};

// ---------------------------------------------------------------- MARK: wave4 w4-history — §38.3 history that lasts
// Types only (docs/PROTOCOL.md §38.3).

/** §38.3: a `turn_summary` row — the event's fields without `type` / `turn` (the row's own `turn`), bounded. */
export type TurnSummaryRow = Omit<TurnSummaryEvent, "type" | "turn"> & { truncated?: true };

/**
 * §38.3: where `transcript_restore.items` start in the chat's file. `start`: the row index of `items[0]` (the position of
 * its line among the file's non-empty lines; `start > 0`: older rows exist, read them with `transcript_page`).
 * `sessionId`: the chat the rows are of. Both absent from an engine before §38.3.
 */
export type TranscriptRestorePaging = { start?: number; sessionId?: string | null };

/** §38.3: reply to `transcript_page` — rows `start`…`before - 1` (oldest first); `start > 0`: there are older ones. */
export type TranscriptPageEvent = { type: "transcript_page"; id?: string; sessionId: string; items: TranscriptItem[]; start: number; before: number };

/** §38.3: one chat whose messages contain the query — its newest matching user message or Claude answer. */
export type TranscriptSearchMatch = {
  sessionId: string;
  title: string;
  /** Row index of the matching row in the chat's file (as `transcript_restore.start`). */
  row: number;
  turn: number;
  /** ISO-8601 */
  at: string;
  kind: "user_message" | "assistant_text";
  /** The line that matched (≤ 160 chars, "…" where cut). */
  line: string;
  /** MARK: wave4c w4c-review — §41.3 (`perChat` > 1): the chat's next older matches, newest first. */
  more?: TranscriptSearchHit[];
  /** §41.3 (`perChat` > 1): every matching row of the chat (this one and `more` included). */
  total?: number;
};
/** §41.3: one more matching row of a chat (`TranscriptSearchMatch.more`). */
export type TranscriptSearchHit = Pick<TranscriptSearchMatch, "row" | "turn" | "at" | "kind" | "line">;

/** §38.3: reply to `transcript_search` — at most one match per chat, newest chat first. */
export type TranscriptSearchEvent = { type: "transcript_search"; id?: string; query: string; matches: TranscriptSearchMatch[] };

/** §38.3: `history_diff.why` — why the round changed the file, from its chat's rows; null: they say nothing. */
export type HistoryDiffWhy = { why?: FileWhy | null };

/** §38.3: `ReviewHistoryFile.commit`. */
export type HistoryCommit = { sha: string; subject: string };

// ---------------------------------------------------------------- MARK: wave4b w4b-bigturn — §39.1 big turns and a full disk
// Types only (docs/PROTOCOL.md §39.1).

/** §39.1: what could not be saved — the review file and its pins, the review history, a chat's checkpoints, a chat's rows. */
export type SaveWhat = "review" | "history" | "checkpoints" | "transcript";

/**
 * §39.1: saves failing right now. `code`: Node's / git's error code (`ENOSPC`, `EDQUOT`, `EROFS`, `EACCES`, …; null unknown);
 * `diskFull`: the code says the disk is full; `detail`: the newest failure's first line; `since`: when this run of failures
 * began (one banner per `since`); `at`: the newest failure. A kind leaves `what` with its next good save.
 */
export type SaveFailure = { what: SaveWhat[]; code: string | null; diskFull: boolean; detail: string; since: string; at: string };

/** §39.1: free space of the repository's volume. `low` below 2 GB, `critical` below 1 GB. */
export type DiskLevel = "ok" | "low" | "critical";
export type DiskSpace = { freeBytes: number; totalBytes: number; level: DiskLevel; at: string };

/** §39.1 `state.storage`. */
export type StorageState = { saveFailed: SaveFailure | null; disk: DiskSpace | null };

/**
 * §39.1: reply to `history_cleanup`. `rounds` / `checkpoints`: review-history rounds and checkpoint records that go (went,
 * with `applied`); `refs`: the app's refs under `refs/reviewgate/<ns>/` that go with them; `bytes`: the loose objects only
 * those refs keep (about what `git prune` frees; packed objects are not counted; null when it could not be measured);
 * `kept`: rounds kept.
 */
export type HistoryCleanupEvent = {
  type: "history_cleanup";
  id?: string;
  keep: number;
  rounds: number;
  checkpoints: number;
  refs: number;
  bytes: number | null;
  kept: number;
  applied: boolean;
};

// ---------------------------------------------------------------- MARK: wave4b w4b-follow — §39.4 following Claude into another worktree
// Types only (docs/PROTOCOL.md §39.4).

/** §39.4: the worktree a chat was handed to / came from. `path`: its root (absolute, native); `name`: its folder name; `at`: ISO-8601. */
export type ChatMoveRef = { path: string; name: string; at: string };

/**
 * §39.4: where the moved chat's first review starts. `head`: the worktree's HEAD commit — this chat created the worktree,
 * so what it did there before the move is reviewed; `disk`: the worktree as it was at the move (changes made before are
 * not reviewed — the worktree may hold the user's own work).
 */
export type ChatMoveBaseline = "head" | "disk";

/** §39.4: this window handed its chat over (`chat_move`, or a followed worktree command): the client opens / fronts the target's window. */
export type ChatMovedEvent = {
  type: "chat_moved";
  sessionId: string;
  /** The target worktree's root. */
  path: string;
  name: string;
  baseline: ChatMoveBaseline;
  /** A running turn was stopped for the move. */
  interrupted: boolean;
};

// ---------------------------------------------------------------- MARK: wave4b w4b-side — §40.3 side questions you can trust

/** §40.3: `settings.sideWeb`. */
export const SIDE_WEB_MODES = ["off", "rules", "on"] as const;
export type SideWebMode = (typeof SIDE_WEB_MODES)[number];

/** §40.3: `SideAnchor.quote` — a passage of Claude's answer the user selected (≤ 2000 chars) and the main turn it is from. */
export type SideQuoteAnchor = { text: string; turn?: number | null };

// ---------------------------------------------------------------- MARK: wave4c w4c-trust — §41.2 trusted auto-accept, undoing a reject
// Types only (docs/PROTOCOL.md §41.2; the rules: engine/src/review/trust.ts).

/** §41.2: the opt-in rules that accept a file on their own — whitespace only, a lockfile with its manifest, a test that passed. */
export const AUTO_ACCEPT_RULES = ["whitespace", "lockfile", "tests"] as const;
export type AutoAcceptRule = (typeof AUTO_ACCEPT_RULES)[number];

/** §41.2: which rules this repository turned on (absent / false = off; every rule is off by default). */
export type AutoAcceptRules = { [K in AutoAcceptRule]?: boolean };

/** §41.2 `turn_summary.autoAccepted[]`: a file this collection's rules accepted. */
export type AutoAcceptedFile = { path: string; rule: AutoAcceptRule };

/**
 * §41.2 `state.gate.rejectUndo`: the last single-file reject while it can still be put back — until the next turn starts,
 * another file is rejected or the review moves underneath it. `available: false` + `reason`: the button is disabled.
 */
export type RejectUndoState = {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  available: boolean;
  reason?: RejectUndoBlock;
};
/** `changed_on_disk`: the file is no longer what the reject left; `review_changed`: A moved (a commit) or the review ended. */
export type RejectUndoBlock = "changed_on_disk" | "review_changed";

// ---------------------------------------------------------------- MARK: wave4c w4c-commit — §41.1 commits and PRs in the team's format

/** §41.1: the shape the recent subjects follow (`#acme/4821/…`, `[ABC-12] …` / `ABC-12: …`, `#12 …` / `[#12] …`, `feat(x): …`). */
export type CommitFormatKind = "path" | "key" | "number" | "conventional";

/** §41.1: reply to `commit_format`. */
export type CommitFormatEvent = {
  type: "commit_format";
  id?: string;
  /** The format most recent subjects follow, as a commit template (`#acme/{issue}/{title} - {summary}`); null when none. */
  learned: string | null;
  kind: CommitFormatKind | null;
  /** Recent subjects that follow it, newest first (≤ 5). */
  examples: string[];
  /** The branch's issue number as `{issue}` renders it ("" without one). */
  issue: string;
  branch: string | null;
  /** `settings.commitTemplate`, else `learned`, with `{issue}` / `{branch}` filled in: what `commit_draft` asks for; null when neither. */
  effective: string | null;
  /** Where `effective` comes from. */
  source: "settings" | "learned" | null;
};

/** §41.1: `pr_create` metadata — one `gh pr create` flag per value (`@me` = the logged-in user). */
export type PRCreateMeta = { assignees?: string[]; labels?: string[]; reviewers?: string[]; projects?: string[] };

/** §41.1: whether `gh pr create` can run: `not_found` (no gh), `not_logged_in` (no account for the remote's host). */
export type GHReadiness = "ok" | "not_found" | "not_logged_in";

/** §41.1: reply to `pr_draft`. */
export type PRDraftEvent = {
  type: "pr_draft";
  id?: string;
  /** Proposed from the branch's commits (`prDraftFrom`); "" without commits. */
  title: string;
  body: string;
  /** The branch's commit subjects since the base, oldest first (≤ 50; merges left out). */
  commits: string[];
  /** The ref the commits were counted from (`origin/<base>` when it exists, else `<base>`); null when neither exists. */
  baseRef: string | null;
  /** False: `pr_create` pushes the branch first (`git push -u origin <branch>`, only when the user creates the PR). */
  hasUpstream: boolean;
  gh: GHReadiness;
  /** The remote's host (`ghe.example.com`); null without a parseable `origin`. */
  host: string | null;
};

// ---------------------------------------------------------------- MARK: wave4c w4c-review — §41.3 review leftovers
// Types only (docs/PROTOCOL.md §41.3).

/**
 * §41.3: reply to `history_file_lines` / `pr_file_lines` — the file as the diff's new side has it (lines split on `\r?\n`,
 * the last empty one dropped), for "20줄 더 보기". `lines` is empty when `isBinary` / `isTooLarge` (over 2 MB or 20 000
 * lines). `entryId`: the history entry; `sha`: the PR's head commit.
 */
export type FileLinesEvent = {
  type: "file_lines";
  id?: string;
  scope: "history" | "pr";
  path: string;
  entryId?: string;
  sha?: string;
  lines: string[];
  isBinary: boolean;
  isTooLarge: boolean;
};

/** §41.3: one side of an image (`file_image`); `dataBase64` absent when `tooLarge` (over 2 MB). */
export type FileImageSide = { size: number; dataBase64?: string; tooLarge?: true };

/**
 * §41.3: reply to `file_image` — a changed png / jpg / gif before (A, at `oldPath` for a rename) and after (the review's
 * B); `old` null for an added file, `new` null for a deleted one. `mediaType`: from the path's extension.
 */
export type FileImageEvent = {
  type: "file_image";
  id?: string;
  path: string;
  oldPath: string | null;
  mediaType: "image/png" | "image/jpeg" | "image/gif";
  old: FileImageSide | null;
  new: FileImageSide | null;
  /** The B the new side is read from (`gate.reviewEndTree`). */
  endTree: string;
};

// ---------------------------------------------------------------- MARK: wave4d w4d-agents2 — §42.4 subagent cost and the agents panel
/**
 * §42.4: what one model cost in a turn — the delta of the SDK's cumulative `result.modelUsage[model]` (main loop,
 * subagents, compaction; the CLI's estimate, not a bill). `model`: the id as the CLI keyed it
 * (`claude-opus-4-1-20250805`); tokens as the SDK counts them (cache reads apart from input).
 */
export type ModelCost = {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

// ---------------------------------------------------------------- MARK: wave4d w4d-config — §42.3 MCP servers and Claude's instructions
// Types only (docs/PROTOCOL.md §42.3).

/** §42.3: where `mcp_toggle` keeps a choice — this worktree (`<git dir>`) or every worktree of the repository (`<git common dir>`). */
export type McpToggleScope = "worktree" | "repository";

/** §42.3: why ReviewGate cannot remove a server where it is defined. */
export type McpNotRemovableReason = "plugin" | "claude_ai" | "managed" | "not_found" | "read_only" | "unknown";

/** §42.3: the file that defines a server and whether `mcp_remove` can remove it there. */
export type McpServerOrigin = {
  /** Absolute, native: a `.mcp.json` of the project or of a folder above it, or the user's `.claude.json`; null when unknown. */
  file: string | null;
  /** `project` inside the project; `parent` a folder above it (every project below that folder uses it); `home` the user's `.claude.json`. */
  place: "project" | "parent" | "home" | null;
  /** `mcp_remove` removes it (a `parent` file only with `file` set to it). */
  removable: boolean;
  reason?: McpNotRemovableReason;
  /** What removes it in a terminal, when ReviewGate cannot. */
  command?: string;
};

/**
 * §42.3: what an instruction file is, and so when Claude reads it. `user` ~/.claude/CLAUDE.md (every project, at the start);
 * `project` the project's CLAUDE.md / .claude/CLAUDE.md (shared through git, at the start); `local` CLAUDE.local.md (only
 * you, at the start); `parent` a CLAUDE.md in a folder above the project (at the start); `nested` one in a folder below the
 * root (when Claude reads files there); `rules` .claude/rules/*.md; `auto_memory` the CLI's own memory (MEMORY.md);
 * `managed` the organization's; `other` anything else.
 */
export type InstructionKind = "user" | "project" | "local" | "parent" | "nested" | "rules" | "auto_memory" | "managed" | "other";

/** §42.3: one of the project's own instruction files (`SessionExtensions.projectInstructions`). */
export type ProjectInstructionFile = { path: string; relPath: string; kind: "project" | "local"; exists: boolean };

/** §42.3: a subagent of the session. `source` / `path` when its definition file was found (else built in or defined elsewhere). */
export type SubagentInfo = { name: string; description: string; model?: string; source?: "project" | "user" | "plugin"; path?: string };

/** §42.3: reply to `claude_md_read` / `claude_md_write`: the file as it is on disk now (`sha` null = missing). */
export type ClaudeMdEvent = {
  type: "claude_md";
  id?: string;
  /** Absolute, native. */
  path: string;
  /** Project-relative, "/"-separated. */
  relPath: string;
  kind: "project" | "local" | "nested";
  text: string;
  sha: string | null;
  exists: boolean;
  /** The reply to a write. */
  saved?: true;
};

// ---------------------------------------------------------------- MARK: wave4d w4d-plan — §42.1 plans you can review and follow

/** §42.1: a step of a proposed plan — 0-based `index` (the clients show index + 1) and its text (≤ 300 chars). */
export type PlanStepBrief = { index: number; text: string };
/** §42.1: `plan_response.into`. */
export const PLAN_INTO = ["new_chat", "workbench"] as const;
export type PlanInto = (typeof PLAN_INTO)[number];
/** §42.1: where a turn summary's plan comes from, in this order: approved in ReviewGate, a plan file, Claude's to-do list, the first message's list, the request. */
export type PlanSourceKind = "approved" | "file" | "todos" | "message" | "request";
/** §42.1: `state.session.planSource`. */
export type PlanSourceState = {
  /** What the next summary follows; null: nothing yet (no plan, no list, the request @mentions no file). */
  kind: PlanSourceKind | null;
  /** The plan file (kind `file`): repo-relative inside the worktree, else absolute. */
  path?: string;
  /** `plan_follow` chose it (not found in the chat by itself). */
  chosen?: boolean;
  /** Plan files to choose from (`.omc/plans/`, `.claude/plans/`, plan-named files under `docs/`, the newest of `~/.claude/plans/`). */
  candidates: string[];
};

// ---------------------------------------------------------------- MARK: wave5 w5-model — §43.4 auto model

/** §43.4: `settings.modelMode` — `manual` (the default: the model chip's choice) or `auto` (the engine picks per message). */
export const MODEL_MODES = ["manual", "auto"] as const;
export type ModelMode = (typeof MODEL_MODES)[number];
/** §43.4: `settings.modelAutoPolicy` — how readily auto picks opus / haiku (default `balanced`). */
export const AUTO_MODEL_POLICIES = ["cost", "balanced", "quality"] as const;
export type AutoModelPolicy = (typeof AUTO_MODEL_POLICIES)[number];
/** §43.4: the model families auto chooses between (the newest of each the session offers). */
export type ModelFamily = "opus" | "sonnet" | "haiku";
/**
 * §43.4: why a turn runs on its model. opus: `plan_mode`, `plan_implementation`, `after_failure`, `after_revert`,
 * `changes_requested`, `design`, `debug`, `refactor`, `why`, `wide_scope`, `long_message`, `attachments`,
 * `quality_policy`; haiku: `trivial_edit`, `quick_question`, `short_message`; sonnet: `standard`, `cost_policy`
 * (a reason for opus the cost policy left on sonnet), `simple_task` (quality's floor); `continuation` (a bare "계속"
 * keeps the previous turn's family); `user_choice` (this message's own pick); `manual` (back to the chip's model after a
 * one-message pick).
 */
export const AUTO_MODEL_REASONS = [
  "plan_mode", "plan_implementation", "after_failure", "after_revert", "changes_requested",
  "design", "debug", "refactor", "why", "wide_scope", "long_message", "attachments", "quality_policy",
  "trivial_edit", "quick_question", "short_message",
  "standard", "cost_policy", "simple_task", "continuation",
  "user_choice", "manual",
] as const;
export type AutoModelReason = (typeof AUTO_MODEL_REASONS)[number];

/**
 * §43.4: the model a turn was given before it went out. `model`: the value sent to `Query.setModel` (an option's
 * `value`; null = the CLI's default, only `by: "manual"`); `by`: `auto` (the engine decided), `user` (`send.model`) or
 * `manual` (the chip's model again after a one-message pick); `switched` / `from`: the session was on another model
 * before (`from`: that value, or the id the CLI reported). Absent from a turn auto did not touch.
 */
export type AutoModelChoice = {
  model: string | null;
  family?: ModelFamily;
  reason: AutoModelReason;
  policy: AutoModelPolicy;
  by: "auto" | "user" | "manual";
  switched?: true;
  from?: string | null;
};

/** §43.4: how many messages auto sent to a family in this chat since the engine opened it (`hud.autoModelCounts`). */
export type AutoModelCount = { family: string; count: number };

// ---------------------------------------------------------------- MARK: wave5 w5-brain — §43.2 the sub-brain

/**
 * §43.2: what kind of memory a file is — its frontmatter `type` (top level or under `metadata:`), else the file name's
 * prefix (`feedback_x.md`, `project-y.md`), else `other`.
 */
export const BRAIN_MEMORY_TYPES = ["user", "feedback", "project", "reference", "other"] as const;
export type BrainMemoryType = (typeof BRAIN_MEMORY_TYPES)[number];

/** §43.2: one auto-memory file (`<memory dir>/<name>.md`; MEMORY.md is the index, not a memory). */
export type BrainMemory = {
  /** The file name without `.md` — what [[links]] and MEMORY.md name. */
  name: string;
  /** The frontmatter `name` when it has one. */
  title?: string;
  type: BrainMemoryType;
  /** The frontmatter `description` (≤ 300 chars; "" when none). */
  description: string;
  /** epoch ms */
  mtime: number;
  size: number;
  /** MEMORY.md links it. */
  indexed: boolean;
  /** The memories its [[links]] reach (their names, ≤ 50; case, `-` and `_` do not matter). */
  links: string[];
  /** Touched during this session: `add` when it is new this session (changed after or not), else `change`. */
  session?: "add" | "change";
};

export type BrainChangeKind = "add" | "change" | "remove";

/**
 * §43.2: who wrote a memory — Claude (`main`), one of its subagents (`agent` + `agentType`), or something the engine did
 * not see write it (`external`: a shell command, an editor, another Claude session, the CLI's own background memory work).
 */
export type BrainWriter = "main" | "agent" | "external";

/** §43.2: a memory added, changed or removed during this session. */
export type BrainChange = {
  /** epoch ms the engine saw it */
  at: number;
  kind: BrainChangeKind;
  name: string;
  title?: string;
  type: BrainMemoryType;
  description: string;
  by: BrainWriter;
  /** `by: "agent"`: its `subagent_type`. */
  agentType?: string;
};

/** §43.2: reply to `brain`, and — while a client watches — the folder after each change. */
export type BrainEvent = {
  type: "brain";
  id?: string;
  /** The auto-memory folder (absolute); null without a project. */
  dir: string | null;
  /** How it was found: the CLI's loaded MEMORY.md, `autoMemoryDirectory` of the user's settings, or the CLI's own rule. */
  dirSource?: "cli" | "settings" | "default";
  /** The folder exists (it may still hold no memory). */
  exists: boolean;
  /** Newest first, ≤ 2 000. */
  memories: BrainMemory[];
  counts: Record<BrainMemoryType, number>;
  /** MEMORY.md exists. */
  hasIndex: boolean;
  /** Memories MEMORY.md does not link (empty without an index). */
  unindexed: string[];
  /** Names MEMORY.md links whose file is not there. */
  missing: string[];
  /** [[links]] that reach no memory. */
  brokenLinks: { from: string; to: string }[];
  /** This session's changes, newest first (≤ 100). */
  changes: BrainChange[];
  /** Every change of this session (`changes` may be cut). */
  tally: { add: number; change: number; remove: number };
  /** Distinct memories added or changed this session and still there — "이번 세션에 쌓인 것". */
  sessionCount: number;
  /** epoch ms of the first scan (the baseline) and of the latest one; null before the first. */
  baselineAt: number | null;
  scannedAt: number | null;
  /** More than 2 000 memory files: the rest are not listed. */
  truncated?: true;
  /** The folder could not be read (it exists). */
  error?: string;
  /** A client watches (`brain {watch: true}`): the engine re-reads the folder every 4 s and sends each change. */
  watching?: boolean;
};

/** §43.2: reply to `brain_read` — one memory's text (≤ 64 KiB), only read. */
export type BrainMemoryEvent = {
  type: "brain_memory";
  id?: string;
  name: string;
  /** Absolute. */
  path: string;
  text: string;
  truncated?: true;
};

// ---------------------------------------------------------------- MARK: wave5 w5-graph — §43.3 the code graph and mods

/** §43.3: a node of the graph with its number of edges ("God Nodes" of the report: the most connected). */
export type CodeGraphNode = { name: string; edges: number };
/** §43.3: an edge the report calls surprising (`from --relation--> to`); the files are repo-relative as the report wrote them. */
export type CodeGraphLink = { from: string; relation: string; to: string; confidence: string; fromFile: string | null; toFile: string | null };
/** §43.3: a community of the report (`### Community <id> - "<name>"`), largest first. */
export type CodeGraphCommunity = { id: number; name: string; nodes: number; cohesion: number | null };
/** §43.3: what `GRAPH_REPORT.md` says (graphify's report; graph.json is never read). Every list is capped, names ≤ 160 chars. */
export type CodeGraphReport = {
  /** `# Graph Report - <name>  (<date>)`. */
  name: string | null;
  date: string | null;
  /** Corpus check: source files and words read. */
  files: number | null;
  words: number | null;
  nodes: number;
  edges: number;
  communities: number;
  /** Extraction: edges found in the code / inferred / ambiguous (percent). */
  extractedPct: number | null;
  inferredPct: number | null;
  ambiguousPct: number | null;
  /** "Built from commit" (short sha), null when the report has none (no git). */
  commit: string | null;
  /** "Community Hubs (Navigation)": the first 20 distinct names; `hubCount` counts every entry. */
  hubs: string[];
  hubCount: number;
  /** The most connected nodes, ≤ 15. */
  gods: CodeGraphNode[];
  /** ≤ 10. */
  surprises: CodeGraphLink[];
  /** The largest communities, ≤ 15. */
  bigCommunities: CodeGraphCommunity[];
  /** Knowledge gaps: nodes with ≤ 1 connection, null when the report does not say. */
  isolated: number | null;
};
/** §43.3: the last `graphify update .` (this engine, this project). */
export type CodeGraphBuild = {
  running: boolean;
  /** ISO-8601 */
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  exitCode?: number | null;
  /** Stopped after 10 minutes. */
  timedOut?: true;
  /** graphify's latest line while it runs, its result line once it ended (`[graphify watch]` removed, ≤ 200 chars). */
  line?: string;
};
/** §43.3: reply to `code_graph` / `code_graph_build`, also emitted while a build runs and when it ends. */
export type CodeGraphEvent = {
  type: "code_graph";
  id?: string;
  /** The project root: where a build runs and its `graphify-out/` goes. */
  root: string;
  /** The report shown (absolute); null when neither this worktree nor the main worktree has one. */
  reportPath: string | null;
  /** The report is the main worktree's (this linked worktree has none of its own). */
  shared?: true;
  /** The report file's modification time (ISO-8601). */
  builtAt: string | null;
  report: CodeGraphReport | null;
  /** The report exists but could not be read (`unreadable`) or is over 8 MiB (`too_large`). */
  reportError?: "unreadable" | "too_large";
  /** HEAD of the project (short sha); null outside git / without a commit. */
  head: string | null;
  /** Commits HEAD has that the report's commit has not (`git rev-list --count <commit>..HEAD`); null when unknown. */
  behind: number | null;
  /** graph.html beside the report, when it exists (the client opens it in the default browser). */
  htmlPath: string | null;
  /** The graphify program found (`~/.local/bin/graphify`, else PATH); null: not installed. */
  graphify: string | null;
  /** `graphify-out/` is ignored by git in the project (a build never lands in a review); null outside git. */
  outIgnored: boolean | null;
  build: CodeGraphBuild | null;
};
/** §43.3: a Claude Code mod of the user (a plugin folder with `.claude-plugin/plugin.json`), read only. */
export type UserMod = {
  name: string;
  description: string;
  version?: string;
  /** The mod's folder (absolute). */
  path: string;
  /** `dev`: `<config>/dev-mods/<session id>/<name>` (loaded only by the session that made it); `plugin_dirs`: named in `CLAUDE_CODE_PLUGIN_DIRS`. */
  source: "dev" | "plugin_dirs";
  /** The session that made a `dev` mod. */
  sessionId?: string;
  /** The running session reported it among its plugins. */
  loaded: boolean;
  /** It has a hooks file (`hooks/hooks.json`: hook modules or hooks). */
  hasHooks: boolean;
};

// ---------------------------------------------------------------- MARK: wave6 w6-statusline — §44.2 the user's status line

/** §44.2: the settings file the `statusLine` that runs comes from (`user` = `<config>/settings.json`). */
export type StatusLineSource = "user" | "project" | "local" | "managed";

/**
 * §44.2: the last run failed — `timeout` (stopped after the limit), `exit` (a non-zero exit; `exitCode`), `spawn` (the
 * shell did not start). `message`: the first line of its stderr, else the reason; `at`: ISO-8601. The lines stay the
 * last good run's.
 */
export type StatusLineError = { code: "timeout" | "exit" | "spawn"; message: string; at: string; exitCode?: number | null };

/**
 * §44.2: a `statusLine` the project's own settings define: where, the command, its sha256 (what the user allows, per
 * project: `settings.allowedProjectStatusLine`), and whether it runs.
 */
export type StatusLineProject = { path: string; command: string; sha256: string; allowed: boolean };

/**
 * §44.2: what the user's Claude Code status line shows — the reply to `status_line`, and sent (no id) whenever it
 * changes. `lines`: the command's output as printed (ANSI escapes and OSC 8 links kept; the clients draw them), [] when
 * nothing runs or it printed nothing. `updatedAt`: when the engine got these lines (null before the first run).
 */
export type StatusLineEvent = {
  type: "status_line";
  id?: string;
  lines: string[];
  updatedAt: string | null;
  /** `settings.showStatusLine` is not false. */
  enabled: boolean;
  /** A `statusLine` command is configured and allowed (it runs while a project is open and the line is on screen). */
  configured: boolean;
  /** Where it comes from: the settings file's kind and path, and the command as configured (absent when not configured). */
  source?: StatusLineSource;
  path?: string;
  command?: string;
  /** `statusLine.padding`: blank columns on each side (0–20; default 0). */
  padding?: number;
  /** The last run failed (absent after a good one). */
  error?: StatusLineError;
  /** The project's settings define a `statusLine` (absent when they do not). */
  project?: StatusLineProject;
  /**
   * Why nothing runs: `disable_all_hooks` — a settings file (or "my hooks off") says `disableAllHooks: true`; `managed_policy`
   * — the organization's managed settings cannot be read (fail closed) or allow only their own status line.
   */
  disabled?: "disable_all_hooks" | "managed_policy";
};

// ---------------------------------------------------------------- MARK: code-browser — §47 browsing the project
// Types only (docs/PROTOCOL.md §47).

/**
 * §47: reply to `project_file` — the worktree file split into lines (`\r?\n`, the last empty one dropped). `lines` is
 * empty when `isBinary`; `truncated` when only its first 2 MB / 20 000 lines are sent. `size`: the file's bytes.
 */
export type ProjectFileEvent = { type: "project_file"; id?: string; path: string; lines: string[]; isBinary: boolean; truncated: boolean; size: number };

/** §47: one matching line — repo-relative path, 1-based line, its text (≤ 400 characters around the first match, "…" where cut). */
export type ProjectSearchMatch = { path: string; line: number; text: string };

/**
 * §47: reply to `project_search` — the matches in git's order (file by file, line by line). `truncated`: there were more
 * than `limit`; `timedOut`: git was stopped after 20 s (the matches are what it found until then).
 */
export type ProjectSearchEvent = { type: "project_search"; id?: string; query: string; matches: ProjectSearchMatch[]; truncated: boolean; timedOut?: true };
