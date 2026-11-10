/**
 * Lane p-diff's renderer state — the notes being written, each diff's scroll position. Its fields and actions go here,
 * never into store.ts. Spread into `useStore` (store.ts); `resetPolishDiff` runs when the window's project view is
 * reset (another project, closing it). Seeded empty by p-foundation; owned by p-diff.
 */
import type { StateCreator } from "zustand";
import type { Store } from "./store";

export type PolishDiffSlice = {
  /** The project view was reset: drop what belonged to the project shown before. */
  resetPolishDiff(): void;
};

export const createPolishDiffSlice: StateCreator<Store, [], [], PolishDiffSlice> = () => ({
  resetPolishDiff() {},
});
