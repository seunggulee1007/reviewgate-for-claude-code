/**
 * §26 rewind / edit & retry, the pure parts: which of "대화만 / 파일만 / 둘 다" a user message allows and why not
 * (`state.session.checkpoints`, the H3 lock), how a refusal is presented, and the default mode of "수정해서 다시 보내기".
 */
import type { ReviewState, RewindMode, TurnCheckpointView } from "@reviewgate/engine";
import { t } from "./i18n";

export type ModeAvailability = { ok: true } | { ok: false; why: string };
export type RewindAvailability = {
  checkpoint: TurnCheckpointView | null;
  /** Why nothing can be rewound right now (a turn / collection / revert / session start in flight), else null. */
  busy: string | null;
  conversation: ModeAvailability;
  files: ModeAvailability;
  both: ModeAvailability;
};

export const checkpointsOf = (s: ReviewState): TurnCheckpointView[] => s.session.checkpoints ?? [];

/** The H3 lock the engine refuses `rewind` with (`session_busy`). */
export function rewindBusy(s: ReviewState): string | null {
  if (s.session.starting || s.gate.phase === "starting") return t("The session is still starting — try again in a moment.");
  if (s.gate.phase === "running" || s.gate.phase === "collecting") return t("Claude is working — you can rewind once the turn has ended.");
  if (s.gate.phase === "reverting") return t("Files are being reverted — try again in a moment.");
  return null;
}

export function rewindAvailability(s: ReviewState, turn: number | undefined): RewindAvailability {
  const checkpoint = typeof turn === "number" ? (checkpointsOf(s).find((c) => c.turn === turn) ?? null) : null;
  const busy = rewindBusy(s);
  if (!checkpoint) {
    const why = t("This message has no checkpoint (sent before rewinding was available, or older than the last 50 turns).");
    const no = { ok: false as const, why };
    return { checkpoint, busy, conversation: no, files: no, both: no };
  }
  const conversation: ModeAvailability = checkpoint.canRewindConversation
    ? { ok: true }
    : { ok: false, why: t("The conversation cannot be rewound here: the turn before it ended without a resumable point.") };
  const files: ModeAvailability = checkpoint.canRewindFiles
    ? { ok: true }
    : { ok: false, why: t("Claude's file changes cannot be put back from here: a later turn's snapshot is missing.") };
  const both: ModeAvailability = !conversation.ok ? conversation : !files.ok ? files : { ok: true };
  return { checkpoint, busy, conversation, files, both };
}

/** "수정해서 다시 보내기": files go back too when that is possible (`both`), else only the conversation. */
export function editRetryMode(a: RewindAvailability, restoreFiles: boolean): RewindMode {
  return restoreFiles && a.files.ok ? "both" : "conversation";
}

/** How the dialog / inline editor presents a refusal. */
export type RewindRefusalView =
  /** `file_changed_since_review`: confirm, then retry with `force: true`. */
  | { kind: "force"; paths: string[] }
  /** `review_pending` / `notes_pending`: finish the review first (with a jump to it). */
  | { kind: "review"; message: string }
  /** `session_busy` / `reverting`: wait for the turn. */
  | { kind: "busy"; message: string }
  | { kind: "error"; message: string };

export function rewindRefusalView(r: { code: string; message: string; paths?: string[] }): RewindRefusalView {
  switch (r.code) {
    case "file_changed_since_review":
      return { kind: "force", paths: r.paths ?? [] };
    case "review_pending":
    case "notes_pending":
      return { kind: "review", message: r.code === "notes_pending" ? t("Finish the review first — send or delete your review notes.") : t("Finish the review first — accept or reject the pending files.") };
    case "session_busy":
    case "reverting":
    case "session_running":
      return { kind: "busy", message: t("Claude is working — you can rewind once the turn has ended.") };
    default:
      return { kind: "error", message: r.message };
  }
}

/** Mode labels of the dialog. */
export function rewindModeLabel(m: RewindMode): string {
  switch (m) {
    case "conversation":
      return t("Conversation only");
    case "files":
      return t("Files only");
    case "both":
      return t("Both");
  }
}
