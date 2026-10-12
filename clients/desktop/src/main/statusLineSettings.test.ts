// MARK: wave6 w6-statusline — §44.2: the renderer may ask for the status line; its switches are renderer-writable (show
// it: a boolean; a project's own command: `{ <project hash>: <sha256> }`), and the engine gets the project's own
// allowance with the project's settings (the payload `engineSettings` builds lives in main/settings.ts, which imports
// electron; the per-project part is sessionSettings.ts).
import { describe, expect, it } from "vitest";
import { projectRootHash } from "../shared/hash.js";
import { isSafeExternalURL, validateCommand } from "./ipcGuard.js";
import { allowedProjectStatusLineFor } from "./sessionSettings.js";
import { sanitizeSettingsPatch } from "./settingsGuard.js";

const SHA = "a".repeat(64);

describe("§44.2 status line", () => {
  it("the renderer may send status_line", () => {
    expect(validateCommand({ type: "status_line", columns: 120, visible: true }).ok).toBe(true);
  });

  it("showStatusLine is a boolean; projectStatusLineAllowed maps project hashes to sha256s", () => {
    const key = projectRootHash("/work/repo");
    expect(sanitizeSettingsPatch({ showStatusLine: false, projectStatusLineAllowed: { [key]: SHA } })).toEqual({ patch: { showStatusLine: false, projectStatusLineAllowed: { [key]: SHA } }, rejected: [] });
    expect(sanitizeSettingsPatch({ projectStatusLineAllowed: {} }).patch).toEqual({ projectStatusLineAllowed: {} });
    for (const odd of [{ [key]: true }, { [key]: "not-a-sha" }, { "not a hash": SHA }, [SHA], "x"]) {
      expect(sanitizeSettingsPatch({ projectStatusLineAllowed: odd }).rejected).toEqual(["projectStatusLineAllowed"]);
    }
    const old = sanitizeSettingsPatch({ showStatusLine: "yes", allowProjectStatusLine: true });
    expect(old.patch).toEqual({});
    expect([...old.rejected].sort()).toEqual(["allowProjectStatusLine", "showStatusLine"]); // the old global switch is gone
  });

  it("the engine gets this project's allowance, never another project's", () => {
    const allowed = { [projectRootHash("/work/repo")]: SHA };
    expect(allowedProjectStatusLineFor(allowed, "/work/repo")).toBe(SHA);
    expect(allowedProjectStatusLineFor(allowed, "/work/repo/")).toBe(SHA); // one project key
    expect(allowedProjectStatusLineFor(allowed, "/work/other")).toBe("");
    expect(allowedProjectStatusLineFor(allowed, null)).toBe("");
    expect(allowedProjectStatusLineFor(undefined, "/work/repo")).toBe("");
    expect(allowedProjectStatusLineFor({ [projectRootHash("/work/repo")]: "x" }, "/work/repo")).toBe("");
  });

  it("a status line's links reach the browser only as http(s)", () => {
    expect(isSafeExternalURL("https://github.com/o/r/pull/1")).toBe(true);
    expect(isSafeExternalURL("file:///Users/me")).toBe(false);
  });
});
