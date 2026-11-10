/**
 * Lane p-window's renderer state — the window's sidebar, Quick Open and project search. Its fields and actions go here,
 * never into store.ts. Spread into `useStore` (store.ts); `resetPolishWindow` runs when the window's project view is
 * reset (another project, closing it). Seeded empty by p-foundation; owned by p-window.
 */
import type { StateCreator } from "zustand";
import type { Store } from "./store";

export type PolishWindowSlice = {
  /** The project view was reset: drop what belonged to the project shown before. */
  resetPolishWindow(): void;
};

export const createPolishWindowSlice: StateCreator<Store, [], [], PolishWindowSlice> = () => ({
  resetPolishWindow() {},
});
