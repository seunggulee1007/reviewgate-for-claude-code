/**
 * MARK: r2-review-flow — M28: "Accept all" applies at once with an undo toast — the summary dialog only for files not looked at or sensitive;
 * the commit dialog takes pending files too ("검토 완료로 표시하고 커밋"); "push after commit" is kept per project (the Mac's
 * Core ReviewFlow+Accept.swift).
 */
import type { ChangedFileState } from "@reviewgate/engine";
import { t } from "./i18n";

// ---------------------------------------------------------------- M28 accept and commit in one action

/** The summary dialog opens only when a pending file was never looked at, changed since, or is sensitive. */
export function acceptAllNeedsDialog(counts: { unviewed: number; changedSinceViewed: number; sensitive: number }): boolean {
  return counts.unviewed + counts.changedSinceViewed + counts.sensitive > 0;
}

export const acceptedToast = (count: number): string => t("Accepted {0} files", count);

type CommitFile = Pick<ChangedFileState, "path" | "state" | "ignored" | "tooLarge">;

/** The files the commit dialog lists: accepted (committable) first, then pending ones (gitignored / too-large never commit). */
export function commitListed(committable: readonly string[], files: readonly CommitFile[]): string[] {
  const pending = files.filter((f) => f.state === "pending" && f.ignored !== true && f.tooLarge !== true).map((f) => f.path);
  return [...committable, ...pending.filter((p) => !committable.includes(p))];
}

/** The ticked files still pending: accepted first by "검토 완료로 표시하고 커밋" (accepting writes nothing). */
export function commitToAccept(ticked: ReadonlySet<string>, files: readonly CommitFile[]): string[] {
  return files.filter((f) => f.state === "pending" && ticked.has(f.path) && f.ignored !== true && f.tooLarge !== true).map((f) => f.path);
}

const pushKey = (root: string) => `rg.commitPush.${root}`;

/** "Push after commit", kept per project (the global default until the user chose here). */
export function commitPushFor(root: string | null, fallback: boolean, storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  if (!root || !storage) return fallback;
  try {
    const v = storage.getItem(pushKey(root));
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function setCommitPushFor(root: string | null, on: boolean, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  if (!root || !storage) return;
  try {
    storage.setItem(pushKey(root), on ? "1" : "0");
  } catch {
    // private window / blocked storage: the choice lasts until the dialog closes
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
