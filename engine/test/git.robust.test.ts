import { chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LfsMissingError, openCheckpoint } from "../src/git/checkpoint.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
const unlock: string[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const p of unlock.splice(0)) chmodSync(p, 0o644);
  for (const d of dirs.splice(0)) removeDir(d);
});

/** chmod 000 — what a root-owned Docker log looks like to the user (no effect as root / on Windows). */
function unreadable(p: string): void {
  chmodSync(p, 0o000);
  unlock.push(p);
}
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

function makeRepo(): string {
  const dir = track(realpathSync(makeTempDir("rg-robust")));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "one\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

describe("one odd file never fails the whole snapshot (robustness-09, §32)", () => {
  it.skipIf(!canLock)("an unreadable untracked file is left out and reported; the rest is snapshotted", async () => {
    const dir = makeRepo();
    write(dir, "logs/app.log", "root-owned log\n");
    unreadable(join(dir, "logs/app.log"));
    write(dir, "b.txt", "b\n");
    const cp = await openCheckpoint(dir);
    const { tree, skipped } = await cp.snapshotDetailed();
    expect(skipped).toEqual([{ path: "logs/app.log", reason: "unreadable" }]);
    const names = sh(dir, "ls-tree", "-r", "--name-only", tree).trim().split("\n");
    expect(names).toEqual(["a.txt", "b.txt"]);
  });

  it.skipIf(!canLock)("an unreadable tracked file keeps its index version", async () => {
    const dir = makeRepo();
    write(dir, "a.txt", "one\nchanged\n");
    unreadable(join(dir, "a.txt"));
    const cp = await openCheckpoint(dir);
    const { tree, skipped } = await cp.snapshotDetailed();
    expect(skipped).toEqual([{ path: "a.txt", reason: "unreadable" }]);
    expect(sh(dir, "show", `${tree}:a.txt`)).toBe("one\n");
  });

  it("a new file outside the sparse-checkout definition is added (--sparse) instead of failing", async () => {
    const dir = makeRepo();
    write(dir, "in/x.txt", "x\n");
    write(dir, "out/y.txt", "y\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "two");
    sh(dir, "sparse-checkout", "set", "--no-cone", "in");
    write(dir, "out/new.txt", "new\n");
    const cp = await openCheckpoint(dir);
    const { tree, skipped } = await cp.snapshotDetailed();
    expect(skipped).toEqual([]);
    expect(sh(dir, "ls-tree", "-r", "--name-only", tree).trim().split("\n")).toEqual(["a.txt", "in/x.txt", "out/new.txt", "out/y.txt"]);
  });

  it("a repository that needs git-lfs, without git-lfs: a clear error instead of git's", async () => {
    const dir = makeRepo();
    write(dir, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    sh(dir, "add", ".gitattributes");
    sh(dir, "commit", "-qm", "attrs");
    sh(dir, "config", "filter.lfs.required", "true");
    sh(dir, "config", "filter.lfs.process", "git-lfs-not-installed-here filter-process");
    sh(dir, "config", "filter.lfs.clean", "git-lfs-not-installed-here clean -- %f");
    write(dir, "model.bin", Buffer.alloc(64, 7));
    const cp = await openCheckpoint(dir);
    const e = await cp.snapshot().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LfsMissingError);
    expect(String((e as Error).message)).toMatch(/git-lfs/);
  });

  it.skipIf(!canLock)("engine: the turn is collected anyway, the skipped file is in gate.snapshotSkipped", async () => {
    const dir = makeRepo();
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "run the app" });
    write(dir, "a.txt", "one\ntwo\n");
    write(dir, "logs/app.log", "written by a container as root\n");
    unreadable(join(dir, "logs/app.log"));
    h.session().emitTurnEnd({ toolFiles: [{ path: join(dir, "a.txt"), tools: ["Edit"], count: 1, toolUseIds: ["e1"] }] });
    const s = await h.waitFor((x) => x.gate.turnEndTree !== null && x.gate.phase !== "collecting", "collected");
    expect(s.gate.phase).toBe("reviewing");
    expect(s.gate.collectError).toBeNull();
    expect(s.changedFiles.map((f) => f.path)).toEqual(["a.txt"]);
    expect(s.gate.snapshotSkipped).toEqual([{ path: "logs/app.log", reason: "unreadable" }]);
  });

  it.skipIf(!canLock)("engine: a file that became unreadable during the turn shows, but is never reverted (not_captured)", async () => {
    const dir = makeRepo();
    write(dir, "cache/state.txt", "readable at the start\n");
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "run it" });
    unreadable(join(dir, "cache/state.txt"));
    h.session().emitTurnEnd();
    const s = await h.waitFor((x) => x.gate.turnEndTree !== null && x.gate.phase !== "collecting", "collected");
    expect(s.changedFiles.map((f) => [f.path, f.status, f.uncaptured])).toEqual([["cache/state.txt", "D", true]]);
    await expect(h.engine.request({ type: "reject", paths: ["cache/state.txt"], force: true })).rejects.toThrow("not_captured:cache/state.txt");
  });
});
