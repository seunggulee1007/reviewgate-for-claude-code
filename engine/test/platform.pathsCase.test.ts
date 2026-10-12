import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInside, realpathLenient, toRepoRelative } from "../src/platform/paths.js";
import { isOutsideRoot } from "../src/session/hooks.js";
import { nestedRepoRoot } from "../src/session/reviewScope.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §35.10: on a case-insensitive file system (macOS by default) a path spelled in another case is the same
 * file — git reports the on-disk spelling (`rev-parse --show-toplevel` of `cd /users/me/code/proj` is
 * `/Users/me/Code/proj`). The real path now uses the on-disk spelling there too (as on Windows), so a project opened
 * as `/users/me/code/proj` no longer puts every edit inside it on an "outside the project" card nor attributes it to
 * no one. A case-sensitive volume keeps the two spellings apart.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

/** `p` with its last component's letters swapped in case (`Proj-Abc` → `pROJ-aBC`). */
function otherCase(p: string): string {
  const i = p.lastIndexOf("/");
  const last = p.slice(i + 1).replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
  return p.slice(0, i + 1) + last;
}

describe("another spelling of the same path on a case-insensitive file system (§35.10)", () => {
  it.skipIf(process.platform !== "darwin")("is inside the project, relative path in the on-disk spelling", () => {
    const base = realpathSync(makeTempDir("rg-case"));
    dirs.push(base);
    const root = join(base, "Proj-Case");
    mkdirSync(join(root, "Src"), { recursive: true });
    writeFileSync(join(root, "Src", "Main.java"), "class Main {}\n");
    const spelled = otherCase(root);
    if (!existsSync(spelled)) return; // a case-sensitive volume: two different paths, nothing to compare
    expect(realpathLenient(spelled)).toBe(root);
    expect(realpathLenient(join(spelled, "src", "main.java"))).toBe(join(root, "Src", "Main.java"));
    expect(isInside(join(spelled, "Src", "Main.java"), root)).toBe(true);
    expect(isInside(join(root, "Src", "Main.java"), spelled)).toBe(true);
    expect(toRepoRelative(join(spelled, "src", "main.java"), root)).toBe("Src/Main.java");
    // A file that does not exist yet keeps its own spelling below the nearest existing folder.
    expect(toRepoRelative(join(spelled, "Src", "NewFile.java"), root)).toBe("Src/NewFile.java");
    expect(isInside(join(base, "Proj-Case-other", "x"), root)).toBe(false);
    // What the edit hook decides with: an edit in the project spelled the other way is no "outside the project" card.
    expect(isOutsideRoot(join(spelled, "Src", "Main.java"), root)).toBe(false);
    expect(nestedRepoRoot(join(spelled, "Src", "Main.java"), root)).toBeNull();
  });
});
