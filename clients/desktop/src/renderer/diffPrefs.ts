/**
 * MARK: wave2 desktop-diff — view preferences every diff view shares (review, history, PR; the unified rows and the
 * Monaco full-file view alike), remembered per window in localStorage. "줄바꿈" (wrap long lines) is on by default:
 * Java lines are often long and a change at the end of one must be visible without scrolling (audit comp-07 /
 * market-06). Kept out of the main store so the line renderer stays store-free (and testable without a window).
 */
import { create } from "zustand";
import type { DiffLayout } from "./diffSplit";

const WRAP_KEY = "rg.diff.wrap";

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "true";
  } catch {
    return fallback;
  }
}

function write(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode, no window (tests) */
  }
}

// §34.11: "합쳐 보기 | 나란히 보기" — unified by default; a pane too narrow for split shows unified anyway (diffSplit.ts).
const LAYOUT_KEY = "rg.diff.layout";

function readLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

type DiffPrefs = { wrap: boolean; toggleWrap(): void; layout: DiffLayout; setLayout(layout: DiffLayout): void; toggleLayout(): void };

export const useDiffPrefs = create<DiffPrefs>((set, get) => ({
  wrap: read(WRAP_KEY, true),
  toggleWrap() {
    const wrap = !get().wrap;
    write(WRAP_KEY, wrap);
    set({ wrap });
  },
  layout: readLayout(),
  setLayout(layout) {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      /* private mode, no window (tests) */
    }
    set({ layout });
  },
  toggleLayout() {
    get().setLayout(get().layout === "split" ? "unified" : "split");
  },
}));
