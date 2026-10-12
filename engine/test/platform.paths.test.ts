import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareKey,
  hasGitComponent,
  isInside,
  isInsidePath,
  parseAbs,
  realpathLenient,
  relativeInside,
  samePath,
  toNativeAbs,
  toRepoRelative,
} from "../src/platform/paths.js";
import { isGitInternalPath } from "../src/session/hooks.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

// The win32 rules are pure (path.win32 + explicit flavor), so macOS / Linux CI covers them too.
const W = "win32" as const;
const P = "posix" as const;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("toNativeAbs", () => {
  it("win32: git's C:/…, MSYS /c/… and lower-case drives become C:\\…; trailing separators dropped", () => {
    expect(toNativeAbs("C:/Users/x/repo", W)).toBe("C:\\Users\\x\\repo");
    expect(toNativeAbs("c:/Users/x/repo/", W)).toBe("C:\\Users\\x\\repo");
    expect(toNativeAbs("/c/Users/x/repo", W)).toBe("C:\\Users\\x\\repo");
    expect(toNativeAbs("/cygdrive/d/w", W)).toBe("D:\\w");
    expect(toNativeAbs("/c", W)).toBe("C:\\");
    expect(toNativeAbs("C:/", W)).toBe("C:\\");
    expect(toNativeAbs("\\\\?\\C:\\long\\path", W)).toBe("C:\\long\\path");
    expect(toNativeAbs("//server/share/repo", W)).toBe("\\\\server\\share\\repo");
    expect(toNativeAbs("C:/a/./b/../c", W)).toBe("C:\\a\\c");
  });

  it("posix: normalized, trailing slash dropped, root kept", () => {
    expect(toNativeAbs("/Users/x/repo/", P)).toBe("/Users/x/repo");
    expect(toNativeAbs("/", P)).toBe("/");
    expect(toNativeAbs("/c/Users", P)).toBe("/c/Users"); // MSYS form only means a drive on Windows
  });
});

describe("compare / containment (win32 rules)", () => {
  it("case, separators, namespace prefixes and trailing dots/spaces name the same path", () => {
    const k = compareKey("C:\\Users\\X\\Repo", W);
    for (const p of ["c:/users/x/repo", "C:\\Users\\X\\Repo\\", "\\\\?\\C:\\Users\\X\\Repo", "\\\\.\\c:\\users\\x\\repo", "\\??\\C:\\Users\\X\\Repo", "C:\\Users\\X\\Repo.", "C:\\Users\\X \\Repo  ", "C:\\Users\\X\\sub\\..\\Repo"]) {
      expect(compareKey(p, W), p).toBe(k);
    }
    expect(samePath("\\\\?\\UNC\\srv\\share\\a", "\\\\SRV\\Share\\A", W)).toBe(true);
    expect(samePath("C:\\a", "D:\\a", W)).toBe(false);
    // POSIX stays case-sensitive and exact.
    expect(samePath("/Users/x", "/users/x", P)).toBe(false);
    expect(samePath("/Users/x/", "/Users/x", P)).toBe(true);
  });

  it("isInsidePath: component-wise, never a mere string prefix; root and drive aware", () => {
    expect(isInsidePath("C:\\repo\\src\\a.ts", "C:\\repo", W)).toBe(true);
    expect(isInsidePath("c:/REPO/src/a.ts", "C:\\Repo\\", W)).toBe(true);
    expect(isInsidePath("C:\\repo", "C:\\repo", W)).toBe(true);
    expect(isInsidePath("C:\\repo-other\\a", "C:\\repo", W)).toBe(false);
    expect(isInsidePath("C:\\repox", "C:\\repo", W)).toBe(false);
    expect(isInsidePath("D:\\repo\\a", "C:\\repo", W)).toBe(false);
    expect(isInsidePath("C:\\repo\\..\\outside\\a", "C:\\repo", W)).toBe(false);
    expect(isInsidePath("C:\\repo\\.. \\outside\\a", "C:\\repo", W)).toBe(false); // ".. " is ".." on Windows
    expect(isInsidePath("\\\\?\\C:\\outside\\a", "C:\\repo", W)).toBe(false);
    expect(isInsidePath("\\\\?\\C:\\repo\\a", "C:\\repo", W)).toBe(true);
    expect(isInsidePath("C:\\a\\b", "C:\\", W)).toBe(true);
    expect(isInsidePath("/repo/src/a.ts", "/repo", P)).toBe(true);
    expect(isInsidePath("/repox/a", "/repo", P)).toBe(false);
    expect(isInsidePath("/Repo/a", "/repo", P)).toBe(false);
  });

  it("unsafe Windows names are never inside: alternate data streams, device names, device namespaces, relative roots", () => {
    for (const p of [
      "C:\\repo\\a.txt:hidden",
      "C:\\repo\\a.txt::$DATA",
      "C:\\repo\\src::$INDEX_ALLOCATION\\x.ts",
      "C:\\repo\\NUL",
      "C:\\repo\\sub\\com1.txt",
      "C:\\repo\\aux.ts",
      "C:\\repo\\CONIN$",
      "\\\\.\\pipe\\x",
      "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\repo\\a",
      "\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1\\repo\\a",
      "C:repo\\a",
      "\\repo\\a",
      "C:\\repo\\...\\a",
    ]) {
      expect(parseAbs(p, W).unsafe, p).toBe(true);
      expect(isInsidePath(p, "C:\\repo", W), p).toBe(false);
      expect(relativeInside(p, "C:\\repo", W), p).toBeNull();
    }
    // Lookalikes that are ordinary names.
    for (const p of ["C:\\repo\\console.ts", "C:\\repo\\nullable.ts", "C:\\repo\\com10", "C:\\repo\\a.txt"]) {
      expect(parseAbs(p, W).unsafe, p).toBe(false);
    }
    // allowUnsafe keeps deny lists strict: a stream of the git dir is still the git dir.
    expect(isInsidePath("C:\\sep\\gd::$INDEX_ALLOCATION\\hooks\\x", "C:\\sep\\gd", W, { allowUnsafe: true })).toBe(true);
    expect(isInsidePath("C:\\sep\\gd\\config:s", "C:\\sep\\gd", W, { allowUnsafe: true })).toBe(true);
    expect(isInsidePath("C:\\sep\\gdx\\config", "C:\\sep\\gd", W, { allowUnsafe: true })).toBe(false);
  });

  it("relativeInside: POSIX separators, the child's own case, null at the root itself or outside", () => {
    expect(relativeInside("C:\\Repo\\Src\\A.ts", "c:/repo", W)).toBe("Src/A.ts");
    expect(relativeInside("C:\\repo\\src\\a.ts. ", "C:\\repo", W)).toBe("src/a.ts");
    expect(relativeInside("C:\\repo", "C:\\repo", W)).toBeNull();
    expect(relativeInside("C:\\other\\a", "C:\\repo", W)).toBeNull();
    expect(relativeInside("/repo/src/a.ts", "/repo", P)).toBe("src/a.ts");
    expect(relativeInside("/repo", "/repo/", P)).toBeNull();
  });

  it("hasGitComponent: case-insensitive everywhere; win32 also trailing dots/spaces, streams and the 8.3 name", () => {
    for (const p of ["C:\\r\\.git\\hooks\\pre-commit", "C:\\r\\.GIT\\config", "C:\\r\\.git.\\config", "C:\\r\\.git \\config", "C:\\r\\.git::$INDEX_ALLOCATION\\hooks\\x", "C:\\r\\.git:stream", "C:\\r\\GIT~1\\hooks\\x", "c:/r/.Git/config", "C:\\r\\.git"]) {
      expect(hasGitComponent(p, W), p).toBe(true);
    }
    for (const p of ["C:\\r\\src\\a.git.ts", "C:\\r\\.github\\ci.yml", "C:\\r\\.gitignore", "C:\\r\\git\\x", "C:\\r\\.gitx\\y"]) {
      expect(hasGitComponent(p, W), p).toBe(false);
    }
    expect(hasGitComponent("/r/.git/config", P)).toBe(true);
    expect(hasGitComponent("/r/.GIT/config", P)).toBe(true);
    expect(hasGitComponent("/r\\.git\\config", P)).toBe(true); // both separators are split on everywhere
    expect(hasGitComponent("/r/.github/x", P)).toBe(false);
  });
});

describe("host wrappers (real filesystem)", () => {
  it("realpathLenient / isInside / toRepoRelative resolve symlinks and missing tails; native separators", () => {
    const base = realpathLenient(makeTempDir("rg-paths"));
    dirs.push(base);
    const root = join(base, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    expect(realpathLenient(join(root, "src", "new", "file.ts"))).toBe(join(root, "src", "new", "file.ts"));
    expect(realpathLenient(join(root, "src") + sep)).toBe(join(root, "src"));
    expect(isInside(join(root, "src", "a.ts"), root)).toBe(true);
    expect(isInside(join(root, "..", "elsewhere"), root)).toBe(false);
    expect(toRepoRelative(join(root, "src", "a.ts"), root)).toBe("src/a.ts");
    expect(toRepoRelative(root, root)).toBeNull();
    let linked = false;
    try {
      symlinkSync(base, join(root, "escape"), "dir");
      linked = true;
    } catch {
      // Windows without the symlink privilege: the lexical cases above still ran.
    }
    if (linked) {
      expect(isInside(join(root, "escape", "x.txt"), root)).toBe(false);
      expect(toRepoRelative(join(root, "escape", "repo", "src", "a.ts"), root)).toBe("src/a.ts");
    }
    if (process.platform === "win32") {
      // Case and separators do not matter on Windows; a stream or a device name is never inside.
      expect(isInside(join(root, "SRC", "a.ts").toUpperCase(), root)).toBe(true);
      expect(isInside(root.replace(/\\/g, "/") + "/src/a.ts", root)).toBe(true);
      expect(isInside(join(root, "src", "a.ts:hidden"), root)).toBe(false);
      expect(isInside(join(root, "NUL"), root)).toBe(false);
      expect(isGitInternalPath(join(root, ".GIT.", "hooks", "x"), [])).toBe(true);
      expect(isGitInternalPath(join(root, ".git::$INDEX_ALLOCATION", "hooks", "x"), [])).toBe(true);
    }
  });

  it("Windows 8.3 short names resolve to the long path (skipped where 8.3 names are not generated)", () => {
    if (process.platform !== "win32") return;
    const base = makeTempDir("rg-paths-long-directory-name");
    dirs.push(base);
    const long = join(base, "a-very-long-directory-name");
    mkdirSync(join(long, ".git"), { recursive: true });
    const shortParent = (() => {
      try {
        // `dir /x` would need cmd.exe; the 8.3 alias of a fresh dir is predictable when generation is on.
        const guess = join(base, "A-VERY~1");
        return realpathSync.native(guess) === realpathSync.native(long) ? guess : null;
      } catch {
        return null;
      }
    })();
    if (!shortParent) return; // 8.3 generation is disabled on this volume (common on CI's D:)
    expect(isInside(join(shortParent, "x.ts"), long)).toBe(true);
    expect(toRepoRelative(join(shortParent, "x.ts"), long)).toBe("x.ts");
    expect(isGitInternalPath(join(long, "GIT~1", "hooks", "pre-commit"), [])).toBe(true);
    expect(isGitInternalPath(join(shortParent, ".git", "hooks", "pre-commit"), [resolve(long, ".git")])).toBe(true);
  });
});
