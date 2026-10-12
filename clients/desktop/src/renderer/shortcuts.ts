/**
 * Window-wide review shortcuts (docs/AUDIT-2026-09-14.md §1.11): ⌘] / ⌘[ (Ctrl on other platforms)
 * select the next / previous pending file; ⌘⇧D toggles the diff pane (M16); ⌥⌘A the agent activity panel, ⌥⌘S the side
 * questions and ⌘. stops the turn — the Mac's keys (docs/SHORTCUTS.md, wave4d w4d-windows). Accept (⌘⇧A)
 * lives in DiffPane, Reject (⌘⇧R) in src/renderer/rejectShortcut.ts, the commit dialog (⌘⇧K) in ChangedFiles and ⌘⇧C
 * (focus composer / request changes) in Composer.
 * ⌥⌘/ asks a side question (§21) about the selected diff lines, else the selected file, else the conversation.
 */
import { useEffect } from "react";
import type { SideAnchor } from "@reviewgate/engine";
import { isRunning, useStore } from "./store";
import { isAskAboutKey } from "./keymap";
import { windowKey } from "./keymap"; // MARK: wave4d w4d-windows

/** The anchor of the current diff selection: the first selected line of the shown file (+ the selected text). */
export function selectionAnchor(): { anchor: SideAnchor | null; context?: string } {
  const s = useStore.getState();
  const history = s.historyView;
  const path = history ? history.path : s.selectedPath;
  const base: SideAnchor | null = path ? { path, ...(history ? { entryId: history.entry.id } : {}) } : null;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  const text = sel && !sel.isCollapsed ? sel.toString() : "";
  if (!base || !sel || !text.trim() || sel.rangeCount === 0) return { anchor: base };
  const range = sel.getRangeAt(0);
  const el = (n: Node | null) => (n ? (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement) : null);
  const startLine = el(range.startContainer)?.closest<HTMLElement>(".unified .line");
  if (!startLine) return { anchor: base };
  const lines = [startLine, el(range.endContainer)?.closest<HTMLElement>(".unified .line") ?? startLine];
  const first = lines.find((l) => l.dataset["line"]) ?? null;
  const hunk = Number(startLine.dataset["hunk"]);
  const context = text.length > 4000 ? text.slice(0, 4000) + "…" : text;
  if (first && first.dataset["line"]) {
    return { anchor: { ...base, line: Number(first.dataset["line"]), side: first.dataset["side"] === "old" ? "old" : "new" }, context };
  }
  return { anchor: Number.isFinite(hunk) ? { ...base, hunkId: hunk } : base, context };
}

export function useReviewShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      // wave4 w4-input (polish-05): ⌥⌘/ (Ctrl+Alt+/) — macOS keeps ⌘⇧/ for its Help menu search.
      if (isAskAboutKey(e)) {
        if (s.dialog || s.tab === "prs" || !s.state.project) return;
        e.preventDefault();
        const { anchor, context } = selectionAnchor();
        s.askAbout(anchor, context ? { context } : {});
        return;
      }
      // MARK: wave4d w4d-windows (polish-08): ⌥⌘A agent panel (was ⌘⇧E), ⌥⌘S side questions, ⌘. stop — the Mac's keys
      // (docs/SHORTCUTS.md). ⌥⌘F is the diff's own (components/UnifiedDiff.tsx).
      const wk = windowKey(e);
      if (wk === "stop") {
        if (s.dialog || !isRunning(s.state)) return;
        e.preventDefault();
        s.interrupt();
        return;
      }
      // MARK: wave5 w5-board — §43.1: ⌥⌘B (Ctrl+Alt+B) opens / closes the agent board.
      if (wk === "board") {
        if (s.dialog || !s.state.project) return;
        e.preventDefault();
        s.toggleBoard();
        return;
      }
      if (wk === "agentPanel" || wk === "sidePanel") {
        if (s.dialog || !s.state.project || s.tab === "prs" || (wk === "agentPanel" && s.tab !== "changes")) return;
        e.preventDefault();
        if (wk === "agentPanel") s.toggleAgentPanel();
        else s.toggleSidePanel();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (s.dialog || s.tab !== "changes") return;
      if (e.shiftKey) {
        if (e.key.toLowerCase() !== "d" || !s.state.project) return;
        e.preventDefault();
        s.toggleDiffPane();
        return;
      }
      if (e.key !== "]" && e.key !== "[") return;
      e.preventDefault();
      s.selectPending(e.key === "]" ? 1 : -1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
