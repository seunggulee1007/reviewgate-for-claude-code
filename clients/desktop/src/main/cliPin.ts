/**
 * MARK: wave3 desktop-session
 * docs/PROTOCOL.md §36.8 in main, pure (no `electron`) and unit-tested: pinning a CLI version. The renderer names a
 * version (`rg:pinClaudeVersion`), never a path — main builds `<home>/.local/share/claude/versions/<ver>` (the native
 * installer's folder; on Windows under `%USERPROFILE%`), checks that it is an executable file and stores it as
 * `claudePath` (src/main/settingsGuard.ts accepts such a file for claude at the next launch). Unpinning is the existing
 * `rg:clearExecutable("claude")`.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** The home the native installer puts its versions under (`%USERPROFILE%` on Windows). */
export function claudeHome(platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? process.env.USERPROFILE : undefined) ?? homedir();
}

/** `2.1.308`, `2.1.308-beta.1` — no separators, no `..`. */
export const VERSION_NAME = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/;

const pathsFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The native installer's versions folder. */
export function claudeVersionsDir(home: string, platform: NodeJS.Platform): string {
  return pathsFor(platform).join(home, ".local", "share", "claude", "versions");
}

/** `path` is a version file of that folder (`<ver>`, on Windows also `<ver>.exe`). */
export function isClaudeVersionPath(path: string, home: string, platform: NodeJS.Platform): boolean {
  const p = pathsFor(platform);
  if (!p.isAbsolute(path)) return false;
  const file = p.normalize(path);
  const same = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(p.dirname(file), p.normalize(claudeVersionsDir(home, platform)))) return false;
  const name = p.basename(file);
  return VERSION_NAME.test(platform === "win32" ? name.replace(/\.exe$/i, "") : name);
}

type FsLike = { isFile(path: string): boolean; isExecutable(path: string): boolean };

const realFs: FsLike = {
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isExecutable: (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** The file to pin for `version`, or why there is none. */
export function pinnedVersionPath(version: unknown, home: string = claudeHome(), platform: NodeJS.Platform = process.platform, fs: FsLike = realFs): { path: string } | { error: string } {
  if (typeof version !== "string" || !VERSION_NAME.test(version)) return { error: "not a version" };
  const dir = claudeVersionsDir(home, platform);
  const p = pathsFor(platform);
  const candidates = platform === "win32" ? [p.join(dir, `${version}.exe`), p.join(dir, version)] : [p.join(dir, version)];
  const file = candidates.find((c) => fs.isFile(c));
  if (!file) return { error: "no such version" };
  if (platform !== "win32" && !fs.isExecutable(file)) return { error: "not executable" };
  return { path: file };
}
