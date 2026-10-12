/**
 * MARK: wave2 desktop-diff — the data side of the diff's line tools (audit comp-19): "diff에서 찾기" hits over the diff's
 * code lines (folded ones included — the view unfolds the current hit), and the `path:line` "경로:줄 복사" puts on the
 * clipboard. Pure and unit-tested (diffTools.test.ts).
 */
import type { DiffLine, FileDiff } from "@reviewgate/engine";
import { matchOffsets } from "./transcriptFind";

/** Hits beyond this many are not listed (the count says "N+"; painting stays cheap on a 20 000-line diff). */
export const MAX_FIND_MATCHES = 2000;

export type DiffMatch = { lineId: number; start: number };

/** Case-insensitive hits of `query` in the add / del / context lines, in diff order (hunk header rows are not code). */
export function findInDiff(diff: FileDiff, query: string): DiffMatch[] {
  if (query.trim().length === 0) return [];
  const out: DiffMatch[] = [];
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      if (l.kind === "hunkHeader") continue;
      for (const start of matchOffsets(l.text, query)) {
        out.push({ lineId: l.id, start });
        if (out.length >= MAX_FIND_MATCHES) return out;
      }
    }
  }
  return out;
}

/**
 * The new file's line to open the editor at for a diff line: its own new number, for a deleted line the next new line
 * of its hunk (where it was), else the one before; null for a header row.
 */
export function newLineNear(diff: FileDiff, line: DiffLine): number | null {
  if (line.kind === "hunkHeader") return null;
  if (line.newNo !== null) return line.newNo;
  for (const h of diff.hunks) {
    const at = h.lines.indexOf(line);
    if (at < 0) continue;
    for (let i = at + 1; i < h.lines.length; i++) if (h.lines[i]!.newNo !== null) return h.lines[i]!.newNo;
    for (let i = at - 1; i >= 0; i--) if (h.lines[i]!.newNo !== null) return h.lines[i]!.newNo;
    return null;
  }
  return null;
}

/** `path:line` of a diff line — a deleted line by its old path and number (the line is only in the old file). */
export function pathLineOf(line: DiffLine, path: string, oldPath: string | null): string | null {
  if (line.kind === "hunkHeader") return null;
  if (line.kind === "del") return line.oldNo === null ? null : `${oldPath ?? path}:${line.oldNo}`;
  return line.newNo === null ? null : `${path}:${line.newNo}`;
}
