/**
 * Lane p-transcript's renderer state — where each chat was read, the times on its rows. Its fields and actions go here,
 * never into store.ts. Spread into `useStore` (store.ts); `resetPolishTranscript` runs when the window's project view is
 * reset (another project, closing it). Seeded empty by p-foundation; owned by p-transcript.
 */
import type { StateCreator } from "zustand";
import type { Store } from "./store";

export type PolishTranscriptSlice = {
  /** The project view was reset: drop what belonged to the project shown before. */
  resetPolishTranscript(): void;
};

export const createPolishTranscriptSlice: StateCreator<Store, [], [], PolishTranscriptSlice> = () => ({
  resetPolishTranscript() {},
});
