/**
 * §62 on Windows — the state of code navigation: the peek list at a Ctrl+click, the references panel, the read-only
 * project file view (§47 `project_file`), the line the review's diff should bring into view, and Back / Forward.
 * Requests are numbered: a newer request's reply replaces an older one's (a stale reply is dropped).
 */
import { create } from "zustand";
import type { ProjectFileEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "../engineRequest";
import { refusalMessage } from "../errorCodes";
import { t } from "../i18n";
import { useStore } from "../store";
import { showToast } from "../toast";
import { isSendableSymbol } from "./identifier";
import { EMPTY_HISTORY, goBack, goForward, peekRows, pushHistory, referenceRows, searchRows, type NavHistory, type NavLocation, type PeekRow, type RefRow } from "./navModel";

export type NavTarget = { path: string; line: number; column: number; symbol?: string };

export type PeekState = {
  x: number;
  y: number;
  symbol: string;
  fromPath?: string;
  from: NavLocation | null;
  loading: boolean;
  rows: PeekRow[];
  selected: number;
  truncated: boolean;
  timedOut: boolean;
  error: string | null;
};

export type RefsState = {
  mode: "references" | "search";
  symbol: string;
  fromPath?: string;
  loading: boolean;
  rows: RefRow[];
  files: number;
  truncated: boolean;
  timedOut: boolean;
  error: string | null;
};

export type FileViewState = NavTarget & { seq: number; data: ProjectFileEvent | null; error: string | null };
export type RevealState = NavTarget & { seq: number };

type NavState = {
  peek: PeekState | null;
  refs: RefsState | null;
  file: FileViewState | null;
  reveal: RevealState | null;
  history: NavHistory;
  /** The line the user is at in the file view / the review's diff (the caret, the last click or jump): Back's "from". */
  here: { path: string; line: number } | null;

  goToDefinition(q: { symbol: string; fromPath?: string; line?: number; x: number; y: number; from: NavLocation | null }): void;
  findReferences(q: { symbol: string; fromPath?: string }): void;
  findInProject(symbol: string): void;
  /** Opens a result: a changed file of the review in its diff at that line, any other file in the project file view. */
  openTarget(target: NavTarget, from: NavLocation | null): void;
  back(): void;
  forward(): void;
  setPeekSelected(index: number): void;
  closePeek(): void;
  closeRefs(): void;
  closeFile(): void;
  /** The review's diff showed the line (`found`), or could not — then the project file view shows it. */
  revealDone(seq: number, found: boolean): void;
  setHere(path: string, line: number): void;
  reset(): void;
};

let defSeq = 0;
let refSeq = 0;
let fileSeq = 0;
let revealSeq = 0;

const messageOf = (e: unknown) => refusalMessage(refusalOf(e));

export const useNav = create<NavState>((set, get) => {
  const openFile = (target: NavTarget) => {
    const s = useStore.getState();
    if (s.tab === "prs") s.setTab("changes");
    const seq = ++fileSeq;
    const cur = get().file;
    const keep = cur && cur.path === target.path && cur.data ? { data: cur.data, error: null } : { data: null, error: null };
    set({ file: { ...target, seq, ...keep }, here: { path: target.path, line: target.line } });
    if (keep.data) return;
    engineRequest({ type: "project_file", path: target.path })
      .then((data) => {
        if (get().file?.seq === seq) set({ file: { ...get().file!, data, error: null } });
      })
      .catch((e: unknown) => {
        if (get().file?.seq === seq) set({ file: { ...get().file!, data: null, error: messageOf(e) } });
      });
  };

  const showReview = (target: NavTarget) => {
    const s = useStore.getState();
    set({ file: null, reveal: { ...target, seq: ++revealSeq }, here: { path: target.path, line: target.line } });
    s.revealFile(target.path);
  };

  const show = (to: NavLocation) => {
    const s = useStore.getState();
    if (to.kind === "file") return openFile({ path: to.path, line: to.line, column: to.column });
    if (to.kind === "review") {
      if (s.state.changedFiles.some((f) => f.path === to.path)) return showReview({ path: to.path, line: to.line, column: 1 });
      return openFile({ path: to.path, line: to.line, column: 1 });
    }
    set({ file: null });
    if (to.pane === "prs") s.setTab("prs");
    else if (!s.historyView) s.setTab("history");
  };

  return {
    peek: null,
    refs: null,
    file: null,
    reveal: null,
    history: EMPTY_HISTORY,
    here: null,

    goToDefinition({ symbol, fromPath, line, x, y, from }) {
      if (!isSendableSymbol(symbol)) return;
      const seq = ++defSeq;
      const base = { x, y, symbol, from, rows: [], selected: 0, truncated: false, timedOut: false, error: null, ...(fromPath ? { fromPath } : {}) };
      set({ peek: { ...base, loading: true } });
      engineRequest({ type: "find_definition", symbol, ...(fromPath ? { fromPath } : {}), ...(line && line > 0 ? { line } : {}) })
        .then((reply) => {
          if (seq !== defSeq || !get().peek) return;
          const rows = peekRows(reply.candidates);
          if (rows.length === 1) {
            set({ peek: null });
            get().openTarget({ ...rows[0]!, symbol }, from);
            if (reply.timedOut) showToast(t("Search stopped after 10 s"));
            return;
          }
          set({ peek: { ...base, loading: false, rows, truncated: reply.truncated, timedOut: reply.timedOut === true } });
        })
        .catch((e: unknown) => {
          if (seq !== defSeq || !get().peek) return;
          set({ peek: { ...base, loading: false, error: messageOf(e) } });
        });
    },

    findReferences({ symbol, fromPath }) {
      if (!isSendableSymbol(symbol)) return;
      const seq = ++refSeq;
      const base = { mode: "references" as const, symbol, rows: [], files: 0, truncated: false, timedOut: false, error: null, ...(fromPath ? { fromPath } : {}) };
      set({ peek: null, refs: { ...base, loading: true } });
      engineRequest({ type: "find_references", symbol, ...(fromPath ? { fromPath } : {}) })
        .then((reply) => {
          if (seq !== refSeq || !get().refs) return;
          set({ refs: { ...base, loading: false, rows: referenceRows(reply.hits), files: reply.files, truncated: reply.truncated, timedOut: reply.timedOut === true } });
        })
        .catch((e: unknown) => {
          if (seq === refSeq && get().refs) set({ refs: { ...base, loading: false, error: messageOf(e) } });
        });
    },

    findInProject(symbol) {
      const seq = ++refSeq;
      const base = { mode: "search" as const, symbol, rows: [], files: 0, truncated: false, timedOut: false, error: null };
      set({ peek: null, refs: { ...base, loading: true } });
      engineRequest({ type: "project_search", query: symbol, wholeWord: true, caseSensitive: true })
        .then((reply) => {
          if (seq !== refSeq || !get().refs) return;
          const rows = searchRows(reply.matches, symbol);
          set({ refs: { ...base, loading: false, rows, files: new Set(rows.map((r) => r.path)).size, truncated: reply.truncated, timedOut: reply.timedOut === true } });
        })
        .catch((e: unknown) => {
          if (seq === refSeq && get().refs) set({ refs: { ...base, loading: false, error: messageOf(e) } });
        });
    },

    openTarget(target, from) {
      if (from) set((st) => ({ history: pushHistory(st.history, from) }));
      set({ peek: null });
      const s = useStore.getState();
      const changed = s.state.changedFiles.some((f) => f.path === target.path && f.status !== "D");
      if (changed) showReview(target);
      else openFile(target);
    },

    back() {
      const here = currentLocation();
      const step = here && goBack(get().history, here);
      if (!step) return;
      set({ history: step.history, peek: null });
      show(step.to);
    },

    forward() {
      const here = currentLocation();
      const step = here && goForward(get().history, here);
      if (!step) return;
      set({ history: step.history, peek: null });
      show(step.to);
    },

    setPeekSelected(index) {
      const p = get().peek;
      if (p) set({ peek: { ...p, selected: index } });
    },
    closePeek: () => {
      defSeq++;
      set({ peek: null });
    },
    closeRefs: () => {
      refSeq++;
      set({ refs: null });
    },
    closeFile: () => set({ file: null }),

    revealDone(seq, found) {
      const r = get().reveal;
      if (!r || r.seq !== seq) return;
      set({ reveal: null });
      if (!found) openFile(r);
    },

    setHere(path, line) {
      const h = get().here;
      if (!h || h.path !== path || h.line !== line) set({ here: { path, line } });
    },

    reset() {
      defSeq++;
      refSeq++;
      set({ peek: null, refs: null, file: null, reveal: null, history: EMPTY_HISTORY, here: null });
    },
  };
});

/** Where the user is now (Back's "from"; Forward's too). */
export function currentLocation(): NavLocation | null {
  const n = useNav.getState();
  const s = useStore.getState();
  if (n.file) {
    const line = n.here?.path === n.file.path ? n.here.line : n.file.line;
    return { kind: "file", path: n.file.path, line, column: 1 };
  }
  if (s.tab === "prs") return { kind: "pane", pane: "prs" };
  if (s.historyView) return { kind: "pane", pane: "history" };
  if (s.selectedPath) return { kind: "review", path: s.selectedPath, line: n.here?.path === s.selectedPath ? n.here.line : 1 };
  return null;
}

/** Why Back / Forward cannot be used now (null: it can). */
export function backBlocked(h: NavHistory): string | null {
  return h.back.length === 0 ? t("Nothing to go back to — Go to Definition (F12) remembers where you were") : null;
}
export function forwardBlocked(h: NavHistory): string | null {
  return h.forward.length === 0 ? t("Nothing to go forward to") : null;
}

// A project switch drops everything: the paths are another repository's. A file picked in the Changes list, a past
// round's or the running turn's diff take the pane back from the project file view (as on the Mac, §47).
let lastRoot: string | null | undefined;
useStore.subscribe((s, prev) => {
  const root = s.state.project?.root ?? null;
  if (lastRoot !== undefined && root !== lastRoot) useNav.getState().reset();
  lastRoot = root;
  if (!useNav.getState().file) return;
  const picked = s.selectedPath !== prev.selectedPath;
  const opened = (s.historyView !== null && s.historyView !== prev.historyView) || (s.liveView !== null && s.liveView !== prev.liveView);
  if (picked || opened) useNav.getState().closeFile();
});
