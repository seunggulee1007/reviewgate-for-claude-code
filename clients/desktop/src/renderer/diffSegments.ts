/**
 * MARK: wave2 desktop-diff — docs/PROTOCOL.md §34.7 in-line changes. A paired add / del line carries `segments`: the
 * changed parts of its `text` as `[start, end)` UTF-16 ranges (JS string indices). The line renderer splits the text into
 * unchanged / changed parts with them. Lenient: whatever the wire carries (unsorted, overlapping, out of range, junk) is
 * cleaned up, and no range ever splits a surrogate pair. No segments → the whole line is one unchanged part (the line's
 * own add / del colour already says it changed).
 */

export type TextPart = { text: string; changed: boolean };

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** `segments` as sorted, merged, in-range `[start, end)` pairs on code point boundaries; [] when there is nothing usable. */
export function validSegments(text: string, segments: unknown): [number, number][] {
  if (!Array.isArray(segments) || segments.length === 0 || text.length === 0) return [];
  const len = text.length;
  const ranges: [number, number][] = [];
  for (const s of segments) {
    if (!Array.isArray(s) || s.length !== 2) continue;
    const [ra, rb] = s as unknown[];
    if (typeof ra !== "number" || typeof rb !== "number" || !Number.isInteger(ra) || !Number.isInteger(rb)) continue;
    let a = Math.max(0, ra);
    let b = Math.min(len, rb);
    // A boundary inside a surrogate pair moves outward: the start to the pair's start, the end to the pair's end.
    if (a > 0 && a < len && isLow(text.charCodeAt(a)) && isHigh(text.charCodeAt(a - 1))) a -= 1;
    if (b > 0 && b < len && isLow(text.charCodeAt(b)) && isHigh(text.charCodeAt(b - 1))) b += 1;
    if (a < b) ranges.push([a, b]);
  }
  ranges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** `text` cut at its segments, in order; the parts always join back to `text`. */
export function segmentParts(text: string, segments: unknown): TextPart[] {
  const ranges = validSegments(text, segments);
  if (ranges.length === 0) return [{ text, changed: false }];
  const parts: TextPart[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) parts.push({ text: text.slice(at, a), changed: false });
    parts.push({ text: text.slice(a, b), changed: true });
    at = b;
  }
  if (at < text.length) parts.push({ text: text.slice(at), changed: false });
  return parts;
}
