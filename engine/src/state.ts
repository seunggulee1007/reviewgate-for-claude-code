import type { BranchInfo, BranchSwitchBlocker } from "./git/branches.js";
import type { PRStore } from "./pr/store.js";
import type {
  BlockedReason,
  Budget,
  BudgetUsage,
  CommitIdentity,
  CommitState,
  GatePhase,
  GitInitState,
  HudState,
  PendingPlan,
  LastCommitState,
  LockConflictState,
  PRState,
  ProjectState,
  ReviewState,
  SessionCapabilities,
  SessionExtensions,
  SessionsState,
  PermissionMode,
  PermissionRequest,
  ToolchainState,
  WorkbenchesState,
  EffortLevel,
  ModelOption,
  TurnCheckpointView,
  ExternalTurn,
  PeerInboundMode,
  PeerMessage,
  CliInfo,
  ExtensionsWaitingOn,
} from "./protocol.js";
import type { RemoteBranchInfo } from "./protocol.js"; // MARK: wave3 engine-flow
import type { StorageState } from "./protocol.js"; // MARK: wave4b w4b-bigturn
import type { AutoModelChoice } from "./protocol.js"; // MARK: wave5 w5-model
import { suggestCommitMessage } from "./review/commitMessage.js";
import type { ReviewGate } from "./review/gate.js";
import { originOf } from "./session/provenance.js";
import { isModsGroup } from "./git/mods.js";
import { fileRiskFields } from "./review/fileRisk.js"; // MARK: wave4b w4b-files
// MARK: wave4c w4c-trust (§41.2)
import type { AutoAcceptRules } from "./protocol.js";
import { anyAutoAcceptRule, normalizeAutoAcceptRules } from "./review/trust.js";

/** The engine's internal slices `buildState` derives the wire snapshot from. */
export type EngineSlices = {
  seq: number;
  project: ProjectState | null;
  gitInit: GitInitState | null;
  session: {
    open: boolean;
    starting: boolean;
    sessionId: string | null;
    model: string | null;
    capabilities: SessionCapabilities | null;
    capabilitiesCached: boolean;
    /** Always `pendingPermissions[0] ?? null` (the engine sets both together). */
    pendingPermission: PermissionRequest | null;
    /** §33: every open permission request, oldest first. */
    pendingPermissions: PermissionRequest[];
    rememberedAllows: string[];
    permissionMode: PermissionMode;
    pendingPlan: PendingPlan | null;
    /** MARK: wave6 w6-terminal — §44.1 (see protocol.ts SessionState); `slices()` sends null outside plan mode. */
    prePlanMode: PermissionMode | null;
    extensions: SessionExtensions | null;
    /** §25 / §26 (see protocol.ts SessionState). */
    effort?: EffortLevel | null;
    selectedModel?: string | null;
    availableModels?: ModelOption[];
    checkpoints?: TurnCheckpointView[];
    /** §30 / §29 (see protocol.ts SessionState). */
    ready?: boolean;
    peerInbound?: PeerInboundMode;
    peerInbox?: PeerMessage[];
    externalTurn?: ExternalTurn | null;
    peerTurn?: { messageIds: string[]; fromNames: string[] } | null;
    // MARK: wave3 engine-session (see protocol.ts SessionState)
    /** §36.7 */
    extensionsWaitingOn?: ExtensionsWaitingOn | null;
    /** §36.8 */
    cli?: CliInfo | null;
    // MARK: wave5 w5-model
    /** §43.4 (see protocol.ts SessionState). */
    autoModel?: AutoModelChoice | null;
  };
  toolchain: ToolchainState;
  gate: ReviewGate;
  budget: Budget;
  budgetUsage: BudgetUsage;
  hud: HudState;
  /** wave3 engine-flow — §36.12 `remotes`: the remote-tracking branches (absent until the first refresh). */
  branches: { list: BranchInfo[]; isWorktreeDirty: boolean; remotes?: RemoteBranchInfo[] };
  pr: PRStore;
  lastError: string | null;
  workbenches: WorkbenchesState;
  lockConflict: LockConflictState | null;
  commit: { lastCommit: LastCommitState | null; identity: CommitIdentity; lastUserText: string | null };
  sessions: SessionsState;
  // MARK: wave4b w4b-bigturn
  /** §39.1: failing saves and the volume's free space (copied as is). */
  storage?: StorageState;
  // MARK: wave4c w4c-trust
  /** §41.2: the open repository's auto-accept rules (sent only while one is on). */
  autoAcceptRules?: AutoAcceptRules;
};

export function gatePhase(s: EngineSlices): GatePhase {
  const g = s.gate;
  if (s.session.starting) return "starting";
  if (g.running) return "running";
  if (g.collecting) return "collecting";
  if (g.reverting) return "reverting";
  if (g.collectError !== null) return "collect_failed";
  if (g.hasPendingReview) return "reviewing";
  return "idle";
}

/**
 * Port of `SessionStore.cannotSendReason` as a reason code; null when `canSend`. A review no longer
 * blocks sending (a question is always allowed), but while the session is gone it still outranks
 * `no_session` (audit 1.4): the client shows "review first", then `restart_session`.
 */
export function blockedReason(s: EngineSlices): BlockedReason | null {
  const g = s.gate;
  if (s.gitInit !== null) return "git_init_needed";
  if (g.running) return s.session.pendingPermission === null ? "running" : "awaiting_permission";
  if (g.collecting) return "collecting";
  if (g.reverting) return "reverting";
  if (g.collectError !== null) return "collect_failed";
  if (!s.session.open || s.session.starting) {
    if (g.pendingFiles.length > 0) return "pending_review";
    if (g.changesRequestedFiles.length > 0) return "changes_requested";
  }
  if (!s.session.open) return "no_session";
  if (s.session.starting) return "starting";
  // §29: a turn the CLI runs that is not ours (`session.externalTurn`; refusals say `external_turn`).
  if (s.session.externalTurn) return "running";
  return null;
}

/** `restart_session` is available while a project is open and no session start is in flight. */
export function canRestart(s: EngineSlices): boolean {
  return s.project !== null && s.gitInit === null && !s.session.starting;
}

/**
 * Input is enabled when no turn / collection / revert is in flight. A pending review does NOT close
 * it: sending a message never changes review state, so a question can always be asked (§10).
 */
export function canSend(s: EngineSlices): boolean {
  return s.session.open && !s.session.starting && s.gate.isSettled && !s.session.externalTurn;
}

/**
 * `request_changes` is how notes go back to Claude; a plain `send` is a question and leaves them alone. §34.4: only notes
 * not sent yet count — a sent note stays in the review ("요청함") but never goes again.
 */
export function canRequestChanges(s: EngineSlices): boolean {
  const g = s.gate;
  return g.unsentNoteCount > 0 && !g.running && s.session.open && !s.session.starting && !g.collecting && !g.reverting
    && g.collectError === null && !s.session.externalTurn;
}

/** Port of `SessionStore.branchSwitchBlocker()`; null means switching is allowed right now. */
export function switchBlocker(s: EngineSlices): BranchSwitchBlocker | null {
  const g = s.gate;
  if (g.running || s.session.starting || g.collecting || g.reverting) return { kind: "running" };
  const outstanding = g.pendingFiles.length + g.changesRequestedFiles.length;
  if (outstanding > 0) return { kind: "pendingReview", count: outstanding };
  if (s.branches.isWorktreeDirty) return { kind: "dirtyWorktree" };
  return null;
}

/**
 * Paths accepted in the current review — what `commit` commits by default (a gitignored mods file cannot be staged, §32).
 * MARK: wave4b w4b-bigturn — §39.1: nor is a large file whose content the review never held (`tooLarge`).
 */
export function acceptedPaths(g: ReviewGate): string[] {
  return g.changedFiles.filter((f) => f.state === "accepted" && f.ignored !== true && f.tooLarge !== true).map((f) => f.path);
}

/**
 * `commit` is available while accepted files exist and no turn / collection / revert is in flight. MARK: wave3
 * check-engine — §37.1: nor while a collection failed (the commit is refused `collect_failed` until the retry).
 */
export function canCommit(s: EngineSlices): boolean {
  const g = s.gate;
  return s.project !== null && !g.running && !g.collecting && !g.reverting && g.collectError === null && acceptedPaths(g).length > 0;
}

export function commitState(s: EngineSlices): CommitState {
  const paths = acceptedPaths(s.gate);
  return {
    lastCommit: s.commit.lastCommit ? { ...s.commit.lastCommit, files: [...s.commit.lastCommit.files] } : null,
    canCommit: canCommit(s),
    acceptedPaths: paths,
    suggestedMessage: suggestCommitMessage(s.commit.lastUserText, paths),
    identity: { ...s.commit.identity },
  };
}

export function prState(pr: PRStore): PRState {
  return {
    host: pr.host,
    mine: pr.mine,
    reviewRequested: pr.reviewRequested,
    selectedSummary: pr.selectedSummary,
    selected: pr.selected,
    files: pr.files,
    comments: pr.comments,
    reviews: pr.reviews,
    draftComments: pr.draftComments,
    accounts: pr.accounts,
    isLoading: pr.isLoading,
    isSubmitting: pr.isSubmitting,
    errorText: pr.errorText,
    lastSubmitResult: pr.lastSubmitResult,
    lastCreatedPR: pr.lastCreatedPR,
  };
}

/** §34.4 (wave2 engine-review): `changedFiles[].sentNoteCount`, present when the file has sent notes. */
function sentNotes(n: number): { sentNoteCount?: number } {
  return n > 0 ? { sentNoteCount: n } : {};
}

/** Derives the wire snapshot; `ReviewState` is always computed from the internal slices. */
export function buildState(s: EngineSlices): ReviewState {
  const g = s.gate;
  return {
    seq: s.seq,
    project: s.project,
    gitInit: s.gitInit,
    session: {
      ...s.session,
      rememberedAllows: [...s.session.rememberedAllows],
      pendingPermissions: s.session.pendingPermissions.map((p) => ({ ...p })),
      pendingPlan: s.session.pendingPlan ? { ...s.session.pendingPlan } : null,
      extensions: s.session.extensions ? structuredClone(s.session.extensions) : null,
      canRestart: canRestart(s),
    },
    toolchain: { ...s.toolchain },
    gate: {
      phase: gatePhase(s),
      canSend: canSend(s),
      canRequestChanges: canRequestChanges(s),
      blockedReason: blockedReason(s),
      collectError: g.collectError,
      pendingCount: g.pendingFiles.length,
      changesRequestedCount: g.changesRequestedFiles.length,
      isRequestingChanges: g.isRequestingChanges,
      turnStartTree: g.turnStartTree,
      turnEndTree: g.turnEndTree,
      lastReviewSummary: g.lastReviewSummary,
      changedOutside: [...g.changedOutside],
      ignoredTouched: [...g.ignoredTouched],
      filteredByPattern: [...g.filteredByPattern],
      restored: g.restored,
      reviewSummary: {
        files: g.changedFiles.length,
        added: g.changedFiles.reduce((n, f) => n + f.added, 0),
        deleted: g.changedFiles.reduce((n, f) => n + f.deleted, 0),
      },
      externalPendingCount: g.externalPendingCount,
      headMoved: g.headMoved ? { from: { ...g.headMoved.from }, to: { ...g.headMoved.to } } : null,
      concurrentClaude: g.concurrentClaude.map((c) => ({ ...c })),
      stale: g.stale ? { ...g.stale, reasons: [...g.stale.reasons], savedHead: g.stale.savedHead ? { ...g.stale.savedHead } : null, head: g.stale.head ? { ...g.stale.head } : null } : null,
      localSettingsChanged: g.localSettingsChanged ? { ...g.localSettingsChanged } : null,
      nestedChanges: g.nestedChanges.map((n) => ({ ...n, head: n.head ? { ...n.head } : null, touchedFiles: [...n.touchedFiles], via: [...n.via] })),
      snapshotSkipped: g.snapshotSkipped.map((s) => ({ ...s })),
      // MARK: wave2 engine-review (§34.1–34.4)
      reviewEndTree: g.reviewEndTree,
      reviewTurns: g.round ? [...g.round.turns] : [],
      lastTurnChanges: g.lastTurnChanges ? { ...g.lastTurnChanges } : null,
      lastRequest: g.lastRequest ? { ...g.lastRequest } : null,
      // MARK: wave3 engine-flow (§36.13)
      prereviews: structuredClone(g.prereviews),
      ...rejectUndoField(g), // MARK: wave4c w4c-trust (§41.2)
    },
    changedFiles: g.changedFiles.map((f) => ({
      ...f,
      tools: [...f.tools],
      toolUseIds: [...f.toolUseIds],
      ...(f.risk ? { risk: [...f.risk] } : {}),
      noteCount: g.noteCount(f.path),
      ...sentNotes(g.sentNoteCount(f.path)),
      origin: originOf(f),
      ...(isModsGroup(f.path) ? { group: "mods" as const } : {}),
      ...fileRiskFields(f), // MARK: wave4b w4b-files — §40.2
    })),
    reviewNotes: g.reviewNotes.map((n) => ({ ...n })),
    budget: { ...s.budget },
    budgetUsage: { ...s.budgetUsage },
    hud: { ...s.hud, activity: { ...s.hud.activity }, agents: s.hud.agents.map((a) => ({ ...a, files: [...a.files] })) },
    // wave3 engine-flow — §36.12: `remotes` always sent by this engine (an older one sends none: clients hide remote bases).
    branches: { list: s.branches.list, isWorktreeDirty: s.branches.isWorktreeDirty, switchBlocker: switchBlocker(s), remotes: (s.branches.remotes ?? []).map((r) => ({ ...r })) },
    pr: prState(s.pr),
    lastError: s.lastError,
    workbenches: { list: s.workbenches.list.map((w) => ({ ...w, locked: w.locked ? { ...w.locked } : null })), current: s.workbenches.current, managedRoot: s.workbenches.managedRoot },
    lockConflict: s.lockConflict ? { ...s.lockConflict } : null,
    commit: commitState(s),
    sessions: { list: s.sessions.list.map((m) => ({ ...m })), currentId: s.sessions.currentId, openTabIds: [...s.sessions.openTabIds] },
    ...(s.storage ? { storage: structuredClone(s.storage) } : {}), // MARK: wave4b w4b-bigturn (§39.1)
    ...(s.project && s.autoAcceptRules && anyAutoAcceptRule(s.autoAcceptRules) ? { autoAcceptRules: normalizeAutoAcceptRules(s.autoAcceptRules) } : {}), // MARK: wave4c w4c-trust (§41.2)
  };
}

/** MARK: wave4c w4c-trust — §41.2: `gate.rejectUndo`, present only while a single-file reject can be (or was) put back. */
function rejectUndoField(g: ReviewGate): { rejectUndo?: NonNullable<ReturnType<ReviewGate["rejectUndoState"]>> } {
  const u = g.rejectUndoState();
  return u ? { rejectUndo: u } : {};
}
