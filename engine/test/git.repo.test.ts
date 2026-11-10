import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGitCandidates, looksUnsafeForGitInit } from "../src/git/repo.js";
import { makeTempDir, removeDir } from "./helpers/repo.js";

const dirs: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("git repo helpers", () => {
  it("git candidates are immediate sub-repos sorted by name", () => {
    const root = track(makeTempDir("rg-cand"));
    for (const name of ["zeta-repo/.git", "alpha-repo/.git", "plain/src", "nested/inner/.git", ".hidden/.git"]) {
      mkdirSync(join(root, name), { recursive: true });
    }
    writeFileSync(join(root, "file.txt"), "x");

    expect(findGitCandidates(root).map((p) => basename(p))).toEqual(["alpha-repo", "zeta-repo"]);
    expect(findGitCandidates(root)[0]).toBe(join(root, "alpha-repo"));
    expect(findGitCandidates(join(root, "missing"))).toEqual([]);
  });

  it("git init looks unsafe for home and big folders", () => {
    const home = homedir();
    expect(looksUnsafeForGitInit(home)).toBe(true);
    expect(looksUnsafeForGitInit("/")).toBe(true);
    expect(looksUnsafeForGitInit(join(home, "Desktop"))).toBe(true);
    expect(looksUnsafeForGitInit(join(home, "Downloads/"))).toBe(true);

    const fakeHome = track(makeTempDir("rg-home"));
    mkdirSync(join(fakeHome, "Documents"), { recursive: true });
    expect(looksUnsafeForGitInit(join(fakeHome, "Documents"), fakeHome)).toBe(true);

    const small = join(fakeHome, "proj");
    mkdirSync(small, { recursive: true });
    expect(looksUnsafeForGitInit(small, fakeHome)).toBe(false);

    const big = join(fakeHome, "big");
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 201; i++) writeFileSync(join(big, `f${i}`), "");
    expect(looksUnsafeForGitInit(big, fakeHome)).toBe(true);
  });
});
