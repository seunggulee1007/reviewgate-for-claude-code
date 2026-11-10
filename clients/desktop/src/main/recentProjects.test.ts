// MARK: wave4 w4-install — audit daily-17: the same recent-list rules as the Mac app (RecentProjects in Core).
import { describe, expect, it } from "vitest";
import { isTransientProjectPath, recentEntries, withoutRecent } from "./recentProjects.js";

describe("recent projects", () => {
  it("keeps temporary and test folders out (Mac's list, plus this machine's temp folder)", () => {
    for (const p of ["/tmp/demo", "/private/tmp/rg-scratch", "/var/folders/x1/T/proj", "/private/var/folders/x1/T/proj", "/tmp"]) {
      expect(isTransientProjectPath(p, ""), p).toBe(true);
    }
    for (const p of ["/Users/me/acme", "/Users/me/tmp/x", "/tmpfoo/x", "C:\\work\\repo"]) {
      expect(isTransientProjectPath(p, ""), p).toBe(false);
    }
    // Windows: %TEMP% in any case or separator form.
    const winTemp = "C:\\Users\\me\\AppData\\Local\\Temp";
    expect(isTransientProjectPath("c:/users/me/appdata/local/temp/rg-123", winTemp)).toBe(true);
    expect(isTransientProjectPath("C:\\Users\\me\\AppData\\Local\\Temp", winTemp)).toBe(true);
    expect(isTransientProjectPath("C:\\Users\\me\\AppData\\Local\\Temporary\\x", winTemp)).toBe(false);
  });

  it("removes one row", () => {
    expect(withoutRecent(["/Users/me/a", "/Users/me/b"], "/Users/me/a")).toEqual(["/Users/me/b"]);
    expect(withoutRecent(["/Users/me/a", "/Users/me/b"], "/Users/me/x")).toEqual(["/Users/me/a", "/Users/me/b"]);
  });

  it("marks folders that are gone and hides stored temp ones", () => {
    const exists = (p: string) => p === "/Users/me/acme";
    expect(recentEntries(["/Users/me/gone", "/tmp/demo", "/Users/me/acme"], exists, "")).toEqual([
      { path: "/Users/me/gone", exists: false },
      { path: "/Users/me/acme", exists: true },
    ]);
  });
});
