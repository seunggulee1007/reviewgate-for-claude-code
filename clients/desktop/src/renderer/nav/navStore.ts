/**
 * §62 on Windows — the state of code navigation: the peek list at a Ctrl+click, the references panel, the read-only
 * project file view (§47 `project_file`), the line the review's diff should bring into view, and Back / Forward.
 * Requests are numbered: a newer request's reply replaces an older one's (a stale reply is dropped).
 */
import { create } from "zustand";
import type { ProjectFileEvent, SymbolPreviewEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "../engineRequest";
import { refusalMessage } from "../errorCodes";
import { t } from "../i18n";
import { useStore } from "../store";
import { showToast } from "../toast";
import { isSendableSymbol } from "./identifier";
import { EMPTY_HISTORY, goBack, goForward, peekRows, pushHistory, referenceRows, searchRows, type NavHistory, type NavLocation, type PeekRow, type RefRow } from "./navModel";
import { sameAnchor, useBandSlot, type BandAnchor } from "./bandSlot"; // §65.8
import { bandLines, bandRows, type BandLine, type BandRow } from "./peekModel";
import { HoverDebounce } from "./hoverModel";

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

/** §65.8: the peek band — the definition's lines inline under the clicked line, the candidates beside them. */
export type BandState = {
  seq: number;
  anchor: BandAnchor;
  symbol: string;
  fromPath?: string;
  from: NavLocation | null;
  loading: boolean;
  error: string | null;
  rows: BandRow[];
  selected: number;
  truncated: boolean;
  timedOut: boolean;
  /** `definition_preview` per candidate (its index): the reply, or the refusal said. Absent: on its way. */
  previews: Record<number, SymbolPreviewEvent | string>;
};

/** §65.8: what the hover asks about — the name under the pointer with Ctrl held, and where to show the card. */
export type HoverQuery = { symbol: string; fromPath?: string; line?: number; column?: number; receiver?: string; x: number; y: number };
/** The hover card: the declaration's signature (bold) and its lines — the doc comment above and the next 8. */
export type HoverState = { seq: number; x: number; y: number; signature: string; path: string; line: number; lines: BandLine[] };

export type FileViewState = NavTarget & { seq: number; data: ProjectFileEvent | null; error: string | null };
export type RevealState = NavTarget & { seq: number };

type NavState = {
  peek: PeekState | null;
  band: BandState | null;
  hover: HoverState | null;
  refs: RefsState | null;
  file: FileViewState | null;
  reveal: RevealState | null;
  history: NavHistory;
  /** The line the user is at in the file view / the review's diff (the caret, the last click or jump): Back's "from". */
  here: { path: string; line: number } | null;

  /** §65.6: `column` (1-based) and `receiver` of the click make members of the receiver's type win. */
  goToDefinition(q: { symbol: string; fromPath?: string; line?: number; column?: number; receiver?: string; x: number; y: number; from: NavLocation | null }): void;
  /** §65.8 Peek Definition (Alt+F12; Ctrl+click while Settings says "Peek"): the band under `anchor`. */
  peekDefinition(q: { symbol: string; fromPath?: string; line?: number; column?: number; receiver?: string; anchor: BandAnchor; from: NavLocation | null }): void;
  /** Another candidate of the band (its preview is asked once). */
  setBandSelected(index: number): void;
  /** The band's candidate in the diff / the project file view (as §62 opens one); the band closes. */
  openBandSelected(): void;
  closeBand(): void;
  /** §65.8 hover: `find_definition`, then `definition_preview {after: 8}` of the first candidate; nothing for none. */
  requestHover(q: HoverQuery): void;
  hideHover(): void;
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

/** `find_definition`'s optional fields (§62 `fromPath` / `line`, §65.6 `column` / `receiver`), each only when known. */
export function definitionHints(q: { fromPath?: string | undefined; line?: number | undefined; column?: number | undefined; receiver?: string | undefined }) {
  return {
    ...(q.fromPath ? { fromPath: q.fromPath } : {}),
    ...(q.line && q.line > 0 ? { line: q.line } : {}),
    ...(q.column && q.column > 0 ? { column: q.column } : {}),
    ...(q.receiver ? { receiver: q.receiver } : {}),
  };
}

let defSeq = 0;
let bandSeq = 0;
let hoverSeq = 0;
let refSeq = 0;
let fileSeq = 0;
let revealSeq = 0;

const messageOf = (e: unknown) => refusalMessage(refusalOf(e));

export const useNav = create<NavState>((set, get) => {
  const dropBand = () => {
    bandSeq++;
    if (get().band) set({ band: null });
    if (useBandSlot.getState().anchor) useBandSlot.setState({ anchor: null, slot: null });
  };

  const loadPreview = (seq: number, index: number) => {
    const row = get().band?.rows[index];
    if (!row) return;
    engineRequest({ type: "definition_preview", path: row.path, line: row.line })
      .then((reply) => {
        const b = get().band;
        if (b && b.seq === seq) set({ band: { ...b, previews: { ...b.previews, [index]: reply } } });
      })
      .catch((e: unknown) => {
        const b = get().band;
        if (b && b.seq === seq) set({ band: { ...b, previews: { ...b.previews, [index]: messageOf(e) } } });
      });
  };

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
    band: null,
    hover: null,
    refs: null,
    file: null,
    reveal: null,
    history: EMPTY_HISTORY,
    here: null,

    goToDefinition({ symbol, fromPath, line, column, receiver, x, y, from }) {
      if (!isSendableSymbol(symbol)) return;
      const seq = ++defSeq;
      const base = { x, y, symbol, from, rows: [], selected: 0, truncated: false, timedOut: false, error: null, ...(fromPath ? { fromPath } : {}) };
      set({ peek: { ...base, loading: true } });
      engineRequest({ type: "find_definition", symbol, ...definitionHints({ fromPath, line, column, receiver }) })
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

    peekDefinition({ symbol, fromPath, line, column, receiver, anchor, from }) {
      if (!isSendableSymbol(symbol)) return;
      defSeq++;
      const seq = ++bandSeq;
      const base = { seq, anchor, symbol, from, rows: [], selected: 0, truncated: false, timedOut: false, error: null, previews: {}, ...(fromPath ? { fromPath } : {}) };
      set({ peek: null, band: { ...base, loading: true } });
      if (!sameAnchor(useBandSlot.getState().anchor, anchor)) useBandSlot.setState({ anchor, slot: null });
      engineRequest({ type: "find_definition", symbol, ...definitionHints({ fromPath, line, column, receiver }) })
        .then((reply) => {
          if (seq !== bandSeq || !get().band) return;
          set({ band: { ...base, loading: false, rows: bandRows(reply.candidates), truncated: reply.truncated, timedOut: reply.timedOut === true } });
          loadPreview(seq, 0);
        })
        .catch((e: unknown) => {
          if (seq === bandSeq && get().band) set({ band: { ...base, loading: false, error: messageOf(e) } });
        });
    },

    setBandSelected(index) {
      const b = get().band;
      if (!b || index < 0 || index >= b.rows.length || index === b.selected) return;
      set({ band: { ...b, selected: index } });
      if (!(index in b.previews)) loadPreview(b.seq, index);
    },

    openBandSelected() {
      const b = get().band;
      const row = b?.rows[b.selected];
      if (!b || !row) return;
      get().openTarget({ path: row.path, line: row.line, column: row.column, symbol: b.symbol }, b.from);
    },

    closeBand: dropBand,

    requestHover(q) {
      const seq = ++hoverSeq;
      if (get().hover) set({ hover: null });
      if (!isSendableSymbol(q.symbol)) return;
      const live = () => seq === hoverSeq;
      engineRequest({ type: "find_definition", symbol: q.symbol, ...definitionHints(q) })
        .then(async (reply) => {
          const best = reply.candidates[0];
          if (!live() || !best) return;
          const preview = await engineRequest({ type: "definition_preview", path: best.path, line: best.line, after: 8 });
          if (!live()) return;
          set({ hover: { seq, x: q.x, y: q.y, signature: preview.symbol?.signature ?? best.preview, path: best.path, line: best.line, lines: bandLines(preview) } });
        })
        .catch(() => undefined); // a hover says nothing about a refusal: the click does
    },

    hideHover() {
      hoverSeq++;
      if (get().hover) set({ hover: null });
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
      dropBand();
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
      dropBand();
      show(step.to);
    },

    forward() {
      const here = currentLocation();
      const step = here && goForward(get().history, here);
      if (!step) return;
      set({ history: step.history, peek: null });
      dropBand();
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
    closeFile: () => {
      dropBand();
      set({ file: null });
    },

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
      hoverSeq++;
      dropBand();
      set({ peek: null, hover: null, refs: null, file: null, reveal: null, history: EMPTY_HISTORY, here: null });
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
  const nav = useNav.getState();
  if (!nav.file && !nav.band) return;
  const picked = s.selectedPath !== prev.selectedPath;
  const opened = (s.historyView !== null && s.historyView !== prev.historyView) || (s.liveView !== null && s.liveView !== prev.liveView);
  if (!picked && !opened && s.tab === prev.tab) return;
  // §65.8: the band belongs to the line it was opened under — another file or pane closes it.
  if (nav.band) nav.closeBand();
  if (nav.file && (picked || opened)) nav.closeFile();
});

/** §65.8: the one hover timer of the window (the DOM diffs and every Monaco editor move it). */
export const hoverTimer = new HoverDebounce<HoverQuery>((q) => useNav.getState().requestHover(q));

/** Ctrl released, a click, a scroll, the pointer off the name: no hover, and none on its way. */
export function endHover(): void {
  hoverTimer.reset();
  useNav.getState().hideHover();
}
