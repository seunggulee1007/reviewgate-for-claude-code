/**
 * MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the status line's text as a terminal draws it — SGR styles
 * (bold, dim, italic, underline, strike, inverse, hidden; 16 / bright / 256 / truecolor) and OSC 8 links as runs;
 * every other escape and control dropped; styles carried from line to line (the CLI prefixes every line with the
 * escapes above it); display columns per grapheme; Ink's truncation ("…"). The Mac's Core `AnsiText` follows the same
 * rules — engine/test/fixtures/ansiVectors.json holds both to them.
 */

/** A palette index 0–255 or "#rrggbb". */
export type AnsiColor = number | string;

export type AnsiStyle = {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  inverse?: true;
  hidden?: true;
  /** The OSC 8 URI the text links to. */
  link?: string;
};

export type AnsiRun = AnsiStyle & { text: string };

const STYLE_KEYS = ["fg", "bg", "bold", "dim", "italic", "underline", "strike", "inverse", "hidden", "link"] as const;

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return STYLE_KEYS.every((k) => a[k] === b[k]);
}

function styleOf(r: AnsiStyle): AnsiStyle {
  const s: AnsiStyle = {};
  for (const k of STYLE_KEYS) if (r[k] !== undefined) (s as Record<string, unknown>)[k] = r[k];
  return s;
}

/** Appends `run`, joining it to the last one when they look the same. */
function push(runs: AnsiRun[], run: AnsiRun): void {
  if (!run.text) return;
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, run)) last.text += run.text;
  else runs.push({ ...styleOf(run), text: run.text });
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const byte = (v: string | undefined): number | null => {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n <= 255 ? n : null;
};

/** `5;n` / `2;r;g;b` after a 38 / 48 (semicolon form): the color and how many parameters it took (null color: ignored). */
function extended(list: readonly string[], at: number): { color: AnsiColor | null; used: number } {
  const mode = list[at];
  if (mode === "5") {
    const n = byte(list[at + 1]);
    return { color: n, used: 2 };
  }
  if (mode === "2") {
    const [r, g, b] = [byte(list[at + 1]), byte(list[at + 2]), byte(list[at + 3])];
    return { color: r !== null && g !== null && b !== null ? rgbHex(r, g, b) : null, used: 4 };
  }
  return { color: null, used: list.length };
}

/** The colon form (`38:5:n`, `38:2::r:g:b`, `38:2:r:g:b`). */
function extendedColon(sub: readonly string[]): AnsiColor | null {
  if (sub[1] === "5") return byte(sub[2]);
  if (sub[1] === "2") {
    const rest = sub.slice(2);
    const rgb = rest.length >= 4 ? rest.slice(rest.length - 3) : rest;
    const [r, g, b] = [byte(rgb[0]), byte(rgb[1]), byte(rgb[2])];
    return r !== null && g !== null && b !== null && rgb.length === 3 ? rgbHex(r, g, b) : null;
  }
  return null;
}

function setFlag(s: AnsiStyle, key: "bold" | "dim" | "italic" | "underline" | "strike" | "inverse" | "hidden", on: boolean): void {
  if (on) s[key] = true;
  else delete s[key];
}

function setColor(s: AnsiStyle, key: "fg" | "bg", c: AnsiColor | null | undefined): void {
  if (c === undefined) delete s[key];
  else if (c !== null) s[key] = c;
}

/** One SGR's parameters applied to `from` (the link is not SGR's: it stays). */
export function applySgr(from: AnsiStyle, params: string): AnsiStyle {
  const s: AnsiStyle = { ...from };
  const list = params === "" ? ["0"] : params.split(";");
  for (let k = 0; k < list.length; k++) {
    const p = list[k]!;
    if (p.includes(":")) {
      const sub = p.split(":");
      if (sub[0] === "38") setColor(s, "fg", extendedColon(sub));
      else if (sub[0] === "48") setColor(s, "bg", extendedColon(sub));
      else if (sub[0] === "4") setFlag(s, "underline", sub[1] !== "0");
      continue;
    }
    const code = p === "" ? 0 : /^\d+$/.test(p) ? Number(p) : -1;
    if (code === 0) {
      const link = s.link;
      for (const key of STYLE_KEYS) delete s[key];
      if (link !== undefined) s.link = link;
    } else if (code === 1) setFlag(s, "bold", true);
    else if (code === 2) setFlag(s, "dim", true);
    else if (code === 3) setFlag(s, "italic", true);
    else if (code === 4 || code === 21) setFlag(s, "underline", true);
    else if (code === 7) setFlag(s, "inverse", true);
    else if (code === 8) setFlag(s, "hidden", true);
    else if (code === 9) setFlag(s, "strike", true);
    else if (code === 22) {
      setFlag(s, "bold", false);
      setFlag(s, "dim", false);
    } else if (code === 23) setFlag(s, "italic", false);
    else if (code === 24) setFlag(s, "underline", false);
    else if (code === 27) setFlag(s, "inverse", false);
    else if (code === 28) setFlag(s, "hidden", false);
    else if (code === 29) setFlag(s, "strike", false);
    else if (code >= 30 && code <= 37) s.fg = code - 30;
    else if (code === 39) delete s.fg;
    else if (code >= 40 && code <= 47) s.bg = code - 40;
    else if (code === 49) delete s.bg;
    else if (code >= 90 && code <= 97) s.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) s.bg = code - 100 + 8;
    else if (code === 38 || code === 48 || code === 58) {
      const { color, used } = extended(list, k + 1);
      if (code !== 58) setColor(s, code === 38 ? "fg" : "bg", color);
      k += used;
    }
  }
  return s;
}

const isParam = (c: number) => c >= 0x30 && c <= 0x3f;
const isInter = (c: number) => c >= 0x20 && c <= 0x2f;
const isFinal = (c: number) => c >= 0x40 && c <= 0x7e;

/** One line's runs, starting in `start` (the style the line above ended in); `end` is the style it ends in. */
export function parseAnsiLine(line: string, start: AnsiStyle = {}): { runs: AnsiRun[]; end: AnsiStyle } {
  const runs: AnsiRun[] = [];
  const cps = Array.from(line);
  const code = (i: number) => (i < cps.length ? cps[i]!.codePointAt(0)! : -1);
  let style: AnsiStyle = styleOf(start);
  let text = "";
  let plain = ""; // the line's text so far (tab stops)
  const flush = () => {
    push(runs, { ...style, text });
    text = "";
  };
  const restyle = (next: AnsiStyle) => {
    if (sameStyle(next, style)) return;
    flush();
    style = next;
  };
  let i = 0;
  while (i < cps.length) {
    const c = code(i);
    if (c === 0x1b) {
      const n = code(i + 1);
      if (n === -1) break;
      if (n === 0x5b /* [ */) {
        let j = i + 2;
        let params = "";
        while (isParam(code(j))) params += cps[j++];
        let inter = "";
        while (isInter(code(j))) inter += cps[j++];
        if (j >= cps.length) break; // unterminated: the rest goes
        if (!isFinal(code(j))) {
          i = j;
          continue;
        }
        if (cps[j] === "m" && inter === "" && !/^[<=>?]/.test(params)) restyle(applySgr(style, params));
        i = j + 1;
        continue;
      }
      if (n === 0x5d /* ] */) {
        let j = i + 2;
        let body = "";
        let ended = false;
        while (j < cps.length) {
          if (code(j) === 0x07) {
            ended = true;
            j += 1;
            break;
          }
          if (code(j) === 0x1b && code(j + 1) === 0x5c) {
            ended = true;
            j += 2;
            break;
          }
          body += cps[j++];
        }
        if (!ended) break;
        const m = /^8;[^;]*;([\s\S]*)$/.exec(body);
        if (m) {
          const next = { ...style };
          if (m[1]) next.link = m[1];
          else delete next.link;
          restyle(next);
        }
        i = j;
        continue;
      }
      if (n === 0x50 || n === 0x58 || n === 0x5e || n === 0x5f /* P X ^ _ */) {
        let j = i + 2;
        let ended = false;
        while (j < cps.length) {
          if (code(j) === 0x1b && code(j + 1) === 0x5c) {
            ended = true;
            j += 2;
            break;
          }
          j++;
        }
        if (!ended) break;
        i = j;
        continue;
      }
      let j = i + 1;
      while (isInter(code(j))) j++;
      if (j >= cps.length) break;
      i = j + 1;
      continue;
    }
    if (c === 0x09) {
      const pad = 8 - (textWidth(plain) % 8);
      text += " ".repeat(pad);
      plain += " ".repeat(pad);
      i++;
      continue;
    }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
      i++;
      continue;
    }
    text += cps[i];
    plain += cps[i];
    i++;
  }
  flush();
  return { runs, end: style };
}

/** Every line's runs; a style (or link) still open at a line's end goes on into the next. */
export function parseAnsiLines(lines: readonly string[]): AnsiRun[][] {
  let state: AnsiStyle = {};
  return lines.map((line) => {
    const r = parseAnsiLine(line, state);
    state = r.end;
    return r.runs;
  });
}

// ---------------------------------------------------------------- columns

/** East Asian wide / fullwidth and emoji-presentation code points (two columns). */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/** Joiners, variation selectors, tags and marks that never start a cluster's width of their own. */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x1160, 0x11ff], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2060, 0x2064], [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]) => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
};

let segmenter: Intl.Segmenter | null | undefined;

/** The text's grapheme clusters (code points where the runtime has no `Intl.Segmenter`). */
export function graphemes(text: string): string[] {
  if (segmenter === undefined) segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

/** One cluster's columns: 2 for an emoji presentation (VS16, a flag) or a wide base, 0 for marks alone, else 1. */
export function graphemeWidth(g: string): number {
  const cps = Array.from(g, (c) => c.codePointAt(0)!);
  if (cps.includes(0xfe0f) || cps.some((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff)) return 2;
  const base = cps.find((cp) => !inRanges(cp, ZERO));
  if (base === undefined) return 0;
  return inRanges(base, WIDE) ? 2 : 1;
}

/** Display columns of `text`. */
export function textWidth(text: string): number {
  let n = 0;
  for (const g of graphemes(text)) n += graphemeWidth(g);
  return n;
}

export function runsWidth(runs: readonly AnsiRun[]): number {
  return runs.reduce((n, r) => n + textWidth(r.text), 0);
}

/** Ink's `wrap="truncate"`: a line wider than `columns` keeps what fits in columns − 1 and ends with an unstyled "…". */
export function truncateRuns(runs: readonly AnsiRun[], columns: number): AnsiRun[] {
  if (columns <= 0) return [];
  if (runsWidth(runs) <= columns) return runs.map((r) => ({ ...r }));
  const budget = columns - 1;
  const out: AnsiRun[] = [];
  let used = 0;
  let full = false;
  for (const r of runs) {
    let kept = "";
    for (const g of graphemes(r.text)) {
      const w = graphemeWidth(g);
      if (used + w > budget) {
        full = true;
        break;
      }
      kept += g;
      used += w;
    }
    push(out, { ...r, text: kept });
    if (full) break;
  }
  push(out, { text: "…" });
  return out;
}

// ---------------------------------------------------------------- colors

/** The 16 basic colors per appearance (VS Code's terminal colors; the Mac's Core `AnsiPalette` is the same). */
export const ANSI_PALETTE: { readonly dark: readonly string[]; readonly light: readonly string[] } = {
  dark: ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"],
  light: ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555", "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"],
};

const CUBE = [0, 95, 135, 175, 215, 255];

/** The xterm color of 256-color index 16–255 (the 6×6×6 cube, then 24 grays). */
export function xterm256(index: number): string {
  if (index >= 232) {
    const v = 8 + 10 * (index - 232);
    return rgbHex(v, v, v);
  }
  const i = index - 16;
  return rgbHex(CUBE[Math.floor(i / 36) % 6]!, CUBE[Math.floor(i / 6) % 6]!, CUBE[i % 6]!);
}

/** A color as CSS in this appearance. */
export function ansiColorCss(c: AnsiColor, dark: boolean): string {
  if (typeof c === "string") return c;
  if (c < 16) return (dark ? ANSI_PALETTE.dark : ANSI_PALETTE.light)[c]!;
  return xterm256(c);
}

/** A link the status line may open: http(s) only (a `file://` or custom scheme stays text, as on the Mac). */
export function openableLink(link: string | undefined): string | null {
  return link && /^https?:\/\//i.test(link) ? link : null;
}
