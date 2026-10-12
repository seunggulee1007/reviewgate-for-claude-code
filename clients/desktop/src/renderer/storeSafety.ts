/**
 * MARK: wave4 w4-safety
 * Store slice of robustness-07: "Stop" that does not end the turn. After `STUCK_INTERRUPT_MS` with the turn still
 * running, the composer offers "Force restart" — `restart_session`, which closes the running turn, collects its changes
 * and resumes the same conversation (the queue and the review stay). Clears by itself when the turn ends. The Mac's
 * `AppState.armInterruptWatch` / `forceRestartStuckTurn` (AppState+Safety.swift). Spread into `useStore` (store.ts).
 */
import type { StateCreator } from "zustand";
import type { Store } from "./store";
import { STUCK_INTERRUPT_MS } from "./workSafety";

export type SafetySlice = {
  /** "Stop" did not end the turn within `STUCK_INTERRUPT_MS`: the composer offers "Force restart". */
  interruptStuck: boolean;
  /** Starts (or restarts) the watch after "Stop". */
  armInterruptWatch(delayMs?: number): void;
  /** "Force restart": ends the CLI process and resumes the same conversation (`restart_session`). */
  forceRestartStuckTurn(): void;
};

let watch: ReturnType<typeof setInterval> | null = null;
const stopWatch = () => {
  if (watch) clearInterval(watch);
  watch = null;
};

export const createSafetySlice: StateCreator<Store, [], [], SafetySlice> = (set, get) => ({
  interruptStuck: false,

  armInterruptWatch(delayMs = STUCK_INTERRUPT_MS) {
    stopWatch();
    if (get().interruptStuck) set({ interruptStuck: false });
    const since = Date.now();
    watch = setInterval(() => {
      const running = get().state.gate.phase === "running";
      if (!running) {
        stopWatch();
        if (get().interruptStuck) set({ interruptStuck: false });
        return;
      }
      if (Date.now() - since >= delayMs && !get().interruptStuck) set({ interruptStuck: true });
    }, Math.min(500, Math.max(10, Math.floor(delayMs / 3))));
  },

  forceRestartStuckTurn() {
    if (!get().interruptStuck || get().state.gate.phase !== "running") return;
    stopWatch();
    set({ interruptStuck: false });
    void get().restartSession();
  },
});
