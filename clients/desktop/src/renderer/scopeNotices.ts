/**
 * r1-scope — docs/PROTOCOL.md §33.4 / §39.5 in the desktop client: what already ran outside this window's review is a chat
 * row — never a banner, never `lastError` — naming the files a command changed there, with the folder's actions (move this
 * chat there, open it as a workbench or a folder). The same words as the Mac (Core `ScopeText`; the keys come from its
 * catalog).
 */
import { t } from "./i18n";

/** At most this many file names on a row; the rest are counted. */
export const SHOWN_FILES = 8;

/** The row's sentence when the engine named the files; null otherwise (the §33.4 sentence stands). */
export function scopeRowText(ev: { code?: string; path?: string; files?: readonly string[] }): string | null {
  if (ev.code !== "worktree_outside_review" || !ev.files?.length) return null;
  return ev.path ? t("Changed where this window's review does not see it: {0}", ev.path) : t("Changed where this window's review does not see it");
}

/** The row's line of files: the first `SHOWN_FILES`, then how many more; "" without files. */
export function scopeFilesLine(files: readonly string[] | undefined): string {
  if (!files?.length) return "";
  const head = files.slice(0, SHOWN_FILES).join(", ");
  const more = files.length - Math.min(files.length, SHOWN_FILES);
  return more > 0 ? `${head} ${t("and {0} more", more)}` : head;
}
