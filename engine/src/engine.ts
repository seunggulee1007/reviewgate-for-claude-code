import { createHash, randomUUID } from "node:crypto";
import { FileIndex, LIST_FILES_MAX, mentionToken } from "./files/fileIndex.js";
import { loadAttachment, prepareAttachments, storeAttachments, type PreparedImage } from "./session/attachments.js";
import { STATIC_MODELS, toModelOptions, validateEffort, validateModel } from "./session/models.js";
import {
  checkpointRefs,
  checkpointViews,
  filesPlan,
  indexOfTurn,
  loadCheckpoints,
  newRecord,
  referencedRecordIds,
  removeCheckpoints,
  renameCheckpoints,
  saveCheckpoints,
  type CheckpointFile,
  type CheckpointRecord,
  type ForkPoint,
} from "./review/checkpoints.js";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { branches as listBranches, createBranch, isWorktreeDirty, switchBranch } from "./git/branches.js";
import { initRepository, LfsMissingError, openCheckpoint, type GitCheckpoint } from "./git/checkpoint.js";
import { commit as gitCommit, gitIdentity, push as gitPush, stagePaths } from "./git/commit.js";
import { CommandRefused, refusalFields } from "./errors.js";
import { NotARepositoryError, setGitPath } from "./git/exec.js";
import { findGitCandidates, looksUnsafeForGitInit } from "./git/repo.js";
import {
  addWorktree,
  branchExists,
  canonicalPath,
  commonDir,
  gitDir as resolveGitDir,
  isValidBranchName,
  linkedGitDir,
  listWorktrees,
  managedWorktreeRoot,
  pruneWorktrees,
  removeWorktree,
  slugify,
  worktreeDirty,
  type GitWorktree,
} from "./git/worktrees.js";
import { createPlatform, type Platform } from "./platform/index.js";
import { DirtyScanner } from "./git/dirtyScan.js"; // MARK: wave4 w4-install (daily-08)
import { CodeGraph, findGraphify } from "./board/codeGraph.js"; // MARK: wave5 w5-graph (§43.3)
import { listUserMods, settingsPluginDirs } from "./board/mods.js"; // MARK: wave5 w5-graph (§43.3)
import { locateToolchain, type Toolchain } from "./platform/toolchain.js";
import { createPR, parseRemoteURL } from "./pr/create.js";
import { PRStore, type ResolvedGH } from "./pr/store.js";
import type {
  ActivityKind,
  AttachmentEvent,
  AttachmentRef,
  EffortLevel,
  FilesEvent,
  ModelOption,
  RewindMode,
  RewoundEvent,
  HeadInfo,
  HeadMove,
  LocalSettingsChange,
  NestedChange,
  SendAttachment,
  Budget,
  BudgetUsage,
  CommittedEvent,
  EngineCommand,
  EngineEvent,
  ErrorDetails,
  ErrorScope,
  FileDiffEvent,
  HistoryDiffEvent,
  ReviewHistoryEntry,
  ReviewHistoryEvent,
  AgentNode,
  FullFileContentEvent,
  HudState,
  ToolOutputEvent,
  ExtensionPlugin,
  MemoryFile,
  SessionExtensions,
  LogLevel,
  McpAddConfig,
  McpScope,
  McpServerInfo,
  McpStatusEvent,
  PermissionMode,
  PermissionRequest,
  PermissionRulesEvent,
  SideAnchor,
  PRCreatedEvent,
  ReadyEvent,
  RefreshScope,
  ReplyEvent,
  ReplyFor,
  ReviewState,
  SessionMeta,
  Settings,
  ToolchainState,
  TranscriptItem,
  TurnUsage,
  WorkbenchInfo,
  ExternalTurn,
  PeerInboundMode,
  PeerMessage,
  // MARK: wave4d w4d-plan (§42.1)
  PendingPlan,
  PlanInto,
  PlanSourceState,
  PlanVsActual,
} from "./protocol.js";
import { isPeerInboundMode, isPermissionMode, MAX_PLAN_BYTES, PLAN_INTO, PROTOCOL_VERSION } from "./protocol.js";
import { ReviewGate, errorMessage, truncateDiff } from "./review/gate.js";
import { rangeRefPrefix, sinceOf, withReviewTotals, withTurnCounts } from "./review/ranges.js"; // wave2 engine-review
import { appendCapped, completeRound, entryTreeRefs, historyView, loadHistory, saveHistory } from "./review/history.js";
import { parseUnifiedDiff } from "./diff/parse.js";
import { withFileMeta } from "./diff/fileMeta.js"; // MARK: wave4b w4b-files
import { buildTurnSummary, parsePlanSteps, type PlanStep, type ToolCallInfo } from "./review/summary.js";
import { acquireLock, isPidAlive, readLock, releaseLock, type LockOwner } from "./review/lock.js";
import { findConcurrentClaude } from "./review/concurrent.js";
import { isModsPath, LOCAL_SETTINGS, localSettingsChange, localSettingsDigest, type LocalSettingsDigest } from "./git/mods.js";
import { nestedChanges, worktreeHeads } from "./review/nested.js";
import { clearReview, loadCapabilities, loadReview, loadSessionState, refNamespace, refPrefix, saveCapabilities, saveReview, saveSession, siblingWorktreeMode, staleWorktreeNamespaces, type PersistedReview } from "./review/persist.js";
import { NEW_CHAT_TITLE, SessionIndex, sessionTitle } from "./review/sessions.js";
import { TRANSCRIPT_RESTORE_ROWS, type TranscriptStore } from "./review/transcript.js";
// MARK: wave4 w4-history — §38.3
import { historyWhy, readTranscriptRows, readTranscriptWindow, searchTranscriptFile, summaryRow, TRANSCRIPT_PAGE_MAX, TRANSCRIPT_PAGE_ROWS, TRANSCRIPT_SEARCH_HITS, TRANSCRIPT_SEARCH_MAX_QUERY } from "./review/transcriptHistory.js";
import { ClaudeSession, claudeLaunchProblem, type ClaudeSessionLike, type ClaudeSessionOptions } from "./session/claude.js";
import { codeOfErrorText } from "./session/apiErrors.js";
import { cliSessionExists, cliSessionFile, codeOfStartFailure, START_FAILURE_MESSAGES, type StartFailureCode } from "./session/cliRecords.js";
import { rememberKey } from "./session/bashClass.js";
import { isExploreCall, markExplore } from "./session/explore.js"; // MARK: wave4b w4b-tabs (§39.2)
import { autoAllowReason, EDIT_TOOLS_MATCHER } from "./session/hooks.js";
import { scopeNoticeMessage } from "./session/reviewScope.js";
import { classifyRules, loadPermissionRules, rememberable, sessionUserRules, type LoadedRules, type UserRules } from "./session/permissionRules.js";
import { clearRememberedAllows, loadRememberedAllows, saveRememberedAllows } from "./session/allowsStore.js";
import type { SessionEvent, ToolFileEntry } from "./session/events.js";
import { originOf, type ToolWindow } from "./session/provenance.js";
import { ToolOutputStore } from "./session/toolOutput.js";
import { AgentTracker, STOP_AGENT_TIMEOUT_MS } from "./session/agents.js";
import { repoRelativeInside, samePath, toRepoRelative } from "./platform/paths.js";
import { exec } from "./util/exec.js";
import { anchorLineText, buildSidePrompt, PROMOTE_PROVENANCE, summarizeInput, type AnchorData } from "./side/context.js";
import type { SideQueryOptions } from "./side/sideQuery.js";
import { SideThreads, type ForkSource, type SideQueryLike } from "./side/threads.js";
import { loadMcpPrefs, mcpAddArgs, mcpRemoveArgs, sdkMcpConfig, toServerInfo, validateMcpConfig, validateMcpName, validateMcpScope, validateServerRef, type RawMcpStatus } from "./mcp/mcp.js";
import { resolveClaudeExecutable } from "./session/claude.js";
import { claudeConfigDir, claudeMdStatus, discoverHooks, pluginIdFromPath, pluginList, resolveDisabledPlugins } from "./session/extensions.js";
import { acceptedPaths, blockedReason, buildState, canRequestChanges, canSend, gatePhase, switchBlocker, type EngineSlices } from "./state.js";
import type { RejectAllResultEvent, RewoundKeptEvent } from "./protocol.js"; // MARK: wave2 check-engine (§35.2, §35.11)
import type { TranscriptPageEvent, TranscriptRestoreEvent, TranscriptSearchEvent, TranscriptSearchMatch } from "./protocol.js"; // MARK: wave4 w4-history (§38.3)
import { errorRow } from "./review/errorRow.js"; // MARK: wave2 check-engine (§35.3)
// MARK: wave4c w4c-trust (§41.2)
import type { AutoAcceptedFile, AutoAcceptRule, AutoAcceptRules } from "./protocol.js";
import { anyAutoAcceptRule, normalizeAutoAcceptRules, planAutoAccept } from "./review/trust.js";
import { loadAutoAcceptRules, saveAutoAcceptRules } from "./review/trustStore.js";
import { lastTestOf } from "./review/tests.js";

import { ENGINE_VERSION } from "./version.js";
// MARK: wave2 engine-why
import type { FileWhy, LiveChangesEvent } from "./protocol.js";
import type { ChangedFile } from "./git/checkpoint.js";
import type { AnnotateArgs } from "./review/gate.js";
import type { TurnDelta } from "./review/turnDelta.js"; // MARK: wave3 check-engine (§37.3)
import { annotateDetail } from "./review/detail.js";
// MARK: wave4c w4c-review — §41.3 review leftovers
import { readFile } from "node:fs/promises";
import type { FileImageEvent, FileLinesEvent } from "./protocol.js";
import { fileLinesOf, historyFileLines, ignoreWhitespacePatch, imageMediaType, imageSide, perChatOf, prHeadContent, searchTranscriptMany } from "./review/reviewLeftovers.js";
import { liveChangesEvent, liveFileList, liveKey, LiveView } from "./review/live.js";
import { fileWhy, isFileWhy } from "./review/why.js";
// MARK: wave3 engine-agents
import { agentReportFromRows, reportRowFields, withoutReports } from "./session/agentReport.js";
import type { AgentReportEvent } from "./protocol.js";
// MARK: wave3 engine-session
import { toCommandInfos } from "./session/commands.js";
import { localHookSources, notAppliedLocalSettings } from "./session/localSettings.js";
import { settingSourcesOf } from "./session/extensions.js";
import { initStallLimit, loadStartHistory, noteStartDuration, saveStartHistory, WaitingOn } from "./session/startWatch.js";
import { cliInfo, defaultCliVersionsDir, listCliVersions, noteCliVersion, parseCliVersion, verifiedCliVersions } from "./session/cliVersion.js";
import type { CliSessionsEvent, CliVersionsEvent } from "./protocol.js";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { registryHasSession, resumableCliSessions, runningCliSessions, type ListSessionsFn } from "./review/cliSessions.js";
import { peerAtAddress, selfPeer } from "./review/cliSessions.js"; // MARK: wave4d w4d-peers
// MARK: wave3 engine-flow
import { RUNNING_TURN_ROWS, runningTurnBlock, runningTurnFromRows } from "./side/runningTurn.js";
import { normalizeSideAnchor } from "./side/context.js";
// MARK: wave4b w4b-side — §40.3
import { deleteSession as sdkDeleteSession, renameSession as sdkRenameSession } from "@anthropic-ai/claude-agent-sdk";
import { sideWebMode, sideWebRuleAllows } from "./side/sideQuery.js";
import { copySideThreads } from "./side/threads.js";
import type { CommitDraftEvent, PRAiDraftEvent, WorkbenchPreviewEvent, WorkbenchSetup, WorkbenchStep } from "./protocol.js";
import type { CommitHunksEvent, CommitSplitDraftEvent, CommittedSeriesEvent, HistoryCommit, SeriesCommit } from "./protocol.js"; // §53
import { COMMIT_SPLIT_LINES, COMMIT_SPLIT_SYSTEM, commitSplitPrompt, hunkLines, parseCommitSplit, validateSplit } from "./review/commitSplit.js";
import { headHunks, splitContent, type HeadFile } from "./git/commitHunks.js"; // §53
import { commitOnHead, indexToHead, SeriesCommitError, worktreeBlob, writeBlob, type SeriesBlob } from "./git/series.js";
import type { AutoTurnInfo, BackgroundTask, TaskBackgroundEvent, TaskOutputEvent } from "./protocol.js"; // §52
import { autoTurnPrompt, readTail } from "./session/background.js";
import { cutPatch, findPRTemplate, parsePRAiDraft, PR_AI_DIFF_LINES, PR_AI_DRAFT_SYSTEM, prAiDraftPrompt } from "./review/prAiDraft.js";
import { isAbsolute } from "node:path";
import { PreReviewRunner } from "./review/prereview.js";
import { copyFiles, copyLog, copyPatternsFor, fetchRef, filesToCopy, firstLogLine, matchingFiles, PREVIEW_MAX_ENTRIES, refExists, remoteNames, runSetupCommand, siblingPath, splitRemoteRef } from "./git/workbenchSetup.js";
import { remoteBranches } from "./git/branches.js";
import { runGit } from "./git/exec.js";
import { readProjectFile, searchProject } from "./files/browse.js"; // MARK: code-browser (§47)
import { cleanCommitDraft, COMMIT_DRAFT_DIFF_LINES, COMMIT_DRAFT_SUBJECTS, COMMIT_DRAFT_SYSTEM, commitDraftPrompt, renderCommitTemplate } from "./review/commitDraft.js";
import { roundPatch } from "./review/roundPatch.js";
// MARK: wave4 w4-longwork
import type { RateLimitWindow } from "./protocol.js";
import type { HudActivity } from "./protocol.js"; // MARK: wave7 w7-state (§45.2)
import { budgetChangeNote, budgetNumbers, isLongWorkNotice, rateLimitChanges, upsertRateLimit, type BudgetNumbers } from "./session/longWork.js";
// MARK: wave4b w4b-bigturn
import type { DiskSpace, HistoryCleanupEvent, SaveWhat } from "./protocol.js";
import { diskChanged, readDiskSpace, SaveHealth } from "./review/storage.js";
import { largeFileBytes, setLargeFileLimit } from "./git/largeFiles.js";
import { applyCleanup, cleanupKeep, planCleanup } from "./review/cleanup.js";
// MARK: wave4b w4b-follow — §39.4
import { dropIncoming, moveRefusal, moveTarget, readIncoming, waitForExit, writeHandoff, type ChatHandoff } from "./review/chatMove.js";
// MARK: wave4d w4d-plan — §42.1
import { applyTaskTool, displayPlanPath, messageSteps, planCandidates, planFilesNamed, planStepBriefs, planView, readPlanFile, requestScope, resolvePlanPath, todoWriteSteps, type TaskItem } from "./review/planSources.js";
import { implementPlanText, takePlanHandoff, writePlanHandoff, type PlanHandoff } from "./review/planHandoff.js";
import { takeTaskHandoff, taskText, writeTaskHandoff, type TaskHandoff } from "./review/taskHandoff.js";
import { sessionTranscriptPath } from "./review/sessions.js";
import { turnRefs } from "./review/persist.js";
import type { ChatMoveBaseline } from "./protocol.js";
import { autoModeUnavailableNotice, isAutoModeNotice } from "./session/autoMode.js"; // MARK: wave4b w4b-auto (§39.5); notice: wave6 w6-terminal (§44.1)
// MARK: wave4c w4c-commit — §41.1
import type { CommitFormatEvent, GHReadiness, PRCreateMeta, PRDraftEvent } from "./protocol.js";
import { branchIssue, COMMIT_FORMAT_SUBJECTS, learnCommitFormat, PR_DRAFT_COMMITS, prDraftFrom, type LearnedCommitFormat } from "./review/commitFormat.js";
import { prMetaValues } from "./pr/create.js";
import { addModelCosts } from "./session/modelCost.js"; // MARK: wave4d w4d-agents2 (§42.4)
import { agentHistoryFromRows } from "./session/agentHistoryRows.js"; // MARK: wave4d w4d-agents2 (§42.4)
import type { ModelCost } from "./protocol.js"; // MARK: wave4d w4d-agents2 (§42.4)
// MARK: wave4d w4d-config — §42.3
import { McpFileIndex, mcpOriginOf } from "./mcp/mcpOrigin.js";
import { applyMcpToggle, loadRepoToggles, loadWorktreeToggles, mcpOffBy, mcpOffNames, repoTogglesStamp, saveRepoToggle, saveWorktreeToggles, type McpToggles } from "./mcp/mcpScopes.js";
import { claudeJsonPath } from "./session/localSettings.js";
import { describeMemoryFile, instructionTarget, projectInstructionFiles, readInstruction, subagentList, writeInstruction } from "./instructions/claudeMd.js";
import type { ClaudeMdEvent, McpToggleScope, SubagentInfo } from "./protocol.js";
// MARK: wave5 w5-model — §43.4 auto model
import { autoModelPolicy, decideAutoModel, modelFamily, pickFamilyModel, type AutoModelInput } from "./session/autoModel.js";
import type { AutoModelChoice, AutoModelCount, ModelFamily } from "./protocol.js";
// MARK: wave5 w5-brain — §43.2
import { autoMemoryDir, SubBrain, type BrainCaller } from "./brain/subBrain.js";
import type { BrainEvent, BrainMemoryEvent } from "./protocol.js";
// MARK: wave6 w6-statusline — §44.2
import { StatusLine } from "./statusline/runner.js";
import { resolveStatusLine, type StatusLineResolution } from "./statusline/settings.js";
import { readManagedPolicy, type ManagedPolicy } from "./statusline/managed.js";
import { ContextWindows } from "./statusline/contextWindows.js";
import { gitWorktreeName, lastTranscriptUsage, modelDisplayName, modelTakesEffort, repoOfRemote, type StatusLineSnapshot } from "./statusline/input.js";
export { ENGINE_VERSION };
export { CommandRefused } from "./errors.js";

export type EngineOptions = {
  /** default createPlatform(process.platform) */
  platform?: Platform;
  /** Base env for every child process (PATH from the client); `hello.env` is merged over it. */
  env?: Record<string, string>;
  log?: (level: LogLevel, msg: string) => void;
  /** Test seam (FakeClaudeSession). */
  sessionFactory?: (opts: ClaudeSessionOptions) => ClaudeSessionLike;
  /** Test seam for `hud.turnStartedAt`. */
  now?: () => number;
  /** Identity written into `reviewgate.lock` (default `process.pid` / `os.hostname()`). */
  lockOwner?: Partial<Pick<LockOwner, "pid" | "host">>;
  /** Backoff before the automatic session restart (default 2000 ms; test seam). */
  autoRestartDelayMs?: number;
  /** Test seam: stands in for a side-question CLI process (§21). */
  sideQueryFactory?: (opts: SideQueryOptions) => SideQueryLike;
  /** MCP status poll interval while a session is alive (default 10 000 ms; 0 = off; §22). */
  mcpPollMs?: number;
  /** Test seam: runs `claude <args>` (mcp add / remove) instead of the real CLI. */
  runClaude?: (args: string[], cwd: string) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  /** How long `interrupt` waits for the turn to end and its changes to be collected before it replies (default 15 000 ms; §28). */
  interruptWaitMs?: number;
  // MARK: wave3 engine-session
  /** §36.7: how long the session stays idle after an extensions fallback before the engine retries once (default 5000 ms; 0 = never; test seam). */
  extensionsAutoRetryMs?: number;
  /** §36.8: the app-wide data folder (`cli-versions.json`); default `REVIEWGATE_DATA_DIR`, else `~/.reviewgate` (§20). */
  dataDir?: string;
  /** §36.8: the native installer's versions folder (default `~/.local/share/claude/versions`; test seam). */
  cliVersionsDir?: string;
  /** §36.9: stands in for the SDK's `listSessions` (test seam). */
  listCliSessions?: ListSessionsFn;
  // MARK: wave4b w4b-side
  /** §40.3: stand in for the SDK's `deleteSession` / `renameSession` of side sessions (test seam). */
  sideSessionFiles?: { delete(sessionId: string, dir: string): Promise<void>; rename(sessionId: string, title: string, dir: string): Promise<void> };
  // MARK: wave5 w5-graph
  /** §43.3: the graphify program (null: not installed); default `~/.local/bin/graphify`, else PATH (test seam). */
  graphifyPath?: string | null;
  /** §43.3: limit of a `code_graph_build` run (default 10 minutes; test seam). */
  graphBuildTimeoutMs?: number;
  // MARK: wave6 w6-statusline
  /** §44.2: the managed settings tier (default: read from this machine's managed sources; test seam). */
  managedPolicy?: () => ManagedPolicy;
  /** §44.2: the status line's debounce, refresh and limit (test seam); wave7 (§45.2): its least interval between runs. */
  statusLineTiming?: { debounceMs?: number; maxWaitMs?: number; recheckMs?: number; timeoutMs?: number; minIntervalMs?: number };
};

/** Default of `EngineOptions.interruptWaitMs`. */
export const INTERRUPT_WAIT_MS = 15_000;
/** §31: a restored review saved longer ago than this is stale (`state.gate.stale.reasons` "old"). */
export const STALE_REVIEW_MS = 12 * 60 * 60 * 1000;
/** `context_warning` threshold (§27). */
export const CONTEXT_WARNING_PERCENT = 80;
/** At most this many `send.mentions` (§23). */
export const MAX_MENTIONS = 20;
/** Longest `compact.focus` (§27). */
export const MAX_COMPACT_FOCUS = 2000;
/** Suffix of the chat a conversation rewind left behind (§26). */
export const REWOUND_TITLE_SUFFIX = " (되돌리기 전)";

/** What `send` takes besides the text (§23, §24, §27). */
type SendOptions = { mentions?: { path: string; kind: "file" | "dir" }[]; images?: PreparedImage[]; command?: boolean; /** MARK: wave5 w5-model — §43.4: this message's own model (null = the CLI's default). */ model?: string | null };
/** What a turn handed to the session (kept for the init-timeout resend, §16). */
type TurnMessage = { text: string; checkpointTree: string | undefined; images?: { mediaType: SendAttachment["mediaType"]; dataBase64: string }[] };

export const MCP_POLL_MS = 10_000;
const MCP_CALL_TIMEOUT_MS = 8000;
// MARK: wave4d w4d-config — §42.3: after `mcp_auth` the polls reconnect a server still needing a login, this long, this far apart.
export const MCP_AUTH_WAIT_MS = 10 * 60_000;
export const MCP_AUTH_RETRY_MS = 20_000;

export const AUTO_RESTART_DELAY_MS = 2000;
/** `settings.extensionsInitTimeoutMs` default (§16); §36.7: the floor of the stall limit. */
export const EXTENSIONS_INIT_TIMEOUT_MS = 20_000;
/** MARK: wave3 engine-session — §36.7: idle time after an extensions fallback before the one automatic retry. */
export const EXTENSIONS_AUTO_RETRY_MS = 5000;
/** MARK: wave3 engine-session — §36.9: a CLI conversation id as `cli_session_import` takes it (the CLI's are uuids). */
const CLI_SESSION_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
/** Banner (scope session) when Claude Code tried to act without a request and the guard blocked it (§18). */
export const UNPROMPTED_NOTICE = "Claude가 요청 없이 작업을 시도해 차단했습니다. (Claude Code continued on its own without a request; its changes were blocked and nothing was modified.)";
// MARK: wave4d w4d-peers — §42.2: the session's `--name` (the CLI keeps 64 code points of a peer name) and the least of the
// chat's title worth adding after `ReviewGate · <project>`.
const PEER_NAME_MAX = 64;
const PEER_NAME_TOPIC_MIN = 8;

export const DEFAULT_SETTINGS: Settings = {
  // §54: no change budget unless the client sends one (0 = no limit on that count).
  budget: { maxFiles: 0, maxLines: 0, hardMultiplier: 2.0 },
  ignorePatterns: [],
  autoAllowTools: [],
  loadUserSettings: true,
  systemPromptAppend: "",
  ghHost: "github.com",
  commitPushByDefault: false,
  commitTrailer: "",
  autoAllowReadOnlyBash: true,
  bashAllowPatterns: [],
};

const ZERO_USAGE: BudgetUsage = { files: 0, lines: 0, denied: false };

/** Edit tools never get a queued request answered for them (§33): they only reach a card for a path outside the review. */
const EDIT_TOOL_NAME_RE = new RegExp(`^(${EDIT_TOOLS_MATCHER})$`);

function initialHud(): HudState {
  return {
    contextTokens: 0,
    contextWindow: null,
    sessionCostUSD: 0,
    turnCount: 0,
    lastTurnMs: 0,
    activity: { kind: "idle" },
    subagentDepth: 0,
    agents: [],
    turnStartedAt: null,
    sideCostUSD: 0,
    turnFiles: 0,
    waitingOnAgents: null, // MARK: wave3 engine-agents (§36.4)
  };
}

/** `task_progress` / `tool_progress` reach the snapshot at most this often (≤ 4/s); lifecycle changes go out at once. */
const AGENT_PROGRESS_MS = 250;
/**
 * MARK: wave7 w7-state — §45.2: the HUD's churn (the activity line, subagent steps, the usage windows) reaches the clients
 * in at most one snapshot per this many ms — the first at once, the rest trailing (nothing is lost). Prompts, errors,
 * the turn's end and command replies are not held.
 */
export const STATE_CHURN_GAP_MS = 100;

/** Tool calls remembered for `turn_summary.files[].why` / `commands`. */
const MAX_TOOL_CALLS = 2000;

/** The edit tools (hooks.ts `EDIT_TOOLS_MATCHER`): their `file` is what they change. */
const EDIT_TOOL_RE = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

function zeroUsage(): TurnUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0 };
}

type Pending = { resolve: (ev: ReplyEvent) => void; reject: (e: Error) => void };

/** `TranscriptItem` without the fields `record()` fills in (distributive over the union). */
type TranscriptRow = TranscriptItem extends infer T ? (T extends TranscriptItem ? Omit<T, "at" | "turn"> : never) : never;

/**
 * The single business-logic core (docs/PROTOCOL.md v2): command dispatch, session lifecycle,
 * review gate, HUD accounting, branches, PR browsing. State is derived by `buildState` and emitted
 * as one coalesced `state` snapshot per macrotask; commands with an `id` get exactly one reply.
 */
export class ReviewEngine {
  private readonly platform: Platform;
  private readonly baseEnv: Record<string, string>;
  private readonly logFn: (level: LogLevel, msg: string) => void;
  private readonly sessionFactory: (opts: ClaudeSessionOptions) => ClaudeSessionLike;
  private readonly now: () => number;

  private settings: Settings = { ...DEFAULT_SETTINGS, budget: { ...DEFAULT_SETTINGS.budget }, bashAllowPatterns: [] };
  private clientEnv: Record<string, string> = {};
  private toolchain: ToolchainState = { claude: null, gh: null, git: null, claudeVersion: null, ghVersion: null };
  private toolchainPromise: Promise<Toolchain> | null = null;
  private toolchainPath: string | null = null;

  private project: EngineSlices["project"] = null;
  // MARK: wave5 w5-brain — §43.2: the repository's auto memory (read only); a watched folder's changes go out as `brain`.
  private readonly subBrain = new SubBrain({ now: () => this.now(), onChange: (ev) => this.emit(ev) });
  private gitInit: EngineSlices["gitInit"] = null;
  private session: ClaudeSessionLike | null = null;
  private sessionState: EngineSlices["session"] = emptySession();
  /** `permission_response { remember: true }` keys (docs/M16-FRICTION.md §2); shared live with the Claude session's hooks. */
  private readonly rememberedAllows = new Set<string>();
  /** `<gitdir>/reviewgate/capabilities.json` of the open project, applied until a fresh `session_info` arrives. */
  private cachedCapabilities: EngineSlices["session"]["capabilities"] = null;
  private readonly gate = new ReviewGate();
  private readonly pr: PRStore;
  private budgetUsage: BudgetUsage = { ...ZERO_USAGE };
  private hud: HudState = initialHud();
  // MARK: wave4 w4-longwork
  /** §38.2: the subscription's usage windows (account-wide: a new chat keeps them) → `state.hud.rateLimits`. */
  private rateLimits: RateLimitWindow[] = [];
  // MARK: wave4b w4b-bigturn — §39.1
  /** Saves failing now (review, history, checkpoints, transcript) → `state.storage.saveFailed`. */
  private saveHealth = new SaveHealth();
  /** Free space of the project's volume → `state.storage.disk` (read at open, every minute, after a failed save). */
  private disk: DiskSpace | null = null;
  private diskTimer: ReturnType<typeof setInterval> | null = null;
  private diskReading = false;
  /** daily-18: the budget the client's `systemPromptAppend` was rendered with (set with it). */
  private promptBudget: BudgetNumbers | null = null;
  /** daily-18: the budget the running session's Claude was last told about (its system prompt, then each note). */
  private toldBudget: BudgetNumbers | null = null;
  private branches: EngineSlices["branches"] = { list: [], isWorktreeDirty: false };
  private lastError: string | null = null;
  /** Number of `fail` calls so far (lets a caller tell whether a step it awaited emitted an error). */
  private failCount = 0;
  private turn = 0;
  private workbenches: EngineSlices["workbenches"] = emptyWorkbenches();
  // MARK: wave4 w4-install
  /** daily-08: the workbench dirty (●) checks — four at a time, the last answer shown while a new one runs. */
  private readonly dirtyScan = new DirtyScanner();
  private lockConflict: EngineSlices["lockConflict"] = null;
  private commitSlice: EngineSlices["commit"] = emptyCommit();
  /** The worktree gitdir whose `reviewgate.lock` we hold. */
  private lockedGitDir: string | null = null;
  private readonly lockOwner: LockOwner;
  /** `git rev-parse --git-dir` of the open worktree: home of the review / session / transcript files. */
  private projectGitDir: string | null = null;
  /** Serializes the review-file writes; each write captures the gate at call time. */
  private persistChain: Promise<void> = Promise.resolve();
  private pinned: { start: string | null; end: string | null } = { start: null, end: null };
  /** `<gitdir>/reviewgate/history.json`, oldest first (docs/PROTOCOL.md §14). */
  private history: ReviewHistoryEntry[] = [];
  /** The round-tree refs last pinned by `persistReview` (skip the git calls when unchanged). */
  private pinnedRoundKey = "";
  private transcript: TranscriptStore | null = null;
  /** `<gitdir>/reviewgate/sessions/` (docs/M15-POLISH.md); null without a gitdir. */
  private sessions: SessionIndex | null = null;
  /** The session the engine runs (or starts) — `state.sessions.currentId`. */
  private currentSessionId: string | null = null;
  private openTabIds: string[] = [];
  /** Ids the CLI reported (`session_info` / `turn_end`) in this process: resumable even with 0 turns. */
  private readonly confirmedSessionIds = new Set<string>();
  /** Set by a failed resume: the next `restart_session` starts a brand-new session instead. */
  private fallbackFresh = false;
  /** Assistant text of the running turn (text_delta accumulated; stored once at turn_end). */
  private turnText = "";
  /** `turnText` was written outside any request (an unprompted turn, §18). */
  private turnTextUnprompted = false;
  /** The unprompted-turn notice was shown for the current episode (reset at its end and at the next send; §18). */
  private unpromptedNoticed = false;
  /** What the running turn handed to `sessionUser` (message + snapshot A), for the init-timeout resend (§16). */
  private turnSent: TurnMessage | null = null;
  /** The CLI produced something for the running turn (session_info, text, a tool call…): it did receive the message. */
  private turnSawOutput = false;
  /** Set by an init-timeout fallback while the turn's message never reached a working CLI: re-sent once after the restart. */
  private resendAfterRestart: TurnMessage | null = null;
  /** Bash outputs longer than the preview, for `tool_output` (bounded; this engine's lifetime only). */
  private readonly toolOutputs = new ToolOutputStore();
  /** Tool calls of the session (bounded): rationale / Bash command / outcome for `turn_summary` (§15). */
  private readonly toolCalls = new Map<string, ToolCallInfo>();
  /** Bash tool_use ids of the running turn, in order. */
  private turnCommandIds: string[] = [];
  /**
   * §31: what the running turn's own events said about its files — edit tools by their `file` (a call whose result was
   * an error dropped), Bash by the post-Bash `tool_files`. The attribution of a turn that ends without the session's
   * `turn_end` (the CLI died, `restart_session` mid-turn); otherwise the session's `toolFiles` are used.
   */
  private readonly turnFiles = new Map<string, ToolFileEntry>();
  /** Edit tool_use id → its file, for dropping a failed call from `turnFiles`. */
  private readonly turnEditCalls = new Map<string, string>();
  /** §31: HEAD / branch when the running turn started (compared after its collection → `head_moved`). */
  private turnHead: HeadInfo | null = null;
  /** §32: hashes of `.claude/settings.local.json` when the running turn started (→ `local_settings_changed`). */
  private turnLocalSettings: LocalSettingsDigest | null = null;
  /** §32: HEADs of the linked worktrees inside the project when the running turn started (→ `nested_changes`). */
  private turnNestedHeads = new Map<string, { head: string | null; branch: string | null }>();
  /** The plan approved in this session (`plan_response{approve:true}`): `turn_summary.plan` maps it to the changed files. */
  private approvedPlan: { path: string | null; plan: string } | null = null;
  /** Set when the CLI did not initialize with user settings in time: sessions of this project start without them (§16). */
  private extensionsFallback: SessionExtensions["fallback"] = null;
  /** What the current session start applied + what the CLI reported since (→ `state.session.extensions`). */
  private ext: {
    loadUser: boolean;
    /** MARK: wave3 engine-session — §36.6: `settingSources` has "local". */
    loadLocal?: boolean;
    disabledIds: string[];
    unresolved: string[];
    hooksDisabled: boolean;
    plugins: { name: string; path: string | null; version?: string }[] | null;
    memoryFiles: MemoryFile[] | null;
    mcpServers: { name: string; status: string }[] | null;
  } | null = null;
  /** Plans already proposed in the running turn (`path:<file>` / `plan:<sha1>`); dedupes ExitPlanMode vs turn_end. */
  private readonly proposedPlanKeys = new Set<string>();
  // MARK: wave4d w4d-plan — §42.1
  /** The open chat's plan sources (its first request, the plan files it named, Claude's to-do list); null until read from its rows. */
  private chatPlan: ChatPlanMemory | null = null;
  /** A plan another worktree handed here (`plan_response{into:"workbench"}`): implemented in a fresh chat once the session runs. */
  private receivedPlan: PlanHandoff | null = null;
  /** §49: a task handed to this worktree (`workbench_create {task}` in another window), sent once the session runs. */
  private receivedTask: TaskHandoff | null = null;
  /** Plan files `plan_follow` can choose from (read when the project opens and after every turn). */
  private planCandidateList: string[] = [];
  /**
   * MARK: wave6 w6-terminal — §44.1: the chat is in plan mode because Claude entered it (EnterPlanMode): the project's
   * stored mode and a new chat's mode stay the user's (`userMode`). Cleared by every mode the user or the engine sets.
   */
  private planByClaude = false;
  /**
   * The `resume` id the current session was started with and whether it produced a `session_info`; §30: whether the CLI
   * answered initialize (`ready`, which decides a resume's success) and how it refused the start (`failure`).
   */
  private sessionStart: { resume: string | null; gotInfo: boolean; ready?: boolean; failure?: StartFailureCode; failureDetail?: string } = { resume: null, gotInfo: false };
  /** §30: the chat whose `--session-id` start was refused as "already in use" and resumed once since (no second retry). */
  private inUseResumed: string | null = null;
  /** §30: the next `restart_session` resumes this id, whatever else it would pick (the in-use recovery). */
  private forceResumeId: string | null = null;
  /** §30: what the new chat of a failed resume says once it is current (`resume_not_found` / `resume_failed`). */
  private resumeNotice: { code: StartFailureCode; sessionId: string; detail?: string } | null = null;
  /**
   * MARK: wave2 check-engine — §35.4: while a chat the CLI could not resume (`resumeFailed`) is open as a record, the id
   * its fresh CLI was started with; the first turn from there makes it a new chat (`adoptRecordOnly`).
   */
  private recordOnlyNext: string | null = null;
  private autoRestartsThisTurn = 0;
  private autoRestartTimer: NodeJS.Timeout | null = null;
  private readonly autoRestartDelayMs: number;

  private seq = 0;
  private lastState: ReviewState | null = null;
  private stateTimer: NodeJS.Immediate | null = null;
  /** Subagents of the session → `hud.agents` / `hud.subagentDepth` (docs/PROTOCOL.md §13). */
  private readonly agents: AgentTracker = new AgentTracker(() => this.now(), (abs) => this.repoRelative(abs));
  private agentTimer: NodeJS.Timeout | null = null;
  private lastAgentEmit = 0;
  // MARK: wave7 w7-state — §45.2
  /** The trailing snapshot of HUD churn (`touchChurn`), and when churn last went out (Date.now ms). */
  private churnTimer: NodeJS.Timeout | null = null;
  private lastChurnAt = 0;
  /** What the agent fields of the HUD last were (`agentsChanged` touches only when they differ). */
  private agentsKey = "";
  private listeners = new Set<(ev: EngineEvent) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly lanes: Record<Lane, Promise<void>> = { main: Promise.resolve(), pr: Promise.resolve(), side: Promise.resolve(), sidectl: Promise.resolve(), mcp: Promise.resolve(), query: Promise.resolve(), live: Promise.resolve(), workbench: Promise.resolve(), search: Promise.resolve() };
  /** Side threads of the current chat (§21). */
  private readonly side: SideThreads;
  /** Chain uuid of the main session's last completed turn: where a side question forks while a turn runs (§21). */
  private lastForkPoint: { sessionId: string; uuid: string } | null = null;
  // ---- MCP (§22)
  private readonly mcpPollMs: number;
  private readonly runClaudeFn: EngineOptions["runClaude"];
  private mcpTimer: NodeJS.Timeout | null = null;
  private mcpPolling: Promise<McpStatusEvent | null> | null = null;
  private mcpLast: McpServerInfo[] = [];
  private mcpLastJson = "";
  /** `mcp_toggle {enabled:false}` names of this project (`<gitdir>/reviewgate/mcp.json`), re-applied at every session start. */
  private readonly mcpDisabled = new Set<string>();
  /** `mcp_add {scope:"session"}` servers of the open project, re-applied when a new session starts. */
  private readonly mcpSessionServers = new Map<string, McpAddConfig>();
  /** A project / user server was added or removed since the session started: it applies at the next session start. */
  private mcpRestartRequired = false;
  private readonly mcpAuthNotified = new Set<string>();
  /** The persisted toggles / session servers were applied to the running session. */
  private mcpApplied = false;
  // MARK: wave4d w4d-config — §42.3
  /** This worktree's choices (`worktreeOff` is `mcpDisabled`) and the repository's (every worktree). */
  private readonly mcpToggles: McpToggles = { worktreeOff: this.mcpDisabled, worktreeOn: new Set(), repoOff: new Set() };
  /** The repository file's stamp when it was last read: a poll re-reads it when it changed. */
  private mcpRepoStamp: string | null = null;
  /** `mcp_auth` names → until when the polls reconnect them while they still need a login, and their last try. */
  private readonly mcpAuthWaiting = new Map<string, { until: number; lastTry: number }>();
  private readonly mcpFiles = new McpFileIndex();
  /** `initializationResult().agents` of the running session, with their files. */
  private cliAgents: SubagentInfo[] | null = null;
  private disposing: Promise<void> | null = null;
  private closed = false;
  // ---- §23–28
  private readonly interruptWaitMs: number;
  /** `list_files` index of the open project (invalidated at turn end, refresh, rewind, branch switch). */
  private fileIndex: FileIndex | null = null;
  /** Turn checkpoints of the current chat (`<gitdir>/reviewgate/checkpoints/<chatId>.json`, §26). */
  private checkpoints: CheckpointFile = { version: 1, records: [] };
  /** The record of the running turn (null between turns). */
  private turnRecord: CheckpointRecord | null = null;
  /** The CLI's `supportedModels()` (kept across sessions of this engine). */
  private models: ModelOption[] | null = null;
  /** The project's `set_model` choice (persisted in `reviewgate-session.json`); undefined fields = the settings apply. */
  private modelChoice: { model?: string | null; effort?: EffortLevel | null } = {};
  /** `context_warning` went out for the current crossing of 80 %. */
  private contextWarned = false;
  // MARK: wave5 w5-model — §43.4 auto model
  /** The model each live session was last set to (its start options, `set_model`, a turn's pick); null = the CLI's default. */
  private readonly liveModels = new WeakMap<ClaudeSessionLike, string | null>();
  /** The next message implements a plan just approved (§42.1's follow-ups). */
  private planImplementNext = false;
  /** What happened since the last message that makes the next one a retry. */
  private autoRetry: "failed" | "rewound" | "rejected" | null = null;
  /** The model the running turn was given (its `turn_end` / `turn_summary` carry it). */
  private turnAutoModel: AutoModelChoice | null = null;
  // ---- §29 peer messages
  /** Held / delivering peer messages of the live session, in arrival order. */
  private readonly peerInbox = new Map<string, PeerMessage>();
  /** The project's `peer_set` (persisted in `reviewgate-session.json`); undefined = `settings.peerInbound`. */
  private peerChoice: PeerInboundMode | undefined;
  /** A turn the CLI runs that is not ours (`state.session.externalTurn`). */
  private externalTurn: ExternalTurn | null = null;
  /** The running review turn is accepted peer messages. */
  private peerTurn: { messageIds: string[]; fromNames: string[] } | null = null;
  /** The unprompted turn running now delivered a peer message: a card says it, not the §18 banner. */
  private externalPeerEpisode = false;
  // ---- §52 background work
  /** Session events held while a turn Claude started is being taken (snapshot A first); replayed in order after it. */
  private adoptQueue: { source: ClaudeSessionLike; ev: SessionEvent }[] | null = null;
  /** A background task was live when the last turn was collected (or after): the next turn keeps A (§52.1). */
  private bgCarry = false;
  /** The collection of the turn that ended last (a turn Claude starts right after it waits for it). */
  private collection: Promise<void> | null = null;
  /** An automatic `peer_accept` (mode auto) is queued on the main lane. */
  private peerAutoQueued = false;
  /** Held messages whose release failed once: `auto` leaves them to the user (no retry loop). */
  private readonly peerReleaseFailed = new Set<string>();
  // ---- §33 permission requests
  /** §33.4 notices already reported this turn (`code|tool|path|branch`). */
  private readonly scopeNoticed = new Set<string>();
  /** §33.5: the user's Claude Code rules the current session applies (read at session start, live with `applyUserAllowRules`). */
  private userRules: UserRules = { allow: [], block: [] };
  /** §33.1: requests the engine answered itself this turn (remember / a new pattern); a late `permission_response` to one is a no-op. */
  private readonly autoAnswered = new Set<string>();
  // MARK: wave4b w4b-follow — §39.4
  /** Worktree roots (canonical) a chat created with a worktree command this engine saw run: chat id → roots. */
  private readonly createdWorktrees = new Map<string, Set<string>>();
  /** "허용하고 따라가기": the worktree command's tool_use id → where to move once it ran, and what to send there. */
  private readonly followAfterTool = new Map<string, { path: string | null; followUp: string | null }>();
  /** The handoff `loadSessions` took for the chat it made current: its baseline, notice and follow-up once the project is open. */
  private receivedMove: { meta: SessionMeta; handoff: ChatHandoff } | null = null;
  /**
   * A worktree command's card (tool_use id) → whether its path was a worktree already when the card came (then it created
   * nothing), and every worktree there was then (the one the command adds is the new one, whatever its words said).
   */
  private readonly worktreeBeforeCommand = new Map<string, Promise<{ was: boolean; roots: string[] }>>();
  // MARK: wave2 engine-review
  /** §34.1: the range trees last pinned by `persistReview` (skip the git calls when unchanged). */
  private pinnedRangeKey = "";
  /** §34.4: when the review last changed (`review_history.current.endedAt`). */
  private reviewUpdatedAt: string | null = null;
  // MARK: wave2 engine-why
  /** §34.6: the running turn's live-tree cache (`live_changes` / `live_diff`); reset at every turn start and end. */
  private readonly live = new LiveView(() => this.now());
  /** §34.8: the main agent's text after its last tool call in the running turn (the turn-end report `why` reads). */
  private turnReport = "";
  /** §34.8 / §34.9: tool_use and tool_result order of the session's calls (`ToolCallInfo.seq` / `resultSeq`). */
  private callSeq = 0;
  private resultSeq = 0;
  // MARK: wave3 engine-session
  /** §36.5: `git rev-parse --git-common-dir` of the open project: the capability cache a new workbench replays (§36.7: the start history). */
  private projectCommonDir: string | null = null;
  /** §36.7: the repository's last successful start durations with user settings (ms, newest last; `<common>/reviewgate/extensions-start.json`). */
  private startHistory: number[] = [];
  /** §36.7: the start in flight — when `session.start()` was called and whether it loads user settings — until initialize answers. */
  private startClock: { at: number; loadUser: boolean } | null = null;
  /** §36.7: what the starting CLI works on (`session.extensionsWaitingOn`). */
  private readonly waitingOn = new WaitingOn();
  /** §36.7: a `retry_extensions` restart is starting (a timeout now falls back for good); the one automatic retry after a fallback. */
  private extRetry: { running: boolean; auto: "none" | "pending" | "done"; timer: NodeJS.Timeout | null } = { running: false, auto: "none", timer: null };
  private readonly extensionsAutoRetryMs: number;
  /** §36.8: `<data dir>/cli-versions.json` (app-wide) and the installer's versions folder. */
  private readonly dataDir: string;
  private readonly cliVersionsDir: string;
  /** The window each model ran with last, for a status line run before this session's first result. */
  private readonly contextWindows: ContextWindows;
  /** §36.9: the SDK's `listSessions`. */
  private readonly listCliSessionsFn: ListSessionsFn;
  // MARK: wave3 engine-flow
  /** §36.12: stops of the workbench setup commands running now (killed on dispose). */
  private readonly setupStops = new Set<() => void>();
  /** §36.13: AI pre-reviews in read-only forks and the main chat's ReportFindings (runs in `gate.prereviews`). */
  private readonly prereviews = new PreReviewRunner({
    gate: this.gate,
    startFork: (run) => this.side.startDetached(run),
    rel: (file) => this.findingPath(file),
    emit: (ev) => this.emit(ev),
    changed: () => {
      this.persistReview();
      this.touch();
    },
    log: (level, msg) => this.log(level, msg),
    now: () => this.now(),
  });

  // MARK: wave5 w5-graph — §43.3
  /** The board's code graph: graphify's report, its freshness, `graphify update .` (built in the constructor: it needs the platform). */
  private readonly codeGraph: CodeGraph;
  /** `EngineOptions.graphifyPath` when given. */
  private readonly graphifyOverride: string | null | undefined;
  /** The graphify found, re-looked for after a minute (the board polls every 15 s). */
  private graphifyFound: { at: number; path: string | null } | null = null;
  /** §43.3: the mods list is re-read at most every 10 s (extensions refresh on many events). */
  private modsCache: { at: number; key: string; mods: NonNullable<SessionExtensions["mods"]> } | null = null;
  // MARK: wave6 w6-statusline — §44.2
  /** The user's Claude Code status line (built in the constructor: it needs the platform). */
  private readonly statusLine: StatusLine;
  /** `EngineOptions.managedPolicy` when given. */
  private readonly managedPolicyOverride: (() => ManagedPolicy) | undefined;
  /** When the live session started and the `--name` it started with (`cost.total_duration_ms`, `session_name`). */
  private sessionStartedAt: number | null = null;
  private sessionStartName: string | null = null;
  /** Lines the collected turns of this chat added / removed since the engine opened it (`cost.total_lines_*`). */
  private chatLines = { added: 0, removed: 0 };

  constructor(opts: EngineOptions = {}) {
    this.platform = opts.platform ?? createPlatform(process.platform);
    // MARK: wave5 w5-graph — §43.3
    this.graphifyOverride = opts.graphifyPath;
    this.codeGraph = new CodeGraph({
      root: () => this.project?.root ?? null,
      graphify: () => this.graphifyPath(),
      env: () => ({ ...this.childEnv(), ...(this.toolchainPath ? { PATH: this.toolchainPath } : {}) }),
      killTree: (pid) => this.platform.killTree(pid),
      isWindows: this.platform.isWindows,
      emit: (ev) => this.emit(ev),
      log: (level, msg) => this.log(level, msg),
      ...(opts.graphBuildTimeoutMs !== undefined ? { timeoutMs: opts.graphBuildTimeoutMs } : {}),
    });
    // MARK: wave6 w6-statusline — §44.2
    this.managedPolicyOverride = opts.managedPolicy;
    this.statusLine = new StatusLine({
      resolve: () => this.statusLineResolution(),
      snapshot: () => this.statusLineSnapshot(),
      enabled: () => this.settings.showStatusLine !== false,
      env: () => ({ ...this.childEnv(), ...(this.toolchainPath ? { PATH: this.toolchainPath } : {}) }),
      platform: this.platform,
      scope: () => this.project?.path ?? null,
      emit: (ev) => this.emit(ev),
      log: (level, msg) => this.log(level, msg),
      now: () => this.now(),
      ...(opts.statusLineTiming ?? {}),
    });
    this.baseEnv = { ...(opts.env ?? {}) };
    this.logFn = opts.log ?? (() => {});
    this.sessionFactory = opts.sessionFactory ?? ((o) => new ClaudeSession(o));
    this.now = opts.now ?? Date.now;
    this.lockOwner = { pid: opts.lockOwner?.pid ?? process.pid, host: opts.lockOwner?.host ?? hostname(), client: "test", token: randomUUID() };
    this.autoRestartDelayMs = opts.autoRestartDelayMs ?? AUTO_RESTART_DELAY_MS;
    this.mcpPollMs = opts.mcpPollMs ?? MCP_POLL_MS;
    this.runClaudeFn = opts.runClaude;
    this.interruptWaitMs = opts.interruptWaitMs ?? INTERRUPT_WAIT_MS;
    // MARK: wave3 engine-session (§36.7, §36.8)
    this.extensionsAutoRetryMs = opts.extensionsAutoRetryMs ?? EXTENSIONS_AUTO_RETRY_MS;
    this.dataDir = opts.dataDir ?? (opts.env?.REVIEWGATE_DATA_DIR || process.env.REVIEWGATE_DATA_DIR || join(homedir(), ".reviewgate"));
    this.contextWindows = new ContextWindows(this.dataDir);
    this.cliVersionsDir = opts.cliVersionsDir ?? defaultCliVersionsDir();
    this.listCliSessionsFn = opts.listCliSessions ?? ((o) => listSessions(o));
    this.side = new SideThreads({
      gitDir: () => this.projectGitDir,
      forkSource: () => this.sideForkSource(),
      launch: () => this.sideLaunch(),
      firstPrompt: async (question, anchor, source, earlier) => buildSidePrompt(question, { ...(await this.sideAnchorData(anchor)), ...this.sideRunningTurn(source), ...(earlier ? { earlier } : {}) }),
      emit: (ev) => this.emit(ev),
      onCost: (usd) => {
        this.hud.sideCostUSD = (this.hud.sideCostUSD ?? 0) + usd;
        this.touch();
      },
      log: (level, msg) => this.log(level, msg),
      ...(opts.sideQueryFactory ? { makeQuery: opts.sideQueryFactory } : {}),
      // MARK: wave4b w4b-side — §40.3: the side sessions live next to the main one (the CLI keys them by the project's cwd).
      deleteSession: async (id) => {
        const dir = this.project?.path;
        if (dir) await (opts.sideSessionFiles?.delete ?? ((i, d) => sdkDeleteSession(i, { dir: d })))(id, dir);
      },
      renameSession: async (id, title) => {
        const dir = this.project?.path;
        if (dir) await (opts.sideSessionFiles?.rename ?? ((i, t, d) => sdkRenameSession(i, t, { dir: d })))(id, title, dir);
      },
      isChat: (id) => this.sessions?.get(id) !== undefined || id === this.sessionState.sessionId,
    });
    this.gate.ignorePatterns = () => this.settings.ignorePatterns;
    this.gate.onChange = () => this.persistReview();
    this.gate.onRoundComplete = (entry) => this.recordHistory(entry);
    // MARK: wave4c w4c-trust — §41.2: a reject that completed its round was put back: the round is in progress again.
    this.gate.onRoundReopened = (id) => {
      if (!this.history.some((e) => e.id === id)) return;
      this.history = this.history.filter((e) => e.id !== id);
      this.saveHistoryFile();
    };
    // MARK: wave2 engine-why
    this.gate.annotateFiles = (args) => this.annotateReviewFiles(args);
    this.pr = new PRStore(
      {
        resolveGH: () => this.resolveGH(),
        platform: this.platform,
        onChange: () => this.touch(),
      },
      this.settings.ghHost,
    );
  }

  // ------------------------------------------------------------------ public surface

  on(listener: (ev: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Last emitted snapshot (a pending coalesced emission is flushed first — wave7: the trailing HUD churn too). */
  get state(): ReviewState {
    if (this.stateTimer || this.churnTimer) {
      if (this.stateTimer) clearImmediate(this.stateTimer);
      this.stateTimer = null;
      this.emitState();
    }
    return this.lastState ?? buildState(this.slices());
  }

  /**
   * Dispatches one command. Never throws; failures surface as `result{ok:false}` (if id) and/or
   * `error` events. Commands run in order on one lane, PR commands (slow `gh` calls) on their own.
   */
  handle(cmd: EngineCommand): Promise<void> {
    if (this.closed) {
      if (cmd.id) this.reply(cmd.id, { type: "result", id: cmd.id, ok: false, error: "engine disposed", code: "engine_disposed" });
      return Promise.resolve();
    }
    const lane = laneOf(cmd);
    const run = this.lanes[lane].then(() => this.handleNow(cmd));
    this.lanes[lane] = run.catch(() => undefined);
    return run;
  }

  private async handleNow(cmd: EngineCommand): Promise<void> {
    if (this.closed) {
      if (cmd.id) this.reply(cmd.id, { type: "result", id: cmd.id, ok: false, error: "engine disposed", code: "engine_disposed" });
      return;
    }
    if (cmd.type === "shutdown") {
      if (cmd.id) this.reply(cmd.id, { type: "result", id: cmd.id, ok: true });
      await this.dispose();
      return;
    }
    let reply: ReplyEvent | undefined;
    try {
      reply = await this.dispatch(cmd);
      if (STATUS_LINE_COMMANDS.has(cmd.type)) this.statusLine.poke(); // MARK: wave6 w6-statusline (§44.2)
    } catch (e) {
      const message = errorMessage(e);
      if (!(e instanceof CommandRefused)) this.fail(message, false, scopeOf(cmd.type), { code: "command_failed" });
      else this.log("debug", `${cmd.type} refused: ${message}`);
      if (cmd.id) this.reply(cmd.id, { type: "result", id: cmd.id, ok: false, error: message, ...refusalFields(e) });
      return;
    }
    // Typed replies (ready / file_diff / full_file_content) always go out; `result` only for an id.
    if (reply) this.reply(cmd.id, cmd.id ? { ...reply, id: cmd.id } : reply);
    else if (cmd.id) this.reply(cmd.id, { type: "result", id: cmd.id, ok: true });
  }

  /** In-process convenience (Electron / tests): assigns an id (any given one is replaced), resolves with the typed reply or rejects. */
  request<C extends EngineCommand>(cmd: C): Promise<ReplyFor<C>> {
    const id = randomUUID();
    return new Promise<ReplyFor<C>>((resolve, reject) => {
      this.pending.set(id, { resolve: (ev) => resolve(ev as ReplyFor<C>), reject });
      void this.handle({ ...cmd, id });
    });
  }

  /** close_project + stop children (≤2.5s), then no more events. */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = (async () => {
      this.cancelAutoRestart();
      this.cancelExtensionsRetry(); // MARK: wave3 engine-session (§36.7)
      this.subBrain.close(); // MARK: wave5 w5-brain — §43.2: no re-read outlives the engine
      await this.side.stopAll().catch(() => undefined);
      for (const stop of this.setupStops) stop(); // MARK: wave3 engine-flow — §36.12: no setup outlives the engine
      this.codeGraph.stop(); // MARK: wave5 w5-graph — §43.3: nor a graphify build
      this.statusLine.dispose(); // MARK: wave6 w6-statusline — §44.2: nor a status line run
      // §31 (daily-01): a review with only accepted files left is done — like close_project, it goes now instead of
      // coming back days later. Kept while a turn was running (its changes are not collected yet: the crash path).
      const done = this.gate.checkpoint !== null && !this.gate.running && !this.gate.collecting && this.gate.turnEndTree !== null
        && !this.gate.hasPendingReview && this.gate.unsentNoteCount === 0 && !this.gate.isRequestingChanges && this.gate.changedFiles.length > 0;
      await this.stopSession();
      if (done) {
        this.gate.completeRound();
        this.persistChain = this.persistChain.then(() => this.clearPersistedReview()).catch((e) => this.log("warn", `persist: ${errorMessage(e)}`));
      }
      await this.persistChain.catch(() => undefined);
      await this.releaseProjectLock();
      this.gate.reset();
      // One last snapshot (session.open = false) so a client that stays alive sees the final state.
      if (this.stateTimer) {
        clearImmediate(this.stateTimer);
        this.stateTimer = null;
      }
      if (this.agentTimer) {
        clearTimeout(this.agentTimer);
        this.agentTimer = null;
      }
      if (this.churnTimer) clearTimeout(this.churnTimer); // MARK: wave7 w7-state (§45.2): the last snapshot below carries it
      this.churnTimer = null;
      this.stopDiskWatch(); // MARK: wave4b w4b-bigturn (§39.1)
      this.emitState();
      this.closed = true;
      for (const [id, p] of this.pending) p.reject(new Error(`engine disposed (${id})`));
      this.pending.clear();
      this.listeners.clear();
    })();
    return this.disposing;
  }

  // ------------------------------------------------------------------ dispatch

  private async dispatch(cmd: EngineCommand): Promise<ReplyEvent | undefined> {
    switch (cmd.type) {
      case "hello": {
        this.clientEnv = { ...(cmd.env ?? {}) };
        this.lockOwner.client = cmd.client;
        this.applySettings(cmd.settings);
        this.toolchainPromise = null;
        void this.locate().catch(() => undefined);
        this.touch();
        const ready: ReadyEvent = {
          type: "ready",
          engineVersion: ENGINE_VERSION,
          platform: this.platform.name,
          protocolVersion: PROTOCOL_VERSION,
        };
        return ready;
      }
      case "set_settings":
        this.applySettings(cmd.settings);
        // MARK: wave3 engine-session — §36.8: a pinned / unpinned CLI shows in `toolchain` now; the next start uses it.
        if (cmd.settings.claudePath !== undefined && this.toolchainPromise === null) void this.locate().catch(() => undefined);
        this.touch();
        return;
      case "open_project":
      case "switch_project":
        await this.openProject(cmd.path, cmd.takeover === true);
        return;
      case "close_project":
        await this.closeProject();
        return;
      case "init_repo":
        await this.initRepo();
        return;
      case "cancel_git_init":
        if (this.gitInit) {
          this.gitInit = null;
          this.touch();
        }
        return;
      case "restart_session":
        await this.restartSession(true);
        return;
      case "send": {
        // MARK: wave4c w4c-commit — §41.1 (SME-11): the CLI's /clear would empty Claude's memory under a chat that still
        // shows it; it is the app's new chat instead (the earlier chat stays in the list). Its arguments mean nothing, as in the CLI.
        if (this.isClearCommand(cmd.text)) {
          this.requireProject();
          await this.sessionNew();
          return;
        }
        const opts = this.sendOptions(cmd.mentions, cmd.attachments);
        if (cmd.model !== undefined) opts.model = validateModel(cmd.model); // MARK: wave5 w5-model (§43.4, refused before anything)
        // MARK: wave3 engine-flow — one of the session's slash commands goes out as that command (§27 rule of /compact).
        if (this.isSessionSlashCommand(cmd.text)) opts.command = true;
        await this.send(cmd.text, cmd.acceptPending === true, opts);
        return;
      }
      case "request_changes":
        await this.requestChanges(cmd.extra ?? null, cmd.noteIds);
        return;
      case "steer": // §50
        this.steer(cmd.text, cmd.mentions);
        return;
      case "interrupt":
        await this.interruptTurn();
        return;
      case "permission_response": {
        const session = this.session;
        if (!session) throw new CommandRefused("no_session");
        // §33: the response answers exactly the request it names, wherever it sits in the queue.
        const pending = this.sessionState.pendingPermissions.find((p) => p.requestId === cmd.requestId);
        if (!pending) {
          // Answered by the engine already (a remembered key / a pattern saved for this very card): nothing left to do.
          if (this.autoAnswered.has(cmd.requestId)) return;
          throw new CommandRefused("unknown_permission_request");
        }
        this.dequeuePermission(cmd.requestId);
        this.record({ kind: "permission", requestId: cmd.requestId, toolName: pending.toolName, allow: cmd.allow, ...(pending.file !== undefined ? { file: pending.file } : {}) });
        session.respondPermission(cmd.requestId, cmd.allow, cmd.message, cmd.updatedInput);
        // §33.2 / §33.3: a card with a reason, SendMessage, a worktree / plan tool or a question keeps asking — `remember`
        // from an older client stores nothing for it (and would answer nothing: hooks.autoAllowReason).
        if (cmd.allow && cmd.remember === true && !pending.reason && rememberable(pending.toolName)) {
          this.rememberedAllows.add(rememberKey(pending.toolName, pending.input));
          this.sessionState.rememberedAllows = [...this.rememberedAllows];
          this.saveAllows();
          this.resolveCoveredPermissions();
        }
        // MARK: wave4b w4b-follow — §39.4 "허용하고 따라가기": once that worktree command ran, the chat moves into it.
        // Not for another repository's worktree (§39.4): no chat of this window can go there — a plain allow.
        if (cmd.allow && cmd.follow === true && pending.reason?.code === "worktree_command" && pending.reason.otherRepository !== true && pending.toolUseId) {
          this.followAfterTool.set(pending.toolUseId, { path: pending.reason.path ?? null, followUp: typeof cmd.followUp === "string" ? cmd.followUp : null });
        }
        this.touch();
        return;
      }
      case "forget_allows":
        this.rememberedAllows.clear();
        this.sessionState.rememberedAllows = [];
        this.clearPersistedAllows();
        this.touch();
        return;
      case "permission_rules":
        return this.permissionRules();
      case "set_permission_mode":
        await this.setPermissionMode(cmd.mode);
        return;
      case "plan_response":
        await this.planResponse(cmd.approve, cmd.mode, cmd.message, cmd.into, cmd.path); // MARK: wave4d w4d-plan (§42.1: into / path)
        break;
      // MARK: wave4d w4d-plan — §42.1
      case "plan_follow":
        this.planFollow(cmd.path);
        return;
      case "accept":
        await this.acceptFiles(cmd.paths);
        return;
      case "accept_all":
        await this.acceptFiles(null);
        return;
      case "unaccept":
        if (this.gate.running || this.gate.collecting || this.gate.reverting) throw new CommandRefused("session_running");
        this.gate.unaccept(cmd.paths);
        this.touch();
        return;
      // MARK: wave4c w4c-trust — §41.2
      case "set_auto_accept":
        await this.setAutoAccept(cmd.rules);
        return;
      case "auto_accept_undo":
        this.gate.undoAutoAccept(Array.isArray(cmd.paths) ? cmd.paths.filter((p): p is string => typeof p === "string") : null);
        this.touch();
        return;
      case "reject_undo":
        await this.rejectUndo(cmd.path);
        return;
      case "reject":
        this.guardReviewMutation();
        await this.reject(cmd.paths, cmd.force === true);
        this.autoRetry = "rejected"; // MARK: wave5 w5-model (§43.4)
        return;
      case "reject_all": {
        this.guardReviewMutation();
        // §31: changes nothing of Claude's explains stay unless the user explicitly includes them.
        const targets = this.gate.rejectAllPaths(cmd.includeExternal === true);
        // MARK: wave2 check-engine — §35.2: an uncaptured file (§32) cannot be put back: it is skipped, not a reason to
        // refuse the whole batch; nothing revertible at all is still refused `not_captured`.
        const uncaptured = new Set(this.gate.changedFiles.filter((f) => f.uncaptured === true).map((f) => f.path));
        const skipped = targets.filter((p) => uncaptured.has(p));
        const revertible = targets.filter((p) => !uncaptured.has(p));
        if (revertible.length === 0 && skipped.length > 0) throw new CommandRefused(`not_captured:${skipped.join(", ")}`, { code: "not_captured", paths: skipped });
        await this.reject(revertible, cmd.force === true);
        if (revertible.length > 0) this.autoRetry = "rejected"; // MARK: wave5 w5-model (§43.4)
        if (skipped.length === 0) return;
        this.log("info", `reject_all left ${skipped.length} uncaptured file(s) as they are: ${skipped.join(", ")}`);
        if (!cmd.id) return;
        const reply: RejectAllResultEvent = { type: "result", id: cmd.id, ok: true, skipped: skipped.map((path) => ({ path, code: "not_captured" })) };
        return reply;
      }
      case "reject_hunks":
        this.guardReviewMutation();
        await this.rejectHunks(cmd.path, Array.isArray(cmd.hunks) ? cmd.hunks : [], cmd.expectedEndTree ?? null, cmd.expectedBaseTree ?? null);
        this.autoRetry = "rejected"; // MARK: wave5 w5-model (§43.4)
        return;
      case "retry_collect":
        await this.retryCollect();
        return;
      case "add_note":
        this.guardNoteMutation();
        if (!this.gate.addNote(cmd)) throw new CommandRefused("empty note", { code: "empty_note" });
        this.touch();
        return;
      case "remove_note":
        this.guardNoteMutation();
        this.gate.removeNote(cmd.noteId);
        this.touch();
        return;
      case "edit_note":
        this.guardNoteMutation();
        if (!this.gate.editNote(cmd.noteId, cmd.body)) throw new CommandRefused("note not editable", { code: "note_not_editable" });
        this.touch();
        return;
      case "select_file": {
        // §34.1 / §34.2: any range, also while a turn runs (from the held B: `stale`).
        const since = sinceOf(cmd.since);
        const { diff, truncated, endTree, baseTree, stale } = await this.gate.diffRange(cmd.path, since);
        const ev: FileDiffEvent = { type: "file_diff", scope: "turn", path: cmd.path, diff, truncated, endTree, ...(since !== "review" ? { since } : {}), baseTree, ...(stale ? { stale: true as const } : {}) };
        // MARK: wave4b w4b-files — §40.2: a binary's sizes (and its modes / similarity, which no patch named).
        ev.diff = await withFileMeta(this.gate.checkpoint, this.gate.changedFiles.find((f) => f.path === cmd.path), diff, { baseTree, endTree, review: since === "review" });
        // MARK: wave4c w4c-review — §41.3: the same range with whitespace ignored (read-only: its hunks are not A's hunks).
        if (cmd.ignoreWhitespace === true) return this.ignoringWhitespace(ev);
        return ev;
      }
      case "full_file": {
        const since = sinceOf(cmd.since);
        const view = await this.gate.fullFile(cmd.path, since);
        const ev: FullFileContentEvent = {
          type: "full_file_content",
          path: view.path,
          lines: view.lines,
          changedNewLines: view.changedNewLines,
          deletedAfterNewLine: Object.fromEntries(Object.entries(view.deletedAfterNewLine)),
          isBinary: view.isBinary,
          isTooLarge: view.isTooLarge,
          oldText: view.oldText,
          newText: view.newText,
          ...(since !== "review" ? { since } : {}),
          ...(view.stale ? { stale: true as const } : {}),
          endTree: view.endTree,
        };
        return ev;
      }
      // MARK: wave2 engine-why — §34.6
      case "live_changes":
        return this.liveChanges();
      case "live_diff":
        return this.liveDiff(cmd.path);
      case "tool_output": {
        const kept = this.toolOutputs.get(cmd.toolUseId);
        const ev: ToolOutputEvent = { type: "tool_output", toolUseId: cmd.toolUseId, output: kept?.output ?? null, truncated: kept?.truncated ?? false };
        return ev;
      }
      case "branches":
        await this.refreshBranches();
        return;
      case "switch_branch":
        await this.withBranchGuard(cmd.name, "switch to", (cp) => switchBranch(cp, cmd.name));
        return;
      case "create_branch":
        await this.withBranchGuard(cmd.name, "create", (cp) => createBranch(cp, cmd.name, cmd.from ?? null));
        return;
      case "pr_list":
        await this.pr.refresh();
        return;
      case "pr_open":
        await this.pr.open(cmd.summaryId);
        return;
      case "pr_close":
        this.pr.close();
        return;
      case "pr_select_file": {
        this.pr.selectFile(cmd.filename);
        const diff = this.pr.selectedFile?.filename === cmd.filename ? this.pr.selectedDiff : null;
        if (!diff) throw new CommandRefused(`Unknown PR file: ${cmd.filename}`, { code: "unknown_pr_file" });
        const ev: FileDiffEvent = { type: "file_diff", scope: "pr", path: cmd.filename, diff, truncated: false };
        return ev;
      }
      case "pr_add_draft":
        this.pr.addDraft({ path: cmd.path, line: cmd.line, side: cmd.side, startLine: cmd.startLine ?? null, body: cmd.body });
        return;
      case "pr_remove_draft":
        this.pr.removeDraft(cmd.draftId);
        return;
      case "pr_submit":
        await this.pr.submit(cmd.event, cmd.body);
        return;
      case "pr_reply":
        await this.pr.reply(cmd.commentId, cmd.body);
        return;
      case "pr_reload_comments":
        await this.pr.reloadComments();
        return;
      case "accounts":
        await this.pr.refreshAccounts();
        return;
      case "login_in_terminal":
        await this.pr.openLoginInTerminal(cmd.host);
        return;
      case "workbench_list":
        this.requireProject();
        await this.refreshWorkbenches(true);
        return;
      case "workbench_create":
        await this.workbenchCreate(cmd); // MARK: wave3 engine-flow — §36.12 / §36.14 (its own lane)
        return;
      case "workbench_preview": // MARK: wave3 engine-flow — §36.12
        return this.workbenchPreview(cmd.branch, cmd.location);
      case "workbench_remove":
        await this.workbenchRemove(cmd.path, cmd.force === true);
        return;
      case "workbench_prune":
        await pruneWorktrees(this.requireProject().root);
        await this.pruneWorktreeNamespaces(this.requireProject());
        await this.refreshWorkbenches(false);
        return;
      case "pr_create":
        return this.prCreate(cmd.base, cmd.title ?? null, cmd.body ?? null, cmd.draft === true, cmd); // wave4c w4c-commit: + §41.1 meta
      case "commit":
        return this.commit(cmd.message, cmd.paths ?? null, cmd.push ?? this.settings.commitPushByDefault === true);
      case "commit_hunks": // §53
        return this.commitHunks(Array.isArray(cmd.paths) ? cmd.paths : null);
      case "commit_series":
        return this.commitSeries(cmd.commits, cmd.push ?? this.settings.commitPushByDefault === true);
      case "push":
        return this.pushLastCommit();
      case "refresh":
        await this.refresh(cmd.scope ?? null);
        return;
      case "session_list":
        this.touch();
        return;
      case "session_new":
        await this.sessionNew();
        return;
      case "session_open":
        await this.sessionOpen(cmd.sessionId);
        return;
      case "session_rename": {
        const meta = this.requireSession(cmd.sessionId);
        const title = cmd.title.trim();
        if (!title) throw new CommandRefused("empty_title");
        meta.title = title;
        this.persistSessions();
        this.touch();
        return;
      }
      case "session_archive": {
        const meta = this.requireSession(cmd.sessionId);
        if (cmd.archived) meta.archived = true;
        else delete meta.archived;
        this.persistSessions();
        this.touch();
        return;
      }
      case "session_delete": {
        const meta = this.requireSession(cmd.sessionId);
        if (meta.id === this.currentSessionId) throw new CommandRefused("session_current");
        this.sessions!.remove(meta.id);
        void this.side.removeFor(meta.id);
        if (this.projectGitDir) removeCheckpoints(this.projectGitDir, meta.id);
        this.pruneTurnRefs();
        this.openTabIds = this.openTabIds.filter((id) => id !== meta.id);
        this.persistSessions();
        this.touch();
        return;
      }
      case "tabs_set": {
        const idx = this.sessions;
        if (!idx) throw new CommandRefused("no_project");
        this.openTabIds = [...new Set(cmd.openTabIds.filter((id) => idx.get(id) !== undefined))];
        this.persistSessions();
        this.touch();
        return;
      }
      case "review_history": {
        if (!this.gate.checkpoint) throw new CommandRefused("no_project");
        const sessionId = cmd.all === true ? undefined : cmd.sessionId ?? this.currentSessionId;
        // §34.4: the round in progress rides along as `current` (never one of `entries`).
        const ev: ReviewHistoryEvent = { type: "review_history", sessionId: sessionId ?? null, entries: historyView(this.history, sessionId), current: this.gate.roundInProgress(this.reviewUpdatedAt) };
        return ev;
      }
      case "history_diff":
        return this.historyDiff(cmd.entryId, cmd.path, cmd.final === true);
      // MARK: wave4c w4c-review — §41.3
      case "history_file_lines":
        return this.historyFileLinesEvent(cmd.entryId, cmd.path, cmd.final === true);
      case "pr_file_lines":
        return this.prFileLinesEvent(cmd.filename);
      case "file_image":
        return this.fileImageEvent(cmd.path);
      // ---- §21 side questions
      case "side_ask": {
        // MARK: wave3 engine-flow — §36.14: a well-formed `anchor.pr` replaces the review-anchor fields.
        const thread = await this.side.ask(cmd.threadId, normalizeSideAnchor(cmd.anchor && typeof cmd.anchor === "object" ? cmd.anchor : null), cmd.question, { refork: cmd.refork === true }); // §40.3 refork
        return { type: "side_thread", thread };
      }
      case "side_list":
        return { type: "side_threads", mainSessionId: this.side.currentMainSessionId, threads: this.side.list() };
      case "side_close":
        await this.side.close(cmd.threadId);
        return;
      case "side_cancel":
        await this.side.cancel(cmd.threadId);
        return;
      case "side_promote_draft":
        return { type: "side_promote_draft", threadId: cmd.threadId, text: await this.side.draft(cmd.threadId) };
      case "side_promote": {
        // MARK: wave4b w4b-side — §40.3: the client queued the conclusion (the main turn runs): only recorded.
        if (cmd.queued === true) {
          this.side.get(cmd.threadId);
          this.side.notePromotion(cmd.threadId, "message", true);
          return;
        }
        if (typeof cmd.text !== "string" || !cmd.text.trim()) return { type: "side_promote_draft", threadId: cmd.threadId, text: await this.side.draft(cmd.threadId) };
        await this.sidePromote(cmd.threadId, cmd.as, cmd.text, cmd.acceptPending === true);
        return;
      }
      // MARK: wave3 engine-flow — §36.11 commit message draft (side lane), §36.13 AI pre-review
      case "commit_draft":
        return this.commitDraft(Array.isArray(cmd.paths) ? cmd.paths : null);
      case "commit_split_draft": // §53
        return this.commitSplitDraft(Array.isArray(cmd.paths) ? cmd.paths : null);
      // MARK: wave4c w4c-commit — §41.1 the team's format (a read) and the PR draft (PR lane)
      case "commit_format":
        return this.commitFormat();
      case "pr_draft":
        return this.prDraft(typeof cmd.base === "string" ? cmd.base : "");
      case "pr_ai_draft": // §51
        return this.prAiDraft(typeof cmd.base === "string" ? cmd.base : "", typeof cmd.title === "string" ? cmd.title : "", typeof cmd.body === "string" ? cmd.body : "");
      case "prereview_start":
        return this.prereviews.start(cmd.scope, cmd.paths, cmd.effort);
      case "prereview_cancel":
        await this.prereviews.cancel(cmd.prereviewId);
        return;
      case "prereview_dismiss":
        this.prereviews.dismiss(cmd.prereviewId, cmd.findingId);
        return;
      // ---- §22 MCP
      case "mcp_status":
        return this.mcpStatusReply();
      case "mcp_reconnect": {
        const name = validateServerRef(cmd.name);
        await this.mcpCall("reconnectMcpServer", (s) => s.reconnectMcpServer!(name), name);
        return this.mcpStatusReply();
      }
      case "mcp_toggle":
        return this.mcpToggle(validateServerRef(cmd.name), cmd.enabled !== false, cmd.scope === "repository" ? "repository" : "worktree");
      case "mcp_add":
        return this.mcpAdd(validateMcpName(cmd.name), validateMcpScope(cmd.scope), validateMcpConfig(cmd.config));
      case "mcp_remove":
        return this.mcpRemove(validateMcpName(cmd.name), validateMcpScope(cmd.scope), typeof cmd.file === "string" ? cmd.file : undefined);
      case "mcp_auth":
        await this.mcpAuth(validateServerRef(cmd.name));
        return;
      // ---- §23–27
      case "list_files":
        return this.listFiles(cmd.query, cmd.limit);
      case "attachment_get":
        return this.attachmentGet(cmd.hash);
      case "set_model":
        await this.setModel(cmd.model, cmd.effort);
        return;
      case "rewind": {
        // MARK: wave5 w5-model — §43.4: the message an edit & retry sends (else the next one) is a retry.
        const before = this.autoRetry;
        this.autoRetry = "rewound";
        try {
          return await this.rewind(cmd.toTurn, cmd.mode, cmd);
        } catch (e) {
          if (this.autoRetry === "rewound") this.autoRetry = before;
          throw e;
        }
      }
      case "compact":
        await this.compact(cmd.focus);
        return;
      // ---- §29 peer messages
      case "peer_accept":
        await this.peerAccept(cmd.ids);
        return;
      case "peer_dismiss":
        await this.peerDismiss(cmd.ids);
        return;
      case "peer_set":
        await this.peerSet(cmd.mode);
        return;
      // ---- §31
      case "finish_review":
        this.guardReviewMutation();
        if (this.gate.reverting) throw new CommandRefused("reverting");
        if (this.gate.collectError !== null) throw new CommandRefused("collect_failed");
        if (this.gate.changedFiles.length === 0 && this.gate.reviewNotes.length === 0 && this.gate.stale === null) return;
        this.gate.finishReview();
        this.touch();
        return;
      case "keep_review":
        this.gate.stale = null;
        this.touch();
        return;
      // MARK: wave3 engine-agents
      case "agent_report":
        return this.agentReport(cmd.toolUseId);
      case "stop_agent":
        await this.stopAgent(cmd.toolUseId);
        return;
      case "task_stop": // §52
        await this.taskStop(cmd.taskId);
        return;
      case "task_background":
        return this.taskBackground(cmd.toolUseId);
      case "task_output":
        return this.taskOutput(cmd.taskId);
      // MARK: wave3 engine-session
      case "retry_extensions":
        await this.retryExtensions();
        return;
      case "cli_versions":
        return this.cliVersions();
      case "cli_sessions":
        return this.cliSessions();
      case "cli_session_import":
        await this.cliSessionImport(cmd.sessionId);
        return;
      // MARK: wave4 w4-history — §38.3
      case "transcript_page":
        return this.transcriptPage(cmd.sessionId, cmd.before, cmd.beforeAt, cmd.limit);
      case "transcript_search":
        return this.transcriptSearch(cmd.query, cmd.limit, cmd.perChat); // MARK: wave4c w4c-review — §41.3 perChat
      // MARK: wave4b w4b-bigturn — §39.1
      case "retry_save":
        await this.retrySave();
        return;
      case "history_cleanup":
        return this.historyCleanup(cmd.keep, cmd.apply === true);
      // MARK: wave4b w4b-follow — §39.4
      case "chat_move":
        await this.chatMove(cmd.path, cmd.interrupt === true, cmd.followUp);
        return;
      case "chat_receive":
        await this.chatReceive();
        return;
      // MARK: wave4d w4d-config — §42.3
      case "claude_md_read":
        return this.claudeMdRead(cmd.path);
      case "claude_md_write":
        return this.claudeMdWrite(cmd.path, cmd.text, cmd.baseSha);
      // MARK: wave5 w5-brain — §43.2
      case "brain":
        return this.brainSnapshot(cmd.watch);
      case "brain_read":
        return this.brainRead(cmd.name);
      // MARK: wave5 w5-graph — §43.3
      case "code_graph":
        return this.codeGraph.snapshot();
      case "code_graph_build":
        return this.codeGraph.startBuild();
      // MARK: wave6 w6-statusline — §44.2
      case "status_line":
        return this.statusLine.request(cmd.columns, cmd.visible);
      // MARK: code-browser — §47: read-only, any file of the project
      case "project_file":
        return { type: "project_file", ...readProjectFile(this.requireProject().root, cmd.path) };
      case "project_search": {
        const found = await searchProject(this.requireProject().root, { query: cmd.query, caseSensitive: cmd.caseSensitive, wholeWord: cmd.wholeWord, limit: cmd.limit });
        return { type: "project_search", query: found.query, matches: found.matches, truncated: found.truncated, ...(found.timedOut ? { timedOut: true as const } : {}) };
      }
      case "shutdown":
        return;
      default:
        throw new CommandRefused(`unknown command: ${String((cmd as { type?: unknown }).type)}`, { code: "unknown_command" });
    }
  }

  /**
   * `set_permission_mode` (docs/M20-MODES.md): switches the live session's mode and persists it per
   * project. Refused while a turn / start / collection is in flight; our PreToolUse rules (the budget
   * deny, the git card of §46) run before mode evaluation, so they still apply in every mode.
   */
  private async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!isPermissionMode(mode)) throw new CommandRefused("invalid_mode");
    const session = this.session;
    if (!session) throw new CommandRefused("no_session");
    if (this.sessionState.starting || this.gate.running || this.gate.collecting || this.gate.reverting || session.isTurnActive) {
      throw new CommandRefused("session_busy");
    }
    const before = this.sessionState.permissionMode;
    await session.setPermissionMode(mode);
    // MARK: wave6 w6-terminal — §44.1: into plan mode the mode before it is kept (approving the plan can go back to it).
    this.sessionState.prePlanMode = mode !== "plan" ? null : before !== "plan" ? before : this.prePlanModeNow();
    this.sessionState.permissionMode = mode;
    this.planByClaude = false;
    this.persistSessions();
    this.touch();
  }

  // MARK: wave6 w6-terminal — §44.1

  /** While the chat is in plan mode, the mode before it (null outside plan mode, or when unknown). */
  private prePlanModeNow(): PermissionMode | null {
    return this.sessionState.permissionMode === "plan" ? this.sessionState.prePlanMode ?? null : null;
  }

  /** The mode approving a plan switches to when the answer names none: back to auto when the chat came from it, else default. */
  private planReturnMode(): PermissionMode {
    return this.prePlanModeNow() === "auto" ? "auto" : "default";
  }

  /**
   * The user's mode: the one stored for the project and a new chat starts in — while Claude's own plan mode runs, the mode
   * before it (Claude chose plan mode for this conversation, the user did not choose it for the project).
   */
  private userMode(): PermissionMode {
    return this.planByClaude ? this.prePlanModeNow() ?? this.sessionState.permissionMode : this.sessionState.permissionMode;
  }

  /** A new chat's session slice: the user's mode (a plan mode they picked keeps the mode before it); Claude's plan mode ends. */
  private freshSessionState(): EngineSlices["session"] {
    const mode = this.userMode();
    const fresh = emptySession(mode, mode === "plan" ? this.prePlanModeNow() : null);
    this.planByClaude = false;
    return fresh;
  }

  /** Sets a mode that comes from storage or another chat (never Claude's own plan mode; the mode before plan is unknown). */
  private restoreMode(mode: PermissionMode): void {
    this.sessionState.permissionMode = mode;
    this.sessionState.prePlanMode = null;
    this.planByClaude = false;
  }

  /**
   * `plan_response` (docs/M20-MODES.md): answers the `plan_proposed` card. Approving switches the
   * mode (default `"default"`), emits `plan_approved` and sends the follow-up instruction as a normal
   * `send` — so the review gate applies to the implementation turn. Rejecting stays in plan mode and
   * sends a "keep planning" nudge. Both clear `pendingPlan`.
   */
  private async planResponse(approve: boolean, mode?: PermissionMode, message?: string, into?: unknown, target?: unknown): Promise<void> {
    const session = this.session;
    if (!session) throw new CommandRefused("no_session");
    if (this.sessionState.starting || this.gate.running || this.gate.collecting || this.gate.reverting || session.isTurnActive) {
      throw new CommandRefused("session_busy");
    }
    const pending = this.sessionState.pendingPlan;
    if (!pending) throw new CommandRefused("no_plan");
    if (mode !== undefined && !isPermissionMode(mode)) throw new CommandRefused("invalid_mode");
    // Everything the follow-up send checks is validated before the mode switches (§19.5): nothing changes on a refusal.
    const slices = this.slices();
    if (!canSend(slices)) throw new CommandRefused(`gate_closed:${blockedReason(slices) ?? "unknown"}`);
    const custom = typeof message === "string" && message.trim().length > 0 ? message : null;
    // MARK: wave4d w4d-plan — §42.1: implement in a fresh chat here, or hand the plan to another workbench (an unknown `into`: here).
    const where = approve && typeof into === "string" && (PLAN_INTO as readonly string[]).includes(into) ? (into as PlanInto) : null;
    // MARK: wave6 w6-terminal — §44.1: no `mode` → back to auto when the chat came from it (`planReturnMode`), else default.
    if (where === "new_chat") return this.planInNewChat(pending, mode ?? this.planReturnMode(), custom);
    if (where === "workbench") return this.planToWorkbench(pending, mode ?? this.planReturnMode(), target);
    const prevMode = this.sessionState.permissionMode;
    const prevPre = this.prePlanModeNow(); // MARK: wave6 w6-terminal — §44.1: put back with the mode on a failed follow-up
    const prevByClaude = this.planByClaude;
    const prevKeys = [...this.proposedPlanKeys];
    let text: string;
    if (approve) {
      let next = mode ?? this.planReturnMode();
      try {
        await this.setPermissionMode(next);
      } catch (e) {
        // MARK: wave6 w6-terminal — §44.1: back to an auto mode the CLI cannot run (another model, a policy): the plan runs
        // in the default mode instead, said as the usual notice — never a refusal the card would loop on.
        if (next !== "auto" || prevPre !== "auto" || !(e instanceof CommandRefused) || e.code !== "auto_mode_unavailable") throw e;
        next = "default";
        await this.setPermissionMode(next);
        const n = autoModeUnavailableNotice(next);
        this.notice(n.message, "session", { code: n.code, ...(n.detail ? { detail: n.detail } : {}) });
      }
      this.sessionState.pendingPlan = null;
      this.approvedPlan = { path: pending.path, plan: pending.plan };
      this.emit({ type: "plan_approved", mode: next, path: pending.path });
      this.planImplementNext = true; // MARK: wave5 w5-model (§43.4)
      this.touch();
      text =
        custom ??
        (pending.path !== null
          ? `Implement the approved plan at ${pending.path}.`
          : "Implement the plan you just proposed.");
    } else {
      this.sessionState.pendingPlan = null;
      this.touch();
      text = custom ?? "Keep planning — revise the plan; do not implement yet.";
    }
    let failure: unknown = null;
    let sent = false;
    const failsBefore = this.failCount;
    try {
      sent = await this.send(text);
    } catch (e) {
      failure = e;
    }
    if (sent) return;
    // The follow-up did not go out: put the plan card and the previous mode back so the user can answer again.
    if (this.sessionState.permissionMode !== prevMode) {
      try {
        await session.setPermissionMode(prevMode);
        this.sessionState.permissionMode = prevMode;
        this.sessionState.prePlanMode = prevPre; // MARK: wave6 w6-terminal (§44.1)
        this.planByClaude = prevByClaude;
        this.persistSessions();
      } catch (e) {
        this.log("warn", `plan_response: restoring permission mode ${prevMode} failed: ${errorMessage(e)}`);
      }
    }
    this.sessionState.pendingPlan = pending;
    if (approve) this.approvedPlan = null;
    for (const k of prevKeys) this.proposedPlanKeys.add(k);
    const reason = failure !== null ? errorMessage(failure) : this.failCount !== failsBefore && this.lastError ? this.lastError : "send_failed";
    this.fail(`The plan answer could not be sent to Claude (${reason}); the plan is still pending.`, false, "session", { code: "plan_followup_failed" });
    throw new CommandRefused(`plan_followup_failed:${reason}`, { code: "plan_followup_failed" });
  }

  /**
   * Offers a plan-mode plan to the client. Two sources (docs/M20-MODES.md): `ExitPlanMode` (CLI
   * 2.1.275+), whose text arrives with the call, and — for CLIs without the tool — the
   * `<home>/.claude/plans/<slug>.md` file the turn wrote, read back at `turn_end`. Both can happen
   * in one turn, so the same plan is only proposed once (by path and by content).
   */
  private proposePlan(planFiles: string[], planText?: string): void {
    if (this.sessionState.permissionMode !== "plan") return;
    const path = planFiles.length > 0 ? planFiles[planFiles.length - 1]! : null;
    let plan: string;
    if (planText !== undefined && planText.length > 0) {
      plan = planText.slice(0, MAX_PLAN_BYTES);
    } else if (path === null) {
      return;
    } else {
      try {
        plan = readFileSync(path, "utf8").slice(0, MAX_PLAN_BYTES);
      } catch (e) {
        this.log("warn", `plan file ${path} could not be read: ${errorMessage(e)}`);
        return;
      }
    }
    const keys = [...(path !== null ? [`path:${path}`] : []), `plan:${createHash("sha1").update(plan).digest("hex")}`];
    if (keys.some((k) => this.proposedPlanKeys.has(k))) return;
    for (const k of keys) this.proposedPlanKeys.add(k);
    const steps = planStepBriefs(plan); // MARK: wave4d w4d-plan — §42.1: the card's per-step notes
    this.sessionState.pendingPlan = { path, plan, at: new Date().toISOString(), steps };
    this.emit({ type: "plan_proposed", path, plan, steps });
  }

  // ------------------------------------------------------------------ MARK: wave4d w4d-plan — §42.1 plans you can review and follow

  /**
   * `plan_response {approve, into: "new_chat"}`: the plan is implemented in a fresh chat of this worktree, so a conversation
   * long research filled is not carried on. Checked like `session_new` before anything changes; the fresh chat's CLI starts
   * in the approved mode, its summaries follow the plan, and its first message names the plan file — a normal send through
   * the gate. A follow-up that does not go out leaves the plan pending in the fresh chat (`plan_followup_failed`).
   */
  private async planInNewChat(pending: PendingPlan, mode: PermissionMode, custom: string | null): Promise<void> {
    if (!isPermissionMode(mode) || mode === "plan") throw new CommandRefused("invalid_mode");
    this.guardSessionSwitch();
    const prevMode = this.sessionState.permissionMode;
    const prev = { pre: this.prePlanModeNow(), byClaude: this.planByClaude }; // MARK: wave6 w6-terminal (§44.1)
    this.sessionState.pendingPlan = null;
    this.proposedPlanKeys.clear();
    this.restoreMode(mode); // the fresh chat's CLI starts in it
    await this.switchSession(this.sessions!.create(), false);
    this.persistSessions();
    if (!this.session || !this.sessionState.open) return this.planRestore(pending, prevMode, "session_start_failed", prev);
    this.approvedPlan = { path: pending.path, plan: pending.plan };
    this.emit({ type: "plan_approved", mode, path: pending.path, into: "new_chat" });
    this.planImplementNext = true; // MARK: wave5 w5-model (§43.4)
    this.touch();
    let failure: unknown = null;
    let sent = false;
    const failsBefore = this.failCount;
    try {
      sent = await this.send(custom ?? implementPlanText(pending.path, pending.plan));
    } catch (e) {
      failure = e;
    }
    if (sent) return;
    const reason = failure !== null ? errorMessage(failure) : this.failCount !== failsBefore && this.lastError ? this.lastError : "send_failed";
    return this.planRestore(pending, prevMode, reason, prev);
  }

  /** The fresh chat's follow-up did not go out: the plan waits there on its card, in the mode it was proposed in. */
  private async planRestore(pending: PendingPlan, prevMode: PermissionMode, reason: string, prev = { pre: null as PermissionMode | null, byClaude: false }): Promise<void> {
    this.approvedPlan = null;
    this.sessionState.pendingPlan = pending;
    if (this.sessionState.permissionMode !== prevMode) {
      try {
        if (this.session) await this.session.setPermissionMode(prevMode);
        this.sessionState.permissionMode = prevMode;
        this.sessionState.prePlanMode = prev.pre; // MARK: wave6 w6-terminal (§44.1)
        this.planByClaude = prev.byClaude;
        this.persistSessions();
      } catch (e) {
        this.log("warn", `plan_response: restoring permission mode ${prevMode} failed: ${errorMessage(e)}`);
      }
    }
    this.touch();
    this.fail(`The plan answer could not be sent to Claude (${reason}); the plan is still pending.`, false, "session", { code: "plan_followup_failed" });
    throw new CommandRefused(`plan_followup_failed:${reason}`, { code: "plan_followup_failed" });
  }

  /**
   * `plan_response {approve, into: "workbench", path}`: the plan goes to another workbench of this repository (the client
   * created it and opens its window next). Its handoff is written into that worktree's git dir; that window's engine takes
   * it once on `open_project` and implements it in a fresh chat there. This chat stays as it is (its mode too) — only the
   * card is answered.
   */
  private async planToWorkbench(pending: PendingPlan, mode: PermissionMode, path: unknown): Promise<void> {
    if (!isPermissionMode(mode) || mode === "plan") throw new CommandRefused("invalid_mode");
    const cp = this.gate.checkpoint;
    const project = this.project;
    if (!cp || !project) throw new CommandRefused("no_project");
    const target = moveTarget(path, cp.root, await listWorktrees(cp.root));
    if ("refused" in target) throw new CommandRefused(await moveRefusal(target.refused, path, cp.root));
    const targetGitDir = await resolveGitDir(target.root).catch(() => null);
    if (!targetGitDir) throw new CommandRefused("not_a_worktree");
    const handoff: PlanHandoff = {
      version: 1,
      from: { path: project.root, name: basename(project.root) },
      planPath: pending.path,
      plan: pending.plan,
      mode,
      text: implementPlanText(pending.path, pending.plan),
      at: new Date().toISOString(),
    };
    await writePlanHandoff(targetGitDir, handoff);
    this.sessionState.pendingPlan = null;
    this.proposedPlanKeys.clear();
    this.log("info", `plan handed to ${target.root} (${mode})`);
    this.emit({ type: "plan_approved", mode: this.sessionState.permissionMode, path: pending.path, into: "workbench", target: target.root });
    this.touch();
  }

  /** A plan handed to this worktree: implemented in the fresh chat `loadSessions` made, once the session runs (else its card waits). */
  private afterPlanReceived(): void {
    const got = this.receivedPlan;
    this.receivedPlan = null;
    if (!got) return;
    this.approvedPlan = { path: got.planPath, plan: got.plan };
    this.log("info", `plan from ${got.from.path}: implementing in a fresh chat (${got.mode})`);
    if (!canSend(this.slices())) {
      this.sessionState.pendingPlan = { path: got.planPath, plan: got.plan, at: new Date().toISOString(), steps: planStepBriefs(got.plan) };
      this.touch();
      return;
    }
    this.emit({ type: "plan_approved", mode: got.mode, path: got.planPath, into: "workbench", from: got.from.path });
    this.planImplementNext = true; // MARK: wave5 w5-model (§43.4)
    void this.handle({ type: "send", text: got.text });
  }

  /**
   * §49: a task handed to this worktree: its text is the fresh chat's first message — a normal send through the gate — once
   * the session runs; when it cannot take a message the client gets the text back for the composer (`sent: false`).
   */
  private afterTaskReceived(): void {
    const got = this.receivedTask;
    this.receivedTask = null;
    if (!got) return;
    const sent = canSend(this.slices());
    this.log("info", `task from ${got.from.path}: ${sent ? "sent in a fresh chat" : "the session cannot take it yet — back to the composer"} (${this.sessionState.permissionMode})`);
    this.emit({ type: "task_started", text: got.text, mode: this.sessionState.permissionMode, from: got.from.path, sent });
    if (sent) void this.handle({ type: "send", text: got.text });
  }

  /** `plan_follow {path}`: the plan file this chat's summaries follow (kept with the chat); null / "" = the automatic sources. */
  private planFollow(path: unknown): void {
    const root = this.project?.root;
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    if (!root || !meta) throw new CommandRefused("no_project");
    if (path === null || path === undefined || (typeof path === "string" && !path.trim())) {
      delete meta.planFile;
    } else {
      if (typeof path !== "string") throw new CommandRefused("invalid_plan_file", { code: "invalid_plan_file" });
      const abs = resolvePlanPath(path, root, homedir());
      if (readPlanFile(abs) === null) throw new CommandRefused(`invalid_plan_file:${path}`, { code: "invalid_plan_file" });
      meta.planFile = abs;
    }
    this.persistSessions();
    this.touch();
  }

  /** The open chat's plan sources, read back from its rows the first time they are needed after it was opened. */
  private chatPlanMemory(): ChatPlanMemory {
    if (this.chatPlan) return this.chatPlan;
    const mem: ChatPlanMemory = { first: null, named: [], todos: null, tasks: [] };
    for (const row of this.transcript?.tail(PLAN_ROWS_SCAN) ?? []) {
      if (row.kind === "user_message") notePlanMessage(mem, row.text, row.mentions ?? []);
      else if (row.kind === "tool_use" && row.parentToolUseId === undefined) notePlanTool(mem, row.name, row.input);
    }
    this.chatPlan = mem;
    return mem;
  }

  /** Plan files `plan_follow` offers, read again (when the project opens, after a turn). */
  private refreshPlanCandidates(): void {
    const root = this.project?.root ?? this.gate.checkpoint?.root;
    this.planCandidateList = root ? planCandidates(root, join(claudeConfigDir(this.childEnv()), "plans")).map((p) => displayPlanPath(p, root)) : [];
  }

  /** `state.session.planSource`: what the next summary follows (no file is read here) and the plan files to choose from. */
  private planSourceSlice(): { planSource?: PlanSourceState } {
    const root = this.project?.root;
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    if (!root || !meta) return {};
    const candidates = [...this.planCandidateList];
    const shown = (raw: string) => displayPlanPath(resolvePlanPath(raw, root, homedir()), root);
    let view: PlanSourceState;
    if (this.approvedPlan) view = { kind: "approved", ...(this.approvedPlan.path ? { path: this.approvedPlan.path } : {}), candidates };
    else if (meta.planFile) view = { kind: "file", path: shown(meta.planFile), chosen: true, candidates };
    else {
      const mem = this.chatPlanMemory();
      const named = mem.named[mem.named.length - 1];
      if (named) view = { kind: "file", path: shown(named), candidates };
      else if ((mem.todos?.length ?? 0) > 0 || mem.tasks.length > 0) view = { kind: "todos", candidates };
      else if (mem.first?.listed) view = { kind: "message", candidates };
      else if (mem.first && mem.first.mentions.length > 0) view = { kind: "request", candidates };
      else view = { kind: null, candidates };
    }
    if (view.kind === null && candidates.length === 0) return {};
    return { planSource: view };
  }

  /**
   * Without a plan approved here: what the chat itself planned — the plan file it chose (`plan_follow`) or named last, Claude's
   * to-do list, the first message's numbered list — else the first request's @mentioned files ("outside the request").
   */
  private followedPlan(files: string[]): PlanVsActual | null {
    const root = this.project?.root;
    if (!root) return null;
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    const mem = this.chatPlanMemory();
    const fromFile = (raw: string): PlanVsActual | null => {
      const abs = resolvePlanPath(raw, root, homedir());
      const text = readPlanFile(abs);
      if (text === null) return null;
      const steps = parsePlanSteps(text);
      return steps.length > 0 ? planView(steps, files, "file", abs, basename(abs)) : null;
    };
    const chosen = meta?.planFile ? fromFile(meta.planFile) : null;
    if (chosen) return chosen;
    for (const raw of [...mem.named].reverse()) {
      const v = fromFile(raw);
      if (v) return v;
    }
    const todos = mem.todos && mem.todos.length > 0 ? mem.todos : mem.tasks.map((t) => ({ text: t.text, done: t.done, body: t.body }));
    if (todos.length > 0) return planView(todos, files, "todos", null);
    if (!mem.first) return null;
    const listed = messageSteps(mem.first.text);
    if (listed) return planView(listed, files, "message", null);
    return requestScope(mem.first.text, mem.first.mentions, files);
  }

  // ------------------------------------------------------------------ settings / toolchain

  private applySettings(raw: Partial<Settings>): void {
    const before = this.settings;
    if (raw.permissionMode !== undefined && !isPermissionMode(raw.permissionMode)) throw new CommandRefused("invalid_mode");
    if (raw.peerInbound !== undefined && !isPeerInboundMode(raw.peerInbound)) throw new CommandRefused("invalid_peer_mode");
    const peerBefore = this.peerMode();
    // A client may omit fields (`hello` without `budget`): keys present but undefined keep the defaults.
    const partial = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as Partial<Settings>;
    this.settings = { ...before, ...partial };
    if (partial.systemPromptAppend !== undefined) this.promptBudget = budgetNumbers(this.settings.budget); // MARK: wave4 w4-longwork (daily-18)
    if ("largeFileMB" in partial) setLargeFileLimit(largeFileBytes(partial.largeFileMB)); // MARK: wave4b w4b-bigturn (§39.1, live)
    if (partial.budget) this.session?.setBudget(partial.budget);
    if (partial.autoAllowReadOnlyBash !== undefined || partial.bashAllowPatterns !== undefined) {
      this.session?.setPermissionSettings({
        ...(partial.autoAllowReadOnlyBash !== undefined ? { autoAllowReadOnlyBash: partial.autoAllowReadOnlyBash } : {}),
        ...(partial.bashAllowPatterns !== undefined ? { bashAllowPatterns: partial.bashAllowPatterns } : {}),
      });
    }
    // §33.5: the user's rules switch on / off live (re-read from the settings files).
    if (partial.applyUserAllowRules !== undefined && this.session && this.project) {
      this.userRules = sessionUserRules(this.readUserRules(this.ext?.loadUser ?? this.settings.loadUserSettings !== false), partial.applyUserAllowRules !== false);
      this.session.setPermissionSettings({ userRules: this.userRules });
    }
    // §33.7: turning persistence on saves the current set, off removes the file.
    if (partial.persistSessionAllows !== undefined && partial.persistSessionAllows !== (before.persistSessionAllows === true)) {
      if (partial.persistSessionAllows) this.saveAllows();
      else this.clearPersistedAllows();
    }
    // §33.1: queued requests a new pattern / rule now covers are answered.
    if (partial.autoAllowReadOnlyBash !== undefined || partial.bashAllowPatterns !== undefined || partial.applyUserAllowRules !== undefined) this.resolveCoveredPermissions();
    // The mode of a LIVE session only changes through `set_permission_mode`; from the settings it
    // takes effect at the next session start (docs/M20-MODES.md).
    if (partial.permissionMode !== undefined && !this.session) this.restoreMode(partial.permissionMode);
    // §29: a project without its own `peer_set` follows the setting, live.
    if (peerFlag(this.peerMode()) !== peerFlag(peerBefore)) void this.applyPeerFlag();
    if (partial.ghHost !== undefined) this.pr.host = partial.ghHost.trim() || this.pr.host;
    if (partial.claudePath !== before.claudePath || partial.ghPath !== before.ghPath || partial.gitPath !== before.gitPath) {
      if (partial.claudePath !== undefined || partial.ghPath !== undefined || partial.gitPath !== undefined) {
        this.toolchainPromise = null;
      }
    }
    // MARK: wave6 w6-statusline — §44.2: the status line follows its two settings (and "my hooks off") live — when they
    // change, not whenever a client sends its whole settings again.
    const statusSwitches = (s: Settings) => `${s.showStatusLine !== false}|${s.allowedProjectStatusLine ?? ""}|${s.disableUserHooks === true}|${s.loadLocalSettings !== false}`;
    if (statusSwitches(before) !== statusSwitches(this.settings)) this.statusLine.settingsChanged();
  }

  private childEnv(): Record<string, string | undefined> {
    return { ...process.env, ...this.baseEnv, ...this.clientEnv };
  }

  private locate(): Promise<Toolchain> {
    if (!this.toolchainPromise) {
      const s = this.settings;
      this.toolchainPromise = locateToolchain(this.platform, this.childEnv(), {
        claude: s.claudePath,
        gh: s.ghPath,
        git: s.gitPath,
      }).then((tc) => {
        this.toolchain = { claude: tc.claude, gh: tc.gh, git: tc.git, claudeVersion: tc.claudeVersion, ghVersion: tc.ghVersion };
        this.toolchainPath = tc.path;
        if (tc.git) setGitPath(tc.git);
        this.touch();
        return tc;
      });
    }
    return this.toolchainPromise;
  }

  private async resolveGH(): Promise<ResolvedGH> {
    const tc = await this.locate();
    if (!tc.gh) throw new Error("gh CLI not found. Install GitHub CLI or set its path in Settings.");
    return { path: tc.gh, env: { ...this.childEnv(), PATH: tc.path } };
  }

  // ------------------------------------------------------------------ project lifecycle

  private async openProject(path: string, takeover: boolean): Promise<void> {
    this.cancelAutoRestart();
    await this.side.stopAll();
    await this.side.load(null);
    await this.stopSession();
    await this.releaseProjectLock();
    this.resetProjectState();
    this.touch();
    let cp: GitCheckpoint;
    try {
      cp = await openCheckpoint(path);
    } catch (e) {
      if (e instanceof NotARepositoryError) {
        this.gitInit = { path, candidates: findGitCandidates(path), looksUnsafe: looksUnsafeForGitInit(path) };
        this.touch();
        return;
      }
      this.fail(errorMessage(e), true, "git", { code: "project_open_failed" });
      return;
    }
    await this.lockProject(cp, takeover);
    await this.adoptCheckpoint(cp, path);
  }

  /**
   * Writes `<gitdir>/reviewgate.lock` (docs/M10-WORKBENCHES.md). A live lock by another session
   * refuses the open with `locked_by_other_session:<pid>` and sets `state.lockConflict`; the lock is
   * advisory — `takeover` overwrites it and the other engine keeps running.
   */
  private async lockProject(cp: GitCheckpoint, takeover: boolean): Promise<void> {
    let dir: string;
    try {
      dir = await resolveGitDir(cp.root);
    } catch (e) {
      this.log("warn", `lock: ${errorMessage(e)}`);
      return;
    }
    let result: Awaited<ReturnType<typeof acquireLock>>;
    try {
      result = await acquireLock(dir, this.lockOwner, { takeover });
    } catch (e) {
      this.log("warn", `lock: ${errorMessage(e)}`);
      return;
    }
    if (!result.ok) {
      const c = result.conflict;
      this.lockConflict = { path: cp.root, pid: c.pid, since: c.since, client: c.client };
      this.touch();
      throw new CommandRefused(`locked_by_other_session:${c.pid}`);
    }
    this.lockedGitDir = dir;
  }

  private async releaseProjectLock(): Promise<void> {
    const dir = this.lockedGitDir;
    this.lockedGitDir = null;
    if (dir) await releaseLock(dir, this.lockOwner).catch(() => undefined);
  }

  private async initRepo(): Promise<void> {
    const pending = this.gitInit;
    if (!pending) throw new CommandRefused("git_init_not_needed");
    this.gitInit = null;
    this.touch();
    let cp: GitCheckpoint;
    try {
      await initRepository(pending.path);
      cp = await openCheckpoint(pending.path);
    } catch (e) {
      this.fail(errorMessage(e), true, "git", { code: "git_init_failed" });
      return;
    }
    await this.lockProject(cp, false);
    await this.adoptCheckpoint(cp, pending.path);
  }

  private async adoptCheckpoint(cp: GitCheckpoint, path: string): Promise<void> {
    this.gate.checkpoint = cp;
    this.projectGitDir = await resolveGitDir(cp.root).catch((e) => {
      this.log("warn", `gitdir: ${errorMessage(e)}`);
      return null;
    });
    if (this.projectGitDir) {
      const common = await commonDir(cp.root).catch(() => this.projectGitDir!);
      this.gate.refNs = refNamespace(this.projectGitDir, common);
      this.history = await loadHistory(this.projectGitDir);
      this.projectCommonDir = common; // MARK: wave3 engine-session (§36.5)
      this.autoAcceptRules = await loadAutoAcceptRules(common).catch(() => ({})); // MARK: wave4c w4c-trust (§41.2)
    }
    const current = await this.loadSessions();
    await this.restoreRememberedAllows();
    this.cachedCapabilities = this.projectGitDir ? await loadCapabilities(this.projectGitDir) : null;
    // MARK: wave3 engine-session — §36.5: a worktree without its own cache (a new workbench) replays the repository's.
    if (!this.cachedCapabilities && this.projectCommonDir && this.projectGitDir && !samePath(this.projectCommonDir, this.projectGitDir)) {
      this.cachedCapabilities = await loadCapabilities(this.projectCommonDir);
    }
    // §36.7: the repository's start history sets the init watchdog's adaptive limit.
    this.startHistory = this.projectCommonDir ? await loadStartHistory(this.projectCommonDir) : [];
    this.applyCachedCapabilities();
    const [branch, remoteURL] = await Promise.all([cp.branchName(), cp.remoteURL()]);
    this.codeGraph.reset(); // MARK: wave5 w5-graph — §43.3: another project's report, freshness and build are not this one's
    this.project = { path, root: cp.root, name: basename(path), branch, remoteURL };
    this.statusLine.projectChanged(); // MARK: wave6 w6-statusline — §44.2: the last project's lines go now, a run of it stops
    // MARK: wave5 w5-brain — §43.2: the session's baseline of the memory folder (read in the background).
    this.refreshBrainDir();
    void this.subBrain.scan().catch(() => undefined);
    this.commitSlice.identity = await gitIdentity(cp.root);
    this.startDiskWatch(); // MARK: wave4b w4b-bigturn (§39.1)
    this.touch();
    await this.restoreReview();
    await this.applyReceivedBaseline(); // MARK: wave4b w4b-follow — §39.4
    this.pruneHistoryRefs();
    this.pruneTurnRefs();
    this.pruneRangeRefs();
    this.fileIndex = new FileIndex(() => listRepoFiles(cp));
    this.refreshPlanCandidates(); // MARK: wave4d w4d-plan (§42.1)
    if (this.gate.refNs === "main") void this.pruneWorktreeNamespaces(cp);
    this.restoreAgentHistory(); // MARK: wave4d w4d-agents2 (§42.4)
    this.emit(this.restoreEvent()); // MARK: wave4 w4-history — §38.3 (+ start / sessionId)
    await this.refreshBranches();
    await this.refreshWorkbenches(false);
    // §31: before the session starts — nothing may be awaited between the start and the reply, or a restart the start
    // queued (the §16 init-timeout fallback) would let a snapshot of the abandoned session out first. The engine's own
    // CLI processes are never listed (their parent is the engine), so the order does not change the result.
    await this.checkConcurrent("open");
    // MARK: wave2 check-engine — §35.4: a record is never resumed again (the CLI has no conversation for it).
    // MARK: wave4b w4b-follow — §39.4: a chat handed to another worktree is a record here (its conversation goes on there).
    if (current?.resumeFailed === true || current?.movedTo !== undefined) await this.startSession(path, null, this.recordOnlyId());
    else if (current && this.isResumable(current)) await this.startSession(path, current.id);
    else await this.startSession(path, null, current?.id ?? null);
    this.afterReceived(); // MARK: wave4b w4b-follow — §39.4 (nothing awaited after the start)
    this.afterPlanReceived(); // MARK: wave4d w4d-plan — §42.1
    this.afterTaskReceived(); // §49
  }

  /**
   * §31: other Claude Code processes whose cwd is this worktree (a terminal session, an IDE plugin, another app) write
   * into the same files; their changes reach the review as `external`. Checked when the project opens and on every
   * send: `state.gate.concurrentClaude`, plus `concurrent_claude` while there are any.
   */
  private async checkConcurrent(at: "open" | "send"): Promise<void> {
    const cp = this.gate.checkpoint;
    if (!cp) return;
    const own = this.session?.pid;
    const sessions = await findConcurrentClaude({
      configDir: claudeConfigDir(this.childEnv()),
      root: cp.root,
      selfPid: process.pid,
      ...(own !== undefined ? { excludePids: new Set([own]) } : {}),
    }).catch((e) => {
      this.log("warn", `concurrent Claude check: ${errorMessage(e)}`);
      return null;
    });
    if (sessions === null || this.gate.checkpoint !== cp) return;
    this.gate.concurrentClaude = sessions;
    if (sessions.length > 0) {
      this.log("warn", `${sessions.length} other Claude process(es) work in this worktree: ${sessions.map((s) => `${s.pid}${s.name ? ` (${s.name})` : ""}`).join(", ")}`);
      this.emit({ type: "concurrent_claude", at, sessions: sessions.map((s) => ({ ...s })) });
    }
    this.touch();
  }

  /** Shows the cached capabilities (`capabilitiesCached: true`) until the CLI's `session_info` replaces them (docs/M16-FRICTION.md). */
  private applyCachedCapabilities(): void {
    if (!this.cachedCapabilities || this.sessionState.capabilities !== null) return;
    this.sessionState.capabilities = this.cachedCapabilities;
    this.sessionState.capabilitiesCached = true;
    // MARK: wave3 engine-session — §36.5: the last session's `state` is not this one's (startSession sets it).
    if (this.cachedCapabilities.state !== undefined) {
      const { state: _state, ...cached } = this.cachedCapabilities;
      this.sessionState.capabilities = cached;
    }
  }

  // ------------------------------------------------------------------ chat sessions (docs/M15-POLISH.md)

  /**
   * Opens `<gitdir>/reviewgate/sessions/` (migrating the legacy transcript), picks the current session
   * from `reviewgate-session.json` (a new "New chat" when none) and binds its transcript. Returns the
   * current meta (null without a gitdir).
   */
  private async loadSessions(): Promise<SessionMeta | null> {
    const dir = this.projectGitDir;
    if (!dir) return null;
    const stored = await loadSessionState(dir);
    // The stored mode is restored as-is, `plan` included (docs/M20-MODES.md): the user may have parked here. A worktree
    // without one (a new workbench) starts as its repository's other worktrees ran last, then as the client says (§11).
    const sibling = stored.permissionMode === null && this.projectCommonDir ? await siblingWorktreeMode(dir, this.projectCommonDir) : null;
    this.restoreMode(stored.permissionMode ?? sibling ?? this.settings.permissionMode ?? "default");
    this.modelChoice = { ...(stored.model !== undefined ? { model: stored.model } : {}), ...(stored.effort !== undefined ? { effort: stored.effort } : {}) };
    this.peerChoice = stored.peerInbound;
    const idx = await SessionIndex.open(dir, stored.sessionId, (m) => this.log("warn", m));
    this.sessions = idx;
    const received = await this.takeIncoming(idx, dir); // MARK: wave4b w4b-follow — §39.4: a chat handed here is the current one
    // MARK: wave4d w4d-plan — §42.1: a plan handed here is implemented in a fresh chat, in the mode it was approved for (a
    // moved chat comes first: the plan waits for the next open).
    const planIn = received ? null : takePlanHandoff(dir);
    if (planIn) {
      this.receivedPlan = planIn;
      this.restoreMode(planIn.mode);
    }
    // §49: a task started here from another window gets a fresh chat too (a moved chat or a plan comes first: it waits).
    const taskIn = received || planIn ? null : takeTaskHandoff(dir);
    if (taskIn) {
      this.receivedTask = taskIn;
      if (taskIn.mode) this.restoreMode(taskIn.mode);
    }
    const existing = stored.sessionId ? idx.get(stored.sessionId) : undefined;
    const current = received ?? (planIn || taskIn ? idx.create() : undefined) ?? existing ?? idx.create();
    this.openTabIds = [...new Set(stored.openTabIds.filter((id) => idx.get(id) !== undefined))];
    this.bindSession(current);
    await this.side.load(current.id);
    void this.side.pruneFiles(idx.list().map((m) => m.id)).catch(() => undefined);
    for (const n of await loadMcpPrefs(dir)) this.mcpDisabled.add(n);
    await this.loadMcpScopes(dir); // MARK: wave4d w4d-config (§42.3)
    return current;
  }

  /** Makes `meta` the current session: transcript, turn counter, tab, session file. */
  private bindSession(meta: SessionMeta): void {
    const idx = this.sessions!;
    this.currentSessionId = meta.id;
    if (!this.openTabIds.includes(meta.id)) this.openTabIds.push(meta.id);
    this.transcript = idx.transcript(meta.id);
    this.chatPlan = null; // MARK: wave4d w4d-plan — §42.1: read back from this chat's rows when needed
    this.turn = meta.turns;
    this.turnText = "";
    this.turnTextUnprompted = false;
    this.bindCheckpoints(meta.id);
    this.persistSessions();
  }

  /**
   * A session the CLI knows (§30): a message was sent to it, it reported its id (`cliKnown`, persisted — also for a turn
   * it ran on its own, e.g. a peer message), or its record file exists. Such a chat is resumed, never started again with
   * `--session-id` (the CLI refuses that: "Session ID … is already in use"). MARK: wave2 check-engine — §35.5:
   * `countLastUserText` false when that text may be a message the CLI never took (a resend after its restart).
   */
  private isResumable(meta: SessionMeta, countLastUserText = true): boolean {
    return meta.turns > 0 || (countLastUserText && meta.lastUserText !== null) || meta.cliKnown === true || this.confirmedSessionIds.has(meta.id) || this.cliHasRecord(meta.id);
  }

  /** The CLI's `<config>/projects/<cwd key>/<id>.jsonl` exists for the open project (a positive signal only, §30). */
  private cliHasRecord(id: string): boolean {
    const cwd = this.project?.path;
    return cwd ? cliSessionExists(cwd, id, this.childEnv()) : false;
  }

  private requireSession(id: string): SessionMeta {
    const meta = this.sessions?.get(id);
    if (!meta) throw new CommandRefused(this.sessions ? `unknown_session:${id}` : "no_project");
    return meta;
  }

  /**
   * `session_new` / `session_open` are refused while a turn, collection or revert is in flight
   * (`session_busy`), and while the review is bound to *this* conversation: a failed collection
   * (`collect_failed`, the retry belongs here), files sent back with notes (`review_pending`) or
   * unsent notes (`notes_pending`). Plain pending files do not block — the review is worktree state
   * that outlives the chat, so a new chat can be opened next to it.
   */
  private guardSessionSwitch(): void {
    if (!this.project || this.gitInit !== null || !this.sessions) throw new CommandRefused("no_project");
    if (this.sessionState.starting || this.gate.running || this.gate.collecting || this.gate.reverting) throw new CommandRefused("session_busy");
    if (this.gate.collectError !== null) throw new CommandRefused("collect_failed");
    if (this.gate.changesRequestedFiles.length > 0) throw new CommandRefused("review_pending");
    // §34.4: sent notes ("요청함") are reminders, not pending notes.
    if (this.gate.unsentNoteCount > 0) throw new CommandRefused("notes_pending");
  }

  private async sessionNew(): Promise<void> {
    this.guardSessionSwitch();
    await this.switchSession(this.sessions!.create(), false);
  }

  private async sessionOpen(id: string): Promise<void> {
    this.guardSessionSwitch();
    const meta = this.requireSession(id);
    if (meta.id === this.currentSessionId) {
      this.emit(this.restoreEvent()); // MARK: wave4 w4-history — §38.3 (+ start / sessionId)
      return;
    }
    await this.switchSession(meta, this.isResumable(meta));
  }

  /** Stops the live Claude session, binds `meta`, replays its transcript and starts (resume or fresh with its id). */
  private async switchSession(meta: SessionMeta, resume: boolean): Promise<void> {
    const project = this.project!;
    this.cancelAutoRestart();
    await this.side.stopAll();
    await this.stopSession();
    this.recordOnlyNext = null; // MARK: wave2 check-engine — §35.4: leaving a record before a turn made nothing
    this.sessionState = this.freshSessionState(); // MARK: wave6 w6-terminal — §44.1 (the user's mode; was: the same mode)
    this.sessionState.rememberedAllows = [...this.rememberedAllows];
    this.applyCachedCapabilities();
    this.hud = initialHud();
    this.chatLines = { added: 0, removed: 0 }; // MARK: wave6 w6-statusline (§44.2)
    this.contextWarned = false;
    this.agents.reset();
    this.budgetUsage = { ...ZERO_USAGE };
    this.autoRestartsThisTurn = 0;
    this.approvedPlan = null;
    this.bindSession(meta);
    await this.side.load(meta.id);
    this.restoreAgentHistory(); // MARK: wave4d w4d-agents2 (§42.4)
    this.touch();
    this.emit(this.restoreEvent()); // MARK: wave4 w4-history — §38.3 (+ start / sessionId)
    // MARK: wave2 check-engine — §35.4: a record shows its rows; the CLI starts fresh for whatever comes next.
    // MARK: wave4b w4b-follow — §39.4: a chat handed to another worktree opens as a record here.
    if (meta.resumeFailed === true || meta.movedTo !== undefined) await this.startSession(project.path, null, this.recordOnlyId());
    else if (resume) await this.startSession(project.path, meta.id);
    else await this.startSession(project.path, null, meta.id);
  }

  // MARK: wave2 check-engine — §35.4 record-only chats

  /** MARK: wave3 check-engine — §37.4: the open chat is a record (`resumeFailed`): the CLI no longer has its conversation. */
  private openChatIsRecord(): boolean {
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    return meta?.resumeFailed === true || meta?.movedTo !== undefined; // MARK: wave4b w4b-follow (§39.4)
  }

  /** The id the fresh CLI of the open record starts with — the same across restarts until a turn makes it a chat. */
  private recordOnlyId(): string {
    this.recordOnlyNext ??= randomUUID();
    return this.recordOnlyNext;
  }

  /**
   * The first turn from a record (a send, request_changes, peer_accept, or one the CLI starts by itself): its new chat is
   * created now — once, with the id its CLI runs under — and becomes current (its tab, an empty `transcript_restore`);
   * the record stays as it was. A no-op otherwise.
   */
  private adoptRecordOnly(): Promise<void> {
    const id = this.recordOnlyNext;
    const idx = this.sessions;
    if (id === null || !idx) return Promise.resolve();
    this.recordOnlyNext = null;
    this.bindSession(idx.get(id) ?? idx.create(id));
    this.emit({ type: "transcript_restore", items: [] });
    this.touch();
    // The record's side questions stay with it.
    return this.side.stopAll().then(() => this.side.load(id)).catch((e: unknown) => this.log("warn", `side threads: ${errorMessage(e)}`));
  }

  /**
   * The CLI reported `reported` for the current session. Usually equal to the pre-chosen id; when it
   * differs (id not honoured, test double) the meta + transcript file follow the CLI's id.
   */
  private adoptReportedSessionId(reported: string): void {
    // MARK: wave2 check-engine — §35.4: a turn the CLI ran from a record (one it started by itself) is the new chat's.
    if (this.recordOnlyNext !== null) void this.adoptRecordOnly();
    const idx = this.sessions;
    const current = this.currentSessionId;
    this.confirmedSessionIds.add(reported);
    if (!idx || !current || current === reported) return;
    const meta = idx.get(current);
    if (!meta) return;
    idx.rename(current, reported);
    this.currentSessionId = reported;
    this.gate.renameSession(current, reported);
    if (this.history.some((e) => e.sessionId === current)) {
      for (const e of this.history) if (e.sessionId === current) e.sessionId = reported;
      this.saveHistoryFile();
    }
    this.openTabIds = [...new Set(this.openTabIds.map((id) => (id === current ? reported : id)))];
    this.transcript = idx.transcript(reported);
    if (this.projectGitDir) renameCheckpoints(this.projectGitDir, current, reported);
    this.side.rebind(reported);
    this.log("debug", `session ${current} is ${reported} according to the CLI`);
  }

  /** `reviewgate-session.json` (current id + open tabs) and `sessions/index.json`, serialized behind the persist chain. */
  private persistSessions(): void {
    const dir = this.projectGitDir;
    const idx = this.sessions;
    const id = this.currentSessionId;
    if (!dir || !idx || !id) return;
    const tabs = [...this.openTabIds];
    const mode = this.userMode(); // MARK: wave6 w6-terminal — §44.1: never Claude's own plan mode
    const choice = { ...this.modelChoice, ...(this.peerChoice ? { peerInbound: this.peerChoice } : {}) };
    this.persistChain = this.persistChain
      .then(async () => {
        await saveSession(dir, id, tabs, mode, choice);
        await idx.save();
      })
      .catch((e) => this.log("warn", `persist sessions: ${errorMessage(e)}`));
  }

  // MARK: wave4d w4d-agents2
  /** §42.4: `hud.turnModels` = the finished turn's models (none: cleared), `hud.sessionModels` their running sum. */
  private noteTurnModels(models: ModelCost[] | undefined): void {
    if (!models || models.length === 0) {
      delete this.hud.turnModels;
      return;
    }
    this.hud.turnModels = models.map((m) => ({ ...m }));
    this.hud.sessionModels = addModelCosts(this.hud.sessionModels ?? [], models);
  }

  /** Every turn end (normal or abnormal) accumulates into the current session's meta. */
  private noteTurnEnd(usage: TurnUsage | null): void {
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    if (!meta) return;
    meta.turns += 1;
    meta.costUSD += usage?.costUsd ?? 0;
    meta.updatedAt = new Date().toISOString();
    this.persistSessions();
  }

  /**
   * `refresh` (docs/M15-POLISH.md): `review` re-snapshots B and re-diffs while reviewing; `branches` /
   * `workbenches` (with per-worktree dirty) and the git identity while a project is open; `pr` /
   * `accounts` re-run `pr_list` (+ `pr_reload_comments`) / `accounts` on the PR lane — by default only
   * when the PR browser was used before. `scope` null = every applicable one.
   */
  private async refresh(scope: RefreshScope[] | null): Promise<void> {
    const wants = (s: RefreshScope) => scope === null || scope.includes(s);
    const cp = this.gate.checkpoint;
    if (wants("review")) this.fileIndex?.invalidate();
    if (cp && wants("review") && gatePhase(this.slices()) === "reviewing") {
      try {
        await this.followHeadMove(false);
        await this.gate.refresh();
      } catch (e) {
        this.fail(`Failed to refresh the review: ${errorMessage(e)}`, false, "git", { code: "refresh_failed" });
        throw new CommandRefused(errorMessage(e), { code: "refresh_failed" });
      }
      this.touch();
    }
    // MARK: wave4c w4c-trust — §41.2: [되돌리기] after a reject is offered only while the file is as the reject left it.
    if (cp && wants("review") && (await this.gate.recheckRejectUndo())) this.touch();
    if (cp && wants("branches")) await this.refreshBranches();
    if (cp && wants("workbenches")) await this.refreshWorkbenches(true, true); // wave4 w4-install: an explicit refresh re-checks all
    if (cp && (wants("branches") || wants("workbenches"))) {
      this.commitSlice.identity = await gitIdentity(cp.root);
      this.touch();
    }
    const prUsed = this.pr.mine.length > 0 || this.pr.reviewRequested.length > 0 || this.pr.selected !== null;
    if (scope?.includes("pr") || (scope === null && prUsed)) {
      void this.handle({ type: "pr_list" });
      if (this.pr.selected) void this.handle({ type: "pr_reload_comments" });
    }
    if (scope?.includes("accounts") || (scope === null && this.pr.accounts.length > 0)) void this.handle({ type: "accounts" });
  }

  private async closeProject(): Promise<void> {
    this.cancelAutoRestart();
    await this.side.stopAll();
    await this.side.load(null);
    await this.stopSession();
    // Nothing pending: the persisted review has served its purpose (accepted files stay on disk).
    // Chained behind the in-flight writes so a late save cannot resurrect the file. (§34.4: sent notes do not count.)
    if (!this.gate.hasPendingReview && this.gate.unsentNoteCount === 0) {
      // The persisted review (and its round) goes away: the round is complete (accepted files stay on disk).
      if (!this.gate.isRequestingChanges) this.gate.completeRound();
      this.persistChain = this.persistChain.then(() => this.clearPersistedReview()).catch((e) => this.log("warn", `persist: ${errorMessage(e)}`));
    }
    await this.persistChain.catch(() => undefined);
    await this.releaseProjectLock();
    this.resetProjectState();
    this.touch();
  }

  // ------------------------------------------------------------------ review persistence (docs/PROTOCOL.md §8)

  /** Mirrors the gate to `<gitdir>/reviewgate-review.json` + `refs/reviewgate/*` after every mutation (serialized, best effort). */
  private persistReview(): void {
    this.prereviews.sync(); // MARK: wave3 engine-flow — §36.13: a fork whose round ended stops; a turn's own report joins its review
    const dir = this.projectGitDir;
    const cp = this.gate.checkpoint;
    if (!dir || !cp) return;
    if (this.gate.isFullyResolved) {
      this.persistChain = this.persistChain.then(() => this.clearPersistedReview()).then(() => this.saveOk("review")).catch((e) => this.log("warn", `persist: ${errorMessage(e)}`));
      return;
    }
    const review: PersistedReview = {
      ...this.gate.persisted(),
      lastUserText: this.commitSlice.lastUserText,
      sessionId: this.sessionState.sessionId,
      savedAt: new Date().toISOString(),
    };
    this.reviewUpdatedAt = review.savedAt;
    this.persistChain = this.persistChain
      .then(async () => {
        if (this.gate.checkpoint !== cp) return;
        if (this.pinned.start !== review.turnStartTree || this.pinned.end !== review.turnEndTree) {
          await this.gate.pinRefs();
          this.pinned = { start: review.turnStartTree, end: review.turnEndTree };
        }
        // §34.1: the trees a diff range refers to (turn base, request tree, accepted trees, the held B).
        const rangeKey = this.gate.rangeTrees().join(" ");
        if (rangeKey !== this.pinnedRangeKey) {
          await this.gate.pinRanges();
          this.pinnedRangeKey = rangeKey;
        }
        // The round's trees (rejected proposals included) are pinned under its future history id.
        const partial = review.round ? completeRound(review.round) : null;
        const key = partial ? JSON.stringify(entryTreeRefs(this.gate.refNs, partial)) : "";
        if (partial && key !== this.pinnedRoundKey) {
          await this.pinEntryTrees(cp, partial);
          this.pinnedRoundKey = key;
        }
        // §31: HEAD at save time; the restore compares it with HEAD then (`gate.stale`).
        await saveReview(dir, { ...review, head: await cp.head().catch(() => null) });
        this.saveOk("review"); // MARK: wave4b w4b-bigturn (§39.1)
      })
      .catch((e) => this.saveFailed("review", e, "persist"));
  }

  private async clearPersistedReview(): Promise<void> {
    const dir = this.projectGitDir;
    if (!dir) return;
    await clearReview(dir);
    await this.gate.unpinRefs().catch((e) => this.log("warn", `unpin: ${errorMessage(e)}`));
    this.pinned = { start: null, end: null };
    this.pinnedRangeKey = "";
  }

  // ------------------------------------------------------------------ review history (docs/PROTOCOL.md §14)

  /** A finished round: appended (newest last, capped), its trees pinned, the refs of dropped entries deleted. */
  private recordHistory(entry: ReviewHistoryEntry): void {
    const dir = this.projectGitDir;
    const cp = this.gate.checkpoint;
    if (!dir || !cp) return;
    const { entries, dropped } = appendCapped(this.history, entry);
    this.history = entries;
    const ns = this.gate.refNs;
    this.persistChain = this.persistChain
      .then(async () => {
        await this.pinEntryTrees(cp, entry);
        await saveHistory(dir, entries);
        this.saveOk("history"); // MARK: wave4b w4b-bigturn (§39.1)
        for (const d of dropped) await cp.deleteRefsUnder(`${refPrefix(ns)}history/${d.id}/`);
      })
      .catch((e) => this.saveFailed("history", e, "persist history"));
  }

  private async pinEntryTrees(cp: GitCheckpoint, entry: ReviewHistoryEntry): Promise<void> {
    for (const { ref, sha } of entryTreeRefs(this.gate.refNs, entry)) await cp.pinRef(ref, sha);
  }

  private saveHistoryFile(): void {
    const dir = this.projectGitDir;
    if (!dir) return;
    const entries = [...this.history];
    this.persistChain = this.persistChain.then(() => saveHistory(dir, entries)).then(() => this.saveOk("history")).catch((e) => this.saveFailed("history", e, "persist history"));
  }

  /** Deletes `refs/reviewgate/<ns>/history/<id>/…` of ids that are neither in the history nor the round in progress. */
  private pruneHistoryRefs(): void {
    const cp = this.gate.checkpoint;
    if (!cp) return;
    const keep = new Set([...this.history.map((e) => e.id), ...(this.gate.round ? [this.gate.round.id] : [])]);
    const prefix = `${refPrefix(this.gate.refNs)}history/`;
    this.persistChain = this.persistChain
      .then(async () => {
        const out = await cp.git(["for-each-ref", "--format=%(refname)", prefix], { allowFailure: true });
        const ids = new Set(out.text.split("\n").map((l) => l.trim().slice(prefix.length).split("/")[0]).filter((id): id is string => !!id));
        for (const id of ids) if (!keep.has(id)) await cp.deleteRefsUnder(`${prefix}${id}/`);
      })
      .catch((e) => this.log("warn", `prune history refs: ${errorMessage(e)}`));
  }

  /**
   * Deletes `refs/reviewgate/wt-<name>/…` of linked worktrees that no longer exist (no
   * `<common>/worktrees/<name>`): their review / history pins would otherwise keep the trees forever.
   * Run on `open_project` of the main worktree and after `workbench_remove` / `workbench_prune`.
   */
  private pruneWorktreeNamespaces(cp: GitCheckpoint): Promise<void> {
    const run = this.persistChain.then(async () => {
      const common = await commonDir(cp.root);
      const refs = await cp.refsUnder("refs/reviewgate/");
      const admin = await readdir(join(common, "worktrees")).catch(() => [] as string[]);
      for (const ns of staleWorktreeNamespaces(refs, admin, common)) {
        await cp.deleteRefsUnder(refPrefix(ns));
        this.log("info", `pruned refs of removed worktree namespace ${ns}`);
      }
    });
    this.persistChain = run.catch((e) => this.log("warn", `prune worktree refs: ${errorMessage(e)}`));
    return this.persistChain;
  }

  /**
   * `history_diff`: the file's diff between the entry's pinned trees — the proposal (a rejected or partially
   * reverted file: the B that still held all of it), or with `final` the round's last B (what was left).
   */
  private async historyDiff(entryId: string, path: string, final = false): Promise<HistoryDiffEvent> {
    const cp = this.requireProject();
    // §34.4: the round in progress (`review_history.current`) diffs its A → reviewEndTree (or the file's endTree).
    const current = this.gate.round?.id === entryId ? this.gate.roundInProgress(this.reviewUpdatedAt) : null;
    const entry = this.history.find((e) => e.id === entryId) ?? current;
    if (!entry) throw new CommandRefused(`unknown_history_entry:${entryId}`);
    const file = entry.files.find((f) => f.path === path);
    if (!file) throw new CommandRefused(`not_in_history_entry:${path}`);
    const end = final ? entry.turnEndTree : file.endTree ?? entry.turnEndTree;
    if (!(await cp.hasObjects([entry.turnStartTree, end]))) throw new CommandRefused("history_trees_gone");
    const patch = await cp.patch(entry.turnStartTree, end, file.path, file.oldPath);
    const parsed = parseUnifiedDiff(patch);
    const { diff, truncated } = parsed.isBinary ? { diff: { ...parsed, hunks: [] }, truncated: false } : truncateDiff(parsed);
    // MARK: wave4 w4-history — §38.3: why the round changed it, from its chat's rows.
    const why = this.historyFileWhy(entry, file);
    return { type: "history_diff", entryId, path, diff, truncated, ...(final ? { final: true as const } : {}), why };
  }

  // MARK: wave4 w4-history — §38.3 history that lasts

  /** `transcript_restore` of the current chat: its last rows, the row index they start at and the chat. */
  private restoreEvent(): TranscriptRestoreEvent {
    const store = this.transcript;
    if (!store) return { type: "transcript_restore", items: [] };
    const w = readTranscriptWindow(store.path, null, TRANSCRIPT_RESTORE_ROWS);
    // An empty chat has nothing to page: the event stays as before §38.3.
    if (w.items.length === 0) return { type: "transcript_restore", items: [] };
    // MARK: wave4b w4b-tabs — §39.2: rows saved before the explore mark get it here
    return { type: "transcript_restore", items: markExplore(w.items), start: w.start, sessionId: this.currentSessionId };
  }

  // MARK: wave4d w4d-agents2
  /**
   * §42.4: "이전 턴" after a restart — the chat's finished agents rebuilt from its last rows (§38.3 keeps them) into an
   * empty tracker (a fresh engine, a chat just opened); a tracker that already has a history keeps its own.
   */
  private restoreAgentHistory(): void {
    const store = this.transcript;
    if (!store) return;
    try {
      const rows = readTranscriptWindow(store.path, null, TRANSCRIPT_PAGE_MAX).items;
      if (this.agents.restoreHistory(agentHistoryFromRows(rows, (abs) => this.repoRelative(abs)))) this.agentsChanged(false);
    } catch (e) {
      this.log("warn", `agent history from the rows: ${errorMessage(e)}`);
    }
  }

  /** `transcript_page`: rows of a chat (default the current one) before row `before`; kept agent reports stay out. */
  private transcriptPage(sessionId: unknown, before: unknown, beforeAt: unknown, limit: unknown): TranscriptPageEvent {
    const idx = this.sessions;
    if (!idx) throw new CommandRefused("no_project");
    const id = typeof sessionId === "string" && sessionId ? sessionId : this.currentSessionId;
    if (!id || !idx.get(id)) throw new CommandRefused(`unknown_session:${id ?? ""}`);
    const end = typeof before === "number" && Number.isFinite(before) && before >= 0 ? Math.floor(before) : null;
    const n = typeof limit === "number" && Number.isFinite(limit) ? Math.min(TRANSCRIPT_PAGE_MAX, Math.max(1, Math.floor(limit))) : TRANSCRIPT_PAGE_ROWS;
    const path = id === this.currentSessionId && this.transcript ? this.transcript.path : idx.transcript(id).path;
    const w = readTranscriptWindow(path, end, n, typeof beforeAt === "string" ? beforeAt : undefined);
    const items = markExplore(withoutReports({ type: "transcript_restore", items: w.items }).items); // MARK: wave4b w4b-tabs (§39.2)
    return { type: "transcript_page", sessionId: id, items, start: w.start, before: w.end };
  }

  /** `transcript_search`: per chat (newest first) its newest user message / Claude answer containing `query`. */
  private async transcriptSearch(query: unknown, limit: unknown, perChat?: unknown): Promise<TranscriptSearchEvent> {
    const idx = this.sessions;
    if (!idx) throw new CommandRefused("no_project");
    const q = typeof query === "string" ? query.trim().slice(0, TRANSCRIPT_SEARCH_MAX_QUERY) : "";
    const max = typeof limit === "number" && Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : TRANSCRIPT_SEARCH_HITS;
    const per = perChatOf(perChat); // MARK: wave4c w4c-review — §41.3: 1 = the §38.3 reply, unchanged
    const matches: TranscriptSearchMatch[] = [];
    if (q) {
      for (const meta of idx.list()) {
        if (matches.length >= max) break;
        const path = meta.id === this.currentSessionId && this.transcript ? this.transcript.path : idx.transcript(meta.id).path;
        if (per > 1) {
          const many = await readFile(path, "utf8").then((text) => searchTranscriptMany(text, q, per), () => null);
          if (many) matches.push({ sessionId: meta.id, title: meta.title, ...many });
          continue;
        }
        const m = await searchTranscriptFile(path, q);
        if (m) matches.push({ sessionId: meta.id, title: meta.title, ...m });
      }
    }
    return { type: "transcript_search", query: typeof query === "string" ? query : "", matches };
  }

  // MARK: wave4c w4c-review — §41.3 review leftovers

  /** `select_file {ignoreWhitespace}`: the range of `ev` diffed again with `-w` (a binary keeps its own reply). */
  private async ignoringWhitespace(ev: FileDiffEvent): Promise<FileDiffEvent> {
    const cp = this.gate.checkpoint;
    const file = this.gate.changedFiles.find((f) => f.path === ev.path);
    if (!cp || !file || ev.diff.isBinary || !ev.baseTree || !ev.endTree) return ev;
    const parsed = parseUnifiedDiff(await ignoreWhitespacePatch(cp, ev.baseTree, ev.endTree, file.path, file.oldPath));
    // Nothing but whitespace changed: still name the file (as an empty range does, §34.1).
    const named = parsed.hunks.length === 0 ? { ...parsed, oldPath: parsed.oldPath ?? file.oldPath ?? file.path, newPath: parsed.newPath ?? file.path } : parsed;
    const { diff, truncated } = truncateDiff(named);
    const meta = { ...(ev.diff.oldMode !== undefined ? { oldMode: ev.diff.oldMode } : {}), ...(ev.diff.newMode !== undefined ? { newMode: ev.diff.newMode } : {}), ...(ev.diff.similarity !== undefined ? { similarity: ev.diff.similarity } : {}) };
    return { ...ev, diff: { ...diff, ...meta }, truncated, ignoreWhitespace: true };
  }

  /** `history_file_lines`: the new side of `history_diff`'s diff, for "20줄 더 보기". */
  private async historyFileLinesEvent(entryId: string, path: string, final: boolean): Promise<FileLinesEvent> {
    const cp = this.requireProject();
    const current = this.gate.round?.id === entryId ? this.gate.roundInProgress(this.reviewUpdatedAt) : null;
    const entry = this.history.find((e) => e.id === entryId) ?? current;
    if (!entry) throw new CommandRefused(`unknown_history_entry:${entryId}`);
    const file = entry.files.find((f) => f.path === path);
    if (!file) throw new CommandRefused(`not_in_history_entry:${path}`);
    const view = await historyFileLines(cp, entry, file, final);
    return { type: "file_lines", scope: "history", path, entryId, ...view };
  }

  /** `pr_file_lines`: the open PR's file at its head commit (this repository's objects first, else GitHub). */
  private async prFileLinesEvent(filename: string): Promise<FileLinesEvent> {
    const head = this.pr.headOf(filename);
    if (!head) throw new CommandRefused(`unknown_pr_file:${filename}`, { code: "unknown_pr_file" });
    const bytes = await prHeadContent(this.gate.checkpoint, head.sha, filename, () => this.pr.fetchHeadContent(head, filename));
    const view = bytes === null ? { lines: [], isBinary: false, isTooLarge: true } : fileLinesOf(bytes);
    return { type: "file_lines", scope: "pr", path: filename, sha: head.sha, ...view };
  }

  /** `file_image`: a changed image of the review before (A) and after (the review's B). */
  private async fileImageEvent(path: string): Promise<FileImageEvent> {
    const cp = this.requireProject();
    const file = this.gate.changedFiles.find((f) => f.path === path);
    if (!file) throw new CommandRefused(`not_a_changed_file:${path}`);
    const mediaType = imageMediaType(file.path);
    if (!mediaType) throw new CommandRefused(`not_an_image:${path}`);
    const start = this.gate.turnStartTree;
    const end = this.gate.reviewEndTree;
    if (start === null || end === null) throw new CommandRefused("no_review");
    const oldPath = file.oldPath ?? null;
    const before = file.status === "A" ? null : await imageSide(cp, start, oldPath ?? file.path);
    const after = file.status === "D" ? null : await imageSide(cp, end, file.path);
    return { type: "file_image", path: file.path, oldPath, mediaType, old: before, new: after, endTree: end };
  }

  /** `history_diff.why`: the reason in the round's chat rows (null when they say nothing or the chat is gone). */
  private historyFileWhy(entry: ReviewHistoryEntry, file: ReviewHistoryEntry["files"][number]): FileWhy | null {
    const idx = this.sessions;
    const id = entry.sessionId;
    if (!idx || !id) return null;
    const path = id === this.currentSessionId && this.transcript ? this.transcript.path : idx.transcript(id).path;
    try {
      return historyWhy(readTranscriptRows(path), entry, file);
    } catch (e) {
      this.log("warn", `history why: ${errorMessage(e)}`);
      return null;
    }
  }

  /**
   * Commits that landed outside the app while the review stands (a pull, a merge, a checkout) go into A, so the list
   * keeps only Claude's changes (`ReviewGate.followHead`). `rediff`: re-diff here (the refresh command re-diffs itself).
   */
  private async followHeadMove(rediff = true): Promise<void> {
    if (gatePhase(this.slices()) !== "reviewing") return;
    try {
      if (!(await this.gate.followHead())) return;
      this.log("info", "HEAD moved outside the app: its commits were carried into the review's start");
      if (rediff) await this.gate.refresh();
      this.touch();
    } catch (e) {
      this.log("warn", `follow HEAD: ${errorMessage(e)}`);
    }
  }

  /** `open_project`: rebuilds the gate from the persisted review when its trees are still pinned. */
  private async restoreReview(): Promise<void> {
    const dir = this.projectGitDir;
    if (!dir) return;
    const saved = await loadReview(dir);
    if (!saved) return;
    try {
      if (await this.gate.restore(saved)) {
        this.reviewUpdatedAt = saved.savedAt || this.reviewUpdatedAt;
        this.commitSlice.lastUserText = saved.lastUserText;
        this.log("info", `restored review from ${dir}: ${this.gate.changedFiles.length} file(s), ${this.gate.reviewNotes.length} note(s)`);
        await this.followHeadMove();
        await this.checkStale(saved);
      } else {
        this.log("info", `stale review file in ${dir} ignored`);
        await this.clearPersistedReview();
      }
    } catch (e) {
      this.log("warn", `restore review: ${errorMessage(e)}`);
    }
    this.touch();
  }

  /**
   * §31: a restored review whose HEAD moved since it was saved (commits, a pull or a checkout while the app was
   * closed) or that is older than `STALE_REVIEW_MS` is stale: `state.gate.stale` until `keep_review` / `finish_review` /
   * the next turn. Whatever changed meanwhile is in the list as `external` either way.
   */
  private async checkStale(saved: PersistedReview): Promise<void> {
    const head = await this.readHead();
    const reasons: ("head_moved" | "old")[] = [];
    const before = saved.head ?? null;
    // A review that knows its A's HEAD (`baseHead`) followed the move itself (`followHeadMove`).
    if (!saved.baseHead && before && head && (before.sha !== head.sha || before.branch !== head.branch)) reasons.push("head_moved");
    const savedMs = Date.parse(saved.savedAt);
    if (Number.isFinite(savedMs) && this.now() - savedMs >= STALE_REVIEW_MS) reasons.push("old");
    if (reasons.length === 0) return;
    const externalFiles = this.gate.changedFiles.reduce((n, f) => (originOf(f) === "external" ? n + 1 : n), 0);
    this.gate.stale = { reasons, savedAt: saved.savedAt, savedHead: before, head, externalFiles };
    this.log("info", `restored review is stale (${reasons.join(", ")}; ${externalFiles} file(s) changed outside the app)`);
  }

  /** Appends one row to `<gitdir>/reviewgate-transcript.ndjson`. */
  private record(item: TranscriptRow): void {
    this.transcript?.append({ at: new Date().toISOString(), turn: this.turn, ...item } as TranscriptItem);
    // MARK: wave4b w4b-bigturn — §39.1: the store logged it already.
    if (this.transcript?.lastError) this.saveFailed("transcript", this.transcript.lastError, null);
    else if (this.transcript) this.saveOk("transcript");
  }

  // MARK: wave4b w4b-bigturn — §39.1 saves that fail and the free space

  /** A save failed: logged (`what` = the log's prefix, null when the caller logged it) and shown until its next good save. */
  private saveFailed(kind: SaveWhat, e: unknown, what: string | null): void {
    if (what !== null) this.log("warn", `${what}: ${errorMessage(e)}`);
    if (this.saveHealth.fail(kind, e)) this.touch();
    void this.checkDisk();
  }

  private saveOk(kind: SaveWhat): void {
    if (this.saveHealth.ok(kind)) this.touch();
  }

  /** Reads the project volume's free space; a state update only when it moved enough (`diskChanged`). */
  private async checkDisk(): Promise<void> {
    const root = this.project?.root ?? this.gate.checkpoint?.root;
    if (!root || this.diskReading) return;
    this.diskReading = true;
    try {
      const next = await readDiskSpace(root);
      if (diskChanged(this.disk, next)) {
        this.disk = next;
        this.touch();
      }
    } finally {
      this.diskReading = false;
    }
  }

  private startDiskWatch(): void {
    this.stopDiskWatch();
    void this.checkDisk();
    this.diskTimer = setInterval(() => void this.checkDisk(), 60_000);
    this.diskTimer.unref?.();
  }

  private stopDiskWatch(): void {
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.diskTimer = null;
  }

  /** `retry_save`: the review, its history and the chat's checkpoints saved again; refused `save_failed` while one fails. */
  private async retrySave(): Promise<void> {
    this.saveHealth.ok("transcript"); // rows that failed are gone; the next row says whether appends work again
    this.persistReview();
    this.saveHistoryFile();
    this.saveCheckpointFile();
    await this.persistChain.catch(() => undefined);
    await this.checkDisk();
    this.touch();
    const v = this.saveHealth.view;
    if (v) throw new CommandRefused(`save_failed:${v.detail}`, { code: "save_failed" });
  }

  /** `history_cleanup`: counts (default) or removes the review rounds and checkpoint records beyond the newest `keep`. */
  private async historyCleanup(keepRaw: unknown, apply: boolean): Promise<HistoryCleanupEvent> {
    const cp = this.gate.checkpoint;
    const dir = this.projectGitDir;
    if (!cp || !dir) throw new CommandRefused("no_project", { code: "no_project" });
    // A running turn adds checkpoint records and may finish a round meanwhile: the files are rewritten only when idle.
    if (apply && (this.gate.running || this.gate.collecting)) throw new CommandRefused("session_running");
    const keep = cleanupKeep(keepRaw);
    const chat = this.currentSessionId;
    const run = this.persistChain.then(async () => {
      const plan = await planCleanup({ cp, gitDir: dir, ns: this.gate.refNs, history: this.history, keep, live: chat ? { chatId: chat, file: this.checkpoints } : null });
      if (apply) {
        await applyCleanup(cp, dir, this.gate.refNs, plan, (m) => this.log("warn", m));
        const dropped = new Set(plan.droppedHistory.map((e) => e.id));
        this.history = this.history.filter((e) => !dropped.has(e.id));
        const mine = chat ? plan.chats.find((c) => c.chatId === chat) : undefined;
        if (mine) this.checkpoints = { ...this.checkpoints, records: [...mine.file.records] };
        this.log("info", `history cleanup: ${plan.droppedHistory.length} round(s), ${plan.chats.reduce((n, c) => n + c.dropped, 0)} checkpoint(s), ${plan.refs.length} ref(s)`);
      }
      return plan;
    });
    this.persistChain = run.then(() => undefined, () => undefined);
    const plan = await run;
    if (apply) {
      this.touch();
      void this.checkDisk();
    }
    return {
      type: "history_cleanup",
      keep,
      rounds: plan.droppedHistory.length,
      checkpoints: plan.chats.reduce((n, c) => n + c.dropped, 0),
      refs: plan.refs.length,
      bytes: plan.bytes,
      kept: plan.keptHistory.length,
      applied: apply,
    };
  }

  private resetProjectState(): void {
    this.gate.reset();
    this.autoAcceptRules = {}; // MARK: wave4c w4c-trust (§41.2)
    this.gate.checkpoint = null;
    this.projectGitDir = null;
    this.transcript = null;
    this.sessions = null;
    this.currentSessionId = null;
    this.openTabIds = [];
    this.confirmedSessionIds.clear();
    this.fallbackFresh = false;
    this.recordOnlyNext = null; // MARK: wave2 check-engine (§35.4)
    this.turnText = "";
    this.turnTextUnprompted = false;
    this.pinned = { start: null, end: null };
    this.history = [];
    this.pinnedRoundKey = "";
    this.pinnedRangeKey = "";
    this.reviewUpdatedAt = null;
    this.toolCalls.clear();
    this.turnCommandIds = [];
    this.approvedPlan = null;
    this.extensionsFallback = null;
    this.ext = null;
    this.sessionStart = { resume: null, gotInfo: false };
    this.inUseResumed = null;
    this.forceResumeId = null;
    this.resumeNotice = null;
    this.autoRestartsThisTurn = 0;
    this.codeGraph.reset(); // MARK: wave5 w5-graph — §43.3: a build of the closed project stops with it
    this.project = null;
    this.statusLine.projectChanged(); // MARK: wave6 w6-statusline — §44.2: its lines go with it
    this.subBrain.close(); // MARK: wave5 w5-brain (§43.2)
    // MARK: wave4b w4b-bigturn (§39.1)
    this.stopDiskWatch();
    this.disk = null;
    this.saveHealth.clear();
    this.gitInit = null;
    this.sessionState = emptySession(this.settings.permissionMode ?? "default");
    this.planByClaude = false; // MARK: wave6 w6-terminal (§44.1)
    this.rememberedAllows.clear();
    this.cachedCapabilities = null;
    this.hud = initialHud();
    this.chatLines = { added: 0, removed: 0 }; // MARK: wave6 w6-statusline (§44.2)
    this.agents.reset();
    this.budgetUsage = { ...ZERO_USAGE };
    this.branches = { list: [], isWorktreeDirty: false };
    this.lastError = null;
    this.turn = 0;
    this.workbenches = emptyWorkbenches();
    this.lockConflict = null;
    this.commitSlice = emptyCommit();
    this.lastForkPoint = null;
    this.mcpDisabled.clear();
    // MARK: wave4d w4d-config — §42.3
    this.mcpToggles.worktreeOn.clear();
    this.mcpToggles.repoOff.clear();
    this.mcpRepoStamp = null;
    this.mcpAuthWaiting.clear();
    this.cliAgents = null;
    this.mcpSessionServers.clear();
    this.mcpRestartRequired = false;
    this.mcpLast = [];
    this.mcpLastJson = "";
    this.fileIndex = null;
    this.checkpoints = { version: 1, records: [] };
    this.turnRecord = null;
    this.modelChoice = {};
    this.contextWarned = false;
    this.peerInbox.clear();
    this.peerChoice = undefined;
    this.externalTurn = null;
    this.peerTurn = null;
    this.externalPeerEpisode = false;
    this.peerReleaseFailed.clear();
    // MARK: wave3 engine-session
    this.projectCommonDir = null;
    this.startHistory = [];
    this.startClock = null;
    this.waitingOn.reset();
    this.cancelExtensionsRetry();
    this.extRetry = { running: false, auto: "none", timer: null };
  }

  /** `resume` continues that Claude session; otherwise a fresh one, pre-named `sessionId` when given (docs/M15-POLISH.md). */
  private async startSession(cwd: string, resume: string | null = null, sessionId: string | null = null): Promise<void> {
    this.sessionState.starting = true;
    this.setCapabilitiesState("starting"); // MARK: wave3 engine-session (§36.5)
    // §26: a rewind fork the CLI has not materialized yet starts as a fork again (whatever the caller asked for).
    const fork = this.checkpoints.pendingFork && this.currentSessionId ? { ...this.checkpoints.pendingFork, id: this.currentSessionId } : null;
    // A fork that dies before reporting in is a failed resume of the fork's own chat (→ a fresh chat, §8).
    this.sessionStart = { resume: fork ? fork.id : resume, gotInfo: false };
    if (fork) this.log("info", `forking session ${fork.sessionId} at ${fork.uuid} into ${fork.id}`);
    else if (resume) this.log("info", `resuming session ${resume}`);
    this.touch();
    try {
      const tc = await this.locate();
      if (!tc.claude) {
        this.fail("claude CLI not found. Install Claude Code or set its path in Settings.", true, "engine", { code: "cli_not_found" });
        return;
      }
      const launchProblem = claudeLaunchProblem(tc.claude, this.platform.isWindows);
      if (launchProblem) {
        this.fail(launchProblem, true, "engine", { code: "cli_not_executable" });
        return;
      }
      this.noteCliVersionOf(parseCliVersion(tc.claudeVersion)); // MARK: wave3 engine-session (§36.8)
      const s = this.settings;
      const loadUser = s.loadUserSettings !== false && this.extensionsFallback === null;
      const { ids: disabledIds, unresolved } = resolveDisabledPlugins(s.disabledPlugins ?? [], this.knownPlugins());
      if (unresolved.length > 0) this.log("warn", `disabledPlugins without a known plugin id ignored: ${unresolved.join(", ")} (use name@marketplace)`);
      this.ext = { loadUser, disabledIds, unresolved, hooksDisabled: s.disableUserHooks === true, plugins: null, memoryFiles: null, mcpServers: null };
      // MARK: wave3 engine-session — §36.6: local settings per project (default on); the §16 fallback drops them with user.
      this.ext.loadLocal = s.loadLocalSettings !== false && this.extensionsFallback === null;
      this.refreshExtensions();
      // §33.5: the user's Claude Code allow rules for the tools that cannot change files (re-read at every start).
      this.userRules = sessionUserRules(this.readUserRules(loadUser, cwd), s.applyUserAllowRules !== false);
      const sessionName = this.peerSessionName();
      const session = this.sessionFactory({
        cwd,
        settings: {
          budget: s.budget,
          ignorePatterns: s.ignorePatterns,
          autoAllowTools: s.autoAllowTools,
          loadUserSettings: loadUser,
          loadLocalSettings: this.ext.loadLocal, // MARK: wave3 engine-session (§36.6)
          disabledPlugins: disabledIds,
          disableUserHooks: s.disableUserHooks === true,
          // MARK: wave3 engine-session — §36.7: a stall limit; the setting is its floor, the repository's history adapts it.
          initTimeoutMs: initStallLimit(s.extensionsInitTimeoutMs ?? EXTENSIONS_INIT_TIMEOUT_MS, this.startHistory),
          systemPromptAppend: s.systemPromptAppend,
          maxTurns: s.maxTurns, // MARK: wave4 w4-longwork (§38.2)
          backgroundWork: s.backgroundWork !== false, // §52
          ...this.startModel(),
          autoAllowReadOnlyBash: s.autoAllowReadOnlyBash !== false,
          bashAllowPatterns: [...(s.bashAllowPatterns ?? [])],
          allowWorktreeIsolation: s.allowWorktreeIsolation === true,
          userRules: this.userRules,
          permissionMode: this.sessionState.permissionMode,
          ...(this.prePlanModeNow() ? { prePlanMode: this.prePlanModeNow()! } : {}), // MARK: wave6 w6-terminal (§44.1)
          // §29: peer messages are parked for the user (or refused), and the session says it is ReviewGate's.
          crossSessionInbound: peerFlag(this.peerMode()),
          sessionName,
          ...(fork ? { resumeSessionId: fork.sessionId, forkAt: fork.uuid, sessionId: fork.id } : resume ? { resumeSessionId: resume } : sessionId ? { sessionId } : {}),
        },
        claudePath: tc.claude,
        env: { ...this.baseEnv, ...this.clientEnv, PATH: tc.path },
        platform: this.platform,
        rememberedAllows: this.rememberedAllows,
        testCommandPatterns: () => this.testCommandPatterns(),
        emit: (ev) => this.onSessionEvent(session, ev),
        log: (level, msg) => this.log(level, msg),
        // MARK: wave4d w4d-peers — §42.2: whom a SendMessage address reaches (the registry, only read).
        resolvePeer: (address) => peerAtAddress({ configDir: claudeConfigDir(this.childEnv()), address }),
      });
      this.session = session;
      this.liveModels.set(session, this.startModel().model ?? null); // MARK: wave5 w5-model (§43.4)
      // MARK: wave6 w6-statusline — §44.2: the CLI's session clock and `--name` start with its process.
      this.sessionStartedAt = this.now();
      this.sessionStartName = sessionName;
      this.toldBudget = this.promptBudget ?? budgetNumbers(s.budget); // MARK: wave4 w4-longwork (daily-18)
      this.sessionState.open = true;
      // MARK: wave3 engine-session — §36.7: the clock of this start and what it waits on.
      this.startClock = { at: Date.now(), loadUser };
      this.waitingOn.reset();
      this.sessionState.extensionsWaitingOn = null;
      this.mcpApplied = false;
      this.mcpRestartRequired = false;
      this.mcpAuthNotified.clear();
      this.cliAgents = null; // MARK: wave4d w4d-config (§42.3)
      try {
        await session.start();
        this.startMcpPolling(session);
      } catch (e) {
        if (this.session === session) {
          this.session = null;
          this.sessionState.open = false;
        }
        this.fail(errorMessage(e), true, "session", { code: codeOfErrorText(errorMessage(e)) ?? "session_start_failed" });
      }
    } finally {
      this.sessionState.starting = false;
      if (!this.session) this.endCapabilitiesStart(); // MARK: wave3 engine-session (§36.5: no CLI, no "starting")
      this.touch();
    }
  }

  private async stopSession(): Promise<void> {
    const s = this.session;
    this.stopMcpPolling();
    this.session = null;
    // MARK: wave6 w6-statusline — §44.2: the CLI's clock and `--name` end with its process.
    this.sessionStartedAt = null;
    this.sessionStartName = null;
    this.sessionState.open = false;
    this.sessionState.extensionsWaitingOn = null; // MARK: wave3 engine-session (§36.7)
    this.startClock = null;
    this.endCapabilitiesStart(); // MARK: wave3 engine-session (§36.5)
    this.setPendingPermissions([]);
    this.gate.running = false;
    this.endPeerState(); // §29: what that CLI held goes with it
    if (s) await s.dispose().catch(() => undefined);
    // Whatever that CLI still ran (background agents) died with it.
    if (this.agents.stopAll()) this.agentsChanged();
  }

  /**
   * `restart_session` (audit 1.4): a new Claude session for the open project WITHOUT touching the gate
   * — the pending review, notes and accepted files survive. Resumes the stored session id when
   * `resume` is set and one is known; a running turn is closed and collected first.
   */
  private async restartSession(resume: boolean): Promise<void> {
    const project = this.project;
    if (!project || this.gitInit !== null) throw new CommandRefused("no_project");
    if (this.sessionState.starting) throw new CommandRefused("starting");
    this.cancelAutoRestart();
    if (this.fallbackFresh && this.sessions) {
      // A resume that failed (docs/M15-POLISH.md): the session stays in the history, a new one starts.
      this.fallbackFresh = false;
      const notice = this.resumeNotice;
      this.resumeNotice = null;
      await this.switchSession(this.sessions.create(), false);
      // §30: said in the new chat (after its transcript_restore), so it stays with the chat the user now sees.
      if (notice) this.notice(START_FAILURE_MESSAGES[notice.code], "session", { code: notice.code, sessionId: notice.sessionId, ...(notice.detail ? { detail: notice.detail } : {}) });
      return;
    }
    // The init-timeout fallback (§16) keeps a turn whose message the hung CLI never took: the new CLI gets it.
    const resend = this.gate.running ? this.resendAfterRestart : null;
    this.resendAfterRestart = null;
    if (this.gate.running && !resend) this.endTurnAbnormally("session restarted");
    await this.stopSession();
    if (resend) this.gate.running = true; // stopSession opened the gate; the user's turn is still on
    await this.persistChain.catch(() => undefined); // session-file writes land before the id is read back
    const current = this.currentSessionId ? this.sessions?.get(this.currentSessionId) ?? null : null;
    const forced = this.forceResumeId;
    this.forceResumeId = null;
    // MARK: wave2 check-engine — §35.4: an open record restarts fresh under its next chat's id, never resumed.
    const record = this.recordOnlyNext;
    // §35.5: the message about to be sent again never reached the CLI — it does not make a brand-new chat resumable.
    const id = forced ?? (resume && record === null ? this.sessionState.sessionId ?? (current && this.isResumable(current, resend === null) ? current.id : null) : null);
    await this.startSession(project.path, id, id === null ? record ?? this.currentSessionId : null);
    if (resend) this.resendTurn(resend);
  }

  /** Hands the running turn's message to the restarted CLI (once); closes the turn when that is impossible. */
  private resendTurn(resend: TurnMessage): void {
    const session = this.session;
    if (!this.gate.running) return;
    if (!session) {
      this.endTurnAbnormally("session restarted");
      return;
    }
    try {
      this.turnSent = resend;
      session.sendUser(resend.text, resend.checkpointTree, resend.images ?? []);
      this.log("info", "init-timeout fallback: the message sent before the restart was sent again");
      this.hud.activity = { kind: "working" };
      this.touch();
    } catch (e) {
      this.endTurnAbnormally("session restarted");
      this.fail(errorMessage(e), false, "session", { code: "send_failed" });
    }
  }

  private cancelAutoRestart(): void {
    if (this.autoRestartTimer) {
      clearTimeout(this.autoRestartTimer);
      this.autoRestartTimer = null;
    }
  }

  /**
   * The session died on its own (`closed` without `stopSession`). §30: a start the CLI refused is recovered right away —
   * "already in use" resumes that conversation (once), a resume the CLI cannot find / load falls back to a fresh chat
   * (with a notice) — and any other death before initialize is not retried with the same arguments (it would fail the
   * same way; `restart_session` / a new chat are the user's). Otherwise one automatic restart per turn after a short
   * backoff (`settings.autoRestartSession !== false`); a resume that initialized resumes again.
   */
  private onSessionDied(): void {
    if (this.closed || this.disposing || !this.project || this.autoRestartTimer) return;
    const start = this.sessionStart;
    if (start.failure === "session_id_in_use" && this.currentSessionId) {
      this.inUseResumed = this.currentSessionId;
      this.forceResumeId = this.currentSessionId;
      this.sessionStart = { resume: null, gotInfo: false };
      this.autoRestartTimer = setTimeout(() => {
        this.autoRestartTimer = null;
        void this.handle({ type: "restart_session" });
      }, 0);
      return;
    }
    if (start.resume && (start.failure === "resume_not_found" || start.failure === "resume_failed")) {
      this.log("warn", `resume of session ${start.resume} failed (${start.failure}); starting a fresh session`);
      this.sessionState.sessionId = null;
      const failed = this.sessions?.get(start.resume);
      if (failed) failed.resumeFailed = true;
      this.fallbackFresh = true;
      this.resumeNotice = { code: start.failure, sessionId: start.resume, ...(start.failureDetail ? { detail: start.failureDetail } : {}) };
      this.autoRestartTimer = setTimeout(() => {
        this.autoRestartTimer = null;
        void this.handle({ type: "restart_session" }); // no id: the fresh start happens on the main lane
      }, 0);
      this.sessionStart = { resume: null, gotInfo: false };
      return;
    }
    if (!start.ready && !start.gotInfo) {
      this.log("warn", "Claude Code exited before it finished starting; not restarted automatically (restart_session or a new chat)");
      return;
    }
    if (this.settings.autoRestartSession === false || this.autoRestartsThisTurn >= 1) return;
    this.autoRestartsThisTurn += 1;
    this.log("warn", `session died; automatic restart in ${this.autoRestartDelayMs} ms`);
    this.autoRestartTimer = setTimeout(() => {
      this.autoRestartTimer = null;
      void this.handle({ type: "restart_session" });
    }, this.autoRestartDelayMs);
    this.autoRestartTimer.unref();
  }

  // ------------------------------------------------------------------ turns

  /**
   * A plain send never changes review state (docs/PROTOCOL.md §10): while files await review it asks
   * a question — every file keeps its state, A is kept and the answer turn merges into the same review.
   * `acceptPending` (docs/M16-FRICTION.md §3, only when the user explicitly chose "Accept N & Send")
   * accepts every pending file first; it is refused with `gate_closed:changes_requested` while
   * changes-requested files exist (use `request_changes`), and like a plain send while running.
   */
  /**
   * Resolves true once the message went to the session; false when the session refused it (an `error` was emitted).
   * Snapshot A failing refuses the send (`send_failed` / `lfs_missing`) before anything of it happened (§35.1).
   */
  private async send(text: string, acceptPending = false, opts: SendOptions = {}): Promise<boolean> {
    if (acceptPending) {
      const g = this.gate;
      if (g.isSettled && g.changesRequestedFiles.length > 0) throw new CommandRefused("gate_closed:changes_requested");
      if (g.isSettled && g.pendingFiles.length > 0) {
        g.acceptAll();
        this.touch();
      }
    }
    const slices = this.slices();
    if (!canSend(slices)) throw new CommandRefused(`gate_closed:${this.closedReason(slices)}`);
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new CommandRefused("empty message", { code: "empty_message" });
    const session = this.session;
    if (!session) throw new CommandRefused("gate_closed:no_session");
    const mentions = opts.mentions ?? [];
    const images = opts.images ?? [];
    await this.followHeadMove();
    await this.gate.prepareAnswer(this.takeBgCarry());
    // MARK: wave2 check-engine — snapshot A first, the gate closed meanwhile: a failure refuses the send with nothing
    // of it done (no user message row, the chat's title / lastUserText, the review-summary prefix, the notes and a
    // pending plan all stay), so the client keeps the message instead of dropping it on an `ok`.
    // A request-changes turn — and an answer to a standing review — keeps snapshot A so the follow-up diff stays cumulative.
    const keptA = this.gate.keepsTurnStart;
    this.gate.running = true;
    let tree: string;
    try {
      tree = await this.gate.snapshotStart();
    } catch (e) {
      this.gate.abortTurn();
      this.touch();
      const code = e instanceof LfsMissingError ? "lfs_missing" : "send_failed";
      this.log("warn", `send refused (${code}): snapshot A failed: ${errorMessage(e)}`);
      throw new CommandRefused(`${code}:${firstLineOf(errorMessage(e))}`, { code });
    }
    const skippedAtStart = this.gate.snapshotSkipped;
    await this.adoptRecordOnly(); // MARK: wave2 check-engine — §35.4: the first message from a record makes its new chat
    // The user's own message supersedes a plan awaiting an answer (docs/M20-MODES.md).
    this.sessionState.pendingPlan = null;
    this.proposedPlanKeys.clear();
    // A slash command (`/compact`, §27) keeps the review summary for the next real message and is no instruction.
    let outgoing = this.gate.beginSend(trimmed, opts.command === true);
    // MARK: wave4 w4-longwork — daily-18: a budget Claude was not told about yet goes in front of the message.
    const budgetNote = opts.command === true ? null : budgetChangeNote(this.toldBudget, this.settings.budget);
    if (budgetNote) outgoing = `${budgetNote}\n\n${outgoing}`;
    // §23: the CLI expands `@path` itself (the file's content goes in as context, no Read call) — verified, CLI 2.1.305.
    if (mentions.length > 0) outgoing += `\n\nReferenced files: ${mentions.map((m) => mentionToken(m.path, m.kind)).join(" ")}`;
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    if (opts.command !== true) {
      this.commitSlice.lastUserText = trimmed;
      if (meta) {
        if (meta.title === NEW_CHAT_TITLE) meta.title = sessionTitle(trimmed);
        meta.lastUserText = trimmed;
      }
    }
    if (meta) {
      meta.updatedAt = new Date().toISOString();
      this.persistSessions();
    }
    const refs = images.map((i) => i.ref);
    if (images.length > 0 && this.projectGitDir) {
      try {
        await storeAttachments(this.projectGitDir, images);
      } catch (e) {
        this.log("warn", `attachments: ${errorMessage(e)}`);
      }
    }
    // MARK: wave5 w5-model — §43.4: the model of this message, set before it goes out (never during a turn: the gate is closed).
    const autoModel = opts.command === true ? null : await this.chooseTurnModel({ text: trimmed, mentions: mentions.length, attachments: images.length }, opts.model);
    this.beginTurn(trimmed, { ...(mentions.length > 0 ? { mentions: mentions.map((m) => m.path) } : {}), ...(refs.length > 0 ? { attachments: refs } : {}), ...(autoModel ? { autoModel } : {}) });
    // `beginTurn` clears the per-turn signals; what snapshot A had to leave out (§32) is this turn's.
    this.gate.snapshotSkipped = skippedAtStart;
    const sessionImages = images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 }));
    try {
      await this.noteTurnStartState();
      // §26: the turn's own start tree (A is the review's, kept across question turns).
      await this.startRecord(keptA ? null : tree);
      this.gate.noteTurnStart(this.turnRecord?.startTree ?? null); // §34.1: "this turn" starts here
      const hookTree = this.turnHookTree(tree);
      this.turnSent = { text: outgoing, checkpointTree: hookTree, images: sessionImages };
      session.sendUser(outgoing, hookTree, sessionImages);
      if (budgetNote) this.toldBudget = budgetNumbers(this.settings.budget); // MARK: wave4 w4-longwork
    } catch (e) {
      // The session went away while the turn was being prepared (snapshot A had succeeded).
      this.gate.abortTurn();
      this.dropRecord();
      this.hud.turnStartedAt = null;
      this.fail(errorMessage(e), false, "session", { code: "send_failed" });
      this.touch();
      return false;
    }
    this.touch();
    await this.checkConcurrent("send");
    return true;
  }

  /**
   * §50 `steer {text, mentions?}`: the message goes into the turn that runs — the CLI gives it to Claude once the current
   * tool call is done, as typing while Claude works does in the terminal. Its changes are this turn's (one review). Refused
   * `steer_unavailable:<why>` when no turn of ours runs or its review is being collected (the client queues it then).
   */
  private steer(text: unknown, mentionsIn: unknown): void {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length === 0) throw new CommandRefused("empty message", { code: "empty_message" });
    const session = this.session;
    const g = this.gate;
    const why = !session?.steerUser ? "no_session"
      : this.sessionState.externalTurn ? "external_turn"
      : g.collecting || g.reverting ? "collecting"
      : !g.running || !session.isTurnActive ? "not_running"
      : null;
    if (why !== null || !session?.steerUser) throw new CommandRefused(`steer_unavailable:${why ?? "no_session"}`, { code: "steer_unavailable" });
    const mentions = this.sendOptions(mentionsIn, undefined).mentions ?? [];
    let outgoing = trimmed;
    if (mentions.length > 0) outgoing += `\n\nReferenced files: ${mentions.map((m) => mentionToken(m.path, m.kind)).join(" ")}`;
    session.steerUser(outgoing);
    const extras = mentions.length > 0 ? { mentions: mentions.map((m) => m.path) } : {};
    this.record({ kind: "user_message", text: trimmed, ...extras, steered: true });
    this.emit({ type: "user_message", text: trimmed, turn: this.turn, ...extras, steered: true });
    this.commitSlice.lastUserText = trimmed;
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    if (meta) {
      meta.lastUserText = trimmed;
      meta.updatedAt = new Date().toISOString();
      this.persistSessions();
    }
    this.log("info", `message put into turn ${this.turn}`);
    this.touch();
  }

  private async requestChanges(extra: string | null, noteIds?: readonly string[]): Promise<void> {
    if (!canRequestChanges(this.slices())) throw new CommandRefused(`request_changes_unavailable:${blockedReason(this.slices()) ?? "no_notes"}`);
    if (noteIds && !this.gate.hasUnsentNote(noteIds)) throw new CommandRefused("request_changes_unavailable:no_notes");
    await this.followHeadMove();
    const session = this.session;
    if (!session) throw new CommandRefused("gate_closed:no_session");
    this.gate.running = true; // close the gate before the async preparation
    this.touch();
    // §34.4: the notes are marked sent with the follow-up turn's number (`beginTurn` below counts it).
    const prepared = await this.gate.prepareRequestChanges(extra, this.turn + 1, noteIds);
    if (!prepared) {
      this.gate.running = false;
      this.touch();
      throw new CommandRefused("request_changes_unavailable:no_review");
    }
    await this.adoptRecordOnly(); // MARK: wave2 check-engine (§35.4)
    const autoModel = await this.chooseTurnModel({ text: prepared.message, retry: "changes_requested" }); // MARK: wave5 w5-model (§43.4)
    this.beginTurn(prepared.message, autoModel ? { autoModel } : {});
    await this.startRecord(null);
    this.gate.noteTurnStart(this.turnRecord?.startTree ?? null); // §34.1: "this turn" starts here
    await this.noteTurnStartState();
    try {
      const hookTree = this.turnHookTree(prepared.checkpointTree);
      this.turnSent = { text: prepared.message, checkpointTree: hookTree };
      session.sendUser(prepared.message, hookTree);
    } catch (e) {
      // Undo the marking so the user can retry (notes are kept).
      this.gate.undoRequestChanges(prepared.endTree);
      this.dropRecord();
      this.hud.turnStartedAt = null;
      this.fail(errorMessage(e), false, "session", { code: "send_failed" });
    }
    this.touch();
  }

  /**
   * The tree the session's hooks count a turn from: the turn's own start (§34.1) — A only when the turn has none. A
   * request-changes turn or a question keeps A for the review, but the opt-in budget is per turn (§54).
   */
  private turnHookTree(a: string): string {
    return this.gate.runningTurnStart ?? a;
  }

  /** Transcript / HUD bookkeeping shared by `send` and `requestChanges` (and §29 `peer_accept`: no user message — the peer row comes with the body). */
  private beginTurn(displayText: string, extras: { mentions?: string[]; attachments?: AttachmentRef[]; autoModel?: AutoModelChoice } = {}, peer = false): void {
    // Text of an unprompted turn that never saw its own end is kept as its own (marked) row.
    if (this.turnTextUnprompted) this.flushTurnText();
    this.turn += 1;
    this.gate.beginTurn({ turn: this.turn, prompt: displayText, startedAt: new Date().toISOString(), sessionId: this.currentSessionId });
    this.turnText = "";
    this.turnTextUnprompted = false;
    this.turnCommandIds = [];
    this.turnFiles.clear();
    this.turnEditCalls.clear();
    this.resetTurnWhy();
    this.autoRestartsThisTurn = 0;
    this.unpromptedNoticed = false;
    this.scopeNoticed.clear();
    this.followAfterTool.clear(); // MARK: wave4b w4b-follow — §39.4: a followed card belongs to its turn
    this.worktreeBeforeCommand.clear();
    this.autoAnswered.clear();
    this.turnSent = null;
    this.turnSawOutput = false;
    this.turnAutoModel = extras.autoModel ?? null; // MARK: wave5 w5-model (§43.4)
    if (!peer) {
      notePlanMessage(this.chatPlanMemory(), displayText, extras.mentions ?? []); // MARK: wave4d w4d-plan (§42.1, before its row)
      this.record({ kind: "user_message", text: displayText, ...extras });
      this.emit({ type: "user_message", text: displayText, turn: this.turn, ...extras });
    }
    this.openRecord(displayText);
    this.hud.turnStartedAt = this.now();
    this.hud.activity = { kind: "working" };
    this.agents.beginTurn();
    this.agents.setTurn(this.turn); // MARK: wave4b w4b-agents — §39.3: agents started from now on are this turn's
    this.agentsChanged(false);
    this.budgetUsage = { ...ZERO_USAGE };
    this.touch();
  }

  /** Snapshots B and rebuilds the review list; emits `turn_end` once the collection succeeded. */
  private async finishTurn(toolFiles: ToolFileEntry[], stopReason: string, usage: TurnUsage | null, windows: ToolWindow[] = []): Promise<void> {
    if (!this.gate.checkpoint || this.gate.turnStartTree === null || this.gate.turnEndTree !== null) return;
    // This turn's §26 record, held now: the gate is open again once the collection is done, so a send (the queue) can
    // open the next turn's record while the tail below still awaits — the tail closes this one, never that one.
    const record = this.turnRecord;
    // MARK: wave5 w5-model — §43.4: this turn's model (held before the gate opens for the next one); a failure steers the next message.
    const autoModel = this.turnAutoModel;
    if (/^error/i.test(stopReason)) this.autoRetry = "failed";
    const run = this.gate.finishTurn(toolFiles, stopReason, usage, windows);
    this.touch();
    try {
      const r = await run;
      if (r) {
        // MARK: wave4c w4c-trust — §41.2: the repository's rules accept what they trust, before the turn's end is told.
        const autoAccepted = this.applyAutoAccept(lastTestOf(this.toolCalls, this.turn));
        // §34.3: files / added / deleted / external count what THIS turn changed; `review` totals the whole list.
        const review = { files: r.files.length, added: r.added, deleted: r.deleted };
        this.chatLines = { added: this.chatLines.added + r.turn.added, removed: this.chatLines.removed + r.turn.deleted }; // MARK: wave6 w6-statusline (§44.2)
        this.statusLine.poke();
        const ev = { stopReason, usage: usage ?? zeroUsage(), files: r.turn.files.length, added: r.turn.added, deleted: r.turn.deleted, changedOutside: [...this.gate.changedOutside], external: r.turn.external, review, ...(r.merged ? { merged: true as const } : {}), ...(autoModel ? { autoModel: { ...autoModel } } : {}) };
        this.record({ kind: "turn_end", ...ev });
        this.emit({ type: "turn_end", ...ev });
        if (r.turn.files.length > 0) {
          const built = buildTurnSummary({ turn: this.turn, files: r.turn.files.map(withTurnCounts), calls: this.toolCalls, commandIds: this.turnCommandIds, plan: this.approvedPlan });
          // MARK: wave4d w4d-plan — §42.1: the approved plan says so; without one, the chat's own plan sources.
          const summary = { ...built, plan: built.plan ? { ...built.plan, source: "approved" as const } : this.followedPlan(built.files.map((f) => f.path)) };
          if (autoAccepted.length > 0) Object.assign(summary, { autoAccepted }); // MARK: wave4c w4c-trust (§41.2)
          if (usage?.models && usage.models.length > 0) summary.models = usage.models.map((m) => ({ ...m })); // MARK: wave4d w4d-agents2 (§42.4)
          if (autoModel) Object.assign(summary, { autoModel: { ...autoModel } }); // MARK: wave5 w5-model (§43.4)
          this.emit({ type: "turn_summary", ...withReviewTotals(summary, { files: r.files, totals: review, merged: r.merged }) });
          // MARK: wave4 w4-history — §38.3: the card comes back with the chat (bounded row).
          this.record({ kind: "turn_summary", ...summaryRow({ type: "turn_summary", ...withReviewTotals(summary, { files: r.files, totals: review, merged: r.merged }) }) });
        }
        this.refreshPlanCandidates(); // MARK: wave4d w4d-plan (§42.1)
        // After turn_end (nothing may come between the collection and it: `interrupt` replies once it is out).
        const turn = this.turn;
        // What the record closes on: this collection's B and list (a send meanwhile clears B for its own turn).
        const closing = { end: this.gate.turnEndTree, listed: this.gate.changedFiles, delta: r.delta };
        const moved = await this.headMove();
        if (moved) this.emit({ type: "head_moved", turn, from: { ...moved.from }, to: { ...moved.to } });
        const local = await this.localSettingsMove();
        if (local) this.emit({ type: "local_settings_changed", turn, ...local });
        const nested = await this.nestedMove(toolFiles, windows);
        if (nested.length > 0) this.emit({ type: "nested_changes", turn, repos: nested.map((n) => ({ ...n })) });
        await this.closeRecord(record, closing.end, closing.listed, toolFiles, windows, closing.delta);
      }
    } catch (e) {
      this.fail(`Failed to collect changes: ${errorMessage(e)}`, false, "git", { code: e instanceof LfsMissingError ? "lfs_missing" : "collect_failed" });
    }
    this.fileIndex?.invalidate();
    this.touch();
    await this.refreshBranches();
    await this.refreshWorkbenches(false);
  }

  /** HEAD / branch of the open project; null when git could not tell. */
  private async readHead(): Promise<HeadInfo | null> {
    return (await this.gate.checkpoint?.head().catch(() => null)) ?? null;
  }

  /** What a turn's end is compared with: HEAD (§31), `.claude/settings.local.json` (§32, hashes only) and nested worktrees' HEADs (§32). */
  private async noteTurnStartState(): Promise<void> {
    const root = this.gate.checkpoint?.root;
    this.turnHead = await this.readHead();
    this.turnLocalSettings = root ? await localSettingsDigest(root).catch(() => null) : null;
    this.turnNestedHeads = root ? await worktreeHeads(root).catch(() => new Map()) : new Map();
  }

  /**
   * §32: nested repositories (linked worktrees under the project, submodules, clones) the turn changed through its
   * edit tools, or ran a Bash / MCP call in, or named in a command — none of it reaches the review (one gitlink line at
   * most): `state.gate.nestedChanges` until the next turn + `nested_changes`.
   */
  private async nestedMove(toolFiles: ToolFileEntry[], windows: ToolWindow[]): Promise<NestedChange[]> {
    const cp = this.gate.checkpoint;
    if (!cp) return [];
    const before = this.turnNestedHeads;
    this.turnNestedHeads = new Map();
    const startTree = this.turnRecord?.startTree ?? this.gate.turnStartTree;
    const editedFiles = toolFiles.filter((tf) => (tf.toolUseIds?.length ?? 0) > 0 && tf.tools.some((t) => EDIT_TOOL_RE.test(t))).map((tf) => tf.path);
    const calls = windows.map((w) => ({ via: w.name === "Bash" ? ("bash" as const) : ("mcp" as const), cwds: [w.cwd, w.cwdAfter].filter((c): c is string => !!c), ...(w.command !== undefined ? { command: w.command } : {}) }));
    if (editedFiles.length === 0 && calls.length === 0) return [];
    try {
      const changes = await nestedChanges({
        root: cp.root,
        commonDir: await commonDir(cp.root),
        touches: { editedFiles, calls },
        headsBefore: before,
        gitlinkBefore: async (rel) => (startTree ? await cp.blobId(startTree, rel) : null),
      });
      this.gate.nestedChanges = changes;
      return changes;
    } catch (e) {
      this.log("warn", `nested repositories: ${errorMessage(e)}`);
      return [];
    }
  }

  /**
   * §32: `.claude/settings.local.json` is never captured (it may hold secrets), so a change Claude made to it can be
   * neither diffed nor reverted — it is reported instead: `state.gate.localSettingsChanged` + `local_settings_changed`.
   */
  private async localSettingsMove(): Promise<LocalSettingsChange | null> {
    const before = this.turnLocalSettings;
    this.turnLocalSettings = null;
    const root = this.gate.checkpoint?.root;
    if (!before || !root) return null;
    const after = await localSettingsDigest(root).catch(() => null);
    const change = after ? localSettingsChange(before, after) : null;
    if (!change) return null;
    this.gate.localSettingsChanged = { path: LOCAL_SETTINGS, ...change };
    return { ...this.gate.localSettingsChanged };
  }

  /**
   * §31: HEAD at the turn's start vs now. A commit, pull or checkout made while the turn ran (Claude's git commands
   * are denied, so it is someone else's) is reported once: `state.gate.headMoved` until the next turn + `head_moved`.
   */
  private async headMove(): Promise<HeadMove | null> {
    const from = this.turnHead;
    this.turnHead = null;
    if (!from) return null;
    const to = await this.readHead();
    if (!to || (to.sha === from.sha && to.branch === from.branch)) return null;
    this.gate.headMoved = { from, to };
    return { from, to };
  }

  private async retryCollect(): Promise<void> {
    const pending = this.gate.pendingCollect;
    if (this.gate.collectError === null || !pending || this.gate.collecting) throw new CommandRefused("nothing_to_retry");
    this.gate.collectError = null;
    await this.finishTurn(pending.toolFiles, pending.stopReason, pending.usage, pending.windows ?? []);
  }

  /**
   * `reject` / `reject_all` / `reject_hunks` / `finish_review` are refused with `session_running` while a turn
   * (an answer to the standing review, a change request) or its collection is in flight: a revert
   * re-snapshots B mid-turn, after which the turn's end-of-turn collection would be skipped and its
   * changes never reach the review. (§34.2: `accept` goes through `acceptFiles` — applied against the held B.)
   * MARK: wave3 check-engine — §37.1: so are they while a collection failed (`collect_failed`): a revert moved B, and
   * `retry_collect` — which collects only while B is unset — then did nothing (the turn never reached the review).
   */
  private guardReviewMutation(): void {
    if (this.gate.running || this.gate.collecting) throw new CommandRefused("session_running");
    if (this.gate.collectError !== null) throw new CommandRefused("collect_failed");
  }

  // MARK: wave2 engine-review
  /**
   * §34.2: `accept` / `accept_all` (`paths` null = every pending file). While a turn runs on a standing review — or its
   * collection failed — they apply at once against the held B (kept only if the turn leaves the file alone); refused
   * `session_running` while the collection runs and during a fresh turn (nothing is pending); otherwise as before.
   */
  private async acceptFiles(paths: string[] | null): Promise<void> {
    const g = this.gate;
    if (g.collecting) throw new CommandRefused("session_running");
    if (g.isStale) await g.acceptHeld(paths ?? g.pendingFiles.map((f) => f.path));
    else if (g.running) throw new CommandRefused("session_running");
    else if (paths === null) g.acceptAll();
    else g.accept(paths);
    if (!g.running && !g.collecting) this.applyAutoAccept(null, ["lockfile"]); // MARK: wave4c w4c-trust — §41.2: a manifest's lockfile follows it
    this.touch();
  }

  // MARK: wave4c w4c-trust — §41.2
  /** This repository's auto-accept rules (`<common dir>/reviewgate/auto-accept.json`), loaded on open. */
  private autoAcceptRules: AutoAcceptRules = {};

  /**
   * Runs the repository's rules over the review list (`only`: some of them) and accepts what they trust; returns the files
   * accepted. Never throws: a rule that cannot decide leaves the file pending.
   */
  private applyAutoAccept(lastTest: ReturnType<typeof lastTestOf>, only?: readonly AutoAcceptRule[]): AutoAcceptedFile[] {
    if (!anyAutoAcceptRule(this.autoAcceptRules) || this.gate.changedFiles.length === 0) return [];
    try {
      const recent = this.history.slice(-HISTORY_REJECT_ROUNDS).flatMap((e) => e.files.filter((f) => f.verdict === "rejected" || (f.rejectedHunks ?? 0) > 0).flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])));
      const plan = planAutoAccept(this.gate.changedFiles, {
        rules: this.autoAcceptRules,
        lastTest,
        rejectedBefore: this.gate.rejectedForTrust(recent),
        noted: this.gate.notedPaths(),
        ...(only ? { only } : {}),
      });
      return plan.length > 0 ? this.gate.autoAccept(plan) : [];
    } catch (e) {
      this.log("warn", `auto-accept: ${errorMessage(e)}`);
      return [];
    }
  }

  /** `set_auto_accept`: saved for the repository (every worktree of it) and applied from the next collection. */
  private async setAutoAccept(rules: unknown): Promise<void> {
    const common = this.projectCommonDir;
    if (!this.project || !common) throw new CommandRefused("no_project");
    const next = normalizeAutoAcceptRules(rules);
    await saveAutoAcceptRules(common, next);
    this.autoAcceptRules = next;
    this.touch();
  }

  /** `reject_undo`: refusals are `result{ok:false}` (and the state says why); a git failure also emits `error{scope:"git"}`. */
  private async rejectUndo(path: unknown): Promise<void> {
    if (typeof path !== "string" || path.length === 0) throw new CommandRefused("invalid_path");
    this.guardReviewMutation();
    const run = this.gate.undoReject(path);
    this.touch();
    try {
      await run;
    } catch (e) {
      if (!(e instanceof CommandRefused)) this.fail(errorMessage(e), false, "git", { code: "revert_failed" });
      throw e instanceof CommandRefused ? e : new CommandRefused(errorMessage(e), { code: "revert_failed" });
    } finally {
      this.touch();
    }
  }

  /** §34.1: without a review nothing references a range tree — leftover pins (a crash, an old file) go on `open_project`. */
  private pruneRangeRefs(): void {
    const cp = this.gate.checkpoint;
    if (!cp || this.gate.turnStartTree !== null) return;
    const prefix = rangeRefPrefix(this.gate.refNs);
    this.persistChain = this.persistChain.then(() => cp.deleteRefsUnder(prefix)).catch((e) => this.log("warn", `prune range refs: ${errorMessage(e)}`));
  }

  /** Notes are refused while a change request is in flight (§34.2 keeps the rule; its collection now keeps the sent notes). */
  private guardNoteMutation(): void {
    if (this.gate.isRequestingChanges && (this.gate.running || this.gate.collecting)) throw new CommandRefused("session_running");
  }

  /**
   * `reject` / `reject_all`: refused with `file_changed_since_review` (`paths`: every such file, nothing reverted)
   * when the user edited a file after the review was collected, unless `force`. A git failure emits `error{scope:"git"}`.
   */
  private async reject(paths: string[], force = false): Promise<void> {
    if (this.gate.reverting) throw new CommandRefused("reverting");
    const run = this.gate.reject(paths, force);
    this.touch();
    try {
      await run;
    } catch (e) {
      if (e instanceof CommandRefused) {
        this.touch();
        throw e;
      }
      this.fail(errorMessage(e), false, "git", { code: "revert_failed" });
    }
    this.touch();
  }

  /** `reject_hunks` (§17): refusals are `result{ok:false}` only; a git failure also emits `error{scope:"git"}`. */
  private async rejectHunks(path: string, hunks: number[], expectedEndTree: string | null, expectedBaseTree: string | null = null): Promise<void> {
    const run = this.gate.rejectHunks(path, hunks, expectedEndTree, expectedBaseTree);
    this.touch();
    try {
      await run;
    } catch (e) {
      if (!(e instanceof CommandRefused)) this.fail(errorMessage(e), false, "git", { code: "revert_failed" });
      throw e instanceof CommandRefused ? e : new CommandRefused(errorMessage(e), { code: "revert_failed" });
    } finally {
      this.touch();
    }
  }

  // ------------------------------------------------------------------ branches

  /** Reloads `branches`, `isWorktreeDirty` and `project.branch`. Failures only go to the log. */
  private async refreshBranches(): Promise<void> {
    const cp = this.gate.checkpoint;
    if (!cp) return;
    try {
      // MARK: wave3 engine-flow — §36.12: the remote-tracking branches ride along (bases for workbench_create).
      const [list, dirty, name, remotes] = await Promise.all([listBranches(cp), isWorktreeDirty(cp), cp.branchName(), remoteBranches(cp).catch(() => [])]);
      if (this.gate.checkpoint !== cp) return;
      this.branches = { list, isWorktreeDirty: dirty, remotes };
      if (this.project) this.project = { ...this.project, branch: name };
    } catch (e) {
      this.log("warn", `refreshBranches: ${errorMessage(e)}`);
    }
    this.touch();
  }

  private async withBranchGuard(name: string, verb: string, op: (cp: GitCheckpoint) => Promise<void>): Promise<void> {
    const cp = this.gate.checkpoint;
    if (!cp) throw new CommandRefused("no_project");
    const blocker = switchBlocker(this.slices());
    if (blocker) throw new CommandRefused(`switch_blocked:${blocker.kind}`);
    try {
      await op(cp);
    } catch (e) {
      this.fail(`Failed to ${verb} branch ${name}: ${errorMessage(e)}`, false, "git", { code: "branch_failed" });
      await this.refreshBranches();
      throw new CommandRefused(errorMessage(e), { code: "branch_failed" });
    }
    this.fileIndex?.invalidate();
    await this.refreshBranches();
  }

  // ------------------------------------------------------------------ workbenches (docs/M10-WORKBENCHES.md)

  private requireProject(): GitCheckpoint {
    const cp = this.gate.checkpoint;
    if (!cp) throw new CommandRefused("no_project");
    return cp;
  }

  /**
   * Rebuilds `state.workbenches` from `git worktree list` + our lock files. `withDirty` runs the
   * 2 s-bounded `status --porcelain` per worktree; otherwise the previous `dirty` is carried over
   * (the current worktree's from `branches.isWorktreeDirty`). Failures only go to the log.
   */
  private async refreshWorkbenches(withDirty: boolean, forceDirty = false): Promise<void> {
    const cp = this.gate.checkpoint;
    if (!cp) return;
    try {
      const [common, worktrees] = await Promise.all([commonDir(cp.root), listWorktrees(cp.root)]);
      if (this.gate.checkpoint !== cp) return;
      const previous = new Map(this.workbenches.list.map((w) => [w.path, w.dirty]));
      const list = await Promise.all(
        worktrees.filter((w) => !w.bare).map(async (w, i): Promise<WorkbenchInfo> => {
          const isMain = i === 0;
          const isCurrent = samePath(w.path, cp.root);
          const dir = await linkedGitDir(w, common, isMain);
          const lock = dir ? await readLock(dir) : null;
          const locked = lock && isPidAlive(lock.pid) ? { pid: lock.pid, since: lock.since, client: lock.client } : null;
          let dirty: boolean | null;
          // wave4 w4-install (daily-08): the last known value now; the scan below (≤4 at a time) brings the new one.
          if (withDirty) dirty = isCurrent ? this.branches.isWorktreeDirty : (this.dirtyScan.cached(w.path) ?? previous.get(w.path) ?? null);
          else if (isCurrent) dirty = this.branches.isWorktreeDirty;
          else dirty = previous.get(w.path) ?? null;
          return { path: w.path, branch: w.branch, head: w.head, isMain, isCurrent, locked, dirty };
        }),
      );
      if (this.gate.checkpoint !== cp) return;
      this.workbenches = { list, current: cp.root, managedRoot: managedWorktreeRoot(this.settings, common) };
      if (withDirty) {
        this.touch(); // wave4 w4-install: the list first, each worktree's answer as it comes
        await this.dirtyScan.scan(list.map((w) => w.path), (path, dirty) => this.setWorkbenchDirty(cp, path, dirty), { force: forceDirty });
      }
    } catch (e) {
      this.log("warn", `refreshWorkbenches: ${errorMessage(e)}`);
    }
    this.touch();
  }

  /** MARK: wave4 w4-install (daily-08): one scanned worktree's answer into the list (which may have been rebuilt meanwhile). */
  private setWorkbenchDirty(cp: GitCheckpoint, path: string, dirty: boolean | null): void {
    if (this.gate.checkpoint !== cp) return;
    const list = this.workbenches.list;
    const i = list.findIndex((w) => w.path === path);
    if (i === -1 || list[i]!.dirty === dirty) return;
    this.workbenches = { ...this.workbenches, list: list.map((w, j) => (j === i ? { ...w, dirty } : w)) };
    this.touch();
  }

  /**
   * `workbench_create` (M10; wave3 engine-flow §36.12 / §36.14): `fetch → create → copy → setup → done`, each a
   * `workbench_progress` keyed by the new worktree's path, the reply after `done`. A remote base is fetched first (unless
   * `fetch: false` / `fetchBase: false`) and the new branch gets no upstream; `fromPr` fetches `refs/pull/<n>/head` unless a
   * local branch of that name exists. A failed setup does not fail the create.
   */
  private async workbenchCreate(cmd: Extract<EngineCommand, { type: "workbench_create" }>): Promise<void> {
    const cp = this.requireProject();
    const name = cmd.branch.trim();
    // §49: a task is checked before anything is created.
    const task = cmd.task === undefined ? null : { text: taskText(cmd.task?.text), mode: cmd.task?.mode };
    if (task && task.text === null) throw new CommandRefused("invalid_task");
    if (task && task.mode !== undefined && !isPermissionMode(task.mode)) throw new CommandRefused("invalid_mode");
    if (!(await isValidBranchName(cp.root, name))) throw new CommandRefused(`invalid_branch_name:${cmd.branch}`);
    const [common, worktrees] = await Promise.all([commonDir(cp.root), listWorktrees(cp.root)]);
    const inUse = worktrees.find((w) => w.branch === name);
    if (inUse) throw new CommandRefused(`branch_in_use:${inUse.path}`);
    const path = this.workbenchPath(name, cmd.path ?? null, cmd.location, common, worktrees);
    if (existsSync(path)) throw new CommandRefused(`path_exists:${path}`);
    const existing = await branchExists(cp.root, name);
    const ws = this.settings.workbenchSetup;
    const progress = (step: WorkbenchStep, extra: { logTail?: string; exitCode?: number | null } = {}): void => this.emit({ type: "workbench_progress", path, branch: name, step, ...extra });
    let from = existing ? null : cmd.from ?? null;
    let noTrack = false;
    let tempRef: string | null = null;
    if (!existing && cmd.fromPr && typeof cmd.fromPr === "object") {
      const n = cmd.fromPr.number;
      if (!Number.isInteger(n) || n <= 0) throw new CommandRefused("invalid_pr_number");
      const remote = await this.prRemote(cp.root, n);
      if (!remote) throw new CommandRefused("fetch_failed:no remote", { code: "fetch_failed" });
      tempRef = `refs/reviewgate/pr-fetch/${n}`;
      progress("fetch");
      const r = await fetchRef(cp.root, remote, `+refs/pull/${n}/head:${tempRef}`);
      progress("fetch", { logTail: r.logTail, exitCode: r.exitCode });
      if (!r.ok) throw new CommandRefused(`fetch_failed:${firstLogLine(r.logTail)}`, { code: "fetch_failed" });
      from = (await cp.git(["rev-parse", "--verify", `${tempRef}^{commit}`])).text.trim();
      noTrack = true;
    } else if (from) {
      const remoteRef = splitRemoteRef(from, await remoteNames(cp.root));
      if (remoteRef) {
        // The branch part goes into a refspec: a plain branch name only (no `:`, `*`, `^`, leading `-`, …).
        if (!(await isValidBranchName(cp.root, remoteRef.branch))) throw new CommandRefused(`invalid_branch_name:${from}`);
        noTrack = true;
        if (cmd.fetch ?? ws?.fetchBase ?? true) {
          progress("fetch");
          const r = await fetchRef(cp.root, remoteRef.remote, `+refs/heads/${remoteRef.branch}:refs/remotes/${remoteRef.remote}/${remoteRef.branch}`);
          progress("fetch", { logTail: r.logTail, exitCode: r.exitCode });
          if (!r.ok && !(await refExists(cp.root, `refs/remotes/${from}`))) throw new CommandRefused(`fetch_failed:${firstLogLine(r.logTail)}`, { code: "fetch_failed" });
        }
      }
    }
    progress("create");
    try {
      await addWorktree(cp.root, { path, branch: name, from, existingBranch: existing, noTrack });
    } catch (e) {
      this.fail(`Failed to create workbench ${name}: ${errorMessage(e)}`, false, "git", { code: "workbench_failed" });
      throw new CommandRefused(errorMessage(e), { code: "workbench_failed" });
    } finally {
      if (tempRef) await cp.git(["update-ref", "-d", tempRef], { allowFailure: true }).catch(() => undefined);
    }
    if (task?.text) await this.handTaskTo(path, cp.root, task.text, task.mode);
    const setupExit = cmd.setup === false ? undefined : await this.prepareWorkbench(cp.root, path, ws, progress);
    progress("done", setupExit !== undefined ? { exitCode: setupExit } : {});
    await this.refreshBranches();
    await this.refreshWorkbenches(false);
  }

  /**
   * §49: the task goes into the new worktree's git dir, where its window's engine takes it on `open_project`. A write that
   * fails refuses the create (`task_handoff_failed`) — the worktree is there, the task text stays with the client.
   */
  private async handTaskTo(path: string, fromRoot: string, text: string, mode: PermissionMode | undefined): Promise<void> {
    try {
      const gitDir = await resolveGitDir(path);
      await writeTaskHandoff(gitDir, { version: 1, from: { path: fromRoot, name: basename(fromRoot) }, text, ...(mode ? { mode } : {}), at: new Date().toISOString() });
      this.log("info", `task handed to ${path}${mode ? ` (${mode})` : ""}`);
    } catch (e) {
      await this.refreshWorkbenches(false).catch(() => undefined);
      this.log("warn", `workbench_create: handing the task to ${path} failed: ${errorMessage(e)}`);
      throw new CommandRefused(`task_handoff_failed:${errorMessage(e)}`, { code: "task_handoff_failed" });
    }
  }

  private async workbenchRemove(path: string, force: boolean): Promise<void> {
    const cp = this.requireProject();
    const [common, worktrees] = await Promise.all([commonDir(cp.root), listWorktrees(cp.root)]);
    const wanted = canonicalPath(path);
    const index = worktrees.findIndex((w) => samePath(w.path, path) || samePath(canonicalPath(w.path), wanted));
    if (index === -1) throw new CommandRefused(`unknown_worktree:${path}`);
    const wt: GitWorktree = worktrees[index]!;
    if (index === 0) throw new CommandRefused("cannot_remove_main");
    if (samePath(canonicalPath(wt.path), canonicalPath(cp.root))) throw new CommandRefused("cannot_remove_current");
    if (!force) {
      const dir = await linkedGitDir(wt, common, false);
      const lock = dir ? await readLock(dir) : null;
      if (lock && isPidAlive(lock.pid)) throw new CommandRefused(`worktree_locked:${lock.pid}`);
      if ((await worktreeDirty(wt.path)) === true) throw new CommandRefused("worktree_dirty");
    }
    try {
      await removeWorktree(cp.root, wt.path, force);
    } catch (e) {
      this.fail(`Failed to remove workbench ${wt.path}: ${errorMessage(e)}`, false, "git", { code: "workbench_failed" });
      throw new CommandRefused(errorMessage(e), { code: "workbench_failed" });
    }
    // Its admin dir went with it: drop its refs/reviewgate/wt-<name>/ pins (review + history).
    await this.pruneWorktreeNamespaces(cp);
    await this.refreshBranches();
    await this.refreshWorkbenches(false);
  }

  // MARK: wave3 engine-flow — §36.12 / §36.14 workbench setup

  /** Where a workbench of `branch` goes: `path` wins, else `location` (default `settings.workbenchSetup.location`, managed). */
  private workbenchPath(branch: string, explicitPath: string | null, location: unknown, common: string, worktrees: GitWorktree[]): string {
    if (explicitPath?.trim()) return resolve(explicitPath.trim());
    const loc = location === "sibling" || location === "managed" ? location : this.settings.workbenchSetup?.location;
    const main = worktrees[0];
    if (loc === "sibling" && main && !main.bare) return siblingPath(main.path, branch);
    return join(managedWorktreeRoot(this.settings, common), slugify(branch));
  }

  /** `workbench_preview`: the path `workbench_create` would use and the files it would copy (≤ 500 listed, every byte counted). */
  private async workbenchPreview(branch: string, location: unknown): Promise<WorkbenchPreviewEvent> {
    const cp = this.requireProject();
    const name = typeof branch === "string" ? branch.trim() : "";
    if (!(await isValidBranchName(cp.root, name))) throw new CommandRefused(`invalid_branch_name:${String(branch)}`);
    const [common, worktrees] = await Promise.all([commonDir(cp.root), listWorktrees(cp.root)]);
    const path = this.workbenchPath(name, null, location, common, worktrees);
    const items = await filesToCopy(cp.root, this.settings.workbenchSetup);
    const totalBytes = items.reduce((n, f) => n + f.bytes, 0);
    return { type: "workbench_preview", path, copy: items.slice(0, PREVIEW_MAX_ENTRIES), totalBytes, count: items.length, ...(items.length > PREVIEW_MAX_ENTRIES ? { truncated: true as const } : {}) };
  }

  /**
   * The copy and the setup of a new workbench (§36.12): the matched local files of this worktree, then the user's own
   * `setupCommand` in the new one. Returns the setup's exit code (null: killed), undefined when no setup ran.
   */
  private async prepareWorkbench(srcRoot: string, path: string, ws: WorkbenchSetup | undefined, progress: (step: WorkbenchStep, extra?: { logTail?: string; exitCode?: number | null }) => void): Promise<number | null | undefined> {
    const patterns = await copyPatternsFor(srcRoot, ws).catch(() => [] as string[]);
    if (patterns.length > 0) {
      progress("copy");
      try {
        const items = await matchingFiles(srcRoot, patterns);
        progress("copy", { logTail: copyLog(await copyFiles(srcRoot, path, items), items.length) });
      } catch (e) {
        progress("copy", { logTail: `Copy failed: ${errorMessage(e)}\n` });
      }
    }
    const command = typeof ws?.setupCommand === "string" ? ws.setupCommand.trim() : "";
    if (!command) return undefined;
    progress("setup");
    const tc = await this.locate().catch(() => null);
    let stop: (() => void) | null = null;
    const run = await runSetupCommand(command, path, { ...this.childEnv(), ...(tc?.path ? { PATH: tc.path } : {}) }, {
      platform: this.platform,
      onOutput: (logTail) => progress("setup", { logTail }),
      onStart: (s) => {
        stop = s;
        this.setupStops.add(s);
      },
    });
    if (stop) this.setupStops.delete(stop);
    if (run.exitCode !== 0) this.log("warn", `workbench setup in ${path} ended with ${run.exitCode === null ? "a kill (timeout)" : `exit ${run.exitCode}`}`);
    progress("setup", { logTail: run.logTail, exitCode: run.exitCode });
    return run.exitCode;
  }

  /** §36.14: the remote whose URL is the PR's repository (the PR tab's summary of PR `number`), else `origin`, else the only one. */
  private async prRemote(root: string, number: number): Promise<string | null> {
    const names = await remoteNames(root);
    if (names.length === 0) return null;
    const summary = (this.pr.selectedSummary?.number === number ? this.pr.selectedSummary : null) ?? [...this.pr.mine, ...this.pr.reviewRequested].find((s) => s.number === number) ?? null;
    if (summary) {
      const want = `${summary.host}/${summary.repo}`.toLowerCase();
      for (const name of names) {
        const out = await runGit(root, ["remote", "get-url", "--", name], { allowFailure: true, timeoutMs: 5000 }).catch(() => null);
        const parsed = out && out.status === 0 ? parseRemoteURL(out.text.trim()) : null;
        if (parsed && `${parsed.host}/${parsed.owner}/${parsed.repo}`.toLowerCase() === want) return name;
      }
    }
    return names.includes("origin") ? "origin" : names.length === 1 ? names[0]! : null;
  }

  // ------------------------------------------------------------------ pr_create

  /**
   * `gh pr create` for the current branch against `base` on the repository of the `origin` remote.
   * A branch without an upstream is pushed first (`git push -u origin <branch>`).
   */
  private async prCreate(base: string, title: string | null, body: string | null, draft: boolean, meta: PRCreateMeta = {}): Promise<PRCreatedEvent> {
    const cp = this.requireProject();
    const baseName = base.trim();
    if (!baseName) throw new CommandRefused("empty base", { code: "empty_base" });
    const [branch, remoteURL] = await Promise.all([cp.branchName(), cp.remoteURL()]);
    if (!branch) throw new CommandRefused("detached_head");
    if (!remoteURL) throw new CommandRefused("no_remote");
    const remote = parseRemoteURL(remoteURL);
    if (!remote) throw new CommandRefused(`unsupported_remote:${remoteURL}`);
    // §41.1: no title — the one `pr_draft` gives (the branch's commits since the base), else the branch; no body then — the
    // commits' list. `gh --fill` is never used: it reads git where gh runs and fails outside the repository.
    let prTitle = title?.trim() ?? "";
    let prBody = body;
    if (!prTitle) {
      const draft = prDraftFrom((await this.branchCommits(cp, baseName)).commits);
      prTitle = draft.title || branch;
      prBody ??= draft.body;
    }
    const upstream = await cp.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFailure: true });
    if (upstream.status !== 0) await cp.git(["push", "-u", "origin", branch], { userHooks: true }); // user-initiated: pre-push runs
    const gh = await this.resolveGH();
    const url = await createPR(gh, remote, {
      branch, base: baseName, title: prTitle, body: prBody ?? "", draft,
      // MARK: wave4c w4c-commit — §41.1 (prCreateArgs keeps only well-formed values)
      assignees: prMetaValues(meta.assignees), labels: prMetaValues(meta.labels), reviewers: prMetaValues(meta.reviewers), projects: prMetaValues(meta.projects),
    }, cp.root);
    this.pr.lastCreatedPR = { url, branch };
    this.touch();
    return { type: "pr_created", url, branch };
  }

  // ------------------------------------------------------------------ commit / push (docs/M12-COMMIT.md)

  /**
   * Stages `paths` (default: every accepted file; renames stage both paths), commits with `message`
   * (+ `settings.commitTrailer`), drops the committed files from the review and optionally pushes.
   * A push failure keeps the commit (`state.commit.lastCommit.pushError`) and is a refusal.
   */
  private async commit(rawMessage: string, requested: string[] | null, push: boolean): Promise<CommittedEvent> {
    const cp = this.requireProject();
    if (this.gate.running || this.gate.collecting || this.gate.reverting) throw new CommandRefused("session_running");
    // MARK: wave3 check-engine — §37.1: a commit re-snapshots B too; the failed collection is retried first.
    if (this.gate.collectError !== null) throw new CommandRefused("collect_failed");
    const accepted = acceptedPaths(this.gate);
    const paths = requested === null ? accepted : [...new Set(requested)];
    if (paths.length === 0 || paths.some((p) => !accepted.includes(p))) throw new CommandRefused("nothing_to_commit");
    let message = rawMessage.trim();
    if (!message) throw new CommandRefused("empty_message");
    const identity = await gitIdentity(cp.root);
    this.commitSlice.identity = identity;
    this.touch();
    const missing = [identity.name === null ? "user.name" : null, identity.email === null ? "user.email" : null].filter((k) => k !== null);
    if (missing.length > 0) throw new CommandRefused(`git_identity_missing:${missing.join(" and ")} not set (git config --global ${missing[0]} …)`);
    const trailer = (this.settings.commitTrailer ?? "").trim();
    if (trailer && !message.split(/\r?\n/).some((l) => l.trim() === trailer)) message += `\n\n${trailer}`;
    // §46: git refuses a partial commit during a merge, so this commit concludes it — the index as the merge left it plus the
    // accepted files. A file still unmerged, or a review file not accepted whose change is staged (Claude's `git add`), would
    // go in unresolved or unreviewed: it has to be accepted first.
    const merging = await cp.mergeInProgress().catch(() => null);
    if (merging) {
      const chosen = new Set(paths);
      const staged = new Set(await cp.indexPaths("staged"));
      const unreviewed = this.gate.changedFiles.filter((f) => !chosen.has(f.path) && f.state !== "accepted" && staged.has(f.path)).map((f) => f.path);
      const open = [...new Set([...(await cp.indexPaths("unmerged")).filter((p) => !chosen.has(p)), ...unreviewed])];
      if (open.length > 0) throw new CommandRefused(`merge_unresolved:${open.slice(0, 5).join(", ")}${open.length > 5 ? ", …" : ""}`, { code: "merge_unresolved", paths: open });
    }
    let sha: string;
    try {
      // `--only`: entries the user staged for other paths stay staged and out of this commit.
      const specs = await stagePaths(cp.root, paths, this.gate.changedFiles);
      sha = await gitCommit(cp.root, message, merging ? null : specs);
    } catch (e) {
      this.fail(`Failed to commit: ${errorMessage(e)}`, false, "git", { code: "commit_failed" });
      throw new CommandRefused(errorMessage(e), { code: "commit_failed" });
    }
    const branch = await cp.branchName();
    this.commitSlice.lastCommit = { sha, shortSha: sha.slice(0, 7), message, branch, pushed: false, pushError: null, files: paths, at: new Date().toISOString() };
    this.touch();
    try {
      await this.gate.dropCommitted(paths, { sha, subject: firstLineOf(message).slice(0, 200) }); // MARK: wave4 w4-history (§38.3)
    } catch (e) {
      this.fail(`Failed to refresh the review after the commit: ${errorMessage(e)}`, false, "git", { code: "refresh_failed" });
    }
    this.touch();
    await this.refreshBranches();
    await this.refreshWorkbenches(false);
    if (push) await this.pushLastCommit();
    return this.committedEvent();
  }

  // §53 commits in meaningful units

  /** `paths` as `commit` takes them (default every accepted file) as their review files; refused `nothing_to_commit`. */
  private commitFiles(requested: readonly unknown[] | null): ChangedFile[] {
    const accepted = acceptedPaths(this.gate);
    const paths = requested === null ? accepted : [...new Set(requested)];
    if (paths.length === 0 || paths.some((p) => typeof p !== "string" || !accepted.includes(p))) throw new CommandRefused("nothing_to_commit");
    return (paths as string[]).map((p) => this.gate.changedFiles.find((f) => f.path === p)).filter((f): f is ChangedFile => f !== undefined);
  }

  /** §53 `commit_hunks`: the accepted files as hunks of `git diff HEAD` — what a commit takes from the worktree. Reads only. */
  private async commitHunks(requested: unknown[] | null): Promise<CommitHunksEvent> {
    const cp = this.requireProject();
    const files = this.commitFiles(requested);
    return { type: "commit_hunks", files: (await headHunks(cp, files)).map((f) => f.file) };
  }

  /**
   * §53 `commit_series`: the commits in order, each git's own `commit` on a temporary index from HEAD (the hooks run as for
   * `commit`): a whole file as the worktree holds it, a file split by hunks as HEAD's content with the hunks of this and the
   * earlier commits applied (from the one `git diff HEAD` taken before the first). Everything is checked first, so a refusal
   * before the first commit changes nothing. The worktree is never written; the user's index keeps everything but the
   * committed paths, which follow HEAD. A failure in the middle stops there (`commit_failed` + `partial`). One push at the end.
   */
  private async commitSeries(rawCommits: unknown, push: boolean): Promise<CommittedSeriesEvent> {
    const cp = this.requireProject();
    if (this.gate.running || this.gate.collecting || this.gate.reverting) throw new CommandRefused("session_running");
    if (this.gate.collectError !== null) throw new CommandRefused("collect_failed");
    const accepted = acceptedPaths(this.gate);
    const raw: unknown[] = Array.isArray(rawCommits) ? rawCommits : [];
    const shape = raw.map((c) => (c && typeof c === "object" ? (c as { message?: unknown; parts?: unknown }) : {}));
    if (accepted.length === 0 || shape.length === 0 || shape.some((c) => !Array.isArray(c.parts) || c.parts.length === 0)) throw new CommandRefused("nothing_to_commit");
    const trailer = (this.settings.commitTrailer ?? "").trim();
    const messages = shape.map((c) => {
      let message = typeof c.message === "string" ? c.message.trim() : "";
      if (!message) throw new CommandRefused("empty_message");
      if (trailer && !message.split(/\r?\n/).some((l) => l.trim() === trailer)) message += `\n\n${trailer}`;
      return message;
    });
    // Every part: an accepted path, whole (no `hunks`) or a non-empty list of hunk ids.
    const parts = shape.map((c) => (c.parts as unknown[]).map((p) => {
      const part = p && typeof p === "object" ? (p as { path?: unknown; hunks?: unknown }) : {};
      const path = typeof part.path === "string" ? part.path : String(part.path);
      if (!accepted.includes(path)) throw new CommandRefused(`invalid_part:${path}`, { code: "invalid_part" });
      if (part.hunks === undefined || part.hunks === null) return { path, hunks: null };
      if (!Array.isArray(part.hunks) || part.hunks.length === 0 || part.hunks.some((id) => !Number.isInteger(id))) throw new CommandRefused(`invalid_part:${path}`, { code: "invalid_part" });
      return { path, hunks: part.hunks as number[] };
    }));
    const files = this.commitFiles([...new Set(parts.flat().map((p) => p.path))]);
    const head = new Map((await headHunks(cp, files)).map((f) => [f.file.path, f]));
    // Known hunk ids only, a whole-only file given whole, no hunk (or whole-only file) twice.
    const taken = new Map<string, Set<number>>();
    for (const part of parts.flat()) {
      const hf = head.get(part.path)!;
      const ids = hf.hunks.length === 0 ? [-1] : part.hunks ?? hf.hunks.map((h) => h.id);
      if (part.hunks !== null && (hf.hunks.length === 0 || part.hunks.some((id) => !hf.hunks.some((h) => h.id === id)))) throw new CommandRefused(`invalid_part:${part.path}`, { code: "invalid_part" });
      const used = taken.get(part.path) ?? new Set<number>();
      taken.set(part.path, used);
      for (const id of ids) {
        if (used.has(id)) throw new CommandRefused(id < 0 ? `hunk_twice:${part.path}` : `hunk_twice:${part.path}#${id}`, { code: "hunk_twice" });
        used.add(id);
      }
    }
    const identity = await gitIdentity(cp.root);
    this.commitSlice.identity = identity;
    this.touch();
    const missing = [identity.name === null ? "user.name" : null, identity.email === null ? "user.email" : null].filter((k) => k !== null);
    if (missing.length > 0) throw new CommandRefused(`git_identity_missing:${missing.join(" and ")} not set (git config --global ${missing[0]} …)`);
    // A series cannot conclude a merge (§46): its first commit would leave out what the merge brings in.
    if (await cp.mergeInProgress().catch(() => null)) throw new CommandRefused("merge_unresolved:a merge is in progress — conclude it with one commit (commit)", { code: "merge_unresolved" });
    // The content of each part split by hunks, computed now from the one diff above: nothing is committed if any fails.
    const planned = await this.planSeries(cp, messages, parts, head);
    const made: SeriesCommit[] = [];
    let failure: string | null = null;
    for (const c of planned) {
      try {
        const sha = await commitOnHead(cp, c.message, c.whole, c.blobs);
        made.push({ sha, shortSha: sha.slice(0, 7), message: c.message, files: c.files });
      } catch (e) {
        failure = e instanceof SeriesCommitError ? e.message : errorMessage(e);
        break;
      }
    }
    if (failure !== null) this.fail(`Failed to commit: ${failure}`, false, "git", { code: "commit_failed" });
    if (made.length === 0) throw new CommandRefused(`commit_failed:${failure}`, { code: "commit_failed" });
    const branch = await this.afterSeries(cp, planned.slice(0, made.length), made, head);
    if (failure !== null) throw new CommandRefused(`commit_failed:${failure}`, { code: "commit_failed", partial: { commits: made, branch, pushed: false } });
    if (push) await this.pushLastCommit();
    return { type: "committed_series", commits: made, branch, pushed: this.commitSlice.lastCommit?.pushed === true };
  }

  /** §53: each commit's message, its whole paths (a rename's both) and its blobs; refused `commit_failed` when a split file's diff no longer matches it. */
  private async planSeries(cp: GitCheckpoint, messages: string[], parts: { path: string; hunks: number[] | null }[][], head: ReadonlyMap<string, HeadFile>): Promise<PlannedCommit[]> {
    const sides = new Map<string, { head: Buffer; work: Buffer; mode: string }>();
    const applied = new Map<string, Set<number>>();
    const planned: PlannedCommit[] = [];
    for (const [k, list] of parts.entries()) {
      const c: PlannedCommit = { message: messages[k]!, whole: [], blobs: [], files: [], parts: list };
      for (const part of list) {
        if (!c.files.includes(part.path)) c.files.push(part.path);
        const hf = head.get(part.path)!;
        if (part.hunks === null) {
          c.whole.push(part.path);
          if (hf.file.oldPath) c.whole.push(hf.file.oldPath);
          continue;
        }
        let side = sides.get(part.path);
        if (!side) {
          const [h, w, mode] = await Promise.all([cp.fileContent(part.path, "HEAD"), worktreeBlob(cp, part.path), cp.treeMode("HEAD", part.path)]);
          side = { head: h, work: w.content, mode: mode ?? "100644" };
          sides.set(part.path, side);
        }
        const done = applied.get(part.path) ?? new Set<number>();
        applied.set(part.path, done);
        for (const id of part.hunks) done.add(id);
        let content: Buffer;
        try {
          content = splitContent(side.head, side.work, hf.hunks, done);
        } catch (e) {
          throw new CommandRefused(`commit_failed:${part.path} changed while the commits were prepared (${errorMessage(e)})`, { code: "commit_failed" });
        }
        const blob = { path: part.path, mode: side.mode, sha: await writeBlob(cp, content) };
        c.blobs = [...c.blobs.filter((b) => b.path !== part.path), blob];
      }
      planned.push(c);
    }
    return planned;
  }

  /**
   * §53 after the commits `made` (the first `planned`): the user's index entries of the committed paths follow HEAD, the last
   * commit is `state.commit.lastCommit`, every fully committed file leaves the review with the commit that took its last
   * part (§38.3) and a file committed partly stays, accepted, with the rest of its hunks. Returns the branch.
   */
  private async afterSeries(cp: GitCheckpoint, planned: readonly PlannedCommit[], made: readonly SeriesCommit[], head: ReadonlyMap<string, HeadFile>): Promise<string | null> {
    const touched = [...new Set(planned.flatMap((c) => [...c.whole, ...c.blobs.map((b) => b.path)]))];
    try {
      await indexToHead(cp, touched);
    } catch (e) {
      this.fail(`Failed to update the index after the commits: ${errorMessage(e)}`, false, "git", { code: "commit_failed" });
    }
    const branch = await cp.branchName();
    const last = made[made.length - 1]!;
    this.commitSlice.lastCommit = { sha: last.sha, shortSha: last.shortSha, message: last.message, branch, pushed: false, pushError: null, files: last.files, at: new Date().toISOString() };
    this.touch();
    const taken = new Map<string, Set<number>>();
    const tookLast = new Map<string, HistoryCommit>();
    for (const [k, c] of planned.entries()) {
      for (const part of c.parts) {
        const all = head.get(part.path)!.hunks.map((h) => h.id);
        const used = taken.get(part.path) ?? new Set<number>();
        taken.set(part.path, used);
        for (const id of part.hunks ?? all) used.add(id);
        tookLast.set(part.path, { sha: made[k]!.sha, subject: firstLineOf(made[k]!.message).slice(0, 200) });
      }
    }
    const full = [...taken.entries()].filter(([path, used]) => head.get(path)!.hunks.every((h) => used.has(h.id))).map(([path]) => path);
    const kept = [...taken.keys()].filter((path) => !full.includes(path));
    try {
      await this.gate.dropCommitted(full, tookLast, { commits: made.length, kept });
    } catch (e) {
      this.fail(`Failed to refresh the review after the commit: ${errorMessage(e)}`, false, "git", { code: "refresh_failed" });
    }
    this.touch();
    await this.refreshBranches();
    await this.refreshWorkbenches(false);
    return branch;
  }

  /** `git push` for the last commit (`push -u origin <branch>` without an upstream); refused with `no_remote` / `push_failed:<line>`. */
  private async pushLastCommit(): Promise<CommittedEvent> {
    const cp = this.requireProject();
    const last = this.commitSlice.lastCommit;
    if (!last) throw new CommandRefused("nothing_to_push");
    try {
      await gitPush(cp.root, await cp.branchName());
    } catch (e) {
      const code = errorMessage(e);
      this.commitSlice.lastCommit = { ...last, pushed: false, pushError: code };
      this.touch();
      await this.refreshBranches();
      throw new CommandRefused(code);
    }
    this.commitSlice.lastCommit = { ...last, pushed: true, pushError: null };
    this.touch();
    await this.refreshBranches();
    return this.committedEvent();
  }

  private committedEvent(): CommittedEvent {
    const last = this.commitSlice.lastCommit!;
    return { type: "committed", sha: last.sha, shortSha: last.shortSha, pushed: last.pushed, branch: last.branch };
  }

  // ------------------------------------------------------------------ §23 file mentions / §24 attachments

  /** Validates `send.mentions` / `send.attachments` before anything changes (refusals: invalid_mention, too_many_mentions, attachment_*). */
  private sendOptions(mentions: unknown, attachments: unknown): SendOptions {
    const out: SendOptions = {};
    if (mentions !== undefined && mentions !== null) {
      if (!Array.isArray(mentions)) throw new CommandRefused("invalid_mention:mentions must be an array", { code: "invalid_mention" });
      if (mentions.length > MAX_MENTIONS) throw new CommandRefused(`too_many_mentions:${mentions.length} > ${MAX_MENTIONS}`, { code: "too_many_mentions" });
      const root = this.gate.checkpoint?.root;
      if (!root) throw new CommandRefused("no_project");
      const list: { path: string; kind: "file" | "dir" }[] = [];
      for (const m of mentions) {
        const rel = typeof m === "string" ? repoRelativeInside(root, m) : null;
        if (rel === null) throw new CommandRefused(`invalid_mention:${String(m).slice(0, 200)}`, { code: "invalid_mention" });
        if (list.some((x) => x.path === rel)) continue;
        let kind: "file" | "dir" = "file";
        try {
          if (statSync(join(root, rel)).isDirectory()) kind = "dir";
        } catch {
          // a path that does not exist (yet / any more) is mentioned as a file
        }
        list.push({ path: rel, kind });
      }
      if (list.length > 0) out.mentions = list;
    }
    const images = prepareAttachments(attachments);
    if (images.length > 0) out.images = images;
    return out;
  }

  /** `list_files {query, limit?}` → `files`: fuzzy matches over the repository's files + directories, review files first. */
  private async listFiles(query: unknown, limit: unknown): Promise<FilesEvent> {
    const cp = this.requireProject();
    const q = typeof query === "string" ? query.slice(0, 500) : "";
    this.fileIndex ??= new FileIndex(() => listRepoFiles(cp));
    const changed = new Set(this.gate.changedFiles.filter((f) => f.status !== "D").map((f) => f.path));
    const n = typeof limit === "number" && limit > 0 ? limit : LIST_FILES_MAX;
    try {
      return { type: "files", query: q, items: await this.fileIndex.search(q, changed, n) };
    } catch (e) {
      throw new CommandRefused(`list_files_failed:${firstLineOf(errorMessage(e))}`, { code: "list_files_failed" });
    }
  }

  /** `attachment_get {hash}` → `attachment` (the image a transcript row references). */
  private async attachmentGet(hash: unknown): Promise<AttachmentEvent> {
    const dir = this.projectGitDir;
    if (!dir) throw new CommandRefused("no_project");
    const found = await loadAttachment(dir, typeof hash === "string" ? hash : "");
    if (!found) throw new CommandRefused(`unknown_attachment:${String(hash).slice(0, 80)}`, { code: "unknown_attachment" });
    return { type: "attachment", hash: hash as string, mediaType: found.mediaType, dataBase64: found.data.toString("base64") };
  }

  // ------------------------------------------------------------------ §25 model / effort

  private effectiveModel(): string | null {
    return this.modelChoice.model !== undefined ? this.modelChoice.model : this.settings.model?.trim() || null;
  }

  private effectiveEffort(): EffortLevel | null {
    return this.modelChoice.effort !== undefined ? this.modelChoice.effort : this.settings.effort ?? null;
  }

  /** `model` / `effort` of a session start: the project's `set_model` choice, else the settings. */
  private startModel(): { model?: string; effort?: EffortLevel } {
    const model = this.effectiveModel();
    const effort = this.effectiveEffort();
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }

  /**
   * `set_model {model, effort?}`: switches the running session (`Query.setModel`, flag `effortLevel`) without a
   * restart — allowed while a turn runs, it applies from the CLI's next model request — and persists the choice per
   * project (`reviewgate-session.json`), so every later session of the project starts with it.
   */
  private async setModel(rawModel: unknown, rawEffort: unknown): Promise<void> {
    if (!this.project || !this.gate.checkpoint) throw new CommandRefused("no_project");
    const model = validateModel(rawModel);
    const effort = validateEffort(rawEffort);
    const session = this.session;
    if (session && !this.sessionState.starting) {
      try {
        if (typeof session.setModel === "function") await withTimeout(session.setModel(model), 15_000, "setModel");
        if (typeof session.setModel === "function") this.liveModels.set(session, model); // MARK: wave5 w5-model (§43.4)
        if (effort !== undefined && typeof session.setEffort === "function") await withTimeout(session.setEffort(effort), 15_000, "setEffort");
      } catch (e) {
        throw new CommandRefused(`set_model_failed:${firstLineOf(errorMessage(e))}`, { code: "set_model_failed" });
      }
    }
    this.modelChoice = { ...this.modelChoice, model, ...(effort !== undefined ? { effort } : {}) };
    this.persistSessions();
    this.touch();
  }

  // ------------------------------------------------------------------ MARK: wave5 w5-model — §43.4 auto model

  /**
   * The model a message goes out on, set on the live session before it is sent (the gate is closed meanwhile, so never
   * during a turn): this message's own pick (`send.model`), else auto's (`settings.modelMode: "auto"`), else — manual —
   * the chip's model again after a one-message pick. null when nothing was decided or set (manual as before, no session,
   * a starting CLI, a failed switch: the message goes out on the model the session has).
   */
  private async chooseTurnModel(input: Pick<AutoModelInput, "text" | "mentions" | "attachments" | "retry">, override?: string | null): Promise<AutoModelChoice | null> {
    const planImplementation = this.planImplementNext;
    const retry = input.retry ?? this.autoRetry;
    this.planImplementNext = false;
    this.autoRetry = null;
    const session = this.session;
    if (!session || typeof session.setModel !== "function" || this.sessionState.starting) return null;
    const policy = autoModelPolicy(this.settings.modelAutoPolicy);
    const live = this.liveModels.has(session) ? this.liveModels.get(session)! : undefined;
    const models = this.models ?? STATIC_MODELS;
    const resolvedOf = (value: string | null): string | null => (value === null ? null : models.find((m) => m.value === value)?.resolvedModel ?? value);
    let choice: AutoModelChoice;
    if (override !== undefined) {
      const family = modelFamily(resolvedOf(override));
      choice = { model: override, ...(family ? { family } : {}), reason: "user_choice", policy, by: "user" };
    } else if (this.settings.modelMode === "auto") {
      const previousFamily: ModelFamily | null = this.sessionState.autoModel?.family ?? modelFamily(resolvedOf(live ?? null) ?? this.sessionState.model);
      const decision = decideAutoModel({ ...input, policy, retry, planImplementation, planMode: this.sessionState.permissionMode === "plan", previousFamily });
      // A family the session does not offer falls back to sonnet; without sonnet the message keeps the session's model.
      const family = pickFamilyModel(decision.family, models) ? decision.family : "sonnet";
      const model = pickFamilyModel(family, models);
      if (!model) return null;
      choice = { model, family, reason: decision.reason, policy, by: "auto" };
    } else {
      const want = this.effectiveModel();
      if (live === undefined || live === want) return null;
      const family = modelFamily(resolvedOf(want));
      choice = { model: want, ...(family ? { family } : {}), reason: "manual", policy, by: "manual" };
    }
    if (live !== choice.model) {
      try {
        await withTimeout(session.setModel(choice.model), 15_000, "setModel");
      } catch (e) {
        this.log("warn", `auto model: switching to ${choice.model ?? "default"} failed, the message keeps the session's model: ${errorMessage(e)}`);
        return null;
      }
      this.liveModels.set(session, choice.model);
      choice = { ...choice, switched: true, from: live === undefined ? this.sessionState.model : live };
    }
    if (choice.by === "auto" && choice.family) this.hud.autoModelCounts = countAutoModel(this.hud.autoModelCounts ?? [], choice.family);
    this.sessionState.autoModel = { ...choice };
    return choice;
  }

  // ------------------------------------------------------------------ §27 context / §28 interrupt

  /** `context_warning` once when the context crosses 80 % of the window; re-armed when it drops below (compaction). */
  private checkContextWarning(): void {
    const window = this.hud.contextWindow;
    const tokens = this.hud.contextTokens;
    if (!window || window <= 0) return;
    const percent = Math.round((tokens / window) * 1000) / 10;
    if (percent < CONTEXT_WARNING_PERCENT) {
      this.contextWarned = false;
      return;
    }
    if (this.contextWarned) return;
    this.contextWarned = true;
    this.emit({ type: "context_warning", percent, contextTokens: tokens, contextWindow: window });
  }

  /** `compact {focus?}`: the CLI's `/compact [focus]` as a turn (gate rules of `send`; the review summary waits for the next message). */
  private async compact(focus: unknown): Promise<void> {
    const f = typeof focus === "string" ? focus.replace(/\s+/g, " ").trim() : "";
    if (f.length > MAX_COMPACT_FOCUS) throw new CommandRefused(`focus_too_long:${f.length} > ${MAX_COMPACT_FOCUS}`, { code: "focus_too_long" });
    const sent = await this.send(f ? `/compact ${f}` : "/compact", false, { command: true });
    if (!sent) throw new CommandRefused("send_failed");
  }

  /**
   * `interrupt`: `Query.interrupt()` (an open permission card is denied with it), then waits — at most
   * `interruptWaitMs` — until the turn ended (`turn_end{stopReason:"interrupted"}`) and its changes were collected,
   * so a `send` queued right behind it goes out ("중단하고 보내기"). A no-op without a running turn.
   */
  private async interruptTurn(): Promise<void> {
    const session = this.session;
    if (!this.gate.running || !session) return;
    await session.interrupt();
    const deadline = Date.now() + this.interruptWaitMs;
    while ((this.gate.running || this.gate.collecting) && Date.now() < deadline && !this.closed) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.gate.running) this.log("warn", `interrupt: the turn was still running after ${this.interruptWaitMs} ms`);
  }

  // ------------------------------------------------------------------ §26 checkpoints / rewind

  /** Loads the chat's checkpoint timeline; the conversation's last known point is the latest listed turn's end. */
  private bindCheckpoints(chatId: string): void {
    const dir = this.projectGitDir;
    this.checkpoints = dir ? loadCheckpoints(dir, chatId) : { version: 1, records: [], pendingFork: null };
    this.turnRecord = null;
    const last = [...this.checkpoints.records].reverse().find((r) => r.kind === "turn" && !r.abandoned);
    this.lastForkPoint = last?.cliSessionId && last.lastUuid ? { sessionId: last.cliSessionId, uuid: last.lastUuid } : null;
  }

  private saveCheckpointFile(): void {
    const dir = this.projectGitDir;
    const chat = this.currentSessionId;
    if (!dir || !chat) return;
    try {
      saveCheckpoints(dir, chat, this.checkpoints);
      this.saveOk("checkpoints"); // MARK: wave4b w4b-bigturn (§39.1)
    } catch (e) {
      this.saveFailed("checkpoints", e, "persist checkpoints");
    }
  }

  private pinRecord(rec: CheckpointRecord, which: "start" | "end"): void {
    const cp = this.gate.checkpoint;
    const tree = which === "start" ? rec.startTree : rec.endTree;
    if (!cp || !tree) return;
    const ref = checkpointRefs(this.gate.refNs, rec.id)[which];
    this.persistChain = this.persistChain.then(() => cp.pinRef(ref, tree)).catch((e) => this.saveFailed("checkpoints", e, "pin checkpoint"));
  }

  /** Deletes `refs/reviewgate/<ns>/turns/<id>/…` no chat of the worktree references any more. */
  private pruneTurnRefs(): void {
    const cp = this.gate.checkpoint;
    const dir = this.projectGitDir;
    if (!cp || !dir) return;
    const prefix = `${refPrefix(this.gate.refNs)}turns/`;
    this.persistChain = this.persistChain
      .then(async () => {
        const keep = referencedRecordIds(dir);
        for (const r of this.checkpoints.records) keep.add(r.id);
        const ids = new Set((await cp.refsUnder(prefix)).map((r) => r.slice(prefix.length).split("/")[0]).filter((id): id is string => !!id));
        for (const id of ids) if (!keep.has(id)) await cp.deleteRefsUnder(`${prefix}${id}/`);
      })
      .catch((e) => this.log("warn", `prune checkpoint refs: ${errorMessage(e)}`));
  }

  /** A user turn starts (`beginTurn`): its record, with where the conversation stood right before it. */
  private openRecord(prompt: string): void {
    const chat = this.currentSessionId;
    if (!this.projectGitDir || !chat) {
      this.turnRecord = null;
      return;
    }
    const meta = this.sessions?.get(chat);
    // MARK: wave3 engine-session — §36.9: an imported chat's first turn follows a terminal conversation, never a fresh start.
    const before: ForkPoint | null = meta && meta.turns === 0 && !meta.imported ? { mode: "fresh" } : this.lastForkPoint ? { mode: "at", sessionId: this.lastForkPoint.sessionId, uuid: this.lastForkPoint.uuid } : null;
    const rec = newRecord("turn", { turn: this.turn, prompt: prompt.slice(0, 200), before, modsCaptured: true });
    this.turnRecord = rec;
    this.checkpoints.records.push(rec);
    this.checkpoints.records = this.checkpoints.records.slice(-MAX_CHECKPOINT_RECORDS_KEPT);
    this.saveCheckpointFile();
  }

  /** The turn's own start tree: snapshot A when it was fresh, else a snapshot of its own (A is the review's). Best effort. */
  private async startRecord(tree: string | null): Promise<void> {
    const rec = this.turnRecord;
    const cp = this.gate.checkpoint;
    if (!rec || !cp) return;
    try {
      rec.startTree = tree ?? (await cp.snapshot(this.settings.ignorePatterns));
    } catch (e) {
      this.log("warn", `checkpoint snapshot: ${errorMessage(e)}`);
      return;
    }
    this.saveCheckpointFile();
    this.pinRecord(rec, "start");
  }

  /** The send never reached Claude: the turn did not happen. */
  private dropRecord(): void {
    const rec = this.turnRecord;
    this.turnRecord = null;
    if (!rec) return;
    this.checkpoints.records = this.checkpoints.records.filter((r) => r !== rec);
    this.saveCheckpointFile();
  }

  /**
   * After the turn's collection: `rec`'s end tree (B, `end`) and the files it changed (its start tree → B). `rec` is the
   * collected turn's record — the current one is left alone when a send has opened the next turn's meanwhile.
   */
  private async closeRecord(rec: CheckpointRecord | null, end: string | null, listed: readonly ChangedFile[], toolFiles: ToolFileEntry[] = [], windows: ToolWindow[] = [], delta: TurnDelta | null = null): Promise<void> {
    const cp = this.gate.checkpoint;
    if (this.turnRecord === rec) this.turnRecord = null;
    if (!rec || !cp) return;
    rec.endedAt = new Date().toISOString();
    if (end && rec.startTree) {
      try {
        // MARK: wave3 check-engine — §37.3: the collection already diffed exactly these trees (its own delta of the turn).
        if (delta !== null && delta.base === rec.startTree && delta.end === end) rec.files = [...delta.paths];
        else {
          const changes = await cp.changes(rec.startTree, end);
          rec.files = [...new Set(changes.flatMap((f) => (f.oldPath !== null && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path])))].sort();
        }
        rec.endTree = end;
        // MARK: wave2 check-engine — §35.11: the files of this turn no call of it explains (§31) — a file rewind leaves them.
        const ids = new Set([...toolFiles.flatMap((tf) => tf.toolUseIds ?? []), ...windows.map((w) => w.toolUseId)]);
        const external = rec.files.filter((p) => {
          const f = listed.find((x) => x.path === p || x.oldPath === p);
          return f !== undefined && !f.toolUseIds.some((id) => ids.has(id));
        });
        if (external.length > 0) rec.external = external;
      } catch (e) {
        this.log("warn", `checkpoint diff: ${errorMessage(e)}`);
      }
    }
    this.saveCheckpointFile();
    this.pinRecord(rec, "end");
  }

  /**
   * `rewind {toTurn, mode, editText?, force?}` (§26). `files`: Claude's changes from turn `toTurn` on are restored to
   * that turn's start tree — only files the timeline says a turn (or an earlier rewind) changed, and only when they
   * still hold what that turn left (else `file_changed_since_review` unless `force`). `conversation`: the chat is
   * forked right before the turn (`resumeSessionAt` + `forkSession`) into a new current chat; the old one stays in
   * the list as "… (되돌리기 전)". `editText` is then sent as the new turn. Refused while anything is in flight.
   */
  private async rewind(toTurn: unknown, mode: unknown, cmd: { editText?: unknown; mentions?: unknown; attachments?: unknown; force?: unknown }): Promise<RewoundKeptEvent> {
    const cp = this.requireProject();
    if (mode !== "conversation" && mode !== "files" && mode !== "both") throw new CommandRefused(`invalid_rewind_mode:${String(mode)}`, { code: "invalid_rewind_mode" });
    if (typeof toTurn !== "number" || !Number.isInteger(toTurn)) throw new CommandRefused(`unknown_turn:${String(toTurn)}`, { code: "unknown_turn" });
    if (this.sessionState.starting || this.gate.running || this.gate.collecting || this.gate.reverting || this.session?.isTurnActive) throw new CommandRefused("session_busy");
    if (this.gate.collectError !== null) throw new CommandRefused("collect_failed");
    const records = this.checkpoints.records;
    const index = indexOfTurn(records, toTurn);
    if (index < 0) throw new CommandRefused(`unknown_turn:${toTurn}`, { code: "unknown_turn" });
    const rec = records[index]!;
    const conversation = mode !== "files";
    const files = mode !== "conversation";
    if (conversation) {
      this.guardSessionSwitch();
      if (rec.before === null) throw new CommandRefused("rewind_unavailable:conversation", { code: "rewind_unavailable" });
      // MARK: wave3 check-engine — §37.4: a record's conversation is gone from the CLI — nothing inside it can be forked.
      if (rec.before.mode === "at" && this.openChatIsRecord()) throw new CommandRefused("rewind_unavailable:conversation", { code: "rewind_unavailable" });
    }
    const plan = files ? filesPlan(records, index) : null;
    if (files && !plan) throw new CommandRefused("rewind_unavailable:files", { code: "rewind_unavailable" });
    const editText = typeof cmd.editText === "string" ? cmd.editText.trim() : "";
    const sendOpts = editText ? this.sendOptions(cmd.mentions, cmd.attachments) : {};
    let restored: string[] = [];
    let kept: string[] = []; // MARK: wave2 check-engine (§35.11)
    if (plan) ({ restored, kept } = await this.rewindFiles(cp, plan, toTurn, cmd.force === true, rec.modsCaptured === true));
    if (conversation) await this.rewindConversation(rec, index);
    if (editText) {
      const sent = await this.send(editText, false, sendOpts);
      if (!sent) throw new CommandRefused("send_failed");
    }
    return { type: "rewound", toTurn, mode, restoredFiles: restored, sessionId: this.currentSessionId, ...(kept.length > 0 ? { keptFiles: kept } : {}) };
  }

  private async rewindFiles(cp: GitCheckpoint, plan: NonNullable<ReturnType<typeof filesPlan>>, toTurn: number, force: boolean, modsCaptured: boolean): Promise<{ restored: string[]; kept: string[] }> {
    // §32: a start tree an older engine took has no mods entries — absent there does not mean "added since".
    if (!modsCaptured) plan = { ...plan, paths: plan.paths.filter((p) => !isModsPath(p)) };
    // MARK: wave2 check-engine — §35.11: what nothing of Claude's changed in those turns (the user's save meanwhile) stays.
    const kept: string[] = [];
    for (const p of plan.paths) if (plan.external.has(p) && !(await cp.worktreeMatches(plan.startTree, p))) kept.push(p);
    plan = { ...plan, paths: plan.paths.filter((p) => !plan.external.has(p)) };
    const edited: string[] = [];
    for (const p of plan.paths) {
      if ((await cp.worktreeMatches(plan.lastEnd.get(p)!, p)) || (await cp.worktreeMatches(plan.startTree, p))) continue;
      edited.push(p);
    }
    if (edited.length > 0 && !force) {
      throw new CommandRefused(`file_changed_since_review:${edited.join(", ")}`, { code: "file_changed_since_review", paths: edited });
    }
    this.gate.reverting = true;
    this.touch();
    const restored: string[] = [];
    try {
      for (const p of plan.paths) {
        if (await cp.worktreeMatches(plan.startTree, p)) continue;
        const mode = await cp.treeMode(plan.startTree, p);
        if (mode === "160000") continue; // a submodule's commit is not ours to move
        await cp.revert({ path: p, oldPath: null, status: mode === null ? "A" : "M" }, plan.startTree);
        restored.push(p);
      }
    } catch (e) {
      this.fail(`Failed to rewind files: ${errorMessage(e)}`, false, "git", { code: "revert_failed" });
      throw new CommandRefused(errorMessage(e), { code: "revert_failed" });
    } finally {
      this.gate.reverting = false;
      this.fileIndex?.invalidate();
    }
    try {
      const end = await cp.snapshot(this.settings.ignorePatterns);
      const rec = newRecord("rewind", { prompt: `rewind to turn ${toTurn}`, endedAt: new Date().toISOString(), endTree: end, files: [...restored] });
      this.checkpoints.records.push(rec);
      this.checkpoints.records = this.checkpoints.records.slice(-MAX_CHECKPOINT_RECORDS_KEPT);
      this.saveCheckpointFile();
      this.pinRecord(rec, "end");
      // The review follows the worktree like `refresh`: reverted files drop out, an accepted file whose content
      // the rewind replaced is reviewed again. Without a standing review nothing becomes one (the gate is turn-based).
      if (this.gate.changedFiles.length > 0) await this.gate.refresh({ repend: new Set(restored) });
    } catch (e) {
      this.fail(`Failed to refresh the review after the rewind: ${errorMessage(e)}`, false, "git", { code: "refresh_failed" });
    }
    this.touch();
    await this.refreshBranches();
    return { restored, kept };
  }

  /** Forks the chat right before `rec` into a new current chat (transcript + checkpoints up to there copied). */
  private async rewindConversation(rec: CheckpointRecord, index: number): Promise<void> {
    const idx = this.sessions!;
    const dir = this.projectGitDir!;
    const old = idx.get(this.currentSessionId!)!;
    const turn = rec.turn!;
    const kept = (this.transcript?.tail(Number.MAX_SAFE_INTEGER) ?? []).filter((r) => r.turn < turn);
    const meta = idx.create();
    meta.title = old.title.endsWith(REWOUND_TITLE_SUFFIX) ? old.title.slice(0, -REWOUND_TITLE_SUFFIX.length) : old.title;
    meta.forkedFrom = { sessionId: old.id, turn };
    meta.turns = Math.max(0, turn - 1);
    meta.costUSD = kept.reduce((n, r) => n + (r.kind === "turn_end" ? r.usage.costUsd ?? 0 : 0), 0);
    const lastUser = [...kept].reverse().find((r) => r.kind === "user_message");
    meta.lastUserText = lastUser?.kind === "user_message" ? lastUser.text : null;
    if (!old.title.endsWith(REWOUND_TITLE_SUFFIX)) old.title += REWOUND_TITLE_SUFFIX;
    const store = idx.transcript(meta.id);
    for (const row of kept) store.append(row);
    const before = rec.before!;
    saveCheckpoints(dir, meta.id, {
      version: 1,
      // Later turns stay in the file timeline (their changes may still be on disk) but are not listed.
      records: this.checkpoints.records.map((r, i) => (i >= index && r.kind === "turn" ? { ...r, abandoned: true as const } : { ...r })),
      pendingFork: before.mode === "at" ? { sessionId: before.sessionId, uuid: before.uuid } : null,
    });
    this.openTabIds = this.openTabIds.map((id) => (id === old.id ? meta.id : id));
    this.log("info", `rewind: chat ${old.id} → ${meta.id} before turn ${turn} (${before.mode})`);
    // MARK: wave4b w4b-side — §40.3: the side threads go on with the conversation (the rewound record keeps none).
    await this.side.stopAll();
    await this.side.moveTo(meta.id).catch((e: unknown) => this.log("warn", `side threads: ${errorMessage(e)}`));
    await this.switchSession(meta, before.mode === "at");
  }

  // ------------------------------------------------------------------ side questions (docs/PROTOCOL.md §21)

  /**
   * Where a new side thread starts: no main conversation yet → fresh; main idle → a fork of the whole main session
   * (its latest point is a completed turn); main running → a fork at the last completed turn's chain uuid, or the
   * whole session when that uuid is unknown (engine restarted mid-session; the partial turn may then be included).
   */
  private sideForkSource(): ForkSource {
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    // MARK: wave3 engine-flow — §36.10: the running turn is summarized in the first prompt of a fork_at / fresh start.
    const running = this.gate.running || this.session?.isTurnActive === true;
    // Only a turn of ours (an unprompted CLI turn, §18, has no request to summarize).
    const runningTurn = this.gate.running ? this.turn : null;
    // MARK: wave2 check-engine — §35.4: an open record has no conversation to fork (the CLI lost it).
    const mainId = this.sessionState.sessionId ?? (meta && this.recordOnlyNext === null && this.isResumable(meta) ? meta.id : null);
    if (!mainId) return { mode: "fresh", atTurn: null, runningTurn };
    if (!running) return { mode: "fork_full", sessionId: mainId, atTurn: this.turn, runningTurn: null };
    if (this.lastForkPoint && this.lastForkPoint.sessionId === mainId) return { mode: "fork_at", sessionId: mainId, at: this.lastForkPoint.uuid, atTurn: this.forkPointTurn(this.lastForkPoint.uuid), runningTurn };
    // The first turn of a brand-new chat is still running: nothing completed to fork from.
    if (!meta || meta.turns === 0) return { mode: "fresh", atTurn: null, runningTurn };
    // §36.10: the whole session may hold part of the running turn — no block (it would only repeat a part of it).
    return { mode: "fork_full", sessionId: mainId, atTurn: this.turn, runningTurn: null };
  }

  // MARK: wave3 engine-flow — §36.10

  /** The turn whose end left the chain uuid `uuid` (its §26 record), else the turn before the current one. */
  private forkPointTurn(uuid: string): number {
    const record = [...this.checkpoints.records].reverse().find((r) => r.kind === "turn" && r.lastUuid === uuid && typeof r.turn === "number");
    return record?.turn ?? Math.max(0, this.turn - 1);
  }

  /** §36.10: the block of the running turn a fork_at / fresh first question summarizes (`source.runningTurn`); else nothing. */
  private sideRunningTurn(source: ForkSource): Pick<AnchorData, "running"> {
    const turn = source.runningTurn;
    if (typeof turn !== "number") return {};
    const root = this.gate.checkpoint?.root;
    const ctx = runningTurnFromRows(this.transcript?.tail(RUNNING_TURN_ROWS) ?? [], turn, (abs) => (root ? toRepoRelative(abs, root) : null));
    // The turn's text so far is held until its end (`flushTurnText`).
    if (turn === this.turn && this.gate.running && !this.turnTextUnprompted) ctx.assistantText = this.turnText;
    return { running: runningTurnBlock(ctx) };
  }

  // MARK: wave3 engine-flow — §36.11

  /**
   * `commit_draft`: a read-only fork of the main session (no thread) writes the commit message for the accepted `paths`
   * (default every accepted file) from their A → B diff, the last 20 commit subjects, the branch and the rendered
   * `settings.commitTemplate`. Nothing is committed; the main conversation and the review are untouched.
   */
  private async commitDraft(requested: string[] | null): Promise<CommitDraftEvent> {
    const cp = this.requireProject();
    const accepted = acceptedPaths(this.gate);
    const paths = requested === null ? accepted : [...new Set(requested)];
    if (paths.length === 0 || paths.some((p) => !accepted.includes(p))) throw new CommandRefused("nothing_to_commit");
    const start = this.gate.turnStartTree;
    const end = this.gate.reviewEndTree;
    if (start === null || end === null) throw new CommandRefused("nothing_to_commit");
    const files = paths.map((p) => this.gate.changedFiles.find((f) => f.path === p)).filter((f): f is ChangedFile => f !== undefined);
    // MARK: wave4c w4c-commit — §41.1: the last 50 subjects teach the team's format; the prompt keeps the newest 20.
    const [format, patch] = await Promise.all([this.teamFormat(cp), roundPatch(cp, start, end, files, COMMIT_DRAFT_DIFF_LINES)]);
    const { branch } = format;
    const subjects = format.subjects.slice(0, COMMIT_DRAFT_SUBJECTS);
    const template = format.effective;
    const run = await this.side.startDetached({
      key: `commit_draft:${randomUUID()}`,
      prompt: commitDraftPrompt({ branch, template, subjects, patch, files, ...(format.source ? { templateSource: format.source } : {}), examples: format.learned?.examples ?? [] }),
      options: { persistSession: false, allowWeb: false, system: COMMIT_DRAFT_SYSTEM },
    });
    const result = await run.done;
    if (result.stopReason === "interrupted") throw new CommandRefused("commit_draft_failed:cancelled", { code: "commit_draft_failed" });
    if (result.error) throw new CommandRefused(`commit_draft_failed:${firstLineOf(result.error)}`, { code: "commit_draft_failed" });
    const message = cleanCommitDraft(result.text);
    if (!message) throw new CommandRefused("commit_draft_failed:empty answer", { code: "commit_draft_failed" });
    return { type: "commit_draft", message };
  }

  /**
   * §53 `commit_split_draft`: a read-only fork of the main session (no thread) proposes the smallest meaningful commits of
   * the accepted `paths` (default every accepted file) from their hunks of `git diff HEAD`, the whole-only files' review
   * diff, the last 20 subjects, the branch and the rendered `settings.commitTemplate`. Only valid parts are kept; what no
   * commit took is `unassigned`. Nothing is committed.
   */
  private async commitSplitDraft(requested: unknown[] | null): Promise<CommitSplitDraftEvent> {
    const cp = this.requireProject();
    const fail = (why: string) => new CommandRefused(`commit_split_failed:${why}`, { code: "commit_split_failed" });
    const files = this.commitFiles(requested);
    const [format, head] = await Promise.all([this.teamFormat(cp), headHunks(cp, files)]);
    const listed = head.map((f) => f.file);
    const whole = files.filter((f) => !f.isBinary && listed.find((l) => l.path === f.path)!.hunks.length === 0);
    const left = COMMIT_SPLIT_LINES - hunkLines(listed);
    const start = this.gate.turnStartTree;
    const end = this.gate.reviewEndTree;
    const wholePatch = left > 0 && whole.length > 0 && start !== null && end !== null ? await roundPatch(cp, start, end, whole, left).catch(() => null) : null;
    const run = await this.side.startDetached({
      key: `commit_split_draft:${randomUUID()}`,
      prompt: commitSplitPrompt({
        branch: format.branch, template: format.effective, subjects: format.subjects.slice(0, COMMIT_DRAFT_SUBJECTS), files: listed, wholePatch,
        ...(format.source ? { templateSource: format.source } : {}), examples: format.learned?.examples ?? [],
      }),
      options: { persistSession: false, allowWeb: false, system: COMMIT_SPLIT_SYSTEM },
    });
    const result = await run.done;
    if (result.stopReason === "interrupted") throw fail("cancelled");
    if (result.error) throw fail(firstLineOf(result.error));
    if (!result.text.trim()) throw fail("empty answer");
    const raw = parseCommitSplit(result.text);
    if (raw === null) throw fail("no JSON plan in the answer");
    const plan = validateSplit(raw, listed);
    if (plan.commits.length === 0) throw fail("no valid commit in the answer");
    return { type: "commit_split_draft", ...plan };
  }

  /**
   * §51 `pr_ai_draft`: a read-only fork of the main session (no thread) writes the PR sheet's title and description from
   * the branch's commits and diff since `base`, the repository's PR template and what the sheet holds. Nothing is pushed.
   */
  private async prAiDraft(base: string, title: string, body: string): Promise<PRAiDraftEvent> {
    const cp = this.requireProject();
    const name = base.trim();
    if (!name) throw new CommandRefused("empty base", { code: "empty_base" });
    const fail = (why: string) => new CommandRefused(`pr_ai_draft_failed:${why}`, { code: "pr_ai_draft_failed" });
    const { baseRef, commits } = await this.branchCommits(cp, name);
    if (baseRef === null) throw fail(`no ${name} to compare with`);
    if (commits.length === 0) throw fail(`no commits since ${baseRef}`);
    const range = `${baseRef}...HEAD`;
    const [branch, log, stat, diff, template] = await Promise.all([
      cp.branchName(),
      cp.git(["log", `-${PR_DRAFT_COMMITS}`, "--no-merges", "--reverse", "--format=%B%x1e", `${baseRef}..HEAD`, "--"], { allowFailure: true }).catch(() => null),
      cp.git(["diff", "--no-color", "--no-ext-diff", "-M", "--stat=200,150", range, "--"], { allowFailure: true }).catch(() => null),
      cp.git(["diff", "--no-color", "--no-ext-diff", "-M", range, "--"], { allowFailure: true }).catch(() => null),
      findPRTemplate(cp.root),
    ]);
    const messages = log && log.status === 0 ? log.text.split("\x1e").map((m) => m.trim()).filter((m) => m.length > 0) : commits;
    const run = await this.side.startDetached({
      key: `pr_ai_draft:${randomUUID()}`,
      prompt: prAiDraftPrompt({
        branch: branch ?? "HEAD", baseRef, commits: messages, stat: stat?.status === 0 ? stat.text : "",
        patch: cutPatch(diff?.status === 0 ? diff.text : "", PR_AI_DIFF_LINES), template, title, body,
      }),
      options: { persistSession: false, allowWeb: false, system: PR_AI_DRAFT_SYSTEM },
    });
    const result = await run.done;
    if (result.stopReason === "interrupted") throw fail("cancelled");
    if (result.error) throw fail(firstLineOf(result.error));
    const draft = parsePRAiDraft(result.text);
    if (!draft.title && !draft.body) throw fail("empty answer");
    return { type: "pr_ai_draft", ...draft };
  }

  // MARK: wave4c w4c-commit — §41.1 commits and PRs in the team's format

  /**
   * The repository's last 50 subjects (merges left out), the format most of them follow, the branch and its issue number,
   * and what a draft asks for: `settings.commitTemplate` when set, else the learned format — `{issue}` / `{branch}` filled in.
   */
  private async teamFormat(cp: GitCheckpoint): Promise<{
    branch: string | null; subjects: string[]; learned: LearnedCommitFormat | null; issue: string;
    effective: string | null; source: "settings" | "learned" | null;
  }> {
    const [branch, log] = await Promise.all([
      cp.branchName(),
      cp.git(["log", `-${COMMIT_FORMAT_SUBJECTS}`, "--no-merges", "--format=%s"], { allowFailure: true }).catch(() => null),
    ]);
    const subjects = log && log.status === 0 ? log.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0) : [];
    const learned = learnCommitFormat(subjects);
    const used = learned?.issues ?? [];
    const own = this.settings.commitTemplate?.trim() ? this.settings.commitTemplate : null;
    const raw = own ?? learned?.template ?? null;
    return {
      branch, subjects, learned, issue: branchIssue(branch, used),
      effective: raw === null ? null : renderCommitTemplate(raw, branch, used),
      source: own !== null ? "settings" : learned ? "learned" : null,
    };
  }

  /** §41.1: `/clear` or one of the aliases the session lists for it (`/reset`, `/new` in CLI 2.1.30x) as the first word. */
  private isClearCommand(text: unknown): boolean {
    const m = typeof text === "string" ? /^\/([^\s/]+)(?:\s|$)/.exec(text.trim()) : null;
    if (!m) return false;
    if (m[1] === "clear") return true;
    const caps = this.sessionState.capabilities ?? this.cachedCapabilities;
    return (caps?.commands ?? []).some((c) => c.name === "clear" && (c.aliases ?? []).includes(m[1]!));
  }

  /** `commit_format`: what the commit sheet shows as "팀 형식" and offers for the project's setting. Reads only. */
  private async commitFormat(): Promise<CommitFormatEvent> {
    const f = await this.teamFormat(this.requireProject());
    return {
      type: "commit_format", learned: f.learned?.template ?? null, kind: f.learned?.kind ?? null, examples: f.learned?.examples ?? [],
      issue: f.issue, branch: f.branch, effective: f.effective, source: f.source,
    };
  }

  /**
   * `pr_draft {base}`: the PR sheet's title / body from the branch's commits since `origin/<base>` (else `<base>`), whether
   * `pr_create` would push first, and whether `gh` can create it (installed, an account for the remote's host). Pushes nothing.
   */
  /** The ref a PR against `base` is compared with (`origin/<base>`, else `<base>`; null: neither) and the branch's commit subjects since it (oldest first, ≤ 50, merges left out). */
  private async branchCommits(cp: GitCheckpoint, base: string): Promise<{ baseRef: string | null; commits: string[] }> {
    const exists = async (ref: string) => (await cp.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true }).catch(() => null))?.status === 0;
    const baseRef = !base.startsWith("-") && (await exists(`refs/remotes/origin/${base}`)) ? `origin/${base}` : !base.startsWith("-") && (await exists(base)) ? base : null;
    const log = baseRef === null ? null : await cp.git(["log", `-${PR_DRAFT_COMMITS}`, "--no-merges", "--reverse", "--format=%s", `${baseRef}..HEAD`, "--"], { allowFailure: true }).catch(() => null);
    const commits = log && log.status === 0 ? log.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0) : [];
    return { baseRef, commits };
  }

  private async prDraft(base: string): Promise<PRDraftEvent> {
    const cp = this.requireProject();
    const name = base.trim();
    if (!name) throw new CommandRefused("empty base", { code: "empty_base" });
    const [{ baseRef, commits }, upstream, remoteURL] = await Promise.all([
      this.branchCommits(cp, name),
      cp.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFailure: true }).catch(() => null),
      cp.remoteURL(),
    ]);
    const host = remoteURL ? (parseRemoteURL(remoteURL)?.host ?? null) : null;
    let gh: GHReadiness = "ok";
    if (!(await this.locate()).gh) gh = "not_found";
    else {
      await this.pr.refreshAccounts();
      // The remote's host decides when gh knows it; a host gh does not list (an ssh alias such as `github-work`) only needs
      // some working account — `gh pr create` then says itself what is wrong.
      const own = host === null ? undefined : this.pr.accounts.find((a) => a.host.toLowerCase() === host.toLowerCase());
      gh = (own ? own.ok : this.pr.accounts.some((a) => a.ok)) ? "ok" : "not_logged_in";
    }
    return { type: "pr_draft", ...prDraftFrom(commits), commits, baseRef, hasUpstream: upstream?.status === 0, gh, host };
  }

  // MARK: wave3 engine-flow — §36.13

  /**
   * The text starts with one of the session's slash commands or skills (`/code-review low`, the client's
   * `prRespondCommand`): `send` then keeps the review-summary prefix for the next real message — a prefixed text no longer
   * starts with "/" and the CLI would never run the command. A path like `/Users/x` is no command.
   */
  private isSessionSlashCommand(text: unknown): boolean {
    const m = typeof text === "string" ? /^\/([^\s/]+)(?:\s|$)/.exec(text.trim()) : null;
    const caps = this.sessionState.capabilities ?? this.cachedCapabilities;
    return !!m && !!caps && (caps.slashCommands.includes(m[1]!) || caps.skills.includes(m[1]!));
  }

  /** A ReportFindings `file` as the review names it: repo-relative (`./x`, `x\\y` normalized), an outside path as given. */
  private findingPath(file: string): string {
    const root = this.gate.checkpoint?.root;
    if (!root) return file;
    if (isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return toRepoRelative(file, root) ?? file;
    return file.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  }

  private async sideLaunch(): Promise<Omit<SideQueryOptions, "prompt" | "emit" | "log" | "forkFrom" | "forkAt" | "resume" | "sessionId">> {
    const project = this.project;
    if (!project) throw new CommandRefused("no_project");
    const tc = await this.locate();
    if (!tc.claude) throw new CommandRefused("cli_not_found");
    if (claudeLaunchProblem(tc.claude, this.platform.isWindows)) throw new CommandRefused("cli_not_executable");
    const s = this.settings;
    const loadUser = s.loadUserSettings !== false && this.extensionsFallback === null;
    const { ids } = resolveDisabledPlugins(s.disabledPlugins ?? [], this.knownPlugins());
    const flag: Record<string, unknown> = { disableAllHooks: true };
    if (ids.length > 0) flag.enabledPlugins = Object.fromEntries(ids.map((id) => [id, false]));
    return {
      // The main session's cwd: the CLI keys its session files by it, so the fork must run there too.
      cwd: project.path,
      claudePath: tc.claude,
      env: { ...this.baseEnv, ...this.clientEnv, PATH: tc.path },
      platform: this.platform,
      ...(s.sideModel || s.model ? { model: s.sideModel || s.model } : {}),
      settingSources: loadUser ? ["user", "project"] : ["project"],
      ...(loadUser ? { skills: "all" as const } : {}),
      // User / plugin hooks off in side sessions: they may write (e.g. state dirs) and a side question changes nothing.
      flagSettings: flag,
      // MARK: wave4b w4b-side — §40.3 (audit SME-08): no web unless chosen; `rules` = what the user allows without a card.
      allowWeb: sideWebMode(s) === "on",
      ...(sideWebMode(s) === "rules" ? { webAllowed: (tool: string, input: Record<string, unknown>) => sideWebRuleAllows(tool, input, this.userRules, this.settings.bashAllowPatterns ?? []) } : {}),
    };
  }

  /** The anchor's file, diff and producing tool calls (§12 data) for the first question's prompt. */
  private async sideAnchorData(anchor: SideAnchor | null): Promise<AnchorData> {
    const data: AnchorData = { anchor, calls: [] };
    if (!anchor || anchor.pr) return data; // MARK: wave3 engine-flow — §36.14: a PR anchor carries its own hunk
    let ids: string[] = [];
    if (anchor.entryId && anchor.path) {
      const entry = this.history.find((e) => e.id === anchor.entryId);
      const file = entry?.files.find((f) => f.path === anchor.path);
      if (entry && file) {
        data.historyPrompt = entry.prompt;
        ids = [...file.toolUseIds];
        try {
          data.diff = (await this.historyDiff(entry.id, file.path)).diff;
        } catch (e) {
          this.log("debug", `side anchor: history diff: ${errorMessage(e)}`);
        }
      }
    } else if (anchor.path) {
      const file = this.gate.changedFiles.find((f) => f.path === anchor.path);
      if (file) {
        data.file = { ...file, tools: [...file.tools], toolUseIds: [...file.toolUseIds] };
        ids = [...file.toolUseIds];
        try {
          data.diff = (await this.gate.diffFor(file.path)).diff;
        } catch (e) {
          this.log("debug", `side anchor: diff: ${errorMessage(e)}`);
        }
      }
    }
    if (anchor.toolUseId) ids = [anchor.toolUseId];
    let rows: TranscriptItem[] | null = null;
    for (const id of ids) {
      const known = this.toolCalls.get(id);
      if (known) {
        data.calls.push({ ...known, id });
        continue;
      }
      // Calls from before an engine restart: the transcript keeps the tool_use row.
      rows ??= this.transcript?.tail(5000) ?? [];
      const row = rows.find((r): r is Extract<TranscriptItem, { kind: "tool_use" }> => r.kind === "tool_use" && r.id === id);
      if (row) {
        data.calls.push({
          id,
          name: row.name,
          ...optional("rationale", row.rationale),
          ...(row.name === "Bash" ? { command: typeof row.input.command === "string" ? row.input.command : "" } : optional("inputPreview", summarizeInput(row.input))),
        });
      }
    }
    return data;
  }

  /**
   * `side_promote {as, text}`: `message` sends the text to the main session through the normal `send` (same gate
   * rules: a question while files await review, refused `gate_closed:<reason>` while a turn runs); `note` adds a
   * review note on the thread's anchor (path + line) for the request-changes flow. Both carry `(곁질문에서 정리됨)`.
   */
  private async sidePromote(threadId: string, as: "message" | "note", rawText: string, acceptPending: boolean): Promise<void> {
    const thread = this.side.get(threadId);
    const text = rawText.trim();
    if (as === "message") {
      const sent = await this.send(`${text}\n\n${PROMOTE_PROVENANCE}`, acceptPending);
      if (!sent) throw new CommandRefused("send_failed");
      this.side.notePromotion(threadId, "message");
      return;
    }
    if (as !== "note") throw new CommandRefused("invalid_promote");
    const a = thread.anchor;
    if (!a?.path) throw new CommandRefused("side_no_anchor");
    this.guardNoteMutation();
    if (!this.gate.changedFiles.some((f) => f.path === a.path)) throw new CommandRefused(`not_a_changed_file:${a.path}`);
    let excerpt = "";
    try {
      excerpt = anchorLineText((await this.gate.diffFor(a.path)).diff, a);
    } catch {
      // the note still goes on without an excerpt
    }
    const note = this.gate.addNote({ path: a.path, line: typeof a.line === "number" ? a.line : null, side: a.side === "old" ? "old" : "new", excerpt, body: `${text}\n${PROMOTE_PROVENANCE}` });
    if (!note) throw new CommandRefused("empty note", { code: "empty_note" });
    this.side.notePromotion(threadId, "note");
    this.touch();
  }

  // ------------------------------------------------------------------ MCP servers (docs/PROTOCOL.md §22)

  private startMcpPolling(session: ClaudeSessionLike): void {
    this.stopMcpPolling();
    if (typeof session.mcpServerStatus !== "function") return;
    const tick = () => {
      if (this.session !== session || this.closed) return;
      void this.pollMcp().then((ev) => {
        if (ev) this.emit(ev);
      });
    };
    // On init (the first call answers once the CLI initialized), then every mcpPollMs.
    tick();
    if (this.mcpPollMs > 0) {
      this.mcpTimer = setInterval(tick, this.mcpPollMs);
      this.mcpTimer.unref?.();
    }
  }

  private stopMcpPolling(): void {
    if (this.mcpTimer) clearInterval(this.mcpTimer);
    this.mcpTimer = null;
  }

  /**
   * One `mcpServerStatus()` round: the redacted list, `ext.mcpServers` updated, `mcp_auth_required` raised once per
   * server and session, the persisted toggles applied on the first answer. Resolves the `mcp_status` event when the
   * list changed (or `always`), else null. Concurrent callers share one round.
   */
  private pollMcp(always = false): Promise<McpStatusEvent | null> {
    const session = this.session;
    if (!session || typeof session.mcpServerStatus !== "function") return Promise.resolve(null);
    if (this.mcpPolling) return this.mcpPolling.then((ev) => (ev ?? (always ? this.mcpEvent() : null)));
    const run = (async (): Promise<McpStatusEvent | null> => {
      let raw: RawMcpStatus[];
      try {
        raw = (await withTimeout(session.mcpServerStatus!(), MCP_CALL_TIMEOUT_MS, "mcpServerStatus")) as RawMcpStatus[];
      } catch (e) {
        this.log("debug", `mcp status: ${errorMessage(e)}`);
        return always ? this.mcpEvent() : null;
      }
      if (this.session !== session) return null;
      if (!this.mcpApplied) {
        this.mcpApplied = true;
        if (await this.applyMcpPrefs(session, raw)) {
          try {
            raw = (await withTimeout(session.mcpServerStatus!(), MCP_CALL_TIMEOUT_MS, "mcpServerStatus")) as RawMcpStatus[];
          } catch {
            // keep the first answer
          }
        }
      }
      // MARK: wave4d w4d-config — §42.3: another worktree's repository choice; a login finished in the terminal.
      const synced = await this.syncRepoMcpChoices(session, raw);
      const relogged = await this.reconnectAfterLogin(session, raw);
      if ((synced || relogged) && this.session === session) {
        try {
          raw = (await withTimeout(session.mcpServerStatus!(), MCP_CALL_TIMEOUT_MS, "mcpServerStatus")) as RawMcpStatus[];
        } catch {
          // keep the answer before
        }
      }
      if (this.session !== session) return null;
      const off = mcpOffNames(this.mcpToggles);
      const servers = await this.describeMcpServers((Array.isArray(raw) ? raw : []).map((r) => toServerInfo(r, { disabled: off, sessionAdded: new Set(this.mcpSessionServers.keys()) })));
      for (const sv of servers) {
        if (sv.status === "needs-auth" && !this.mcpAuthNotified.has(sv.name)) {
          this.mcpAuthNotified.add(sv.name);
          this.emit({ type: "error", message: `MCP server "${sv.name}" needs authentication (mcp_auth opens a terminal with claude /mcp).`, fatal: false, scope: "session", code: "mcp_auth_required", server: sv.name });
        }
      }
      const json = JSON.stringify(servers);
      const changed = json !== this.mcpLastJson;
      this.mcpLast = servers;
      this.mcpLastJson = json;
      if (changed && this.ext) {
        this.ext.mcpServers = servers.map((sv) => ({ name: sv.name, status: sv.status }));
        this.refreshExtensions();
        this.touch();
      }
      return changed || always ? this.mcpEvent() : null;
    })();
    this.mcpPolling = run;
    void run.finally(() => {
      if (this.mcpPolling === run) this.mcpPolling = null;
    });
    return run;
  }

  /** Re-applies the project's disabled servers and the session-scope servers to a new session; true when anything changed. */
  private async applyMcpPrefs(session: ClaudeSessionLike, raw: RawMcpStatus[]): Promise<boolean> {
    let changed = false;
    if (this.mcpSessionServers.size > 0 && typeof session.setMcpServers === "function") {
      try {
        await withTimeout(session.setMcpServers(this.sdkSessionServers()), MCP_CALL_TIMEOUT_MS, "setMcpServers");
        changed = true;
      } catch (e) {
        this.log("warn", `mcp: re-adding session servers failed: ${errorMessage(e)}`);
      }
    }
    if (typeof session.toggleMcpServer === "function") {
      for (const r of raw) {
        if (!mcpOffNames(this.mcpToggles).has(r.name) || r.status === "disabled") continue; // MARK: wave4d w4d-config (§42.3: either choice)
        try {
          await withTimeout(session.toggleMcpServer(r.name, false), MCP_CALL_TIMEOUT_MS, "toggleMcpServer");
          changed = true;
        } catch (e) {
          this.log("warn", `mcp: disabling ${r.name} failed: ${errorMessage(e)}`);
        }
      }
    }
    return changed;
  }

  private sdkSessionServers(): Record<string, never> {
    return Object.fromEntries([...this.mcpSessionServers].map(([n, c]) => [n, sdkMcpConfig(c)])) as Record<string, never>;
  }

  private mcpEvent(): McpStatusEvent {
    return { type: "mcp_status", servers: this.mcpLast.map((sv) => ({ ...sv })), restartRequired: this.mcpRestartRequired, ...(this.projectCommonDir ? { repositoryToggle: true as const } : {}) }; // MARK: wave4d w4d-config (§42.3)
  }

  private async mcpStatusReply(): Promise<McpStatusEvent> {
    const session = this.session;
    if (!session) {
      if (this.mcpLast.length > 0 || this.mcpRestartRequired) return this.mcpEvent();
      throw new CommandRefused("no_session");
    }
    if (typeof session.mcpServerStatus !== "function") throw new CommandRefused("mcp_unsupported");
    // MARK: wave4d w4d-config — §42.3: a poll already under way may predate the change just made: answer from a new one.
    if (this.mcpPolling) await this.mcpPolling.catch(() => null);
    return (await this.pollMcp(true)) ?? this.mcpEvent();
  }

  /** Runs one MCP control call on the live session; a failure is `mcp_failed:<message>` (+ `server`). */
  private async mcpCall(method: "reconnectMcpServer" | "toggleMcpServer" | "setMcpServers", call: (s: ClaudeSessionLike) => Promise<unknown>, name: string): Promise<void> {
    const session = this.session;
    if (!session) throw new CommandRefused("no_session");
    if (typeof session[method] !== "function") throw new CommandRefused("mcp_unsupported");
    try {
      await withTimeout(call(session), 30_000, method);
    } catch (e) {
      throw new CommandRefused(`mcp_failed:${firstLineOf(errorMessage(e))}`, { code: "mcp_failed" });
    } finally {
      this.log("info", `mcp ${method} ${name}`);
    }
  }

  /** MARK: wave4d w4d-config — §42.3: `scope` keeps the choice for this worktree (§22) or for every worktree of the repository. */
  private async mcpToggle(name: string, enabled: boolean, scope: McpToggleScope = "worktree"): Promise<McpStatusEvent> {
    const common = this.projectCommonDir;
    if (scope === "repository" && !common) throw new CommandRefused("no_project");
    await this.mcpCall("toggleMcpServer", (s) => s.toggleMcpServer!(name, enabled), name);
    applyMcpToggle(this.mcpToggles, name, enabled, scope);
    const dir = this.projectGitDir;
    if (dir) {
      const toggles = { worktreeOff: new Set(this.mcpToggles.worktreeOff), worktreeOn: new Set(this.mcpToggles.worktreeOn), repoOff: new Set<string>() };
      this.persistChain = this.persistChain.then(() => saveWorktreeToggles(dir, toggles)).catch((e) => this.log("warn", `persist mcp: ${errorMessage(e)}`));
    }
    if (scope === "repository" && common) {
      // The file is read again just before writing: another worktree's window may have changed another name meanwhile.
      this.persistChain = this.persistChain
        .then(async () => {
          const list = await saveRepoToggle(common, name, !enabled);
          this.mcpToggles.repoOff = new Set(list);
          this.mcpRepoStamp = await repoTogglesStamp(common);
        })
        .catch((e) => this.log("warn", `persist mcp (repository): ${errorMessage(e)}`));
      await this.persistChain;
    }
    return this.mcpStatusReply();
  }

  private async mcpAdd(name: string, scope: McpScope, config: McpAddConfig): Promise<McpStatusEvent> {
    if (scope === "session") {
      const next = new Map(this.mcpSessionServers).set(name, config);
      const servers = Object.fromEntries([...next].map(([n, c]) => [n, sdkMcpConfig(c)])) as Record<string, never>;
      let errors: Record<string, string> = {};
      await this.mcpCall("setMcpServers", async (s) => {
        errors = (await s.setMcpServers!(servers)).errors ?? {};
      }, name);
      this.mcpSessionServers.set(name, config);
      if (errors[name]) this.emit({ type: "error", message: `MCP server "${name}" failed to connect: ${firstLineOf(errors[name]!)}`, fatal: false, scope: "session", code: "mcp_failed", server: name });
      return this.mcpStatusReply();
    }
    if (scope === "project" || scope === "local") this.requireProject(); // MARK: wave3 engine-session (§36.6: local is this project's)
    await this.runClaudeMcp(mcpAddArgs(name, scope, config), name);
    return this.afterPersistentMcpChange(scope);
  }

  private async mcpRemove(name: string, scope: McpScope, file?: string): Promise<McpStatusEvent> {
    if (scope === "session") {
      if (!this.mcpSessionServers.has(name)) throw new CommandRefused(`unknown_mcp_server:${name}`);
      const next = new Map(this.mcpSessionServers);
      next.delete(name);
      const servers = Object.fromEntries([...next].map(([n, c]) => [n, sdkMcpConfig(c)])) as Record<string, never>;
      await this.mcpCall("setMcpServers", (s) => s.setMcpServers!(servers), name);
      this.mcpSessionServers.delete(name);
      return this.mcpStatusReply();
    }
    if (scope === "project" || scope === "local") this.requireProject(); // MARK: wave3 engine-session (§36.6: local is this project's)
    // MARK: wave4d w4d-config — §42.3: a parent folder's .mcp.json, by the CLI run in that folder (only the file the user confirmed).
    const cwd = scope === "project" && file !== undefined ? await this.mcpRemoveFolder(name, file) : undefined;
    await this.runClaudeMcp(mcpRemoveArgs(name, scope), name, cwd);
    return this.afterPersistentMcpChange(scope);
  }

  /** A project / user server takes effect at the next session start (`restartRequired`); `.mcp.json` shows as a worktree change. */
  private async afterPersistentMcpChange(scope: McpScope): Promise<McpStatusEvent> {
    this.mcpRestartRequired = true;
    if (scope === "project" && this.gate.checkpoint) await this.refreshBranches();
    this.touch();
    return this.session && typeof this.session.mcpServerStatus === "function" ? this.mcpStatusReply() : this.mcpEvent();
  }

  /** `claude <args>` without a shell, in the project (project scope writes its `.mcp.json`); argv is never logged (env / header values). */
  private async runClaudeMcp(args: string[], name: string, cwdOverride?: string): Promise<void> {
    const cwd = cwdOverride ?? this.project?.path ?? homedir(); // MARK: wave4d w4d-config (§42.3: the folder of the server's .mcp.json)
    let out: { status: number | null; stdout: string; stderr: string };
    if (this.runClaudeFn) out = await this.runClaudeFn(args, cwd);
    else {
      const tc = await this.locate();
      if (!tc.claude) throw new CommandRefused("cli_not_found");
      const exe = resolveClaudeExecutable(tc.claude, this.platform.isWindows);
      const file = exe.executable ?? exe.path;
      const argv = exe.executable ? [exe.path, ...args] : args;
      const r = await exec(file, argv, { cwd, env: { ...this.childEnv(), PATH: tc.path, ...(exe.env ?? {}) }, timeoutMs: 30_000 });
      out = { status: r.status, stdout: r.stdout.toString("utf8"), stderr: r.stderr };
    }
    this.log("info", `claude mcp ${args[1]} ${name}: exit ${out.status}`);
    if (out.status !== 0) {
      const why = firstLineOf(out.stderr) || firstLineOf(out.stdout) || `exit ${out.status}`;
      throw new CommandRefused(`mcp_cli_failed:${why}`, { code: "mcp_cli_failed" });
    }
  }

  /**
   * `mcp_auth`: the SDK has no OAuth flow for MCP servers, so a terminal runs `claude /mcp` (the CLI's own server
   * dialog, where "Authenticate" signs in) — in the project directory on macOS / Linux.
   */
  private async mcpAuth(name: string): Promise<void> {
    const root = this.project?.path;
    const command = root && !this.platform.isWindows ? `cd '${root.replace(/'/g, `'\\''`)}' && claude /mcp` : "claude /mcp";
    try {
      // MARK: wave4d w4d-config — §42.3: on Windows the console starts in the project (its project / local servers).
      await this.platform.openTerminal(command, root ?? undefined);
    } catch (e) {
      throw new CommandRefused(`terminal_failed:${firstLineOf(errorMessage(e))}`, { code: "terminal_failed" });
    }
    this.log("info", `mcp_auth ${name}: opened a terminal with claude /mcp`);
    // MARK: wave4d w4d-config — §42.3: the polls reconnect it until the login in the terminal took (at most 10 minutes).
    this.mcpAuthWaiting.set(name, { until: Date.now() + MCP_AUTH_WAIT_MS, lastTry: Date.now() });
    if (this.mcpLast.some((sv) => sv.name === name)) {
      this.mcpLast = this.mcpLast.map((sv) => (sv.name === name ? { ...sv, authWaiting: true as const } : sv));
      this.mcpLastJson = JSON.stringify(this.mcpLast);
      this.emit(this.mcpEvent());
    }
  }

  // ------------------------------------------------------------------ MARK: wave4d w4d-config — §42.3 MCP choices, origins, logins; instructions

  /** At open: this worktree's `enabled` exceptions and the repository's choices. */
  private async loadMcpScopes(gitDir: string): Promise<void> {
    const own = await loadWorktreeToggles(gitDir);
    for (const n of own.enabled) this.mcpToggles.worktreeOn.add(n);
    const common = this.projectCommonDir;
    if (!common) return;
    this.mcpRepoStamp = await repoTogglesStamp(common);
    this.mcpToggles.repoOff = new Set(await loadRepoToggles(common));
  }

  /**
   * The repository's file changed (another worktree's window chose): the servers it newly turns off are turned off in this
   * session, the ones it no longer turns off are turned on again (only those it had turned off). True when anything changed.
   */
  private async syncRepoMcpChoices(session: ClaudeSessionLike, raw: RawMcpStatus[]): Promise<boolean> {
    const common = this.projectCommonDir;
    if (!common || typeof session.toggleMcpServer !== "function") return false;
    const stamp = await repoTogglesStamp(common);
    if (stamp === this.mcpRepoStamp) return false;
    const before = mcpOffNames(this.mcpToggles);
    this.mcpRepoStamp = stamp;
    this.mcpToggles.repoOff = new Set(await loadRepoToggles(common));
    const after = mcpOffNames(this.mcpToggles);
    let changed = false;
    for (const r of Array.isArray(raw) ? raw : []) {
      const want = after.has(r.name) && !before.has(r.name) ? false : before.has(r.name) && !after.has(r.name) ? true : null;
      if (want === null || (want === false && r.status === "disabled") || (want === true && r.status !== "disabled")) continue;
      try {
        await withTimeout(session.toggleMcpServer(r.name, want), MCP_CALL_TIMEOUT_MS, "toggleMcpServer");
        changed = true;
      } catch (e) {
        this.log("warn", `mcp: repository choice for ${r.name} failed: ${errorMessage(e)}`);
      }
    }
    return changed;
  }

  /** After `mcp_auth`: a server that still needs a login is reconnected every other poll (≥ 20 s apart) until it connects. */
  private async reconnectAfterLogin(session: ClaudeSessionLike, raw: RawMcpStatus[]): Promise<boolean> {
    if (this.mcpAuthWaiting.size === 0 || typeof session.reconnectMcpServer !== "function") return false;
    const now = Date.now();
    // Every other poll: 20 s with the default 10 s poll (a test's fast poll keeps the same rhythm).
    const retryMs = this.mcpPollMs > 0 ? Math.min(MCP_AUTH_RETRY_MS, 2 * this.mcpPollMs) : MCP_AUTH_RETRY_MS;
    let tried = false;
    for (const [name, wait] of [...this.mcpAuthWaiting]) {
      const r = (Array.isArray(raw) ? raw : []).find((x) => x.name === name);
      if (!r || now > wait.until || (r.status !== "needs-auth" && r.status !== "pending")) {
        this.mcpAuthWaiting.delete(name);
        continue;
      }
      if (r.status !== "needs-auth" || now - wait.lastTry < retryMs) continue;
      wait.lastTry = now;
      tried = true;
      try {
        await withTimeout(session.reconnectMcpServer(name), MCP_CALL_TIMEOUT_MS, "reconnectMcpServer");
        this.log("info", `mcp: reconnected ${name} after a login`);
      } catch (e) {
        this.log("debug", `mcp: reconnect ${name} after a login: ${errorMessage(e)}`);
      }
    }
    return tried;
  }

  /** `origin`, `disabledIn` and `authWaiting` of the wire list (§42.3). */
  private async describeMcpServers(servers: McpServerInfo[]): Promise<McpServerInfo[]> {
    const root = this.project?.path;
    const claudeJson = claudeJsonPath(this.childEnv());
    const out: McpServerInfo[] = [];
    for (const sv of servers) {
      const offBy = sv.disabledByUser ? mcpOffBy(this.mcpToggles, sv.name) : null;
      const origin = root ? await mcpOriginOf(sv, { root, claudeJson, index: this.mcpFiles, windows: this.platform.isWindows }).catch(() => undefined) : undefined;
      out.push({ ...sv, ...(origin ? { origin } : {}), ...(offBy ? { disabledIn: offBy } : {}), ...(this.mcpAuthWaiting.has(sv.name) && sv.status === "needs-auth" ? { authWaiting: true as const } : {}) });
    }
    return out;
  }

  /** The folder `claude mcp remove --scope project` runs in for `file` — the server's own `.mcp.json`, as found now. */
  private async mcpRemoveFolder(name: string, file: string): Promise<string> {
    const root = this.project?.path;
    const found = root ? await this.mcpFiles.projectFileOf(name, root) : null;
    if (!found || !samePath(found, file)) throw new CommandRefused(`mcp_origin_changed:${name}`, { code: "mcp_origin_changed" });
    return dirname(found);
  }

  private applyInstructionExtensions(root: string, configDir: string): void {
    const ext = this.sessionState.extensions;
    if (!ext) return;
    if (ext.memoryFiles) ext.memoryFiles = ext.memoryFiles.map((m) => describeMemoryFile(m, { root, configDir }));
    ext.projectInstructions = projectInstructionFiles(root);
    if (this.cliAgents) ext.agents = this.cliAgents.map((a) => ({ ...a }));
  }

  private instructionFile(raw: unknown) {
    this.requireProject();
    const root = this.project?.path;
    const target = root ? instructionTarget(root, raw) : null;
    if (!target) throw new CommandRefused("invalid_path", { code: "invalid_path" });
    return target;
  }

  private async claudeMdRead(raw: unknown): Promise<ClaudeMdEvent> {
    const t = this.instructionFile(raw);
    const c = await readInstruction(t.abs);
    return { type: "claude_md", path: t.abs, relPath: t.relPath, kind: t.kind, text: c.text, sha: c.sha, exists: c.exists };
  }

  /**
   * The user's own edit of an instruction file: never while Claude works (it would land in the turn) nor over a file in the
   * open review (its verdict must stay about Claude's change); only over the content the user started from.
   */
  private async claudeMdWrite(raw: unknown, text: unknown, baseSha: unknown): Promise<ClaudeMdEvent> {
    const t = this.instructionFile(raw);
    if (this.sessionState.starting || this.gate.running || this.gate.collecting || this.gate.reverting) throw new CommandRefused("session_busy", { code: "session_busy" });
    // A failed collection is retried over the working tree as it is: the user's save would land in that turn.
    if (this.gate.collectError !== null) throw new CommandRefused("collect_failed", { code: "collect_failed" });
    const cp = this.requireProject();
    const repoRel = toRepoRelative(t.abs, cp.root);
    if (repoRel !== null && this.gate.pendingFiles.some((f) => f.path === repoRel)) throw new CommandRefused("in_review", { code: "in_review" });
    const c = await writeInstruction(t.abs, text, baseSha);
    this.log("info", `claude_md_write ${t.relPath}`);
    this.refreshExtensions();
    if (this.gate.checkpoint) await this.refreshBranches();
    this.touch();
    return { type: "claude_md", path: t.abs, relPath: t.relPath, kind: t.kind, text: c.text, sha: c.sha, exists: true, saved: true };
  }

  // ------------------------------------------------------------------ peer messages (docs/PROTOCOL.md §29)

  /** The project's peer mode: its `peer_set`, else `settings.peerInbound`, else `ask`. */
  private peerMode(): PeerInboundMode {
    return this.peerChoice ?? this.settings.peerInbound ?? "ask";
  }

  /** `--name` of the session, so the user's other sessions see it is ReviewGate's (audit peer-05): `ReviewGate · <project>[/<branch>]`. */
  private peerSessionName(): string {
    const p = this.project;
    const name = p?.name ?? "project";
    const branch = this.gate.refNs !== "main" && p?.branch && p.branch !== name ? `/${p.branch}` : "";
    // MARK: wave4d w4d-peers — §42.2: `· <chat title>` once the chat has one (the CLI takes the name at start only), so
    // the other sessions — and the terminal's /resume — can tell which chat it is; ≤ 64 characters, none split.
    const base = [...`ReviewGate · ${name}${branch}`];
    const title = this.currentSessionId ? this.sessions?.get(this.currentSessionId)?.title : undefined;
    const room = PEER_NAME_MAX - base.length - 3;
    if (!title || title === NEW_CHAT_TITLE || room < PEER_NAME_TOPIC_MIN) return base.slice(0, PEER_NAME_MAX).join("");
    const topic = [...title];
    const cut = topic.length > room ? `${topic.slice(0, room - 1).join("").trimEnd()}…` : title;
    return `${base.join("")} · ${cut}`;
  }

  /** The live session follows the mode (hold / refuse); best effort — the next start applies it anyway. */
  private async applyPeerFlag(): Promise<void> {
    const session = this.session;
    if (!session || typeof session.setPeerInbound !== "function") return;
    try {
      await session.setPeerInbound(peerFlag(this.peerMode()));
    } catch (e) {
      this.log("warn", `crossSessionInbound: ${errorMessage(e)}`);
    }
  }

  private heldPeers(): PeerMessage[] {
    return [...this.peerInbox.values()].filter((m) => m.state === "held");
  }

  /** `ids` (optional) must name exactly the held messages: the user decides on what the card showed. */
  private checkPeerIds(ids: unknown, held: PeerMessage[]): void {
    if (ids === undefined || ids === null) return;
    const want = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
    const have = held.map((m) => m.id);
    if (want.length !== have.length || have.some((id) => !want.includes(id))) {
      throw new CommandRefused(`peer_inbox_changed:${have.join(", ")}`, { code: "peer_inbox_changed" });
    }
  }

  /** Updates (or adds) a peer message, announces it, keeps only held / delivering ones in the inbox. */
  private updatePeer(m: PeerMessage): void {
    if (m.state === "held" || m.state === "delivering") this.peerInbox.set(m.id, m);
    else this.peerInbox.delete(m.id);
    this.emit({ type: "peer_message", message: { ...m } });
    this.touch();
  }

  /** The transcript row of a delivered / dropped peer message (its turn's first row when it runs one). */
  private recordPeer(m: PeerMessage): void {
    if (m.state !== "delivered" && m.state !== "dropped") return;
    this.record({
      kind: "peer_message",
      id: m.id,
      from: m.from,
      ...(m.fromName !== null ? { fromName: m.fromName } : {}),
      ...(m.verifiedPeerPid !== null ? { verifiedPeerPid: m.verifiedPeerPid } : {}),
      state: m.state,
      ...(m.outcome !== undefined ? { outcome: m.outcome } : {}),
      ...(m.body !== undefined ? { body: m.body } : {}),
      ...(m.unprompted ? { unprompted: true as const } : {}),
    });
  }

  private onPeerHold(ev: Extract<SessionEvent, { type: "peer_hold" }>): void {
    const known = this.peerInbox.get(ev.messageUuid);
    if (ev.state === "held") {
      this.updatePeer({
        id: ev.messageUuid,
        from: ev.from,
        fromName: ev.fromName ?? null,
        verifiedPeerPid: null,
        cause: ev.cause ?? null,
        receivedAt: known?.receivedAt ?? new Date().toISOString(),
        state: "held",
      });
      this.log("info", `peer message ${ev.messageUuid} from ${ev.fromName ?? ev.from} held (${ev.cause ?? "?"})`);
      return;
    }
    if (ev.state === "released") {
      if (known && known.state === "held") this.updatePeer({ ...known, state: "delivering", ...(this.peerTurn ? { turn: this.turn } : {}) });
      return;
    }
    // dropped: refused (peer_dismiss / off), expired, …
    const m: PeerMessage = {
      ...(known ?? { id: ev.messageUuid, from: ev.from, fromName: ev.fromName ?? null, verifiedPeerPid: null, cause: null, receivedAt: new Date().toISOString() }),
      state: "dropped",
      ...(ev.outcome ? { outcome: ev.outcome } : {}),
    };
    this.recordPeer(m);
    this.updatePeer(m);
  }

  private onPeerDelivered(ev: Extract<SessionEvent, { type: "peer_delivered" }>): void {
    const o = ev.origin;
    const known = ev.messageUuid ? this.peerInbox.get(ev.messageUuid) : undefined;
    const m: PeerMessage = {
      id: ev.messageUuid ?? o.msgId ?? randomUUID(),
      from: o.from,
      fromName: o.name ?? known?.fromName ?? null,
      verifiedPeerPid: o.verifiedPeerPid ?? null,
      cause: known?.cause ?? null,
      receivedAt: known?.receivedAt ?? new Date().toISOString(),
      state: "delivered",
      ...(o.body !== undefined ? { body: o.body } : {}),
      ...(ev.owned && known?.turn !== undefined ? { turn: known.turn } : ev.owned && this.peerTurn ? { turn: this.turn } : {}),
      ...(ev.owned ? {} : { unprompted: true as const }),
    };
    if (!ev.owned) {
      // An older CLI (or a policy that accepts) ran it by itself: §18 blocks its changes; its card offers to send it.
      this.externalPeerEpisode = true;
      if (this.externalTurn) this.externalTurn = { ...this.externalTurn, peer: { from: m.from, fromName: m.fromName, verifiedPeerPid: m.verifiedPeerPid } };
      this.log("warn", `peer message from ${m.fromName ?? m.from} delivered without being held; its turn runs outside the review (changes blocked)`);
    }
    this.recordPeer(m);
    this.updatePeer(m);
  }

  /**
   * `peer_accept {ids?}`: every held message runs as one review turn — the `send` gate (`gate_closed:<reason>`), snapshot A
   * (kept for an answer to a standing review), a checkpoint, the turn's collection; the CLI lets them through
   * (`releasePeers`). Refused `peer_none`, `peer_inbox_changed` (also when a message was held while snapshot A was taken,
   * §35.8), `peer_unsupported`, `peer_release_failed` (snapshot A failed, or nothing released within 3 s: the messages are
   * held again).
   */
  private async peerAccept(ids: unknown): Promise<void> {
    const session = this.session;
    if (!session) throw new CommandRefused("no_session");
    if (typeof session.releasePeers !== "function") throw new CommandRefused("peer_unsupported");
    const held = this.heldPeers();
    if (held.length === 0) throw new CommandRefused("peer_none");
    this.checkPeerIds(ids, held);
    const slices = this.slices();
    if (!canSend(slices)) throw new CommandRefused(`gate_closed:${this.closedReason(slices)}`);
    await this.followHeadMove();
    await this.gate.prepareAnswer(this.takeBgCarry());
    // MARK: wave2 check-engine — §35.8: snapshot A first, the gate closed meanwhile (like `send`, §35.1): a failure, or a
    // message held while it was taken, leaves nothing of the turn behind (turn counter, notes, round, per-turn banners).
    const keptA = this.gate.keepsTurnStart;
    this.gate.running = true;
    let tree: string;
    try {
      tree = await this.gate.snapshotStart();
    } catch (e) {
      this.gate.abortTurn();
      for (const m of held) this.peerReleaseFailed.add(m.id);
      const why = firstLineOf(errorMessage(e));
      // §32: snapshot A failing for want of git-lfs says so (the refusal stays `peer_release_failed`: the card is held again).
      this.fail(`The held message could not be handed to Claude (${why}); it is still waiting.`, false, "session", { code: e instanceof LfsMissingError ? "lfs_missing" : "peer_release_failed" });
      throw new CommandRefused(`peer_release_failed:${why}`, { code: "peer_release_failed" });
    }
    // The CLI's release lets through every message held at that moment, so one held meanwhile would run unseen: the
    // user's ids refuse it (the card shows the inbox as it is now); without ids (auto, an older client) it comes along.
    const late = this.heldPeers().filter((m) => !held.some((x) => x.id === m.id));
    if (late.length > 0) {
      if (ids !== undefined && ids !== null) {
        this.gate.abortTurn();
        this.touch();
        throw new CommandRefused(`peer_inbox_changed:${[...held, ...late].map((m) => m.id).join(", ")}`, { code: "peer_inbox_changed" });
      }
      held.push(...late);
    }
    const skippedAtStart = this.gate.snapshotSkipped;
    const names = [...new Set(held.map((m) => m.fromName ?? m.from))];
    // The turn's prompt in the review history / rewind list (the body is only known once the CLI delivers it).
    const display = `[peer message] ${names.join(", ")}`;
    this.sessionState.pendingPlan = null;
    this.proposedPlanKeys.clear();
    // The review summary waits for the user's next real message: nothing of ours goes out with a peer turn.
    this.gate.beginSend(display, true);
    await this.adoptRecordOnly(); // MARK: wave2 check-engine (§35.4)
    const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
    if (meta) {
      meta.updatedAt = new Date().toISOString();
      this.persistSessions();
    }
    this.beginTurn(display, {}, true);
    // `beginTurn` clears the per-turn signals; what snapshot A had to leave out (§32) is this turn's.
    this.gate.snapshotSkipped = skippedAtStart;
    this.peerTurn = { messageIds: held.map((m) => m.id), fromNames: names };
    for (const m of held) this.updatePeer({ ...m, state: "delivering", turn: this.turn });
    try {
      // §31 / §32: a peer turn is a review turn — HEAD, settings.local.json and nested HEADs are compared at its end too.
      await this.noteTurnStartState();
      await this.startRecord(keptA ? null : tree);
      this.gate.noteTurnStart(this.turnRecord?.startTree ?? null); // §34.1: "this turn" starts here
      this.turnSent = null;
      const released = await session.releasePeers(held.map((m) => m.id), this.turnHookTree(tree));
      for (const m of held) {
        const cur = this.peerInbox.get(m.id);
        if (cur && cur.state === "delivering" && !released.includes(m.id)) this.updatePeer({ ...cur, state: "held" });
      }
      this.log("info", `peer message(s) ${released.join(", ")} released into turn ${this.turn}`);
    } catch (e) {
      this.gate.abortTurn();
      this.dropRecord();
      this.hud.turnStartedAt = null;
      this.peerTurn = null;
      this.setIdle();
      for (const m of held) {
        this.peerReleaseFailed.add(m.id);
        const cur = this.peerInbox.get(m.id);
        if (cur && cur.state === "delivering") this.updatePeer({ ...cur, state: "held" });
      }
      const why = firstLineOf(errorMessage(e));
      this.fail(`The held message could not be handed to Claude (${why}); it is still waiting.`, false, "session", { code: "peer_release_failed" });
      throw new CommandRefused(`peer_release_failed:${why}`, { code: "peer_release_failed" });
    }
    this.touch();
  }

  /** `peer_dismiss {ids?}`: refuses every held message (the senders get a "not delivered" receipt; dropped rows). */
  private async peerDismiss(ids: unknown): Promise<void> {
    const session = this.session;
    if (!session) throw new CommandRefused("no_session");
    if (typeof session.dismissPeers !== "function") throw new CommandRefused("peer_unsupported");
    const held = this.heldPeers();
    if (held.length === 0) throw new CommandRefused("peer_none");
    this.checkPeerIds(ids, held);
    let dropped: string[];
    try {
      dropped = await session.dismissPeers(held.map((m) => m.id));
    } catch (e) {
      throw new CommandRefused(`peer_dismiss_failed:${firstLineOf(errorMessage(e))}`, { code: "peer_dismiss_failed" });
    }
    if (dropped.length === 0) throw new CommandRefused("peer_dismiss_failed:no message was dropped", { code: "peer_dismiss_failed" });
  }

  /** `peer_set {mode}`: this project's mode, live (hold / refuse) and persisted; `off` drops what is held (refused). */
  private async peerSet(mode: unknown): Promise<void> {
    if (!isPeerInboundMode(mode)) throw new CommandRefused("invalid_peer_mode");
    if (!this.project) throw new CommandRefused("no_project");
    const before = peerFlag(this.peerMode());
    this.peerChoice = mode;
    this.persistSessions();
    if (peerFlag(mode) !== before) await this.applyPeerFlag();
    this.touch();
  }

  /** §29 `auto`: a held message runs by itself once nothing is in flight or waiting for the user (gate idle, no card). */
  private maybeAutoAcceptPeers(state: ReviewState): void {
    if (this.peerAutoQueued || this.peerMode() !== "auto" || this.peerInbox.size === 0 || !this.session) return;
    if (!state.gate.canSend || state.gate.phase !== "idle" || state.session.pendingPermission || state.session.pendingPlan) return;
    const held = this.heldPeers();
    if (held.length === 0 || held.every((m) => this.peerReleaseFailed.has(m.id))) return;
    this.peerAutoQueued = true;
    void this.handle({ type: "peer_accept" }).finally(() => {
      this.peerAutoQueued = false;
    });
  }

  /** The peer turn ended: a released message whose body never came (no echo, no `result.origin`) still was delivered. */
  private settlePeerTurn(): void {
    const t = this.peerTurn;
    this.peerTurn = null;
    if (!t) return;
    for (const id of t.messageIds) {
      const m = this.peerInbox.get(id);
      if (m?.state !== "delivering") continue;
      const done: PeerMessage = { ...m, state: "delivered" };
      this.recordPeer(done);
      this.updatePeer(done);
    }
  }

  /** The session (and what its CLI held) is gone: held / running messages are discarded (rows), the external turn ends. */
  private endPeerState(): void {
    this.endBackgroundState(); // §52: the CLI's tasks end with its process
    for (const m of [...this.peerInbox.values()]) {
      const gone: PeerMessage = { ...m, state: "dropped", outcome: "discarded" };
      this.recordPeer(gone);
      this.updatePeer(gone);
    }
    this.externalTurn = null;
    this.peerTurn = null;
    this.externalPeerEpisode = false;
  }

  /** The `gate_closed:<reason>` of a refused send: `external_turn` when only a turn of someone else's holds the input (§29). */
  private closedReason(slices: EngineSlices): string {
    const reason = blockedReason(slices);
    return reason === "running" && !this.gate.running && slices.session.externalTurn ? "external_turn" : reason ?? "unknown";
  }

  // ------------------------------------------------------------------ §33 permission requests

  /** The open requests, oldest first; `pendingPermission` (older clients) is always the first of them. */
  private setPendingPermissions(list: PermissionRequest[]): void {
    this.sessionState.pendingPermissions = list;
    this.sessionState.pendingPermission = list[0] ?? null;
  }

  private dequeuePermission(requestId: string): void {
    const rest = this.sessionState.pendingPermissions.filter((p) => p.requestId !== requestId);
    if (rest.length !== this.sessionState.pendingPermissions.length) this.setPendingPermissions(rest);
  }

  /** Fills `agent` from `state.hud.agents` (by the SDK's agent id, else the asking call's parent); main-agent requests stay as they are. */
  private attributePermission(raw: PermissionRequest): PermissionRequest {
    if (!raw.agent) return raw;
    const node = this.agents.ownerOf(raw.agent.agentId, raw.toolUseId);
    if (!node) return raw;
    return {
      ...raw,
      agent: {
        agentId: raw.agent.agentId,
        agentToolUseId: node.toolUseId,
        ...(node.type ? { subagentType: node.type } : {}),
        ...(node.description ? { description: node.description } : {}),
      },
    };
  }

  /**
   * After a remembered allow: queued requests the session would now allow without asking (the same rules as its
   * hooks: read-only Bash, allow patterns, remembered keys) are answered too. Never edit tools — those only reach a
   * card for a path outside the review — nor a request whose `reason` says it works outside the review (§33.3).
   */
  private resolveCoveredPermissions(): void {
    const session = this.session;
    if (!session) return;
    const ctx = {
      autoAllowReadOnlyBash: this.settings.autoAllowReadOnlyBash !== false,
      bashAllowPatterns: this.settings.bashAllowPatterns ?? [],
      rememberedAllows: this.rememberedAllows,
      userRules: this.userRules,
      // MARK: wave2 check-engine — §35.7: the servers' readOnly / destructive annotations, as the hooks judge them.
      ...(session.mcpToolHints ? { mcpToolHints: session.mcpToolHints } : {}),
    };
    for (const p of [...this.sessionState.pendingPermissions]) {
      if (p.reason || EDIT_TOOL_NAME_RE.test(p.toolName) || !autoAllowReason(p.toolName, p.input, ctx)) continue;
      this.dequeuePermission(p.requestId);
      this.autoAnswered.add(p.requestId);
      this.record({ kind: "permission", requestId: p.requestId, toolName: p.toolName, allow: true, ...(p.file !== undefined ? { file: p.file } : {}) });
      session.respondPermission(p.requestId, true);
    }
    this.touch();
  }

  /** §33.5: the user's Claude Code settings files (user ones only when user settings load). */
  private readUserRules(loadUser: boolean, cwd?: string): LoadedRules {
    const loadLocal = this.ext?.loadLocal ?? (this.settings.loadLocalSettings !== false && this.extensionsFallback === null); // MARK: wave3 engine-session (§36.6)
    return loadPermissionRules({ configDir: claudeConfigDir(this.childEnv()), root: this.project?.root ?? cwd ?? "", loadUser, loadLocal });
  }

  /** §33.8: `permission_rules` — every allow rule of the user's settings, what ReviewGate does with it, the terminal's default mode. */
  private permissionRules(): PermissionRulesEvent {
    if (!this.project) throw new CommandRefused("no_project");
    const loadUser = this.ext?.loadUser ?? this.settings.loadUserSettings !== false;
    const apply = this.settings.applyUserAllowRules !== false;
    const loaded = this.readUserRules(loadUser);
    return {
      type: "permission_rules",
      sources: loaded.sources.map((s) => ({ ...s })),
      rules: classifyRules(loaded, { applyUserRules: apply }),
      defaultMode: loaded.defaultMode,
      defaultModeSupported: loaded.defaultMode !== null && isPermissionMode(loaded.defaultMode),
      applyUserAllowRules: apply,
      loadUserSettings: loadUser,
    };
  }

  /** §33.7: with `persistSessionAllows`, the worktree's stored remembered allows come back on `open_project`. */
  private async restoreRememberedAllows(): Promise<void> {
    const dir = this.projectGitDir;
    if (!dir || this.settings.persistSessionAllows !== true) return;
    for (const key of await loadRememberedAllows(dir)) this.rememberedAllows.add(key);
    this.sessionState.rememberedAllows = [...this.rememberedAllows];
  }

  private saveAllows(): void {
    const dir = this.projectGitDir;
    if (!dir || this.settings.persistSessionAllows !== true) return;
    const keys = [...this.rememberedAllows];
    this.persistChain = this.persistChain.then(() => saveRememberedAllows(dir, keys)).catch((e) => this.log("warn", `persist allows: ${errorMessage(e)}`));
  }

  private clearPersistedAllows(): void {
    const dir = this.projectGitDir;
    if (!dir) return;
    this.persistChain = this.persistChain.then(() => clearRememberedAllows(dir)).catch((e) => this.log("warn", `clear allows: ${errorMessage(e)}`));
  }

  // ------------------------------------------------------------------ session events

  private onSessionEvent(source: ClaudeSessionLike, ev: SessionEvent): void {
    if (this.session !== source || this.closed) {
      if (ev.type === "error" || ev.type === "closed") this.log("debug", `stale session ${ev.type} ignored`);
      return;
    }
    // §52.1: while a turn Claude started is being taken, its events wait (in order) for the turn's start.
    if (this.adoptQueue !== null && ev.type !== "closed" && !(ev.type === "error" && ev.fatal)) {
      this.adoptQueue.push({ source, ev });
      return;
    }
    if (TURN_OUTPUT_EVENTS.has(ev.type)) {
      this.turnSawOutput = true;
      this.sessionStart.ready = true; // output means the CLI initialized
    }
    if (pokesStatusLine(ev)) this.statusLine.poke(); // MARK: wave6 w6-statusline — §44.2 (it runs 300 ms after, with this applied)
    switch (ev.type) {
      case "session_ready":
        // §30: the CLI answered initialize — a resume found its conversation; a death from now on is a crash.
        this.sessionStart.ready = true;
        this.setCapabilitiesState("ready"); // MARK: wave3 engine-session (§36.5)
        this.noteStartAnswered(); // MARK: wave3 engine-session (§36.7)
        if (this.inUseResumed !== null && this.inUseResumed === this.currentSessionId) this.log("info", `resumed session ${this.inUseResumed}`);
        this.touch();
        return;
      case "session_info":
        this.sessionStart.gotInfo = true;
        this.sessionState.sessionId = ev.sessionId;
        this.rememberSession(ev.sessionId);
        if (this.checkpoints.pendingFork) {
          // §26: the CLI materialized the rewind fork; from now on the chat resumes like any other.
          this.checkpoints.pendingFork = null;
          this.saveCheckpointFile();
        }
        this.sessionState.model = ev.model;
        const prevCommands = this.sessionState.capabilities?.commands; // MARK: wave3 engine-session (§36.5)
        this.sessionState.capabilities = {
          slashCommands: ev.slashCommands,
          skills: ev.skills,
          plugins: ev.plugins.map((p) => p.name),
          mcpServers: ev.mcpServers,
          pluginDetails: ev.plugins.map((p) => ({ name: p.name, path: p.path, id: pluginIdFromPath(p.name, p.path), ...(p.version ? { version: p.version } : {}) })),
        };
        // MARK: wave3 engine-session — §36.5: session_info has no commands: the ones initialize gave stay; it came after initialize.
        this.sessionState.capabilities = { ...this.sessionState.capabilities, ...(prevCommands ? { commands: prevCommands } : {}), state: "ready" };
        if (this.ext) {
          this.ext.plugins = ev.plugins.map((p) => ({ ...p }));
          this.ext.mcpServers = ev.mcpServers.map((m) => ({ ...m }));
        }
        this.refreshExtensions();
        this.sessionState.capabilitiesCached = false;
        this.cachedCapabilities = this.sessionState.capabilities;
        this.persistCapabilities(this.sessionState.capabilities);
        if (ev.contextWindow !== undefined) this.hud.contextWindow = ev.contextWindow;
        if (ev.cliVersion) this.noteCliVersionOf(parseCliVersion(ev.cliVersion, { plain: true })); // MARK: wave3 engine-session (§36.8)
        this.touch();
        return;
      case "init_timeout":
        this.onInitTimeout(ev.afterMs);
        return;
      case "models_info":
        this.models = toModelOptions(ev.models) ?? this.models;
        this.touch();
        return;
      case "extensions_info":
        if (this.ext) {
          if (ev.memoryFiles) this.ext.memoryFiles = ev.memoryFiles.map((m) => ({ ...m }));
          if (ev.mcpServers) this.ext.mcpServers = ev.mcpServers.map((m) => ({ ...m }));
        }
        this.refreshExtensions();
        // MARK: wave5 w5-brain — §43.2: the MEMORY.md the CLI loaded says where its memory is.
        if (ev.memoryFiles) {
          const before = this.subBrain.dir;
          this.refreshBrainDir();
          if (this.subBrain.dir !== before) void this.subBrain.scan().catch(() => undefined);
        }
        this.touch();
        return;
      // MARK: wave4d w4d-config — §42.3
      case "agents_info": {
        const root = this.project?.path ?? this.project?.root;
        if (!root) return;
        const plugins = this.knownPlugins().map((p) => ({ name: p.name, path: p.path }));
        const agents = subagentList(ev.agents, { root, configDir: claudeConfigDir(this.childEnv()), plugins });
        if (!agents) return;
        this.cliAgents = agents;
        this.refreshExtensions();
        this.touch();
        return;
      }
      // MARK: wave3 engine-session
      case "commands_info": {
        // §36.5: initialize's commands (no message needed), then each commands_changed; cached with the lists.
        const commands = toCommandInfos(ev.commands);
        if (!commands) return;
        this.sessionState.capabilities = { ...(this.sessionState.capabilities ?? emptyCapabilities()), commands, state: "ready" };
        this.cachedCapabilities = this.sessionState.capabilities;
        this.persistCapabilities(this.sessionState.capabilities);
        this.touch();
        return;
      }
      case "start_progress": {
        // §36.7: the session restarted its stall watchdog; the client shows what the start waits on.
        const { type: _type, ...progress } = ev;
        this.waitingOn.note(progress);
        if (this.sessionStart.ready) return;
        this.sessionState.extensionsWaitingOn = this.waitingOn.current;
        this.touch();
        return;
      }
      case "text_delta":
        if (!this.gate.running) {
          // No request of ours is running: the CLI continued on its own (§18). Its text is its own row.
          if (!this.turnTextUnprompted) this.flushTurnText();
          this.turnTextUnprompted = true;
          this.turnText += ev.text;
          this.emit({ type: "text_delta", text: ev.text, unprompted: true });
          return;
        }
        if (this.turnTextUnprompted) this.flushTurnText();
        this.turnText += ev.text;
        this.turnReport += ev.text;
        this.emit(ev);
        return;
      case "tool_use": {
        // MARK: wave3 engine-agents — §36.3: a SendMessage that continues a known subagent names it (event and row).
        const continues = this.agents.continuationOf(ev.name, ev.input);
        if (continues) ev.continues = continues;
        if (isExploreCall(ev.name, ev.input)) ev.explore = true; // MARK: wave4b w4b-tabs — §39.2 an exploration call (event and row)
        // MARK: wave4d w4d-plan — §42.1: Claude's own to-do list (read before this row is written, so it is not counted twice)
        if (ev.parentToolUseId === undefined && PLAN_TOOLS.has(ev.name)) notePlanTool(this.chatPlanMemory(), ev.name, ev.input);
        const { type: _type, ...row } = ev;
        this.record({ kind: "tool_use", ...row });
        this.emit(ev);
        if (ev.name === "ReportFindings") this.prereviews.onMainReport(ev.id, ev.input); // MARK: wave3 engine-flow (§36.13)
        this.rememberCall(ev.id, {
          name: ev.name,
          ...(ev.rationale !== undefined ? { rationale: ev.rationale } : {}),
          ...(ev.parentToolUseId !== undefined ? { parentToolUseId: ev.parentToolUseId } : {}),
          ...(ev.name === "Bash" ? { command: typeof ev.input.command === "string" ? ev.input.command : "" } : {}),
          ...(ev.name !== "Bash" ? optional("inputPreview", summarizeInput(ev.input)) : {}),
        });
        if (ev.name === "Bash") this.turnCommandIds.push(ev.id);
        if (ev.file !== undefined && EDIT_TOOL_RE.test(ev.name) && this.gate.running) {
          this.noteTurnFile(ev.file, ev.name, ev.id);
          this.turnEditCalls.set(ev.id, ev.file);
        }
        this.noteCallWhy(ev);
        if (this.agents.onToolUse(ev)) this.agentsChanged();
        this.subBrain.onToolUse(ev.id, ev.name, ev.input, this.brainCaller(ev.parentToolUseId)); // MARK: wave5 w5-brain (§43.2)
        return;
      }
      case "tool_result": {
        // `output` stays in the engine (`tool_output`); the wire event and the transcript carry the preview. So does an
        // Agent call's `agentReport` (§34.8: the subagent's report, for `why`).
        const { type: _type, output, agentReport, keptReport, ...row } = ev;
        // MARK: wave3 engine-agents — §36.2: the result of an agent the user stopped says so (event and row).
        if (this.agents.stoppedByUser(ev.toolUseId, ev.isError)) row.stoppedBy = "user";
        if (output !== undefined) this.toolOutputs.set(ev.toolUseId, output.text, output.truncated);
        const call = this.toolCalls.get(ev.toolUseId);
        if (call) {
          call.isError = ev.isError;
          if (ev.testOutcome !== undefined) call.testOutcome = ev.testOutcome;
          if (agentReport !== undefined) call.report = agentReport;
        }
        // MARK: wave3 engine-agents — §36.1: the row keeps the cleaned report (never on the wire, never in transcript_restore).
        this.record({ kind: "tool_result", ...row, ...reportRowFields(keptReport) });
        this.emit({ type: "tool_result", ...row });
        const edited = this.turnEditCalls.get(ev.toolUseId);
        if (ev.isError && edited !== undefined) {
          const entry = this.turnFiles.get(edited);
          if (entry) entry.toolUseIds = (entry.toolUseIds ?? []).filter((id) => id !== ev.toolUseId);
        }
        this.noteResultWhy(ev.toolUseId, ev.isError);
        this.subBrain.onToolResult(ev.toolUseId, ev.isError); // MARK: wave5 w5-brain (§43.2)
        if (this.agents.onToolResult(ev.toolUseId, ev.isError)) this.agentsChanged();
        // MARK: wave3 engine-agents — §36.1: the report, its <usage> and the CLI's agent id on the node; kept for agent_report.
        if (this.agents.onAgentResult({ toolUseId: ev.toolUseId, isError: ev.isError, ...optional("report", keptReport), ...optional("usage", ev.agentUsage), ...optional("cliAgentId", ev.cliAgentId) })) this.agentsChanged();
        return;
      }
      case "tool_files":
        if (this.gate.running) for (const f of ev.files) this.noteTurnFile(f, "Bash", ev.toolUseId);
        this.noteBashFilesWhy(ev.toolUseId);
        if (this.agents.onToolFiles(ev.toolUseId, ev.files)) this.agentsChanged();
        return;
      // MARK: wave2 engine-why — §34.6
      case "bash_snapshot":
        if (this.gate.running && this.gate.checkpoint && samePath(ev.root, this.gate.checkpoint.root)) this.live.onBashSnapshot(ev.toolUseId, ev.tree);
        return;
      // MARK: wave4 w4-longwork — §38.2
      case "rate_limit_info": {
        // MARK: wave7 w7-state — §45.2: a window that comes again unchanged (its receipt time and the order aside) sends no
        // snapshot; a changed one is HUD churn.
        const now = this.now();
        if (!rateLimitChanges(this.rateLimits, ev.window, now)) return;
        this.rateLimits = upsertRateLimit(this.rateLimits, ev.window, now);
        this.touchChurn();
        return;
      }
      case "agent_signal":
        if (this.agents.onSignal(ev.signal)) this.agentsChanged(ev.signal.kind === "task_progress" || ev.signal.kind === "tool_progress");
        return;
      case "permission_request": {
        const { type: _type, ...raw } = ev;
        const request = this.attributePermission(raw);
        this.noteWorktreeBeforeCommand(request); // MARK: wave4b w4b-follow — §39.4
        this.setPendingPermissions([...this.sessionState.pendingPermissions, request]);
        this.emit({ type: "permission_request", ...request });
        this.touch();
        return;
      }
      case "permission_cancelled":
        this.dequeuePermission(ev.requestId);
        this.touch();
        return;
      case "scope_notice": {
        // MARK: wave4b w4b-agents — §39.3: the isolated agent's card says where it worked.
        if (ev.code === "worktree_outside_review" && ev.toolUseId && this.agents.noteWorktree(ev.toolUseId, ev.path, ev.branch)) this.agentsChanged();
        // MARK: wave4b w4b-follow — §39.4: a worktree command that ran: the chat made that worktree; a followed card moves it.
        if (ev.code === "worktree_outside_review" && ev.reasonCode === "worktree_command") {
          const followed = ev.toolUseId !== undefined && this.followAfterTool.has(ev.toolUseId);
          void this.afterWorktreeCommand(ev.path ?? null, ev.toolUseId ?? null);
          if (followed) return; // the chat follows: no "outside the review" warning for it
        }
        // §33.4: once per turn and kind; the client's banner offers "open a workbench". A command's changes in another
        // worktree / nested repository: a row per call that changed something there, naming only the files no row of this
        // turn named yet.
        const key = `${ev.code}|${ev.toolName}|${ev.path ?? ""}|${ev.branch ?? ""}`;
        let files = ev.files;
        if (files) {
          files = files.filter((f) => !this.scopeNoticed.has(`${key}|${f}`));
          if (files.length === 0) return;
          for (const f of files) this.scopeNoticed.add(`${key}|${f}`);
        } else {
          if (this.scopeNoticed.has(key)) return;
          this.scopeNoticed.add(key);
        }
        const { type: _type, toolUseId: _id, reasonCode: _why, files: _files, ...rest } = ev;
        const notice = { ...rest, ...(files ? { files } : {}) };
        this.log("warn", `${ev.code}: ${ev.toolName}${ev.path ? ` ${ev.path}` : ""}${files ? ` (${files.length} files)` : ""}`);
        // What already ran outside the review is a chat row (no state.lastError, never a stopped queue); a blocked call keeps
        // its banner.
        if (ev.code === "worktree_outside_review") this.notice(scopeNoticeMessage(notice), "session", notice);
        else this.fail(scopeNoticeMessage(notice), false, "session", notice);
        return;
      }
      case "budget_event":
        this.budgetUsage = { files: ev.files, lines: ev.lines, denied: ev.kind === "deny" || this.budgetUsage.denied };
        this.settings.budget = ev.budget;
        this.record({ kind: "budget_event", event: ev.kind, toolName: ev.toolName, ...(ev.file !== undefined ? { file: ev.file } : {}), files: ev.files, lines: ev.lines });
        this.emit(ev);
        this.touch();
        return;
      case "plan_exit":
        // The session already denied the tool; the plan is the turn's result, offered right away.
        this.proposePlan(ev.planFiles, ev.plan);
        this.touch();
        return;
      // MARK: wave6 w6-terminal — §44.1: Claude entered plan mode itself — the chip shows it and the plan card works; the
      // project's stored mode stays the user's (`userMode`).
      case "permission_mode":
        if (ev.mode !== "plan" || this.sessionState.permissionMode === "plan") return;
        this.sessionState.prePlanMode = ev.prePlanMode;
        this.sessionState.permissionMode = "plan";
        this.planByClaude = true;
        this.log("info", `Claude entered plan mode (was ${ev.prePlanMode ?? "unknown"})`);
        this.touch();
        return;
      case "turn_end": {
        if (!this.gate.running) {
          // No turn of ours is running (closed abnormally already, or the CLI ran one on its own):
          // nothing to collect, and turnCount / cost / the gate stay as they are (§18).
          this.log("warn", `turn_end (${ev.stopReason}) without a running turn ignored`);
          if (ev.sessionId) this.rememberSession(ev.sessionId);
          return;
        }
        this.gate.running = false;
        this.endTurnWhy();
        this.setPendingPermissions([]);
        this.settlePeerTurn();
        if (ev.sessionId) {
          this.sessionState.sessionId = ev.sessionId;
          this.rememberSession(ev.sessionId);
          if (ev.lastUuid) this.lastForkPoint = { sessionId: ev.sessionId, uuid: ev.lastUuid };
        }
        if (this.turnRecord) {
          this.turnRecord.cliSessionId = ev.sessionId || null;
          this.turnRecord.lastUuid = ev.lastUuid ?? null;
        }
        this.gate.changedOutside = [...ev.changedOutside];
        this.flushTurnText();
        this.budgetUsage = { ...ev.budget };
        this.hud.turnCount += 1;
        this.hud.lastTurnMs = ev.usage.durationMs;
        this.hud.sessionCostUSD += ev.usage.costUsd;
        this.noteTurnModels(ev.usage.models); // MARK: wave4d w4d-agents2 (§42.4)
        this.hud.contextTokens = ev.usage.contextTokens;
        if (ev.usage.contextWindow !== undefined) {
          this.hud.contextWindow = ev.usage.contextWindow;
          this.contextWindows.set(this.statusModelId(this.models ?? STATIC_MODELS, this.session?.statusUsage?.model ?? null), ev.usage.contextWindow);
        }
        this.checkContextWarning();
        this.hud.turnStartedAt = null;
        this.agents.endTurn();
        this.setIdle();
        this.noteTurnEnd(ev.usage);
        this.proposePlan(ev.planFiles);
        this.proposedPlanKeys.clear();
        this.touch();
        // §52: B is taken now — a background task still live may write after it (the next turn keeps A).
        if ((this.sessionState.backgroundTasks ?? []).length > 0) this.bgCarry = true;
        const collection = this.finishTurn(ev.toolFiles, ev.stopReason, ev.usage, ev.toolWindows ?? []);
        this.collection = collection;
        void collection.finally(() => {
          if (this.collection === collection) this.collection = null;
        });
        return;
      }
      case "activity": {
        // MARK: wave7 w7-state — §45.2: the same activity again (the assistant message repeats the streamed tool_start)
        // sends no snapshot; a new one is HUD churn (an idle one touches through `agentsChanged` as well).
        const before = this.hud.activity;
        this.applyActivity(ev.kind, ev.toolName, ev.detail);
        this.emit(ev);
        if (!sameActivity(before, this.hud.activity)) this.touchChurn();
        return;
      }
      case "peer_hold":
        this.onPeerHold(ev);
        return;
      case "peer_delivered":
        this.onPeerDelivered(ev);
        return;
      case "external_turn":
        // §29: a command that is not ours runs (or ended): the input waits for it (`gate_closed:external_turn`).
        if (ev.running) this.externalTurn = { commandUuid: ev.commandUuid ?? null, since: new Date().toISOString(), peer: this.externalTurn?.peer ?? null };
        else {
          this.externalTurn = null;
          this.externalPeerEpisode = false;
        }
        this.touch();
        return;
      case "background_tasks": // §52
        this.onBackgroundTasks(ev.tasks);
        return;
      case "auto_turn_start": // §52.1
        this.onAutoTurnStart(source, ev);
        return;
      case "unprompted_denied":
        this.log("warn", `blocked ${ev.toolName}: Claude Code tried it without a request (unprompted turn)`);
        // §29 (audit peer-04): a peer message the CLI delivered by itself has its card — no banner, no paused queue.
        if (this.externalPeerEpisode) return;
        if (!this.unpromptedNoticed) {
          this.unpromptedNoticed = true;
          this.fail(UNPROMPTED_NOTICE, false, "session", { code: "unprompted_blocked" });
        }
        return;
      case "unprompted_turn_end":
        this.log("warn", "Claude Code ended a turn it ran without a request; not collected or counted");
        this.unpromptedNoticed = false;
        this.externalPeerEpisode = false;
        // The turn wrote the CLI's record of the conversation (§30): resume it from now on.
        if (ev.sessionId) this.rememberSession(ev.sessionId);
        if (!this.gate.running) {
          // Keep what Claude said in the transcript; the turn itself is not a review turn.
          this.flushTurnText();
          this.setIdle();
          this.touch();
        }
        return;
      case "error": {
        const { type: _t, message, fatal, ...details } = ev;
        if (fatal && this.onStartRefused(message, details)) return;
        // Hints (a retry in progress, a slow start) are not the session's last error: no state.lastError.
        if (!fatal && (details.code === "api_retrying" || details.code === "cli_start_slow")) this.emit({ type: "error", message, fatal, scope: "session", ...details });
        else if (!fatal && isLongWorkNotice(details.code)) this.notice(message, "session", details); // MARK: wave4 w4-longwork (§38.2)
        else if (!fatal && isAutoModeNotice(details.code)) this.notice(message, "session", details); // MARK: wave4b w4b-auto (§39.5)
        else this.fail(message, fatal, "session", details);
        if (fatal) this.endTurnAbnormally("error");
        return;
      }
      case "closed":
        this.stopMcpPolling();
        this.session = null;
        this.sessionState.open = false;
        this.sessionState.extensionsWaitingOn = null; // MARK: wave3 engine-session (§36.7)
        this.endCapabilitiesStart(); // MARK: wave3 engine-session (§36.5)
        void source.dispose().catch(() => undefined);
        // §30: a message the refused CLI never took goes to the resumed one (restart_session re-sends it).
        if (this.resendAfterRestart === null) this.endTurnAbnormally("session closed");
        this.endPeerState();
        this.onSessionDied();
        return;
    }
  }

  /**
   * §30: a fatal error that says the CLI refused the start. "Session ID … is already in use" (`--session-id` of a
   * conversation it has) is no failure: the chat is marked `cliKnown` and resumed right away (`onSessionDied`), a message
   * the CLI never took is re-sent — no error row. A resume the CLI cannot find / load becomes the new chat's notice. True
   * when handled (nothing is shown now); a second "already in use" for the same chat is shown like any error.
   */
  private onStartRefused(message: string, details: ErrorDetails): boolean {
    const code = details.code === "session_id_in_use" || details.code === "resume_not_found" || details.code === "resume_failed" ? details.code : codeOfStartFailure(message);
    if (code === null) return false;
    const id = this.currentSessionId;
    if (code === "session_id_in_use") {
      if (!id || this.inUseResumed === id) return false;
      this.log("info", `Claude Code already has session ${id} (${details.detail ?? message}); resuming it`);
      const meta = this.sessions?.get(id);
      if (meta) meta.cliKnown = true;
      this.persistSessions();
      if (this.gate.running && !this.turnSawOutput && this.turnSent !== null) this.resendAfterRestart = { ...this.turnSent };
    } else if (!this.sessionStart.resume) {
      return false;
    }
    this.sessionStart.failure = code;
    if (details.detail) this.sessionStart.failureDetail = details.detail;
    return true;
  }

  /** §31: one attribution of the running turn's events (see `turnFiles`). */
  private noteTurnFile(file: string, tool: string, toolUseId: string): void {
    const entry = this.turnFiles.get(file) ?? { path: file, tools: [], count: 0, toolUseIds: [] };
    if (!entry.tools.includes(tool)) entry.tools.push(tool);
    entry.count += 1;
    if (!entry.toolUseIds!.includes(toolUseId)) entry.toolUseIds!.push(toolUseId);
    this.turnFiles.set(file, entry);
  }

  /** Keeps the newest `MAX_TOOL_CALLS` calls (a review spans a few turns; older ids lose their `why`). */
  private rememberCall(id: string, info: ToolCallInfo): void {
    this.toolCalls.delete(id);
    this.toolCalls.set(id, info);
    while (this.toolCalls.size > MAX_TOOL_CALLS) this.toolCalls.delete(this.toolCalls.keys().next().value!);
  }

  // MARK: wave2 engine-why — §34.6 live changes, §34.8 why, §34.9 test runs

  /** A turn starts: nothing live, no report and no turn files of the last one. */
  private resetTurnWhy(): void {
    this.live.reset();
    this.turnReport = "";
    this.hud.turnFiles = 0;
  }

  /** The turn ended (normally or not): nothing is live any more (the report stays for its collection). */
  private endTurnWhy(): void {
    // What the reuse rules left of the live view's cost (§34.6), for the log of a slow repository.
    if (this.live.snapshotsTaken > 0) this.log("debug", `live_changes took ${this.live.snapshotsTaken} snapshot(s) this turn`);
    this.live.reset();
    this.hud.turnFiles = 0;
  }

  /** §34.9: the live `settings.testCommandPatterns` (strings only). */
  private testCommandPatterns(): string[] {
    const p = this.settings.testCommandPatterns;
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  }

  /** tool_use: the call's turn, order, rationale source / age and subagent type (§34.8); the live tree and the report. */
  private noteCallWhy(ev: Extract<SessionEvent, { type: "tool_use" }>): void {
    const call = this.toolCalls.get(ev.id);
    if (call) {
      call.turn = this.turn;
      call.seq = ++this.callSeq;
      if (ev.rationaleSource !== undefined) call.rationaleSource = ev.rationaleSource;
      if (ev.rationaleAge !== undefined) call.rationaleAge = ev.rationaleAge;
      const type = ev.input.subagent_type;
      if (/^(Agent|Task)$/.test(ev.name) && typeof type === "string" && type) call.subagentType = type;
    }
    if (!this.gate.running) return;
    this.live.onToolUse(ev.id, ev.name);
    // The report is what the main agent says after its last tool call.
    if (ev.parentToolUseId === undefined) this.turnReport = "";
    this.syncTurnFiles();
  }

  /** tool_result: its order and time (§34.9 lastTest); a successful edit inside the repository changed a file. */
  private noteResultWhy(toolUseId: string, isError: boolean): void {
    const call = this.toolCalls.get(toolUseId);
    const cp = this.gate.checkpoint;
    if (call) {
      call.resultSeq = ++this.resultSeq;
      call.resultAt = new Date(this.now()).toISOString();
      const file = this.turnEditCalls.get(toolUseId);
      if (!isError && file !== undefined && cp && toRepoRelative(file, cp.root) !== null) call.fileChanging = true;
    }
    this.live.onToolResult(toolUseId);
    if (this.gate.running) this.syncTurnFiles();
  }

  /** tool_files: the post-Bash snapshot attributed files to the call — it changed files (§34.9). */
  private noteBashFilesWhy(toolUseId: string): void {
    const call = this.toolCalls.get(toolUseId);
    if (call) call.fileChanging = true;
    if (this.gate.running) this.syncTurnFiles();
  }

  /** §34.6 `hud.turnFiles` from the running turn's own attribution (`turnFiles`); a new count goes out with the next state. */
  private syncTurnFiles(): void {
    const cp = this.gate.checkpoint;
    const n = cp ? this.live.turnFileCount(this.turnFiles.values(), cp.root, this.settings.ignorePatterns) : 0;
    if (n === this.hud.turnFiles) return;
    this.hud.turnFiles = n;
    this.touch();
  }

  /** §34.6: the running turn's own start tree — its checkpoint record's (null while that is still being taken), else A. */
  private liveBase(): string | null {
    const rec = this.turnRecord;
    if (rec) return rec.startTree ?? null;
    return this.gate.turnStartTree;
  }

  /** §34.6 `live_changes`: the running turn's changes so far (`running: false`, no files, between turns). */
  private async liveChanges(): Promise<LiveChangesEvent> {
    const cp = this.gate.checkpoint;
    if (!cp) throw new CommandRefused("no_project");
    const idle = () => liveChangesEvent({ running: false, turn: null, base: null, live: null, list: null, reviewPaths: new Set(), now: this.now() });
    if (!this.gate.running) return idle();
    const turn = this.turn;
    const base = this.liveBase();
    const reviewPaths = new Set(this.gate.changedFiles.map((f) => f.path));
    if (base === null) return liveChangesEvent({ running: true, turn, base: null, live: null, list: null, reviewPaths, now: this.now() });
    const ignore = [...this.settings.ignorePatterns];
    const live = await this.live.liveTree(() => cp.snapshot(ignore));
    const list = await this.live.files(liveKey(base, live.tree, ignore), () => liveFileList(cp, base, live.tree, ignore));
    // The turn ended (or another began) while git ran: its changes are the review's now.
    if (!this.gate.running || this.turn !== turn || this.gate.checkpoint !== cp) return idle();
    return liveChangesEvent({ running: true, turn, base, live, list, reviewPaths, now: this.now() });
  }

  /** §34.6 `live_diff {path}`: one file of the latest live tree (one is taken if none) against the turn's start tree. */
  private async liveDiff(path: unknown): Promise<FileDiffEvent> {
    const cp = this.gate.checkpoint;
    if (!cp) throw new CommandRefused("no_project");
    const base = this.gate.running ? this.liveBase() : null;
    if (base === null) throw new CommandRefused("no_live_turn");
    const ignore = [...this.settings.ignorePatterns];
    const live = this.live.latestTree ?? (await this.live.liveTree(() => cp.snapshot(ignore)));
    const list = await this.live.files(liveKey(base, live.tree, ignore), () => liveFileList(cp, base, live.tree, ignore));
    const file = typeof path === "string" ? list.all.find((f) => f.path === path) : undefined;
    if (!file) throw new CommandRefused(`not_a_live_file:${String(path)}`);
    const diff = file.isBinary ? { oldPath: file.oldPath ?? file.path, newPath: file.path, isBinary: true, hunks: [] } : parseUnifiedDiff(await cp.patch(base, live.tree, file.path, file.oldPath));
    const cut = truncateDiff(diff);
    return { type: "file_diff", scope: "live", path: file.path, diff: cut.diff, truncated: cut.truncated, baseTree: base, endTree: live.tree };
  }

  /**
   * `gate.annotateFiles` (§34.7 / §34.8): `generated` / `whitespaceOnly` on every rebuilt list, and `why` — at a
   * collection recomputed for the files the turn changed (its own start tree → B; every file of a fresh turn), kept
   * otherwise (a refresh, a restore, a file a question turn left alone), else computed from the review's calls.
   */
  private async annotateReviewFiles(a: AnnotateArgs): Promise<void> {
    await annotateDetail(a.cp, a.files, a.start, a.end);
    try {
      const previous = new Map(a.previous.map((f) => [f.path, (f as { why?: unknown }).why]));
      // MARK: wave3 check-engine — §37.3: at a collection the gate's own delta of the turn (its start tree → B, the one
      // `changedThisTurn` reads; every file of a fresh turn) says what it changed — no second diff of the same trees.
      const changed: ReadonlySet<string> | null = a.reason === "collect" ? (a.turnPaths ?? new Set(a.files.map((f) => f.path))) : null;
      // A refresh / restore collects no turn: every call the engine remembers (the last turn's too) is an earlier one.
      const ctx = a.reason === "collect" ? { calls: this.toolCalls, turn: this.turn, mainReport: this.turnReport.trim() } : { calls: this.toolCalls, turn: this.turn, mainReport: "", noTurn: true };
      for (const f of a.files as (ChangedFile & { why?: FileWhy })[]) {
        const old = previous.get(f.path);
        if (changed?.has(f.path)) f.why = fileWhy(f, ctx, true);
        else if (isFileWhy(old)) f.why = old;
        else f.why = fileWhy(f, ctx, false);
      }
    } catch (e) {
      this.log("warn", `why: ${errorMessage(e)}`);
    }
  }

  /**
   * The CLI did not initialize within `extensionsInitTimeoutMs` with user settings loaded (§16): a
   * hanging plugin / MCP server / hook must not leave the project without a session. The project's
   * sessions start without user settings from now on (until it is reopened); the running one is
   * restarted — resumed when it had a conversation — and the client gets a banner.
   */
  private onInitTimeout(timeoutMs: number): void {
    // MARK: wave3 engine-session — §36.7: also a start that loads only the local settings (their hooks / MCP servers).
    if (this.extensionsFallback !== null || !(this.ext?.loadUser || this.ext?.loadLocal) || !this.project) return;
    this.extensionsFallback = { reason: "init_timeout", timeoutMs, at: new Date().toISOString() };
    // §36.7: a timeout of a retry falls back for good; any other fallback gets the one automatic retry once idle.
    this.extRetry.auto = this.extRetry.running ? "done" : "pending";
    this.extRetry.running = false;
    const waited = this.waitingOn.current;
    // A message sent while the CLI hung in its initialize handshake never ran: send it again after the restart.
    const resend = this.gate.running && !this.turnSawOutput && this.turnSent !== null;
    this.resendAfterRestart = resend ? { ...this.turnSent! } : null;
    const message =
      `Claude Code did not start within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} of its last progress with your ${this.ext?.loadUser ? "user" : "local"} settings (plugins, MCP servers, hooks)` +
      `${waited?.name ? ` — it was waiting for ${waited.name}` : ""}; restarted without them.` +
      (resend ? " Your message was sent again." : "");
    this.log("warn", message);
    this.fail(message, false, "session", { code: "extensions_init_timeout" });
    this.emit({ type: "extensions_fallback", reason: "init_timeout", timeoutMs, message, ...(resend ? { resent: true as const } : {}) });
    this.refreshExtensions();
    void this.handle({ type: "restart_session" }); // main lane, after whatever is running there
  }

  /** Plugins seen before (this session or the capabilities cache): resolves bare `disabledPlugins` names. */
  private knownPlugins(): ExtensionPlugin[] {
    const fromState = this.sessionState.extensions?.plugins ?? [];
    const fromCache = (this.cachedCapabilities?.pluginDetails ?? []).map((p): ExtensionPlugin => ({ name: p.name, id: p.id, path: p.path, ...(p.version ? { version: p.version } : {}), enabled: true }));
    return [...fromState, ...fromCache.filter((c) => !fromState.some((p) => p.name === c.name))];
  }

  /** Rebuilds `state.session.extensions` from what the session start applied and what the CLI reported. */
  private refreshExtensions(): void {
    const ext = this.ext;
    const root = this.project?.root ?? this.gate.checkpoint?.root;
    if (!ext || !root) {
      this.sessionState.extensions = null;
      return;
    }
    const caps = this.sessionState.capabilities ?? this.cachedCapabilities;
    // What the CLI reported wins; before that, the cached list (only meaningful when user settings load).
    const expected = ext.loadUser ? (caps?.pluginDetails ?? []).filter((p) => !ext.disabledIds.includes(p.id ?? "")).map((p) => ({ name: p.name, path: p.path, ...(p.version ? { version: p.version } : {}) })) : [];
    const plugins = pluginList(ext.plugins ?? expected, ext.disabledIds, this.knownPlugins());
    const configDir = claudeConfigDir(this.childEnv());
    this.sessionState.extensions = {
      settingSources: ext.loadUser ? ["user", "project"] : ["project"],
      fallback: this.extensionsFallback ? { ...this.extensionsFallback } : null,
      plugins,
      disabledPlugins: [...ext.disabledIds],
      unresolvedDisabledPlugins: [...ext.unresolved],
      userHooksDisabled: ext.hooksDisabled,
      skills: [...(caps?.skills ?? [])],
      slashCommands: [...(caps?.slashCommands ?? [])],
      mcpServers: (ext.mcpServers ?? caps?.mcpServers ?? []).map((m) => ({ ...m })),
      memoryFiles: ext.memoryFiles ? ext.memoryFiles.map((m) => ({ ...m })) : null,
      claudeMd: claudeMdStatus({ configDir, cwd: root, memoryFiles: ext.memoryFiles }),
      hooks: discoverHooks({ configDir, cwd: root, loadUser: ext.loadUser, plugins: plugins.filter((p) => p.enabled), disabled: ext.hooksDisabled }),
    };
    this.applyLocalExtensions(root); // MARK: wave3 engine-session (§36.6)
    this.applyInstructionExtensions(this.project?.path ?? root, configDir); // MARK: wave4d w4d-config (§42.3)
    // MARK: wave5 w5-graph — §43.3: the user's mods (absent when there are none)
    const mods = this.userMods(configDir, plugins.map((p) => p.path).filter((p): p is string => typeof p === "string"));
    if (mods.length > 0) this.sessionState.extensions.mods = mods;
  }

  // MARK: wave5 w5-graph — §43.3

  /** The user's mods: `CLAUDE_CODE_PLUGIN_DIRS` of the session's env (else settings.json's) and `<config>/dev-mods`, ≤ every 10 s. */
  private userMods(configDir: string, loadedPaths: string[]): NonNullable<SessionExtensions["mods"]> {
    const env = this.childEnv();
    const pluginDirs = env.CLAUDE_CODE_PLUGIN_DIRS?.trim() ? env.CLAUDE_CODE_PLUGIN_DIRS : settingsPluginDirs(configDir);
    const key = `${configDir}\0${pluginDirs ?? ""}\0${loadedPaths.join("\0")}`;
    const now = Date.now();
    if (this.modsCache && this.modsCache.key === key && now - this.modsCache.at < 10_000) return this.modsCache.mods.map((m) => ({ ...m }));
    let mods: NonNullable<SessionExtensions["mods"]> = [];
    try {
      mods = listUserMods({ configDir, pluginDirs, loadedPaths });
    } catch (e) {
      this.log("debug", `mods: ${errorMessage(e)}`);
    }
    this.modsCache = { at: now, key, mods };
    return mods.map((m) => ({ ...m }));
  }

  /** graphify: the option's, else `~/.local/bin/graphify`, else PATH (the login shell's); looked for again after a minute. */
  private async graphifyPath(): Promise<string | null> {
    if (this.graphifyOverride !== undefined) return this.graphifyOverride;
    const now = Date.now();
    if (this.graphifyFound && now - this.graphifyFound.at < 60_000) return this.graphifyFound.path;
    const tc = await this.locate().catch(() => null);
    const env = { ...this.childEnv(), ...(tc?.path ? { PATH: tc.path } : {}) };
    const path = await findGraphify({ isWindows: this.platform.isWindows, which: (name) => this.platform.which(name, env) });
    this.graphifyFound = { at: now, path };
    return path;
  }

  // ------------------------------------------------------------------ MARK: wave6 w6-statusline — §44.2

  /** Which `statusLine` runs for the open project (re-read before every run, as the CLI follows its settings files). */
  private statusLineResolution(): StatusLineResolution {
    const configDir = claudeConfigDir(this.childEnv());
    return resolveStatusLine({
      configDir,
      cwd: this.project?.path ?? null,
      // Every managed source the CLI reads (server-managed, MDM, the managed folder), cached; unreadable → nothing runs.
      managed: this.managedPolicyOverride ? this.managedPolicyOverride() : readManagedPolicy({ platform: this.platform.name, configDir }),
      allowedProjectSha: this.settings.allowedProjectStatusLine || null,
      // §36.6: no settings.local.json when this project's local settings are off (the session does not load them either).
      loadLocal: this.ext?.loadLocal ?? this.settings.loadLocalSettings !== false,
      // §16: "my hooks off" is the flag layer's disableAllHooks — which the CLI says turns off the status line too.
      disableAllHooks: this.settings.disableUserHooks === true,
    });
  }

  /** What the status line's stdin says about this chat (null without a project or chat: nothing runs). */
  private statusLineSnapshot(): Omit<StatusLineSnapshot, "outputStyle"> | null {
    const project = this.project;
    const sessionId = this.currentSessionId ?? this.sessionState.sessionId;
    if (!project || !sessionId) return null;
    const cwd = project.path;
    const transcriptPath = statusTranscriptPath(cwd, sessionId, this.childEnv());
    const live = this.session?.statusUsage;
    let usage = live?.usage ?? null;
    let apiModel = live?.model ?? null;
    if (!usage) {
      // A chat the engine resumed: the CLI's line reads the conversation it loaded; so does this one.
      const fromTranscript = lastTranscriptUsage(transcriptPath);
      if (fromTranscript) {
        usage = fromTranscript.usage;
        apiModel ??= fromTranscript.model;
      }
    }
    const models = this.models ?? STATIC_MODELS;
    const id = this.statusModelId(models, apiModel);
    return {
      sessionId,
      sessionName: this.sessionStartName,
      transcriptPath,
      cwd,
      projectDir: cwd,
      gitWorktree: gitWorktreeName(project.root),
      repo: repoOfRemote(project.remoteURL),
      model: { id, displayName: id ? modelDisplayName(id, models) : "" },
      version: /\d+\.\d+\.\d+/.exec(this.sessionState.cli?.version ?? this.toolchain.claudeVersion ?? "")?.[0] ?? "",
      costUsd: this.hud.sessionCostUSD,
      durationMs: this.sessionStartedAt === null ? 0 : this.now() - this.sessionStartedAt,
      apiDurationMs: live?.apiDurationMs ?? 0,
      linesAdded: this.chatLines.added,
      linesRemoved: this.chatLines.removed,
      usage,
      contextWindowSize: this.hud.contextWindow ?? this.contextWindows.get(id) ?? (/\[1m\]$/i.test(id) ? 1_000_000 : 200_000),
      effort: id && modelTakesEffort(id, models) ? this.effectiveEffort() ?? "high" : null,
      thinkingEnabled: true,
      fastMode: false,
      rateLimits: this.rateLimits,
      nowMs: this.now(),
    };
  }

  /** `model.id`: the model the next answer comes from — the live / chosen one resolved, else the last answer's, else the CLI's. */
  private statusModelId(models: readonly ModelOption[], apiModel: string | null): string {
    const session = this.session;
    const chosen = session && this.liveModels.has(session) ? this.liveModels.get(session)! : this.effectiveModel();
    const resolved = chosen ? models.find((m) => m.value === chosen)?.resolvedModel ?? chosen : null;
    if (resolved && /^claude-/i.test(resolved)) return resolved;
    return apiModel ?? this.sessionState.model ?? resolved ?? "";
  }

  /** `<gitdir>/reviewgate/capabilities.json`, behind the persist chain (best effort). */
  private persistCapabilities(capabilities: NonNullable<EngineSlices["session"]["capabilities"]>): void {
    const dir = this.projectGitDir;
    if (!dir) return;
    this.persistChain = this.persistChain
      .then(() => saveCapabilities(dir, capabilities))
      .catch((e) => this.log("warn", `persist capabilities: ${errorMessage(e)}`));
    // MARK: wave3 engine-session — §36.5: also the repository's copy, which a worktree without its own replays.
    const common = this.projectCommonDir;
    if (common && !samePath(common, dir)) {
      this.persistChain = this.persistChain
        .then(() => saveCapabilities(common, capabilities))
        .catch((e) => this.log("warn", `persist capabilities (common): ${errorMessage(e)}`));
    }
  }

  // MARK: wave3 engine-session

  /** §36.5: `capabilities.state` — never null while a session starts (the cache, else empty lists). */
  private setCapabilitiesState(state: "starting" | "ready"): void {
    const caps = this.sessionState.capabilities;
    if (caps?.state === state) return;
    this.sessionState.capabilities = { ...(caps ?? emptyCapabilities()), state };
  }

  /** §36.5: a start that ended without initialize (it failed, the CLI died, the session was stopped) is not "starting" any more. */
  private endCapabilitiesStart(): void {
    const caps = this.sessionState.capabilities;
    if (caps?.state !== "starting") return;
    const { state: _state, ...rest } = caps;
    this.sessionState.capabilities = rest;
  }

  /**
   * §36.7: the CLI answered initialize — a start with user settings joins the repository's history (the adaptive limit);
   * the waiting-on line goes; a `retry_extensions` restart succeeded (the fallback episode is over).
   */
  private noteStartAnswered(): void {
    const clock = this.startClock;
    this.startClock = null;
    this.waitingOn.reset();
    this.sessionState.extensionsWaitingOn = null;
    if (this.extRetry.running) {
      this.extRetry.running = false;
      this.extRetry.auto = "none";
      this.log("info", "the session started with the user's extensions again");
    }
    if (!clock?.loadUser) return;
    this.startHistory = noteStartDuration(this.startHistory, Date.now() - clock.at);
    const dir = this.projectCommonDir;
    if (!dir) return;
    const history = [...this.startHistory];
    this.persistChain = this.persistChain.then(() => saveStartHistory(dir, history)).catch((e) => this.log("warn", `persist start history: ${errorMessage(e)}`));
  }

  /**
   * §36.7 `retry_extensions`: after an init-timeout fallback, the session restarts with the user's extensions (resumed, as
   * `restart_session`); a timeout of that start falls back again (no automatic retry after it).
   */
  private async retryExtensions(): Promise<void> {
    if (!this.project || this.gitInit !== null) throw new CommandRefused("no_session");
    if (this.extensionsFallback === null) throw new CommandRefused("extensions_on");
    if (this.sessionState.starting || this.gate.running || this.gate.collecting || this.gate.reverting || this.session?.isTurnActive || this.externalTurn !== null) {
      throw new CommandRefused("session_busy");
    }
    this.cancelExtensionsRetry();
    this.extensionsFallback = null;
    this.extRetry.running = true;
    this.extRetry.auto = "done";
    this.log("info", "retrying the session start with the user's extensions");
    try {
      await this.restartSession(true);
    } finally {
      // The restart could not even begin (no session start happened): the fallback stays the truth.
      if (!this.session && this.extRetry.running && this.extensionsFallback === null && !this.sessionState.starting) this.extRetry.running = false;
    }
  }

  /**
   * §36.8: the version the session's CLI reports (`claude --version` at the start, then `system/init`): `session.cli`, and the
   * app-wide record — a version other than the last one seen sends the `cli_version_changed` notice once (a chat row).
   */
  private noteCliVersionOf(version: string | null): void {
    if (!version || this.sessionState.cli?.version === version) return;
    const { change, previous } = noteCliVersion(this.dataDir, version);
    this.sessionState.cli = cliInfo(version, previous, this.cliVersionsDir, verifiedCliVersions(this.dataDir));
    if (change) {
      const message = `Claude Code changed from ${change.from ?? "an unknown version"} to ${change.to} (${change.verified ? "verified" : "not verified yet"}).`;
      this.log("info", message);
      this.notice(message, "session", { code: "cli_version_changed", cli: { ...change } });
    }
    this.touch();
  }

  /** §36.8 `cli_versions`: the installed versions (by name), newest first; never refused. */
  private cliVersions(): CliVersionsEvent {
    return {
      type: "cli_versions",
      versions: listCliVersions(this.cliVersionsDir, verifiedCliVersions(this.dataDir)),
      current: this.sessionState.cli?.version ?? parseCliVersion(this.toolchain.claudeVersion),
      pinnedPath: this.settings.claudePath?.trim() || null,
    };
  }

  /**
   * §36.9 `cli_sessions` (lane `query`): the user's other Claude processes in this repository's worktrees (the registry,
   * only read; this engine's own CLIs left out) and the terminal / IDE conversations of the repository that can be resumed
   * here (without the running ones and the chats this window already has).
   */
  private async cliSessions(): Promise<CliSessionsEvent> {
    const cp = this.gate.checkpoint;
    if (!this.project || !cp || this.gitInit !== null) throw new CommandRefused("no_project");
    const worktrees = await listWorktrees(cp.root).catch((e) => {
      this.log("warn", `cli_sessions: worktree list: ${errorMessage(e)}`);
      return [] as GitWorktree[];
    });
    const roots = worktrees.filter((w) => !w.bare).map((w) => w.path);
    if (!roots.some((r) => samePath(r, cp.root))) roots.push(cp.root);
    const own = this.session?.pid;
    const running = await runningCliSessions({
      configDir: claudeConfigDir(this.childEnv()),
      worktreeRoots: roots,
      currentRoot: cp.root,
      selfPid: process.pid,
      ...(own !== undefined ? { excludePids: new Set([own]) } : {}),
    });
    const exclude = new Set<string>([...running.flatMap((r) => (r.sessionId ? [r.sessionId] : [])), ...(this.sessions?.list().map((m) => m.id) ?? [])]);
    const resumable = await resumableCliSessions({ mainRoot: roots[0] ?? cp.root, exclude, list: this.listCliSessionsFn });
    // MARK: wave4d w4d-peers — §42.2: how the user's other sessions see this window (its CLI's registry entry).
    const self = own !== undefined ? await selfPeer({ configDir: claudeConfigDir(this.childEnv()), pid: own }) : null;
    return { type: "cli_sessions", running, resumable, ...(self ? { self } : {}) };
  }

  /**
   * §36.9 `cli_session_import`: a new chat of this window that resumes a terminal conversation (`imported`, `cliKnown`),
   * made current like `session_open` with an empty transcript (the conversation stays in the CLI's file). From then on
   * everything goes through the gate: the next send's snapshot A takes what the terminal changed as the baseline.
   */
  private async cliSessionImport(sessionId: unknown): Promise<void> {
    this.guardSessionSwitch();
    if (typeof sessionId !== "string" || !CLI_SESSION_ID_RE.test(sessionId)) throw new CommandRefused("unknown_session");
    if (this.sessions!.get(sessionId)) throw new CommandRefused(`unknown_session:${sessionId}`);
    if (await registryHasSession({ configDir: claudeConfigDir(this.childEnv()), sessionId })) throw new CommandRefused(`cli_session_running:${sessionId}`);
    const found = (await this.cliSessions()).resumable.find((s) => s.sessionId === sessionId);
    if (!found) throw new CommandRefused(`unknown_session:${sessionId}`);
    this.guardSessionSwitch(); // nothing started while the lists were read
    const idx = this.sessions!;
    const meta = idx.create(sessionId);
    meta.title = sessionTitle(found.title);
    meta.cliKnown = true;
    meta.imported = { at: new Date().toISOString(), cwd: found.cwd };
    this.log("info", `importing the CLI conversation ${sessionId} as a new chat`);
    await this.switchSession(meta, true);
  }

  // ------------------------------------------------------------------ MARK: wave4b w4b-follow — §39.4 following Claude into another worktree

  /** A turn, a start, a collection / revert, an open card or a turn the CLI runs on its own: the chat is working. */
  private chatBusy(): boolean {
    return this.gate.running || this.gate.collecting || this.gate.reverting || this.sessionState.starting
      || this.sessionState.pendingPermissions.length > 0 || this.externalTurn !== null;
  }

  /** The review bound to this conversation stays with it (as for a chat switch): a failed collection, a change request, unsent notes. */
  private guardMoveReview(): void {
    if (this.gate.collectError !== null) throw new CommandRefused("collect_failed");
    if (!this.gate.running && this.gate.changesRequestedFiles.length > 0) throw new CommandRefused("review_pending");
    if (this.gate.unsentNoteCount > 0) throw new CommandRefused("notes_pending");
  }

  /** Stops the running turn (an open card is denied with it) and waits until it ended and its changes were collected. */
  private async settleForMove(): Promise<void> {
    if (this.gate.running && this.session) await this.interruptTurn();
    if (this.gate.running) this.endTurnAbnormally("chat moved");
    // The stopped turn's changes are collected here first (a big worktree takes a while; every git call is capped).
    const deadline = Date.now() + Math.max(this.interruptWaitMs, CHAT_MOVE_COLLECT_WAIT_MS);
    while ((this.gate.collecting || this.gate.reverting || this.sessionState.starting) && Date.now() < deadline && !this.closed) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.gate.collecting || this.gate.reverting || this.sessionState.starting) throw new CommandRefused("session_busy");
  }

  /**
   * `chat_move {path, interrupt?, followUp?}`: hands the current chat to another worktree of this repository. Its CLI is
   * stopped and has exited first (two processes on one conversation would corrupt it); then its meta and rows go to the
   * target's `incoming/` (taken by that worktree's engine on `open_project` / `chat_receive`), this window keeps the chat
   * as a record (`movedTo`) and `chat_moved` tells the client to open the target's window. The review stays here.
   */
  private async chatMove(path: unknown, interrupt: boolean, followUp: unknown): Promise<void> {
    const project = this.project;
    const cp = this.gate.checkpoint;
    const idx = this.sessions;
    const dir = this.projectGitDir;
    const chatId = this.currentSessionId;
    if (!project || !cp || this.gitInit !== null || !idx || !dir || !chatId) throw new CommandRefused("no_project");
    const meta = idx.get(chatId);
    if (!meta) throw new CommandRefused("no_project");
    // A record has no conversation of its own here (the CLI lost it, or it moved already).
    if (meta.movedTo !== undefined || meta.resumeFailed === true || this.recordOnlyNext !== null) throw new CommandRefused("chat_is_record");
    const target = moveTarget(path, cp.root, await listWorktrees(cp.root));
    if ("refused" in target) throw new CommandRefused(await moveRefusal(target.refused, path, cp.root));
    const targetGitDir = await resolveGitDir(target.root).catch(() => null);
    if (!targetGitDir) throw new CommandRefused("not_a_worktree");
    this.guardMoveReview();
    let interrupted = false;
    if (this.chatBusy()) {
      if (!interrupt) throw new CommandRefused("session_busy");
      interrupted = this.gate.running || this.externalTurn !== null;
      this.cancelAutoRestart();
      await this.settleForMove();
      this.guardMoveReview();
    }
    const pid = this.session?.pid ?? null;
    this.cancelAutoRestart();
    await this.side.stopAll();
    await this.stopSession();
    if (pid !== null && !(await waitForExit(pid, CHAT_MOVE_EXIT_WAIT_MS))) {
      this.log("warn", `chat_move: claude (pid ${pid}) has not exited; the chat stays here`);
      await this.startSession(project.path, meta.id);
      throw new CommandRefused("cli_still_running");
    }
    await this.persistChain.catch(() => undefined); // the rows and the index are on disk before they are copied
    const at = new Date().toISOString();
    const from = { path: project.root, name: basename(project.root), at };
    const baseline: ChatMoveBaseline = this.createdWorktrees.get(meta.id)?.has(canonicalPath(target.root)) ? "head" : "disk";
    const { movedFrom: _was, movedTo: _never, ...rest } = meta;
    const handoff: ChatHandoff = {
      version: 1,
      meta: { ...structuredClone(rest), ...(this.isResumable(meta) ? { cliKnown: true as const } : {}), movedFrom: from },
      from,
      to: target.root,
      baseline,
      followUp: interrupted && typeof followUp === "string" && followUp.trim() ? followUp.trim() : null,
      permissionMode: this.userMode(), // MARK: wave6 w6-terminal — §44.1: never Claude's own plan mode
      at,
    };
    try {
      await writeHandoff(targetGitDir, handoff, sessionTranscriptPath(dir, meta.id));
    } catch (e) {
      this.log("warn", `chat_move: the handoff could not be written (${errorMessage(e)}); the chat stays here`);
      await this.startSession(project.path, meta.id);
      throw e;
    }
    meta.movedTo = { path: target.root, name: target.name, at };
    this.persistSessions();
    this.log("info", `chat ${meta.id} moved to ${target.root} (review from ${baseline}${interrupted ? ", turn stopped" : ""})`);
    // This window keeps the chat as a record: a fresh CLI under its next chat's id for whatever comes next.
    this.sessionState = this.freshSessionState(); // MARK: wave6 w6-terminal — §44.1 (the user's mode; was: the same mode)
    this.sessionState.rememberedAllows = [...this.rememberedAllows];
    this.applyCachedCapabilities();
    this.hud = initialHud();
    this.chatLines = { added: 0, removed: 0 }; // MARK: wave6 w6-statusline (§44.2)
    this.contextWarned = false;
    this.agents.reset();
    this.budgetUsage = { ...ZERO_USAGE };
    this.autoRestartsThisTurn = 0;
    this.approvedPlan = null;
    this.emit({ type: "chat_moved", sessionId: meta.id, path: target.root, name: target.name, baseline, interrupted });
    this.touch();
    await this.startSession(project.path, null, this.recordOnlyId());
  }

  /** `chat_receive`: the chats handed to this worktree become its own; the newest is opened (resumed) like `session_open`. */
  private async chatReceive(): Promise<void> {
    const dir = this.projectGitDir;
    if (!this.project || !this.sessions || !dir || this.gitInit !== null) throw new CommandRefused("no_project");
    this.guardSessionSwitch();
    const meta = await this.takeIncoming(this.sessions, dir);
    if (!meta) throw new CommandRefused("nothing_to_receive");
    await this.switchSession(meta, this.isResumable(meta));
    await this.applyReceivedBaseline();
    this.afterReceived();
  }

  /** Takes every chat waiting in `<gitdir>/reviewgate/incoming/` into the index (rows moved in); returns the newest (null: none). */
  private async takeIncoming(idx: SessionIndex, dir: string): Promise<SessionMeta | null> {
    const incoming = await readIncoming(dir).catch((e: unknown) => {
      this.log("warn", `incoming chats: ${errorMessage(e)}`);
      return [];
    });
    let last: { meta: SessionMeta; handoff: ChatHandoff } | null = null;
    for (const chat of incoming) {
      const { movedTo: _gone, ...rest } = chat.handoff.meta;
      const meta = idx.adopt({ ...rest, movedFrom: chat.handoff.from }, chat.rowsPath);
      dropIncoming(chat);
      if (!meta) continue;
      // MARK: wave4b w4b-side — §40.3: the chat's side threads come along from the source worktree (its record keeps them);
      // copied once the chat is in this index, so the open's prune of chat-less side files cannot take them.
      await resolveGitDir(chat.handoff.from.path)
        .then((from) => copySideThreads(from, dir, meta.id))
        .catch((e: unknown) => this.log("warn", `incoming chat ${meta.id}: side threads: ${errorMessage(e)}`));
      last = { meta, handoff: chat.handoff };
      this.log("info", `chat ${meta.id} moved in from ${chat.handoff.from.path}`);
    }
    if (!last) return null;
    await idx.save();
    this.receivedMove = last;
    // §11: the permission mode follows the chat ('세션 동안 허용' does not: §33.7, this worktree's own).
    if (last.handoff.permissionMode) this.restoreMode(last.handoff.permissionMode);
    return last.meta;
  }

  /**
   * The moved chat created this worktree (`baseline: "head"`): the first review starts at HEAD's commit tree, so what it did
   * here before the move (copied files, edits) is in it — as files changed outside the app's turns (`external`). A worktree
   * that already has a review, or a HEAD that cannot be read, starts from the disk as it is (`disk`), like every other.
   */
  private async applyReceivedBaseline(): Promise<void> {
    const got = this.receivedMove;
    const cp = this.gate.checkpoint;
    if (!got || !cp || got.handoff.baseline !== "head") return;
    if (this.gate.changedFiles.length > 0 || this.gate.turnStartTree !== null || this.gate.running) {
      got.handoff.baseline = "disk";
      return;
    }
    const startRef = turnRefs(this.gate.refNs).start;
    try {
      const head = (await runGit(cp.root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { allowFailure: true })).text.trim();
      if (!/^[0-9a-f]{40,64}$/.test(head)) {
        got.handoff.baseline = "disk";
        return;
      }
      await cp.pinRef(startRef, head);
      const saved: PersistedReview = {
        version: 1, turnStartTree: head, turnEndTree: null, changedFiles: [], reviewNotes: [], acceptedPatchHashes: {}, acceptedPaths: [],
        rejectedPaths: [], lastReviewSummary: null, isRequestingChanges: false, isAnsweringReview: false, lastUserText: got.meta.lastUserText,
        sessionId: got.meta.id, savedAt: new Date().toISOString(),
      };
      if (await this.gate.restore(saved)) {
        this.gate.restored = false; // not a review brought back from an earlier run
        this.log("info", `moved chat: the review starts at HEAD (${this.gate.changedFiles.length} file(s) changed before the move)`);
      } else {
        await cp.pinRef(startRef, null);
      }
    } catch (e) {
      this.log("warn", `moved chat: the review could not start at HEAD (${errorMessage(e)})`);
      got.handoff.baseline = "disk";
      await cp.pinRef(startRef, null).catch(() => undefined);
    }
    this.touch();
  }

  /** Says in the moved chat where it came from (after its rows) and sends the follow-up once — a normal send, through the gate. */
  private afterReceived(): void {
    const got = this.receivedMove;
    this.receivedMove = null;
    if (!got) return;
    const head = got.handoff.baseline === "head";
    const from = got.handoff.from.path;
    this.notice(
      head
        ? `This chat moved here from ${from}. It is reviewed from here on, with what it changed here before the move.`
        : `This chat moved here from ${from}. It is reviewed from here on; changes made here before the move are not in the review.`,
      "session",
      { code: head ? "chat_moved_in" : "chat_moved_in_disk", path: from, sessionId: got.meta.id },
    );
    this.touch();
    const text = got.handoff.followUp;
    if (text) void this.handle({ type: "send", text });
  }

  /** A worktree command's card: whether its path is a worktree already, read now (before the command can run). */
  private noteWorktreeBeforeCommand(request: PermissionRequest): void {
    const cp = this.gate.checkpoint;
    const path = request.reason?.code === "worktree_command" ? request.reason.path : undefined;
    if (!cp || !path || !request.toolUseId) return;
    this.worktreeBeforeCommand.set(
      request.toolUseId,
      listWorktrees(cp.root).then(
        (list) => ({ was: !("refused" in moveTarget(path, cp.root, list)), roots: list.map((w) => canonicalPath(w.path)) }),
        () => ({ was: false, roots: [] }),
      ),
    );
  }

  /**
   * A worktree command of this chat ran: when its path is now a worktree of this repository, the chat created it (its move
   * there reviews from HEAD). A card answered "허용하고 따라가기" moves the chat there now (the running turn is stopped).
   */
  private async afterWorktreeCommand(path: string | null, toolUseId: string | null): Promise<void> {
    const cp = this.gate.checkpoint;
    const chat = this.currentSessionId;
    const follow = toolUseId ? this.followAfterTool.get(toolUseId) : undefined;
    if (toolUseId) this.followAfterTool.delete(toolUseId);
    let where = path ?? follow?.path ?? null;
    const beforeP = toolUseId ? this.worktreeBeforeCommand.get(toolUseId) : undefined;
    if (toolUseId) this.worktreeBeforeCommand.delete(toolUseId);
    if (!cp || !chat) return;
    const before = beforeP ? await beforeP : undefined;
    let isWorktree = false;
    let refusal = "not_a_worktree";
    try {
      const list = await listWorktrees(cp.root);
      let target = where ? moveTarget(where, cp.root, list) : ({ refused: "path_not_found" } as const);
      // The command's words did not name the worktree it made (`"$WT"`, `$(…)`, a script): the one that appeared is it.
      if ("refused" in target && before) {
        const known = new Set(before.roots);
        const added = list.filter((w) => !w.bare && !w.prunable && w.path && !known.has(canonicalPath(w.path)));
        if (added.length === 1) {
          this.log("info", `worktree command: ${where ?? "(no path)"} is no worktree; the one it added is ${added[0]!.path}`);
          where = added[0]!.path;
          target = moveTarget(where, cp.root, list);
        }
      }
      if ("refused" in target) refusal = await moveRefusal(target.refused, where, cp.root);
      else {
        isWorktree = true;
        // A worktree that was there before the card (`git worktree add` refused, hidden by `| tail`) was not created by it:
        // the user's own changes there must not land in the review (its move reviews from the disk).
        if (before?.was && path !== null && samePath(canonicalPath(where!), canonicalPath(path))) this.log("info", `worktree command: ${target.root} was a worktree already (its review starts from the disk)`);
        else {
          let roots = this.createdWorktrees.get(chat);
          if (!roots) this.createdWorktrees.set(chat, (roots = new Set()));
          roots.add(canonicalPath(target.root));
        }
      }
    } catch (e) {
      this.log("warn", `worktree check: ${errorMessage(e)}`);
    }
    if (!follow) {
      // Not followed: list the new worktree now (not at the turn's end), so the warning offers "이 채팅을 거기로 옮기기" at once.
      if (isWorktree && !this.closed) {
        await this.refreshWorkbenches(false);
        this.touch();
      }
      return;
    }
    const failed = (code: string) =>
      this.fail(`This chat could not move to ${where ?? "the new worktree"} (${code}); it stays here.`, false, "session", { code: "chat_move_failed", ...(where ? { path: where } : {}), detail: code });
    if (!isWorktree || !where) {
      failed(refusal);
      return;
    }
    const to = where;
    // On the main lane like a client's command; a refusal is said in the chat instead of a reply nobody waits for.
    const run = this.lanes.main.then(() => (this.closed ? undefined : this.chatMove(to, true, follow.followUp)));
    this.lanes.main = run.catch((e: unknown) => {
      if (!this.closed) failed(errorMessage(e));
    });
  }

  /** §36.7: idle = a ready session, no turn / start / collection / revert, no open card, no turn the CLI runs on its own. */
  private extensionsRetryIdle(): boolean {
    const s = this.session;
    return this.extensionsFallback !== null && this.project !== null && s !== null && this.sessionState.open && !this.sessionState.starting
      && (this.sessionStart.ready === true || this.sessionStart.gotInfo) && !this.gate.running && !this.gate.collecting && !this.gate.reverting
      && !s.isTurnActive && this.sessionState.pendingPermissions.length === 0 && this.externalTurn === null
      && (this.settings.loadUserSettings !== false || this.settings.loadLocalSettings !== false);
  }

  /** §36.7: after a fallback, the first time the session is idle (for `extensionsAutoRetryMs`), the engine retries once. */
  private maybeAutoRetryExtensions(): void {
    if (this.extRetry.auto !== "pending" || this.extRetry.timer || this.extensionsAutoRetryMs <= 0 || !this.extensionsRetryIdle()) return;
    this.extRetry.timer = setTimeout(() => {
      this.extRetry.timer = null;
      if (this.closed || this.extRetry.auto !== "pending") return;
      if (!this.extensionsRetryIdle()) return; // busy again: the next idle snapshot schedules it anew
      this.log("info", "extensions fallback: retrying with the user's extensions once, now that the session is idle");
      void this.handle({ type: "retry_extensions" });
    }, this.extensionsAutoRetryMs);
    this.extRetry.timer.unref?.();
  }

  private cancelExtensionsRetry(): void {
    if (this.extRetry.timer) clearTimeout(this.extRetry.timer);
    this.extRetry.timer = null;
  }

  /**
   * §36.6: `extensions.settingSources` with "local" when the local settings load (their hooks listed with the project's),
   * else `notApplied` — what `.claude/settings.local.json` and the local-scope MCP servers hold that this session leaves out.
   */
  private applyLocalExtensions(root: string): void {
    const ext = this.ext;
    const out = this.sessionState.extensions;
    if (!ext || !out) return;
    const loadLocal = ext.loadLocal === true;
    out.settingSources = settingSourcesOf(ext.loadUser, loadLocal);
    if (loadLocal) {
      out.hooks = [...out.hooks, ...localHookSources(root, ext.hooksDisabled)];
      out.notApplied = null;
    } else {
      out.notApplied = notAppliedLocalSettings({ root, projectPath: this.project?.path ?? root, env: this.childEnv() });
    }
  }

  /** Stores the assistant text of the turn as one transcript row (`unprompted` when the CLI ran the turn on its own, §18). */
  private flushTurnText(): void {
    const text = this.turnText.trim();
    const unprompted = this.turnTextUnprompted;
    this.turnText = "";
    this.turnTextUnprompted = false;
    if (text) this.record({ kind: "assistant_text", text, ...(unprompted ? { unprompted: true as const } : {}) });
  }

  /** `<gitdir>/reviewgate-session.json` keeps the session id for `resume` on the next open / restart (+ the sessions index). */
  private rememberSession(sessionId: string): void {
    this.adoptReportedSessionId(sessionId);
    // §30: the CLI now has a record of it — from here on the chat is resumed, whatever its turn count says.
    const meta = this.sessions?.get(sessionId);
    if (meta && meta.cliKnown !== true) meta.cliKnown = true;
    this.persistSessions();
  }

  /** Fatal session error / session gone while a turn was running: close the turn and collect what is on disk. */
  private endTurnAbnormally(stopReason: string): void {
    const wasRunning = this.gate.running;
    this.gate.running = false;
    this.endTurnWhy();
    this.setPendingPermissions([]);
    this.settlePeerTurn();
    this.hud.turnStartedAt = null;
    this.agents.endTurn();
    this.setIdle();
    this.touch();
    if (wasRunning) {
      // The turn's last chain entry is unknown: the next turn cannot be rewound to (nor a side question fork at it).
      this.lastForkPoint = null;
      this.flushTurnText();
      this.noteTurnEnd(null);
      // No toolFiles from the session: the turn's own tool events attribute its files (§31).
      void this.finishTurn([...this.turnFiles.values()].map((f) => ({ ...f, tools: [...f.tools], toolUseIds: [...(f.toolUseIds ?? [])] })), stopReason, null);
    }
  }

  private setIdle(): void {
    this.hud.activity = { kind: "idle" };
    this.agentsChanged(false);
  }

  /**
   * Mirrors the tracker into the HUD (`agents`, `subagentDepth`) and schedules a snapshot: at once for
   * lifecycle changes, at most every `AGENT_PROGRESS_MS` for progress (the trailing update is never lost).
   */
  private agentsChanged(progress = false): void {
    this.hud.agents = this.agents.list as AgentNode[];
    this.hud.subagentDepth = this.agents.foregroundRunning;
    // MARK: wave3 engine-agents — §36.4: the main turn blocked on foreground subagents; null between turns.
    this.hud.waitingOnAgents = this.gate.running ? this.agents.waitingOn() : null;
    // MARK: wave4b w4b-agents — §39.3: finished agents of this chat's earlier turns.
    this.hud.agentHistory = this.agents.history as AgentNode[];
    // MARK: wave7 w7-state — §45.2: nothing the snapshot shows changed (every idle activity lands here): no snapshot.
    const key = JSON.stringify([this.hud.agents, this.hud.subagentDepth, this.hud.waitingOnAgents, this.hud.agentHistory]);
    if (key === this.agentsKey) return;
    this.agentsKey = key;
    const wait = progress ? this.lastAgentEmit + AGENT_PROGRESS_MS - Date.now() : 0;
    if (wait <= 0) {
      if (this.agentTimer) {
        clearTimeout(this.agentTimer);
        this.agentTimer = null;
      }
      this.lastAgentEmit = Date.now();
      this.touchChurn(); // MARK: wave7 w7-state (§45.2): a subagent's step is HUD churn
    } else if (!this.agentTimer) {
      this.agentTimer = setTimeout(() => {
        this.agentTimer = null;
        this.lastAgentEmit = Date.now();
        this.touchChurn();
      }, wait);
      this.agentTimer.unref?.();
    }
  }

  /** Repo-relative path for `AgentNode.files` when inside the open repository, else the absolute path. */
  private repoRelative(abs: string): string {
    const root = this.gate.checkpoint?.root;
    if (!root) return abs;
    return toRepoRelative(abs, root) ?? abs;
  }

  // MARK: wave3 engine-agents
  /** §36.1 `agent_report`: from memory, else from the current chat's transcript rows (also after a restart). */
  private agentReport(toolUseId: string): AgentReportEvent {
    if (typeof toolUseId !== "string" || !toolUseId) throw new CommandRefused("unknown_agent");
    const found = this.agents.report(toolUseId) ?? agentReportFromRows(toolUseId, this.transcript?.tail(Number.MAX_SAFE_INTEGER) ?? []);
    if (typeof found === "string") throw new CommandRefused(found);
    return found;
  }

  // ------------------------------------------------------------------ §52 background work

  /** `task_stop {taskId}`: `Query.stopTask` for a live background task (its `task_notification` says `stopped`). */
  private async taskStop(taskId: unknown): Promise<void> {
    const session = this.session;
    if (!session) throw new CommandRefused("no_session");
    if (typeof taskId !== "string" || !(this.sessionState.backgroundTasks ?? []).some((t) => t.taskId === taskId)) throw new CommandRefused("task_unknown");
    if (!session.stopTask) throw new CommandRefused("task_stop_failed:this Claude session cannot stop a task", { code: "task_stop_failed" });
    try {
      await withTimeout(session.stopTask(taskId), STOP_AGENT_TIMEOUT_MS, "stopTask");
    } catch (e) {
      throw new CommandRefused(`task_stop_failed:${firstLineOf(errorMessage(e))}`, { code: "task_stop_failed" });
    }
    this.log("info", `task_stop: background task ${taskId} stopped`);
  }

  /** `task_background {toolUseId?}`: Ctrl+B — the running call (all foreground tasks without an id) goes on in the background. */
  private async taskBackground(toolUseId: unknown): Promise<TaskBackgroundEvent> {
    const session = this.session;
    if (!session) throw new CommandRefused("no_session");
    if (!session.backgroundTasks || session.backgroundWorkOn === false) throw new CommandRefused("background_off");
    const id = typeof toolUseId === "string" && toolUseId ? toolUseId : undefined;
    let moved: boolean;
    try {
      moved = await withTimeout(session.backgroundTasks(id), STOP_AGENT_TIMEOUT_MS, "backgroundTasks");
    } catch (e) {
      throw new CommandRefused(`task_background_failed:${firstLineOf(errorMessage(e))}`, { code: "task_background_failed" });
    }
    this.log("info", `task_background${id ? ` ${id}` : ""}: ${moved ? "moved" : "nothing to move"}`);
    return { type: "task_background", moved };
  }

  /** `task_output {taskId}`: the last 64 KiB of the file the CLI named for that task (only that file is read). */
  private async taskOutput(taskId: unknown): Promise<TaskOutputEvent> {
    const session = this.session;
    if (typeof taskId !== "string" || !taskId || !session) throw new CommandRefused("task_unknown");
    const path = session.taskOutputFile?.(taskId) ?? null;
    if (!path) throw new CommandRefused(session.taskOutputFile ? "no_output" : "task_unknown");
    let tail: { text: string; truncated: boolean };
    try {
      tail = await readTail(path);
    } catch (e) {
      throw new CommandRefused(`no_output:${firstLineOf(errorMessage(e))}`, { code: "no_output" });
    }
    return { type: "task_output", taskId, text: tail.text, truncated: tail.truncated, running: session.isTaskLive?.(taskId) === true };
  }

  /** The session's live background tasks: each named with the transcript turn of the call that started it. */
  private onBackgroundTasks(tasks: BackgroundTask[]): void {
    const turnOf = (id: string | null) => (id === null ? null : this.toolCalls.get(id)?.turn ?? null);
    const before = this.sessionState.backgroundTasks ?? [];
    this.sessionState.backgroundTasks = tasks.map((t) => ({ ...t, turn: t.turn ?? before.find((b) => b.taskId === t.taskId)?.turn ?? turnOf(t.toolUseId) }));
    // §52.1: work in the background while no turn of ours runs reaches the next review (A is kept).
    if (tasks.length > 0 && !this.gate.running) this.bgCarry = true;
    this.touch();
  }

  /** §52.1: whether the next turn keeps A (consumed: the turn's own collection sets it again while tasks still run). */
  private takeBgCarry(): boolean {
    const carry = this.bgCarry || (this.sessionState.backgroundTasks ?? []).length > 0;
    this.bgCarry = false;
    return carry;
  }

  /**
   * §52.1: the CLI started a turn itself. Its events wait (`adoptQueue`) while the engine takes it as `peer_accept` takes a
   * peer message (§29): the collection in flight first, then A (kept with a standing review or work in the background),
   * the turn's start and its `auto_turn` row — then the session lets its calls run. When the gate cannot take it, §18
   * applies as before (its changes are denied).
   */
  private onAutoTurnStart(source: ClaudeSessionLike, ev: Extract<SessionEvent, { type: "auto_turn_start" }>): void {
    this.adoptQueue = [];
    // Clients hold their messages meanwhile (`gate_closed:external_turn`), as for any turn that is not ours.
    this.externalTurn = { commandUuid: ev.commandUuid ?? null, since: new Date().toISOString(), peer: null };
    this.touch();
    void this.adoptAutoTurn(source, ev);
  }

  private async adoptAutoTurn(source: ClaudeSessionLike, ev: Extract<SessionEvent, { type: "auto_turn_start" }>): Promise<void> {
    let ok = false;
    let tree: string | undefined;
    const deadline = Date.now() + AUTO_TURN_WAIT_MS;
    try {
      if (this.collection) await this.collection.catch(() => undefined);
      while ((this.gate.collecting || this.gate.reverting) && this.session === source && Date.now() < deadline) await pause(50);
      if (this.session !== source || this.closed) return;
      if (this.gate.running) {
        // A send slipped in before the input closed: the CLI's turn joins it — and the session waits for that message too.
        const joinBy = Math.min(deadline, Date.now() + AUTO_TURN_JOIN_MS);
        while (this.gate.running && this.turnSent === null && this.session === source && Date.now() < joinBy) await pause(20);
        this.log("info", "a turn Claude started joins the turn of a message sent meanwhile");
        ok = this.gate.running;
        return;
      }
      this.externalTurn = null;
      if (!this.gate.checkpoint || !canSend(this.slices())) {
        this.log("warn", `a turn Claude started cannot be reviewed now (${this.closedReason(this.slices())}): its changes are denied`);
        return;
      }
      await this.followHeadMove();
      await this.gate.prepareAnswer(this.takeBgCarry());
      const keptA = this.gate.keepsTurnStart;
      this.gate.running = true;
      try {
        tree = await this.gate.snapshotStart();
      } catch (e) {
        this.gate.abortTurn();
        tree = undefined;
        this.log("warn", `a turn Claude started: snapshot A failed (${errorMessage(e)}); its changes are denied`);
        return;
      }
      const skippedAtStart = this.gate.snapshotSkipped;
      const info: AutoTurnInfo = { trigger: ev.trigger, ...(ev.task ? { task: { ...ev.task } } : {}), ...(ev.wakeupSource ? { wakeupSource: ev.wakeupSource } : {}) };
      const display = autoTurnPrompt(info);
      this.sessionState.pendingPlan = null;
      this.proposedPlanKeys.clear();
      // Nothing of ours goes out: the review summary waits for the user's next real message.
      this.gate.beginSend(display, true);
      await this.adoptRecordOnly();
      const meta = this.currentSessionId ? this.sessions?.get(this.currentSessionId) : undefined;
      if (meta) {
        meta.updatedAt = new Date().toISOString();
        this.persistSessions();
      }
      this.beginTurn(display, {}, true);
      this.gate.snapshotSkipped = skippedAtStart;
      this.record({ kind: "auto_turn", ...info });
      this.emit({ type: "auto_turn", turn: this.turn, ...info });
      // §31 / §32: a review turn — HEAD, settings.local.json and nested HEADs are compared at its end too.
      await this.noteTurnStartState();
      await this.startRecord(keptA ? null : tree);
      this.gate.noteTurnStart(this.turnRecord?.startTree ?? null); // §34.1: "this turn" starts here
      this.turnSent = null;
      ok = true;
      this.log("info", `turn ${this.turn}: Claude started it itself (${ev.trigger}); reviewed like any other`);
    } catch (e) {
      this.log("warn", `a turn Claude started could not be taken: ${errorMessage(e)}`);
      if (this.gate.running && !ok) {
        this.gate.abortTurn();
        this.dropRecord();
        this.hud.turnStartedAt = null;
        this.setIdle();
      }
    } finally {
      if (!ok) this.externalTurn = null;
      if (this.session === source) source.autoTurnReady?.(ok, ok && tree !== undefined ? this.turnHookTree(tree) : undefined);
      this.drainAdoptQueue();
      this.touch();
    }
  }

  /** The events held while a turn Claude started was being taken, in order (one may start the next such turn: it holds the rest). */
  private drainAdoptQueue(): void {
    const queued = this.adoptQueue;
    this.adoptQueue = null;
    for (const { source, ev } of queued ?? []) this.onSessionEvent(source, ev);
  }

  private endBackgroundState(): void {
    this.sessionState.backgroundTasks = [];
    const queued = this.adoptQueue;
    this.adoptQueue = null;
    if (queued && queued.length > 0) this.log("debug", `dropped ${queued.length} session event(s) of a turn being taken when the session ended`);
  }

  /** §36.2 `stop_agent`: `query.stopTask` for that one subagent; the main turn and the other agents go on. */
  private async stopAgent(toolUseId: string): Promise<void> {
    const target = typeof toolUseId === "string" && toolUseId ? this.agents.stopTarget(toolUseId) : "unknown_agent";
    if (typeof target === "string") throw new CommandRefused(target);
    const session = this.session;
    if (!session?.stopTask) throw new CommandRefused("not_supported: this Claude session cannot stop one task");
    this.agents.requestStop(toolUseId);
    try {
      await withTimeout(session.stopTask(target.taskId), STOP_AGENT_TIMEOUT_MS, "stopTask");
    } catch (e) {
      // The CLI may have stopped it all the same (its notification arrived first).
      if (this.agents.node(toolUseId)?.stoppedBy === "user") return;
      this.agents.cancelStop(toolUseId);
      throw new CommandRefused(`${this.agents.stopTarget(toolUseId) === "not_running" ? "not_running" : "not_supported"}: ${errorMessage(e)}`);
    }
    this.log("info", `stop_agent: ${toolUseId} (task ${target.taskId}) stopped`);
    if (this.agents.confirmStop(toolUseId)) this.agentsChanged();
  }

  private applyActivity(kind: ActivityKind, toolName?: string, detail?: string): void {
    const h = this.hud;
    switch (kind) {
      case "tool_start":
        h.activity = { kind: "tool", toolName: toolName ?? "?", ...(detail !== undefined ? { detail } : {}) };
        break;
      case "tool_end":
        h.activity = h.subagentDepth > 0 ? { kind: "subagent" } : { kind: "working" };
        break;
      case "subagent_start":
        h.activity = { kind: "subagent", ...(toolName !== undefined ? { toolName } : {}), ...(detail !== undefined ? { detail } : {}) };
        break;
      case "subagent_end":
        h.activity = h.subagentDepth > 0 ? { kind: "subagent" } : { kind: "working" };
        break;
      case "thinking":
        h.activity = { kind: "thinking", ...(detail !== undefined ? { detail } : {}) };
        break;
      case "idle":
        this.setIdle();
        break;
    }
  }

  // ------------------------------------------------------------------ emission

  private slices(): EngineSlices {
    return {
      seq: this.seq,
      project: this.project,
      gitInit: this.gitInit,
      session: {
        ...this.sessionState,
        prePlanMode: this.prePlanModeNow(), // MARK: wave6 w6-terminal (§44.1)
        effort: this.effectiveEffort(),
        selectedModel: this.effectiveModel(),
        availableModels: (this.models ?? STATIC_MODELS).map((m) => ({ ...m, ...(m.supportedEffortLevels ? { supportedEffortLevels: [...m.supportedEffortLevels] } : {}) })),
        checkpoints: checkpointViews(this.checkpoints.records, { conversationLost: this.openChatIsRecord() }),
        ready: this.sessionState.open && !this.sessionState.starting && (this.sessionStart.ready === true || this.sessionStart.gotInfo),
        peerInbound: this.peerMode(),
        peerInbox: [...this.peerInbox.values()].map((m) => ({ ...m })),
        externalTurn: this.externalTurn ? { ...this.externalTurn, peer: this.externalTurn.peer ? { ...this.externalTurn.peer } : null } : null,
        backgroundTasks: (this.sessionState.backgroundTasks ?? []).map((t) => ({ ...t })), // §52
        peerTurn: this.peerTurn ? { messageIds: [...this.peerTurn.messageIds], fromNames: [...this.peerTurn.fromNames] } : null,
        ...this.planSourceSlice(), // MARK: wave4d w4d-plan (§42.1)
      },
      toolchain: this.toolchain,
      gate: this.gate,
      budget: this.settings.budget,
      budgetUsage: this.budgetUsage,
      hud: this.rateLimits.length > 0 ? { ...this.hud, rateLimits: this.rateLimits.map((w) => ({ ...w })) } : this.hud, // MARK: wave4 w4-longwork (§38.2)
      branches: this.branches,
      pr: this.pr,
      lastError: this.lastError,
      workbenches: this.workbenches,
      lockConflict: this.lockConflict,
      commit: this.commitSlice,
      sessions: { list: this.sessions?.list() ?? [], currentId: this.currentSessionId, openTabIds: this.openTabIds },
      storage: { saveFailed: this.saveHealth.view, disk: this.disk ? { ...this.disk } : null }, // MARK: wave4b w4b-bigturn (§39.1)
      autoAcceptRules: this.autoAcceptRules, // MARK: wave4c w4c-trust (§41.2)
    };
  }

  /** Schedules one `state` emission on the next macrotask (bursts coalesce). */
  private touch(): void {
    if (this.stateTimer || this.closed) return;
    this.stateTimer = setImmediate(() => {
      this.stateTimer = null;
      this.emitState();
    });
  }

  /**
   * MARK: wave7 w7-state — §45.2: a HUD-only change (the activity line, a subagent's step, the usage windows): a snapshot
   * at once when none carried churn in the last `STATE_CHURN_GAP_MS`, else one at the end of that window. Any other
   * snapshot before then carries it as well.
   */
  private touchChurn(): void {
    if (this.closed || this.churnTimer) return;
    const wait = this.lastChurnAt + STATE_CHURN_GAP_MS - Date.now();
    if (wait <= 0) {
      this.lastChurnAt = Date.now();
      this.touch();
      return;
    }
    this.churnTimer = setTimeout(() => {
      this.churnTimer = null;
      this.lastChurnAt = Date.now();
      this.touch();
    }, wait);
    this.churnTimer.unref?.();
  }

  private emitState(): void {
    if (this.closed) return;
    if (this.churnTimer) {
      // MARK: wave7 w7-state (§45.2): this snapshot carries the churn that waited; the window starts again from here.
      clearTimeout(this.churnTimer);
      this.churnTimer = null;
      this.lastChurnAt = Date.now();
    }
    this.seq += 1;
    this.lastState = buildState({ ...this.slices(), seq: this.seq });
    this.emit({ type: "state", state: this.lastState });
    this.maybeAutoAcceptPeers(this.lastState);
    this.maybeAutoRetryExtensions(); // MARK: wave3 engine-session (§36.7)
  }

  // ---------------------------------------------------------------- MARK: wave5 w5-brain — §43.2 the sub-brain

  /** The memory folder for the open project (the CLI's loaded MEMORY.md first); a different folder starts a new baseline. */
  private refreshBrainDir(): void {
    const path = this.project?.path;
    if (!path) return;
    const env = this.childEnv();
    this.subBrain.setDir(autoMemoryDir({ projectPath: path, configDir: claudeConfigDir(env), env, cliMemoryFiles: this.ext?.memoryFiles ?? null }));
  }

  /** Who makes a tool call: the main agent, or the subagent whose Agent / Task call it runs under. */
  private brainCaller(parentToolUseId: string | undefined): BrainCaller {
    if (parentToolUseId === undefined) return { by: "main" };
    const node = this.agents.list.find((n) => n.toolUseId === parentToolUseId);
    return node ? { by: "agent", agentType: node.type } : { by: "agent" };
  }

  /** `brain {watch?}`: reads the folder now; `watch` starts / stops the 4 s re-read that sends each change. */
  private async brainSnapshot(watch: boolean | undefined): Promise<BrainEvent> {
    if (!this.project) {
      this.subBrain.setWatching(false);
      return this.subBrain.snapshot();
    }
    this.refreshBrainDir();
    if (watch !== false) await this.subBrain.scan();
    if (typeof watch === "boolean") this.subBrain.setWatching(watch);
    return this.subBrain.snapshot();
  }

  /** `brain_read {name}`: one memory's text, read only. */
  private async brainRead(name: string): Promise<BrainMemoryEvent> {
    if (!this.project) throw new CommandRefused("no_project");
    this.refreshBrainDir();
    if (!this.subBrain.hasBaseline) await this.subBrain.scan();
    return this.subBrain.read(name);
  }

  private emit(ev: EngineEvent): void {
    if (this.closed) return;
    // MARK: wave3 engine-agents — §36.1: restores stay small; `agent_report` reads the kept reports from the rows.
    if (ev.type === "transcript_restore") ev = withoutReports(ev);
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (e) {
        this.logFn("error", `listener threw: ${errorMessage(e)}`);
      }
    }
  }

  private reply(id: string | undefined, ev: ReplyEvent): void {
    const p = id !== undefined ? this.pending.get(id) : undefined;
    if (p && id !== undefined) {
      this.pending.delete(id);
      if (ev.type === "result" && !ev.ok) p.reject(new Error(ev.error));
      else p.resolve(ev);
    }
    this.emit(ev);
  }

  /** Emits `error`; `extra.code` (and its detail fields) let clients localize it (docs/PROTOCOL.md §19.6). */
  private fail(message: string, fatal: boolean, scope: ErrorScope, extra: ErrorDetails = {}): void {
    this.lastError = message;
    this.failCount += 1;
    this.recordError(message, fatal, scope, extra);
    this.emit({ type: "error", message, fatal, scope, ...extra });
    this.touch();
  }

  /** §30: a non-fatal `error` that informs about something already handled (`resume_not_found`): no `state.lastError`. */
  private notice(message: string, scope: ErrorScope, extra: ErrorDetails): void {
    this.recordError(message, false, scope, extra);
    this.emit({ type: "error", message, fatal: false, scope, ...extra });
  }

  /**
   * §30 (audit robustness-03): what the user saw stays in the chat's transcript; PR-browser errors are not the chat's. Never
   * into a git dir that is gone (a git failure's usual cause): the transcript store would create `.git/reviewgate/` anew.
   */
  private recordError(message: string, fatal: boolean, scope: ErrorScope, extra: ErrorDetails): void {
    if (scope === "pr" || (this.projectGitDir && !existsSync(this.projectGitDir))) return;
    // MARK: wave2 check-engine — §35.3: the row keeps the details its banner needs (tool / folder / branch, exit, chat, …).
    this.record(errorRow(message, fatal, scope, extra));
  }

  private log(level: LogLevel, message: string): void {
    this.logFn(level, message);
    this.emit({ type: "log", level, message });
  }
}

/** Records kept in memory per chat (the file keeps the same number). */
const MAX_CHECKPOINT_RECORDS_KEPT = 60;
/** MARK: wave4b w4b-follow — §39.4: how long `chat_move` waits for the stopped CLI's process to be gone before it gives up. */
const CHAT_MOVE_EXIT_WAIT_MS = 5000;
/** MARK: wave4b w4b-follow — §39.4: how long `chat_move` waits for the stopped turn's collection. */
const CHAT_MOVE_COLLECT_WAIT_MS = 120_000;

/** `git ls-files --cached --others --exclude-standard` (repo-relative, POSIX) for `list_files` (§23). */
async function listRepoFiles(cp: GitCheckpoint): Promise<string[]> {
  const out = await cp.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return out.stdout.toString("utf8").split("\0").filter(Boolean);
}

function emptyWorkbenches(): EngineSlices["workbenches"] {
  return { list: [], current: "", managedRoot: "" };
}

/** Session events that prove the CLI took the turn's message (no init-timeout resend after one of them). */
const TURN_OUTPUT_EVENTS = new Set<SessionEvent["type"]>(["session_info", "text_delta", "tool_use", "tool_result", "permission_request", "budget_event", "plan_exit", "agent_signal", "turn_end"]);

/** §29: the CLI's `crossSessionInbound` for a peer mode. */
function peerFlag(mode: PeerInboundMode): "hold" | "refuse" {
  return mode === "off" ? "refuse" : "hold";
}

// MARK: wave6 w6-statusline — §44.2
/** Commands after which the status line's stdin may say something else (it runs 300 ms after the last change). */
const STATUS_LINE_COMMANDS: ReadonlySet<EngineCommand["type"]> = new Set<EngineCommand["type"]>([
  "open_project", "switch_project", "close_project", "restart_session", "session_new", "session_open", "send", "set_model",
  "set_permission_mode", "plan_response", "rewind", "compact", "chat_move", "chat_receive", "cli_session_import",
]);

/** MARK: wave7 w7-state — §45.2: two HUD activity lines say the same. */
function sameActivity(a: HudActivity, b: HudActivity): boolean {
  return a.kind === b.kind && a.toolName === b.toolName && a.detail === b.detail;
}

/** Session events the CLI's own status line follows: a start, every main-agent answer, the usage windows, the models. */
function pokesStatusLine(ev: SessionEvent): boolean {
  switch (ev.type) {
    case "session_info":
    case "session_ready":
    case "turn_end":
    case "rate_limit_info":
    case "models_info":
      return true;
    case "tool_use":
      return ev.parentToolUseId === undefined;
    default:
      return false;
  }
}

/** `transcript_path`: the CLI's record of the chat under its real (symlink-resolved) cwd, else as spelled when only that exists. */
function statusTranscriptPath(cwd: string, sessionId: string, env: Record<string, string | undefined>): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // a cwd that does not resolve is taken as given
  }
  const own = cliSessionFile(real, sessionId, env);
  if (real === cwd || existsSync(own)) return own;
  const given = cliSessionFile(cwd, sessionId, env);
  return existsSync(given) ? given : own;
}

function emptyCommit(): EngineSlices["commit"] {
  return { lastCommit: null, identity: { name: null, email: null }, lastUserText: null };
}

/** MARK: wave3 engine-session — §36.5: the capabilities of a session start without a cache. */
function emptyCapabilities(): NonNullable<EngineSlices["session"]["capabilities"]> {
  return { slashCommands: [], skills: [], plugins: [], mcpServers: [] };
}

function emptySession(permissionMode: PermissionMode = "default", prePlanMode: PermissionMode | null = null): EngineSlices["session"] {
  // §36.7 / §36.8: null, never absent — a client tells a §36 engine apart before its first session starts.
  return { open: false, starting: false, sessionId: null, model: null, capabilities: null, capabilitiesCached: false, pendingPermission: null, pendingPermissions: [], rememberedAllows: [], permissionMode, pendingPlan: null, prePlanMode: permissionMode === "plan" ? prePlanMode : null, extensions: null, extensionsWaitingOn: null, cli: null };
}

function isPrCommand(type: EngineCommand["type"]): boolean {
  return type.startsWith("pr_") || type === "accounts" || type === "login_in_terminal";
}

/** `live` (§34.6, wave2 engine-why): `live_changes` / `live_diff` snapshot the worktree; never behind — or holding up — another lane. */
type Lane = "main" | "pr" | "side" | "sidectl" | "mcp" | "query" | "live" | "workbench" | "search"; // wave3 engine-flow: workbench (§36.12); code-browser: search (§47)

/**
 * PR commands run on their own lane (slow `gh`), side questions too (§21: `side_ask` / drafts must never wait behind
 * — or hold up — the main conversation; `side_cancel` / `side_close` / `side_list` on a lane of their own so they are
 * not stuck behind a draft), MCP commands on theirs (`claude mcp add` / status calls). `side_promote` with text
 * changes the main conversation / review: main lane.
 */
function laneOf(cmd: EngineCommand): Lane {
  if (cmd.type === "pr_ai_draft") return "side"; // §51: a read-only fork, never behind (or holding up) the PR lane
  if (isPrCommand(cmd.type)) return "pr";
  switch (cmd.type) {
    case "side_ask":
    case "side_promote_draft":
    case "commit_draft": // MARK: wave3 engine-flow — §36.11 / §36.13: read-only forks, never behind the main lane
    case "commit_split_draft": // §53
    case "prereview_start":
      return "side";
    case "prereview_cancel": // MARK: wave3 engine-flow — never stuck behind a start
    case "prereview_dismiss":
      return "sidectl";
    case "side_promote":
      return typeof cmd.text === "string" && cmd.text.trim() ? "main" : "side";
    case "side_list":
    case "side_close":
    case "side_cancel":
      return "sidectl";
    // Pure reads for the composer (§23, §24): never behind a running command of the main lane.
    case "list_files":
    case "attachment_get":
    case "permission_rules":
    // MARK: wave3 engine-agents — §36.1 a pure read too; §36.2 stop_agent never waits behind a send / interrupt (one quick
    // call, ≤ STOP_AGENT_TIMEOUT_MS).
    case "agent_report":
    case "stop_agent":
    case "task_stop": // §52: one quick call each, never behind a send
    case "task_background":
    case "task_output":
    case "cli_versions": // MARK: wave3 engine-session (§36.8, §36.9)
    case "cli_sessions":
    case "transcript_page": // MARK: wave4 w4-history — §38.3 pure reads of the session files
    case "transcript_search":
    case "commit_format": // MARK: wave4c w4c-commit — §41.1 a `git log` read for the commit sheet (pr_draft: the PR lane)
    case "history_file_lines": // MARK: wave4c w4c-review — §41.3 pure reads of pinned trees (pr_file_lines: the pr lane)
    case "file_image":
    case "brain": // MARK: wave5 w5-brain — §43.2 reads of the memory folder, never behind a turn
    case "brain_read":
    case "code_graph": // MARK: wave5 w5-graph — §43.3 a read; the build starts in the background and replies at once
    case "code_graph_build":
    case "status_line": // MARK: wave6 w6-statusline — §44.2 replies with what it shows; the command runs in the background
    case "project_file": // MARK: code-browser — §47 a read of one worktree file
      return "query";
    // MARK: code-browser — §47: a `git grep` (≤ 20 s) never holds up the composer's reads on the query lane.
    case "project_search":
      return "search";
    case "live_changes":
    case "live_diff":
      return "live";
    // MARK: wave3 engine-flow — §36.12: a create (fetch, copy, a setup of up to 10 minutes) never holds up the main lane;
    // the preview is a read for the sheet.
    case "workbench_create":
      return "workbench";
    case "workbench_preview":
      return "query";
    default:
      return cmd.type.startsWith("mcp_") ? "mcp" : "main";
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function firstLineOf(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    t.unref?.();
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function scopeOf(type: EngineCommand["type"]): ErrorScope {
  if (type.startsWith("pr_") || type === "accounts" || type === "login_in_terminal") return "pr";
  switch (type) {
    case "send":
    case "steer":
    case "request_changes":
    case "interrupt":
    case "set_model":
    case "compact":
    case "attachment_get":
    case "permission_response":
    case "forget_allows":
    case "permission_rules":
    case "set_permission_mode":
    case "plan_response":
    case "plan_follow": // MARK: wave4d w4d-plan (§42.1)
    case "restart_session":
    case "session_new":
    case "session_open":
    case "peer_accept":
    case "peer_dismiss":
    case "peer_set":
    // MARK: wave3 engine-agents
    case "agent_report":
    case "stop_agent":
    case "task_stop": // §52
    case "task_background":
    case "task_output":
    case "retry_extensions": // MARK: wave3 engine-session
    case "cli_sessions":
    case "cli_session_import":
    case "transcript_page": // MARK: wave4 w4-history (§38.3)
    case "transcript_search":
    case "chat_move": // MARK: wave4b w4b-follow (§39.4)
    case "chat_receive":
    case "brain": // MARK: wave5 w5-brain (§43.2)
    case "brain_read":
    case "status_line": // MARK: wave6 w6-statusline (§44.2)
      return "session";
    case "side_ask":
    case "side_list":
    case "side_close":
    case "side_cancel":
    case "side_promote":
    case "side_promote_draft":
    case "commit_draft": // MARK: wave3 engine-flow
    case "commit_split_draft": // §53
    case "pr_ai_draft": // §51
    case "prereview_start":
    case "prereview_cancel":
    case "prereview_dismiss":
    case "mcp_status":
    case "mcp_reconnect":
    case "mcp_toggle":
    case "mcp_add":
    case "mcp_remove":
    case "mcp_auth":
      return "session";
    case "open_project":
    case "switch_project":
    case "init_repo":
    case "reject":
    case "reject_all":
    case "reject_hunks":
    case "retry_collect":
    case "select_file":
    case "full_file":
    case "history_diff":
    case "branches":
    case "switch_branch":
    case "create_branch":
    case "workbench_list":
    case "workbench_create":
    case "workbench_remove":
    case "workbench_prune":
    case "commit":
    case "commit_hunks": // §53
    case "commit_series":
    case "push":
    case "refresh":
    case "rewind":
    case "list_files":
    case "live_changes":
    case "live_diff":
    case "retry_save": // MARK: wave4b w4b-bigturn (§39.1; both on the main lane: they wait for the persist chain)
    case "history_cleanup":
    case "reject_undo": // MARK: wave4c w4c-trust (§41.2: it writes the file back)
    case "commit_format": // MARK: wave4c w4c-commit (§41.1)
    case "history_file_lines": // MARK: wave4c w4c-review (§41.3)
    case "file_image":
    case "project_file": // MARK: code-browser (§47)
    case "project_search":
      return "git";
    default:
      return "engine";
  }
}

/** §53: one commit of a series as it will be made. */
type PlannedCommit = { message: string; whole: string[]; blobs: SeriesBlob[]; files: string[]; parts: { path: string; hunks: number[] | null }[] };

/** §52.1: how long a turn Claude started waits for the collection / revert in flight before it is taken. */
const AUTO_TURN_WAIT_MS = 60_000;
/** §52.1: how long it waits for a message sent meanwhile to go out (its turn is the one it joins). */
const AUTO_TURN_JOIN_MS = 5_000;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** MARK: wave4c w4c-trust — §41.2: a file rejected in one of the last this-many review rounds is never auto-accepted. */
const HISTORY_REJECT_ROUNDS = 20;

// ---------------------------------------------------------------- MARK: wave4d w4d-plan — §42.1

/** What the open chat said about its plan: its first request, the plan files its messages named (oldest first), Claude's list. */
type ChatPlanMemory = {
  /** `listed`: it has a numbered / checklist list (`messageSteps`), read once — the state asks on every emission. */
  first: { text: string; mentions: string[]; listed: boolean } | null;
  named: string[];
  /** The latest TodoWrite list. */
  todos: PlanStep[] | null;
  /** The Task tools' list (TaskCreate / TaskUpdate). */
  tasks: TaskItem[];
};

/** Rows of a chat read back for its plan sources. */
const PLAN_ROWS_SCAN = 5000;
/** Claude's to-do tools whose calls make its list. */
const PLAN_TOOLS: ReadonlySet<string> = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

function notePlanMessage(mem: ChatPlanMemory, text: string, mentions: readonly string[]): void {
  if (!mem.first && text.trim()) mem.first = { text: text.slice(0, 8000), mentions: [...mentions], listed: messageSteps(text.slice(0, 8000)) !== null };
  for (const f of planFilesNamed(text, mentions)) {
    const i = mem.named.indexOf(f);
    if (i >= 0) mem.named.splice(i, 1);
    mem.named.push(f);
  }
}

function notePlanTool(mem: ChatPlanMemory, name: string, input: unknown): void {
  if (name === "TodoWrite") {
    const steps = todoWriteSteps(input);
    if (steps) mem.todos = steps;
    return;
  }
  const tasks = applyTaskTool(mem.tasks, name, input);
  if (tasks) mem.tasks = tasks;
}

// MARK: wave5 w5-model — §43.4
const FAMILY_ORDER = ["opus", "sonnet", "haiku"];

/** `hud.autoModelCounts` with one more message for `family`: most first, then opus / sonnet / haiku. */
function countAutoModel(counts: readonly AutoModelCount[], family: string): AutoModelCount[] {
  const next = counts.map((c) => (c.family === family ? { family, count: c.count + 1 } : { ...c }));
  if (!next.some((c) => c.family === family)) next.push({ family, count: 1 });
  return next.sort((a, b) => b.count - a.count || FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family));
}
