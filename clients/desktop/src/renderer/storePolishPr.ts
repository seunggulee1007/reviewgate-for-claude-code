/**
 * Lane p-pr's renderer state — the PR comments and reviews being written. Its fields and actions go here,
 * never into store.ts. Spread into `useStore` (store.ts); `resetPolishPr` runs when the window's project view is
 * reset (another project, closing it). Seeded empty by p-foundation; owned by p-pr.
 */
import type { StateCreator } from "zustand";
import type { Store } from "./store";

export type PolishPrSlice = {
  /** The project view was reset: drop what belonged to the project shown before. */
  resetPolishPr(): void;
};

export const createPolishPrSlice: StateCreator<Store, [], [], PolishPrSlice> = () => ({
  resetPolishPr() {},
});
