/**
 * accept-baseline — docs/PROTOCOL.md §66 on Windows (as the Mac's Core `SinceAccepted.swift`): a file the user accepted and a
 * later turn changed again is reviewed since the accept. Its row and diff header say so ("수락 이후 변경") with the
 * since-accepted status letter, the diff offers "수락 이후 / 라운드 전체", reject's words say the accepted content comes back
 * ("라운드 시작으로 되돌리기" is a menu item with its own confirm), parts are reverted in the since-accepted view against the
 * accepted tree, and the folded group counts the engine's "accepted, not committed yet". Unit-tested in sinceAccepted.test.ts.
 */
import type { ChangedFileState, ChangeStatus, DiffSince, GateState } from "@reviewgate/engine";
import { t } from "./i18n";

type BaseFile = Pick<ChangedFileState, "acceptedBase">;

/** The status letter shown: the change since the accept for a file with an `acceptedBase` (a created, accepted, then edited file is `M`), else the round's. */
export const badgeStatus = (f: Pick<ChangedFileState, "status" | "acceptedBase">): ChangeStatus => f.acceptedBase?.status ?? f.status;

/** The row's and the diff header's label ("수락 이후 변경") and its tooltip. */
export const sinceAcceptedLabel = (): string => t("Changed since accepted");
export const sinceAcceptedHelp = (): string =>
  t("You accepted this file earlier and a later turn changed it again. The +/− and the status letter count what changed since your accept; “Whole round” shows the whole round");

/** The range selector's label for the whole review of a file reviewed since its accept: "라운드 전체" (else null: the usual label). */
export const wholeRoundLabel = (f: BaseFile, since: DiffSince): string | null => (since === "review" && f.acceptedBase ? t("Whole round") : null);

/**
 * The view `since` shows hunk ids `reject_hunks` takes, with the base tree to name: the whole review (`baseTree` of the diff,
 * A), or for a file with an `acceptedBase` its since-accepted view (the accepted tree). null: not a hunk-reject view.
 */
export function hunkRejectBase(f: BaseFile, since: DiffSince | undefined, shownBase: string | undefined): { base: string | undefined } | null {
  if (since === undefined || since === "review") return { base: shownBase };
  if (since === "accepted" && f.acceptedBase) return { base: f.acceptedBase.tree };
  return null;
}

/** The status the hunk reject judges by in `since`: the change since the accept in the since-accepted view, else the round's. */
export const hunkStatus = (f: Pick<ChangedFileState, "status" | "acceptedBase">, since: DiffSince | undefined): ChangeStatus =>
  since === "accepted" && f.acceptedBase ? f.acceptedBase.status : f.status;

/** Reject's tooltip for a file with an `acceptedBase` (it restores the accepted content, never deletes it); null otherwise. */
export const sinceAcceptedRejectHelp = (f: BaseFile): string | null => (f.acceptedBase ? t("Revert to the content you accepted (⌘⇧R)") : null);

/** "라운드 시작으로 되돌리기": offered for a pending file with an `acceptedBase`. */
export const offersRoundReject = (f: Pick<ChangedFileState, "state" | "acceptedBase">): boolean => f.state === "pending" && !!f.acceptedBase;

/**
 * Why "라운드 시작으로 되돌리기" is off (null: on): reject's own reason, a turn running (a reject scheduled during a turn always
 * restores the accepted content, §66), a file whose content was never captured.
 */
export function roundRejectBlocked(f: Pick<ChangedFileState, "uncaptured">, gate: Pick<GateState, "phase">, rejectBlocked: string | null): string | null {
  if (rejectBlocked !== null) return rejectBlocked;
  if (gate.phase === "running" || gate.phase === "collecting") return t("Reject is available when this turn ends");
  if (f.uncaptured) return t("Content not captured (large file / binary) — cannot be reverted");
  return null;
}

export const roundRejectLabel = (): string => t("Revert to the start of the round");
export const roundRejectHelp = (): string => t("Undoes your accept too: the file goes back to how it was before this round and leaves the list");
export const roundRejectTitle = (path: string): string => t("Revert {0} to the start of the round?", path.slice(path.lastIndexOf("/") + 1));
/** The confirm's message: a file this round created is deleted, any other goes back to the round's start. */
export const roundRejectMessage = (f: Pick<ChangedFileState, "status">): string =>
  f.status === "A"
    ? t("The content you accepted goes too. The file did not exist before this round, so it is deleted from disk.")
    : t("The content you accepted goes too. The file on disk goes back to how it was before this round and leaves the review list.");

/** "수락함 · 커밋 전 N": the engine's count (`reviewSummary.acceptedUncommitted`, §66), else (an older engine) the client's own. */
export const acceptedGroupCount = (gate: Partial<Pick<GateState, "reviewSummary">>, own: number): number => gate.reviewSummary?.acceptedUncommitted ?? own;
