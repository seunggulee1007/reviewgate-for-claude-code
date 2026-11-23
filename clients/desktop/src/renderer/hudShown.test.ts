import { describe, expect, it } from "vitest";
import { hudShown } from "./hudModel";

// §56.6: the HUD hides what is still zero (the Mac's HUDShownTests).

describe("the HUD's numbers", () => {
  it("hides what is still zero", () => {
    expect(hudShown({ contextTokens: 0, sessionCostUSD: 0, turnCount: 0 }, false)).toEqual({ context: false, cost: false, turn: false });
    // A turn running shows its time before anything is counted.
    expect(hudShown({ contextTokens: 0, sessionCostUSD: 0, turnCount: 0 }, true)).toEqual({ context: false, cost: false, turn: true });
    expect(hudShown({ contextTokens: 48_200, sessionCostUSD: 0.42, turnCount: 2 }, false)).toEqual({ context: true, cost: true, turn: true });
    // A subscription reports no cost: the meter and the turn still show.
    expect(hudShown({ contextTokens: 9_000, sessionCostUSD: 0, turnCount: 1 }, false)).toEqual({ context: true, cost: false, turn: true });
  });
});
