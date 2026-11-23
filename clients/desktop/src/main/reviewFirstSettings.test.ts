// §64 settings.reviewFirst: the renderer may write one of the three modes, and it goes out with hello / set_settings (default edits).
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.3.0", getPath: () => "/tmp/rg-user-data" },
  nativeTheme: { themeSource: "system" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import { DEFAULTS, engineSettings } from "./settings";
import { sanitizeSettingsPatch } from "./settingsGuard";

describe("review first setting (§64)", () => {
  it("is edits unless set; prompts and off go out as they are, anything else as edits", () => {
    expect(engineSettings({ ...DEFAULTS }, null).reviewFirst).toBe("edits");
    expect(engineSettings({ ...DEFAULTS, reviewFirst: "prompts" }, null).reviewFirst).toBe("prompts");
    expect(engineSettings({ ...DEFAULTS, reviewFirst: "off" }, null).reviewFirst).toBe("off");
    expect(engineSettings({ ...DEFAULTS, reviewFirst: "bogus" as never }, null).reviewFirst).toBe("edits");
  });

  it("the renderer may write one of the three modes only", () => {
    for (const mode of ["edits", "prompts", "off"]) expect(sanitizeSettingsPatch({ reviewFirst: mode })).toEqual({ patch: { reviewFirst: mode }, rejected: [] });
    expect(sanitizeSettingsPatch({ reviewFirst: "all" }).rejected).toEqual(["reviewFirst"]);
    expect(sanitizeSettingsPatch({ reviewFirst: true }).rejected).toEqual(["reviewFirst"]);
  });
});
