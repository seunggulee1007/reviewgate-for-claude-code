/**
 * Composer prompt history (pure, unit-tested): ↑ / ↓ walk the messages sent in this project, and Esc puts back the draft
 * that was there before browsing. MARK: wave6 w6-terminal (§44.1) — like the terminal, also with text typed, and that
 * draft is never lost: it waits until ↓ past the newest entry or Esc brings it back, or a prompt is sent; what is typed
 * into a recalled entry is kept for the walk (as a shell keeps an edited history line). With text in the box the walk
 * starts / goes on only where the textarea cannot move the caret any further — ↑ at the very start, ↓ at the very end —
 * so a long soft-wrapped paragraph keeps ↑ / ↓ for moving between its lines. Persisted per project in localStorage
 * (`rg.promptHistory.<projectRootHash>`), ≤ 100.
 */
export const HISTORY_LIMIT = 100;

/**
 * `index` = the entry shown (null: not browsing); `saved` = the draft to restore; `edits` = what was typed into recalled
 * entries, by index (kept until Esc or a sent prompt).
 */
export type HistoryNav = { index: number | null; saved: string; edits?: Record<number, string> };
export const IDLE_NAV: HistoryNav = { index: null, saved: "" };

/** Newest last; the same text twice in a row is kept once. */
export function pushHistory(entries: string[], text: string, limit = HISTORY_LIMIT): string[] {
  const s = text.trim();
  if (s.length === 0) return entries;
  const next = entries[entries.length - 1] === s ? entries : [...entries, s];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** The box's new text and where its caret goes (`start` after ↑, so the next ↑ walks on; `end` otherwise). */
export type HistoryStep = { nav: HistoryNav; draft: string; caret: "start" | "end" } | null;

const shownAt = (entries: string[], edits: Record<number, string> | undefined, i: number): string => edits?.[i] ?? entries[i]!;

/** The edits with the box's text kept for the entry on screen, when the user changed it. */
function editsWith(entries: string[], nav: HistoryNav, draft: string): Record<number, string> | undefined {
  const i = nav.index;
  if (i === null || draft === shownAt(entries, nav.edits, i)) return nav.edits;
  return { ...nav.edits, [i]: draft };
}

/**
 * ↑ (dir -1) / ↓ (dir 1). `caret` is the textarea's collapsed selection (null when a range is selected).
 * Null → let the textarea handle the key (move the caret between lines).
 */
export function historyStep(entries: string[], nav: HistoryNav, draft: string, caret: number | null, dir: -1 | 1): HistoryStep {
  if (caret === null || entries.length === 0) return null;
  const browsing = nav.index !== null;
  if (dir === -1) {
    if (caret !== 0) return null; // an empty box is always at 0; with text, ↑ first moves the caret up to the start
    const edits = editsWith(entries, nav, draft);
    if (!browsing) {
      const index = entries.length - 1;
      return { nav: { index, saved: draft, edits }, draft: shownAt(entries, edits, index), caret: "start" };
    }
    if (nav.index === 0) return { nav: { ...nav, edits }, draft, caret: "start" };
    const index = nav.index! - 1;
    return { nav: { ...nav, index, edits }, draft: shownAt(entries, edits, index), caret: "start" };
  }
  if (!browsing || caret !== draft.length) return null;
  const edits = editsWith(entries, nav, draft);
  if (nav.index! >= entries.length - 1) return { nav: { index: null, saved: "", edits }, draft: nav.saved, caret: "end" };
  const index = nav.index! + 1;
  return { nav: { ...nav, index, edits }, draft: shownAt(entries, edits, index), caret: "end" };
}

/** Esc while browsing → the saved draft (the edits of recalled entries go); null when not browsing (then Esc may stop a turn). */
export function historyEscape(nav: HistoryNav): HistoryStep {
  return nav.index === null ? null : { nav: IDLE_NAV, draft: nav.saved, caret: "end" };
}

/** What the box stands for: while a recalled entry is shown, the draft typed before ↑ (kept per chat, joined by an insert). */
export function draftOf(nav: HistoryNav, draft: string): string {
  return nav.index === null ? draft : nav.saved;
}

const key = (projectHash: string) => `rg.promptHistory.${projectHash}`;

export function loadHistory(projectHash: string | null): string[] {
  if (!projectHash) return [];
  try {
    const raw = localStorage.getItem(key(projectHash));
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveHistory(projectHash: string | null, entries: string[]): void {
  if (!projectHash) return;
  try {
    localStorage.setItem(key(projectHash), JSON.stringify(entries.slice(-HISTORY_LIMIT)));
  } catch {
    /* storage unavailable */
  }
}
