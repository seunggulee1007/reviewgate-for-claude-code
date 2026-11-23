/**
 * §62 — the pure parts of code navigation on Windows: where the user was (Back / Forward, client-side), the peek list's rows
 * and keys, the references grouped by file, and the symbol marked in a preview line.
 */
import type { DefinitionCandidate, DefinitionKind, ReferenceHit } from "@reviewgate/engine";

// ---- history

/** Where the user was: the review's diff of a changed file, a project file (read-only), or another pane (History / PRs). */
export type NavLocation =
  | { kind: "review"; path: string; line: number }
  | { kind: "file"; path: string; line: number; column: number }
  | { kind: "pane"; pane: "history" | "prs" };

export type NavHistory = { back: NavLocation[]; forward: NavLocation[] };

export const EMPTY_HISTORY: NavHistory = { back: [], forward: [] };
/** How many steps back are kept. */
export const HISTORY_LIMIT = 50;

/** A jump from `from`: it goes on the back stack (the same place twice in a row once), the forward stack empties. */
export function pushHistory(h: NavHistory, from: NavLocation): NavHistory {
  const last = h.back[h.back.length - 1];
  const back = last && sameLocation(last, from) ? h.back : [...h.back, from].slice(-HISTORY_LIMIT);
  return { back, forward: [] };
}

/** Back from `current`: the place to show and the history after it (null when there is nothing to go back to). */
export function goBack(h: NavHistory, current: NavLocation): { to: NavLocation; history: NavHistory } | null {
  const to = h.back[h.back.length - 1];
  if (!to) return null;
  return { to, history: { back: h.back.slice(0, -1), forward: [current, ...h.forward].slice(0, HISTORY_LIMIT) } };
}

/** Forward from `current` (null when nothing was gone back from). */
export function goForward(h: NavHistory, current: NavLocation): { to: NavLocation; history: NavHistory } | null {
  const to = h.forward[0];
  if (!to) return null;
  return { to, history: { back: [...h.back, current].slice(-HISTORY_LIMIT), forward: h.forward.slice(1) } };
}

export function sameLocation(a: NavLocation, b: NavLocation): boolean {
  if (a.kind === "pane" || b.kind === "pane") return a.kind === b.kind && (a as { pane: string }).pane === (b as { pane: string }).pane;
  return a.kind === b.kind && a.path === b.path && a.line === b.line;
}

// ---- peek list

export type PeekRow = { path: string; name: string; folder: string; line: number; column: number; kind: DefinitionKind; preview: string };

/** One row per candidate, in the engine's order (best first). */
export function peekRows(candidates: readonly DefinitionCandidate[]): PeekRow[] {
  return candidates.map((c) => ({ path: c.path, ...splitPath(c.path), line: c.line, column: c.column, kind: c.kind, preview: c.preview }));
}

export type PeekKeyResult = { kind: "select"; index: number } | { kind: "open"; index: number } | { kind: "close" } | null;

/** ↑ / ↓ move (wrapping), Enter opens the selected row, Esc closes; anything else is not the list's. */
export function peekKey(key: string, selected: number, count: number): PeekKeyResult {
  if (key === "Escape") return { kind: "close" };
  if (count === 0) return null;
  if (key === "ArrowDown") return { kind: "select", index: (selected + 1) % count };
  if (key === "ArrowUp") return { kind: "select", index: (selected - 1 + count) % count };
  if (key === "Home") return { kind: "select", index: 0 };
  if (key === "End") return { kind: "select", index: count - 1 };
  if (key === "Enter") return { kind: "open", index: Math.min(Math.max(selected, 0), count - 1) };
  return null;
}

// ---- references

export type RefRow = { path: string; line: number; column: number; preview: string; kind?: DefinitionKind };
export type RefGroup = { path: string; name: string; folder: string; rows: RefRow[] };

/** The hits by file, files in the order their first hit arrived, lines as received. */
export function groupByFile(hits: readonly RefRow[]): RefGroup[] {
  const groups = new Map<string, RefGroup>();
  for (const h of hits) {
    let g = groups.get(h.path);
    if (!g) {
      g = { path: h.path, ...splitPath(h.path), rows: [] };
      groups.set(h.path, g);
    }
    g.rows.push(h);
  }
  return [...groups.values()];
}

/** §65.8: the rows in the order the References tab shows them (file groups, then lines) — the order F4 / Shift+F4 walk. */
export function referenceOrder(rows: readonly RefRow[]): RefRow[] {
  return groupByFile(rows).flatMap((g) => g.rows);
}

/**
 * F4 (`dir` 1) / Shift+F4 (-1) from `selected` (-1: none yet — F4 starts at the first, Shift+F4 at the last), wrapping;
 * null when there is nothing to step to.
 */
export function stepReference(selected: number, count: number, dir: 1 | -1): number | null {
  if (count === 0) return null;
  if (selected < 0 || selected >= count) return dir === 1 ? 0 : count - 1;
  return (selected + dir + count) % count;
}

/** `project_search` matches as reference rows (Find in Project from the "no definition" notice): the column of the first hit. */
export function searchRows(matches: readonly { path: string; line: number; text: string }[], symbol: string): RefRow[] {
  return matches.map((m) => ({ path: m.path, line: m.line, column: Math.max(1, wholeWordIndex(m.text, symbol) + 1), preview: m.text.trim() }));
}

export function referenceRows(hits: readonly ReferenceHit[]): RefRow[] {
  return hits.map((h) => ({ path: h.path, line: h.line, column: h.column, preview: h.preview, ...(h.kind ? { kind: h.kind } : {}) }));
}

// ---- preview text

export type PreviewPart = { text: string; mark: boolean };

/** `preview` with every whole-word occurrence of the symbol's searched name marked (`a.b.C` → `C`, a path → its file name). */
export function markSymbol(preview: string, symbol: string): PreviewPart[] {
  const word = searchedWord(symbol);
  if (!word) return [{ text: preview, mark: false }];
  const parts: PreviewPart[] = [];
  let from = 0;
  for (;;) {
    const i = wholeWordIndex(preview, word, from);
    if (i < 0) break;
    if (i > from) parts.push({ text: preview.slice(from, i), mark: false });
    parts.push({ text: preview.slice(i, i + word.length), mark: true });
    from = i + word.length;
  }
  if (from < preview.length || parts.length === 0) parts.push({ text: preview.slice(from), mark: false });
  return parts;
}

/** The word the engine searches for a symbol: the last part of `a.b.C`, a path's file name, the tag of `prefix:tag`. */
export function searchedWord(symbol: string): string {
  if (symbol.includes("/") || /\.[a-z]+$/.test(symbol)) return symbol.slice(symbol.lastIndexOf("/") + 1);
  if (symbol.includes(":")) return symbol.slice(symbol.indexOf(":") + 1);
  return symbol.slice(symbol.lastIndexOf(".") + 1);
}

function wholeWordIndex(text: string, word: string, from = 0): number {
  if (!word) return -1;
  const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$-]/.test(c);
  for (let i = text.indexOf(word, from); i >= 0; i = text.indexOf(word, i + 1)) {
    if (!isWord(text[i - 1]) && !isWord(text[i + word.length])) return i;
  }
  return -1;
}

export function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}
