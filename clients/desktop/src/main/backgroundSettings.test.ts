// §52 settings.backgroundWork: the renderer may write a boolean, and it goes out with hello / set_settings (default on).
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.3.0", getPath: () => "/tmp/rg-user-data" },
  nativeTheme: { themeSource: "system" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import { DEFAULTS, engineSettings } from "./settings";
import { validateCommand } from "./ipcGuard";
import { sanitizeSettingsPatch } from "./settingsGuard";

describe("background work setting (§52)", () => {
  it("the renderer may write a boolean only", () => {
    expect(sanitizeSettingsPatch({ backgroundWork: false })).toEqual({ patch: { backgroundWork: false }, rejected: [] });
    expect(sanitizeSettingsPatch({ backgroundWork: "no" }).rejected).toEqual(["backgroundWork"]);
  });

  it("§52.2 subagentsInTurn: off by default, a boolean only, sent with hello / set_settings", () => {
    expect(DEFAULTS.subagentsInTurn).toBe(false);
    expect(engineSettings({ ...DEFAULTS }, null).subagentsInTurn).toBe(false);
    expect(engineSettings({ ...DEFAULTS, subagentsInTurn: true }, null).subagentsInTurn).toBe(true);
    expect(sanitizeSettingsPatch({ subagentsInTurn: true })).toEqual({ patch: { subagentsInTurn: true }, rejected: [] });
    expect(sanitizeSettingsPatch({ subagentsInTurn: "yes" }).rejected).toEqual(["subagentsInTurn"]);
  });

  it("is sent as backgroundWork with hello / set_settings: on by default, off when turned off", () => {
    expect(DEFAULTS.backgroundWork).toBe(true);
    expect(engineSettings({ ...DEFAULTS }, null).backgroundWork).toBe(true);
    const old = { ...DEFAULTS } as Record<string, unknown>;
    delete old.backgroundWork;
    expect(engineSettings(old as never, null).backgroundWork).toBe(true);
    expect(engineSettings({ ...DEFAULTS, backgroundWork: false }, null).backgroundWork).toBe(false);
  });

  it("the three commands pass main's guard", () => {
    for (const cmd of [{ type: "task_stop", taskId: "b1" }, { type: "task_background", toolUseId: "tu1" }, { type: "task_background" }, { type: "task_output", taskId: "b1" }]) {
      expect(validateCommand(cmd)).toEqual({ ok: true, cmd });
    }
  });
});
