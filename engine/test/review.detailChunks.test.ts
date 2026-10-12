import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCheckpoint } from "../src/git/checkpoint.js";
import { whitespaceOnlyPaths, WS_SPEC_CHARS_MAX } from "../src/review/detail.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §37.9: `whitespaceOnly` (§34.7) diffs up to 300 candidates with one `:(literal)<path>` pathspec each
 * (both names of a rename) on one command line. On Windows a command line holds 32 767 characters: a review of a few
 * hundred long Java paths — a package move is 300 renames, 600 pathspecs — failed to spawn and every file silently lost
 * the flag. The pathspecs now go in calls of at most `WS_SPEC_CHARS_MAX` characters (a rename's two names together).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function repo(): string {
  const dir = makeTempDir("rg-detailchunks");
  dirs.push(dir);
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "T");
  sh(dir, "config", "core.autocrlf", "false");
  return dir;
}

const tree = (dir: string) => {
  sh(dir, "add", "-A");
  return sh(dir, "write-tree").trim();
};

describe("whitespaceOnly pathspecs fit a Windows command line (§37.9)", () => {
  it("a small budget splits the pathspecs into several calls — a rename's two names together — with the same result", async () => {
    const dir = repo();
    const pkg = "acme-settlement/src/main/java/com/example/acme/settlement/service";
    for (let i = 0; i < 12; i++) write(dir, `${pkg}/Service${i}.java`, `class S${i} {\n  int a = ${i};\n  int b = ${i};\n}\n`);
    const a = tree(dir);
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 0) {
        // whitespace only
        write(dir, `${pkg}/Service${i}.java`, `class S${i} {\n    int a = ${i};\n  int b = ${i};\n}\n`);
      } else if (i % 3 === 1) {
        // a real change
        write(dir, `${pkg}/Service${i}.java`, `class S${i} {\n  int a = ${i + 100};\n  int b = ${i};\n}\n`);
      } else {
        // a rename (the package moved) with an indentation change
        rmSync(join(dir, `${pkg}/Service${i}.java`));
        write(dir, `${pkg}/moved/Service${i}.java`, `class S${i} {\n  int a = ${i};\n    int b = ${i};\n}\n`);
      }
    }
    const b = tree(dir);
    const cp = new GitCheckpoint(dir);
    const files = await cp.changes(a, b);
    expect(files.filter((f) => f.status === "R")).toHaveLength(4);
    const whole = await whitespaceOnlyPaths(cp, a, b, files);
    expect([...whole].sort()).toEqual([0, 3, 6, 9].map((i) => `${pkg}/Service${i}.java`).concat([2, 5, 8, 11].map((i) => `${pkg}/moved/Service${i}.java`)).sort());

    const calls: string[][] = [];
    const real = cp.git.bind(cp);
    cp.git = (args, opts) => {
      calls.push(args);
      return real(args, opts);
    };
    const budget = 400;
    const split = await whitespaceOnlyPaths(cp, a, b, files, budget);
    expect([...split].sort()).toEqual([...whole].sort());
    expect(calls.length).toBeGreaterThan(1);
    for (const args of calls) {
      const specs = args.slice(args.indexOf("--") + 1);
      expect(specs.reduce((n, s) => n + s.length + 1, 0)).toBeLessThanOrEqual(budget);
      // A rename's two names are in the same call (else git sees a delete and an add).
      for (const i of [2, 5, 8, 11]) {
        const both = specs.filter((s) => s.endsWith(`/Service${i}.java`));
        expect(both.length === 0 || both.length === 2).toBe(true);
      }
    }
  });

  it("the default budget stays well inside Windows' 32 767-character command line", () => {
    expect(WS_SPEC_CHARS_MAX).toBeLessThanOrEqual(24_000);
  });
});
