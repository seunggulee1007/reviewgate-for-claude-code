/**
 * §62 — the name under the pointer (or the caret / selection) in a DOM diff (`UnifiedDiff`: the review, History and PR
 * diffs). A diff pane that takes navigation carries `data-nav-path` (the file's repo-relative path); its rows carry
 * `data-side` / `data-line`, their code is `.text`.
 */
import { identifierAt, isSendableSymbol } from "./identifier";

/** The Ctrl+click modifier: Ctrl on Windows / Linux, ⌘ on a Mac (the development build). */
export function navModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return typeof window !== "undefined" && window.rg?.platform === "darwin" ? e.metaKey : e.ctrlKey;
}

export type DomNavTarget = {
  symbol: string;
  path: string;
  /** The row's line on its side (the new side's for an added / unchanged line); absent on a hunk header. */
  line?: number;
  side?: "old" | "new";
  /** The name's text, for the underline. */
  range: Range;
};

type CaretDoc = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** The name at the window point (x, y), when it is over a line's code in a navigable diff. */
export function domTargetAt(x: number, y: number): DomNavTarget | null {
  const hit = document.elementFromPoint(x, y);
  const text = hit?.closest?.(".unified-pane[data-nav-path] .line .text");
  if (!text) return null;
  const doc = document as CaretDoc;
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) ({ offsetNode: node, offset } = pos);
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || !text.contains(node)) return null;
  return targetIn(text, textOffset(text, node, offset));
}

/** The name at the caret / the selected name, when the selection is in a navigable diff's code (F12 / Shift+F12). */
export function domTargetAtSelection(): DomNavTarget | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null;
  const el = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? (sel.anchorNode as Element) : sel.anchorNode.parentElement;
  const text = el?.closest(".unified-pane[data-nav-path] .line .text");
  if (!text) return null;
  const range = sel.getRangeAt(0);
  const start = textOffset(text, range.startContainer, range.startOffset);
  if (!sel.isCollapsed) {
    const chosen = sel.toString().trim();
    if (isSendableSymbol(chosen) && text.contains(range.endContainer)) {
      const base = targetIn(text, start);
      if (base) return { ...base, symbol: chosen };
    }
  }
  return targetIn(text, start);
}

function targetIn(text: Element, offset: number): DomNavTarget | null {
  const row = text.closest<HTMLElement>(".line[data-id]");
  const pane = text.closest<HTMLElement>(".unified-pane[data-nav-path]");
  const path = pane?.dataset["navPath"];
  if (!row || !path) return null;
  const found = identifierAt(text.textContent ?? "", offset, path);
  if (!found) return null;
  const range = rangeIn(text, found.start, found.end);
  if (!range) return null;
  const line = Number(row.dataset["line"]);
  const side = row.dataset["side"] === "old" ? "old" : row.dataset["side"] === "new" ? "new" : undefined;
  return { symbol: found.symbol, path, range, ...(Number.isInteger(line) && line > 0 ? { line } : {}), ...(side ? { side } : {}) };
}

/** `node` + `offset` as a character offset into `root`'s text. */
function textOffset(root: Element, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** The DOM range of `[start, end)` of an element's text. */
function rangeIn(el: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let from: { node: Node; off: number } | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.nodeValue?.length ?? 0;
    if (!from && start < pos + len) from = { node: n, off: start - pos };
    if (from && end <= pos + len) {
      const r = document.createRange();
      r.setStart(from.node, from.off);
      r.setEnd(n, end - pos);
      return r;
    }
    pos += len;
  }
  return null;
}
