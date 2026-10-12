/**
 * wave2 desktop-flow — review round 2 (docs/PROTOCOL.md §34) as pure helpers (unit-tested in reviewRound.test.ts):
 * which B the review's diffs refer to while a turn runs (§34.2), accept / reject during a turn, the diff ranges and their
 * defaults (§34.1), viewed by content (§34.5), the Changes list's screen order (comp-10), sent notes (§34.4), the
 * turn_end row's review totals (§34.3) and the live changes totals (§34.6).
 *
 * Every §34 field is optional: an engine before §34 sends none of them, and these helpers then answer as before (the
 * whole review only, viewed by path, no accept during a turn, no sent notes).
 */
import type { ChangedFileState, ChangeTotals, DiffLine, DiffSince, FileDiff, GateState, ReviewNote, ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";
import { groupChanges } from "./reviewGate";
import { sortByRisk } from "./risk";
import { currentCauseOf, currentGroupBy, orderByGroups, type GroupBy } from "./fileGroups"; // MARK: wave4b w4b-files (wave4c w4c-review: by cause)
import { isBulk } from "./bigTurn"; // MARK: wave4b w4b-files

// ---------------------------------------------------------------- §34.2 the B the review refers to

type TreeGate = Pick<GateState, "turnEndTree"> & Partial<Pick<GateState, "reviewEndTree">>;

/** `gate.reviewEndTree` (§34.2: B, or the held B while a turn runs), else `turnEndTree` (an engine before §34). */
export const diffTreeOf = (g: TreeGate): string | null => g.reviewEndTree ?? g.turnEndTree ?? null;

/** The engine speaks §34 (it always sends `reviewEndTree`, null without a review). */
export const hasReviewRound2 = (g: Partial<Pick<GateState, "reviewEndTree">>): boolean => g.reviewEndTree !== undefined;

/** A turn runs or is being collected: the review's diffs are read-only (`stale`). */
export const isTurnActive = (g: Pick<GateState, "phase">): boolean => g.phase === "running" || g.phase === "collecting";

/**
 * Why accept / accept_all cannot be offered now (null: it can). §34.2: during a running turn on a standing review (the
 * held B) it applies at once — accepted only if the turn leaves the file alone; refused while collecting, without a
 * held B (a fresh turn: nothing is pending) and by an engine before §34.
 */
export function acceptBlockedReason(s: Pick<ReviewState, "gate">): string | null {
  const g = s.gate;
  switch (g.phase) {
    case "reverting":
      return t("Reverting…");
    case "collecting":
      return t("Collecting changes…");
    case "running":
      return hasReviewRound2(g) && diffTreeOf(g) !== null ? null : t("Claude is working…");
    default:
      return null;
  }
}

/**
 * Why reject / reject_all / reject_hunks cannot be offered now: they wait for the turn's end (§34.2) or the revert, and
 * (§37.1) for a failed collection's Retry — the engine refuses them `collect_failed` until it succeeded.
 */
export function rejectBlockedReason(s: Pick<ReviewState, "gate">): string | null {
  if (s.gate.phase === "reverting") return t("Reverting…");
  if (isTurnActive(s.gate)) return t("Reject is available when this turn ends");
  return collectFailedReason(s);
}

/** §37.1: reject / reject_all / reject_hunks / commit wait while a collection failed ("Retry first"); null otherwise. */
export function collectFailedReason(s: Pick<ReviewState, "gate">): string | null {
  return s.gate.phase === "collect_failed" || (s.gate.collectError ?? null) !== null ? t("Retry collecting the changes first") : null;
}

// ---------------------------------------------------------------- §34.1 ranges

type RangeGate = Partial<Pick<GateState, "reviewTurns" | "lastTurnChanges" | "lastRequest">>;
type RangeFile = Pick<ChangedFileState, "state" | "changedThisTurn" | "changedSinceAccepted" | "changedSinceRequest" | "sentNoteCount">;

/** The follow-up of the last `request_changes` has been collected (its numbers are in `lastTurnChanges`). */
const requestCollected = (g: RangeGate): boolean => !!g.lastRequest && !!g.lastTurnChanges && g.lastTurnChanges.turn >= g.lastRequest.turn;

/**
 * The ranges a file's diff can be shown in, in the selector's order — each only where it shows something the whole review
 * does not (the Mac's ReviewRange rules): "이번 턴" when the review spans more than one turn and the last one changed the
 * file, but not when that turn is the change request's own follow-up and "요청 이후" is offered (the two show the same
 * lines); "요청 이후" after a request in this review for a file changed since; "수락 이후" for a file that was accepted and
 * changed again. A file with sent notes the follow-up left alone says so in the list ("요청 후 바뀌지 않음").
 */
export function availableRanges(f: RangeFile, g: RangeGate): DiffSince[] {
  const out: DiffSince[] = ["review"];
  const request = !!g.lastRequest && f.changedSinceRequest === true;
  const lastTurn = g.lastTurnChanges?.turn ?? g.reviewTurns?.[g.reviewTurns.length - 1];
  const turnIsTheRequestsFollowUp = request && lastTurn !== undefined && g.lastRequest?.turn === lastTurn;
  if (f.changedThisTurn === true && (g.reviewTurns?.length ?? 0) > 1 && !turnIsTheRequestsFollowUp) out.push("turn");
  if (request) out.push("request");
  if (f.changedSinceAccepted === true) out.push("accepted");
  return out;
}

/**
 * The range a pending file opens in (as on the Mac): accepted, then changed again → "수락 이후"; sent back with notes and
 * changed by the follow-up → "요청 이후"; anything else — a file nobody decided on yet included — the whole review, so a
 * part that was never looked at is never hidden.
 */
export function defaultRange(f: RangeFile, g: RangeGate): DiffSince {
  if (f.state !== "pending") return "review";
  if (f.changedSinceAccepted === true) return "accepted";
  if (g.lastRequest && f.changedSinceRequest === true && (f.sentNoteCount ?? 0) > 0) return "request";
  return "review";
}

/**
 * The range a file's diff was opened or picked in, with the content it was chosen on (`contentKey`): it holds until the
 * file's content changes — another file's reject, a removed note or a new B elsewhere never moves it (as on the Mac).
 */
export type RangeChoice = { since: DiffSince; content: string };

/** The range `f` opens in now: its remembered one while its content is the same and the range is still offered, else the default. */
export function rangeFor(f: RangeFile & Pick<ChangedFileState, "blob" | "status">, g: RangeGate, choice: RangeChoice | undefined): DiffSince {
  if (choice && choice.content === contentKey(f) && availableRanges(f, g).includes(choice.since)) return choice.since;
  return defaultRange(f, g);
}

export function rangeLabel(since: DiffSince): string {
  switch (since) {
    case "review":
      return t("Whole review");
    case "turn":
      return t("This turn");
    case "request":
      return t("Since request");
    case "accepted":
      return t("Since accepted");
  }
}

/** Diff caches are per (path, range) within one B; the whole review keeps the bare path (what other readers look up). */
export const rangeCacheKey = (path: string, since: DiffSince): string => (since === "review" ? path : `${path}\u0000${since}`);

/** "요청 후 바뀌지 않음": the file carries sent notes and the collected follow-up left it as it was at the request. */
export function unchangedSinceRequest(f: Pick<ChangedFileState, "sentNoteCount" | "changedSinceRequest">, g: RangeGate): boolean {
  return (f.sentNoteCount ?? 0) > 0 && f.changedSinceRequest !== true && requestCollected(g);
}

// ---------------------------------------------------------------- §34.5 viewed by content

export type ViewState = "viewed" | "changed" | "unviewed";

/** What "봤음" is keyed on besides the path: the blob in B, "deleted" without one; "" for an engine without `blob` (path only). */
export function contentKey(f: Pick<ChangedFileState, "blob" | "status">): string {
  if (typeof f.blob === "string" && f.blob.length > 0) return f.blob;
  return f.status === "D" ? "deleted" : "";
}

/** `viewed`: path → the content key seen. A key that differs from the current one is "본 뒤 바뀜". */
export function viewStateOf(f: Pick<ChangedFileState, "path" | "blob" | "status">, viewed: Readonly<Record<string, string>>): ViewState {
  const seen = viewed[f.path];
  if (seen === undefined) return "unviewed";
  return seen === contentKey(f) ? "viewed" : "changed";
}

/** Pending files whose content changed after they were viewed (the "본 뒤 바뀜 N개" count). */
export function changedSinceViewed<F extends ChangedFileState>(files: readonly F[], viewed: Readonly<Record<string, string>>): F[] {
  return files.filter((f) => f.state === "pending" && viewStateOf(f, viewed) === "changed");
}

// ---------------------------------------------------------------- comp-10 screen order

/** The Changes list as drawn: settings & hooks · Claude's · outside groups, risky first inside each when chosen. */
export function displayOrder(files: readonly ChangedFileState[], riskFirst: boolean, groupBy: GroupBy = currentGroupBy()): ChangedFileState[] {
  // MARK: wave4b w4b-files — §40.2: inside each group, the "묶기" sections in order (a bulk list folds by folder instead).
  const by = isBulk(files.length) ? "none" : groupBy;
  return groupChanges(files).flatMap((g) => orderByGroups(riskFirst ? sortByRisk(g.files) : g.files, by, (f) => currentCauseOf(f.path)));
}

/** ⌘] / ⌘[: the next / previous pending file on screen after `current` (wrapping; another one than `current`). */
export function stepPending(order: readonly ChangedFileState[], current: string | null, dir: 1 | -1): string | null {
  const n = order.length;
  if (n === 0) return null;
  const idx = order.findIndex((f) => f.path === current);
  const start = idx < 0 ? (dir === 1 ? -1 : n) : idx;
  for (let step = 1; step <= n; step++) {
    const f = order[(((start + dir * step) % n) + n) % n]!;
    if (f.state === "pending" && f.path !== current) return f.path;
  }
  return null;
}

/** After accept / reject of `path`: the next pending file below it on screen, else the first pending one. */
export const nextPendingAfter = (order: readonly ChangedFileState[], path: string): string | null => stepPending(order, path, 1);

// ---------------------------------------------------------------- §34.4 sent notes

/** Notes still to send with `request_changes` (`noteCount`, the Request changes count and every "notes pending" guard). */
export const unsentNotes = (notes: readonly ReviewNote[]): ReviewNote[] => notes.filter((n) => !n.sent);
/** Notes that went to Claude ("요청함: … — 반영 확인"). */
export const sentNotes = (notes: readonly ReviewNote[]): ReviewNote[] => notes.filter((n) => !!n.sent);

/**
 * Which notes can sit under their line in the shown diff: a note whose line is gone (§34.4 `anchor: "gone"`), a file
 * note (no line) and — with a diff — one whose line is not in it go above the diff instead, so none is hidden or drawn
 * under a line that now holds something else. `diff` null: the full-file view (every line of the file is there).
 */
export function placeNotes(notes: readonly ReviewNote[], diff: Pick<FileDiff, "hunks"> | null): { inline: ReviewNote[]; outside: ReviewNote[] } {
  let shown: Set<string> | null = null;
  if (diff) {
    shown = new Set<string>();
    for (const h of diff.hunks) for (const l of h.lines) {
      const k = lineSlot(l);
      if (k) shown.add(k);
    }
  }
  const inline: ReviewNote[] = [];
  const outside: ReviewNote[] = [];
  for (const n of notes) {
    const placeable = n.line !== null && n.anchor !== "gone" && (shown === null || shown.has(`${n.side}:${n.line}`));
    (placeable ? inline : outside).push(n);
  }
  return { inline, outside };
}

/** The note slot of a diff line (`side:line`, as UnifiedDiff's `keyId(lineKey(line))`); null for a hunk header. */
function lineSlot(l: DiffLine): string | null {
  if (l.kind === "hunkHeader") return null;
  if (l.kind === "del") return l.oldNo !== null ? `old:${l.oldNo}` : null;
  return l.newNo !== null ? `new:${l.newNo}` : null;
}

/** "+12" / "−7": the side and line a note points at. */
export const noteLineLabel = (n: Pick<ReviewNote, "line" | "side">): string | null => (n.line === null ? null : `${n.side === "old" ? "−" : "+"}${n.line}`);

// ---------------------------------------------------------------- §34.3 the turn_end row

/** A question / request-changes follow-up merged into the review: the whole review's totals after this turn's own. */
export function turnEndReviewText(ev: { merged?: true; review?: ChangeTotals }): string {
  if (ev.merged !== true || !ev.review) return "";
  return t("whole review: {0} file(s) (+{1} −{2})", ev.review.files, ev.review.added, ev.review.deleted);
}

/**
 * wave3 check-clients — the turn summary card's "리뷰 전체: 파일 N개 · +A −D" next to this turn's own numbers (as the Mac's
 * TurnSummary.reviewTotalsShown): only for a turn merged into a standing review; a fresh turn's review is that turn.
 */
export function summaryReviewTotals(s: { merged?: true; review?: ChangeTotals }): ChangeTotals | null {
  return s.merged === true && s.review ? s.review : null;
}

// ---------------------------------------------------------------- §34.6 live changes

/** The HUD's "진행 중" totals: the listed files' +/−, and at least the count `hud.turnFiles` has without a snapshot. */
export function liveTotals(files: readonly { added: number; deleted: number }[], turnFiles: number): ChangeTotals {
  return {
    files: Math.max(files.length, turnFiles),
    added: files.reduce((n, f) => n + f.added, 0),
    deleted: files.reduce((n, f) => n + f.deleted, 0),
  };
}
