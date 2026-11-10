// M05b (docs/PROTOCOL.md §33.4, §39.4): agents that work in another worktree run unless turned off, and the engine's own
// chat moves (EnterWorktree / ExitWorktree in auto mode) send the follow-up in the UI's language.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.3.0", getPath: () => "/tmp/rg-user-data" },
  nativeTheme: { themeSource: "system" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import { DEFAULTS, engineSettings } from "./settings";
import { initI18n, t } from "../renderer/i18n";

afterEach(() => initI18n("en", "darwin"));

describe("worktree settings for the engine (M05b)", () => {
  it("allowWorktreeIsolation: on by default and for a settings file written before it existed; off when turned off", () => {
    expect(DEFAULTS.allowWorktreeIsolation).toBe(true);
    expect(engineSettings({ ...DEFAULTS }, null).allowWorktreeIsolation).toBe(true);
    const old = { ...DEFAULTS } as Record<string, unknown>;
    delete old.allowWorktreeIsolation;
    expect(engineSettings(old as never, null).allowWorktreeIsolation).toBe(true);
    expect(engineSettings({ ...DEFAULTS, allowWorktreeIsolation: false }, null).allowWorktreeIsolation).toBe(false);
  });

  it("chatMoveFollowUp: the Mac's follow-up words with {name} for the engine to fill in, in the UI language", () => {
    expect(engineSettings({ ...DEFAULTS }, null).chatMoveFollowUp).toBe("The working folder moved to {name}. Please continue what you were doing.");
    initI18n("ko", "darwin");
    const ko = engineSettings({ ...DEFAULTS }, null).chatMoveFollowUp!;
    expect(ko).toBe(t("The working folder moved to {0}. Please continue what you were doing.", "{name}"));
    expect(ko).toContain("{name}");
    expect(ko).not.toBe("The working folder moved to {name}. Please continue what you were doing.");
  });
});
