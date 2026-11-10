/**
 * MARK: wave3 desktop-session — §36.6 in main: the per-project "Load local settings" choice reaches the engine before the
 * session of that project starts (set_settings right before open_project / switch_project), and the renderer may write it.
 */
import { describe, expect, it } from "vitest";
import { projectRootHash } from "../shared/hash.js";
import { loadLocalSettingsFor, projectOpenPath } from "./sessionSettings.js";
import { sanitizeSettingsPatch } from "./settingsGuard.js";

describe("loadLocalSettings per project (§36.6)", () => {
  it("defaults to on (as the terminal's claude does); a stored false for the project turns it off", () => {
    expect(loadLocalSettingsFor(undefined, "/repo")).toBe(true);
    expect(loadLocalSettingsFor({}, "/repo")).toBe(true);
    expect(loadLocalSettingsFor({ [projectRootHash("/repo")]: false }, "/repo")).toBe(false);
    expect(loadLocalSettingsFor({ [projectRootHash("/repo")]: false }, "/repo/")).toBe(false);
    expect(loadLocalSettingsFor({ [projectRootHash("/repo")]: false }, "/other")).toBe(true);
    expect(loadLocalSettingsFor({ [projectRootHash("/repo")]: false }, null)).toBe(true);
    expect(loadLocalSettingsFor({ [projectRootHash("/repo")]: "no" } as unknown as Record<string, boolean>, "/repo")).toBe(true);
  });

  it("open_project / switch_project name the folder whose settings go first; nothing else does", () => {
    expect(projectOpenPath({ type: "open_project", path: "/repo" })).toBe("/repo");
    expect(projectOpenPath({ type: "switch_project", path: "/repo-1600" })).toBe("/repo-1600");
    expect(projectOpenPath({ type: "open_project", path: "" })).toBeNull();
    expect(projectOpenPath({ type: "send", text: "x" } as unknown as { type: string })).toBeNull();
  });

  it("the renderer may write projectLoadLocalSettings — project hashes to booleans only", () => {
    expect(sanitizeSettingsPatch({ projectLoadLocalSettings: { abcd1234: false, "0000ffff": true } }).patch).toEqual({ projectLoadLocalSettings: { abcd1234: false, "0000ffff": true } });
    expect(sanitizeSettingsPatch({ projectLoadLocalSettings: { "not-a-hash": false } }).rejected).toEqual(["projectLoadLocalSettings"]);
    expect(sanitizeSettingsPatch({ projectLoadLocalSettings: { abcd1234: "off" } }).rejected).toEqual(["projectLoadLocalSettings"]);
    expect(sanitizeSettingsPatch({ projectLoadLocalSettings: [] }).rejected).toEqual(["projectLoadLocalSettings"]);
  });
});
