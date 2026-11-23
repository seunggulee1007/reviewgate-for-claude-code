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
  /** §60 `pr_comment`: a general comment on the selected PR's conversation. Null when it was posted, else the refusal's words. */
  prComment(body: string): Promise<string | null>;
};

export const createPolishPrSlice: StateCreator<Store, [], [], PolishPrSlice> = (_set, get) => ({
  resetPolishPr() {},
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
