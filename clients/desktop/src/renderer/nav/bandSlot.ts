/**
 * §65.8 on Windows — where the peek band sits: under a row of a DOM diff (`UnifiedDiff`, by the row's line id) or in a
 * Monaco view zone under a line (`monacoNav.ts`, by the editor's id). The view that holds the anchor puts an element
 * there (`slot`); the band is portalled into it (NavViews.tsx). Kept apart from navStore so the diff needs no store.
 */
import { create } from "zustand";

export type BandAnchor = { kind: "dom"; path: string; rowId: number } | { kind: "monaco"; editorId: string; line: number };

export const useBandSlot = create<{ anchor: BandAnchor | null; slot: HTMLElement | null }>(() => ({ anchor: null, slot: null }));

/** The view's element under its anchor (null: it went — a fold, another file). A stale anchor's view changes nothing. */
export function setBandSlot(slot: HTMLElement | null, anchor: BandAnchor): void {
  const s = useBandSlot.getState();
  if (!sameAnchor(s.anchor, anchor) || s.slot === slot) return;
  useBandSlot.setState({ slot });
}

export function sameAnchor(a: BandAnchor | null, b: BandAnchor | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "dom" && b.kind === "dom") return a.path === b.path && a.rowId === b.rowId;
  if (a.kind === "monaco" && b.kind === "monaco") return a.editorId === b.editorId && a.line === b.line;
  return false;
}

/** The DOM diff row the band hangs under in `path`'s diff (null: none there). */
export function useDomBandRow(path: string | undefined): number | null {
  return useBandSlot((s) => (path && s.anchor?.kind === "dom" && s.anchor.path === path ? s.anchor.rowId : null));
}
