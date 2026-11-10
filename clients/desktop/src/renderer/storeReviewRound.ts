/**
 * Store slice (wave2 desktop-flow, docs/PROTOCOL.md §34): the diff range of the selected file (§34.1, the user's pick per
 * file until the next B), the Changes list's "risky first" order that ⌘] / ⌘[ and the move after accept follow
 * (comp-10), and the running turn's changes so far (§34.6 `live_changes` / `live_diff`: the "진행 중 변경" section,
 * its read-only diff and the HUD's "진행 중" totals). Spread into `useStore` (store.ts); the members are declared in
 * `Store` under "MARK: wave2 desktop-flow". The selection itself (`selectFile`) stays in store.ts.
 *
 * `live_changes` snapshots the worktree (the engine reuses one ≤ 2 s old), so it is asked for only while a turn runs and
 * the list is on screen (`watchingLive`): when it comes into view, then when Claude touched another file or the turn's
 * budget numbers moved — at most every `LIVE_MIN_GAP_MS`, never while the window is hidden (a read due then runs once it is
 * shown again); ↻ and the HUD chip ask at once.
 */
import type { StateCreator } from "zustand";
import type { DiffSince, LiveChangedFile, ReviewState } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";
import { contentKey, diffTreeOf } from "./reviewRound";
import type { ReviewDiff, Store } from "./store";

/** The running turn's changes so far (`live_changes`); empty between turns. */
export type LiveState = {
  files: LiveChangedFile[];
  turn: number | null;
  /** ISO-8601: when the engine's live snapshot was taken. */
  at: string | null;
  truncated: boolean;
  loading: boolean;
  /** The last request's refusal in words. */
  error: string | null;
};

/** One live file shown read-only where the review diff normally is (`live_diff`). */
export type LiveView = { path: string; diff: ReviewDiff | null; loading: boolean; error: string | null };

export const EMPTY_LIVE: LiveState = { files: [], turn: null, at: null, truncated: false, loading: false, error: null };

/** A change waits this long before `live_changes` is asked (several edits in a row make one request)… */
export const LIVE_DEBOUNCE_MS = 1500;
/** …and two automatic requests are at least this far apart. */
export const LIVE_MIN_GAP_MS = 5000;
/** wave3 check-clients: how often a read due while the window was hidden checks whether it is shown again. */
export const LIVE_HIDDEN_RECHECK_MS = 2000;

const RISK_FIRST_KEY = "rg.changes.riskFirst";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode etc. */
  }
}

const windowHidden = (): boolean => typeof document !== "undefined" && (document as { visibilityState?: string }).visibilityState === "hidden";

/** The "진행 중 변경" section is on screen (Changes tab, sidebar shown, expanded) or a live file's diff is. */
export const watchingLive = (s: Pick<Store, "tab" | "sidebarVisible" | "liveOpen" | "liveView">): boolean =>
  (s.tab === "changes" && s.sidebarVisible && s.liveOpen) || s.liveView !== null;

/** wave3 check-clients — what the History tab's round in progress shows besides B: the files, their verdicts, the notes. */
function roundShape(s: Pick<ReviewState, "changedFiles" | "reviewNotes">): string {
  const by = (state: string) => s.changedFiles.filter((f) => f.state === state).length;
  return `${s.changedFiles.length}|${by("pending")}|${by("changesRequested")}|${s.reviewNotes.length}`;
}

/** What, in a new snapshot, means the turn changed something on disk since the last look. */
function liveMoved(next: ReviewState, prev: ReviewState): boolean {
  const files = next.hud.turnFiles ?? 0;
  if (files === 0) return false;
  if (files !== (prev.hud.turnFiles ?? 0)) return true;
  return next.budgetUsage.files !== prev.budgetUsage.files || next.budgetUsage.lines !== prev.budgetUsage.lines;
}

export type ReviewRoundSlice = Pick<
  Store,
  | "riskFirst"
  | "setRiskFirst"
  | "diffSince"
  | "rangeChoice"
  | "setDiffSince"
  | "diffUnavailable"
  | "live"
  | "liveOpen"
  | "setLiveOpen"
  | "liveView"
  | "refreshLive"
  | "openLiveDiff"
  | "closeLiveView"
  | "revealLiveChanges"
  | "resetReviewRound"
>;

export const createReviewRoundSlice: StateCreator<Store, [], [], ReviewRoundSlice> = (set, get, api) => {
  const log = (line: string) =>
    set((s) => {
      const logs = [...s.logs, line];
      if (logs.length > 500) logs.splice(0, logs.length - 500);
      return { logs };
    });

  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastLiveAt = 0;
  let liveInflight = false;
  let liveAgain = false;
  /** The live file on screen when its turn ended: selected in the review once the collection lists it. */
  let revealAfterTurn: string | null = null;

  const cancelLive = () => {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = null;
    liveAgain = false;
  };
  const scheduleLive = (delay?: number) => {
    if (liveTimer) return;
    const wait = delay ?? Math.max(LIVE_DEBOUNCE_MS, LIVE_MIN_GAP_MS - (Date.now() - lastLiveAt));
    liveTimer = setTimeout(() => {
      liveTimer = null;
      // wave3 check-clients: a hidden window asks once it is shown again — dropping the read left the list (and a live
      // diff on screen) stale until Claude touched the disk again.
      if (windowHidden()) scheduleLive(LIVE_HIDDEN_RECHECK_MS);
      else void get().refreshLive();
    }, wait);
  };

  const fetchLiveDiff = (path: string, keepShown: boolean) => {
    if (!keepShown) set({ liveView: { path, diff: null, loading: true, error: null } });
    engineRequest({ type: "live_diff", path })
      .then((reply) => {
        if (get().liveView?.path !== path) return;
        const diff: ReviewDiff = { ...reply.diff, truncated: reply.truncated, ...(reply.endTree ? { endTree: reply.endTree } : {}), ...(reply.baseTree ? { baseTree: reply.baseTree } : {}) };
        set({ liveView: { path, diff, loading: false, error: null } });
      })
      .catch((e: unknown) => {
        const r = refusalOf(e);
        log(`[warn] live_diff ${path}: ${r.error}`);
        if (get().liveView?.path === path) set({ liveView: { path, diff: keepShown ? (get().liveView?.diff ?? null) : null, loading: false, error: refusalMessage(r) } });
      });
  };

  api.subscribe((st, prev) => {
    const running = st.state.gate.phase === "running";
    const wasRunning = prev.state.gate.phase === "running";
    if (running && !wasRunning) {
      // A new turn: the previous turn's list is gone.
      cancelLive();
      revealAfterTurn = null;
      if (get().live !== EMPTY_LIVE) set({ live: EMPTY_LIVE });
    } else if (!running && wasRunning) {
      // The turn ended: what it changed becomes the review (§34.6 — nothing here could be accepted).
      cancelLive();
      const view = get().liveView;
      if (view) revealAfterTurn = view.path;
      set({ live: EMPTY_LIVE, liveView: null });
    }
    // Asked for only while someone looks at it (the Changes tab's section, or a live file on screen); the HUD chip keeps
    // the free count meanwhile, and asking starts again (at once) when the section comes into view.
    const looking = watchingLive(st);
    if (running && looking && st.state !== prev.state && liveMoved(st.state, prev.state)) scheduleLive();
    if (running && looking && !watchingLive(prev) && (st.state.hud.turnFiles ?? 0) > 0) void get().refreshLive();
    // §34.4: an open History tab follows the round in progress (a new A is reloaded by store.ts `apply` already) — a new B,
    // and (wave3 check-clients, as the Mac's reload key) a verdict or a note, which never move B.
    const tree = diffTreeOf(st.state.gate);
    const roundMoved = (tree !== null && tree !== diffTreeOf(prev.state.gate)) || roundShape(st.state) !== roundShape(prev.state);
    if (st.tab === "history" && st.state.project && st.state !== prev.state && roundMoved && st.state.gate.turnStartTree === prev.state.gate.turnStartTree) {
      void get().loadReviewHistory();
    }
    // Once the collection lists the file that was on screen live, land on its review diff.
    if (revealAfterTurn && !running && st.state.gate.phase !== "collecting" && st.state !== prev.state) {
      const path = revealAfterTurn;
      revealAfterTurn = null;
      if (st.state.changedFiles.some((f) => f.path === path) && get().selectedPath !== path) queueMicrotask(() => get().selectFile(path));
    }
  });

  return {
    riskFirst: readFlag(RISK_FIRST_KEY, true),
    diffSince: "review",
    rangeChoice: {},
    diffUnavailable: null,
    live: EMPTY_LIVE,
    liveOpen: true,
    liveView: null,

    setRiskFirst(value) {
      writeFlag(RISK_FIRST_KEY, value);
      set({ riskFirst: value });
    },

    setDiffSince(since: DiffSince) {
      const path = get().selectedPath;
      if (!path || get().diffSince === since) return;
      const file = get().state.changedFiles.find((f) => f.path === path);
      set((s) => ({ rangeChoice: { ...s.rangeChoice, [path]: { since, content: file ? contentKey(file) : "" } } }));
      get().selectFile(path);
    },

    setLiveOpen(open) {
      // Expanding brings the section into view: the subscription asks for it then.
      set({ liveOpen: open });
    },

    async refreshLive() {
      const s = get().state;
      if (!s.project || s.gate.phase !== "running") return;
      if (liveInflight) {
        liveAgain = true;
        return;
      }
      liveInflight = true;
      lastLiveAt = Date.now();
      set((st) => ({ live: { ...st.live, loading: true } }));
      try {
        const reply = await engineRequest({ type: "live_changes" });
        if (get().state.gate.phase !== "running" || !reply.running) {
          set({ live: EMPTY_LIVE });
          return;
        }
        const before = get().live.files;
        set({ live: { files: reply.files, turn: reply.turn, at: reply.at, truncated: reply.truncated === true, loading: false, error: null } });
        // The file shown live changed again: read its diff once more (the old one stays until the new one is there).
        const view = get().liveView;
        if (view && !view.loading) {
          const was = before.find((f) => f.path === view.path);
          const now = reply.files.find((f) => f.path === view.path);
          if (now && (!was || was.added !== now.added || was.deleted !== now.deleted)) fetchLiveDiff(view.path, true);
        }
      } catch (e) {
        const r = refusalOf(e);
        log(`[warn] live_changes: ${r.error}`);
        set((st) => ({ live: { ...st.live, loading: false, error: refusalMessage(r) } }));
      } finally {
        liveInflight = false;
        if (liveAgain) {
          liveAgain = false;
          scheduleLive();
        }
      }
    },

    openLiveDiff(path) {
      set({ historyView: null });
      if (get().ui.diffCollapsed === true) get().setUI({ diffCollapsed: undefined });
      fetchLiveDiff(path, false);
    },

    closeLiveView() {
      set({ liveView: null });
    },

    revealLiveChanges() {
      // Coming into view asks by itself (the subscription); a section already on screen is asked again.
      const inView = watchingLive(get());
      if (get().tab !== "changes") get().setTab("changes");
      if (!get().sidebarVisible) get().toggleSidebar();
      set({ liveOpen: true });
      if (inView) void get().refreshLive();
    },

    resetReviewRound() {
      cancelLive();
      revealAfterTurn = null;
      set({ diffSince: "review", rangeChoice: {}, diffUnavailable: null, live: EMPTY_LIVE, liveView: null });
    },
  };
};
