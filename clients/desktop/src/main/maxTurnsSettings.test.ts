// docs/PROTOCOL.md §38.2: no tool-call limit by default — the engine gets maxTurns 0 (none) until the limit is turned on;
// the number stays stored for then. A settings file from before the switch kept the old default 200: off as well.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.3.0", getPath: () => "/tmp/rg-user-data", getLocale: () => "ko" },
  nativeTheme: { themeSource: "system" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import { DEFAULTS, engineSettings, maxTurnsOf } from "./settings";
import { sanitizeSettingsPatch } from "./settingsGuard";

describe("tool-call limit (§38.2)", () => {
  it("is off by default: the engine gets 0 (no limit), also for a file from before the switch that kept 200", () => {
    expect(DEFAULTS.maxTurnsLimit).toBe(false);
    expect(engineSettings({ ...DEFAULTS }, null).maxTurns).toBe(0);
    const old = { ...DEFAULTS, maxTurns: 200 } as Record<string, unknown>;
    delete old.maxTurnsLimit;
    expect(engineSettings(old as never, null).maxTurns).toBe(0);
  });

  it("on: the stored number (10–1000, else 200) goes out", () => {
    expect(engineSettings({ ...DEFAULTS, maxTurnsLimit: true, maxTurns: 300 }, null).maxTurns).toBe(300);
    expect(maxTurnsOf({ maxTurnsLimit: true, maxTurns: 5 })).toBe(10);
    expect(maxTurnsOf({ maxTurnsLimit: true, maxTurns: 5000 })).toBe(1000);
    expect(maxTurnsOf({ maxTurnsLimit: true })).toBe(200);
    expect(maxTurnsOf({ maxTurnsLimit: false, maxTurns: 300 })).toBe(0);
  });

  it("the renderer may write maxTurnsLimit as a boolean only", () => {
    expect(sanitizeSettingsPatch({ maxTurnsLimit: true })).toEqual({ patch: { maxTurnsLimit: true }, rejected: [] });
    expect(sanitizeSettingsPatch({ maxTurnsLimit: "yes" }).rejected).toEqual(["maxTurnsLimit"]);
  });
});
