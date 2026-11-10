import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createSafetySlice, type SafetySlice } from "./storeSafety";
import type { Store } from "./store";

// MARK: wave4 w4-safety — robustness-07: "Force restart" after a stop that did not stop.

type Mini = SafetySlice & { state: { gate: { phase: string } }; restartSession: () => Promise<void> };

function miniStore(restart: () => Promise<void>) {
  return createStore<Mini>()((set, get, api) => ({
    state: { gate: { phase: "running" } },
    restartSession: restart,
    ...createSafetySlice(set as never, get as unknown as () => Store, api as never),
  }));
}

// Fake timers (Date too): the slice's setInterval and Date.now() differences run on a clock the test moves, not the runner's.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const wait = async (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("force restart (robustness-07)", () => {
  it("is offered when the turn still runs after the delay, and restarts the session", async () => {
    const restart = vi.fn(async () => undefined);
    const store = miniStore(restart);
    store.getState().armInterruptWatch(30);
    expect(store.getState().interruptStuck).toBe(false);
    await wait(120);
    expect(store.getState().interruptStuck).toBe(true);
    store.getState().forceRestartStuckTurn();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(store.getState().interruptStuck).toBe(false);
  });

  it("goes away when the turn ends, and a stop that works never offers it", async () => {
    const restart = vi.fn(async () => undefined);
    const store = miniStore(restart);
    store.getState().armInterruptWatch(30);
    await wait(120);
    expect(store.getState().interruptStuck).toBe(true);
    store.setState({ state: { gate: { phase: "reviewing" } } });
    await wait(60);
    expect(store.getState().interruptStuck).toBe(false);
    store.getState().forceRestartStuckTurn();
    expect(restart).not.toHaveBeenCalled();

    store.setState({ state: { gate: { phase: "running" } } });
    store.getState().armInterruptWatch(30);
    store.setState({ state: { gate: { phase: "idle" } } });
    await wait(120);
    expect(store.getState().interruptStuck).toBe(false);
  });
});
