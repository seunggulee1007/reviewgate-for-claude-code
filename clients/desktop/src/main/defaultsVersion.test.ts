// MARK: r2-skills-side — the settings file keeps every default, so "Allow for session" (§33.7, r2 M21: on by default now)
// was stored false for everyone who ever saved a setting: such a file reads it as the new default once (`defaultsVersion`),
// while a choice made since stays.
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.3.0", getPath: () => "/tmp/rg-user-data", getLocale: () => "ko" },
  nativeTheme: { themeSource: "system" },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

import type { AppSettings } from "../shared/ipc";
import { DEFAULTS, DEFAULTS_VERSION, engineSettings, withChangedDefaults } from "./settings";
import { sanitizeSettingsPatch } from "./settingsGuard";

/** A file an earlier version saved: every default of then, no version. */
function savedBefore(patch: Partial<AppSettings> = {}): Partial<AppSettings> {
  const { applyUserBashRules: _new, ...then } = { ...DEFAULTS, persistSessionAllows: false, allowWorktreeIsolation: false, peerInbound: "ask", ...patch } as AppSettings;
  return then;
}

describe("defaults that changed (defaultsVersion)", () => {
  it("an earlier file's persistSessionAllows false was only the default then: it reads as on, and the engine keeps the allows", () => {
    const read = { ...DEFAULTS, ...withChangedDefaults(savedBefore()) } as AppSettings;
    expect(read.persistSessionAllows).toBe(true);
    expect(engineSettings(read, null).persistSessionAllows).toBe(true);
    expect(engineSettings(read, null).applyUserBashRules).toBe(true); // a key the file never had: its default
  });

  it("the rest of an earlier file stays as stored, and a value other than the old default too", () => {
    const old = savedBefore({ autoAllowReadOnlyBash: false, notifications: false });
    expect(withChangedDefaults(old)).toEqual({ ...old, persistSessionAllows: undefined, allowWorktreeIsolation: undefined, peerInbound: undefined });
    expect(withChangedDefaults(savedBefore({ persistSessionAllows: true })).persistSessionAllows).toBe(true);
  });

  it("an earlier file's isolation off and peer messages \"ask\" were the defaults then too: they read as on and \"auto\" (M05b, r2-peers)", () => {
    const read = { ...DEFAULTS, ...withChangedDefaults(savedBefore()) } as AppSettings;
    expect(read.allowWorktreeIsolation).toBe(true);
    expect(read.peerInbound).toBe("auto");
    expect(engineSettings(read, null).allowWorktreeIsolation).toBe(true);
    expect(withChangedDefaults(savedBefore({ peerInbound: "off" })).peerInbound).toBe("off"); // not the old default: a choice
    expect(withChangedDefaults({ peerInbound: "ask", allowWorktreeIsolation: false, defaultsVersion: DEFAULTS_VERSION })).toMatchObject({ peerInbound: "ask", allowWorktreeIsolation: false });
  });

  it("a choice saved with this version stays, on or off", () => {
    expect(withChangedDefaults({ persistSessionAllows: false, defaultsVersion: DEFAULTS_VERSION }).persistSessionAllows).toBe(false);
    expect(withChangedDefaults({ persistSessionAllows: true, defaultsVersion: DEFAULTS_VERSION }).persistSessionAllows).toBe(true);
  });

  it("only main writes the version: a renderer's patch cannot", () => {
    expect(sanitizeSettingsPatch({ defaultsVersion: 0, persistSessionAllows: false })).toEqual({ patch: { persistSessionAllows: false }, rejected: ["defaultsVersion"] });
  });
});
