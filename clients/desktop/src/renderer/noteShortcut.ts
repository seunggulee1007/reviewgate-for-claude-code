/**
 * wave4 w4-input (polish-06): ⌥⌘N (Ctrl+Alt+N) opens a review note on the selected diff line, else on the first changed
 * line — the Mac diff header's "Add note" (its clicked row, else the first +/− line). A range view takes notes on the new
 * side only, as its gutter does.
 */
import type { DiffLine, SideAnchor } from "@reviewgate/engine";
import type { ShortcutKey } from "./keymap";

export type NoteLine = { side: "old" | "new"; line: number };

/** The physical N key decides (a Korean input source reads it as "ㅜ"). */
export function isNoteKey(e: ShortcutKey): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && (e.code === "KeyN" || e.key.toLowerCase() === "n");
}

export function noteLineTarget(diff: { hunks: { lines: DiffLine[] }[] }, anchor: SideAnchor | null, sides: "both" | "new"): NoteLine | null {
  const lines = diff.hunks.flatMap((h) => h.lines);
  const target = (l: DiffLine): NoteLine | null => {
    if (l.kind === "hunkHeader") return null;
    if (l.kind === "del") return sides === "both" && l.oldNo !== null ? { side: "old", line: l.oldNo } : null;
    return l.newNo !== null ? { side: "new", line: l.newNo } : null;
  };
  if (typeof anchor?.line === "number") {
    const hit = lines.find((l) => l.kind !== "hunkHeader" && (anchor.side === "old" ? l.oldNo : l.newNo) === anchor.line);
    const picked = hit ? target(hit) : null;
    if (picked) return picked;
  }
  for (const l of lines) {
    const picked = l.kind === "add" || l.kind === "del" ? target(l) : null;
    if (picked) return picked;
  }
  return null;
}
