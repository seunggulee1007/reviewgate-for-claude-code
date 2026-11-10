/**
 * MARK: polish p-ui-kit — PX-09: text cut short with an ellipsis reads in full on hover, everywhere, with no change to the
 * component that shows it. One listener for the whole page (installed from main.tsx): when the pointer comes onto text
 * that is cut — a `.truncate`, or anything styled `text-overflow: ellipsis` or clamped to a few lines — that element gets
 * its whole text as its tooltip (`title`); once the text fits again, the tooltip goes. A tooltip a component set stays:
 * on the element itself it is left alone; on a row around it (a file row's path, a menu item's reason), it is kept under
 * the whole text, or left alone when it already holds that text.
 *
 *   installAutoTitle(document);                                  // once, at start (main.tsx)
 *   <span className="truncate" data-no-auto-title>…</span>      // a spot that wants no tooltip
 */

/** A tooltip longer than this is cut (a clamped message of thousands of characters). */
const MAX_TITLE = 1000;
/** How far up from the element under the pointer the cut text may be (an icon or a <b> inside a truncated label). */
const DEPTH = 3;
/** Where a tooltip of ours would be in the way: a field's own text, the code editor, a spot that opts out. */
const SKIP = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor, [data-no-auto-title]';

/** The parts of an element this module reads and writes (an HTMLElement; a plain object in the tests). */
export interface TitleTarget {
  readonly parentElement: TitleTarget | null;
  readonly classList: { contains(name: string): boolean };
  readonly dataset: Record<string, string | undefined>;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly innerText?: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selector: string): unknown;
}

/** How an element is styled to cut its text: on one line (an ellipsis), over a few lines (a line clamp), or not. */
export type CutStyle = "line" | "lines" | null;

/**
 * The tooltip a cut element gets: its whole text — and under it the tooltip of the row around it, unless that already
 * holds the text (a file row whose tooltip is the path). Null: none (no text, or a row that asked for no tooltip: `title=""`).
 */
export function autoTitleFor(text: string, around: string | null): string | null {
  const whole = text.trim();
  if (whole.length === 0 || around === "") return null;
  const clipped = whole.length > MAX_TITLE ? `${whole.slice(0, MAX_TITLE - 1)}…` : whole;
  if (around === null) return clipped;
  return holds(around, whole) ? null : `${clipped}\n${around}`;
}

/** Text as a tooltip compares it: runs of spaces and line breaks as one space. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether a row's tooltip already says the text: the text itself, or each of its words — a file's name and folder shown
 * as "Other.java — src/acme" against a tooltip of the full path. A word is a run with a letter or a digit (not "—").
 */
function holds(around: string, text: string): boolean {
  const all = flat(around);
  if (all.includes(flat(text))) return true;
  const words = flat(text)
    .split(" ")
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length > 0 && words.every((w) => all.includes(w));
}

/** The tooltip a component wrote on this element (not one of ours), or null. A title someone changed after us is theirs. */
function ownTitle(el: TitleTarget): string | null {
  const title = el.getAttribute("title");
  if (title === null) return null;
  if (el.dataset.autoTitle === title) return null;
  delete el.dataset.autoTitle; // a component wrote over ours: it is theirs now
  return title;
}

/** The nearest tooltip a component wrote on a row around the element (one of ours higher up does not count). */
function titleAround(el: TitleTarget): string | null {
  for (let up = el.parentElement; up; up = up.parentElement) {
    const title = up.getAttribute("title");
    if (title !== null && up.dataset.autoTitle !== title) return title;
  }
  return null;
}

function forget(el: TitleTarget): void {
  if (el.dataset.autoTitle === undefined) return;
  if (el.getAttribute("title") === el.dataset.autoTitle) el.removeAttribute("title");
  delete el.dataset.autoTitle;
}

/**
 * Whether the text overflows its box now — wider than one line allows, or taller than the lines it is clamped to. An
 * inline box (a `.truncate` span in running text cuts nothing) or one not shown has no box to overflow.
 */
export function isCut(el: TitleTarget, cut: Exclude<CutStyle, null>): boolean {
  if (el.clientWidth === 0 && el.clientHeight === 0) return false;
  return cut === "line" ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
}

/**
 * Bring the tooltip of the cut text under the pointer up to date: the element under it, or one a few levels up, styled
 * to cut its text — the first that is cut now gets its whole text; one that fits loses ours, and the search goes on up
 * (an inline span cuts nothing; the block around it may). None inside a field, the code editor or a spot that opts out,
 * and none where a component set its own tooltip.
 */
export function updateAutoTitle(start: TitleTarget | null, styleOf: (el: TitleTarget) => CutStyle): void {
  if (!start || start.closest(SKIP)) return;
  let el: TitleTarget | null = start;
  for (let depth = 0; el && depth < DEPTH; depth++, el = el.parentElement) {
    const cut = el.classList.contains("truncate") ? "line" : styleOf(el);
    if (!cut) continue;
    if (ownTitle(el) !== null) return;
    const next = isCut(el, cut) ? autoTitleFor(el.innerText ?? el.textContent ?? "", titleAround(el)) : null;
    if (next !== null) {
      if (el.getAttribute("title") !== next) el.setAttribute("title", next);
      el.dataset.autoTitle = next;
      return;
    }
    forget(el);
  }
}

/** How the page styles an element to cut its text (read only for the few elements under the pointer). */
function cutStyleOf(el: TitleTarget): CutStyle {
  const view = (el as unknown as Element).ownerDocument?.defaultView;
  if (!view) return null;
  const s = view.getComputedStyle(el as unknown as Element);
  const clamp = s.getPropertyValue("-webkit-line-clamp");
  if (clamp && clamp !== "none" && s.overflowY !== "visible") return "lines";
  if (s.textOverflow === "ellipsis" && s.overflowX !== "visible") return "line";
  return null;
}

/** One listener for the whole page; returns its removal. */
export function installAutoTitle(doc: Document): () => void {
  const onOver = (e: MouseEvent) => {
    const target = e.target;
    const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    updateAutoTitle(el as unknown as TitleTarget | null, cutStyleOf);
  };
  // Caught on the way down (a component's own handler cannot stop it); it only reads styles and writes a title.
  doc.addEventListener("mouseover", onOver, { capture: true, passive: true });
  return () => doc.removeEventListener("mouseover", onOver, { capture: true });
}
