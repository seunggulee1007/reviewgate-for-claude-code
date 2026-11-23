/**
 * Lane p-pr's renderer state — the PR comments and reviews being written. Its fields and actions go here,
 * never into store.ts. Spread into `useStore` (store.ts); `resetPolishPr` runs when the window's project view is
 * reset (another project, closing it). Seeded empty by p-foundation; owned by p-pr.
 */
import type { StateCreator } from "zustand";
import type { Store } from "./store";
import { engineRequest, refusalOf } from "./engineRequest";
import { refusalMessage } from "./errorCodes";

export type PolishPrSlice = {
  /** The project view was reset: drop what belonged to the project shown before. */
  resetPolishPr(): void;
  /** §60 "Code comments": the PR diff line to bring into view and mark (`pr`: the PR's url; `seq` grows with every jump). */
  prFocus: { pr: string; path: string; side: "LEFT" | "RIGHT"; line: number; seq: number } | null;
  /** Shows an inline comment's file in the PR diff and, when it still has a line there, scrolls to that line. */
  prShowComment(path: string, side: "LEFT" | "RIGHT", line: number | null): void;
  /** §60 `pr_comment`: a general comment on the selected PR's conversation. Null when it was posted, else the refusal's words. */
  prComment(body: string): Promise<string | null>;
};

let focusSeq = 0;

export const createPolishPrSlice: StateCreator<Store, [], [], PolishPrSlice> = (set, get) => ({
  resetPolishPr() {
    set({ prFocus: null });
  },
  prFocus: null,
  prShowComment(path, side, line) {
    const { files, selected } = get().state.pr;
    const file = files.find((f) => f.filename === path);
    if (!file || !selected) return;
    if (get().prSelectedFilename !== path) get().prSelectFile(file);
    set({ prFocus: line === null ? null : { pr: selected.url, path, side, line, seq: ++focusSeq } });
  },
  async prComment(body) {
    try {
      await engineRequest({ type: "pr_comment", body });
      await get().settle();
      return null;
    } catch (e) {
      return refusalMessage(refusalOf(e));
    }
  },
});
