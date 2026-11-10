import type { FileDiff } from "./parse.js";

/**
 * The whole new content of a changed file plus where this turn's diff touched it
 * (port of Core `Diff/FullFileView.swift`). Line numbers are 1-based and refer to `lines`.
 */
export type FullFileView = {
  path: string;
  /** Empty when `isBinary` or `isTooLarge`. */
  lines: string[];
  /** Ascending, unique. */
  changedNewLines: number[];
  /** Deleted old lines, keyed by the new line number they follow (0 = before the first line). */
  deletedAfterNewLine: Record<number, string[]>;
  isBinary: boolean;
  /** More than `FULL_FILE_MAX_LINES` lines or `FULL_FILE_MAX_BYTES` bytes. */
  isTooLarge: boolean;
  /** Old/new text for a side-by-side editor; null when binary or too large. */
  oldText: string | null;
  newText: string | null;
};

export const FULL_FILE_MAX_LINES = 20_000;
export const FULL_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** Derives the view from the file's new bytes and its parsed unified diff. */
export function deriveFullFile(path: string, newBytes: Buffer, diff: FileDiff, isBinary = false): FullFileView {
  const binary = isBinary || diff.isBinary || newBytes.subarray(0, 8192).includes(0);
  const text = binary ? "" : newBytes.toString("utf8");
  const split = text.split(/\r?\n/);
  if (split[split.length - 1] === "") split.pop();
  const tooLarge = newBytes.length > FULL_FILE_MAX_BYTES || split.length > FULL_FILE_MAX_LINES;

  const changed = new Set<number>();
  const deleted: Record<number, string[]> = {};
  if (!binary && !tooLarge) {
    for (const hunk of diff.hunks) {
      let lastNew = newStart(hunk.header) - 1;
      for (const line of hunk.lines) {
        switch (line.kind) {
          case "add":
            if (line.newNo !== null) {
              changed.add(line.newNo);
              lastNew = line.newNo;
            }
            break;
          case "context":
            if (line.newNo !== null) lastNew = line.newNo;
            break;
          case "del": {
            const key = Math.max(0, lastNew);
            (deleted[key] ??= []).push(line.text);
            break;
          }
          case "hunkHeader":
            break;
        }
      }
    }
  }

  const usable = !binary && !tooLarge;
  return {
    path,
    lines: usable ? split : [],
    changedNewLines: [...changed].sort((a, b) => a - b),
    deletedAfterNewLine: deleted,
    isBinary: binary,
    isTooLarge: tooLarge,
    oldText: usable ? reconstructOld(split, diff, text.endsWith("\n")) : null,
    newText: usable ? text : null,
  };
}

/** `@@ -a,b +c,d @@` → c (1 when unparsable). */
function newStart(header: string): number {
  const plus = header.indexOf(" +");
  if (plus < 0) return 1;
  const m = /^[0-9]+/.exec(header.slice(plus + 2));
  return m ? Number.parseInt(m[0], 10) : 1;
}

/**
 * Rebuilds the old text by applying the diff in reverse to the new lines: added lines are dropped,
 * deleted lines are re-inserted after the new line they follow. Lines outside the hunks are shared.
 */
function reconstructOld(newLines: string[], diff: FileDiff, trailingNewline: boolean): string {
  const drop = new Set<number>();
  const insertAfter = new Map<number, string[]>();
  for (const hunk of diff.hunks) {
    let lastNew = newStart(hunk.header) - 1;
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newNo !== null) {
        drop.add(line.newNo);
        lastNew = line.newNo;
      } else if (line.kind === "context" && line.newNo !== null) {
        lastNew = line.newNo;
      } else if (line.kind === "del") {
        const key = Math.max(0, lastNew);
        let bucket = insertAfter.get(key);
        if (!bucket) insertAfter.set(key, (bucket = []));
        bucket.push(line.text);
      }
    }
  }
  const out: string[] = [];
  const before = insertAfter.get(0);
  if (before) out.push(...before);
  for (let i = 0; i < newLines.length; i++) {
    const no = i + 1;
    if (!drop.has(no)) out.push(newLines[i]);
    const after = insertAfter.get(no);
    if (after) out.push(...after);
  }
  return out.length === 0 ? "" : out.join("\n") + (trailingNewline ? "\n" : "");
}
