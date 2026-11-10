import { statfs } from "node:fs/promises";
import type { DiskLevel, DiskSpace, SaveFailure, SaveWhat } from "../protocol.js";

/**
 * MARK: wave4b w4b-bigturn — §39.1 (robustness-11 ② ③): what the engine could not save, and how much room the
 * repository's volume has left. Both end up in `state.storage`.
 */

/** Below this the HUD shows the free space in orange (a disk with a few GB to spare shows no chip). */
export const DISK_LOW_BYTES = 2 * 1024 ** 3;
/** Below this it turns red and the clients show one banner. */
export const DISK_CRITICAL_BYTES = 1024 ** 3;
/**
 * MARK: wave7 w7-state — §45.2: a new reading is published when the level changed, or when the free space moved by this
 * fraction of the last published one — a quarter while the level is ok (no client shows the figure then), a tenth below
 * it (the HUD chip's figure). Swap growing on the same volume no longer sends a snapshot every 256 MB.
 */
export const DISK_REPORT_FRACTION_OK = 0.25;
export const DISK_REPORT_FRACTION_LOW = 0.1;

export function diskLevel(freeBytes: number): DiskLevel {
  if (freeBytes < DISK_CRITICAL_BYTES) return "critical";
  if (freeBytes < DISK_LOW_BYTES) return "low";
  return "ok";
}

/** `statfs` of the volume holding `path`; null when it cannot be read (an old Node, a vanished folder). */
export async function readDiskSpace(path: string, now: Date = new Date()): Promise<DiskSpace | null> {
  try {
    const s = await statfs(path);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < 0) return null;
    return { freeBytes, totalBytes, level: diskLevel(freeBytes), at: now.toISOString() };
  } catch {
    return null;
  }
}

/** True when `next` is worth a state update over `prev` (the last published reading). */
export function diskChanged(prev: DiskSpace | null, next: DiskSpace | null): boolean {
  if (prev === null || next === null) return prev !== next;
  if (prev.level !== next.level) return true;
  const fraction = next.level === "ok" ? DISK_REPORT_FRACTION_OK : DISK_REPORT_FRACTION_LOW;
  return Math.abs(prev.freeBytes - next.freeBytes) >= prev.freeBytes * fraction;
}

/**
 * The error code of a failed save: Node's `code` (`ENOSPC`, `EDQUOT`, `EROFS`, `EACCES`, …), else read from git's words
 * ("No space left on device" — a `git update-ref` / `hash-object` that failed for the same reason). Null when unknown.
 */
export function saveErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return code;
  const text = e instanceof Error ? e.message : String(e);
  if (/no space left on device/i.test(text)) return "ENOSPC";
  if (/disk quota exceeded/i.test(text)) return "EDQUOT";
  if (/read-only file system/i.test(text)) return "EROFS";
  if (/permission denied/i.test(text)) return "EACCES";
  return null;
}

export function isDiskFullCode(code: string | null): boolean {
  return code === "ENOSPC" || code === "EDQUOT";
}

function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300);
}

/**
 * The saves that are failing now, by kind. A kind clears with its next good save; `since` is when the current run of
 * failures began (clients show one banner per `since`: the same failure repeating is not a new one).
 */
export class SaveHealth {
  private failing = new Map<SaveWhat, { code: string | null; detail: string; at: string }>();
  private since: string | null = null;

  /** Records a failed save; true when the view changed (a kind that was fine, or another code). */
  fail(what: SaveWhat, e: unknown, now: Date = new Date()): boolean {
    const code = saveErrorCode(e);
    const prev = this.failing.get(what);
    const at = now.toISOString();
    this.failing.set(what, { code, detail: firstLine(e), at });
    if (this.since === null) this.since = at;
    return prev === undefined || prev.code !== code;
  }

  /** A good save of `what`; true when it cleared a failure. */
  ok(what: SaveWhat): boolean {
    if (!this.failing.delete(what)) return false;
    if (this.failing.size === 0) this.since = null;
    return true;
  }

  has(what: SaveWhat): boolean {
    return this.failing.has(what);
  }

  clear(): void {
    this.failing.clear();
    this.since = null;
  }

  get view(): SaveFailure | null {
    if (this.failing.size === 0 || this.since === null) return null;
    const entries = [...this.failing.entries()].sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0));
    const [, latest] = entries[0]!;
    const codes = entries.map(([, f]) => f.code);
    const code = codes.find((c) => isDiskFullCode(c)) ?? latest.code;
    return {
      what: entries.map(([w]) => w).sort(),
      code,
      diskFull: isDiskFullCode(code),
      detail: latest.detail,
      since: this.since,
      at: latest.at,
    };
  }
}
