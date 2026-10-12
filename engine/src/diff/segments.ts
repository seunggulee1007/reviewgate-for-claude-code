/**
 * §34.7 line detail: in-line change segments and whitespace-only pairs of a parsed diff (docs/PROTOCOL.md §34.7).
 *
 * Pairs: in a hunk, a run of `del` lines directly followed by a run of `add` lines is a block; its i-th del pairs with its
 * i-th add. Each pair is diffed over tokens (`[\p{L}\p{N}_]+` words, whitespace runs, any other single code point) with
 * the `diff` package's Myers (`diffArrays`, bounded by `maxEditLength`); both lines get the changed tokens as `[start,
 * end)` UTF-16 ranges. Limits keep a huge or rewritten file cheap: lines over 2 000 units / a rewrite (> 60 % of the
 * longer line changed) get none, a block over 200 lines on either side is not paired, and at most 4 000 lines of a file
 * (2 000 pairs) — or a token-diff work budget — get segments (`segmentsLimited` on the rest).
 */
import { diffArrays } from "diff";
import type { DiffLine, FileDiff } from "./parse.js";

/** A block with more lines than this on either side is not paired. */
export const SEGMENT_BLOCK_MAX_LINES = 200;
/** Either line longer than this (UTF-16 units): no segments for the pair. */
export const SEGMENT_LINE_MAX_UNITS = 2000;
/** More than this share of the longer line changed: a rewrite, no segments. */
export const SEGMENT_MAX_CHANGED_RATIO = 0.6;
/** Lines of one file that get segments (both lines of a pair count); the rest none + `segmentsLimited`. */
export const SEGMENT_MAX_PAIRED_LINES = 4000;
/**
 * Token-diff work of one file, as (tokens of both middles) × (the edit length allowed): the pessimistic Myers cost
 * (~50–80 ns a unit in `diffArrays`, so ≤ ~0.3 s a file). Ordinary code edits stay far below it (2 000 paired Java
 * lines: < 1 %); long lines that share most of their tokens in another order exhaust it.
 */
export const SEGMENT_WORK_BUDGET = 4_000_000;

export type Token = { text: string; start: number };
export type SegmentRanges = [number, number][];

const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^]/gu;

/** The §34.7 tokens of `text` with their UTF-16 start offsets (a code point is never split). */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ text: m[0], start: m.index });
  return out;
}

/** The work `segmentPair` may still spend (see `SEGMENT_WORK_BUDGET`); `Infinity` = unbounded. */
export type SegmentBudget = { left: number; exceeded: boolean };

/**
 * The changed parts of a paired del (`a`) / add (`b`) line: `{a, b}` ranges (ascending, adjacent merged; `[]` = nothing
 * of that line changed), or null when the pair gets none — a line over the length limit, a rewrite, or a token diff the
 * remaining `budget` cannot pay for (`budget.exceeded` is then set; cheaper pairs after it still get theirs).
 */
export function segmentPair(a: string, b: string, budget: SegmentBudget = { left: Infinity, exceeded: false }): { a: SegmentRanges; b: SegmentRanges } | null {
  if (a.length > SEGMENT_LINE_MAX_UNITS || b.length > SEGMENT_LINE_MAX_UNITS) return null;
  if (a === b) return { a: [], b: [] };
  const ta = tokenize(a);
  const tb = tokenize(b);
  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre]!.text === tb[pre]!.text) pre++;
  let suf = 0;
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf]!.text === tb[tb.length - 1 - suf]!.text) suf++;
  const ma = ta.slice(pre, ta.length - suf);
  const mb = tb.slice(pre, tb.length - suf);
  const maxLen = Math.max(a.length, b.length);
  const limit = Math.floor(SEGMENT_MAX_CHANGED_RATIO * maxLen);
  const units = (ts: Token[]) => ts.reduce((n, t) => n + t.text.length, 0);
  const ua = units(ma);
  const ub = units(mb);
  // What changes at least: the longer middle minus everything the shorter one could share with it.
  if (ua - ub > limit || ub - ua > limit) return null;
  // Tighter, still O(n): a common subsequence never shares more than the two middles' token multisets have in common.
  if (ma.length > 0 && mb.length > 0) {
    const shared = sharedUnits(ma, mb);
    if (ua - shared > limit || ub - shared > limit) return null;
  }
  let ra: SegmentRanges;
  let rb: SegmentRanges;
  if (ma.length === 0 || mb.length === 0) {
    ra = ma.length === 0 ? [] : [[ma[0]!.start, ma[0]!.start + ua]];
    rb = mb.length === 0 ? [] : [[mb[0]!.start, mb[0]!.start + ub]];
  } else {
    // Tokens are ≥ 1 unit: an edit script longer than both sides' limits together always fails the ratio below.
    const maxEditLength = Math.min(ma.length + mb.length, 2 * limit);
    const work = (ma.length + mb.length) * maxEditLength;
    if (work > budget.left) {
      budget.exceeded = true;
      return null;
    }
    budget.left -= work;
    const parts = diffArrays(
      ma.map((t) => t.text),
      mb.map((t) => t.text),
      { maxEditLength },
    );
    if (!parts) return null;
    ra = [];
    rb = [];
    let ia = 0;
    let ib = 0;
    for (const p of parts) {
      if (p.removed) {
        pushRange(ra, ma[ia]!.start, ma[ia + p.count - 1]!.start + ma[ia + p.count - 1]!.text.length);
        ia += p.count;
      } else if (p.added) {
        pushRange(rb, mb[ib]!.start, mb[ib + p.count - 1]!.start + mb[ib + p.count - 1]!.text.length);
        ib += p.count;
      } else {
        ia += p.count;
        ib += p.count;
      }
    }
  }
  const covered = (r: SegmentRanges) => r.reduce((n, [s, e]) => n + (e - s), 0);
  if (Math.max(covered(ra), covered(rb)) > limit) return null;
  return { a: ra, b: rb };
}

/** Units of the multiset intersection of two token lists (an upper bound of any common subsequence's units). */
function sharedUnits(a: Token[], b: Token[]): number {
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t.text, (counts.get(t.text) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const n = counts.get(t.text);
    if (!n) continue;
    counts.set(t.text, n - 1);
    shared += t.text.length;
  }
  return shared;
}

function pushRange(ranges: SegmentRanges, start: number, end: number): void {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === start) last[1] = end;
  else ranges.push([start, end]);
}

const noWhitespace = (s: string) => s.replace(/\s+/gu, "");

/**
 * Adds `segments` / `wsOnly` to the paired lines of `diff` (in place) and `segmentsLimited` when a per-file limit cut
 * the pass short; returns `diff`. Context, hunk header and unpaired lines are never touched.
 */
export function addSegments(diff: FileDiff): FileDiff {
  if (diff.isBinary) return diff;
  let pairedLines = 0;
  let limited = false;
  const budget: SegmentBudget = { left: SEGMENT_WORK_BUDGET, exceeded: false };
  for (const hunk of diff.hunks) {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i]!.kind !== "del") {
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && lines[j]!.kind === "del") j++;
      let k = j;
      while (k < lines.length && lines[k]!.kind === "add") k++;
      const dels = lines.slice(i, j);
      const adds = lines.slice(j, k);
      i = k;
      if (adds.length === 0 || dels.length > SEGMENT_BLOCK_MAX_LINES || adds.length > SEGMENT_BLOCK_MAX_LINES) continue;
      for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
        const del = dels[p]!;
        const add = adds[p]!;
        if (noWhitespace(del.text) === noWhitespace(add.text)) {
          del.wsOnly = true;
          add.wsOnly = true;
        }
        if (pairedLines + 2 > SEGMENT_MAX_PAIRED_LINES) {
          limited = true;
          continue;
        }
        pairedLines += 2;
        const r = segmentPair(del.text, add.text, budget);
        if (r) setSegments(del, r.a, add, r.b);
      }
    }
  }
  if (limited || budget.exceeded) diff.segmentsLimited = true;
  return diff;
}

function setSegments(del: DiffLine, a: SegmentRanges, add: DiffLine, b: SegmentRanges): void {
  del.segments = a;
  add.segments = b;
}
