/**
 * Renderer state (zustand): the last engine `ReviewState` plus the client-side pieces the Mac app's
 * `AppState` keeps — the transcript built from streaming events, selection, the per-`turnEndTree`
 * diff cache, logs (≤ 500), cached capabilities, the lock-conflict / dialogs UI state.
 */
import { create } from "zustand";
import { planHandoffLine, planReviewSupported } from "./planReview"; // MARK: wave4d w4d-plan
import { applyCodeGraphEvent } from "./codeGraph"; // MARK: wave5 w5-graph (§43.3)
import { applyStatusLineEvent } from "./statusLine"; // MARK: wave6 w6-statusline (§44.2)
import type {
  AttachmentRef,
  Budget,
  BudgetEventEvent,
  ChangedFileState,
  EngineCommand,
  EngineEvent,
  ErrorEvent,
  ErrorScope,
  FileDiff,
  FullFileContentEvent,
  PendingPlan,
  PermissionMode,
  PlanInto, // MARK: wave4d w4d-plan
  PermissionRequest,
  PRFileMeta,
  PRSummary,
  ReviewEvent,
  SendAttachment,
  ReviewHistoryEntry,
  ReviewState,
  SessionCapabilities,
  TestOutcome,
  ToolOutputEvent,
  TranscriptItem,
  TurnSummaryEvent,
  WorkbenchInfo,
} from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { engineRequest, refusalOf } from "./engineRequest";
import { errorEventText, presentationOf, refusalMessage } from "./errorCodes";
import { canAcceptAndSend, isDiffCollapsed } from "./friction";
import { t } from "./i18n";
import { adoptsRecord, EMPTY_SESSIONS, projectRootHash, sessionsOf } from "./sessions";
import { createSessionSlice, type SessionSlice } from "./storeSessions";
import { createSideSlice, type SideSlice } from "./storeSide";
import { createComposerSlice, seedAttachment, type ComposerSlice } from "./storeComposer";
import { planAfterFollowupFailure } from "./planLock";
import { changedPathsOf, runReject, type RejectCommand } from "./rejectFlow";
import { setAppearance } from "./theme";
import { notificationFor } from "./attention";
import { addPatternLine } from "./bashPattern";
// MARK: wave1 desktop-perms: §33 permission queue
import type { PermissionRulesEvent } from "@reviewgate/engine";
import type { AutoModelChoice } from "@reviewgate/engine"; // MARK: wave5 w5-model (§43.4)
import { canAllowBeyondOnce, canRemember, hasPermissionRow, isPermissionPending, markPermissionRow, pendingPermissionsOf, requestsWithoutRow, sessionWithoutRequest, sessionWithRequest } from "./permissionQueue";
import { importPatch, type ImportTarget } from "./terminalRules";
import { editQueued, EMPTY_QUEUE, enqueue, moveQueued, nextToSend, pauseReasonForTurnEnd, removeQueued, sendExtras, type QueuedExtras, type QueueState } from "./sendQueue";
// MARK: wave1 desktop-session
import { appendErrorRow, clearsOnReady, errorTone, factsOf, queueRetryDelayMs, queueStopOf, requeuesSend, type ErrorFacts, type QueueStop } from "./sessionErrors";
import { peerRowOf, type PeerRow } from "./peer";
import { createPeerSlice, type PeerSlice } from "./storePeer";
import { autoTurnRowOf, type AutoTurnRow } from "./background"; // MARK: §52
import { createBackgroundSlice, type BackgroundSlice } from "./storeBackground"; // MARK: §52
import { showToast } from "./toast";
import { keepQueueWhileLeaving } from "./sessionKeep"; // MARK: polish p-lifecycle (P4-composer-07)
import { confirmProjectChange, isOpenProject } from "./projectChange"; // MARK: polish p-lifecycle (P1-chrome-03)
// MARK: wave1 desktop-review
import type { RejectOutcome } from "./rejectFlow";
import { isExternalChange, planRejectAll, type GateNoticeKind, type GateNoticeMemory } from "./reviewGate";
import { createReviewGateSlice, type ReviewGateDialog } from "./storeReviewGate";
// MARK: wave3 desktop-flow — §36.11–36.14 (storeFlow.ts)
import type { PreReviewEffort, PreReviewFinding, PreReviewScope } from "@reviewgate/engine";
import type { CommitPlan } from "@reviewgate/engine";
import { createFlowSlice, type CommitHunksResult, type CommitSeriesResult, type CommitSplitResult, type FlowSettingsPatch, type FlowState, type PRFillResult, type PRSheetText, type PRWorkbenchRequest, type WorkbenchCreateRequest, type WorkbenchPreviewRequest } from "./storeFlow";
import type { PRCommentThread } from "./prClaude";
// MARK: wave2 check-clients
import { restoredErrorFacts } from "./sessionErrors";
import { beginSendAttempt, failsSend, sendTurnOver, type SendAttempt } from "./sendRecovery";
// MARK: wave2 desktop-flow — §34 review round 2
import type { ChangeTotals, DiffSince } from "@reviewgate/engine";
import { acceptBlockedReason, contentKey, diffTreeOf, displayOrder, hunkRejectBlockedReason, isTurnActive, nextPendingAfter, rangeCacheKey, rangeFor, rejectBlockedReason, stepPending, turnEndReviewText, type RangeChoice } from "./reviewRound";
import { createReviewRoundSlice, type LiveState, type LiveView } from "./storeReviewRound";
// MARK: wave2 desktop-diff — §34.8 where a tool row's rationale came from (fileWhy.ts)
import { rationaleMetaOf, type RationaleMeta } from "./fileWhy";
// MARK: wave3 desktop-agents — §36.1–36.3 a tool row's continuation / usage / agentId / stoppedBy (agentMeta.ts)
import { agentResultMetaOf, agentUseMetaOf, type AgentResultMeta, type AgentUseMeta } from "./agentMeta";
// MARK: wave3 desktop-session — §36.5–36.9
import { freshCapabilities } from "./slashCommands";
import { createSessionToolsSlice, type SessionToolsSlice } from "./storeSessionTools";
// MARK: wave4 w4-safety — "Force restart" (storeSafety.ts), the stop reason of a turn's notification (workSafety.ts)
import { createSafetySlice, type SafetySlice } from "./storeSafety";
import { TurnStopTracker } from "./workSafety";
import { createLongWorkSlice, type LongWorkSlice } from "./storeLongWork"; // MARK: wave4 w4-longwork
import { createAutoModeSlice, type AutoModeSlice } from "./storeAutoMode"; // MARK: wave4b w4b-auto
import { hookDeniedOf, longWorkRowFacts, RESUME_DELAY_MS } from "./longWork"; // MARK: wave4 w4-longwork
import { stopReasonWords } from "./stopWords"; // MARK: wave4b w4b-check4 (§40.1)
import { compactedField, type CompactedRowFacts } from "./commitFormat"; // MARK: wave4c w4c-commit (§41.1)
import type { PRCreateMeta } from "@reviewgate/engine";
// MARK: wave4 w4-history — §38.3 older rows, restored summary cards (transcriptHistory.ts)
import { pagingOnRestore, summaryOfRow } from "./transcriptHistory";
import type { FileWhy } from "@reviewgate/engine";
// MARK: wave4b w4b-tabs — §39.2 the engine's exploration mark on tool rows (exploreFold.ts)
import { exploreMetaOf, type ExploreMeta } from "./exploreFold";
import { insertIntoComposer } from "./composerBridge"; // MARK: §49 a task the session could not take goes into the composer
import { stampRestored, stampRow } from "./rowTimes"; // MARK: polish p-foundation (P3-transcript-25)
// MARK: polish p-foundation — the polish lanes' own slices (their state goes there, not here)
import { createPolishWindowSlice, type PolishWindowSlice } from "./storePolishWindow";
import { createPolishTranscriptSlice, type PolishTranscriptSlice } from "./storePolishTranscript";
import { createPolishDiffSlice, type PolishDiffSlice } from "./storePolishDiff";
import { createPolishPrSlice, type PolishPrSlice } from "./storePolishPr";

export { isReviewLocked } from "./planLock";


// ---------------------------------------------------------------- transcript

export type ChatItem =
  /** `turn`: the engine's turn number (§26 rewind target); `mentions` / `attachments`: §23 / §24. */
  | { kind: "user"; id: number; text: string; turn?: number; mentions?: string[]; attachments?: AttachmentRef[]; /** MARK: wave5 w5-model — §43.4 */ autoModel?: AutoModelChoice; /** §50: sent into the running turn ("바로 보내기") */ steered?: true }
  /** `unprompted`: written in a turn Claude Code ran on its own, outside any request (docs/PROTOCOL.md §18). */
  | { kind: "assistant"; id: number; text: string; streaming: boolean; unprompted?: true }
  | { kind: "toolUse"; id: number; toolUseId: string; name: string; file?: string; input: Record<string, unknown>; parentToolUseId?: string; rationale?: string } & RationaleMeta & AgentUseMeta & ExploreMeta /* MARK: wave4b w4b-tabs (§39.2) */
  | { kind: "toolResult"; id: number; toolUseId: string; isError: boolean; preview: string; parentToolUseId?: string; truncated?: boolean; testOutcome?: TestOutcome; /** r1x §38.2 */ hookDenied?: { hook: string; reason: string } } & AgentResultMeta
  | { kind: "permission"; id: number; request: PermissionRequest; allowed: boolean | null; answers?: Record<string, string> }
  | { kind: "budget"; id: number; event: BudgetEventEvent }
  /**
   * `facts` (§30 / §33.4): code, the CLI's words, exit code, tool / folder / branch; `count` / `lastAt`: repeats of the same
   * failure merged into this row ("×N · last time", src/renderer/sessionErrors.ts) — restored rows alike.
   */
  | { kind: "error"; id: number; message: string; fatal: boolean; facts?: ErrorFacts; count?: number; lastAt?: number; scope?: ErrorScope | "client" }
  /** §29: a message from another Claude session, delivered (its turn's first row) or dropped. */
  | PeerRow
  /** §52: a turn Claude started itself (a background command ended, /loop, /goal) — its first row. */
  | AutoTurnRow
  | { kind: "turnEnd"; id: number; summary: string; compacted?: CompactedRowFacts /* wave4c w4c-commit (§41.1) */ }
  /** `turn_summary` (docs/PROTOCOL.md §15): what the turn changed, why, the commands it ran, plan vs actual. */
  | { kind: "turnSummary"; id: number; summary: TurnSummaryEvent }
  | { kind: "planProposed"; id: number; path: string | null; plan: string }
  | { kind: "planApproved"; id: number; mode: PermissionMode; path: string | null; line?: string /* MARK: wave4d w4d-plan (§42.1: where it went) */ }
  | { kind: "restoredDivider"; id: number };

let nextId = 1;
/** A new row id — stamped now in the row-time table (polish p-foundation, P3-transcript-25: rowTimes.ts). */
const uid = (): number => {
  const id = nextId++;
  stampRow(id);
  return id;
};
/** r1x — §38.2: a tool_result's `hookDenied` (event or row) as the item keeps it. */
const hookDeniedField = (ev: { hookDenied?: unknown }): { hookDenied?: { hook: string; reason: string } } => {
  const d = hookDeniedOf(ev);
  return d ? { hookDenied: d } : {};
};

/** Shared by the live `turn_end` event and restored `TranscriptItem` rows of the same kind. */
function turnEndSummary(ev: { files: number; added: number; deleted: number; stopReason: string; usage: { costUsd: number; durationMs: number }; external?: number; merged?: true; review?: ChangeTotals }): string {
  // wave2 desktop-flow — §34.3: `files` / `added` / `deleted` are this turn's; a merged turn adds the whole review's totals.
  const review = turnEndReviewText(ev);
  return (
    t("Changed {0} file(s) (+{1} −{2}) · {3}", ev.files, ev.added, ev.deleted, stopReasonWords(ev.stopReason)) + // words: wave4b w4b-check4 (§40.1)
    ` · $${ev.usage.costUsd.toFixed(4)} · ${(ev.usage.durationMs / 1000).toFixed(1)}s` +
    // wave1 desktop-review — §31 `turn_end.external`: how many of the files nothing of Claude's explains.
    (typeof ev.external === "number" && ev.external > 0 ? ` · ${t("{0} outside change(s) included", ev.external)}` : "") +
    (review ? ` · ${review}` : "")
  );
}

/** `transcript_restore.items` (docs/PROTOCOL.md §8) → `ChatItem`s, in the same shapes `handleEvent` produces live. */
function transcriptItemsToChatItems(items: TranscriptItem[], budget: Budget): ChatItem[] {
  let out: ChatItem[] = [];
  for (const item of items) {
    const from = out.length; // polish p-foundation (P3-transcript-25): the rows this item becomes get its time
    switch (item.kind) {
      case "user_message":
        out.push(userItem(item.text, item.turn, item.mentions, item.attachments, item.autoModel, item.steered));
        break;
      case "assistant_text":
        out.push({ kind: "assistant", id: uid(), text: item.text, streaming: false, ...(item.unprompted ? { unprompted: true as const } : {}) });
        break;
      case "tool_use":
        out.push({ kind: "toolUse", id: uid(), toolUseId: item.id, name: item.name, file: item.file, input: item.input, parentToolUseId: item.parentToolUseId, rationale: item.rationale, ...rationaleMetaOf(item), ...agentUseMetaOf(item), ...exploreMetaOf(item) });
        break;
      case "tool_result":
        out.push({ kind: "toolResult", id: uid(), toolUseId: item.toolUseId, isError: item.isError, preview: item.preview, parentToolUseId: item.parentToolUseId, truncated: item.truncated, testOutcome: item.testOutcome, ...agentResultMetaOf(item), ...hookDeniedField(item) });
        break;
      case "permission":
        // The persisted row only keeps the decision, not the original `input`; restored cards show it empty.
        out.push({ kind: "permission", id: uid(), request: { requestId: item.requestId, toolName: item.toolName, input: {}, file: item.file }, allowed: item.allow });
        break;
      case "budget_event":
        // `budget` itself was not persisted per-row; the current one is a reasonable approximation for display.
        out.push({ kind: "budget", id: uid(), event: { type: "budget_event", kind: item.event, toolName: item.toolName, file: item.file, files: item.files, lines: item.lines, budget } });
        break;
      case "turn_end":
        out.push({ kind: "turnEnd", id: uid(), summary: turnEndSummary(item), ...compactedField(item.usage) });
        break;
      // MARK: wave1 desktop-session — §30 errors the user saw (same words and merging as live ones), §29 peer messages
      case "error": {
        // §35.3: the row's own details (older rows: read back from the engine's words — restoredErrorFacts), and the reset
        // time / HTTP status its sentence names.
        const facts = restoredErrorFacts(item);
        const at = Date.parse(item.at);
        out = appendErrorRow(out, {
          kind: "error",
          id: uid(),
          message: errorEventText({ code: item.code, message: item.message, detail: item.detail, toolName: facts.toolName, path: facts.path, branch: facts.branch, ...(item.resetAt ? { resetAt: item.resetAt } : {}), ...(typeof item.status === "number" ? { status: item.status } : {}), ...longWorkRowFacts(item) }),
          fatal: item.fatal,
          scope: item.scope,
          ...(Object.keys(facts).length > 0 ? { facts } : {}),
          ...(Number.isFinite(at) ? { lastAt: at } : {}),
        }).items;
        break;
      }
      case "peer_message": {
        const row = peerRowOf(item, uid());
        if (row) out.push(row);
        break;
      }
      // MARK: §52 — a turn Claude started itself: its first row (once per turn)
      case "auto_turn": {
        if (!out.some((r) => r.kind === "autoTurn" && r.turn === item.turn)) {
          const row = autoTurnRowOf(item, uid());
          if (row) out.push(row);
        }
        break;
      }
      // MARK: wave4 w4-history — §38.3: the turn summary card comes back with the chat.
      case "turn_summary": {
        const summary = summaryOfRow(item);
        if (summary) out.push({ kind: "turnSummary", id: uid(), summary });
        break;
      }
    }
    stampRestored(out, from, item.at);
  }
  return out;
}

/** A user row with only the extras it has (restored rows and live `user_message` events alike). */
function userItem(text: string, turn: number | undefined, mentions: string[] | undefined, attachments: AttachmentRef[] | undefined, autoModel?: AutoModelChoice, steered?: boolean): ChatItem {
  return {
    kind: "user",
    id: uid(),
    text,
    ...(typeof turn === "number" ? { turn } : {}),
    ...(mentions && mentions.length > 0 ? { mentions } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(autoModel && typeof autoModel === "object" && typeof autoModel.reason === "string" ? { autoModel } : {}), // MARK: wave5 w5-model (§43.4)
    ...(steered === true ? { steered: true as const } : {}), // §50: the same turn's number as the message that started it
  };
}

/** `file_diff.diff` plus the engine's `truncated` flag (cut at FILE_DIFF_MAX_LINES; the full file is still on disk). */
export type ReviewDiff = FileDiff & { truncated: boolean; endTree?: string } & ReviewDiffRange;
/**
 * wave2 desktop-flow — §34.1 / §34.2: the range the diff shows (absent = the whole review), its old side (`baseTree`, what
 * `reject_hunks.expectedBaseTree` echoes) and `stale` (served from the held B while a turn runs: read-only).
 */
export type ReviewDiffRange = { since?: DiffSince; baseTree?: string; stale?: true };

/** Non-modal error banner (App): `error` events keep their engine `scope`; client-side failures are "client". */
export type ErrorBanner = {
  message: string;
  scope: ErrorScope | "client";
  fatal: boolean;
  /** §19.6 code of the `error` event / refusal — drives the banner's actions (login, restart, settings). */
  code?: string;
  /** The engine's own (English) text when `message` is the localized one — the banner's tooltip. */
  detail?: string;
  /** §22 `mcp_auth_required` / `mcp_failed`: the MCP server (the banner's sign-in / details action). */
  server?: string;
  // MARK: wave1 desktop-session
  /** §30 / §33.4: what the error carries besides its text (the session banner's second line and actions). */
  facts?: ErrorFacts;
  /** Repeats merged into one ("×N"); a crash seen twice puts New chat first (§2.6). */
  count?: number;
  /** epoch ms of the last occurrence. */
  lastAt?: number;
};

/** `api_retrying` (§19.6): the CLI retries by itself — a HUD chip until progress or the turn's end. */
export type RetryingInfo = { attempt?: number; maxRetries?: number; retryDelayMs?: number; status?: number | null; message: string; at: number };
/** `cli_start_slow` (§19.6): a non-sticky hint; `at` is when it arrived. */
export type StartSlowHint = { message: string; at: number };

export type Dialog =
  | { kind: "gitInit" }
  | { kind: "lockConflict" }
  /** `branch`: prefilled (§33.4 `worktree_blocked` → "워크벤치로 열기"). */
  | { kind: "newWorkbench"; branch?: string; planMode?: PermissionMode /* MARK: wave4d w4d-plan (§42.1: hand the pending plan to it) */
      /** MARK: §49 "Run as Task": the sheet starts the task in the new workbench (the composer's text; "" from the menus). */
      task?: string }
  | { kind: "newBranch" }
  | { kind: "createPR" }
  | { kind: "settings"; tab?: "general" | "accounts" | "permissions" }
  | { kind: "switchProject"; path: string }
  | { kind: "rejectAll" }
  // MARK: wave1 desktop-review — rejectExternal / staleReview / finishReview (storeReviewGate.ts)
  | ReviewGateDialog
  // MARK: wave3 desktop-agents — §36.1 the agent details sheet (components/agents/AgentDetailSheet.tsx)
  | { kind: "agentDetail"; toolUseId: string; focus?: "report" | "instructions" /* MARK: wave4d w4d-agents2: the card menu's 보고서 / 지시 보기 */ }
  /** §19.1: the reject was refused because the user edited `paths` since the review — revert anyway (force)? */
  | { kind: "forceReject"; paths: string[]; all: boolean }
  | { kind: "acceptAll" }
  | { kind: "removeWorkbench"; wb: WorkbenchInfo; refusal: string | null }
  | { kind: "submitReview" }
  | { kind: "commit" }
  /** `highlight`: the chat to point at (§30 resume notice → "이전 대화 보기"). */
  | { kind: "history"; highlight?: string }
  | { kind: "extensions" }
  /** §27: "대화 압축" with an optional focus. */
  | { kind: "compact" }
  /** §26: "이 시점으로 되돌리기" for the user message of `turn`. */
  | { kind: "rewind"; turn: number }
  // MARK: wave3 desktop-flow — §36.14 the New Workbench sheet on a PR's head ("Open as workbench")
  | { kind: "newWorkbenchFromPr"; pr: PRWorkbenchRequest }
  // MARK: wave4 w4-safety — daily-11: the reject shortcut asks first (components/dialogs/SafetyDialogs.tsx)
  | { kind: "rejectOne"; path: string }
  // MARK: wave4d w4d-windows — polish-08: Help › Keyboard Shortcuts (components/dialogs/ShortcutsDialog.tsx)
  | { kind: "shortcuts" };

/** Sidebar tab: the live review, the PR browser, or the review history (docs/PROTOCOL.md §14). */
export type Tab = "changes" | "prs" | "history";

/**
 * The review-history list (`review_history`), fetched when the History tab opens. `current` (wave2 desktop-flow, §34.4):
 * the round in progress (`inProgress: true`, never in `entries`); null without one or from an engine before §34.
 */
export type ReviewHistoryState = { entries: ReviewHistoryEntry[]; all: boolean; loading: boolean; error: string | null; loadedAt: number; current?: ReviewHistoryEntry | null };
/** A past file shown read-only in the diff pane (`history_diff`); null = the live review. */
export type HistoryView = { entry: ReviewHistoryEntry; path: string; diff: ReviewDiff | null; loading: boolean; error: string | null; /** MARK: wave4 w4-history — §38.3 why the round changed it */ why?: FileWhy | null };

// ---------------------------------------------------------------- commit (docs/M12-COMMIT.md)

/** Client-side mirror of `state.commit`; read through `commitOf` so an older engine (no slice) still works. */
export type LastCommit = { sha: string; shortSha: string; message: string; branch: string | null; pushed: boolean; pushError: string | null; files: string[]; at: string };
export type CommitState = {
  lastCommit: LastCommit | null;
  canCommit: boolean;
  acceptedPaths: string[];
  identity: { name: string | null; email: string | null };
  suggestedMessage?: string;
};
export const EMPTY_COMMIT: CommitState = { lastCommit: null, canCommit: false, acceptedPaths: [], identity: { name: null, email: null }, suggestedMessage: "" };
export const commitOf = (s: ReviewState): CommitState => (s as ReviewState & { commit?: CommitState }).commit ?? EMPTY_COMMIT;

export const EMPTY_STATE = {
  seq: 0,
  project: null,
  gitInit: null,
  session: { open: false, starting: false, sessionId: null, model: null, capabilities: null, capabilitiesCached: false, pendingPermission: null, canRestart: false, rememberedAllows: [], permissionMode: "default", pendingPlan: null },
  toolchain: { claude: null, gh: null, git: null, claudeVersion: null, ghVersion: null },
  gate: {
    phase: "idle",
    canSend: false,
    canRequestChanges: false,
    blockedReason: "no_session",
    collectError: null,
    pendingCount: 0,
    changesRequestedCount: 0,
    isRequestingChanges: false,
    turnStartTree: null,
    turnEndTree: null,
    lastReviewSummary: null,
    changedOutside: [],
    ignoredTouched: [],
    filteredByPattern: [],
    restored: false,
    reviewSummary: { files: 0, added: 0, deleted: 0 },
  },
  changedFiles: [],
  reviewNotes: [],
  budget: { maxFiles: 0, maxLines: 0 }, // §54: no change budget until Settings turns the limit on
  budgetUsage: { files: 0, lines: 0, denied: false },
  hud: { contextTokens: 0, contextWindow: null, sessionCostUSD: 0, turnCount: 0, lastTurnMs: 0, activity: { kind: "idle" }, subagentDepth: 0, agents: [], turnStartedAt: null },
  branches: { list: [], isWorktreeDirty: false, switchBlocker: null },
  pr: {
    host: "",
    mine: [],
    reviewRequested: [],
    selectedSummary: null,
    selected: null,
    files: [],
    comments: [],
    reviews: [],
    draftComments: [],
    accounts: [],
    isLoading: false,
    isSubmitting: false,
    errorText: null,
    lastSubmitResult: null,
    lastCreatedPR: null,
  },
  lastError: null,
  workbenches: { list: [], current: "", managedRoot: "" },
  lockConflict: null,
  commit: EMPTY_COMMIT,
  sessions: EMPTY_SESSIONS,
} as ReviewState;

export type Store = SessionSlice & SideSlice & ComposerSlice & PeerSlice & BackgroundSlice & SessionToolsSlice & SafetySlice & LongWorkSlice & AutoModeSlice & PolishWindowSlice & PolishTranscriptSlice & PolishDiffSlice & PolishPrSlice & {
  state: ReviewState;
  transcript: ChatItem[];
  logs: string[];
  lastError: string | null;
  errorBanner: ErrorBanner | null;
  settings: AppSettings | null;
  cachedCapabilities: SessionCapabilities | null;
  tab: Tab;
  sidebarVisible: boolean;
  dialog: Dialog | null;
  /** The folder whose `open_project` was refused with `locked_by_other_session` (drives the takeover dialog). */
  lockedProjectPath: string | null;
  refusedLockPid: number | null;
  // review selection + caches
  selectedPath: string | null;
  selectedDiff: ReviewDiff | null;
  diffLoading: boolean;
  /** Per B (`reviewEndTree`); keyed by `rangeCacheKey(path, since)` — the bare path for the whole review. */
  diffCache: Record<string, ReviewDiff>;
  fullFileCache: Record<string, FullFileContentEvent>;
  /**
   * Files whose diff was shown in this review (reset when `turnStartTree` changes, never because B moved — §34.5): path →
   * the content key seen (`contentKey`: the blob, "deleted", or "" from an engine without `blob`). A key that differs from
   * the file's current one is "본 뒤 바뀜" — the "not yet viewed" count of Accept all.
   */
  viewedPaths: Record<string, string>;
  // PR browser selection + cache
  prSelectedFilename: string | null;
  prSelectedDiff: ReviewDiff | null;
  prDiffCache: Record<string, ReviewDiff>;
  prDiffLoading: boolean;
  /** `submittedAt` of the dismissed submit banner. */
  dismissedSubmitAt: string | null;
  dismissedPRURL: string | null;
  /** `at` of the dismissed commit banner. */
  dismissedCommitAt: string | null;
  /** True once this project view has applied its `transcript_restore` (the engine may resend it). */
  transcriptRestored: boolean;
  /** The transcript row to scroll to and flash (diff → cause); `nonce` re-triggers the same id. */
  transcriptFocus: { toolUseId: string; nonce: number } | null;
  /** The agent activity panel (AgentPanel) is shown — remembered across launches (localStorage). */
  agentPanelOpen: boolean;
  // MARK: wave5 w5-board
  /** §43.1: the agent board (components/board/BoardDialog.tsx) is open over the window. */
  boardOpen: boolean;
  /** §14 review history (History tab) and the past diff shown in place of the live one. */
  reviewHistory: ReviewHistoryState;
  historyView: HistoryView | null;
  /** `fallback.at` of the dismissed "started without extensions" banner (§16). */
  dismissedFallbackAt: string | null;
  /** §19.6 `api_retrying`: the HUD chip "재시도 중 (2/10)…", cleared on progress / turn end. */
  retrying: RetryingInfo | null;
  /** §19.6 `cli_start_slow`: hint banner, cleared once the session initializes (or dismissed / timed out). */
  startSlowHint: StartSlowHint | null;
  /** A `plan_response` is waiting for its `result` (the plan card is locked meanwhile). */
  planAnswering: boolean;
  /** Why the last plan answer did not go through (a refusal or §19.5 `plan_followup_failed`) — shown on the plan card. */
  planNotice: string | null;
  /** The plan being answered — the card comes back from it after `plan_followup_failed` (§19.5). */
  answeredPlan: PendingPlan | null;
  /** Messages typed while Claude works, sent in order once a plain Send is allowed (src/renderer/sendQueue.ts). */
  queue: QueueState;

  // engine plumbing
  handleEvent(ev: EngineEvent): void;
  fire(cmd: EngineCommand): void;
  run(cmd: EngineCommand, opts?: { reportFailure?: boolean; fatal?: boolean }): Promise<boolean>;
  settle(): Promise<void>;
  loadSettings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;

  // lifecycle
  openProject(path: string, takeover?: boolean): Promise<void>;
  switchProject(path: string): Promise<void>;
  requestSwitch(path: string): void;
  chooseAndOpen(mode?: "open" | "switch"): Promise<void>;
  takeOver(): Promise<void>;
  cancelTakeover(): void;
  closeProject(): Promise<void>;
  initRepository(): Promise<void>;
  cancelGitInit(): void;
  /** `restart_session` (docs/PROTOCOL.md §8): new Claude session for the open project, gate untouched. */
  restartSession(): Promise<void>;

  // chat
  /** `acceptPending` (docs/M16-FRICTION.md): accept the pending files first, then send — "Accept N & Send". */
  send(text: string, opts?: { acceptPending?: boolean } & QueuedExtras): void;
  interrupt(): void;
  /** Queues `text` (front: before the others); it goes out when a plain Send would be allowed. */
  enqueueMessage(text: string, front?: boolean, extras?: QueuedExtras): void;
  editQueuedMessage(id: number, text: string): void;
  removeQueuedMessage(id: number): void;
  moveQueuedMessage(id: number, dir: -1 | 1): void;
  resumeQueue(): void;
  clearQueue(): void;
  /**
   * "Stop & send" (§28): `interrupt` (its reply waits for the turn's end and collection), then `send` right behind it on
   * the engine's main lane. A refused send goes back to the front of the queue, paused with the reason.
   */
  interruptAndSend(text: string, extras?: QueuedExtras): void;
  /**
   * §50 "바로 보내기" (Mac `AppState.steer`): `steer` puts the message into the turn that runs — Claude reads it once the
   * current step is done; its changes join this turn's review. Any refusal (the turn ended meanwhile, its review is being
   * collected, another session's turn) queues it instead, so it is never lost. Resolves once it went in or was queued.
   */
  steer(text: string, extras?: Pick<QueuedExtras, "mentions">): Promise<void>;
  /**
   * "Always allow in this project" on the card of `requestId`: saves `pattern` (a Bash pattern or one of the request's
   * §33.6 `allowPatterns`) to this project's allow patterns, then allows that request. Never for a reason / SendMessage card.
   */
  allowAlwaysInProject(requestId: string, pattern: string): Promise<void>;
  /** MARK: r2-skills-side — §33.6 (M21) "모든 프로젝트에서 허용": the pattern joins the global list, then the card is allowed. */
  allowAlwaysEverywhere(requestId: string, pattern: string): Promise<void>;
  /**
   * §33.1: answers exactly the request `requestId` (its own card), wherever it sits in the queue. `remember` (M16): auto-allow
   * the same tool + command prefix for the rest of the session — never sent for a reason / SendMessage card.
   */
  respondPermission(requestId: string, allow: boolean, message?: string, updatedInput?: Record<string, unknown>, remember?: boolean,
    /** r2-chats-cards M25 (§33.10), with `allow: false`: "건너뛰고 계속" (`skip`) or "거부하고 멈추기" (`interrupt`). */
    deny?: { skip?: boolean; interrupt?: boolean }): void;
  /** MARK: wave4b w4b-follow — §39.4 "허용하고 따라가기": allows a worktree-creating card; the chat moves there once it ran (`followUp` sent there). */
  allowAndFollow(requestId: string, followUp?: string): void;
  /** `forget_allows` (M16): clears `session.rememberedAllows`. */
  forgetAllows(): void;
  // MARK: wave1 desktop-perms — §33 permission queue
  /** §33.8 `permission_rules` (query lane): the user's Claude Code allow rules and what the app does with them, or the refusal in words. */
  fetchPermissionRules(): Promise<{ ok: true; rules: PermissionRulesEvent } | { ok: false; message: string }>;
  /** §33.8 import: appends `patterns` to the global or this project's allow patterns → how many were new (null: nothing saved). */
  importAllowPatterns(patterns: string[], target: ImportTarget): Promise<number | null>;
  /**
   * M20 `set_permission_mode`: switches the live session's mode → null, or the refusal code (`session_busy`, `no_session`,
   * `invalid_mode`). `force` (wave6 w6-terminal, §44.1): also when the snapshot already shows `mode` — another switch may
   * still be on its way (Shift+Tab pressed again before the engine's state came back). `busyWaits` (§39.5): a `session_busy`
   * refusal shows no banner — the caller makes the pick wait for the turn's end.
   */
  setPermissionMode(mode: PermissionMode, opts?: { force?: boolean; busyWaits?: boolean }): Promise<string | null>;
  /** M20 `plan_response{approve:true}`: leaves plan mode in `mode` (default `"default"`) and lets the engine send the follow-up. */
  approvePlan(mode?: PermissionMode): Promise<string | null>;
  /** M20 `plan_response{approve:false}`: stays in plan mode with an optional note for the next planning turn. */
  keepPlanning(message?: string): Promise<string | null>;
  // MARK: wave4d w4d-plan — §42.1
  /** `plan_response{approve, mode, into, path?}`: implement in a fresh chat here (`new_chat`) or in the workbench at `path`. */
  approvePlanInto(mode: PermissionMode, into: PlanInto, path?: string): Promise<string | null>;
  /** `plan_follow{path}`: the plan file this chat's "plan vs actual" follows (null: the automatic sources). */
  followPlan(path: string | null): Promise<string | null>;
  /** AskUserQuestion: allow with `updatedInput.{questions,answers}` per the SDK's expected reply shape. */
  /** r2-chats-cards M08b: `annotations` (questionNotes.ts) go out as `updatedInput.annotations` when there are any. */
  answerQuestions(requestId: string, answers: Record<string, string>, annotations?: Record<string, { notes?: string; preview?: string }>): void;
  requestChanges(extra: string | null): void;

  // review
  selectFile(path: string | null): void;
  /** Chat → diff: selects `path` in the review and re-opens a diff pane the user had collapsed. */
  revealFile(path: string): void;
  /** Diff → cause: scrolls the transcript to the tool row `toolUseId` (expanding its agent groups) and flashes it. */
  revealToolUse(toolUseId: string): void;
  /** `tool_output`: the kept full output of a Bash result (null when the engine kept nothing). */
  toolOutput(toolUseId: string): Promise<ToolOutputEvent>;
  toggleAgentPanel(open?: boolean): void;
  // MARK: wave5 w5-board
  /** §43.1: opens / closes the agent board (View › Agent Board, Ctrl+Alt+B, the agent panel's board button). */
  toggleBoard(open?: boolean): void;
  /** §17 `reject_hunks`: reverts the given hunks of a pending file → null, or the refusal code (also in the banner). */
  rejectHunks(path: string, hunks: number[]): Promise<string | null>;
  /** §14 `review_history` (this chat's rounds, or every chat's with `all`). */
  loadReviewHistory(all?: boolean): Promise<void>;
  /** §14 `history_diff`: shows a past file's diff read-only in the diff pane. */
  openHistoryDiff(entry: ReviewHistoryEntry, path: string): void;
  /** Leaves the read-only history view (back to the live review). */
  closeHistoryView(): void;
  /** §16: re-opens the project so the next session tries the user's extensions again (the fallback sticks until then). */
  retryWithExtensions(): Promise<void>;
  /** ⌘] / ⌘[: selects the next / previous pending file after the current selection (wraps). */
  selectPending(dir: 1 | -1): void;
  accept(path: string): void;
  reject(path: string): void;
  acceptAll(): void;
  /** §31.2: Claude's pending changes only; `includeExternal` also reverts the outside ones, after a second confirm. */
  rejectAll(includeExternal?: boolean): void;
  // MARK: wave1 desktop-review — §31–32 review provenance (storeReviewGate.ts)
  /** Gate banners the user closed (src/renderer/reviewGate.ts `GateNoticeMemory`). */
  gateNotices: GateNoticeMemory;
  /** Hides a gate banner until its next occurrence (the engine clears it, or the next turn starts). */
  dismissGateNotice(kind: GateNoticeKind): void;
  /** Hides the "another Claude session" banner for the sessions it lists now (re-sent on every send). */
  dismissConcurrentClaude(): void;
  /** §31.5 `finish_review`: empties the review list and its notes, no file touched → null, or the refusal (also in the banner). */
  finishReview(): Promise<string | null>;
  /** §31.5 `keep_review`: dismisses `gate.stale` ("이어서 리뷰") → null, or the refusal. */
  keepReview(): Promise<string | null>;
  /** §32.3: adds the files the snapshots could not read to the ignore patterns (settings, every project). */
  ignoreSkippedFiles(): Promise<void>;
  /** Selects the first pending file changed outside the app (banner "앱 밖 변경 보기"). */
  revealExternalChanges(): void;
  /** §31.2: the "revert outside changes too?" confirm listing `paths` → true for "revert them". */
  confirmRejectExternal(paths: string[], all: boolean): Promise<boolean>;
  /** Answers that confirm (closing it any other way counts as "keep them"). */
  answerRejectExternal(revert: boolean): void;
  /** Answers the `forceReject` confirm (§19.1): true re-sends the reject with `force: true`, false keeps the edits. */
  answerForceReject(revert: boolean): void;
  // MARK: wave2 desktop-flow — §34 review round 2 (storeReviewRound.ts)
  /** comp-10: the Changes list puts risky files first (localStorage `rg.changes.riskFirst`); ⌘] / ⌘[ and the move after accept follow the list. */
  riskFirst: boolean;
  setRiskFirst(value: boolean): void;
  /** §34.1: the range the selected file's diff shows (`select_file` / `full_file` `since`). */
  diffSince: DiffSince;
  /** The range each file's diff was opened or picked in, until that file's content changes (then its default applies again). */
  rangeChoice: Record<string, RangeChoice>;
  /** Shows the selected file's diff since `since` (only ranges `availableRanges` offers). */
  setDiffSince(since: DiffSince): void;
  /** Why the selected file has no diff to show now (a turn runs and there is no review B to read it from) — instead of a spinner. */
  diffUnavailable: string | null;
  /** §34.6: the running turn's changes so far ("진행 중 변경"); empty between turns. */
  live: LiveState;
  /** The "진행 중 변경" section of the Changes list is expanded. */
  liveOpen: boolean;
  setLiveOpen(open: boolean): void;
  /** §34.6: a live file's diff shown read-only in place of the review diff; null = the review. */
  liveView: LiveView | null;
  /** `live_changes` now (while a turn runs). */
  refreshLive(): Promise<void>;
  /** `live_diff`: shows the running turn's change of `path` read-only. */
  openLiveDiff(path: string): void;
  closeLiveView(): void;
  /** HUD "진행 중" → the Changes tab's "진행 중 변경" section (expanded, refreshed). */
  revealLiveChanges(): void;
  /** Forgets the slice's per-project state (a project switch / close). */
  resetReviewRound(): void;
  retryCollect(): void;
  /** `since` (§34.1, default the whole review) selects the range `changedNewLines` / `oldText` describe. */
  fullFile(path: string, since?: DiffSince): Promise<FullFileContentEvent>;
  addNote(path: string, line: number | null, side: "old" | "new", excerpt: string, body: string): void;
  removeNote(id: string): void;

  // branches / workbenches / PR create
  refreshBranches(): Promise<void>;
  switchBranch(name: string): Promise<void>;
  createBranch(name: string): Promise<void>;
  refreshWorkbenches(): Promise<void>;
  removeWorkbench(path: string, force: boolean): Promise<string | null>;
  pruneWorkbenches(): Promise<void>;
  createPR(base: string, title: string | null, body: string | null, draft: boolean, meta?: PRCreateMeta /* wave4c w4c-commit (§41.1) */): Promise<string | null>;
  /** `commit` → resolves null on `committed`, else the refusal code (also in `lastError`). */
  commitAccepted(opts: { message: string; paths: string[]; push: boolean }): Promise<string | null>;
  /** `push` (retry after `push_failed`) → same contract as `commitAccepted`. */
  pushNow(): Promise<string | null>;

  // PR browser
  prRefresh(): Promise<void>;
  prRefreshAccounts(): Promise<void>;
  prSetHost(host: string): Promise<void>;
  prOpen(pr: PRSummary): Promise<void>;
  prClose(): void;
  prSelectFile(file: PRFileMeta | null): void;
  prAddDraft(path: string, line: number, side: "LEFT" | "RIGHT", body: string, startLine?: number): void;
  prRemoveDraft(id: string): void;
  prSubmit(event: ReviewEvent, body: string): Promise<boolean>;
  prReply(commentId: number, body: string): Promise<boolean>;
  prReloadComments(): Promise<void>;
  loginInTerminal(host: string): void;

  // MARK: wave3 desktop-flow — §36.11–36.14 (storeFlow.ts)
  /** The commit draft, the workbench preview / create steps, the AI pre-review runs, a new workbench's failed setup. */
  flow: FlowState;
  /** `workbench_progress` / `prereview` (and the flow replies) → `flow`; true when the event was one of them. */
  applyFlowEvent(ev: EngineEvent): boolean;
  /** Wired from `apply`: a new project forgets the flow state; the engine's `gate.prereviews` is mirrored. */
  flowSnapshotApplied(previous: ReviewState, snapshot: ReviewState): void;
  resetFlow(): void;
  /** §36.11 `commit_draft` → the message for the commit sheet's field, or null (`flow.draftError` says why). Nothing is committed. */
  draftCommitMessage(paths?: string[]): Promise<string | null>;
  /** §53 `commit_hunks` → the hunks of the accepted paths (the split sheet). */
  loadCommitHunks(paths?: string[]): Promise<CommitHunksResult>;
  /** §53 `commit_split_draft` → Claude's proposed split (read-only fork; nothing is committed). */
  splitCommitWithClaude(paths?: string[]): Promise<CommitSplitResult>;
  /** §53 `commit_series` → the commits in order (then one push when `push`). */
  commitSeries(commits: CommitPlan[], push: boolean): Promise<CommitSeriesResult>;
  /** §51 `pr_ai_draft` → Claude's title / description for the PR sheet, or why not in one line. Nothing is pushed or created. */
  fillPRWithClaude(base: string, sheet: PRSheetText): Promise<PRFillResult>;
  /** §36.12 `workbench_preview`, debounced (an older answer never replaces a newer one). */
  requestWorkbenchPreview(req: WorkbenchPreviewRequest, delayMs?: number): void;
  /** §36.12 / §36.14 `workbench_create` with its steps; the new window opens when it is ready (also after the sheet closed). */
  createWorkbenchWith(req: WorkbenchCreateRequest): Promise<string | null>;
  /** §36.13 `prereview_start` → true when it started. */
  startPreReview(scope: PreReviewScope, paths: string[] | undefined, effort: PreReviewEffort): Promise<boolean>;
  cancelPreReview(prereviewId: string): Promise<void>;
  /** `prereview_dismiss`: gone here at once; a refusal brings it back. */
  dismissFinding(prereviewId: string, findingId: string): Promise<void>;
  /** "Add as note": an ordinary review note on the finding's line, then the finding leaves the list. */
  addFindingAsNote(prereviewId: string, finding: PreReviewFinding, excerpt: string): Promise<boolean>;
  clearFlowError(which: "draft" | "preReview"): void;
  /** The window's repository's commit template / workbench setup / PR command, the pre-review effort. */
  saveFlowSettings(patch: FlowSettingsPatch): Promise<void>;
  /** §36.14 "Send to Claude": the threads as a composer draft — the PR head's workbench window, else this one. */
  sendPrThreads(threads: PRCommentThread[]): Promise<"this" | "workbench" | null>;
  dismissSetupReport(): void;

  // ui
  setTab(tab: Tab): void;
  toggleSidebar(): void;
  /** ⌘⇧D: collapse / expand the diff pane, remembered per project (`ui.diffCollapsed`). */
  toggleDiffPane(): void;
  openDialog(d: Dialog | null): void;
  dismissError(): void;
  dismissStartSlow(): void;
  dismissSubmitBanner(): void;
  dismissPRBanner(): void;
  dismissCommitBanner(): void;
};

const rg = () => window.rg;

/** Events that mean Claude is making progress again — they end an `api_retrying` chip (§19.6). */
const PROGRESS_EVENTS: ReadonlySet<EngineEvent["type"]> = new Set<EngineEvent["type"]>(["text_delta", "tool_use", "tool_result", "permission_request", "turn_end", "turn_summary", "plan_proposed"]);
/** `cli_start_slow` is a hint, not a state: it hides by itself after this long. */
const START_SLOW_HIDE_MS = 30_000;

const EMPTY_HISTORY: ReviewHistoryState = { entries: [], all: false, loading: false, error: null, loadedAt: 0 };

const AGENT_PANEL_KEY = "rg.agentPanel.open";
/** A view preference in localStorage (absent / unreadable → `fallback`). */
export function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}
export function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode etc. */
  }
}

export const useStore = create<Store>((set, get, api) => {
  const appendLog = (line: string) => {
    const logs = [...get().logs, line];
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    set({ logs });
  };

  /**
   * The banner + a transcript row. §2.6: the same failure again (code + the CLI's words, else the text) is counted on the
   * row it already has ("×N · last time") instead of a new row; a notice (§30 resume) does not become `lastError`.
   */
  const fail = (message: string, fatal: boolean, scope: ErrorScope | "client" = "client", extra: { code?: string; detail?: string; server?: string; facts?: ErrorFacts } = {}) => {
    const facts: ErrorFacts | undefined = extra.facts ?? (extra.code ? { code: extra.code } : undefined);
    const at = Date.now();
    set((s) => {
      const { items, row } = appendErrorRow(s.transcript, { kind: "error", id: uid(), message, fatal, scope, ...(facts && Object.keys(facts).length > 0 ? { facts } : {}), lastAt: at });
      const banner: ErrorBanner = {
        message,
        scope,
        fatal,
        ...(extra.code ? { code: extra.code } : {}),
        ...(extra.detail && extra.detail !== message ? { detail: extra.detail } : {}),
        ...(extra.server ? { server: extra.server } : {}),
        ...(row.facts ? { facts: row.facts } : {}),
        count: row.count ?? 1,
        lastAt: at,
      };
      return { ...(errorTone(extra.code, fatal) === "info" ? {} : { lastError: message }), errorBanner: banner, transcript: items };
    });
  };
  /** A refusal shown in place (dialog / banner) — no transcript row, but `lastError` + the top banner. */
  const notice = (message: string, scope: ErrorScope, code?: string) => set({ lastError: message, errorBanner: { message, scope, fatal: false, ...(code ? { code } : {}) } });
  /** A rejected request in words (§19.6 codes, else the engine's text) for the banner / a dialog. */
  const refusalWords = (e: unknown): string => refusalMessage(refusalOf(e));

  /** `forceReject` dialog → `runReject` (one confirm at a time; a replaced / closed dialog counts as Cancel). */
  let confirmResolver: ((revert: boolean) => void) | null = null;
  const settleConfirm = (revert: boolean) => {
    const r = confirmResolver;
    confirmResolver = null;
    r?.(revert);
  };
  const confirmOverwrite = (paths: string[], all: boolean): Promise<boolean> => {
    settleConfirm(false);
    return new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
      set({ dialog: { kind: "forceReject", paths, all } });
    });
  };
  /**
   * §19.1 whole-file reject: a `file_changed_since_review` refusal asks before re-sending with `force: true`.
   * §31.2: `external` (the outside changes `cmd` would revert) are confirmed first; declining sends nothing.
   */
  const rejectCommand = (cmd: RejectCommand, external: string[] = []): Promise<RejectOutcome> => {
    const batch = cmd.type === "reject_all" || cmd.paths.length > 1;
    return runReject(
      cmd,
      {
        request: (c) => engineRequest(c),
        confirmOverwrite: (paths) => confirmOverwrite(paths, batch),
        confirmExternal: (paths) => get().confirmRejectExternal(paths, batch),
      },
      external,
    ).then((outcome) => {
      if (outcome.kind === "refused") {
        appendLog(`[warn] ${cmd.type}: ${refusalOf(outcome.error).error}`);
        notice(refusalWords(outcome.error), "git", refusalOf(outcome.error).code);
      } else if (outcome.kind === "cancelled") {
        appendLog(`[info] ${cmd.type}: kept the user's edits in ${outcome.paths.join(", ")}`);
      } else if (outcome.kind === "keptExternal") {
        appendLog(`[info] ${cmd.type}: kept the outside changes in ${outcome.paths.join(", ")}`);
      }
      return outcome;
    });
  };
  /** §32: files whose content was never captured cannot be reverted — said in place of sending a doomed reject. */
  const notCapturedNotice = (paths: string[]) =>
    notice(refusalMessage({ code: "not_captured", error: `not_captured:${paths.join(", ")}`, detail: paths.join(", "), paths }), "git", "not_captured");

  /** M20 `set_permission_mode` / `plan_response`: null on success, else the engine's refusal code (also shown in the banner — not a `session_busy` the caller waits out, §39.5). */
  const planCommand = async (cmd: EngineCommand, opts: { busyWaits?: boolean } = {}): Promise<string | null> => {
    const isAnswer = cmd.type === "plan_response";
    if (isAnswer) {
      if (get().planAnswering) return "session_busy";
      set({ planAnswering: true, planNotice: null, answeredPlan: pendingPlan(get().state) });
    }
    try {
      await engineRequest(cmd);
      await get().settle();
      if (isAnswer) set({ planAnswering: false, answeredPlan: null });
      return null;
    } catch (e) {
      const r = refusalOf(e);
      appendLog(`[warn] ${cmd.type}: ${r.error}`);
      // MARK: wave6 w6-terminal — §44.1: any refusal saying auto mode cannot run here (a mode switch, a plan answer) is
      // remembered — Shift+Tab skips auto and a plan is approved into the default mode.
      if (r.code === "auto_mode_unavailable" || r.error.startsWith("auto_mode_unavailable")) get().noteAutoModeUnavailable();
      const words = refusalMessage(r);
      if (isAnswer) {
        // §19.5: the engine put the plan back — show the card again (from the plan we answered until its snapshot lands).
        const current = pendingPlan(get().state);
        const plan = r.code === "plan_followup_failed" ? planAfterFollowupFailure(current, get().answeredPlan) : current;
        set((s) => ({ planAnswering: false, answeredPlan: null, planNotice: plan ? words : null, state: { ...s.state, session: { ...s.state.session, pendingPlan: plan } } }));
        if (!plan) notice(words, "session", r.code);
      } else if (!(opts.busyWaits === true && r.code === "session_busy")) notice(words, "session", r.code);
      await get().settle();
      return r.error;
    }
  };

  // MARK: wave1 desktop-perms — §33.1 per-request answers
  /** The engine refused an answer: the card is undecided again — "handled" while the queue no longer lists it. */
  const permissionRefused = (requestId: string, e: unknown) => {
    const r = refusalOf(e);
    appendLog(`[warn] permission_response ${requestId}: ${r.error}`);
    set((s) => ({ transcript: markPermissionRow(s.transcript, requestId, null) }));
    // Already answered, withdrawn or ended with the turn (§33.1): nothing failed — the window's toast (toast.ts), not a red banner.
    if (r.code === "unknown_permission_request") showToast(refusalMessage(r));
    else notice(refusalMessage(r), "session", r.code);
  };
  /** Answered from this window: the card shows the decision and leaves the local queue at once (the next snapshot is the authority). */
  const markAnswered = (requestId: string, allow: boolean, answers?: Record<string, string>) =>
    set((s) => ({ transcript: markPermissionRow(s.transcript, requestId, allow, answers), state: { ...s.state, session: sessionWithoutRequest(s.state.session, requestId) } }));

  /**
   * Review mutations (accept / reject / notes) as request/reply: the engine refuses them with
   * `session_running` while a turn or its collection is in flight (release review H3), and a refusal
   * must reach the banner instead of vanishing like a fire-and-forget `send`.
   */
  const reviewCommand = (cmd: EngineCommand): void => {
    void engineRequest(cmd)
      .catch((e: unknown) => {
        appendLog(`[warn] ${cmd.type}: ${refusalOf(e).error}`);
        notice(refusalWords(e), "session", refusalOf(e).code);
      });
  };

  /**
   * True (and the banner says why) when the action must wait — wave2 desktop-flow §34.2: accept during a running turn on a
   * standing review goes through (`acceptBlockedReason`), reject waits for the turn's end (`rejectBlockedReason`).
   */
  const blockedNotice = (why: string | null): boolean => {
    if (why === null) return false;
    notice(why, "session");
    return true;
  };

  /** wave2 desktop-flow — §34.5: the selected file's diff is on screen — remember the content it showed. */
  const markViewed = (path: string) => {
    // MARK: wave3 check-clients — no review B (a fresh turn): the list is the previous round's, nothing of the new review is on screen.
    if (diffTreeOf(get().state.gate) === null) return;
    const f = get().state.changedFiles.find((x) => x.path === path);
    if (!f) return;
    const key = contentKey(f);
    if (get().viewedPaths[path] !== key) set((st) => ({ viewedPaths: { ...st.viewedPaths, [path]: key } }));
  };
  /** Bumped by every `selectFile`: a reply for an older selection only fills the cache. */
  let diffSeq = 0;

  const finishStreaming = (items: ChatItem[]): ChatItem[] => {
    const last = items[items.length - 1];
    if (last && last.kind === "assistant" && last.streaming) return [...items.slice(0, -1), { ...last, streaming: false }];
    return items;
  };

  /** Streams into the open assistant message — a new one when the unprompted mark changes (§18). */
  const appendAssistant = (items: ChatItem[], text: string, unprompted = false): ChatItem[] => {
    const last = items[items.length - 1];
    if (last && last.kind === "assistant" && last.streaming && (last.unprompted === true) === unprompted) return [...items.slice(0, -1), { ...last, text: last.text + text }];
    return [...finishStreaming(items), { kind: "assistant", id: uid(), text, streaming: true, ...(unprompted ? { unprompted: true as const } : {}) }];
  };

  const resetProjectView = () => {
    set({ transcript: [], lastError: null, errorBanner: null, selectedPath: null, selectedDiff: null, diffCache: {}, fullFileCache: {}, diffLoading: false, viewedPaths: {}, transcriptRestored: false, transcriptFocus: null, replaceTranscript: false, ui: {}, wantedPath: null, reviewHistory: EMPTY_HISTORY, historyView: null, queue: EMPTY_QUEUE });
    get().resetSide();
    get().resetComposer();
    get().resetPeer();
    get().resetFlow(); // MARK: wave3 desktop-flow
    sendAttempt = null; // wave2 check-clients
    get().resetReviewRound(); // MARK: wave2 desktop-flow
    get().resetSessionTools(); // MARK: wave3 desktop-session
    // MARK: polish p-foundation — the polish lanes' slices
    get().resetPolishWindow();
    get().resetPolishTranscript();
    get().resetPolishDiff();
    get().resetPolishPr();
  };

  // MARK: wave2 check-clients — M7 / §2.9 like the Mac: a send the engine took but could not hand to Claude comes back.
  /** The message that went out last, until its turn is over (src/renderer/sendRecovery.ts). */
  let sendAttempt: SendAttempt | null = null;
  // MARK: wave4 w4-safety — daily-14: why the running turn stopped, for its turn_end notification.
  const turnStops = new TurnStopTracker();
  /** `send_failed` / `lfs_missing` for `attempt`: it goes back to the front of the queue (once), which stops with the reason. */
  const requeueFailedSend = (attempt: SendAttempt) => {
    if (sendAttempt === attempt) sendAttempt = null;
    set((s) => {
      const kept = attempt.queuedId !== null && s.queue.items.some((m) => m.id === attempt.queuedId);
      const items = kept ? s.queue.items : enqueue(s.queue.items, attempt.message.text, true, attempt.message);
      return { queue: { ...s.queue, items, inflight: false, awaitingTurn: false, paused: s.queue.paused ?? attempt.failure ?? t("The message could not be sent to Claude") } };
    });
  };

  const setQueue = (patch: Partial<QueueState>) => set((s) => ({ queue: { ...s.queue, ...patch } }));
  // §50.1: a queue the API or the usage limit stopped goes on by itself at `resumeAt` (unless resumed / cleared / stopped again).
  let queueResumeTimer: ReturnType<typeof setTimeout> | null = null;
  const pauseQueueUntil = (patch: Partial<QueueState> & { paused: string }, resumeAt: number | null) => {
    if (queueResumeTimer) clearTimeout(queueResumeTimer);
    queueResumeTimer = null;
    setQueue({ ...patch, resumeAt, afterStop: false });
    if (resumeAt === null) return;
    queueResumeTimer = setTimeout(() => {
      queueResumeTimer = null;
      const q = get().queue;
      if (q.paused !== null && q.resumeAt === resumeAt) get().resumeQueue();
    }, Math.max(0, resumeAt - Date.now()));
  };
  /** §50.1: what an `error` does to a queue with messages in it (`queueStopOf`): nothing, a stop until Resume, or one that ends by itself. */
  const stopQueue = (stop: QueueStop, reason: string, resetAt: string | undefined) => {
    if (stop === "none") return;
    if (stop === "pause") return pauseQueueUntil({ paused: reason }, null);
    if (stop === "retry") {
      const retries = (get().queue.retries ?? 0) + 1;
      return pauseQueueUntil({ paused: reason, retries }, Date.now() + queueRetryDelayMs(retries));
    }
    const reset = resetAt ? Date.parse(resetAt) : Number.NaN;
    pauseQueueUntil({ paused: reason }, Number.isFinite(reset) ? reset + RESUME_DELAY_MS : null);
  };
  /** Sends the first queued message when the gate allows a plain send (same rule as the Send button). */
  const pumpQueue = () => {
    const s = get();
    const next = nextToSend(s.queue, s.state.gate);
    if (!next) return;
    setQueue({ inflight: true });
    const attempt = (sendAttempt = beginSendAttempt(next, next.id, Date.now()));
    engineRequest({ type: "send", text: next.text, ...sendExtras(next) })
      .then(() => {
        attempt.replied = true;
        // wave2 check-clients: an error{send_failed | lfs_missing} came first — the message stays first in the stopped queue.
        if (attempt.failed) requeueFailedSend(attempt);
        else set((st) => ({ queue: { ...st.queue, inflight: false, awaitingTurn: true, items: removeQueued(st.queue.items, next.id) } }));
      })
      .catch((e: unknown) => {
        if (sendAttempt === attempt) sendAttempt = null;
        const r = refusalOf(e);
        appendLog(`[warn] queued send: ${r.error}`);
        // The gate closed between the snapshot and the send: not an error — wait for it to open again.
        if (r.code === "gate_closed") setQueue({ inflight: false });
        else {
          setQueue({ inflight: false, paused: refusalMessage(r) });
          notice(refusalMessage(r), "session", r.code);
        }
      });
  };

  /**
   * Auto-selection after a snapshot: the project's last selected file (once), else the first pending, else the first —
   * in the Changes list's screen order (wave2 desktop-flow, comp-10).
   */
  const autoPick = (snapshot: ReviewState): string | null => {
    const wanted = get().wantedPath;
    const remembered = wanted ? snapshot.changedFiles.find((f) => f.path === wanted) : undefined;
    if (wanted && snapshot.changedFiles.length > 0) set({ wantedPath: null });
    const order = displayOrder(snapshot.changedFiles, get().riskFirst);
    return (remembered ?? order.find((f) => f.state === "pending") ?? order[0])?.path ?? null;
  };

  /** Accept / Reject on the selected file moves the selection to the next pending one on screen (below it, else the first). */
  const advanceFrom = (path: string) => {
    if (get().selectedPath !== path) return;
    const next = nextPendingAfter(displayOrder(get().state.changedFiles, get().riskFirst), path);
    if (next) get().selectFile(next);
  };

  const apply = (snapshot: ReviewState) => {
    const previous = get().state;
    if (snapshot.seq <= previous.seq && snapshot.seq !== 0) return;
    set({ state: snapshot });
    // MARK: wave2 check-clients — once its turn is over, a later send_failed (request changes, a rewind) is not about it.
    // Not before the send was answered: the turn a "Stop & send" interrupts ends before the send behind it runs.
    if (sendAttempt && sendAttempt.replied && sendTurnOver(previous, snapshot)) sendAttempt = null;
    // MARK: wave1 desktop-perms — §33.1: every open request has its card; one whose event this view missed (a reload) gets it now.
    const missing = requestsWithoutRow(get().transcript, pendingPermissionsOf(snapshot));
    if (missing.length > 0) set((s) => ({ transcript: [...finishStreaming(s.transcript), ...missing.map((request): ChatItem => ({ kind: "permission", id: uid(), request, allowed: null }))] }));
    // wave3 desktop-session — §36.5: capabilities exist from the start now (the engine's cache or empty starting lists);
    // only the session's own ones are kept as the client's cache and mean "initialized".
    const freshCaps = freshCapabilities(snapshot.session);
    const initialized = freshCaps !== null && freshCapabilities(previous.session) === null;
    if (initialized) set({ cachedCapabilities: freshCaps });
    // §19.6: the retry chip ends with the turn; the slow-start hint once the CLI is initialized (or the session is gone).
    if (get().retrying && snapshot.gate.phase !== "running") set({ retrying: null });
    if (get().startSlowHint && (initialized || !snapshot.session.open)) set({ startSlowHint: null });
    // MARK: wave1 desktop-session — §30: the CLI answered initialize again (a real recovery): the crash banner is stale.
    if (snapshot.session.ready === true && previous.session.ready !== true && clearsOnReady(get().errorBanner)) set({ errorBanner: null });
    if (snapshot.project?.root && snapshot.project.root !== previous.project?.root) {
      // M15: per-project UI preferences (pane widths, sidebar tab, last selected file).
      const ui = get().settings?.ui?.[projectRootHash(snapshot.project.root)] ?? {};
      set({ ui, tab: ui.tab ?? "changes", wantedPath: ui.selectedPath ?? null });
      if (ui.tab === "history") void get().loadReviewHistory();
    }
    const sel = get().selectedPath;
    // M16: files arriving re-open a diff pane the user had collapsed (back to auto).
    if (snapshot.changedFiles.length > 0 && previous.changedFiles.length === 0 && get().ui.diffCollapsed === true) get().setUI({ diffCollapsed: undefined });
    if (snapshot.gate.turnStartTree !== previous.gate.turnStartTree) {
      set({ viewedPaths: {}, rangeChoice: {} });
      // MARK: wave3 check-clients — a new review: the previous round's diffs are no diff of it (as on the Mac; the one on screen stays).
      set({ diffCache: {}, fullFileCache: {} });
      // A new snapshot A ends the previous review round (§14): an open History tab lists it.
      if (get().tab === "history" && snapshot.project) void get().loadReviewHistory();
    }
    // wave2 desktop-flow — §34.2: diffs are cached per review B (`reviewEndTree`, else `turnEndTree`), which a send on a
    // standing review keeps until the collection; a turn that leaves no B to read keeps what is on screen (read-only).
    const nextTree = diffTreeOf(snapshot.gate);
    if (nextTree !== diffTreeOf(previous.gate)) {
      if (nextTree === null && isTurnActive(snapshot.gate)) {
        if (sel && !snapshot.changedFiles.some((f) => f.path === sel)) get().selectFile(autoPick(snapshot));
      } else {
        // Diffs are cached per snapshot B: after a collection or a revert they must be re-requested.
        set({ diffCache: {}, fullFileCache: {} });
        if (nextTree === null) set({ selectedDiff: null, diffLoading: false });
        else if (sel && snapshot.changedFiles.some((f) => f.path === sel)) get().selectFile(sel);
        else get().selectFile(autoPick(snapshot));
      }
    } else if (sel && !snapshot.changedFiles.some((f) => f.path === sel)) {
      get().selectFile(autoPick(snapshot));
    }
    // PR browser: drop the selection when the PR closed or its file list changed.
    const prSel = get().prSelectedFilename;
    if (snapshot.pr.selected?.number !== previous.pr.selected?.number || snapshot.pr.selectedSummary?.url !== previous.pr.selectedSummary?.url) {
      set({ prSelectedFilename: null, prSelectedDiff: null, prDiffCache: {}, prDiffLoading: false });
      const first = snapshot.pr.files[0];
      if (snapshot.pr.selected && first) get().prSelectFile(first);
    } else if (prSel && !snapshot.pr.files.some((f) => f.filename === prSel)) {
      set({ prSelectedFilename: null, prSelectedDiff: null });
    }
    get().flowSnapshotApplied(previous, snapshot); // MARK: wave3 desktop-flow — §36.13 gate.prereviews, a new project's flow state
    // A chat that became current (open_project / session_new / session_open) always has a tab; the client owns `openTabIds`.
    const currentChat = sessionsOf(snapshot).currentId;
    if (currentChat && currentChat !== sessionsOf(previous).currentId) {
      get().ensureTab(currentChat);
      // §21: the side threads belong to the chat — load the new chat's (the engine may also send them by itself).
      if (get().side.mainSessionId !== currentChat) void get().sideList();
      // §27: the HUD reset of a chat switch re-arms the warning — this chat's banner does not carry over.
      if (sessionsOf(previous).currentId) set({ contextWarning: null });
    }
    if (snapshot.gitInit && !previous.gitInit) set({ dialog: { kind: "gitInit" } });
    if (!snapshot.gitInit && previous.gitInit && get().dialog?.kind === "gitInit") set({ dialog: null });
    // Queue: a started turn ends the wait for it; another chat must not receive this chat's queue.
    const q = get().queue;
    if (q.awaitingTurn && snapshot.gate.phase === "running") setQueue({ awaitingTurn: false });
    if (q.items.length > 0 && currentChat !== sessionsOf(previous).currentId && sessionsOf(previous).currentId && !adoptsRecord(previous, snapshot)) setQueue({ paused: t("The chat changed") });
    get().stepLimitResume(); // MARK: wave4 w4-longwork — §38.2 "풀리면 이어서 하기" fires once idle past the reset
    get().stepScheduledMode(previous, snapshot); // MARK: wave4b w4b-auto — §39.5 a mode picked during the turn goes out now
    pumpQueue();
  };

  let startSlowTimer: ReturnType<typeof setTimeout> | null = null;
  /** `error` events by §19.6 code: chip, hint, plan card or banner (+ transcript row). */
  const handleErrorEvent = (ev: ErrorEvent) => {
    const text = errorEventText(ev);
    const code = ev.code;
    appendLog(`[${ev.fatal ? "error" : "warn"}] error${code ? ` ${code}` : ""}: ${ev.message}`);
    switch (presentationOf(code)) {
      case "retrying":
        set({ retrying: { attempt: ev.attempt, maxRetries: ev.maxRetries, retryDelayMs: ev.retryDelayMs, status: ev.status, message: ev.message, at: Date.now() } });
        return;
      case "startSlow": {
        set({ startSlowHint: { message: text, at: Date.now() } });
        if (startSlowTimer) clearTimeout(startSlowTimer);
        startSlowTimer = setTimeout(() => set({ startSlowHint: null }), START_SLOW_HIDE_MS);
        return;
      }
      case "planFailed": {
        const plan = planAfterFollowupFailure(pendingPlan(get().state), get().answeredPlan);
        set((s) => ({ planNotice: text, state: { ...s.state, session: { ...s.state.session, pendingPlan: plan } } }));
        if (!plan) fail(text, false, ev.scope, { code, detail: ev.message });
        return;
      }
      // MARK: wave3 desktop-session — §36.8 `cli_version_changed`: the chat row only; its banner comes from `session.cli`.
      case "row": {
        const facts = factsOf(ev);
        set((s) => ({ transcript: appendErrorRow(s.transcript, { kind: "error", id: uid(), message: text, fatal: false, scope: ev.scope, ...(Object.keys(facts).length > 0 ? { facts } : {}), lastAt: Date.now() }).items }));
        return;
      }
      default:
        if (ev.fatal) set((s) => ({ transcript: finishStreaming(s.transcript) }));
        set({ retrying: null });
        fail(text, ev.fatal, ev.scope, { code, detail: ev.message, ...(ev.server ? { server: ev.server } : {}), facts: factsOf(ev) });
    }
  };

  return {
    ...createSessionSlice(set, get, api),
    ...createSideSlice(set, get, api),
    ...createComposerSlice(set, get, api),
    ...createPeerSlice(set, get, api),
    ...createBackgroundSlice(set, get, api), // MARK: §52
    ...createReviewGateSlice(set, get, api), // MARK: wave1 desktop-review
    ...createReviewRoundSlice(set, get, api), // MARK: wave2 desktop-flow
    ...createSessionToolsSlice(set, get, api), // MARK: wave3 desktop-session
    ...createSafetySlice(set, get, api), // MARK: wave4 w4-safety
    ...createLongWorkSlice(set, get, api), // MARK: wave4 w4-longwork
    ...createAutoModeSlice(set, get, api), // MARK: wave4b w4b-auto
    // MARK: polish p-foundation — the polish lanes' slices
    ...createPolishWindowSlice(set, get, api),
    ...createPolishTranscriptSlice(set, get, api),
    ...createPolishDiffSlice(set, get, api),
    ...createPolishPrSlice(set, get, api),
    state: EMPTY_STATE,
    ...createFlowSlice(set, get, api), // MARK: wave3 desktop-flow
    transcript: [],
    logs: [],
    lastError: null,
    errorBanner: null,
    settings: null,
    cachedCapabilities: null,
    tab: "changes",
    sidebarVisible: true,
    dialog: null,
    lockedProjectPath: null,
    refusedLockPid: null,
    selectedPath: null,
    selectedDiff: null,
    diffLoading: false,
    diffCache: {},
    fullFileCache: {},
    viewedPaths: {},
    prSelectedFilename: null,
    prSelectedDiff: null,
    prDiffCache: {},
    prDiffLoading: false,
    dismissedSubmitAt: null,
    dismissedPRURL: null,
    dismissedCommitAt: null,
    transcriptRestored: false,
    transcriptFocus: null,
    agentPanelOpen: readBool(AGENT_PANEL_KEY, false),
    boardOpen: false, // MARK: wave5 w5-board
    reviewHistory: EMPTY_HISTORY,
    historyView: null,
    dismissedFallbackAt: null,
    retrying: null,
    startSlowHint: null,
    planAnswering: false,
    planNotice: null,
    answeredPlan: null,
    queue: EMPTY_QUEUE,

    // ------------------------------------------------------------ events

    handleEvent(ev) {
      // §19.6 `api_retrying` lasts until Claude makes progress again (or the turn ends).
      if (get().retrying && PROGRESS_EVENTS.has(ev.type)) set({ retrying: null });
      // §21 side questions / §22 MCP status (side_failed stays in its thread, never the window banner).
      if (get().applySideEvent(ev)) return;
      if (get().applyComposerEvent(ev)) return;
      if (get().applyFlowEvent(ev)) return; // MARK: wave3 desktop-flow — §36.12 workbench_progress, §36.13 prereview
      if (applyCodeGraphEvent(ev)) return; // MARK: wave5 w5-graph — §43.3 the board's code graph (its own store)
      if (applyStatusLineEvent(ev)) return; // MARK: wave6 w6-statusline — §44.2 the user's status line (its own store)
      switch (ev.type) {
        case "state":
          apply(ev.state);
          break;
        case "user_message":
          set((s) => ({ transcript: [...finishStreaming(s.transcript), userItem(ev.text, ev.turn, ev.mentions, ev.attachments, ev.autoModel, ev.steered)] }));
          break;
        case "text_delta":
          set((s) => ({ transcript: appendAssistant(s.transcript, ev.text, ev.unprompted === true) }));
          break;
        case "tool_use":
          set((s) => ({ transcript: [...finishStreaming(s.transcript), { kind: "toolUse", id: uid(), toolUseId: ev.id, name: ev.name, file: ev.file, input: ev.input, parentToolUseId: ev.parentToolUseId, rationale: ev.rationale, ...rationaleMetaOf(ev), ...agentUseMetaOf(ev), ...exploreMetaOf(ev) }] }));
          break;
        case "tool_result":
          set((s) => ({ transcript: [...s.transcript, { kind: "toolResult", id: uid(), toolUseId: ev.toolUseId, isError: ev.isError, preview: ev.preview, parentToolUseId: ev.parentToolUseId, truncated: ev.truncated, testOutcome: ev.testOutcome, ...agentResultMetaOf(ev), ...hookDeniedField(ev) }] }));
          break;
        case "permission_request": {
          const { type: _t, ...request } = ev;
          // §33.1: a queue — the request joins the open ones (the oldest stays `pendingPermission`); no card is ever replaced.
          set((s) => ({
            state: { ...s.state, session: sessionWithRequest(s.state.session, request) },
            transcript: hasPermissionRow(s.transcript, request.requestId) ? s.transcript : [...finishStreaming(s.transcript), { kind: "permission", id: uid(), request, allowed: null }],
          }));
          get().answerIfAgentAllowed(request); // r2-peers (M26): "이 에이전트의 요청은 이번 턴 동안 허용"
          break;
        }
        case "budget_event":
          set((s) => ({ transcript: [...s.transcript, { kind: "budget", id: uid(), event: ev }] }));
          break;
        case "turn_end": {
          get().endTurnAllowances(); // r2-peers (M26)
          const summary = turnEndSummary(ev);
          set((s) => ({ transcript: [...finishStreaming(s.transcript), { kind: "turnEnd", id: uid(), summary, ...compactedField(ev.usage) }] }));
          {
            // A pause already set (an error of this turn, §50.1) keeps its reason and its own resume time. After the user's
            // Stop the queue waits with "멈춤 — 다음 메시지 대기 중" and [보내기]; a turn the queue went on after resets the API backoff.
            const q = get().queue;
            const why = pauseReasonForTurnEnd(ev.stopReason, q.skipInterruptPause);
            const stops = q.paused === null && q.items.length > 0 && why !== null;
            const paused = stops ? (why === "interrupted" ? t("Stopped — the next message waits") : t("The turn ended with an error")) : q.paused;
            setQueue({ awaitingTurn: false, skipInterruptPause: false, paused, ...(stops ? { afterStop: why === "interrupted", resumeAt: null } : {}), ...(paused === null ? { retries: 0 } : {}) });
          }
          break;
        }
        case "turn_summary":
          // wave2 desktop-flow — §34.3: a summary is about what THIS turn changed; nothing changed → no card.
          if (ev.files.length === 0) break;
          set((s) => ({ transcript: [...finishStreaming(s.transcript), { kind: "turnSummary", id: uid(), summary: ev }] }));
          break;
        case "extensions_fallback":
          appendLog(`[warn] extensions_fallback: ${ev.message}`);
          // The dedicated fallback banner (BannerStack) replaces the engine's generic error banner for it.
          set((s) => ({ dismissedFallbackAt: null, ...(s.errorBanner?.message === ev.message ? { errorBanner: null } : {}) }));
          break;
        case "plan_proposed":
          set((s) => ({
            planNotice: null,
            answeredPlan: null,
            state: { ...s.state, session: { ...s.state.session, pendingPlan: { path: ev.path, plan: ev.plan, at: new Date().toISOString() } } },
            transcript: [...finishStreaming(s.transcript), { kind: "planProposed", id: uid(), path: ev.path, plan: ev.plan }],
          }));
          break;
        case "plan_approved":
          set((s) => ({
            state: { ...s.state, session: { ...s.state.session, pendingPlan: null } },
            transcript: [...finishStreaming(s.transcript), { kind: "planApproved", id: uid(), mode: ev.mode, path: ev.path, ...(ev.into ? { line: planHandoffLine(ev) } : {}) /* MARK: wave4d w4d-plan */ }],
          }));
          break;
        // MARK: §49 Run as Task — a task handed to this worktree went out as the first message of a fresh chat (its
        // `user_message` follows), or (`sent: false`) the session could not take it: it goes into the composer, once.
        // The engine keeps the worktree's mode itself (this client has no per-project mode memory).
        case "task_started":
          appendLog(`[info] task from ${ev.from}: ${ev.sent ? "sent in a fresh chat" : "waiting in the composer"} (${ev.mode})`);
          if (!ev.sent && ev.text) insertIntoComposer(ev.text);
          break;
        case "transcript_restore": {
          if (get().replaceTranscript) {
            // After `session_new` / `session_open` (M15) the rows are the other chat's: swap, don't prepend.
            const swapped = transcriptItemsToChatItems(ev.items, get().state.budget);
            set({ transcript: swapped, replaceTranscript: false, transcriptRestored: true });
            pagingOnRestore(ev, swapped); // MARK: wave4 w4-history (§38.3)
            break;
          }
          // The engine may resend this after a reconnect; only apply it once per project view.
          if (get().transcriptRestored) break;
          set({ transcriptRestored: true });
          pagingOnRestore(ev, []); // MARK: wave4 w4-history — reset; the rows below set it
          if (ev.items.length === 0) break;
          const restored = transcriptItemsToChatItems(ev.items, get().state.budget);
          set((s) => ({ transcript: [{ kind: "restoredDivider", id: uid() }, ...restored, ...s.transcript] }));
          pagingOnRestore(ev, restored); // MARK: wave4 w4-history (§38.3)
          break;
        }
        case "error":
          // MARK: wave2 check-clients — the message that just went out never reached Claude: back to the front of the queue.
          if (failsSend(ev.code, sendAttempt, Date.now())) {
            sendAttempt.failed = true;
            sendAttempt.failure = errorEventText(ev);
            if (sendAttempt.replied) requeueFailedSend(sendAttempt);
          }
          get().noteLongWorkError(ev); // MARK: wave4 w4-longwork — §38.2 the usage limit's reset
          if (ev.code === "auto_mode_unavailable") get().noteAutoModeUnavailable(); // MARK: wave6 w6-terminal — §44.1 Shift+Tab skips auto
          handleErrorEvent(ev);
          // §2.9 (M4) / §50.1: only the message's own failure, its session, a login or the API stop the queue — never a
          // notice, a failing PR list, a refresh or a commit (their banner says it).
          if (get().queue.items.length > 0) stopQueue(queueStopOf(ev), errorEventText(ev), ev.resetAt);
          break;
        // MARK: wave1 desktop-session — §29
        case "peer_message":
          get().applyPeerMessage(ev.message);
          break;
        // MARK: §52 — the turn Claude started itself
        case "auto_turn":
          get().applyAutoTurn(ev);
          break;
        case "log":
          appendLog(`[${ev.level}] ${ev.message}`);
          break;
        default:
          break;
      }
      // MARK: wave4 w4-safety — daily-14: every event is followed (also in front), so a reason never leaks into the next turn.
      const phase = get().state.gate.phase;
      const stopNote = turnStops.observe(ev, phase === "running" || phase === "collecting");
      // OS notification for a window in the background (main checks focus + the setting again).
      if (typeof document !== "undefined" && !document.hasFocus()) {
        const root = get().state.project?.root ?? null;
        // r2-peers (M26): a request "이번 턴 동안 허용" already answered needs no one.
        const answered = ev.type === "permission_request" && !isPermissionPending(get().state, ev.requestId);
        const n = answered ? null : notificationFor(ev, { project: root ? lastComponent(root) : null, peerInbound: get().state.session.peerInbound, ...stopNote, chatId: get().state.sessions?.currentId ?? null }); // wave4b w4-notify: chatId
        if (n) void rg().notify?.(n).catch(() => undefined);
      }
    },

    fire(cmd) {
      rg().send(cmd);
    },

    async run(cmd, opts = {}) {
      try {
        await engineRequest(cmd);
        await get().settle();
        return true;
      } catch (e) {
        const r = refusalOf(e);
        if (opts.reportFailure === false) {
          appendLog(`[warn] ${cmd.type}: ${r.error}`);
          return false;
        }
        fail(refusalMessage(r), opts.fatal === true, scopeOfCommand(cmd.type), { code: r.code, detail: r.error });
        return false;
      }
    },

    /** Waits (≤ 500 ms) for the snapshot the engine coalesces after a reply. */
    async settle() {
      const seq = get().state.seq;
      const deadline = Date.now() + 500;
      while (get().state.seq <= seq && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    },

    async loadSettings() {
      const s = await rg().getSettings();
      setAppearance(s.appearance);
      set({ settings: s, cachedCapabilities: get().cachedCapabilities ?? s.cachedCapabilities });
      return s;
    },

    async saveSettings(patch) {
      const s = await rg().setSettings(patch);
      setAppearance(s.appearance);
      // §54: mirrors main's `budgetOf` — the limits while the change limit is on, else none.
      const budget = s.budgetEnabled === true ? { maxFiles: s.budgetMaxFiles, maxLines: s.budgetMaxLines, hardMultiplier: 2.0 } : { maxFiles: 0, maxLines: 0 };
      set({ settings: s, state: { ...get().state, budget } });
    },

    // ------------------------------------------------------------ lifecycle

    async openProject(path, takeover = false) {
      keepQueueWhileLeaving(get().state.project?.root ?? null); // MARK: polish p-lifecycle (P4-composer-07): the queue stays kept
      resetProjectView();
      set({ lockedProjectPath: null, refusedLockPid: null, dialog: null, tab: "changes" });
      try {
        await engineRequest({ type: "open_project", path, takeover });
        await get().settle();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("locked_by_other_session")) {
          await get().settle();
          const pid = Number(message.split(":")[1] ?? "0") || 0;
          // M19: the lock belongs to another of our own windows — focus it instead of offering a take-over.
          if (await rg().focusProjectWindow(path)) return;
          set({ lockedProjectPath: path, refusedLockPid: pid, dialog: { kind: "lockConflict" } });
        } else {
          fail(message, true);
        }
      }
    },

    async switchProject(path) {
      keepQueueWhileLeaving(get().state.project?.root ?? null); // MARK: polish p-lifecycle (P4-composer-07)
      resetProjectView();
      set({ lockedProjectPath: null, refusedLockPid: null, dialog: null, tab: "changes" });
      try {
        await engineRequest({ type: "switch_project", path });
        await get().settle();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith("locked_by_other_session")) {
          await get().settle();
          if (await rg().focusProjectWindow(path)) return;
          set({ lockedProjectPath: path, refusedLockPid: Number(message.split(":")[1] ?? "0") || 0, dialog: { kind: "lockConflict" } });
        } else fail(message, true);
      }
    },

    /**
     * Switching (File › Open / Open Recent / Switch Project…, the sidebar's projects). MARK: polish p-lifecycle (P1-chrome-03):
     * the project already open does nothing and one open in another window comes to the front (a switch would stop this
     * session for a lock it cannot take); a switch stops the session, so a turn running, a card waiting or work that would
     * stop or be lost asks first (main's question, the Mac's words); otherwise pending files ask (the Mac's "Switch project?").
     */
    requestSwitch(path) {
      void (async () => {
        if (isOpenProject(get().state.project, path, rg().platform)) return;
        if (get().state.project && (await rg().focusProjectWindow(path))) return;
        const answer = await confirmProjectChange(get(), "switch");
        if (!answer.ok) return;
        const s = get().state;
        const pending = s.changedFiles.filter((f) => f.state === "pending" || f.state === "changesRequested").length;
        if (pending > 0 && !answer.asked) set({ dialog: { kind: "switchProject", path } });
        else void get().switchProject(path);
      })();
    },

    async chooseAndOpen(mode = "open") {
      const path = await rg().chooseDirectory();
      if (!path) return;
      if (mode === "switch" || get().state.project) get().requestSwitch(path);
      else await get().openProject(path);
    },

    async takeOver() {
      const path = get().lockedProjectPath;
      if (path) await get().openProject(path, true);
    },

    cancelTakeover() {
      set({ lockedProjectPath: null, refusedLockPid: null, dialog: get().dialog?.kind === "lockConflict" ? null : get().dialog });
    },

    async closeProject() {
      // MARK: polish p-lifecycle (P1-chrome-03): closing stops the session — asked like a window's close (the review is saved).
      if (get().state.project && !(await confirmProjectChange(get(), "close")).ok) return;
      keepQueueWhileLeaving(get().state.project?.root ?? null); // MARK: polish p-lifecycle (P4-composer-07)
      resetProjectView();
      set({ lockedProjectPath: null, refusedLockPid: null, dialog: null });
      await get().run({ type: "close_project" });
    },

    async initRepository() {
      if (!get().state.gitInit) return;
      await get().run({ type: "init_repo" }, { fatal: true });
    },

    cancelGitInit() {
      if (get().state.gitInit) get().fire({ type: "cancel_git_init" });
      set({ dialog: null });
    },

    async restartSession() {
      if (!get().state.session.canRestart) return;
      await get().run({ type: "restart_session" }, { reportFailure: false });
    },

    // ------------------------------------------------------------ chat

    send(text, opts = {}) {
      const trimmed = text.trim();
      const s = get().state;
      const acceptPending = opts.acceptPending === true && canAcceptAndSend(s);
      if ((!s.gate.canSend && !acceptPending) || trimmed.length === 0) return;
      const extras = sendExtras(opts);
      for (const a of extras.attachments ?? []) void seedAttachment(a);
      // wave2 check-clients: remembered until its turn is over — a send_failed / lfs_missing puts it back (sendRecovery.ts).
      const attempt = (sendAttempt = beginSendAttempt({ text: trimmed, ...extras }, null, Date.now()));
      const sending = engineRequest({ type: "send", text: trimmed, ...(acceptPending ? { acceptPending: true } : {}), ...extras });
      void sending.then(
        () => {
          attempt.replied = true;
          if (attempt.failed) requeueFailedSend(attempt);
        },
        () => {
          if (sendAttempt === attempt) sendAttempt = null;
        },
      );
      // A request (not fire-and-forget): a §23 / §24 refusal (`invalid_mention`, `attachment_type`, …) reaches the banner.
      void sending.catch((e: unknown) => {
        const r = refusalOf(e);
        appendLog(`[warn] send: ${r.error}`);
        // §29: the gate closed between the snapshot and the click (another session's turn started, …) — the message waits
        // first in the queue and goes out when the gate opens, instead of being lost to a banner.
        if (!acceptPending && requeuesSend(r)) {
          set((s) => ({ queue: { ...s.queue, items: enqueue(s.queue.items, trimmed, true, extras) } }));
          // The gate may already be open again (its snapshot came before this reply): no snapshot would pump it then.
          pumpQueue();
          return;
        }
        // wave2 check-clients: any other refusal keeps the typed message too — first in the stopped queue, with the reason
        // (the composer was already cleared; the Mac's `sendRequest` does the same).
        set((s) => ({ queue: { ...s.queue, items: enqueue(s.queue.items, trimmed, true, extras), paused: refusalMessage(r) } }));
        notice(refusalMessage(r), "session", r.code);
      });
    },

    interrupt() {
      if (get().state.gate.phase !== "running") return;
      get().fire({ type: "interrupt" });
      get().armInterruptWatch(); // MARK: wave4 w4-safety — robustness-07: "Force restart" when the stop does not stop
    },

    enqueueMessage(text, front = false, extras = {}) {
      if (!get().state.project) return;
      set((s) => ({ queue: { ...s.queue, items: enqueue(s.queue.items, text, front, extras) } }));
      pumpQueue();
    },
    editQueuedMessage(id, text) {
      set((s) => ({ queue: { ...s.queue, items: editQueued(s.queue.items, id, text) } }));
    },
    removeQueuedMessage(id) {
      set((s) => ({ queue: { ...s.queue, items: removeQueued(s.queue.items, id) } }));
    },
    moveQueuedMessage(id, dir) {
      set((s) => ({ queue: { ...s.queue, items: moveQueued(s.queue.items, id, dir) } }));
    },
    resumeQueue() {
      if (queueResumeTimer) clearTimeout(queueResumeTimer);
      queueResumeTimer = null;
      setQueue({ paused: null, awaitingTurn: false, resumeAt: null, afterStop: false });
      pumpQueue();
    },
    clearQueue() {
      if (queueResumeTimer) clearTimeout(queueResumeTimer);
      queueResumeTimer = null;
      setQueue({ items: [], paused: null, resumeAt: null, afterStop: false });
    },

    interruptAndSend(text, extras = {}) {
      const trimmed = text.trim();
      if (!get().state.project || trimmed.length === 0) return;
      const running = get().state.gate.phase === "running";
      if (!running) {
        set((s) => ({ queue: { ...s.queue, items: enqueue(s.queue.items, trimmed, true, extras), paused: null, awaitingTurn: false } }));
        pumpQueue();
        return;
      }
      // §28: the interrupted turn must not pause the rest of the queue, and the queue waits for this send.
      setQueue({ skipInterruptPause: true, inflight: true });
      const payload = sendExtras(extras);
      for (const a of payload.attachments ?? []) void seedAttachment(a);
      void engineRequest({ type: "interrupt" }).catch((e: unknown) => appendLog(`[warn] interrupt: ${refusalOf(e).error}`));
      const attempt = (sendAttempt = beginSendAttempt({ text: trimmed, ...payload }, null, Date.now())); // wave2 check-clients
      engineRequest({ type: "send", text: trimmed, ...payload })
        .then(() => {
          attempt.replied = true;
          if (attempt.failed) requeueFailedSend(attempt);
          else setQueue({ inflight: false, awaitingTurn: true });
        })
        .catch((e: unknown) => {
          if (sendAttempt === attempt) sendAttempt = null;
          const r = refusalOf(e);
          appendLog(`[warn] stop & send: ${r.error}`);
          // Still running (the interrupt outlived its wait): it goes out first once the gate opens; anything else pauses.
          const paused = r.code === "gate_closed" ? null : refusalMessage(r);
          set((s) => ({ queue: { ...s.queue, inflight: false, items: enqueue(s.queue.items, trimmed, true, extras), paused } }));
          if (paused) notice(paused, "session", r.code);
          else pumpQueue();
        });
    },

    async steer(text, extras = {}) {
      const trimmed = text.trim();
      if (!get().state.project || trimmed.length === 0) return;
      const mentions = extras.mentions ?? [];
      try {
        await engineRequest({ type: "steer", text: trimmed, ...(mentions.length > 0 ? { mentions } : {}) });
      } catch (e: unknown) {
        appendLog(`[info] steer refused (${refusalOf(e).error}) — queued instead`);
        get().enqueueMessage(trimmed, false, mentions.length > 0 ? { mentions } : {});
      }
    },

    async allowAlwaysInProject(requestId, pattern) {
      const s = get();
      const req = pendingPermissionsOf(s.state).find((p) => p.requestId === requestId);
      const root = s.state.project?.root;
      // Never a pattern for a reason card or SendMessage (§33.3 / §33.2: the engine would not apply it either).
      if (!req || !root || !canAllowBeyondOnce(req) || pattern.trim().length === 0) return;
      // The card shows its answer at once; the pattern is saved first (→ set_settings) so the engine also answers the
      // queued calls it covers, and this card's own late answer is then a no-op `ok` (§33.6).
      markAnswered(requestId, true);
      const map = { ...(get().settings?.projectBashAllowPatterns ?? {}) };
      // MARK: r2-skills-side — §33.6 (M21): kept for the repository — every worktree of it (`commonDir`), else this folder.
      const hash = projectRootHash(s.state.project?.commonDir ?? root);
      map[hash] = addPatternLine(map[hash], pattern);
      try {
        await get().saveSettings({ projectBashAllowPatterns: map });
        appendLog(`[info] allow pattern for this project: ${pattern}`);
      } catch (e) {
        notice(e instanceof Error ? e.message : String(e), "session");
      }
      void engineRequest({ type: "permission_response", requestId, allow: true }).catch((e: unknown) => permissionRefused(requestId, e));
    },

    async allowAlwaysEverywhere(requestId, pattern) {
      const s = get();
      const req = pendingPermissionsOf(s.state).find((p) => p.requestId === requestId);
      if (!req || !s.state.project || !canAllowBeyondOnce(req) || pattern.trim().length === 0) return;
      markAnswered(requestId, true);
      try {
        // Main sends the merged list to every window's engine (broadcastSettings), then this card's answer goes out.
        await get().saveSettings({ bashAllowPatterns: addPatternLine(get().settings?.bashAllowPatterns, pattern) });
        appendLog(`[info] allow pattern for all projects: ${pattern}`);
      } catch (e) {
        notice(e instanceof Error ? e.message : String(e), "session");
      }
      void engineRequest({ type: "permission_response", requestId, allow: true }).catch((e: unknown) => permissionRefused(requestId, e));
    },

    respondPermission(requestId, allow, message, updatedInput, remember, deny) {
      const req = pendingPermissionsOf(get().state).find((p) => p.requestId === requestId);
      const answers =
        updatedInput && typeof updatedInput["answers"] === "object" && updatedInput["answers"] !== null
          ? (updatedInput["answers"] as Record<string, string>)
          : undefined;
      markAnswered(requestId, allow, answers);
      // `remember` never rides on a reason card (§33.3), nor on a request this view no longer lists — nor on a SendMessage,
      // unless its receiving session's conversation is known (r2-peers, §33.2: SendMessage:<session id>).
      const keep = remember === true && allow && req !== undefined && canRemember(req);
      // A request, not fire-and-forget: `unknown_permission_request` (already answered / withdrawn) must reach the card.
      void engineRequest({
        type: "permission_response",
        requestId,
        allow,
        ...(message !== undefined ? { message } : {}),
        ...(updatedInput !== undefined ? { updatedInput } : {}),
        ...(keep ? { remember: true } : {}),
        ...(!allow && deny?.skip ? { skip: true } : {}),
        ...(!allow && deny?.interrupt ? { interrupt: true } : {}),
      }).catch((e: unknown) => permissionRefused(requestId, e));
    },

    // MARK: wave4b w4b-follow — §39.4
    allowAndFollow(requestId, followUp) {
      markAnswered(requestId, true);
      void engineRequest({ type: "permission_response", requestId, allow: true, follow: true, ...(followUp ? { followUp } : {}) })
        .catch((e: unknown) => permissionRefused(requestId, e));
    },

    forgetAllows() {
      if (!get().state.project) return;
      get().fire({ type: "forget_allows" });
    },

    // MARK: wave1 desktop-perms — §33 permission queue
    async fetchPermissionRules() {
      try {
        const rules = await engineRequest({ type: "permission_rules" });
        return { ok: true as const, rules };
      } catch (e) {
        const r = refusalOf(e);
        appendLog(`[warn] permission_rules: ${r.error}`);
        return { ok: false as const, message: refusalMessage(r) };
      }
    },

    async importAllowPatterns(patterns, target) {
      const s = get();
      if (!s.settings) return null;
      const r = importPatch(s.settings, patterns, target, s.state.project?.root ?? null);
      if (!r) return null;
      if (r.added === 0) return 0;
      try {
        await get().saveSettings(r.patch);
        appendLog(`[info] imported ${r.added} allow pattern(s) into ${target === "global" ? "the global list" : "this project"}`);
        return r.added;
      } catch (e) {
        notice(e instanceof Error ? e.message : String(e), "session");
        return null;
      }
    },

    async setPermissionMode(mode, opts) {
      if (!get().state.session.open) return "no_session";
      if (!opts?.force && permissionMode(get().state) === mode) return null;
      return await planCommand({ type: "set_permission_mode", mode }, { busyWaits: opts?.busyWaits === true });
    },

    async approvePlan(mode) {
      if (!pendingPlan(get().state)) return "no_plan";
      return await planCommand({ type: "plan_response", approve: true, ...(mode ? { mode } : {}) });
    },

    async keepPlanning(message) {
      if (!pendingPlan(get().state)) return "no_plan";
      const note = message?.trim();
      return await planCommand({ type: "plan_response", approve: false, ...(note ? { message: note } : {}) });
    },

    // MARK: wave4d w4d-plan — §42.1
    async approvePlanInto(mode, into, path) {
      const plan = pendingPlan(get().state);
      if (!plan) return "no_plan";
      // An engine that sends no steps would read `into` as a plain approve (implementing here): never sent to it.
      if (!planReviewSupported(plan)) return "unsupported";
      return await planCommand({ type: "plan_response", approve: true, mode, into, ...(path ? { path } : {}) });
    },

    async followPlan(path) {
      try {
        await engineRequest({ type: "plan_follow", path });
        await get().settle();
        return null;
      } catch (e) {
        const r = refusalOf(e);
        appendLog(`[warn] plan_follow: ${r.error}`);
        notice(refusalMessage(r), "session", r.code);
        return r.error;
      }
    },

    answerQuestions(requestId, answers, annotations) {
      const req = pendingPermissionsOf(get().state).find((p) => p.requestId === requestId);
      if (!req || req.toolName !== "AskUserQuestion") return;
      const notes = annotations && Object.keys(annotations).length > 0 ? { annotations } : {}; // r2-chats-cards M08b
      get().respondPermission(requestId, true, undefined, { questions: req.input["questions"], answers, ...notes });
    },

    requestChanges(extra) {
      if (!get().state.gate.canRequestChanges) return;
      get().fire({ type: "request_changes", extra: extra ?? undefined });
    },

    // ------------------------------------------------------------ review

    selectFile(path) {
      // wave2 desktop-flow — §34.1 the range (the user's pick, else the file's default), §34.2 the review B a running turn
      // keeps readable (a cached diff stays; without a B to read the reason replaces the spinner), §34.5 viewed by content.
      const seq = ++diffSeq;
      set({ selectedPath: path, selectedDiff: null, diffLoading: false, diffUnavailable: null, liveView: null });
      if (path && get().ui.selectedPath !== path) get().setUI({ selectedPath: path });
      const s = get().state;
      const file = s.changedFiles.find((f) => f.path === path);
      if (!file) return;
      const chosen = get().rangeChoice[file.path];
      const since: DiffSince = rangeFor(file, s.gate, chosen);
      if (get().diffSince !== since) set({ diffSince: since });
      // The range it opened in holds until the file's content changes (a default too: removing a sent note never moves it).
      const content = contentKey(file);
      if (chosen?.since !== since || chosen.content !== content) set((st) => ({ rangeChoice: { ...st.rangeChoice, [file.path]: { since, content } } }));
      if (file.isBinary) {
        set({ selectedDiff: { oldPath: file.oldPath ?? file.path, newPath: file.path, isBinary: true, hunks: [], truncated: false } });
        markViewed(file.path);
        return;
      }
      const key = rangeCacheKey(file.path, since);
      const cached = get().diffCache[key];
      if (cached) {
        set({ selectedDiff: cached });
        markViewed(file.path);
        return;
      }
      const tree = diffTreeOf(s.gate);
      const unavailable = (): string | null => {
        const g = get().state.gate;
        if (isTurnActive(g)) return t("This diff can be shown when the turn ends");
        return g.phase === "collect_failed" ? t("Could not collect the turn's changes") : null;
      };
      if (tree === null) {
        set({ diffUnavailable: unavailable() });
        return;
      }
      set({ diffLoading: true });
      engineRequest({ type: "select_file", path: file.path, ...(since !== "review" ? { since } : {}) })
        .then((reply) => {
          if (diffTreeOf(get().state.gate) !== tree) {
            if (seq === diffSeq) set({ diffLoading: false, diffUnavailable: unavailable() });
            return;
          }
          // The tree this diff describes: reject_hunks echoes it (§17), not whatever B the next snapshot shows.
          // `since` as asked: a range's hunk ids must never pass for the whole review's (§34.1), echoed or not.
          const diff: ReviewDiff = {
            ...reply.diff,
            truncated: reply.truncated,
            endTree: reply.endTree ?? tree,
            ...(since !== "review" ? { since } : {}),
            ...(reply.baseTree ? { baseTree: reply.baseTree } : {}),
            ...(reply.stale ? { stale: true as const } : {}),
          };
          set((st) => ({ diffCache: { ...st.diffCache, [key]: diff } }));
          if (seq === diffSeq) {
            set({ selectedDiff: diff, diffLoading: false });
            markViewed(file.path);
          }
        })
        .catch((e) => {
          const r = refusalOf(e);
          // §34.1: the range is gone (a restored review whose trees were pruned, …) — the whole review instead, quietly.
          if (since !== "review" && (r.code === "range_unavailable" || r.code === "invalid_since")) {
            appendLog(`[info] select_file ${file.path} since ${since}: ${r.error}`);
            set((st) => ({ rangeChoice: { ...st.rangeChoice, [file.path]: { since: "review", content: contentKey(file) } } }));
            if (seq === diffSeq) get().selectFile(file.path);
            return;
          }
          if (seq === diffSeq) set({ diffLoading: false });
          fail(`Failed to load diff for ${file.path}: ${e instanceof Error ? e.message : String(e)}`, false);
        });
    },

    revealFile(path) {
      if (!get().state.changedFiles.some((f) => f.path === path)) return;
      if (get().tab !== "changes") get().setTab("changes");
      if (get().historyView) set({ historyView: null });
      if (get().liveView) set({ liveView: null }); // wave2 desktop-flow — the review's diff, not the running turn's
      if (get().ui.diffCollapsed === true) get().setUI({ diffCollapsed: undefined });
      if (get().selectedPath !== path) get().selectFile(path);
    },

    revealToolUse(toolUseId) {
      set((s) => ({ transcriptFocus: { toolUseId, nonce: (s.transcriptFocus?.nonce ?? 0) + 1 } }));
    },

    toolOutput(toolUseId) {
      return engineRequest({ type: "tool_output", toolUseId });
    },

    async rejectHunks(path, hunks) {
      const s = get().state;
      const file = s.changedFiles.find((f) => f.path === path);
      if (!file || file.state !== "pending" || hunks.length === 0) return "not_pending";
      if (blockedNotice(hunkRejectBlockedReason(s))) return "session_running"; // r2-review-flow M32: hunks still wait for the turn
      // The tree the diff on screen was computed for (file_diff.endTree): if B moved since, the engine says stale_diff.
      // wave2 desktop-flow — §34.1: hunk ids are the whole review's (the only view that offers them); `baseTree` guards that.
      const selected = get().selectedPath === path ? get().selectedDiff : null;
      const shown = selected && !selected.since ? selected : null;
      const tree = (shown ?? get().diffCache[path])?.endTree ?? s.gate.turnEndTree;
      const base = (shown ?? get().diffCache[path])?.baseTree;
      try {
        await engineRequest({ type: "reject_hunks", path, hunks, ...(tree ? { expectedEndTree: tree } : {}), ...(base ? { expectedBaseTree: base } : {}) });
        await get().settle();
        return null;
      } catch (e) {
        const code = e instanceof Error ? e.message : String(e);
        appendLog(`[warn] reject_hunks: ${code}`);
        // §19.1: every hunk selected = a whole-file reject — same "your edits will be lost" confirm, then `reject{force}`.
        const edited = changedPathsOf(e);
        const shownDiff = shown ?? get().diffCache[path];
        if (edited && shownDiff && shownDiff.hunks.every((h) => hunks.includes(h.id))) {
          if (!(await confirmOverwrite(edited, false))) return code;
          try {
            await engineRequest({ type: "reject", paths: [path], force: true });
            await get().settle();
            return null;
          } catch (again) {
            appendLog(`[warn] reject (force): ${refusalOf(again).error}`);
            notice(refusalWords(again), "git", refusalOf(again).code);
            return refusalOf(again).error;
          }
        }
        notice(hunkRefusalText(code), "session");
        // The diff on screen no longer matches B (or the file): drop the cached one and fetch it again.
        if (/^(stale_diff|unknown_hunk|diff_mismatch|no_hunks)/.test(code) && get().selectedPath === path) {
          set((st) => {
            const { [path]: _gone, ...rest } = st.diffCache;
            return { diffCache: rest };
          });
          get().selectFile(path);
        }
        return code;
      }
    },

    async loadReviewHistory(all) {
      if (!get().state.project) return;
      const wantAll = all ?? get().reviewHistory.all;
      set((s) => ({ reviewHistory: { ...s.reviewHistory, all: wantAll, loading: true, error: null } }));
      try {
        const reply = await engineRequest({ type: "review_history", ...(wantAll ? { all: true } : {}) });
        if (get().reviewHistory.all !== wantAll) return;
        // wave2 desktop-flow — §34.4: the round in progress comes apart from the finished ones.
        set({ reviewHistory: { entries: reply.entries, all: wantAll, loading: false, error: null, loadedAt: Date.now(), current: reply.current ?? null } });
      } catch (e) {
        const code = e instanceof Error ? e.message : String(e);
        appendLog(`[warn] review_history: ${code}`);
        set((s) => ({ reviewHistory: { ...s.reviewHistory, loading: false, error: historyRefusalText(code) } }));
      }
    },

    openHistoryDiff(entry, path) {
      set({ historyView: { entry, path, diff: null, loading: true, error: null }, liveView: null });
      if (get().ui.diffCollapsed === true) get().setUI({ diffCollapsed: undefined });
      const isCurrent = () => get().historyView?.entry.id === entry.id && get().historyView?.path === path;
      engineRequest({ type: "history_diff", entryId: entry.id, path })
        .then((reply) => {
          if (isCurrent()) set({ historyView: { entry, path, diff: { ...reply.diff, truncated: reply.truncated }, loading: false, error: null, ...(reply.why !== undefined ? { why: reply.why } : {}) } });
        })
        .catch((e: unknown) => {
          const code = e instanceof Error ? e.message : String(e);
          appendLog(`[warn] history_diff: ${code}`);
          if (isCurrent()) set({ historyView: { entry, path, diff: null, loading: false, error: historyRefusalText(code) } });
        });
    },

    closeHistoryView() {
      set({ historyView: null });
    },

    async retryWithExtensions() {
      const path = get().state.project?.path;
      if (!path) return;
      await get().switchProject(path);
    },

    toggleAgentPanel(open) {
      const next = open ?? !get().agentPanelOpen;
      set({ agentPanelOpen: next });
      writeBool(AGENT_PANEL_KEY, next);
    },

    // MARK: wave5 w5-board
    toggleBoard(open) {
      const next = (open ?? !get().boardOpen) && get().state.project !== null;
      set({ boardOpen: next });
    },

    selectPending(dir) {
      // wave2 desktop-flow — comp-10: in the order the Changes list shows (groups, risky first).
      const next = stepPending(displayOrder(get().state.changedFiles, get().riskFirst), get().selectedPath, dir);
      if (next) get().selectFile(next);
    },

    accept(path) {
      const s = get().state;
      // wave2 desktop-flow — §34.2: also while a turn runs on this review (accepted if the turn leaves the file alone).
      if (!s.changedFiles.some((f) => f.path === path && f.state === "pending") || blockedNotice(acceptBlockedReason(s))) return;
      reviewCommand({ type: "accept", paths: [path] });
      advanceFrom(path);
    },

    reject(path) {
      const s = get().state;
      if (!s.changedFiles.some((f) => f.path === path && f.state === "pending") || blockedNotice(rejectBlockedReason(s))) return;
      // wave1 desktop-review — §32: an uncaptured file is never reverted; §31.2: an outside change is confirmed first.
      const file = s.changedFiles.find((f) => f.path === path && f.state === "pending");
      if (file?.uncaptured) return notCapturedNotice([path]);
      if (file && isExternalChange(file)) {
        void rejectCommand({ type: "reject", paths: [path] }, [path]).then((outcome) => outcome.kind === "done" && advanceFrom(path));
        return;
      }
      void rejectCommand({ type: "reject", paths: [path] });
      advanceFrom(path);
    },

    acceptAll() {
      const s = get().state;
      if (s.gate.pendingCount === 0 || blockedNotice(acceptBlockedReason(s))) return;
      reviewCommand({ type: "accept_all" });
    },

    rejectAll(includeExternal) {
      const s = get().state;
      if (s.gate.pendingCount === 0 || blockedNotice(rejectBlockedReason(s))) return;
      // wave1 desktop-review — §31.2 / §32: Claude's changes only unless includeExternal (confirmed); uncaptured files stay.
      const plan = planRejectAll(s.changedFiles, includeExternal === true);
      if (!plan.cmd) {
        if (plan.uncaptured.length > 0) notCapturedNotice(plan.uncaptured.map((f) => f.path));
        return;
      }
      void rejectCommand(plan.cmd, plan.external.map((f) => f.path));
    },

    answerForceReject(revert) {
      if (get().dialog?.kind === "forceReject") set({ dialog: null });
      settleConfirm(revert);
    },

    retryCollect() {
      const s = get().state;
      if (!s.gate.collectError || s.gate.phase === "collecting") return;
      get().fire({ type: "retry_collect" });
    },

    async fullFile(path, since = "review") {
      const key = rangeCacheKey(path, since);
      const cached = get().fullFileCache[key];
      if (cached) return cached;
      const reply = await engineRequest({ type: "full_file", path, ...(since !== "review" ? { since } : {}) });
      set((st) => ({ fullFileCache: { ...st.fullFileCache, [key]: reply } }));
      return reply;
    },

    addNote(path, line, side, excerpt, body) {
      const text = body.trim();
      if (!text) return;
      reviewCommand({ type: "add_note", path, line, side, excerpt, body: text });
    },

    removeNote(id) {
      reviewCommand({ type: "remove_note", noteId: id });
    },

    // ------------------------------------------------------------ branches / workbenches

    async refreshBranches() {
      if (!get().state.project) return;
      await get().run({ type: "branches" }, { reportFailure: false });
    },

    async switchBranch(name) {
      const s = get().state;
      if (!s.project || s.branches.switchBlocker) return;
      await get().run({ type: "switch_branch", name }, { reportFailure: false });
    },

    async createBranch(name) {
      const s = get().state;
      if (!s.project || s.branches.switchBlocker) return;
      await get().run({ type: "create_branch", name }, { reportFailure: false });
    },

    async refreshWorkbenches() {
      if (!get().state.project) return;
      await get().run({ type: "workbench_list" }, { reportFailure: false });
    },

    async removeWorkbench(path, force) {
      if (!get().state.project) return null;
      try {
        await engineRequest({ type: "workbench_remove", path, force });
        await get().settle();
        return null;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        appendLog(`[warn] workbench_remove: ${message}`);
        return message;
      }
    },

    async pruneWorkbenches() {
      if (!get().state.project) return;
      await get().run({ type: "workbench_prune" });
      await get().refreshWorkbenches();
    },

    async createPR(base, title, body, draft, meta) {
      if (!get().state.project) return null;
      try {
        const reply = await engineRequest({ type: "pr_create", base, title: title ?? undefined, body: body ?? undefined, draft: draft || undefined, ...(meta ?? {}) });
        await get().settle();
        set({ dismissedPRURL: null });
        return reply.url;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        appendLog(`[warn] pr_create: ${message}`);
        notice(refusalWords(e), "pr", refusalOf(e).code);
        return null;
      }
    },

    async commitAccepted({ message, paths, push }) {
      if (!get().state.project) return "no_project";
      try {
        // `commit` / `push` land in `@reviewgate/engine` with M12; the cast keeps older engine typings compiling.
        await engineRequest({ type: "commit", message, paths, push } as unknown as EngineCommand);
        await get().settle();
        set({ dismissedCommitAt: null });
        return null;
      } catch (e) {
        const code = e instanceof Error ? e.message : String(e);
        appendLog(`[warn] commit: ${code}`);
        notice(refusalWords(e), "git", refusalOf(e).code);
        await get().settle();
        return code;
      }
    },

    async pushNow() {
      if (!get().state.project) return "no_project";
      try {
        await engineRequest({ type: "push" } as unknown as EngineCommand);
        await get().settle();
        set({ dismissedCommitAt: null });
        return null;
      } catch (e) {
        const code = e instanceof Error ? e.message : String(e);
        appendLog(`[warn] push: ${code}`);
        notice(refusalWords(e), "git", refusalOf(e).code);
        await get().settle();
        return code;
      }
    },

    // ------------------------------------------------------------ PR browser

    async prRefresh() {
      await get().run({ type: "pr_list" }, { reportFailure: false });
    },
    async prRefreshAccounts() {
      await get().run({ type: "accounts" }, { reportFailure: false });
    },
    async prSetHost(host) {
      await get().saveSettings({ ghHost: host });
      await get().settle();
      await get().prRefresh();
    },
    async prOpen(pr) {
      const id = `${pr.host}/${pr.repo}#${pr.number}`;
      await get().run({ type: "pr_open", summaryId: id }, { reportFailure: false });
    },
    prClose() {
      get().fire({ type: "pr_close" });
      set({ prSelectedFilename: null, prSelectedDiff: null, prDiffCache: {} });
    },
    prSelectFile(file) {
      set({ prSelectedFilename: file?.filename ?? null, prSelectedDiff: null, prDiffLoading: false });
      if (!file) return;
      const cached = get().prDiffCache[file.filename];
      if (cached) {
        set({ prSelectedDiff: cached });
        return;
      }
      set({ prDiffLoading: true });
      engineRequest({ type: "pr_select_file", filename: file.filename })
        .then((reply) => {
          const diff: ReviewDiff = { ...reply.diff, truncated: reply.truncated };
          set((st) => ({ prDiffCache: { ...st.prDiffCache, [file.filename]: diff } }));
          if (get().prSelectedFilename === file.filename) set({ prSelectedDiff: diff, prDiffLoading: false });
        })
        .catch((e) => {
          if (get().prSelectedFilename === file.filename) set({ prDiffLoading: false });
          appendLog(`[warn] pr_select_file: ${e instanceof Error ? e.message : String(e)}`);
        });
    },
    prAddDraft(path, line, side, body, startLine) {
      const text = body.trim();
      if (!text) return;
      get().fire({ type: "pr_add_draft", path, line, side, body: text, startLine });
    },
    prRemoveDraft(id) {
      get().fire({ type: "pr_remove_draft", draftId: id });
    },
    async prSubmit(event, body) {
      const ok = await get().run({ type: "pr_submit", event, body }, { reportFailure: false });
      if (ok) set({ dismissedSubmitAt: null });
      return ok;
    },
    async prReply(commentId, body) {
      return get().run({ type: "pr_reply", commentId, body }, { reportFailure: false });
    },
    async prReloadComments() {
      await get().run({ type: "pr_reload_comments" }, { reportFailure: false });
    },
    loginInTerminal(host) {
      get().fire({ type: "login_in_terminal", host });
    },

    // ------------------------------------------------------------ ui

    setTab(tab) {
      set({ tab, ...(tab !== "history" ? { historyView: null } : {}) });
      if (get().ui.tab !== tab) get().setUI({ tab });
      if (tab === "history") void get().loadReviewHistory();
    },
    toggleSidebar() {
      set((s) => ({ sidebarVisible: !s.sidebarVisible }));
    },
    toggleDiffPane() {
      const { state, ui, selectedPath } = get();
      get().setUI({ diffCollapsed: !isDiffCollapsed(state, ui, selectedPath) });
    },
    openDialog(d) {
      // Replacing / closing the §19.1 confirm any other way keeps the user's edits.
      if (get().dialog?.kind === "forceReject" && d?.kind !== "forceReject") settleConfirm(false);
      set({ dialog: d });
    },
    dismissError() {
      set({ errorBanner: null });
    },
    dismissStartSlow() {
      set({ startSlowHint: null });
    },
    dismissSubmitBanner() {
      set({ dismissedSubmitAt: get().state.pr.lastSubmitResult?.submittedAt ?? null });
    },
    dismissPRBanner() {
      set({ dismissedPRURL: get().state.pr.lastCreatedPR?.url ?? null });
    },
    dismissCommitBanner() {
      set({ dismissedCommitAt: commitOf(get().state).lastCommit?.at ?? null });
    },
  };
});

// ---------------------------------------------------------------- derived helpers (used by components)

/** Mirror of the engine's `scopeOf` for failures that come back as a rejected `request` (no `error` event). */
export function scopeOfCommand(type: EngineCommand["type"]): ErrorScope {
  if (type.startsWith("pr_") || type === "accounts" || type === "login_in_terminal") return "pr";
  if (["send", "request_changes", "interrupt", "permission_response", "forget_allows", "restart_session", "tabs_set", "set_permission_mode", "plan_response"].includes(type) || type.startsWith("session_")) return "session";
  if (/^(open_project|switch_project|init_repo|reject|reject_all|retry_collect|select_file|full_file|branches|switch_branch|create_branch|workbench_\w+|commit|push)$/.test(type)) return "git";
  return "engine";
}

export const pendingFiles = (s: ReviewState): ChangedFileState[] => s.changedFiles.filter((f) => f.state === "pending");
export const hasPendingReview = (s: ReviewState): boolean => s.changedFiles.some((f) => f.state === "pending" || f.state === "changesRequested");
export const isRunning = (s: ReviewState): boolean => s.gate.phase === "running";
/** M20: the live session's mode; `"default"` on an engine (or a restored state) without the field. */
export const permissionMode = (s: ReviewState): PermissionMode => s.session.permissionMode ?? "default";
/** M20: the plan awaiting `plan_response`, or null. */
export const pendingPlan = (s: ReviewState): PendingPlan | null => s.session.pendingPlan ?? null;
export const isReverting = (s: ReviewState): boolean => s.gate.phase === "reverting";
export const capabilitiesOf = (st: Pick<Store, "state" | "cachedCapabilities">): { caps: SessionCapabilities | null; cached: boolean } => {
  // wave3 desktop-session — §36.5: the engine's replayed cache counts as (cached) too.
  if (st.state.session.capabilities) return { caps: st.state.session.capabilities, cached: st.state.session.capabilitiesCached === true };
  return { caps: st.cachedCapabilities, cached: st.cachedCapabilities !== null };
};
export const repoDisplayName = (s: ReviewState): string => {
  const main = s.workbenches.list.find((w) => w.isMain);
  if (main) return lastComponent(main.path);
  return s.project?.name ?? (s.project?.path ?? s.gitInit?.path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
};
export const lastComponent = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export const isMainWorkbench = (s: ReviewState): boolean => {
  const cur = s.workbenches.list.find((w) => w.isCurrent) ?? s.workbenches.list.find((w) => w.path === s.workbenches.current);
  return cur?.isMain ?? true;
};

/** `gate.blockedReason` localized (AppState.cannotSendReason). */
export function cannotSendReason(s: ReviewState): string | null {
  switch (s.gate.blockedReason) {
    case null:
      return null;
    case "git_init_needed":
      return t("Initialize a git repository to continue");
    case "no_session":
      return s.project ? t("Session ended — Restart to continue") : t("Open a project first (⌘O)");
    case "starting":
      return t("Starting sidecar…");
    case "running":
      // §29: another session's turn keeps the gate closed (`blockedReason` stays "running") — the message waits, then goes out.
      // wave2 check-clients: a turn of the CLI's own (no `peer`) is other work, not a message (the Mac's words).
      if (s.session.externalTurn && !s.session.externalTurn.peer) return t("Claude Code is busy with other work — what you send goes out when it is done");
      if (s.session.externalTurn) return t("Another session's message is being handled — your message goes out when it is done");
      return t("Claude is working…");
    case "awaiting_permission":
      return t("Waiting for permission decision");
    case "collecting":
      return t("Collecting changes…");
    case "reverting":
      return t("Reverting…");
    case "collect_failed":
      return t("Could not collect changes: {0} — Retry", s.gate.collectError ?? "");
    case "pending_review":
      return t("Review {0} pending file(s) to continue", s.gate.pendingCount);
    case "changes_requested":
      return t("Send your change request ({0} file(s)) to continue", s.gate.changesRequestedCount);
  }
}

/** A refusal code / engine error text in words (§19.6 codes via src/renderer/errorCodes.ts); anything unknown verbatim. */
export function refusalText(code: string): string {
  return refusalMessage(refusalOf(code));
}

/** §17 `reject_hunks` refusals in words — with the way out (whole-file reject, refresh) where there is one. */
export function hunkRefusalText(code: string): string {
  const [head, detail = ""] = code.split(/:(.*)/s);
  switch (head) {
    case "file_changed_since_review":
      return t("{0} was edited after this diff was made, so parts of it cannot be reverted safely. Refresh (⌘R) to see the current diff, then try again.", detail);
    case "binary_file":
      return t("Binary files cannot be reverted in parts — reject the whole file instead.");
    case "partial_reject_unsupported": {
      if (detail === "uncaptured") return t("This file's content was not captured, so no part of it can be reverted either"); // wave1 desktop-review (§32)
      if (detail === "symlink") return t("A symbolic link cannot be reverted part by part — reject the whole file instead");
      if (detail === "submodule") return t("A submodule cannot be reverted part by part — reject the whole file instead");
      if (detail === "mode") return t("Only the file mode changed — reject the whole file to revert it");
      const what = detail === "A" ? t("added") : detail === "D" ? t("deleted") : detail === "R" ? t("renamed") : t("copied");
      return t("Parts of a {0} file cannot be reverted — reject the whole file instead.", what);
    }
    case "stale_diff":
      return t("The diff changed in the meantime. It has been reloaded — select the parts again.");
    case "unknown_hunk":
    case "diff_mismatch":
      return t("The diff no longer matches the file. It has been reloaded — select the parts again.");
    case "no_hunks":
      return t("Select at least one part to revert.");
    case "not_pending":
      return t("Only files still pending review can be reverted in parts.");
    case "not_a_changed_file":
      return t("{0} is not part of the current review.", detail);
    case "no_review":
      return t("There is no review in progress.");
    case "reverting":
      return t("Reverting…");
    case "session_running":
      return t("Claude is working…");
    default:
      return refusalText(code);
  }
}

/** §14 `review_history` / `history_diff` refusals. */
export function historyRefusalText(code: string): string {
  const [head, detail = ""] = code.split(/:(.*)/s);
  switch (head) {
    case "unknown_history_entry":
      return t("This review round is no longer in the history.");
    case "not_in_history_entry":
      return t("{0} is not part of this review round.", detail);
    case "history_trees_gone":
      return t("The snapshots of this round were cleaned up; its diff can no longer be shown.");
    default:
      return refusalText(code);
  }
}

/** Client-side mirror of `git check-ref-format --branch`; null means acceptable. */
export function branchNameHint(raw: string, existing: { name: string }[]): string | null {
  const name = raw.trim();
  if (!name) return t("Enter a branch name");
  if (existing.some((b) => b.name === name)) return t("A branch with this name already exists");
  if (
    /[\s~^:?*[\\\x00-\x1f]/.test(name) ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name === "@" ||
    name.split("/").some((c) => c.startsWith(".") || c.endsWith(".lock"))
  ) {
    return t("Not a valid branch name");
  }
  return null;
}

/** Folder name the engine derives from a branch (`feature/x` → `feature-x`). */
export function workbenchSlug(branch: string): string {
  const slug = branch.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  return slug.length > 0 ? slug : "workbench";
}

export function budgetLabel(b: Budget): string {
  return `${b.maxFiles}/${b.maxLines}`;
}

// MARK: wave4 w4-history — §38.3: `transcript_page` rows become items the way restored rows do (transcriptHistory.ts).
export const chatItemsOfRows = (items: TranscriptItem[], budget: Budget): ChatItem[] => transcriptItemsToChatItems(items, budget);
