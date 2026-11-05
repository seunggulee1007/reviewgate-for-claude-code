import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { deriveFullFile, type FullFileView } from "../diff/fullfile.js";
import { parseUnifiedDiff, type FileDiff } from "../diff/parse.js";
import { HunkMismatchError, revertHunks } from "../diff/hunks.js";
import type { ChangedFile, GitCheckpoint, SkippedPath } from "../git/checkpoint.js";
import { matchesIgnore } from "../git/ignore.js";
import { isModsGroup, isModsPath, isStubContent, modsRisks } from "../git/mods.js";
import { realpathLenient, relativeInside, toRepoRelative } from "../platform/paths.js";
import type { ToolFileEntry } from "../session/events.js";
import { changeTimeOf, inWindow, isMcpTool, originOf, type ToolWindow } from "../session/provenance.js";
import type { ConcurrentClaude, HeadInfo, HeadMove, LocalSettingsChange, NestedChange, StaleReview, TurnUsage } from "../protocol.js";
import { CommandRefused } from "../errors.js";
import { makeNote, requestChangesMessage, unsentNotesContext, type DiffSide, type ReviewNote } from "./notes.js";
import { REF_TURN_END, REF_TURN_START, turnRefs, type PersistedReview } from "./persist.js";
import { addRoundNotes, completeRound, newRound, setVerdict, syncRound, type HistoryRound, type TurnInfo } from "./history.js";
import type { ReviewHistoryEntry } from "../protocol.js";
// MARK: wave2 engine-review
import type { DiffSince, LastTurnChanges, ReviewRequestInfo } from "../protocol.js";
import { carryNote, keptTurnMarks, rangeRefPrefix, rangeUnavailable, syncRangePins, treeEntryIds, type PersistedRanges } from "./ranges.js";
import { annotateDetail } from "./detail.js";
import { turnDelta, turnPaths, type TurnDelta } from "./turnDelta.js"; // MARK: wave3 check-engine (§37.3)
import { recheckWhitespaceOnly } from "./detail.js"; // MARK: wave3 check-engine (§37.5)
// MARK: wave3 engine-flow
import type { PreReviewRun } from "../protocol.js";
import type { HistoryCommit } from "../protocol.js"; // MARK: wave4 w4-history (§38.3)
import { restoreRuns } from "./prereview.js";
// MARK: wave4c w4c-trust (§41.2)
import type { AutoAcceptedFile, RejectUndoBlock, RejectUndoState } from "../protocol.js";
import type { RoundFile } from "./history.js";

/**
 * `turn` (§34.3, wave2 engine-review): what the collected turn itself changed — the listed files whose content its own start
 * tree → B changed, their numbers and how many of them nothing of Claude's explains; `merged`: a question / request-changes
 * follow-up merged into a standing review.
 */
export type CollectResult = { files: ChangedFile[]; added: number; deleted: number; turn: TurnChanges; merged: boolean }
  // MARK: wave3 check-engine — §37.3: the turn's own delta (start tree → B, unfiltered), for the engine's §26 record.
  & { delta: TurnDelta };
export type TurnChanges = { files: ChangedFile[]; added: number; deleted: number; external: number };

export type PendingCollect = { toolFiles: ToolFileEntry[]; stopReason: string; usage: TurnUsage | null; windows?: ToolWindow[] };

export type PreparedRequestChanges = { message: string; checkpointTree: string; endTree: string };

// MARK: wave2 engine-why
/**
 * §34.7 / §34.8: what `ReviewGate.annotateFiles` gets for every rebuilt review list — `files` (A → B, about to become
 * `changedFiles`), `previous` (the list it replaces; a restore: the saved one) and why it was rebuilt.
 */
export type AnnotateArgs = { cp: GitCheckpoint; files: ChangedFile[]; start: string; end: string; previous: readonly ChangedFile[]; reason: "collect" | "refresh" | "restore" }
  // MARK: wave3 check-engine — §37.3: at a collection, the paths the turn's own delta touched (`turnPaths`, both names of a rename).
  & { turnPaths?: ReadonlySet<string> };

/** Maximum hunk lines `file_diff` carries; longer diffs are cut and flagged `truncated`. */
export const FILE_DIFF_MAX_LINES = 20_000;
/** MARK: wave4b w4b-bigturn — §39.1: above this many files the reject checks read whole trees once (`worktreeMatchesMany`). */
const BATCH_CHECK_MIN = 8;

/**
 * The per-turn review gate (port of the review half of Core `Session/SessionStore.swift`):
 * snapshot A before a send, snapshot B + changed-file list after the turn, accept / reject
 * (revert on disk, re-snapshot B), notes + request-changes (A kept, accepted patches hashed),
 * collect failure + retry. Owns the diff cache, invalidated whenever `turnEndTree` changes.
 */
export class ReviewGate {
  checkpoint: GitCheckpoint | null = null;
  /** Live view of the client's ignore patterns (applied at collection time, like the Swift store). */
  ignorePatterns: () => string[] = () => [];
  /** Called after every mutation of the persisted part of the gate (engine → `reviewgate-review.json`). */
  onChange: () => void = () => {};
  /** A review round ended (docs/PROTOCOL.md §14); the engine appends it to the history and pins its trees. */
  onRoundComplete: (entry: ReviewHistoryEntry) => void = () => {};
  /** Ref namespace of this worktree (`refNamespace()`): A / B are pinned under `refs/reviewgate/<ns>/`. */
  refNs = "main";

  running = false;
  /** True while the end-of-turn snapshot/diff is being computed (input stays disabled). */
  collecting = false;
  /** True while a reject is reverting files on disk. */
  reverting = false;
  /** Non-null when the end-of-turn snapshot/diff failed: the gate stays closed until `retryCollect()` succeeds. */
  collectError: string | null = null;

  turnStartTree: string | null = null;
  turnEndTree: string | null = null;
  changedFiles: ChangedFile[] = [];
  reviewNotes: ReviewNote[] = [];
  /** True from `prepareRequestChanges` until the follow-up turn's review list is rebuilt: A is kept. */
  isRequestingChanges = false;
  /**
   * True from a plain `send` issued while files still await review until that turn's list is rebuilt:
   * sending answers a question, so A is kept and the answer turn merges into the SAME review list
   * (docs/PROTOCOL.md §10). Nothing is accepted, rejected or dropped by sending.
   */
  isAnsweringReview = false;
  /** Arguments of the last `finishTurn` whose collection failed; replayed by `retryCollect()`. */
  pendingCollect: PendingCollect | null = null;
  /** Edits outside the checkpoint root the user approved this turn (from `turn_end.changedOutside`). */
  changedOutside: string[] = [];
  /** Repo-relative paths the turn's edit tools touched that are gitignored (invisible to the snapshot). */
  ignoredTouched: string[] = [];
  /** Repo-relative changed paths hidden from `changedFiles` by the ignore patterns. */
  filteredByPattern: string[] = [];
  /** True after `restore()` rebuilt the review from the persisted file; cleared by `beginTurn()`. */
  restored = false;
  /** §31: HEAD / the branch moved while the last turn ran (set by the engine after the collection); cleared by `beginTurn()`. */
  headMoved: HeadMove | null = null;
  /**
   * HEAD when A was snapshotted. Commits that land outside the app while the review stands (a pull, a merge, the user's
   * own commit, a checkout) are carried into A by `followHead`, so they never show up as Claude's changes.
   */
  baseHead: HeadInfo | null = null;
  /**
   * §46: the `MERGE_HEAD` of an unfinished merge whose incoming side A already holds — carried by `carryGitMoves`, or on disk
   * when A was snapshotted — so it is never carried twice.
   */
  baseMerge: string | null = null;
  /** `baseHead` of the review a fresh `snapshotStart` replaced (back on `abortTurn`). */
  private freshUndoBaseHead: HeadInfo | null = null;
  /** §31: other Claude processes in this worktree (the engine re-checks on open and on every send). */
  concurrentClaude: ConcurrentClaude[] = [];
  /** §31: the restored review is stale (set by the engine's restore); cleared by `keep_review`, `finish_review` and the next turn. */
  stale: StaleReview | null = null;
  /** §32: `.claude/settings.local.json` changed during the last turn (set by the engine); cleared by `beginTurn()`. */
  localSettingsChanged: LocalSettingsChange | null = null;
  /** §32: nested repositories the last turn changed (set by the engine); cleared by `beginTurn()`. */
  nestedChanges: NestedChange[] = [];
  /** §32 (robustness-09): what this turn's snapshots (A, B) had to leave out; cleared by `beginTurn()`. */
  snapshotSkipped: SkippedPath[] = [];

  // MARK: wave3 engine-flow
  /**
   * §36.13: the AI pre-reviews of the review in progress (`review/prereview.ts` writes them), newest first, ≤ 5; stored
   * with the review, restored with it, gone when the round ends (`completeRound`, which `finish_review` runs too).
   */
  prereviews: PreReviewRun[] = [];

  // MARK: wave2 engine-why
  /**
   * §34.7 / §34.8: runs on every rebuilt list (collection, refresh, restore) right after the mods annotation, before it
   * replaces `changedFiles`: sets `generated` / `whitespaceOnly` on `files` (the default), and — as the engine wires it —
   * `why`. Must never throw (a failed annotation leaves the files without it).
   */
  annotateFiles: (args: AnnotateArgs) => Promise<void> = (args) => annotateDetail(args.cp, args.files, args.start, args.end);

  private acceptedPaths: string[] = [];
  private rejectedPaths: string[] = [];
  /** Files `reject_hunks` partly reverted since the last send (→ `lastReviewSummary`). */
  private partiallyRejectedPaths: string[] = [];
  /**
   * SHA-256 of the patch of every file accepted before `requestChanges`; files whose patch is
   * unchanged after the follow-up turn are pre-marked accepted again.
   */
  private acceptedPatchHashes = new Map<string, string>();
  /** B as it was when an answer turn started, so `abortTurn()` can put the review back the way it was. */
  private answerEndTree: string | null = null;
  private diffCache = new Map<string, FileDiff>();
  /** The review-history round in progress (null between rounds). */
  round: HistoryRound | null = null;
  /** The running turn, for the round's `turns` / prompt (set by `beginTurn`). */
  private turnInfo: TurnInfo | null = null;
  /** `round.notes.length` before `prepareRequestChanges` added the request's notes (undone on a failed send). */
  private roundNotesBefore = 0;
  // MARK: wave2 check-engine
  /**
   * §35.9: after `restore()`, the B the review was saved with and the files restored from its list: what was reviewed
   * there is that B's content, not the fresh snapshot's (which holds what changed while the app was closed). Cleared by
   * the next collection, `refresh`, `finish_review` and `reset`.
   */
  private restoredFrom: { tree: string; paths: Set<string> } | null = null;

  // MARK: wave2 engine-review — §34.1–34.5 trees, ranges and request bookkeeping
  /**
   * §34.2: the B a `send` / `request_changes` on a standing review cleared (`turnEndTree = null`): the list, every diff and
   * `blob` keep referring to it while the turn runs or is collected; the collection replaces it. Null for a fresh turn.
   */
  heldEndTree: string | null = null;
  /** §34.1: the last collected turn's own start tree (`since: "turn"`); = A for a fresh turn. */
  turnBaseTree: string | null = null;
  /** §34.1: the running turn's own start tree (the engine's §26 record); becomes `turnBaseTree` at its collection. */
  private runningTurnBase: string | null = null;
  /** §34.3: what the last collected turn itself changed; null before a review's first collection. */
  lastTurnChanges: LastTurnChanges | null = null;
  /** §34.4: B when the last `request_changes` of this review was sent (`since: "request"`), and what it sent. */
  requestTree: string | null = null;
  lastRequest: ReviewRequestInfo | null = null;
  /** §34.1: per file, B when it was accepted — the held B for an accept during a turn (`since: "accepted"`). */
  private acceptedTrees = new Map<string, string>();
  /** §34.2: files accepted while the running turn ran: a turn that changes them takes them out of `acceptedPaths` again. */
  private acceptedDuringTurn = new Set<string>();
  /** What `prepareRequestChanges` changed, for `undoRequestChanges`. */
  private requestUndo: { sent: string[]; requestTree: string | null; lastRequest: ReviewRequestInfo | null; changedSinceRequest: string[] } | null = null;
  /** Range diffs by base / end tree / path (trees never change, so entries never go stale; bounded). */
  private rangeCache = new Map<string, FileDiff>();

  // MARK: wave3 check-engine
  /**
   * §37.8: what a fresh `snapshotStart` replaced (A, B, the ranges, what A left out) — `abortTurn` puts it back when the turn
   * is called off before it ran (a refused `peer_accept`, a session gone right after A); its collection drops it.
   */
  private freshUndo: { start: string | null; end: string | null; skipped: SkippedPath[]; ranges: RangeState; baseMerge: string | null } | null = null;

  reset(): void {
    this.restoredFrom = null; // MARK: wave2 check-engine (§35.9)
    this.freshUndo = null; // MARK: wave3 check-engine (§37.8)
    this.running = false;
    this.collecting = false;
    this.reverting = false;
    this.collectError = null;
    this.turnStartTree = null;
    this.turnEndTree = null;
    this.baseHead = null;
    this.baseMerge = null;
    this.changedFiles = [];
    this.reviewNotes = [];
    this.isRequestingChanges = false;
    this.isAnsweringReview = false;
    this.pendingCollect = null;
    this.acceptedPaths = [];
    this.rejectedPaths = [];
    this.partiallyRejectedPaths = [];
    this.acceptedPatchHashes = new Map();
    this.answerEndTree = null;
    this.diffCache = new Map();
    this.changedOutside = [];
    this.ignoredTouched = [];
    this.filteredByPattern = [];
    this.restored = false;
    this.headMoved = null;
    this.concurrentClaude = [];
    this.stale = null;
    this.localSettingsChanged = null;
    this.nestedChanges = [];
    this.snapshotSkipped = [];
    this.round = null;
    this.turnInfo = null;
    this.resetRanges();
    this.prereviews = []; // MARK: wave3 engine-flow (§36.13)
    // MARK: wave4c w4c-trust (§41.2)
    this.lastReject = null;
    this.rejectedBefore.clear();
  }

  /** Per-turn signals (`changedOutside`, `ignoredTouched`, `filteredByPattern`, `restored`, `headMoved`, `stale`) are cleared when a turn starts. */
  beginTurn(info: TurnInfo | null = null): void {
    this.lastReject = null; // MARK: wave4c w4c-trust — §41.2: a new turn ends the reject undo
    this.turnInfo = info;
    this.changedOutside = [];
    this.ignoredTouched = [];
    this.filteredByPattern = [];
    this.restored = false;
    this.headMoved = null;
    this.stale = null;
    this.localSettingsChanged = null;
    this.nestedChanges = [];
    this.snapshotSkipped = [];
  }

  // MARK: - Persistence (docs/PROTOCOL.md §8)

  /** The persisted part of the gate; `lastUserText` / `sessionId` / `savedAt` are filled in by the engine. */
  persisted(): Omit<PersistedReview, "lastUserText" | "sessionId" | "savedAt"> {
    return {
      version: 1,
      turnStartTree: this.turnStartTree,
      turnEndTree: this.turnEndTree,
      changedFiles: this.changedFiles.map((f) => ({ ...f, tools: [...f.tools], toolUseIds: [...f.toolUseIds] })),
      reviewNotes: this.reviewNotes.map((n) => ({ ...n })),
      acceptedPatchHashes: Object.fromEntries(this.acceptedPatchHashes),
      acceptedPaths: [...this.acceptedPaths],
      rejectedPaths: [...this.rejectedPaths],
      partiallyRejectedPaths: [...this.partiallyRejectedPaths],
      lastReviewSummary: this.lastReviewSummary,
      isRequestingChanges: this.isRequestingChanges,
      isAnsweringReview: this.isAnsweringReview,
      round: this.round ? structuredClone(this.round) : null,
      modsCaptured: true,
      baseHead: this.baseHead,
      baseMerge: this.baseMerge,
      ranges: this.persistedRanges(),
      prereviews: structuredClone(this.prereviews), // MARK: wave3 engine-flow (§36.13)
    };
  }

  /**
   * Ends the review round in progress (docs/PROTOCOL.md §14) and hands it to `onRoundComplete`.
   * Called when a fresh `send` takes a new snapshot A, when nothing is left to review, and by the
   * engine on `close_project` of a resolved review.
   */
  completeRound(finished = false): void {
    this.prereviews = []; // MARK: wave3 engine-flow — §36.13: a round's pre-reviews end with it
    const round = this.round;
    this.round = null;
    if (!round) return;
    const entry = completeRound(round, undefined, finished);
    if (entry) this.onRoundComplete(entry);
  }

  /**
   * `finish_review` (docs/PROTOCOL.md §31): the review list and its notes go, nothing on disk is touched. Files still
   * pending stay in the worktree as they are (uncommitted) and are part of the next turn's snapshot A — the
   * baseline, no longer a review; the round goes to the history with them `pending` (`finished`). The accept /
   * reject verdicts of a live review still prefix the next message; those of a stale restored one (§31) belong to an
   * old conversation and are dropped.
   */
  finishReview(): void {
    this.lastReject = null; // MARK: wave4c w4c-trust (§41.2)
    this.restoredFrom = null; // MARK: wave2 check-engine (§35.9)
    if (this.stale !== null) {
      this.acceptedPaths = [];
      this.rejectedPaths = [];
      this.partiallyRejectedPaths = [];
    }
    if (this.turnStartTree !== null && this.turnEndTree !== null) this.trackRound(null);
    this.completeRound(true);
    this.turnStartTree = null;
    this.turnEndTree = null;
    this.baseHead = null;
    this.baseMerge = null;
    this.changedFiles = [];
    this.reviewNotes = [];
    this.acceptedPatchHashes = new Map();
    this.isAnsweringReview = false;
    this.answerEndTree = null;
    this.diffCache = new Map();
    this.restored = false;
    this.stale = null;
    this.resetRanges();
    this.onChange();
  }

  /** Re-syncs the round with the current list (creating it on the first collection with files). */
  private trackRound(turn: number | null): void {
    const start = this.turnStartTree;
    const end = this.turnEndTree;
    if (start === null || end === null) return;
    if (!this.round) {
      if (this.changedFiles.length === 0) return;
      this.round = newRound(this.turnInfo, start, end);
    }
    syncRound(this.round, this.changedFiles, end, turn);
  }

  /** The CLI reported another id for the session the round belongs to (engine adoptReportedSessionId). */
  renameSession(from: string, to: string): void {
    if (this.round?.sessionId === from) this.round.sessionId = to;
    if (this.turnInfo?.sessionId === from) this.turnInfo = { ...this.turnInfo, sessionId: to };
  }

  private completeRoundIfResolved(): void {
    if (this.isFullyResolved) {
      this.completeRound();
      this.resetRanges(); // §34.1: the round is over — so are its ranges
    }
  }

  /** Nothing left to review, commit or send back: the persisted review can be deleted. */
  get isFullyResolved(): boolean {
    return !this.running && this.changedFiles.length === 0 && this.reviewNotes.length === 0 && !this.isRequestingChanges;
  }

  /**
   * Rebuilds the review from a persisted file (audit 1.3): A must still be pinned by
   * `refs/reviewgate/turn-start`; B is a fresh snapshot, so every saved file is re-verified against
   * `diff-tree A B` (files whose diff is empty now are dropped, changes that appeared since — e.g. the
   * turn that was running when the engine died — are added as pending). Returns false when nothing
   * could be restored.
   */
  async restore(saved: PersistedReview): Promise<boolean> {
    const cp = this.requireCheckpoint();
    const pinnedStart = saved.turnStartTree;
    // The per-worktree pin, or the shared pre-namespace one written by an older engine (migrated by pinRefs below).
    if (pinnedStart === null || !((await cp.refIs(turnRefs(this.refNs).start, pinnedStart)) || (await cp.refIs(REF_TURN_START, pinnedStart)))) return false;
    // §32: an A snapshotted before mods were captured gains today's mods entries (no phantom additions).
    const start = saved.modsCaptured === true ? pinnedStart : await cp.withMods(pinnedStart);
    const ignore = this.ignorePatterns();
    const end = await cp.snapshot(ignore);
    const current = await cp.dropIgnoredDeletions((await cp.changes(start, end)).filter((f) => !hiddenBy(f, ignore)));
    const byPath = new Map(current.map((f) => [f.path, f]));
    const files: ChangedFile[] = [];
    for (const old of saved.changedFiles) {
      const cur = byPath.get(old.path);
      if (!cur) continue;
      byPath.delete(old.path);
      let state = old.state === "changesRequested" ? "pending" : old.state;
      if (saved.isRequestingChanges || saved.isAnsweringReview) {
        // Same rule as finishTurn: a file accepted before the turn stays accepted only when its patch is unchanged.
        const hash = saved.acceptedPatchHashes[old.path];
        if (state === "accepted") state = "pending";
        if (hash !== undefined && patchHash(await cp.patch(start, end, cur.path, cur.oldPath)) === hash) state = "accepted";
      }
      // `toolUseIds` is absent in reviews persisted before it existed.
      files.push({ ...cur, ...partialOf(old), ...keptTurnMarks(old), tools: [...old.tools], toolUseIds: [...(old.toolUseIds ?? [])], state, ...(old.state === "accepted" && state !== "accepted" ? { changedSinceAccepted: true as const } : {}) });
    }
    for (const f of byPath.values()) files.push(f);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (files.length === 0) return false;
    carryAutoAccepted(files, saved.changedFiles); // MARK: wave4c w4c-trust (§41.2)
    this.lastReject = null;
    await annotateMods(cp, files, start, end);
    await annotateLarge(cp, files, start, end); // MARK: wave4b w4b-bigturn (§39.1)
    await this.annotateFiles({ cp, files, start, end, previous: saved.changedFiles, reason: "restore" });
    const paths = new Set(files.map((f) => f.path));
    // MARK: wave2 check-engine — §35.9: what was reviewed of the saved files is the saved B's content.
    const savedEnd = saved.turnEndTree;
    const fromList = new Set(saved.changedFiles.map((f) => f.path).filter((p) => paths.has(p)));
    this.restoredFrom = savedEnd !== null && fromList.size > 0 && (await cp.hasObjects([savedEnd])) ? { tree: savedEnd, paths: fromList } : null;
    this.turnStartTree = start;
    this.turnEndTree = end;
    this.baseHead = saved.baseHead ?? null;
    this.baseMerge = saved.baseMerge ?? null;
    this.changedFiles = files;
    this.reviewNotes = saved.reviewNotes.filter((n) => paths.has(n.path)).map((n) => ({ ...n }));
    this.acceptedPaths = saved.acceptedPaths.filter((p) => paths.has(p) && files.find((f) => f.path === p)?.state === "accepted");
    this.rejectedPaths = [...saved.rejectedPaths];
    this.partiallyRejectedPaths = (saved.partiallyRejectedPaths ?? []).filter((p) => paths.has(p));
    this.acceptedPatchHashes = new Map();
    this.isRequestingChanges = false;
    this.isAnsweringReview = false;
    this.answerEndTree = null;
    this.pendingCollect = null;
    this.collectError = null;
    this.running = false;
    this.diffCache = new Map();
    this.restored = true;
    this.round = saved.round ? structuredClone(saved.round) : null;
    if (!this.round) this.round = newRound(null, start, end, saved.lastUserText);
    syncRound(this.round, this.changedFiles, end, null);
    this.prereviews = restoreRuns(saved.prereviews); // MARK: wave3 engine-flow (§36.13)
    await this.restoreRanges(cp, saved, end);
    await this.pinRefs();
    this.onChange();
    return true;
  }

  /**
   * HEAD moved since A (`baseHead`) while the review stands — a pull, a merge, a commit or a checkout outside the app: the
   * commits' changes (`baseHead..HEAD`) are applied to A, so the list keeps only what Claude changed — and so is the
   * incoming side of a merge still in progress (§46, `carryGitMoves`). Call `refresh()` after a true. When the commits do
   * not apply on A (they overlap uncommitted changes), A stays and `headMoved` says so.
   */
  async followHead(): Promise<boolean> {
    const cp = this.checkpoint;
    const start = this.turnStartTree;
    if (!cp || start === null || this.turnEndTree === null || !this.baseHead?.sha || this.running || this.collecting || this.reverting) return false;
    const [carried] = await this.carryGitMoves(cp, [start]);
    if (carried === start) return false;
    this.turnStartTree = carried!;
    if (this.round) this.round.turnStartTree = carried!;
    this.diffCache = new Map();
    await this.pinRefs();
    return true;
  }

  /**
   * `trees` with what git brought in since A was snapshotted carried into each: the commits since `baseHead` (a pull, a
   * merge, a commit — into all of them or none; else `headMoved` says so), then §46 the incoming side of an unfinished merge
   * (`merge-base(HEAD, MERGE_HEAD)..MERGE_HEAD`, once per `MERGE_HEAD`): a file whose change conflicts keeps its content,
   * so Claude's resolution of it stays in the review. When even that does not apply, the trees stay as they are.
   */
  private async carryGitMoves(cp: GitCheckpoint, trees: string[]): Promise<string[]> {
    let out = trees;
    const base = this.baseHead;
    const head = await cp.head().catch(() => null);
    if (base?.sha && head?.sha && head.sha !== base.sha) {
      const carried = await Promise.all(out.map((t) => this.carryHeadMove(cp, t, base.sha!, head.sha!).catch(() => null)));
      this.baseHead = head;
      if (carried.every((t) => t !== null)) out = carried as string[];
      else {
        this.headMoved = { from: { ...base }, to: { ...head } };
        this.onChange();
      }
    } else if (base && head?.sha && head.branch !== base.branch) this.baseHead = head;
    const merge = await cp.mergeInProgress().catch(() => null);
    if (merge && merge.head !== this.baseMerge) {
      this.baseMerge = merge.head;
      const carried = await Promise.all(out.map((t) => cp.carryCommits(t, merge.base, merge.head, { keepConflicts: true }).catch(() => null)));
      if (carried.every((t) => t !== null)) out = carried as string[];
    } else if (!merge && this.baseMerge) {
      // The merge is over. Committed (HEAD moved): the commits above carried it. Aborted (HEAD where it was): A still holds
      // its incoming side — take it back out, else every file it brought in would show as Claude undoing it.
      const ended = this.baseMerge;
      this.baseMerge = null;
      const mb = head?.sha && head.sha === base?.sha ? await cp.mergeBase(head.sha, ended).catch(() => null) : null;
      if (mb) {
        const back = await Promise.all(out.map((t) => cp.carryCommits(t, ended, mb, { keepConflicts: true }).catch(() => null)));
        if (back.every((t) => t !== null)) out = back as string[];
      }
    }
    return out;
  }

  /**
   * §46: `tree` with HEAD's move `from` → `to` carried in. Along first parents a merge commit brings in only its other side
   * (`merge-base..other parent`, a conflicting file keeping `tree`'s content) — the resolutions committed with it, and
   * whatever else was staged, stay in the review; any other commit is carried whole. When `to` does not get back to
   * `from` along first parents (a checkout elsewhere, a rebase), the whole `from..to`.
   */
  private async carryHeadMove(cp: GitCheckpoint, tree: string, from: string, to: string): Promise<string | null> {
    const chain = await cp.firstParentChain(from, to);
    if (!chain || !chain.some((c) => c.parents.length === 2)) return cp.carryCommits(tree, from, to);
    let t: string | null = tree;
    let rangeFrom = from;
    for (const c of chain) {
      if (c.parents.length !== 2) continue;
      const [p1, p2] = c.parents as [string, string];
      const mb = await cp.mergeBase(p1, p2);
      if (!mb) return cp.carryCommits(tree, from, to);
      if (rangeFrom !== p1) t = await cp.carryCommits(t, rangeFrom, p1);
      if (t !== null) t = await cp.carryCommits(t, mb, p2, { keepConflicts: true });
      if (t === null) return null;
      rangeFrom = c.sha;
    }
    return rangeFrom === to ? t : cp.carryCommits(t, rangeFrom, to);
  }

  /**
   * `refresh` while reviewing (docs/M15-POLISH.md): B is re-snapshotted and the list re-diffed against
   * the same A — external edits appear, files whose diff became empty are dropped (with their notes),
   * new files appear pending; reviewed states and `tools[]` are kept. Returns false when not reviewing.
   */
  async refresh(opts: { repend?: ReadonlySet<string> } = {}): Promise<boolean> {
    const cp = this.checkpoint;
    const start = this.turnStartTree;
    if (!cp || start === null || this.turnEndTree === null || this.running || this.collecting || this.reverting) return false;
    const ignore = this.ignorePatterns();
    const end = await cp.snapshot(ignore);
    const hidden = (f: ChangedFile) => hiddenBy(f, ignore);
    const all = await cp.changes(start, end);
    const byPath = new Map((await cp.dropIgnoredDeletions(all.filter((f) => !hidden(f)))).map((f) => [f.path, f]));
    const files: ChangedFile[] = [];
    for (const old of this.changedFiles) {
      const cur = byPath.get(old.path);
      if (!cur) continue;
      byPath.delete(old.path);
      // `repend` (§26 file rewind): files whose content the engine itself just replaced are reviewed again.
      const state = opts.repend?.has(old.path) && old.state === "accepted" ? "pending" : old.state;
      files.push({ ...cur, ...partialOf(old), ...keptTurnMarks(old), tools: [...old.tools], toolUseIds: [...old.toolUseIds], state, ...(old.state === "accepted" && state !== "accepted" ? { changedSinceAccepted: true as const } : {}) });
    }
    for (const f of byPath.values()) files.push(f);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    carryAutoAccepted(files, this.changedFiles); // MARK: wave4c w4c-trust (§41.2)
    await annotateMods(cp, files, start, end);
    await annotateLarge(cp, files, start, end); // MARK: wave4b w4b-bigturn (§39.1)
    await this.annotateFiles({ cp, files, start, end, previous: this.changedFiles, reason: "refresh" });
    await this.followB(cp, files, this.turnEndTree, end);
    const paths = new Set(files.map((f) => f.path));
    if (opts.repend) {
      this.acceptedPaths = this.acceptedPaths.filter((p) => !opts.repend!.has(p));
      for (const p of opts.repend) this.acceptedPatchHashes.delete(p);
    }
    this.turnEndTree = end;
    this.changedFiles = files;
    this.reviewNotes = this.reviewNotes.filter((n) => paths.has(n.path));
    this.acceptedPaths = this.acceptedPaths.filter((p) => paths.has(p));
    for (const p of [...this.acceptedPatchHashes.keys()]) if (!paths.has(p)) this.acceptedPatchHashes.delete(p);
    this.filteredByPattern = all.filter(hidden).map((f) => f.path);
    this.diffCache = new Map();
    this.restoredFrom = null; // MARK: wave2 check-engine — §35.9: the refreshed diff is what the user reviews now
    this.trackRound(null);
    this.completeRoundIfResolved();
    this.onChange();
    return true;
  }

  /**
   * `refs/reviewgate/<ns>/turn-start` / `turn-end` follow A / B (deleted when null) so `git gc` keeps
   * the trees. The shared pre-namespace refs are dropped once they point at our own trees (migration).
   */
  async pinRefs(): Promise<void> {
    const cp = this.checkpoint;
    if (!cp) return;
    const refs = turnRefs(this.refNs);
    await cp.pinRef(refs.start, this.turnStartTree);
    await cp.pinRef(refs.end, this.turnEndTree);
    await this.dropLegacyRefs(cp);
  }

  async unpinRefs(): Promise<void> {
    const cp = this.checkpoint;
    if (!cp) return;
    const refs = turnRefs(this.refNs);
    const start = await cp.refValue(refs.start);
    const end = await cp.refValue(refs.end);
    await cp.pinRef(refs.start, null);
    await cp.pinRef(refs.end, null);
    await this.dropLegacyRefs(cp, [start, end, this.turnStartTree, this.turnEndTree]);
    await cp.deleteRefsUnder(rangeRefPrefix(this.refNs)); // §34.1: the range pins go with the review
  }

  /** Deletes `refs/reviewgate/turn-start|end` (shared by every worktree) only when they hold one of our trees. */
  private async dropLegacyRefs(cp: GitCheckpoint, ours: (string | null)[] = [this.turnStartTree, this.turnEndTree]): Promise<void> {
    const mine = new Set(ours.filter((t): t is string => t !== null));
    for (const ref of [REF_TURN_START, REF_TURN_END]) {
      const v = await cp.refValue(ref);
      if (v !== null && mine.has(v)) await cp.pinRef(ref, null);
    }
  }

  // MARK: - Derived

  get pendingFiles(): ChangedFile[] {
    return this.changedFiles.filter((f) => f.state === "pending");
  }

  /** Files sent back with notes by request-changes; they keep the gate closed like pending ones. */
  get changesRequestedFiles(): ChangedFile[] {
    return this.changedFiles.filter((f) => f.state === "changesRequested");
  }

  get hasPendingReview(): boolean {
    return this.pendingFiles.length > 0 || this.changesRequestedFiles.length > 0;
  }

  /** §31: pending files nothing of Claude's explains (`reject_all` leaves them out unless `includeExternal`). */
  get externalPendingCount(): number {
    return this.pendingFiles.reduce((n, f) => (originOf(f) === "external" ? n + 1 : n), 0);
  }

  /** What `reject_all` reverts: every pending file Claude changed, the external ones too only with `includeExternal` (§31). */
  rejectAllPaths(includeExternal = false): string[] {
    return this.pendingFiles.filter((f) => includeExternal || originOf(f) !== "external").map((f) => f.path);
  }

  /** Nothing is in flight: a message can be sent (a standing review does not close the input). */
  get isSettled(): boolean {
    return !this.running && !this.collecting && !this.reverting && this.collectError === null;
  }

  /** Prefix sent with the next user message once a review round has been completed. */
  get lastReviewSummary(): string | null {
    if (this.acceptedPaths.length === 0 && this.rejectedPaths.length === 0 && this.partiallyRejectedPaths.length === 0) return null;
    const parts: string[] = [];
    if (this.acceptedPaths.length > 0) parts.push(`Accepted: ${this.acceptedPaths.join(", ")}.`);
    if (this.rejectedPaths.length > 0) {
      parts.push(`Rejected (reverted on disk, do not redo unless asked): ${this.rejectedPaths.join(", ")}.`);
    }
    const partial = this.partiallyRejectedPaths.filter((p) => !this.rejectedPaths.includes(p));
    if (partial.length > 0) {
      parts.push(`Partially rejected (some hunks reverted on disk, do not redo them unless asked): ${partial.join(", ")}.`);
    }
    return "[Review gate] " + parts.join(" ");
  }

  /** §34.4: the file's unsent notes (`sentNoteCount` counts the ones `request_changes` already sent). */
  noteCount(path: string): number {
    return this.reviewNotes.reduce((n, note) => (note.path === path && !note.sent ? n + 1 : n), 0);
  }

  // MARK: - Turn start

  /**
   * A plain `send` while files still await review: the user is asking a question, not reviewing, so
   * the review survives untouched. Records the patch hashes of the already-accepted files (same rule
   * as `prepareRequestChanges`) and marks the turn so A is kept and the list is merged, not replaced.
   * A no-op when nothing is under review (unless `carry`, §52). Call before `beginSend()`.
   */
  async prepareAnswer(carry = false): Promise<void> {
    const cp = this.checkpoint;
    const start = this.turnStartTree;
    const end = this.turnEndTree;
    // §52 `carry`: a background process may have written since B — the turn keeps A even with nothing pending, so what it
    // wrote reaches this turn's review instead of a fresh A (accepted files whose patch is unchanged stay accepted).
    if ((!this.hasPendingReview && !carry) || !cp || start === null || end === null) return;
    this.acceptedPatchHashes = await this.hashAccepted(cp, start, end);
    this.answerEndTree = end;
    this.heldEndTree = end; // §34.2: still what the review shows while the answer runs
    this.isAnsweringReview = true;
    this.onChange();
  }

  /**
   * Builds the outgoing text (review-summary prefix consumed), clears the notes and closes the gate.
   * An answer turn (`prepareAnswer()`) keeps the notes: they belong to the review it leaves standing.
   * Follow with `snapshotStart()`; on failure call `abortTurn()`.
   */
  beginSend(trimmed: string, keepSummary = false): string {
    // A fresh snapshot A follows: the previous review round is over (accepted files stay on disk).
    if (!this.isAnsweringReview && !this.isRequestingChanges) this.completeRound();
    let outgoing = trimmed;
    // `keepSummary`: a slash command (`/compact`, §27) must start with "/" — the summary waits for the next real message.
    const summary = keepSummary ? null : this.lastReviewSummary;
    if (summary !== null) {
      outgoing = summary + "\n\n" + trimmed;
      this.acceptedPaths = [];
      this.rejectedPaths = [];
      this.partiallyRejectedPaths = [];
    }
    // A question during a review: the unsent notes go along as context ("메모 반영해줘"); they stay unsent.
    const unsent = this.isAnsweringReview && !keepSummary ? this.reviewNotes.filter((n) => !n.sent) : [];
    if (unsent.length > 0) outgoing += "\n\n" + unsentNotesContext(unsent);
    this.lastReject = null; // MARK: wave4c w4c-trust — §41.2: sending ends the reject undo
    if (!this.isAnsweringReview) this.reviewNotes = [];
    this.running = true;
    return outgoing;
  }

  /** `snapshotStart()` will keep the current A (a change request / an answer to a standing review). */
  get keepsTurnStart(): boolean {
    return (this.isRequestingChanges || this.isAnsweringReview) && this.turnStartTree !== null;
  }

  /** Snapshot A (kept while a change request or an answer to a standing review is in flight); clears B. */
  async snapshotStart(): Promise<string> {
    const cp = this.requireCheckpoint();
    const keep = (this.isRequestingChanges || this.isAnsweringReview) && this.turnStartTree !== null;
    let tree = this.turnStartTree!;
    if (!keep) {
      const snap = await cp.snapshotDetailed(this.ignorePatterns());
      tree = snap.tree;
      // MARK: wave3 check-engine — §37.8: kept until the turn is collected, for an `abortTurn` before it ran.
      this.freshUndo = { start: this.turnStartTree, end: this.turnEndTree, skipped: this.snapshotSkipped, ranges: this.rangeState(), baseMerge: this.baseMerge };
      this.snapshotSkipped = snap.skipped;
      this.resetRanges(); // §34: a fresh A starts a new review — no held B, no ranges of the old one
      this.freshUndoBaseHead = this.baseHead;
      this.baseHead = await cp.head().catch(() => null);
      // §46: a merge already under way is on disk, so A holds its incoming side.
      this.baseMerge = (await cp.mergeInProgress().catch(() => null))?.head ?? null;
    }
    this.turnStartTree = tree;
    this.turnEndTree = null;
    this.onChange();
    return tree;
  }

  /** The send failed: reopen the gate and put an answer turn's review back the way it was. */
  abortTurn(): void {
    if (this.isAnsweringReview) {
      this.isAnsweringReview = false;
      this.acceptedPatchHashes = new Map();
      if (this.turnEndTree === null) this.turnEndTree = this.answerEndTree;
      this.answerEndTree = null;
      this.heldEndTree = null;
      this.onChange();
    }
    // MARK: wave3 check-engine — §37.8: a fresh start called off — the review it replaced comes back (A, B, ranges).
    const undo = this.freshUndo;
    this.freshUndo = null;
    if (undo && this.turnEndTree === null) {
      this.baseHead = this.freshUndoBaseHead;
      this.baseMerge = undo.baseMerge;
      this.turnStartTree = undo.start;
      this.turnEndTree = undo.end;
      this.snapshotSkipped = undo.skipped;
      this.restoreRangeState(undo.ranges);
      this.diffCache = new Map();
      this.onChange();
    }
    this.runningTurnBase = null;
    this.running = false;
  }

  // MARK: - Turn end

  /**
   * Snapshots the working tree after a turn and builds the review list. Throws on failure, in which
   * case the gate stays closed (`collectError`) until `retryCollect()` succeeds.
   */
  async finishTurn(toolFiles: ToolFileEntry[], stopReason: string, usage: TurnUsage | null, windows: ToolWindow[] = []): Promise<CollectResult | null> {
    const cp = this.checkpoint;
    let start = this.turnStartTree;
    if (!cp || start === null || this.turnEndTree !== null) return null;
    this.collecting = true;
    // §34 (wave2 engine-review): the list the turn started on, and whether the turn merges into it.
    const merged = this.isAnsweringReview || this.isRequestingChanges;
    const before = this.changedFiles;
    try {
      // §46: what git brought in while the turn ran (Claude's approved merge, pull or commit) goes into A and the turn's own
      // start first, so neither the list nor the turn's counts show another branch's changes as Claude's.
      const ownStart = this.runningTurnBase ?? this.heldEndTree ?? start;
      const carried = await this.carryGitMoves(cp, ownStart === start ? [start] : [start, ownStart]);
      if (carried[0] !== start) {
        start = carried[0]!;
        this.turnStartTree = start;
        if (this.round) this.round.turnStartTree = start;
      }
      this.runningTurnBase = carried[carried.length - 1]!;
      const ignore = this.ignorePatterns();
      const snap = await cp.snapshotDetailed(ignore);
      const end = snap.tree;
      const skipped = mergeSkipped(this.snapshotSkipped, snap.skipped);
      const all = await cp.changes(start, end);
      const files = await cp.dropIgnoredDeletions(all.filter((f) => !hiddenBy(f, ignore)));
      const touchedRel: string[] = [];
      for (const tf of toolFiles) {
        const inside = toRepoRelative(tf.path, cp.root);
        const rel = inside ?? tf.path;
        if (inside !== null) touchedRel.push(inside);
        // A symlink a Bash call created is that path in the tree, not its target (§31: it is the call's).
        const leaf = leafRelative(tf.path, cp.root);
        const f = (leaf !== null ? files.find((x) => x.path === leaf || x.oldPath === leaf) : undefined) ?? files.find((x) => x.path === rel || x.oldPath === rel);
        if (f) {
          f.tools = [...new Set([...f.tools, ...tf.tools])].sort();
          f.toolUseIds = [...new Set([...f.toolUseIds, ...(tf.toolUseIds ?? [])])];
        }
      }
      // §31: an MCP tool's writes (an IDE's MCP server, a filesystem server) have no file_path the session could
      // record: a file nothing else explains is that call's when it changed inside the call's execution window.
      const writers = windows.filter((w) => isMcpTool(w.name) && w.end !== null);
      if (writers.length > 0) {
        for (const f of files) {
          if (f.toolUseIds.length > 0) continue;
          const t = await changeTimeOf(cp.fsPath(f.path), cp.root);
          const w = t === null ? undefined : writers.find((x) => inWindow(t, x));
          if (!w) continue;
          f.tools = [...new Set([...f.tools, w.name])].sort();
          f.toolUseIds = [...f.toolUseIds, w.toolUseId];
        }
      }
      // Tool-touched paths that git ignores never reach the snapshot: surface them instead of losing them.
      // (Mods paths do reach it, gitignored or not: they are in the list — §32.)
      const ignoredTouched = [...new Set(await cp.ignored(touchedRel))].filter((p) => !isModsPath(p)).sort();
      // Ditto for ignorePatterns: `snapshot()` excludes them via pathspec magic so they never enter
      // either tree and can't be recovered from the diff; derive them from the tool-touched paths
      // instead, same as `ignoredTouched`.
      const filteredByPattern = [...new Set(touchedRel.filter((p) => matchesIgnore(p, ignore) && !isModsPath(p)))].sort();
      await annotateMods(cp, files, start, end);
      await annotateLarge(cp, files, start, end); // MARK: wave4b w4b-bigturn (§39.1)
      // §34.3: what THIS turn changed (its own start tree → B) and who explains it, before the merge adds the earlier
      // turns' causes — and before the merge mutates the gate, so a failure here still leaves a clean retry.
      const turnBase = this.runningTurnBase ?? this.heldEndTree ?? start;
      const ownAll = turnBase === start ? all : await cp.changes(turnBase, end);
      const own = turnBase === start ? files : ownAll.filter((f) => !hiddenBy(f, ignore));
      // MARK: wave3 check-engine — §37.3: the same delta says which files get a fresh `why` (no second diff of these trees).
      await this.annotateFiles({ cp, files, start, end, previous: this.changedFiles, reason: "collect", turnPaths: turnPaths(own) });
      markSkipped(files, skipped);
      const ownOrigins = new Map(files.map((f) => [f.path, originOf(f)]));
      if (this.isAnsweringReview) {
        // A question turn merges into the SAME review: every file keeps the state and the tools it
        // already had, files the answer touched are added pending, and an accepted file goes back to
        // pending only when the answer actually changed its patch.
        const previous = new Map(this.changedFiles.map((f) => [f.path, f]));
        for (const f of files) {
          const old = previous.get(f.path);
          if (!old) continue;
          f.tools = [...new Set([...old.tools, ...f.tools])].sort();
          f.toolUseIds = [...new Set([...old.toolUseIds, ...f.toolUseIds])];
          f.state = old.state;
          Object.assign(f, partialOf(old));
          if (old.state !== "accepted") continue;
          const hash = this.acceptedPatchHashes.get(f.path);
          f.state = hash !== undefined && patchHash(await cp.patch(start, end, f.path, f.oldPath)) === hash ? "accepted" : "pending";
        }
        const paths = new Set(files.map((f) => f.path));
        this.acceptedPaths = this.acceptedPaths.filter((p) => paths.has(p));
        this.reviewNotes = this.reviewNotes.filter((n) => paths.has(n.path));
        this.acceptedPatchHashes = new Map();
        this.answerEndTree = null;
        this.isAnsweringReview = false;
      } else if (this.isRequestingChanges) {
        // Rebuilt from the ORIGINAL A: files accepted before the request stay accepted when
        // their patch is byte-identical; everything else is reviewed again. The cause of every file
        // (tools / toolUseIds, §12) carries over like an answer turn's: the follow-up only adds to it.
        const previous = new Map(this.changedFiles.map((f) => [f.path, f]));
        for (const f of files) {
          const old = previous.get(f.path);
          if (old) {
            f.tools = [...new Set([...old.tools, ...f.tools])].sort();
            f.toolUseIds = [...new Set([...old.toolUseIds, ...f.toolUseIds])];
          }
          const hash = this.acceptedPatchHashes.get(f.path);
          if (hash === undefined) continue;
          const patch = await cp.patch(start, end, f.path, f.oldPath);
          if (patchHash(patch) === hash) f.state = "accepted";
        }
        const paths = new Set(files.map((f) => f.path));
        this.acceptedPaths = this.acceptedPaths.filter((p) => paths.has(p));
        this.acceptedPatchHashes = new Map();
        this.isRequestingChanges = false;
        // §34.4: the follow-up no longer clears the notes — a sent note stays ("요청함") until the user removes it.
        this.reviewNotes = this.reviewNotes.filter((n) => paths.has(n.path));
      }
      carryAutoAccepted(files, before); // MARK: wave4c w4c-trust — §41.2: a file that stays accepted keeps its rule
      const turn = await this.collectTurn(cp, files, before, end, merged, turnBase, own, ownOrigins);
      this.turnEndTree = end;
      this.pendingCollect = null;
      this.collectError = null;
      this.diffCache = new Map();
      this.restoredFrom = null; // MARK: wave2 check-engine (§35.9)
      this.freshUndo = null; // MARK: wave3 check-engine (§37.8): the turn ran — nothing to put back
      this.changedFiles = files;
      this.filteredByPattern = filteredByPattern;
      this.ignoredTouched = ignoredTouched;
      this.snapshotSkipped = skipped;
      // §34.1–34.3: the held B is replaced; the turn's own start becomes "this turn"'s base.
      this.heldEndTree = null;
      this.runningTurnBase = null;
      this.turnBaseTree = turn.base;
      this.lastTurnChanges = files.length > 0 ? { turn: this.turnInfo?.turn ?? 0, files: turn.changes.files.length, added: turn.changes.added, deleted: turn.changes.deleted } : null;
      this.trackRound(this.turnInfo?.turn ?? null);
      this.onChange();
      const added = files.reduce((n, f) => n + f.added, 0);
      const deleted = files.reduce((n, f) => n + f.deleted, 0);
      return { files, added, deleted, turn: turn.changes, merged, delta: turnDelta(turnBase, end, ownAll) };
    } catch (e) {
      this.pendingCollect = { toolFiles, stopReason, usage, windows };
      this.collectError = errorMessage(e);
      throw e;
    } finally {
      this.collecting = false;
    }
  }

  /** Re-runs the end-of-turn collection after a failure; null when there is nothing to retry. */
  async retryCollect(): Promise<CollectResult | null> {
    const pending = this.pendingCollect;
    if (this.collectError === null || !pending || this.collecting) return null;
    this.collectError = null;
    return this.finishTurn(pending.toolFiles, pending.stopReason, pending.usage, pending.windows ?? []);
  }

  // MARK: - Accept / reject

  /** Marks pending `paths` accepted; non-pending paths are ignored. */
  accept(paths: string[]): void {
    for (const path of paths) {
      const f = this.changedFiles.find((x) => x.path === path);
      if (!f || f.state !== "pending") continue;
      f.state = "accepted";
      if (!this.acceptedPaths.includes(path)) this.acceptedPaths.push(path);
      setVerdict(this.round, path, "accepted");
      // §34.1: B now is the file's accepted tree ("수락 이후"); accepting again clears "changed after accept".
      if (this.reviewEndTree !== null) this.acceptedTrees.set(path, this.reviewEndTree);
      delete f.changedSinceAccepted;
    }
    this.onChange();
  }

  acceptAll(): void {
    this.accept(this.pendingFiles.map((f) => f.path));
  }

  /** `unaccept`: accepted `paths` are pending again (the file on disk is not touched). */
  unaccept(paths: string[]): void {
    for (const path of paths) {
      const f = this.changedFiles.find((x) => x.path === path);
      if (!f || f.state !== "accepted") continue;
      f.state = "pending";
      delete f.autoAccepted;
      delete f.changedSinceAccepted;
      this.acceptedPaths = this.acceptedPaths.filter((p) => p !== path);
      this.acceptedPatchHashes.delete(path);
      this.acceptedTrees.delete(path);
      setVerdict(this.round, path, "pending");
    }
    this.onChange();
  }

  /**
   * Reverts pending `paths` one by one (each success re-snapshots B and drops the file from the list);
   * the first failure stops the batch and is thrown. Non-pending paths are skipped.
   */
  async reject(paths: string[], force = false): Promise<void> {
    if (this.reverting) return;
    this.reverting = true;
    try {
      const files: ChangedFile[] = [];
      for (const path of paths) {
        const f = this.changedFiles.find((x) => x.path === path && x.state === "pending");
        if (f && !files.includes(f)) files.push(f);
      }
      // §32: a file whose content was not captured cannot be put back — refused for the batch, force or not.
      const uncaptured = files.filter((f) => f.uncaptured).map((f) => f.path);
      if (uncaptured.length > 0) throw new CommandRefused(`not_captured:${uncaptured.join(", ")}`, { code: "not_captured", paths: uncaptured });
      // Checked for the whole batch before anything is written: each revert re-snapshots B, which would
      // silently absorb the user's edits to the files still waiting in the batch.
      if (!force) {
        const edited = await this.editedSinceReview(files);
        if (edited.length > 0) throw new CommandRefused(`file_changed_since_review:${edited.join(", ")}`, { code: "file_changed_since_review", paths: edited });
      }
      if (files.length > 1) await this.revertBatch(files); // MARK: wave4b w4b-bigturn (§39.1)
      else for (const f of files) await this.revert(f);
    } finally {
      this.reverting = false;
    }
  }

  // MARK: wave4b w4b-bigturn
  /** §39.1: `editedSinceReview` with `worktreeMatchesMany` — a few git calls per tree instead of three per path. */
  private async editedSinceReviewMany(cp: GitCheckpoint, files: readonly ChangedFile[], start: string, end: string): Promise<string[]> {
    const pathsOf = (f: ChangedFile) => (f.oldPath && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path]);
    const restored = this.restoredFrom;
    const fromRestored = restored ? files.filter((f) => restored.paths.has(f.path)) : [];
    const fromEnd = restored ? files.filter((f) => !restored.paths.has(f.path)) : [...files];
    const okEnd = await cp.worktreeMatchesMany(end, fromEnd.flatMap(pathsOf));
    const okRestored = restored && fromRestored.length > 0 ? await cp.worktreeMatchesMany(restored.tree, fromRestored.flatMap(pathsOf)) : new Set<string>();
    const reviewedOk = (f: ChangedFile, p: string) => (restored?.paths.has(f.path) ? okRestored : okEnd).has(p);
    const rest = files.flatMap((f) => pathsOf(f).filter((p) => !reviewedOk(f, p)));
    const okStart = await cp.worktreeMatchesMany(start, rest);
    return files.filter((f) => pathsOf(f).some((p) => !reviewedOk(f, p) && !okStart.has(p))).map((f) => f.path);
  }

  /**
   * §39.1 (robustness-10 ①): `revert` for many files — every file put back at once (`revertMany`: the added ones removed,
   * the rest restored with one `git restore`), then ONE snapshot (300 files took 35 s, a snapshot each). The list, notes
   * (§37.2), history verdicts and B follow as with one `revert` per file. When the batch fails part way, the files that
   * are back at A count as rejected and the error is thrown for the rest, as the first failure of the old loop was.
   */
  private async revertBatch(files: ChangedFile[]): Promise<void> {
    const cp = this.requireCheckpoint();
    const start = this.turnStartTree;
    if (start === null) throw new Error("no turn-start snapshot");
    const proposal = this.turnEndTree;
    let failure: unknown = null;
    try {
      await cp.revertMany(files, start);
    } catch (e) {
      failure = e;
    }
    let done = files;
    if (failure !== null) {
      done = [];
      for (const f of files) {
        const paths = f.status === "R" && f.oldPath ? [f.path, f.oldPath] : [f.path];
        let back = true;
        for (const p of paths) if (!(await cp.worktreeMatches(start, p).catch(() => false))) back = false;
        if (back) done.push(f);
      }
    }
    try {
      if (done.length > 0) this.turnEndTree = await cp.snapshot(this.ignorePatterns());
    } catch (e) {
      throw new Error(`Failed to revert ${files[0]!.path}: ${errorMessage(e)}`);
    }
    this.lastReject = null; // MARK: wave4c w4c-trust — §41.2: only a single-file reject can be put back
    for (const file of done) {
      this.noteRejected(file); // MARK: wave4c w4c-trust (§41.2)
      this.changedFiles = this.changedFiles.filter((f) => f.path !== file.path);
      this.dropNotesOf(file.path); // §37.2
      this.diffCache.delete(file.path);
      this.rejectedPaths.push(file.path);
      const pinned = file.partial ? this.round?.files.find((f) => f.path === file.path)?.endTree : undefined;
      const endTree = pinned ?? proposal;
      setVerdict(this.round, file.path, "rejected", endTree !== null ? { endTree } : {});
    }
    if (done.length > 0) {
      if (this.round && this.turnEndTree !== null) this.round.turnEndTree = this.turnEndTree;
      if (this.turnEndTree !== null) await this.followB(cp, this.changedFiles, proposal, this.turnEndTree);
      this.completeRoundIfResolved();
      this.onChange();
    }
    if (failure !== null) {
      const left = files.find((f) => !done.includes(f)) ?? files[0]!;
      throw new Error(`Failed to revert ${left.path}: ${errorMessage(failure)}`);
    }
  }

  rejectAll(force = false, includeExternal = false): Promise<void> {
    return this.reject(this.rejectAllPaths(includeExternal), force);
  }

  /**
   * The files among `files` whose revert would destroy content the user wrote after the review was collected:
   * on disk (the path, and a rename's old path) is neither the reviewed post-turn B nor already the turn-start A
   * the revert restores. Covers edits, a file the user deleted (an M file gone from disk), and a file the user
   * created where B has none (a deleted file re-created, a rename's old path re-used).
   */
  async editedSinceReview(files: readonly ChangedFile[]): Promise<string[]> {
    const cp = this.requireCheckpoint();
    const start = this.turnStartTree;
    const end = this.turnEndTree;
    if (start === null || end === null) return [];
    if (files.length > BATCH_CHECK_MIN) return this.editedSinceReviewMany(cp, files, start, end); // MARK: wave4b w4b-bigturn (§39.1)
    const edited: string[] = [];
    for (const f of files) {
      const paths = f.oldPath && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path];
      // MARK: wave2 check-engine — §35.9: a restored file is compared with the B the review was saved with.
      const reviewed = this.restoredFrom?.paths.has(f.path) ? this.restoredFrom.tree : end;
      for (const p of paths) {
        if ((await cp.worktreeMatches(reviewed, p)) || (await cp.worktreeMatches(start, p))) continue;
        edited.push(f.path);
        break;
      }
    }
    return edited;
  }

  /** Reverts one file to the turn-start tree, re-snapshots and drops it from the list. */
  private async revert(file: ChangedFile): Promise<void> {
    const cp = this.requireCheckpoint();
    const start = this.turnStartTree;
    if (start === null) throw new Error("no turn-start snapshot");
    const proposal = this.turnEndTree;
    const undo = this.rejectUndoBase(file); // MARK: wave4c w4c-trust — §41.2: taken before anything changes
    this.lastReject = null;
    try {
      await cp.revert(file, start);
      this.turnEndTree = await cp.snapshot(this.ignorePatterns());
    } catch (e) {
      throw new Error(`Failed to revert ${file.path}: ${errorMessage(e)}`);
    }
    const newlyRejected = this.noteRejected(file); // MARK: wave4c w4c-trust (§41.2)
    this.changedFiles = this.changedFiles.filter((f) => f.path !== file.path);
    this.dropNotesOf(file.path); // MARK: wave3 check-engine (§37.2)
    this.diffCache.delete(file.path);
    this.rejectedPaths.push(file.path);
    // The rejected proposal only survives in the B before the revert: the history diff reads it from there
    // (a partially reverted file already pinned the B before its first reject_hunks — the whole proposal).
    const pinned = file.partial ? this.round?.files.find((f) => f.path === file.path)?.endTree : undefined;
    const endTree = pinned ?? proposal;
    setVerdict(this.round, file.path, "rejected", endTree !== null ? { endTree } : {});
    if (this.round && this.turnEndTree !== null) this.round.turnEndTree = this.turnEndTree;
    if (this.turnEndTree !== null) await this.followB(cp, this.changedFiles, proposal, this.turnEndTree);
    this.completeRoundIfResolved();
    // MARK: wave4c w4c-trust — §41.2: [되돌리기] can put this one back while nothing moved underneath it.
    if (proposal !== null && this.turnEndTree !== null) this.lastReject = { ...undo, proposal, after: this.turnEndTree, completed: undo.round !== null && this.round === null, newlyRejected, reason: null };
    this.onChange();
  }

  /**
   * `reject_hunks` (docs/PROTOCOL.md §17): reverts the selected hunks of a pending modified file to the
   * turn-start content and keeps the rest under review (`partial`). Hunk ids are `FileDiff.hunks[].id`
   * of this file's current A→B diff. Selecting every hunk is a whole-file `reject`. Refused (nothing
   * written) for binary / added / deleted / renamed files, unknown ids, a stale `expectedEndTree`, and
   * when the file on disk is no longer the reviewed content (the user edited it): no data loss.
   */
  async rejectHunks(path: string, hunkIds: number[], expectedEndTree: string | null = null, expectedBaseTree: string | null = null): Promise<"partial" | "whole"> {
    if (this.reverting) throw new CommandRefused("reverting");
    const cp = this.requireCheckpoint();
    const start = this.turnStartTree;
    const end = this.turnEndTree;
    if (start === null || end === null) throw new CommandRefused("no_review");
    if (expectedEndTree !== null && expectedEndTree !== end) throw new CommandRefused("stale_diff");
    // §34.1: hunk ids of a range other than A → B (`since`) are not this diff's ids.
    if (expectedBaseTree !== null && expectedBaseTree !== start) throw new CommandRefused("stale_diff");
    const file = this.changedFiles.find((f) => f.path === path);
    if (!file) throw new CommandRefused(`not_a_changed_file:${path}`);
    if (file.state !== "pending") throw new CommandRefused(`not_pending:${path}`);
    if (file.uncaptured) throw new CommandRefused("partial_reject_unsupported:uncaptured");
    if (file.isBinary) throw new CommandRefused("binary_file");
    if (file.status !== "M") throw new CommandRefused(`partial_reject_unsupported:${file.status}`);
    // The splice rewrites a regular file's bytes: a symlink's target or a submodule's commit is not
    // text on disk, and a mode-only change has no hunks to pick — all of them go through `reject`.
    const [modeA, modeB] = await Promise.all([cp.treeMode(start, path), cp.treeMode(end, path)]);
    if (modeA === "120000" || modeB === "120000") throw new CommandRefused("partial_reject_unsupported:symlink");
    if (modeA === "160000" || modeB === "160000") throw new CommandRefused("partial_reject_unsupported:submodule");
    if (modeA !== modeB && (await cp.blobId(start, path)) === (await cp.blobId(end, path))) throw new CommandRefused("partial_reject_unsupported:mode");
    const ids = [...new Set(hunkIds)];
    if (ids.length === 0) throw new CommandRefused("no_hunks");
    const diff = parseUnifiedDiff(await cp.patch(start, end, file.path, file.oldPath));
    if (diff.isBinary) throw new CommandRefused("binary_file");
    for (const id of ids) if (!Number.isInteger(id) || !diff.hunks.some((h) => h.id === id)) throw new CommandRefused(`unknown_hunk:${id}`);
    if (ids.length === diff.hunks.length) {
      await this.reject([path]);
      return "whole";
    }
    this.reverting = true;
    this.lastReject = null; // MARK: wave4c w4c-trust — §41.2: a part reject is not put back by [되돌리기]
    try {
      const [reviewed, onDisk] = await Promise.all([cp.blobId(end, path), cp.worktreeBlobId(path)]);
      if (reviewed === null || onDisk !== reviewed) throw new CommandRefused(`file_changed_since_review:${path}`);
      const [oldContent, newContent] = await Promise.all([cp.fileContent(path, start), cp.fileContent(path, end)]);
      let content: Buffer;
      try {
        content = revertHunks(oldContent, newContent, diff.hunks, new Set(ids));
      } catch (e) {
        if (e instanceof HunkMismatchError) throw new CommandRefused(`diff_mismatch:${e.message}`);
        throw e;
      }
      try {
        await cp.writeWorktreeContent(path, content);
        this.turnEndTree = await cp.snapshot(this.ignorePatterns());
      } catch (e) {
        throw new Error(`Failed to revert hunks of ${path}: ${errorMessage(e)}`);
      }
      this.noteRejected(file); // MARK: wave4c w4c-trust (§41.2)
      const now = (await cp.changes(start, this.turnEndTree)).find((f) => f.path === path);
      this.diffCache = new Map();
      if (!now) {
        // Nothing left (the kept hunks cancelled out): same outcome as a whole-file reject.
        this.changedFiles = this.changedFiles.filter((f) => f.path !== path);
        this.dropNotesOf(path); // MARK: wave3 check-engine (§37.2)
        this.rejectedPaths.push(path);
        setVerdict(this.round, path, "rejected", { endTree: this.round?.files.find((f) => f.path === path)?.endTree ?? end });
        if (this.round) this.round.turnEndTree = this.turnEndTree;
        await this.followB(cp, this.changedFiles, end, this.turnEndTree);
        this.completeRoundIfResolved();
        this.onChange();
        return "whole";
      } else {
        file.added = now.added;
        file.deleted = now.deleted;
        file.partial = true;
        file.rejectedHunks = (file.rejectedHunks ?? 0) + ids.length;
        await recheckWhitespaceOnly(cp, file, start, this.turnEndTree); // MARK: wave3 check-engine (§37.5)
        if (!this.partiallyRejectedPaths.includes(path)) this.partiallyRejectedPaths.push(path);
        this.trackRound(null);
        // Pin the full proposal (the B before the first partial revert) so history_diff can still show the reverted part.
        const rf = this.round?.files.find((f) => f.path === path);
        if (rf && !rf.endTree) rf.endTree = end;
        await this.followB(cp, this.changedFiles, end, this.turnEndTree);
      }
      this.onChange();
      return "partial";
    } finally {
      this.reverting = false;
    }
  }

  // MARK: - Commit

  /**
   * After `paths` were committed (docs/M12-COMMIT.md): they leave the review list together with
   * their diff cache, patch hashes and notes; A is rebuilt with their current worktree content so a
   * follow-up turn (whose list is rebuilt from A) does not resurface them; B is re-snapshotted.
   * §53: `commit` per path when a series made several (`commits`: how many HEAD moved by).
   */
  async dropCommitted(paths: string[], commit?: HistoryCommit | ReadonlyMap<string, HistoryCommit>, commits = 1): Promise<void> {
    const cp = this.requireCheckpoint();
    this.lastReject = null; // MARK: wave4c w4c-trust — §41.2: a commit moves A
    const prevEnd = this.turnEndTree;
    const set = new Set(paths);
    const files = this.changedFiles.filter((f) => set.has(f.path));
    // MARK: wave4 w4-history — §38.3: the round's file keeps the commit it left with (`commit`).
    for (const f of files) {
      const took = commit instanceof Map ? commit.get(f.path) : (commit as HistoryCommit | undefined);
      setVerdict(this.round, f.path, "accepted", { committed: true, ...(took ? { commit: took } : {}) });
    }
    const specs = [...new Set(files.flatMap((f) => (f.oldPath !== null && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path])))];
    this.changedFiles = this.changedFiles.filter((f) => !set.has(f.path));
    this.reviewNotes = this.reviewNotes.filter((n) => !set.has(n.path));
    for (const p of set) this.acceptedPatchHashes.delete(p);
    this.diffCache = new Map();
    if (this.turnStartTree !== null) this.turnStartTree = await cp.overlayWorktree(this.turnStartTree, specs);
    // A holds what the commit holds now: when HEAD moved by just this commit (a merge it concluded included; §53: these
    // commits), there is nothing of it left to carry. Any other move (a pull before it) is still carried by `followHead`.
    const before = this.baseHead;
    const now = await cp.head().catch(() => null);
    if (before?.sha && now?.sha && (await cp.firstParentChain(before.sha, now.sha, commits).catch(() => null))?.length === commits) {
      this.baseHead = now;
      if (!(await cp.mergeInProgress().catch(() => null))) this.baseMerge = null;
    }
    this.turnEndTree = await cp.snapshot(this.ignorePatterns());
    await this.followB(cp, this.changedFiles, prevEnd, this.turnEndTree);
    this.completeRoundIfResolved();
    this.onChange();
  }

  // MARK: - Notes / request changes

  addNote(note: { path: string; line: number | null; side: DiffSide; excerpt: string; body: string }): ReviewNote | null {
    const text = note.body.trim();
    if (text.length === 0) return null;
    const created = makeNote({ path: note.path, line: note.line, side: note.side, excerpt: note.excerpt, body: text });
    this.reviewNotes.push(created);
    this.onChange();
    return created;
  }

  removeNote(id: string): void {
    this.reviewNotes = this.reviewNotes.filter((n) => n.id !== id);
    this.onChange();
  }

  /** `edit_note`: replaces an unsent note's text (a sent one is what Claude was asked; it stays as sent). */
  editNote(id: string, body: string): boolean {
    const text = body.trim();
    const note = this.reviewNotes.find((n) => n.id === id);
    if (!note || note.sent || text.length === 0) return false;
    note.body = text;
    this.onChange();
    return true;
  }

  /** True when one of `ids` is an unsent note (`request_changes{noteIds}`). */
  hasUnsentNote(ids: readonly string[]): boolean {
    return this.reviewNotes.some((n) => !n.sent && ids.includes(n.id));
  }

  /**
   * Everything request-changes does before talking to the session: builds the message, records
   * the patch hashes of accepted files, marks noted files, keeps A. Closes the gate (`running`).
   */
  async prepareRequestChanges(extra?: string | null, turn = 0, noteIds?: readonly string[]): Promise<PreparedRequestChanges | null> {
    const cp = this.checkpoint;
    const start = this.turnStartTree;
    const end = this.turnEndTree;
    // §34.4: only the notes not sent yet go; `turn` is the follow-up turn they are marked sent with.
    // `noteIds` (a single note's "send only this"): just those; the other unsent notes stay for a later request.
    const unsent = this.reviewNotes.filter((n) => !n.sent && (!noteIds || noteIds.includes(n.id)));
    if (unsent.length === 0 || !cp || start === null || end === null) return null;
    const message = requestChangesMessage(unsent, extra);
    this.acceptedPatchHashes = await this.hashAccepted(cp, start, end);
    this.roundNotesBefore = this.round?.notes.length ?? 0;
    addRoundNotes(this.round, unsent);
    const noted = new Set(unsent.map((n) => n.path));
    for (const f of this.changedFiles) if (noted.has(f.path)) f.state = "changesRequested";
    this.markRequestSent(unsent, end, turn);
    this.isRequestingChanges = true;
    this.turnEndTree = null;
    this.running = true;
    this.onChange();
    return { message, checkpointTree: start, endTree: end };
  }

  /** Undoes `prepareRequestChanges` after the session refused the message (notes are kept). */
  undoRequestChanges(endTree: string): void {
    for (const f of this.changedFiles) if (f.state === "changesRequested") f.state = "pending";
    if (this.round) {
      this.round.notes.splice(this.roundNotesBefore);
      syncRound(this.round, this.changedFiles, this.round.turnEndTree, null);
    }
    this.isRequestingChanges = false;
    this.acceptedPatchHashes = new Map();
    this.turnEndTree = endTree;
    this.running = false;
    this.undoRequestSent();
    this.onChange();
  }

  // MARK: - Diff / full file

  /**
   * Parsed diff of a changed file between A and B (cached until B changes); `endTree` = the B it was computed for — §34.2:
   * `reviewEndTree`, the held B while a turn runs — and `baseTree` = A.
   */
  async diffFor(path: string): Promise<{ diff: FileDiff; truncated: boolean; endTree: string; baseTree: string }> {
    const cp = this.requireCheckpoint();
    const file = this.changedFiles.find((f) => f.path === path);
    if (!file) throw new CommandRefused(`not_a_changed_file:${path}`);
    const start = this.turnStartTree;
    const end = this.reviewEndTree;
    if (start === null || end === null) throw new CommandRefused("no_review");
    if (file.isBinary) return { diff: { oldPath: file.oldPath ?? file.path, newPath: file.path, isBinary: true, hunks: [] }, truncated: false, endTree: end, baseTree: start };
    const cached = this.diffCache.get(path);
    if (cached) return { ...truncateDiff(cached), endTree: end, baseTree: start };
    const patch = await cp.patch(start, end, file.path, file.oldPath);
    const diff = parseUnifiedDiff(patch);
    // B may have moved while git ran (a reject, a refresh, a collection): never cache a diff under the newer B.
    if (this.reviewEndTree === end && this.turnStartTree === start) this.diffCache.set(path, diff);
    return { ...truncateDiff(diff), endTree: end, baseTree: start };
  }

  /**
   * New content of `path` — the worktree, falling back to B; §34.2: the held B's content while a turn runs (`stale`) — with
   * the changed line numbers of the range `since` (§34.1; A → B by default). `endTree`: the B it belongs to.
   */
  async fullFile(path: string, since: DiffSince = "review"): Promise<FullFileView & { endTree: string; stale: boolean }> {
    const cp = this.requireCheckpoint();
    const file = this.changedFiles.find((f) => f.path === path);
    if (!file) throw new CommandRefused(`not_a_changed_file:${path}`);
    const end = this.reviewEndTree;
    if (this.turnStartTree === null || end === null) throw new CommandRefused("no_review");
    const stale = end !== this.turnEndTree;
    const { diff } = await this.diffRange(path, since);
    let content: Buffer = Buffer.alloc(0);
    if (file.status !== "D") {
      const fromB = () => cp.fileContent(file.path, end);
      content = await (stale ? fromB() : cp.fileContent(file.path, null).catch(fromB)).catch(() => Buffer.alloc(0));
    }
    return { ...deriveFullFile(file.path, content, diff, file.isBinary), endTree: end, stale };
  }

  /** Patch hash of every accepted file, so a follow-up turn can tell which of them it left alone. */
  private async hashAccepted(cp: GitCheckpoint, start: string, end: string): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const f of this.changedFiles) {
      if (f.state !== "accepted") continue;
      try {
        hashes.set(f.path, patchHash(await cp.patch(start, end, f.path, f.oldPath)));
      } catch {
        // unreadable patch: the file is reviewed again after the follow-up turn
      }
    }
    return hashes;
  }

  private requireCheckpoint(): GitCheckpoint {
    if (!this.checkpoint) throw new CommandRefused("no_project");
    return this.checkpoint;
  }

  // MARK: wave2 engine-review — §34.1–34.5

  /** §34.2: the B the list, every diff and `blob` refer to — `turnEndTree`, or the held B while a turn runs / is collected. */
  get reviewEndTree(): string | null {
    return this.turnEndTree ?? this.heldEndTree;
  }

  /** §34.2: diffs are served from the held B (read-only: the running turn may still change the files). */
  get isStale(): boolean {
    return this.turnEndTree === null && this.heldEndTree !== null;
  }

  /** §34.4: notes `request_changes` has not sent yet (what it would send; `canRequestChanges` / "notes pending" look at these). */
  get unsentNoteCount(): number {
    return this.reviewNotes.reduce((n, note) => (note.sent ? n : n + 1), 0);
  }

  /** §34.4: the file's notes already sent with `request_changes`. */
  sentNoteCount(path: string): number {
    return this.reviewNotes.reduce((n, note) => (note.path === path && note.sent ? n + 1 : n), 0);
  }

  /** §34.1: the running turn's own start tree (the engine's §26 record; null when unknown: the held B, or A for a fresh turn). */
  noteTurnStart(own: string | null): void {
    this.runningTurnBase = own ?? this.heldEndTree ?? this.turnStartTree;
  }

  /**
   * §34.2: `accept` / `accept_all` while a turn runs on a standing review (or its collection failed): applied at once, with the
   * file's patch A → held B recorded like a file accepted before an answer turn — after the collection the file stays accepted
   * only when the turn left that patch alone, else it is pending with `changedSinceAccepted` and out of `acceptedPaths`.
   * Refused `session_running` while collecting and without a held B (a fresh turn: nothing is pending).
   */
  async acceptHeld(paths: readonly string[]): Promise<void> {
    const cp = this.requireCheckpoint();
    const start = this.turnStartTree;
    const held = this.heldEndTree;
    if (this.collecting || !this.isStale || held === null || start === null) throw new CommandRefused("session_running");
    const files = [...new Set(paths)].map((p) => this.changedFiles.find((f) => f.path === p && f.state === "pending")).filter((f): f is ChangedFile => f !== undefined);
    const hashes = new Map<string, string>();
    for (const f of files) {
      try {
        hashes.set(f.path, patchHash(await cp.patch(start, held, f.path, f.oldPath)));
      } catch {
        // unreadable patch: the file is reviewed again after the turn
      }
    }
    // The turn may have ended while git ran: its collection is rebuilding the list.
    if (this.collecting || this.heldEndTree !== held || this.turnEndTree !== null) throw new CommandRefused("session_running");
    for (const f of files) {
      if (f.state !== "pending") continue;
      f.state = "accepted";
      delete f.changedSinceAccepted;
      if (!this.acceptedPaths.includes(f.path)) this.acceptedPaths.push(f.path);
      const hash = hashes.get(f.path);
      if (hash !== undefined) this.acceptedPatchHashes.set(f.path, hash);
      this.acceptedTrees.set(f.path, held);
      this.acceptedDuringTurn.add(f.path);
      setVerdict(this.round, f.path, "accepted");
    }
    this.onChange();
  }

  /**
   * §34.1: the file's diff over the range `since` — the old side is A (`review`), the last collected turn's own start
   * (`turn`), the request tree (`request`) or the file's accepted tree (`accepted`); the new side is `reviewEndTree`. Renames
   * are followed between the two trees. A known base always answers (possibly without hunks), else `range_unavailable`.
   */
  async diffRange(path: string, since: DiffSince): Promise<{ diff: FileDiff; truncated: boolean; endTree: string; baseTree: string; stale: boolean }> {
    if (since === "review") {
      const r = await this.diffFor(path);
      return { ...r, stale: r.endTree !== this.turnEndTree };
    }
    const cp = this.requireCheckpoint();
    const file = this.changedFiles.find((f) => f.path === path);
    if (!file) throw new CommandRefused(`not_a_changed_file:${path}`);
    const end = this.reviewEndTree;
    if (this.turnStartTree === null || end === null) throw new CommandRefused("no_review");
    const base = since === "turn" ? this.turnBaseTree : since === "request" ? this.requestTree : (this.acceptedTrees.get(path) ?? null);
    if (base === null) throw rangeUnavailable(since);
    const key = `${base}\0${end}\0${path}`;
    let diff = this.rangeCache.get(key);
    if (!diff) {
      const parsed = parseUnifiedDiff(await cp.patch(base, end, file.path));
      // Nothing changed in this range: still name the file.
      diff = parsed.hunks.length === 0 && !parsed.isBinary ? { ...parsed, oldPath: parsed.oldPath ?? file.path, newPath: parsed.newPath ?? file.path } : parsed;
      this.rangeCache.set(key, diff);
      if (this.rangeCache.size > RANGE_CACHE_MAX) this.rangeCache.delete(this.rangeCache.keys().next().value!);
    }
    const shown = diff.isBinary ? { diff: { ...diff, hunks: [] }, truncated: false } : truncateDiff(diff);
    return { ...shown, endTree: end, baseTree: base, stale: end !== this.turnEndTree };
  }

  /** §34.4: the round in progress as a history entry (`inProgress`, `endedAt` = `updatedAt`, B = `reviewEndTree`); null without one. */
  roundInProgress(updatedAt: string | null): ReviewHistoryEntry | null {
    const round = this.round;
    if (!round) return null;
    const entry = completeRound(round, updatedAt ?? round.startedAt);
    return entry ? { ...entry, turnEndTree: this.reviewEndTree ?? entry.turnEndTree, inProgress: true } : null;
  }

  /** §34.1: every tree a range refers to — pinned under `refs/reviewgate/<ns>/range/` while referenced. */
  rangeTrees(): string[] {
    const trees = [this.turnBaseTree, this.requestTree, this.heldEndTree, ...this.acceptedTrees.values()];
    return [...new Set(trees.filter((t): t is string => t !== null))].sort();
  }

  /** Pins exactly `rangeTrees()` (the unreferenced range pins of this worktree go). */
  async pinRanges(): Promise<void> {
    const cp = this.checkpoint;
    if (cp) await syncRangePins(cp, this.refNs, this.rangeTrees());
  }

  /**
   * §34.3–34.5 at a collection: this turn's own changes (`own`: its start tree `base` → `end`) per listed file and in total,
   * the accept marks the turn moved (`changedSinceAccepted`; during-turn accepts it changed leave `acceptedPaths`), then the
   * B-following bookkeeping (notes carried from the held B). `before`: the list the turn started on. Never throws.
   */
  private async collectTurn(
    cp: GitCheckpoint,
    files: ChangedFile[],
    before: readonly ChangedFile[],
    end: string,
    merged: boolean,
    base: string,
    own: readonly ChangedFile[],
    ownOrigins: ReadonlyMap<string, string>,
  ): Promise<{ base: string; changes: TurnChanges }> {
    const ownByPath = new Map(own.map((f) => [f.path, { added: f.added, deleted: f.deleted }]));
    const prev = new Map(merged ? before.map((f) => [f.path, f]) : []);
    const changes: TurnChanges = { files: [], added: 0, deleted: 0, external: 0 };
    for (const f of files) {
      const t = ownByPath.get(f.path);
      if (t) {
        f.changedThisTurn = true;
        f.turnAdded = t.added;
        f.turnDeleted = t.deleted;
        changes.files.push(f);
        changes.added += t.added;
        changes.deleted += t.deleted;
        if (ownOrigins.get(f.path) === "external") changes.external += 1;
      } else {
        delete f.changedThisTurn;
        delete f.turnAdded;
        delete f.turnDeleted;
      }
      const old = prev.get(f.path);
      if (f.state !== "accepted" && old && (old.state === "accepted" || (old.changedSinceAccepted && f.state === "pending"))) f.changedSinceAccepted = true;
      else delete f.changedSinceAccepted;
    }
    if (this.acceptedDuringTurn.size > 0) {
      const back = new Set(files.filter((f) => f.state !== "accepted" && this.acceptedDuringTurn.has(f.path)).map((f) => f.path));
      this.acceptedPaths = this.acceptedPaths.filter((p) => !back.has(p));
      this.acceptedDuringTurn = new Set();
    }
    await this.followB(cp, files, merged ? this.heldEndTree : null, end);
    return { base, changes };
  }

  /**
   * §34.4 / §34.5: B moved (`from` → `to`; `from` null: nothing to carry). Every listed file gets its `blob` in `to` and
   * `changedSinceRequest` against the request tree; the new-side notes of files whose content changed are carried through
   * `from` → `to`; the accepted trees of files that left the list go. Best effort: a git failure leaves the marks as they were.
   */
  private async followB(cp: GitCheckpoint, files: readonly ChangedFile[], from: string | null, to: string): Promise<void> {
    const paths = files.map((f) => f.path);
    const listed = new Set(paths);
    for (const p of [...this.acceptedTrees.keys()]) if (!listed.has(p)) this.acceptedTrees.delete(p);
    try {
      const now = await treeEntryIds(cp, to, paths);
      const asked = this.requestTree !== null ? await treeEntryIds(cp, this.requestTree, paths) : null;
      for (const f of files) {
        const blob = now.get(f.path);
        if (blob !== undefined) f.blob = blob;
        else delete f.blob;
        if (asked && asked.get(f.path) !== blob) f.changedSinceRequest = true;
        else delete f.changedSinceRequest;
      }
      if (from === null || from === to) return;
      const noted = [...new Set(this.reviewNotes.filter((n) => n.side === "new" && n.line !== null && n.anchor !== "gone" && listed.has(n.path)).map((n) => n.path))];
      if (noted.length === 0) return;
      const was = await treeEntryIds(cp, from, noted);
      const diffs = new Map<string, FileDiff>();
      for (const p of noted) if (was.get(p) !== now.get(p)) diffs.set(p, parseUnifiedDiff(await cp.patch(from, to, p, null)));
      if (diffs.size === 0) return;
      this.reviewNotes = this.reviewNotes.map((n) => {
        const d = diffs.get(n.path);
        return d ? carryNote(n, d) : n;
      });
    } catch {
      // the marks stay as they were; the next B change recomputes them
    }
  }

  /**
   * §34.4: `request_changes` sent `notes` (marked `sent`) from `end` — the new request tree, so nothing has changed since it
   * yet; `turn` is the follow-up turn.
   */
  private markRequestSent(notes: readonly ReviewNote[], end: string, turn: number): void {
    const at = new Date().toISOString();
    const ids = new Set(notes.map((n) => n.id));
    const changed = this.changedFiles.filter((f) => f.changedSinceRequest).map((f) => f.path);
    this.requestUndo = { sent: [...ids], requestTree: this.requestTree, lastRequest: this.lastRequest, changedSinceRequest: changed };
    this.reviewNotes = this.reviewNotes.map((n) => (ids.has(n.id) ? { ...n, sent: { at, turn } } : n));
    for (const f of this.changedFiles) delete f.changedSinceRequest;
    this.requestTree = end;
    this.lastRequest = { turn, at, notes: notes.length };
    this.heldEndTree = end;
  }

  /** The request never reached Claude: its notes are unsent again, the previous request (if any) is the last one. */
  private undoRequestSent(): void {
    const undo = this.requestUndo;
    this.requestUndo = null;
    this.heldEndTree = null;
    this.runningTurnBase = null;
    if (!undo) return;
    const ids = new Set(undo.sent);
    this.reviewNotes = this.reviewNotes.map((n) => {
      if (!ids.has(n.id)) return n;
      const { sent: _sent, ...rest } = n;
      return rest;
    });
    this.requestTree = undo.requestTree;
    this.lastRequest = undo.lastRequest;
    const changed = new Set(undo.changedSinceRequest);
    for (const f of this.changedFiles) if (changed.has(f.path)) f.changedSinceRequest = true;
  }

  /** §34: what the review file keeps (the trees are re-checked by `restore`). */
  private persistedRanges(): PersistedRanges {
    return {
      turnBaseTree: this.turnBaseTree,
      heldEndTree: this.heldEndTree,
      requestTree: this.requestTree,
      lastRequest: this.lastRequest ? { ...this.lastRequest } : null,
      lastTurnChanges: this.lastTurnChanges ? { ...this.lastTurnChanges } : null,
      acceptedTrees: Object.fromEntries(this.acceptedTrees),
    };
  }

  /**
   * §34.1 restore: the saved ranges whose trees still exist (a pruned one is simply unavailable), then blob /
   * changedSinceRequest for the fresh B and the notes carried from the saved B (or the held B of a turn that was running).
   */
  private async restoreRanges(cp: GitCheckpoint, saved: PersistedReview, end: string): Promise<void> {
    this.resetRanges();
    const r = saved.ranges ?? null;
    const known = new Map<string, boolean>();
    const kept = async (tree: string | null): Promise<string | null> => {
      if (tree === null) return null;
      if (!known.has(tree)) known.set(tree, await cp.hasObjects([tree]).catch(() => false));
      return known.get(tree) ? tree : null;
    };
    if (r) {
      this.turnBaseTree = await kept(r.turnBaseTree);
      this.requestTree = await kept(r.requestTree);
      this.lastRequest = this.requestTree !== null && r.lastRequest ? { ...r.lastRequest } : null;
      this.lastTurnChanges = this.turnBaseTree !== null && r.lastTurnChanges ? { ...r.lastTurnChanges } : null;
      const listed = new Set(this.changedFiles.map((f) => f.path));
      for (const [path, tree] of Object.entries(r.acceptedTrees)) if (listed.has(path) && (await kept(tree)) !== null) this.acceptedTrees.set(path, tree);
    }
    // A mark whose range is gone (a pruned tree, a file written before §34) would offer a diff that is refused.
    for (const f of this.changedFiles) {
      if (this.turnBaseTree === null) {
        delete f.changedThisTurn;
        delete f.turnAdded;
        delete f.turnDeleted;
      }
      if (!this.acceptedTrees.has(f.path)) delete f.changedSinceAccepted;
    }
    await this.followB(cp, this.changedFiles, await kept(saved.turnEndTree ?? r?.heldEndTree ?? null), end);
  }

  private resetRanges(): void {
    this.heldEndTree = null;
    this.turnBaseTree = null;
    this.runningTurnBase = null;
    this.lastTurnChanges = null;
    this.requestTree = null;
    this.lastRequest = null;
    this.acceptedTrees = new Map();
    this.acceptedDuringTurn = new Set();
    this.requestUndo = null;
    this.rangeCache = new Map();
  }

  // MARK: wave3 check-engine

  /**
   * §37.2: a file a reject took out of the review takes its notes with it (sent ones too: they were about a change that is
   * gone) — the next `request_changes` must not ask Claude about it, and no note may keep `notes_pending` / an unresolved
   * review alive without a file to show it on.
   */
  private dropNotesOf(path: string): void {
    this.reviewNotes = this.reviewNotes.filter((n) => n.path !== path);
  }

  /** §37.8: the §34 range bookkeeping as it stands (what `resetRanges` clears), for `freshUndo`. */
  private rangeState(): RangeState {
    return {
      heldEndTree: this.heldEndTree,
      turnBaseTree: this.turnBaseTree,
      lastTurnChanges: this.lastTurnChanges,
      requestTree: this.requestTree,
      lastRequest: this.lastRequest,
      acceptedTrees: new Map(this.acceptedTrees),
      acceptedDuringTurn: new Set(this.acceptedDuringTurn),
      requestUndo: this.requestUndo,
      rangeCache: this.rangeCache,
    };
  }

  private restoreRangeState(r: RangeState): void {
    this.heldEndTree = r.heldEndTree;
    this.turnBaseTree = r.turnBaseTree;
    this.lastTurnChanges = r.lastTurnChanges;
    this.requestTree = r.requestTree;
    this.lastRequest = r.lastRequest;
    this.acceptedTrees = r.acceptedTrees;
    this.acceptedDuringTurn = r.acceptedDuringTurn;
    this.requestUndo = r.requestUndo;
    this.rangeCache = r.rangeCache;
  }

  // MARK: wave4c w4c-trust — §41.2 trusted auto-accept, undoing a reject

  /** Paths rejected (wholly or in part) while this project is open — no auto-accept rule takes them again. */
  readonly rejectedBefore = new Set<string>();
  /** The last single-file reject while [되돌리기] can put it back; cleared by a turn, another reject, a commit, a finish. */
  private lastReject: RejectUndo | null = null;
  /** The round a reject had completed came back (`reject_undo`): the engine drops its history entry again. */
  onRoundReopened: (roundId: string) => void = () => {};

  /** Remembers `file` as rejected; true when it was not remembered yet. */
  private noteRejected(file: ChangedFile): boolean {
    const fresh = !this.rejectedBefore.has(file.path);
    this.rejectedBefore.add(file.path);
    if (file.oldPath && file.oldPath !== file.path) this.rejectedBefore.add(file.oldPath);
    return fresh;
  }

  /** What no rule may accept because it was rejected: the engine's memory, this round's verdicts and `extra` (the history). */
  rejectedForTrust(extra: Iterable<string> = []): Set<string> {
    const out = new Set(this.rejectedBefore);
    for (const f of this.round?.files ?? []) if (f.verdict === "rejected" || (f.rejectedHunks ?? 0) > 0) out.add(f.path);
    for (const p of extra) out.add(p);
    return out;
  }

  /** Paths with review notes (sent or not). */
  notedPaths(): Set<string> {
    return new Set(this.reviewNotes.map((n) => n.path));
  }

  /** §41.2: accepts the planned files still pending, each marked with its rule (the round keeps it); returns what it accepted. */
  autoAccept(plan: readonly AutoAcceptedFile[]): AutoAcceptedFile[] {
    const done: AutoAcceptedFile[] = [];
    for (const p of plan) {
      const f = this.changedFiles.find((x) => x.path === p.path);
      if (!f || f.state !== "pending") continue;
      this.accept([p.path]);
      f.autoAccepted = p.rule;
      setVerdict(this.round, p.path, "accepted", { autoAccepted: p.rule });
      done.push({ path: p.path, rule: p.rule });
    }
    if (done.length > 0) this.onChange();
    return done;
  }

  /** §41.2 `auto_accept_undo`: files a rule accepted are pending again (`paths` null: all of them); nothing on disk changes. */
  undoAutoAccept(paths: readonly string[] | null): string[] {
    if (this.running || this.collecting || this.reverting) throw new CommandRefused("session_running");
    const want = paths ? new Set(paths) : null;
    const back: string[] = [];
    for (const f of this.changedFiles) {
      if (f.state !== "accepted" || f.autoAccepted === undefined || (want && !want.has(f.path))) continue;
      f.state = "pending";
      delete f.autoAccepted;
      this.acceptedPaths = this.acceptedPaths.filter((p) => p !== f.path);
      this.acceptedTrees.delete(f.path);
      this.acceptedPatchHashes.delete(f.path);
      const rf = this.round?.files.find((x) => x.path === f.path);
      if (rf) {
        rf.verdict = "pending";
        delete rf.autoAccepted;
      }
      back.push(f.path);
    }
    if (back.length > 0) this.onChange();
    return back;
  }

  /** §41.2 `state.gate.rejectUndo`. */
  rejectUndoState(): RejectUndoState | null {
    const u = this.lastReject;
    if (!u) return null;
    return { path: u.file.path, oldPath: u.file.oldPath, status: u.file.status, available: u.reason === null, ...(u.reason !== null ? { reason: u.reason } : {}) };
  }

  /** Re-checks whether the last reject can still be put back (after a refresh); true when the answer changed. */
  async recheckRejectUndo(): Promise<boolean> {
    const u = this.lastReject;
    if (!u) return false;
    const reason = await this.rejectUndoBlock(u).catch((): RejectUndoBlock => "changed_on_disk");
    if (this.lastReject !== u || reason === u.reason) return false;
    u.reason = reason;
    return true;
  }

  /**
   * §41.2 `reject_undo`: the last single-file reject is put back — its proposal (B before the revert) on disk, the file in
   * the list as it was (pending, its notes), its verdict and the round (one the reject had completed comes back). Only
   * while A is the same, nothing lists the path and its disk content is what the reject left; refused otherwise.
   */
  async undoReject(path: string): Promise<void> {
    if (this.running || this.collecting || this.reverting) throw new CommandRefused("session_running");
    const cp = this.requireCheckpoint();
    const u = this.lastReject;
    if (!u || (u.file.path !== path && u.file.oldPath !== path)) throw new CommandRefused(`reject_undo_unavailable:${path}`, { code: "reject_undo_unavailable" });
    this.reverting = true;
    try {
      const reason = await this.rejectUndoBlock(u);
      if (reason !== null) {
        u.reason = reason;
        throw new CommandRefused(`reject_undo_${reason}:${path}`, { code: `reject_undo_${reason}` });
      }
      const before = this.turnEndTree;
      try {
        await reapplyProposal(cp, u.file, u.proposal);
        this.turnEndTree = await cp.snapshot(this.ignorePatterns());
      } catch (e) {
        throw new Error(`Failed to put back ${u.file.path}: ${errorMessage(e)}`);
      }
      this.lastReject = null;
      const file: ChangedFile = { ...u.file, state: "pending" };
      this.changedFiles = [...this.changedFiles.filter((f) => f.path !== file.path), file].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      this.reviewNotes = [...this.reviewNotes, ...u.notes];
      const i = this.rejectedPaths.lastIndexOf(file.path);
      if (i >= 0) this.rejectedPaths.splice(i, 1);
      if (u.newlyRejected) {
        this.rejectedBefore.delete(file.path);
        if (file.oldPath) this.rejectedBefore.delete(file.oldPath);
      }
      this.diffCache.delete(file.path);
      if (u.completed && u.round) {
        this.round = u.round;
        this.restoreRangeState(u.ranges);
        this.onRoundReopened(u.round.id);
      } else if (this.round && u.roundFile) {
        this.round.files = [...this.round.files.filter((f) => f.path !== file.path), u.roundFile];
      }
      if (this.round && this.turnEndTree !== null) this.round.turnEndTree = this.turnEndTree;
      if (before !== null && this.turnEndTree !== null) await this.followB(cp, this.changedFiles, before, this.turnEndTree);
      this.trackRound(null);
      this.onChange();
    } finally {
      this.reverting = false;
    }
  }

  /** What a reject must remember before it changes anything, for `undoReject`. */
  private rejectUndoBase(file: ChangedFile): Pick<RejectUndo, "file" | "notes" | "start" | "round" | "roundFile" | "ranges"> {
    return {
      file: structuredClone(file),
      notes: this.reviewNotes.filter((n) => n.path === file.path).map((n) => ({ ...n })),
      start: this.turnStartTree ?? "",
      round: this.round ? structuredClone(this.round) : null,
      roundFile: structuredClone(this.round?.files.find((f) => f.path === file.path) ?? null),
      ranges: this.rangeState(),
    };
  }

  /** Why the reject can no longer be put back (null: it can). */
  private async rejectUndoBlock(u: RejectUndo): Promise<RejectUndoBlock | null> {
    const cp = this.checkpoint;
    if (!cp || this.turnStartTree !== u.start || this.turnEndTree === null) return "review_changed";
    const paths = u.file.oldPath && u.file.oldPath !== u.file.path ? [u.file.path, u.file.oldPath] : [u.file.path];
    if (this.changedFiles.some((f) => paths.includes(f.path) || (f.oldPath !== null && paths.includes(f.oldPath)))) return "changed_on_disk";
    for (const p of paths) if (!(await cp.worktreeMatches(u.after, p))) return "changed_on_disk";
    return null;
  }
}

/** MARK: wave4c w4c-trust — §41.2: one single-file reject, as `undoReject` needs it. */
type RejectUndo = {
  /** The file as the list had it (pending). */
  file: ChangedFile;
  /** Its notes the reject dropped (§37.2). */
  notes: ReviewNote[];
  /** A at the reject. */
  start: string;
  /** B before the revert: the proposal that comes back. */
  proposal: string;
  /** B right after the revert: what the disk must still hold. */
  after: string;
  /** The round before the reject, and the file's entry in it. */
  round: HistoryRound | null;
  roundFile: RoundFile | null;
  /** The reject completed the round (nothing was left): undoing it reopens the round and its ranges. */
  completed: boolean;
  ranges: RangeState;
  /** The path entered `rejectedBefore` with this reject. */
  newlyRejected: boolean;
  /** The last check's answer (null: can be put back). */
  reason: RejectUndoBlock | null;
};

/** MARK: wave4c w4c-trust — §41.2: `revert` the other way — the file's paths as the proposal tree has them. */
async function reapplyProposal(cp: GitCheckpoint, f: Pick<ChangedFile, "path" | "oldPath" | "status">, proposal: string): Promise<void> {
  // `revert(…, tree)` restores a path from `tree` (status M) or removes it (status A).
  if (f.status === "D") return cp.revert({ path: f.path, oldPath: null, status: "A" }, proposal);
  if (f.status === "R" && f.oldPath && f.oldPath !== f.path) await cp.revert({ path: f.oldPath, oldPath: null, status: "A" }, proposal);
  await cp.revert({ path: f.path, oldPath: null, status: "M" }, proposal);
}

/** MARK: wave4c w4c-trust — §41.2: a rebuilt list's file keeps its rule while it stays accepted; otherwise the mark goes. */
function carryAutoAccepted(files: ChangedFile[], previous: readonly ChangedFile[]): void {
  const prev = new Map(previous.map((f) => [f.path, f]));
  for (const f of files) {
    const old = prev.get(f.path);
    if (f.state === "accepted" && old?.state === "accepted" && old.autoAccepted !== undefined) f.autoAccepted = old.autoAccepted;
    else delete f.autoAccepted;
  }
}

/** MARK: wave3 check-engine — §37.8: the range fields `resetRanges` clears (the running turn's base excepted). */
type RangeState = {
  heldEndTree: string | null;
  turnBaseTree: string | null;
  lastTurnChanges: LastTurnChanges | null;
  requestTree: string | null;
  lastRequest: ReviewRequestInfo | null;
  acceptedTrees: Map<string, string>;
  acceptedDuringTurn: Set<string>;
  requestUndo: { sent: string[]; requestTree: string | null; lastRequest: ReviewRequestInfo | null; changedSinceRequest: string[] } | null;
  rangeCache: Map<string, FileDiff>;
};

/** §34.1: range diffs kept in memory (trees are immutable; the oldest goes first). */
const RANGE_CACHE_MAX = 64;

function mergeSkipped(a: readonly SkippedPath[], b: readonly SkippedPath[]): SkippedPath[] {
  const out = [...a];
  for (const s of b) if (!out.some((x) => x.path === s.path)) out.push(s);
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** §32 (robustness-09): a file a snapshot left out has no reliable A / B content — like a stub, it is never reverted. */
function markSkipped(files: ChangedFile[], skipped: readonly SkippedPath[]): void {
  if (skipped.length === 0) return;
  const paths = new Set(skipped.map((s) => s.path));
  for (const f of files) if (paths.has(f.path) || (f.oldPath !== null && paths.has(f.oldPath))) f.uncaptured = true;
}

/** Hidden from the list by the app's ignore patterns — never a mods path (§32: hooks and settings are not noise). */
function hiddenBy(f: ChangedFile, ignore: string[]): boolean {
  const hides = (p: string) => !isModsPath(p) && matchesIgnore(p, ignore);
  return hides(f.path) || (f.oldPath !== null && hides(f.oldPath));
}

/**
 * §32: for the mods files of a list — `risk` from the path and the A / B content (settings keys), `uncaptured` when
 * either side is a stub, `ignored` when gitignored (force-added: reviewable, not committable). Other files untouched.
 */
async function annotateMods(cp: GitCheckpoint, files: ChangedFile[], start: string, end: string): Promise<void> {
  const mods = files.filter((f) => isModsGroup(f.path));
  if (mods.length === 0) return;
  const ignored = new Set(await cp.ignored(mods.map((f) => f.path)));
  const blob = async (tree: string, path: string): Promise<Buffer | null> => {
    const out = await cp.git(["cat-file", "-p", `${tree}:${path}`], { allowFailure: true });
    return out.status === 0 ? out.stdout : null;
  };
  for (const f of mods) {
    const [before, after, modeA, modeB] = await Promise.all([blob(start, f.oldPath ?? f.path), blob(end, f.path), cp.treeMode(start, f.oldPath ?? f.path), cp.treeMode(end, f.path)]);
    const risk = modsRisks(f.path, modeA === "100755" || modeB === "100755", before, after);
    if (risk.length > 0) f.risk = risk;
    else delete f.risk;
    if ((before !== null && isStubContent(before)) || (after !== null && isStubContent(after))) f.uncaptured = true;
    else delete f.uncaptured;
    if (ignored.has(f.path)) f.ignored = true;
    else delete f.ignored;
  }
}

// MARK: wave4b w4b-bigturn
/**
 * §39.1: a listed file whose A or B side is a large-file stub (its content was never captured) is `tooLarge` (with the
 * size the newer stub records, `largeBytes`) and `uncaptured`: never reverted (`reject` refuses it, `reject_all` skips
 * it, §35.2) and never committed by the app. Read from the trees themselves (two batch calls), so an answer turn — whose
 * A is an older snapshot — and a restored review mark it too. Best effort: a git failure leaves the marks as they are.
 */
async function annotateLarge(cp: GitCheckpoint, files: ChangedFile[], start: string, end: string): Promise<void> {
  if (files.length === 0) return;
  const specs = files.flatMap((f) => [{ tree: start, path: f.oldPath ?? f.path }, { tree: end, path: f.path }]);
  const stubs = await cp.largeStubs(specs).catch(() => new Map<string, number>());
  for (const f of files) {
    const size = stubs.get(`${end}:${f.path}`) ?? stubs.get(`${start}:${f.oldPath ?? f.path}`);
    if (size !== undefined) {
      f.tooLarge = true;
      f.largeBytes = size;
      f.uncaptured = true;
    } else {
      delete f.tooLarge;
      delete f.largeBytes;
    }
  }
}

/** Repo-relative path of `abs` with its directory resolved but not the leaf (a symlink stays itself); null outside the root. */
function leafRelative(abs: string, root: string): string | null {
  return relativeInside(join(realpathLenient(dirname(abs)), basename(abs)), realpathLenient(root));
}

/** The `reject_hunks` marks a file keeps across a refresh / merge / restore. */
function partialOf(f: Partial<Pick<ChangedFile, "partial" | "rejectedHunks">>): Pick<ChangedFile, "partial" | "rejectedHunks"> {
  return f.partial ? { partial: true, ...(f.rejectedHunks ? { rejectedHunks: f.rejectedHunks } : {}) } : {};
}

export function patchHash(patch: string): string {
  return createHash("sha256").update(patch, "utf8").digest("hex");
}

export function truncateDiff(diff: FileDiff): { diff: FileDiff; truncated: boolean } {
  let total = 0;
  for (const h of diff.hunks) total += h.lines.length;
  if (total <= FILE_DIFF_MAX_LINES) return { diff, truncated: false };
  const hunks: FileDiff["hunks"] = [];
  let remaining = FILE_DIFF_MAX_LINES;
  for (const h of diff.hunks) {
    if (remaining <= 0) break;
    hunks.push({ ...h, lines: h.lines.slice(0, remaining) });
    remaining -= h.lines.length;
  }
  return { diff: { ...diff, hunks }, truncated: true };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
