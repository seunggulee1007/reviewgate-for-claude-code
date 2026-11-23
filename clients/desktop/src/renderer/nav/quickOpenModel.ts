/**
 * §65.8 on Windows — the pure glue of the three quick-open palettes: Go to File (Ctrl+P, `list_files {filesOnly}`),
 * Symbols in This File (Ctrl+F12, `document_symbols`, filtered here) and Symbols in Project (Ctrl+Alt+Shift+N,
 * `workspace_symbols`): a `path:line` query split, the matched letters to make bold, the file's symbols filtered and
 * ranked the engine's way (exact > prefix > camel humps > substring > subsequence), and the index's line.
 */
import type { DocumentSymbol, FileItem, NavIndexState } from "@reviewgate/engine";
import { splitPath } from "./navModel";

export type PaletteMode = "files" | "fileSymbols" | "projectSymbols";

/** What the box sends and shows per keystroke (ms; the newest reply wins). */
export const PALETTE_DEBOUNCE_MS: Record<PaletteMode, number> = { files: 50, fileSymbols: 0, projectSymbols: 80 };

/** `CartService.java:42` → the path part to search and the line to open at (a `:` with no number is dropped). */
export function parseFileQuery(raw: string): { query: string; line?: number } {
  const q = raw.trim();
  const m = /^(.*?):(\d*)$/.exec(q);
  if (!m) return { query: q };
  const line = Number(m[2]);
  return Number.isInteger(line) && line > 0 ? { query: m[1]!.trim(), line } : { query: m[1]!.trim() };
}

/** Text in runs, the matched ones bold. */
export type BoldPart = { text: string; bold: boolean };

export function boldParts(text: string, marks: readonly number[]): BoldPart[] {
  if (marks.length === 0) return [{ text, bold: false }];
  const on = new Set(marks);
  const parts: BoldPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const bold = on.has(i);
    const last = parts[parts.length - 1];
    if (last && last.bold === bold) last.text += text[i];
    else parts.push({ text: text[i]!, bold });
  }
  return parts;
}

const isUpper = (c: string | undefined) => c !== undefined && c >= "A" && c <= "Z";
const isAlnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);

/** Where the words of a name start: its first letter, a capital after a lower-case letter or digit, a letter after `_` / `-` / `.` / `$`. */
export function wordStarts(name: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (!isAlnum(c)) continue;
    const p = name[i - 1];
    if (i === 0 || !isAlnum(p) || (isUpper(c) && !isUpper(p)) || (isUpper(c) && isUpper(p) && name[i + 1] !== undefined && /[a-z]/.test(name[i + 1]!))) out.push(i);
  }
  return out;
}

/**
 * Camel humps (§65.3): the query split before each capital and at `_`; each part starts at a word of the name, in order
 * (words may be skipped), its other letters in order within that word. `UsrSvc` → `UserService`, `uS` → `userService`,
 * `NPE` → `NullPointerException`. The matched offsets, or null.
 */
export function camelHumps(name: string, query: string): number[] | null {
  const humps = query.split(/(?=[A-Z])|_/).filter((p) => p.length > 0);
  if (humps.length < 2) return null;
  const starts = wordStarts(name);
  const ends = starts.map((s, i) => starts[i + 1] ?? name.length);
  const marks: number[] = [];
  let w = 0;
  for (const part of humps) {
    let placed = false;
    for (; w < starts.length; w++) {
      const s = starts[w]!;
      if (name[s]!.toLowerCase() !== part[0]!.toLowerCase()) continue;
      const got = [s];
      let at = s + 1;
      for (const ch of part.slice(1)) {
        while (at < ends[w]! && name[at]!.toLowerCase() !== ch.toLowerCase()) at++;
        if (at >= ends[w]!) break;
        got.push(at++);
      }
      if (got.length !== part.length) continue;
      marks.push(...got);
      w++;
      placed = true;
      break;
    }
    if (!placed) return null;
  }
  return marks;
}

/** The query's letters in order anywhere in `text` (case-insensitive), word starts first; null when they are not all there. */
export function subsequenceMarks(text: string, query: string): number[] | null {
  if (!query) return [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const marks: number[] = [];
  let at = 0;
  for (const ch of q) {
    const i = lower.indexOf(ch, at);
    if (i < 0) return null;
    marks.push(i);
    at = i + 1;
  }
  return marks;
}

export type Scored = { score: number; marks: number[] };

/** The engine's matching, client-side (§65.3): exact (1000) > prefix (800 / 760 ignoring case) > humps (600) > substring (450 / 400) > subsequence (200). */
export function matchName(name: string, query: string): Scored | null {
  if (!query) return { score: 0, marks: [] };
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
  if (name === query) return { score: 1000, marks: range(0, name.length) };
  const extra = Math.min(80, name.length - query.length);
  if (name.startsWith(query)) return { score: 800 - extra, marks: range(0, query.length) };
  const lname = name.toLowerCase();
  const lq = query.toLowerCase();
  if (lname === lq) return { score: 780, marks: range(0, name.length) };
  if (lname.startsWith(lq)) return { score: 760 - extra, marks: range(0, query.length) };
  const humps = query.length > 1 ? camelHumps(name, query) : null;
  if (humps) return { score: 600 - extra, marks: humps };
  const sub = lname.indexOf(lq);
  if (sub >= 0) return { score: (wordStarts(name).includes(sub) ? 450 : 400) - extra, marks: range(sub, query.length) };
  if (query.length === 1) return null;
  const seq = subsequenceMarks(name, query);
  return seq ? { score: 200 - extra, marks: seq } : null;
}

export type SymbolRow = DocumentSymbol & { marks: number[] };

/** The file's symbols for the query: all in file order when empty, else the matching ones best first (ties: file order). */
export function filterDocumentSymbols(symbols: readonly DocumentSymbol[], query: string): SymbolRow[] {
  const q = query.trim();
  if (!q) return symbols.map((s) => ({ ...s, marks: [] }));
  const hits: { row: SymbolRow; score: number; order: number }[] = [];
  symbols.forEach((s, order) => {
    const m = matchName(s.name, q);
    if (m) hits.push({ row: { ...s, marks: m.marks }, score: m.score, order });
  });
  return hits.sort((a, b) => b.score - a.score || a.order - b.order).map((h) => h.row);
}

export type FileRow = { path: string; name: string; folder: string; marks: number[]; changed: boolean };

/** `list_files` items as rows: directories dropped (an older engine ignores `filesOnly`), the basename's matched letters. */
export function fileRows(items: readonly FileItem[], query: string): FileRow[] {
  return items
    .filter((i) => i.kind === "file")
    .map((i) => {
      const { name, folder } = splitPath(i.path);
      const stem = query.includes("/") ? query.slice(query.lastIndexOf("/") + 1) : query;
      const marks = camelHumps(name.replace(/\.[^.]+$/, ""), stem.replace(/\.[^.]+$/, "")) ?? subsequenceMarks(name, stem) ?? [];
      return { path: i.path, name, folder, marks, changed: i.changed === true };
    });
}

/** The line under the field while the project's index builds or failed (null when ready / idle). */
export function indexLine(index: NavIndexState | undefined, t: (k: string, ...a: (string | number)[]) => string): { text: string; failed: boolean } | null {
  if (!index) return null;
  if (index.status === "building") return { text: index.filesTotal ? t("Indexing… {0} / {1} files", index.files, index.filesTotal) : t("Indexing…"), failed: false };
  if (index.status === "failed") return { text: index.error ? t("The symbol index could not be built: {0}", index.error) : t("The symbol index could not be built"), failed: true };
  return null;
}
