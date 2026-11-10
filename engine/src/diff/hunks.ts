import type { DiffHunk } from "./parse.js";

/**
 * Hunk-level reject (docs/PROTOCOL.md §17): rebuilds a file from its turn-end content with the
 * selected hunks of the A→B diff reverted to the turn-start content. Works on raw bytes split after
 * every `\n`, so CRLF line endings, a missing final newline and non-UTF-8 bytes survive untouched.
 */

export class HunkMismatchError extends Error {}

/** `@@ -a[,b] +c[,d] @@` → [a, b, c, d] (omitted counts are 1). */
export function hunkRanges(header: string): [number, number, number, number] {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) throw new HunkMismatchError(`unparsable hunk header: ${header}`);
  return [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/** Lines of `buf`, each with its `\n` (the last one may have none). */
export function splitLinesKeepEol(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

function lineText(line: Buffer): string {
  const end = line.length > 0 && line[line.length - 1] === 0x0a ? line.length - 1 : line.length;
  return line.subarray(0, end).toString("utf8");
}

function verify(actual: Buffer[], expected: string[], side: string, header: string): void {
  if (actual.length !== expected.length || actual.some((l, i) => lineText(l) !== expected[i])) {
    throw new HunkMismatchError(`the ${side} side of hunk "${header}" does not match the file content`);
  }
}

/**
 * The content of `newBuf` (turn end) with every hunk in `selected` (hunk ids of `hunks`, the parsed
 * A→B diff) replaced by its old-side lines from `oldBuf` (turn start). Each hunk's old / new side
 * is checked against the actual bytes first: a diff that does not describe these two contents throws
 * `HunkMismatchError` instead of producing a wrong file.
 */
export function revertHunks(oldBuf: Buffer, newBuf: Buffer, hunks: DiffHunk[], selected: ReadonlySet<number>): Buffer {
  const a = splitLinesKeepEol(oldBuf);
  const b = splitLinesKeepEol(newBuf);
  const out: Buffer[] = [];
  let cursor = 0;
  for (const h of hunks) {
    const [oldStart, oldCount, newStart, newCount] = hunkRanges(h.header);
    // A zero count names the line BEFORE the (empty) range: its 0-based index is the start itself.
    const ai = oldCount === 0 ? oldStart : oldStart - 1;
    const bi = newCount === 0 ? newStart : newStart - 1;
    const oldSide = a.slice(ai, ai + oldCount);
    const newSide = b.slice(bi, bi + newCount);
    verify(oldSide, h.lines.filter((l) => l.kind === "context" || l.kind === "del").map((l) => l.text), "old", h.header);
    verify(newSide, h.lines.filter((l) => l.kind === "context" || l.kind === "add").map((l) => l.text), "new", h.header);
    if (bi < cursor || ai + oldCount > a.length || bi + newCount > b.length) throw new HunkMismatchError(`hunk "${h.header}" is out of range`);
    out.push(...b.slice(cursor, bi));
    out.push(...(selected.has(h.id) ? oldSide : newSide));
    cursor = bi + newCount;
  }
  out.push(...b.slice(cursor));
  return Buffer.concat(out);
}
