import { describe, expect, it } from "vitest";
import { sanitizeSettingsPatch, validateExecutable } from "./settingsGuard.js";

describe("sanitizeSettingsPatch", () => {
  it("keeps renderer-writable keys with valid values", () => {
    const { patch, rejected } = sanitizeSettingsPatch({ appearance: "dark", budgetMaxFiles: 12, ghHost: "ghe.example.com", disabledPlugins: ["a@b"], worktreeRoot: "~/wt" });
    expect(patch).toEqual({ appearance: "dark", budgetMaxFiles: 12, ghHost: "ghe.example.com", disabledPlugins: ["a@b"], worktreeRoot: "~/wt" });
    expect(rejected).toEqual([]);
  });

  it("never accepts executable paths or main-owned keys", () => {
    const { patch, rejected } = sanitizeSettingsPatch({ claudePath: "/tmp/evil", ghPath: "x", gitPath: "y", openWindows: [], recentProjects: [], cachedCapabilities: {}, ui: {}, locale: "ko", __proto__x: 1 });
    expect(patch).toEqual({});
    expect(rejected.sort()).toEqual(["__proto__x", "cachedCapabilities", "claudePath", "ghPath", "gitPath", "locale", "openWindows", "recentProjects", "ui"].sort());
  });

  it("drops wrong types and out-of-range values", () => {
    const { patch, rejected } = sanitizeSettingsPatch({
      appearance: "neon",
      budgetMaxFiles: 0,
      budgetMaxLines: 1.5,
      autoAllowBash: "true",
      ghHost: "evil.com; rm -rf /",
      commitTrailer: "a\nb",
      permissionMode: "bypassPermissions!",
      worktreeRoot: "relative/dir",
      disabledPlugins: [1],
      extensionsInitTimeoutMs: -1,
    });
    expect(patch).toEqual({});
    expect(rejected).toHaveLength(10);
  });

  it("keeps the §33 permission switches only as booleans", () => {
    const ok = sanitizeSettingsPatch({ allowWorktreeIsolation: true, applyUserAllowRules: false, persistSessionAllows: true, applyUserBashRules: false });
    expect(ok.patch).toEqual({ allowWorktreeIsolation: true, applyUserAllowRules: false, persistSessionAllows: true, applyUserBashRules: false });
    expect(ok.rejected).toEqual([]);
    const bad = sanitizeSettingsPatch({ allowWorktreeIsolation: "yes", applyUserAllowRules: 1, persistSessionAllows: null });
    expect(bad.patch).toEqual({});
    expect(bad.rejected).toHaveLength(3);
  });

  it("refuses non plain objects", () => {
    expect(sanitizeSettingsPatch(null).patch).toEqual({});
    expect(sanitizeSettingsPatch([1]).patch).toEqual({});
    expect(sanitizeSettingsPatch(Object.create({ appearance: "dark" })).patch).toEqual({});
  });

  it("accepts the three §29 peer modes and nothing else", () => {
    for (const mode of ["ask", "auto", "off"]) expect(sanitizeSettingsPatch({ peerInbound: mode }).patch).toEqual({ peerInbound: mode });
    expect(sanitizeSettingsPatch({ peerInbound: "always" }).rejected).toEqual(["peerInbound"]);
    expect(sanitizeSettingsPatch({ peerInbound: true }).rejected).toEqual(["peerInbound"]);
  });
});

describe("validateExecutable", () => {
  const fs = (files: Record<string, { exec: boolean }>) => ({
    isFile: (p: string) => p in files,
    isExecutable: (p: string) => files[p]?.exec === true,
  });

  it("accepts an existing executable named like the tool", () => {
    expect(validateExecutable("/opt/homebrew/bin/claude", "claude", "darwin", fs({ "/opt/homebrew/bin/claude": { exec: true } }))).toBeNull();
    expect(validateExecutable("C:\\Users\\a b\\AppData\\Roaming\\npm\\claude.cmd", "claude", "win32", fs({ "C:\\Users\\a b\\AppData\\Roaming\\npm\\claude.cmd": { exec: false } }))).toBeNull();
    expect(validateExecutable("C:\\Program Files\\Git\\cmd\\git.exe", "git", "win32", fs({ "C:\\Program Files\\Git\\cmd\\git.exe": { exec: false } }))).toBeNull();
  });

  it("refuses relative, missing, non-executable or misnamed files", () => {
    const files = fs({ "/bin/sh": { exec: true }, "/tmp/claude": { exec: false } });
    expect(validateExecutable("claude", "claude", "darwin", files)).toMatch(/absolute/);
    expect(validateExecutable("/usr/local/bin/claude", "claude", "darwin", files)).toMatch(/no such file/);
    expect(validateExecutable("/tmp/claude", "claude", "darwin", files)).toMatch(/not executable/);
    expect(validateExecutable("/bin/sh", "claude", "darwin", files)).toMatch(/named/);
    expect(validateExecutable("C:\\Windows\\System32\\cmd.exe", "gh", "win32", fs({ "C:\\Windows\\System32\\cmd.exe": { exec: true } }))).toMatch(/named/);
    expect(validateExecutable("C:\\x\\gh.cmd", "gh", "win32", fs({ "C:\\x\\gh.cmd": { exec: true } }))).toMatch(/named/);
    expect(validateExecutable(42, "git", "darwin", files)).toMatch(/not a path/);
  });
});
