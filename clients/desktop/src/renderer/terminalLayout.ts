/**
 * §57.5 / §57.10 (plan §4.3): a terminal chat's layout — pure, ported from the Mac's `PaneSplit` (Core ComposerLayout.swift).
 *
 * The terminal takes the window and the review panel (the diff pane) opens on its left, next to the file list, while
 * there is something to review. The terminal never goes below 80 columns: where 80 columns and the panel's floor fit
 * side by side the panel is a pane beside it (the divider moves between the two, the terminal's share remembered); in a
 * narrower area the panel is a drawer over the terminal's left side — 45 % of the area, at least the floor, a strip of
 * the terminal left visible — and the terminal keeps its whole width (no resize, no reflow of the TUI) while the drawer
 * opens and closes.
 */

/** The TUI's floor. */
export const TERMINAL_COLUMNS = 80;
/** The review panel's floor: the diff header's controls still show Accept. */
export const REVIEW_FLOOR = 360;
/** The pane divider's own width (5 px with −2 px margins). */
export const DIVIDER_WIDTH = 1;
/** The terminal's share of the side-by-side split until the user moves the divider (`ui.terminalReviewSplit`). */
export const DEFAULT_TERMINAL_SHARE = 0.55;
/** What a terminal needs beside its columns: xterm's scrollbar and the host's padding (4 px each side). */
export const TERMINAL_CHROME = 14 + 8;
/** The drawer's share of the area, and the strip of terminal it always leaves. */
export const DRAWER_SHARE = 0.45;
export const DRAWER_TERMINAL_STRIP = 120;

export type TerminalReviewLayout = "side" | "drawer";

/** The terminal's width for `columns` columns of `cellWidth` px (the font's "W" advance) and its chrome. */
export function terminalMinWidth(cellWidth: number, columns = TERMINAL_COLUMNS, chrome = TERMINAL_CHROME): number {
  return Math.ceil(cellWidth * columns + chrome);
}

/** Side by side when the terminal keeps 80 columns beside the panel's floor (and the divider), else a drawer. */
export function terminalReviewLayout(total: number, minTerminal: number, reviewFloor = REVIEW_FLOOR, divider = DIVIDER_WIDTH): TerminalReviewLayout {
  return total >= minTerminal + reviewFloor + divider ? "side" : "drawer";
}

/** Side by side: the terminal's width for the `want` the divider asks — at least `minTerminal`, at most what leaves the floor. */
export function terminalWidth(want: number, total: number, minTerminal: number, reviewFloor = REVIEW_FLOOR): number {
  const low = Math.min(minTerminal, Math.max(total, 0));
  const high = Math.max(low, total - reviewFloor);
  return Math.min(Math.max(want, low), high);
}

/** Side by side: the review panel's width for the `want` the divider asks — what the terminal leaves of `total`. */
export function reviewPanelWidth(want: number, total: number, minTerminal: number, reviewFloor = REVIEW_FLOOR): number {
  return total - terminalWidth(total - want, total, minTerminal, reviewFloor);
}

/** Side by side: the review panel's width for the terminal's remembered `share` (0…1; anything else: the default). */
export function reviewWidthForShare(share: number | undefined, total: number, minTerminal: number, reviewFloor = REVIEW_FLOOR): number {
  const s = share !== undefined && Number.isFinite(share) && share > 0 && share < 1 ? share : DEFAULT_TERMINAL_SHARE;
  return Math.round(reviewPanelWidth(total * (1 - s), total, minTerminal, reviewFloor));
}

/** The terminal's share once the divider left the review panel `reviewWidth` px wide (kept within 0.05…0.95). */
export function terminalShareOf(reviewWidth: number, total: number): number {
  if (total <= 0) return DEFAULT_TERMINAL_SHARE;
  const share = 1 - reviewWidth / total;
  return Math.round(Math.min(0.95, Math.max(0.05, share)) * 1000) / 1000;
}

/** The drawer's width: 45 % of the area, at least the floor, never so wide that less than 120 px of terminal shows (in a tiny area: what is there). */
export function reviewDrawerWidth(total: number, reviewFloor = REVIEW_FLOOR, share = DRAWER_SHARE, terminalStrip = DRAWER_TERMINAL_STRIP): number {
  const want = Math.max(reviewFloor, Math.round(total * share));
  return Math.max(Math.min(want, total - terminalStrip), Math.min(reviewFloor, Math.max(total, 0)));
}

/** The width of "W" in the terminal's font — canvas `measureText`, as xterm measures its cells. `fallback` without a canvas. */
export function measureCellWidth(font: string, fallback = 7.8): number {
  if (typeof document === "undefined") return fallback;
  const ctx = document.createElement("canvas").getContext?.("2d");
  if (!ctx) return fallback;
  ctx.font = font;
  const w = ctx.measureText("W").width;
  return Number.isFinite(w) && w > 0 ? w : fallback;
}
