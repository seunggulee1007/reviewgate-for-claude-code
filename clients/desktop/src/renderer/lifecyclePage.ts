/**
 * MARK: polish p-lifecycle — what this page tells main on its own, wired once when the page loads
 * (menuActions.lifecycle.ts): the close / quit question's facts when main asks (P1-chrome-01, closeGuardExtras.ts), what
 * the menu bar's Review and Chat items can do now (P1-chrome-09, src/shared/menuState.ts) — and what main says it did
 * (a toast, P1-chrome-13).
 */
import { closeGuardExtras } from "./closeGuardExtras";
import { commitOf, hasPendingReview, isRunning, useStore, type Store } from "./store";
import { acceptBlockedReason, rejectBlockedReason } from "./reviewRound";
import { finishReviewBlocked } from "./reviewGate";
import { rejectShortcutTarget } from "./rejectShortcut";
import { sessionSwitchRefusal } from "./sessions";
import { NOTHING_ENABLED, sameMenuState, type MenuEnabled } from "../shared/menuState";
import { showToast } from "./toast";

type Facts = Pick<Store, "state" | "selectedPath" | "tab" | "ui" | "historyView">;

/** What the Review and Chat items can do now — the rules of the buttons and keys they stand for. */
export function menuEnabledOf(s: Facts): MenuEnabled {
  const st = s.state;
  if (!st.project) return NOTHING_ENABLED;
  const selected = s.selectedPath ? st.changedFiles.find((f) => f.path === s.selectedPath) : undefined;
  const pending = st.changedFiles.filter((f) => f.state === "pending").length;
  const acceptBlocked = acceptBlockedReason(st);
  const rejectBlocked = rejectBlockedReason(st);
  return {
    accept: selected?.state === "pending" && acceptBlocked === null,
    reject: rejectShortcutTarget({ state: st, selectedPath: s.selectedPath, tab: s.tab, ui: s.ui, historyOpen: s.historyView !== null, dialogOpen: false }).kind === "reject",
    pending: pending > 0,
    acceptAll: pending > 0 && acceptBlocked === null,
    rejectAll: pending > 0 && rejectBlocked === null,
    finishReview: finishReviewBlocked(st) === null,
    commit: commitOf(st).canCommit,
    createPR: !hasPendingReview(st) && !st.branches.isWorktreeDirty && !isRunning(st) && (st.project.branch ?? null) !== null,
    chatSwitch: sessionSwitchRefusal(st) === null,
    stop: isRunning(st),
  };
}

type Watched = { getState(): Facts; subscribe(listener: (s: Facts, prev: Facts) => void): () => void };

/**
 * Tells main what the items can do whenever it changes — at most every `delayMs`, as a store change is often a streamed
 * snapshot. Returns the unsubscribe.
 */
export function reportMenuState(store: Watched, send: (m: MenuEnabled) => void, delayMs = 250): () => void {
  let last: MenuEnabled | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const now = menuEnabledOf(store.getState());
    if (sameMenuState(last, now)) return;
    last = now;
    send(now);
  };
  flush();
  const off = store.subscribe((s, prev) => {
    if (s.state === prev.state && s.selectedPath === prev.selectedPath && s.tab === prev.tab && s.ui === prev.ui && s.historyView === prev.historyView) return;
    if (timer === null) timer = setTimeout(flush, delayMs);
  });
  return () => {
    off();
    if (timer !== null) clearTimeout(timer);
  };
}

let wired = false;

export function wirePage(): void {
  const rg = typeof window !== "undefined" ? window.rg : undefined;
  if (wired || !rg) return;
  wired = true;
  // P1-chrome-01: main asks before it closes this window or quits.
  rg.onCloseGuardQuery?.(() => closeGuardExtras(useStore.getState()));
  // P1-chrome-09: the menu bar's items follow this window's state.
  const report = rg.reportMenuState;
  if (report) reportMenuState(useStore, (m) => report(m));
  // P1-chrome-13: what main did, said in the window (Help › Copy Diagnostics).
  rg.onToast?.((text) => showToast(text));
}
