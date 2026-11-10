import { describe, expect, it } from "vitest";
import { sanitizeSettingsPatch } from "./settingsGuard";

// polish p-foundation — the switches the polish lanes add (P1-chrome-01 confirmQuit, P4-composer-13 returnSends,
// P5-sheets-49 autoCheckUpdates): a renderer may write them, as booleans only.

describe("the polish switches", () => {
  it("a renderer may write them as booleans", () => {
    const { patch, rejected } = sanitizeSettingsPatch({ confirmQuit: false, returnSends: true, autoCheckUpdates: false });
    expect(patch).toEqual({ confirmQuit: false, returnSends: true, autoCheckUpdates: false });
    expect(rejected).toEqual([]);
    expect(sanitizeSettingsPatch({ confirmQuit: "no" }).rejected).toEqual(["confirmQuit"]);
  });
});
