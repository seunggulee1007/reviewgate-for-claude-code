// MARK: wave5 w5-model — §43.4: the model mode and policy are renderer-writable settings with checked values.
import { describe, expect, it } from "vitest";
import { sanitizeSettingsPatch } from "./settingsGuard.js";

describe("§43.4 auto model settings", () => {
  it("keeps a known mode / policy and refuses anything else", () => {
    expect(sanitizeSettingsPatch({ modelMode: "auto", modelAutoPolicy: "cost" })).toEqual({ patch: { modelMode: "auto", modelAutoPolicy: "cost" }, rejected: [] });
    expect(sanitizeSettingsPatch({ modelMode: "manual", modelAutoPolicy: "quality" }).patch).toEqual({ modelMode: "manual", modelAutoPolicy: "quality" });
    const odd = sanitizeSettingsPatch({ modelMode: "turbo", modelAutoPolicy: 3 });
    expect(odd.patch).toEqual({});
    expect([...odd.rejected].sort()).toEqual(["modelAutoPolicy", "modelMode"]);
  });
});
