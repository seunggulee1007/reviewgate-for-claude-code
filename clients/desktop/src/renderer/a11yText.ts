/**
 * MARK: wave4d w4d-speed — audit polish-10: what a screen reader says for the review's rows, in the Mac's words (Core
 * `ReviewSpeech`, the same English keys — ko.json is generated from its catalog): a diff line starts with its kind and number
 * ("추가된 줄 42:"), a file's status letter and review mark are words, "+12 −3" is "12줄 추가, 3줄 삭제".
 */
import type { ChangeStatus, DiffLine, FileReviewState } from "@reviewgate/engine";
import { t } from "./i18n";

/** The status letter (M / A / D / R / X) as a word. */
export function statusWord(status: ChangeStatus): string {
  switch (status) {
    case "M":
      return t("Modified");
    case "A":
      return t("Added");
    case "D":
      return t("Deleted");
    case "R":
      return t("Renamed");
    default:
      return t("Other change");
  }
}

/** A file's review state (the dot, the check, the arrow at the end of its row). */
export function stateWord(state: FileReviewState): string {
  switch (state) {
    case "pending":
      return t("Pending review");
    case "accepted":
      return t("Accepted");
    case "rejected":
      return t("Rejected");
    case "changesRequested":
      return t("Changes requested");
  }
}

/** "+12 −3" read out. */
export const countsText = (added: number, deleted: number): string => t("{0} lines added, {1} removed", added, deleted);

/** What a diff row says before its code: its kind and the number on its own side. */
export function diffLinePrefix(line: Pick<DiffLine, "kind" | "oldNo" | "newNo">): string {
  switch (line.kind) {
    case "add":
      return line.newNo != null ? t("Added line {0}:", line.newNo) : t("Added line:");
    case "del":
      return line.oldNo != null ? t("Removed line {0}:", line.oldNo) : t("Removed line:");
    case "context": {
      const n = line.newNo ?? line.oldNo;
      return n != null ? t("Unchanged line {0}:", n) : t("Unchanged line:");
    }
    case "hunkHeader":
      return t("Changed part:");
  }
}
