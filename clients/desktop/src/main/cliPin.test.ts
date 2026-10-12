/**
 * MARK: wave3 desktop-session — §36.8 pinning a CLI version in main: the renderer names a version, never a path; main
 * builds `~/.local/share/claude/versions/<ver>` itself, checks the file and stores it as `claudePath`. A stored pin stays
 * valid at the next launch (validateExecutable accepts the native installer's version files for claude only).
 */
import { describe, expect, it } from "vitest";
import { claudeVersionsDir, isClaudeVersionPath, pinnedVersionPath } from "./cliPin.js";
import { validateExecutable } from "./settingsGuard.js";

const fsWith = (files: Record<string, { exec?: boolean }>) => ({
  isFile: (p: string) => p in files,
  isExecutable: (p: string) => files[p]?.exec !== false,
});

describe("CLI version pin (§36.8)", () => {
  it("the versions folder of the native installer", () => {
    expect(claudeVersionsDir("/Users/me", "darwin")).toBe("/Users/me/.local/share/claude/versions");
    expect(claudeVersionsDir("C:\\Users\\me", "win32")).toBe("C:\\Users\\me\\.local\\share\\claude\\versions");
  });

  it("recognises a version file there — nothing else", () => {
    expect(isClaudeVersionPath("/Users/me/.local/share/claude/versions/2.1.308", "/Users/me", "darwin")).toBe(true);
    expect(isClaudeVersionPath("/Users/me/.local/share/claude/versions/2.1.308-beta.1", "/Users/me", "darwin")).toBe(true);
    expect(isClaudeVersionPath("/Users/me/.local/share/claude/versions/evil", "/Users/me", "darwin")).toBe(false);
    expect(isClaudeVersionPath("/Users/me/.local/share/claude/versions/../../bin/2.1.308", "/Users/me", "darwin")).toBe(false);
    expect(isClaudeVersionPath("/tmp/versions/2.1.308", "/Users/me", "darwin")).toBe(false);
    expect(isClaudeVersionPath("/Users/other/.local/share/claude/versions/2.1.308", "/Users/me", "darwin")).toBe(false);
    expect(isClaudeVersionPath("C:\\Users\\me\\.local\\share\\claude\\versions\\2.1.308.exe", "C:\\Users\\me", "win32")).toBe(true);
    expect(isClaudeVersionPath("c:\\users\\ME\\.local\\share\\claude\\versions\\2.1.308", "C:\\Users\\me", "win32")).toBe(true);
  });

  it("builds the path from a version only, and checks the file", () => {
    const dir = "/Users/me/.local/share/claude/versions";
    const fs = fsWith({ [`${dir}/2.1.307`]: {}, [`${dir}/2.1.306`]: { exec: false } });
    expect(pinnedVersionPath("2.1.307", "/Users/me", "darwin", fs)).toEqual({ path: `${dir}/2.1.307` });
    expect(pinnedVersionPath("2.1.306", "/Users/me", "darwin", fs)).toEqual({ error: "not executable" });
    expect(pinnedVersionPath("2.1.300", "/Users/me", "darwin", fs)).toEqual({ error: "no such version" });
    expect(pinnedVersionPath("../../bin/sh", "/Users/me", "darwin", fs)).toEqual({ error: "not a version" });
    expect(pinnedVersionPath(42, "/Users/me", "darwin", fs)).toEqual({ error: "not a version" });
    const win = "C:\\Users\\me\\.local\\share\\claude\\versions";
    expect(pinnedVersionPath("2.1.307", "C:\\Users\\me", "win32", fsWith({ [`${win}\\2.1.307.exe`]: {} }))).toEqual({ path: `${win}\\2.1.307.exe` });
  });

  it("a stored pin stays valid at the next launch; other names still have to be claude", () => {
    const fs = fsWith({ "/Users/me/.local/share/claude/versions/2.1.307": {}, "/usr/local/bin/notclaude": {} });
    expect(validateExecutable("/Users/me/.local/share/claude/versions/2.1.307", "claude", "darwin", fs, "/Users/me")).toBeNull();
    expect(validateExecutable("/usr/local/bin/notclaude", "claude", "darwin", fs, "/Users/me")).toMatch(/must be named claude/);
    // gh / git never take a version file
    expect(validateExecutable("/Users/me/.local/share/claude/versions/2.1.307", "gh", "darwin", fs, "/Users/me")).toMatch(/must be named gh/);
  });
});
