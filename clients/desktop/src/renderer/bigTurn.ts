/**
 * MARK: wave4b w4b-bigturn
 * docs/PROTOCOL.md §39.1 in Electron (as on the Mac, BigTurn.swift) — pure, unit-tested: the save-failure banner (one per
 * run of failures), the HUD's disk chip below 2 GB and one critical banner below 1 GB, the large files left out of the
 * review, the bulk list folded by folder (`foldFolders`, reused by the files pane's "묶기 › 폴더") and the cleanup's words.
 */
import type { ChangedFileState, DiskSpace, HistoryCleanupEvent, SaveFailure, StorageState } from "@reviewgate/engine";
import { t } from "./i18n";

/** settings.largeFileMB: the engine's default and range. */
export const DEFAULT_LARGE_FILE_MB = 50;
export const MIN_LARGE_FILE_MB = 1;
export const MAX_LARGE_FILE_MB = 100_000;
/** history_cleanup.keep: what a cleanup keeps. */
export const DEFAULT_CLEANUP_KEEP = 20;

export function largeFileMBOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= MIN_LARGE_FILE_MB && v <= MAX_LARGE_FILE_MB ? Math.round(v) : DEFAULT_LARGE_FILE_MB;
}

/** The save-failure banner: shown until closed — never again for the same run of failures (`since`). */
export function saveFailureNotice(storage: StorageState | undefined | null, dismissedSince: string | null): SaveFailure | null {
  const f = storage?.saveFailed;
  if (!f || typeof f.since !== "string" || !f.since || f.since === dismissedSince) return null;
  return f;
}

/** The HUD chip: only below the low mark (a disk with a few GB to spare never sees it). */
export function diskChip(storage: StorageState | undefined | null): DiskSpace | null {
  const d = storage?.disk;
  return d && (d.level === "low" || d.level === "critical") ? d : null;
}

/** The one critical banner (below 1 GB), once per window until closed. */
export function diskCritical(storage: StorageState | undefined | null, dismissed: boolean): DiskSpace | null {
  const d = storage?.disk;
  return !dismissed && d && d.level === "critical" ? d : null;
}

/** "1.2 GB", "380 MB" (decimal units, as the Mac's file-size style). */
export function formatBytes(n: number): string {
  const v = Math.max(0, n);
  if (v < 1000) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1000;
  let i = 0;
  while (x >= 1000 && i < units.length - 1) {
    x /= 1000;
    i++;
  }
  return `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10} ${units[i]}`;
}

export function saveFailedText(f: SaveFailure): string {
  if (f.diskFull) {
    if (f.what.includes("review")) return t("The disk is full, so the review could not be saved — free some space and retry.");
    if (f.what.includes("history")) return t("The disk is full, so the review history could not be saved — free some space and retry.");
    if (f.what.includes("checkpoints")) return t("The disk is full, so the checkpoints could not be saved — free some space and retry.");
    return t("The disk is full, so the chat could not be saved — free some space and retry.");
  }
  return t("Could not save the review ({0}).", f.code ?? "?");
}

export function diskChipText(d: DiskSpace): string {
  return t("Disk {0} free", formatBytes(d.freeBytes));
}

export function diskCriticalText(d: DiskSpace): string {
  return t("Only {0} left on the disk — the review and its history may fail to save.", formatBytes(d.freeBytes));
}

/** The review's files whose content no snapshot holds because of their size. */
export function largeFilesOf(files: readonly ChangedFileState[]): ChangedFileState[] {
  return files.filter((f) => f.tooLarge === true);
}

export function largeFilesText(count: number): string {
  return t("{0} large file(s) kept out of snapshots (cannot be reverted)", count);
}

export function largeFileRow(f: ChangedFileState): string {
  return typeof f.largeBytes === "number" ? `${f.path} · ${formatBytes(f.largeBytes)}` : f.path;
}

// ---------------------------------------------------------------- robustness-10 ②: a bulk list folds by folder

/** More changed files than this make a bulk change. */
export const BULK_THRESHOLD = 300;
/** At most this many folders: deeper ones merge into their parents until it fits. */
export const MAX_FOLDER_GROUPS = 40;

export function isBulk(count: number): boolean {
  return count > BULK_THRESHOLD;
}

export function bulkText(count: number): string {
  return t("Bulk change: {0} files", count);
}

export type FolderGroup = { folder: string; paths: string[] };

/** The folder of `path` cut to its first `depth` levels ("" for a file at the root). */
export function folderOf(path: string, depth: number): string {
  const parts = path.split("/");
  parts.pop();
  return parts.slice(0, depth).join("/");
}

function groupsAt(paths: readonly string[], depth: number): FolderGroup[] {
  const by = new Map<string, string[]>();
  for (const p of paths) {
    const f = folderOf(p, depth);
    const list = by.get(f);
    if (list) list.push(p);
    else by.set(f, [p]);
  }
  return [...by.keys()].sort(cmp).map((folder) => ({ folder, paths: [...by.get(folder)!].sort(cmp) }));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Grouped by each file's own folder. */
export function byParent(paths: readonly string[]): FolderGroup[] {
  return groupsAt(paths, Number.MAX_SAFE_INTEGER);
}

/** The deepest grouping by the first d folder levels with at most `maxGroups` groups; one level at least. */
export function foldFolders(paths: readonly string[], maxGroups = MAX_FOLDER_GROUPS): FolderGroup[] {
  const deepest = paths.reduce((n, p) => Math.max(n, p.split("/").length - 1), 0);
  let best = groupsAt(paths, 1);
  for (let depth = 2; depth <= deepest; depth++) {
    const g = groupsAt(paths, depth);
    if (g.length > maxGroups) break;
    best = g;
  }
  return best;
}

/** A folder group's header: "gen/x/ 120". */
export function folderTitle(folder: string, count: number): string {
  return `${folder === "" ? "/" : folder + "/"} ${count}`;
}

// ---------------------------------------------------------------- robustness-11 ④: [오래된 리뷰 기록 정리]

export function cleanupConfirmText(r: HistoryCleanupEvent): string {
  if (typeof r.bytes !== "number") return t("Removes {0} review round(s) and {1} checkpoint(s), keeping the newest {2}.", r.rounds, r.checkpoints, r.keep);
  return t("Removes {0} review round(s) and {1} checkpoint(s), keeping the newest {2} — about {3} freed.", r.rounds, r.checkpoints, r.keep, formatBytes(r.bytes));
}

export function cleanupNothing(r: HistoryCleanupEvent): boolean {
  return r.rounds === 0 && r.checkpoints === 0 && r.refs === 0;
}

export function cleanupNothingText(r: HistoryCleanupEvent): string {
  return t("Nothing to clean up — {0} review round(s), all among the newest {1}.", r.kept, r.keep);
}

export function cleanupDoneText(r: HistoryCleanupEvent): string {
  return t("Removed {0} review round(s) and {1} checkpoint(s).", r.rounds, r.checkpoints);
}
