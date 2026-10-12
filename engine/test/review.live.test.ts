import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { GitCheckpoint } from "../src/git/checkpoint.js";
import { LIVE_IDLE_REUSE_MS, LIVE_MAX_FILES, LIVE_REUSE_MS, liveChangesEvent, liveFileList, LiveView } from "../src/review/live.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

describe("LiveView reuse rules (§34.6)", () => {
  function view() {
    let t = 1_000_000;
    const v = new LiveView(() => t);
    let n = 0;
    const take = async () => `tree${++n}`;
    return { v, take, tick: (ms: number) => (t += ms), taken: () => n };
  }

  it("any tree is reused for 2 s; after that only one no writer could have changed", async () => {
    const { v, take, tick, taken } = view();
    expect((await v.liveTree(take)).tree).toBe("tree1");
    tick(LIVE_REUSE_MS);
    expect((await v.liveTree(take)).tree).toBe("tree1");
    // Idle and nothing started since: still the same worktree for up to 30 s.
    tick(LIVE_IDLE_REUSE_MS - LIVE_REUSE_MS);
    expect((await v.liveTree(take)).tree).toBe("tree1");
    tick(1);
    expect((await v.liveTree(take)).tree).toBe("tree2");
    expect(taken()).toBe(2);
  });

  it("a writer that starts makes the tree stale after 2 s; read-only tools never do", async () => {
    const { v, take, tick } = view();
    await v.liveTree(take);
    v.onToolUse("r1", "Read");
    v.onToolUse("g1", "Grep");
    v.onToolUse("a1", "Agent");
    tick(LIVE_REUSE_MS + 1);
    expect((await v.liveTree(take)).tree).toBe("tree1");
    v.onToolUse("e1", "Edit");
    v.onToolResult("e1");
    // tree1 is older than 2 s and an edit ran since: a new snapshot.
    expect((await v.liveTree(take)).tree).toBe("tree2");
    // Within 2 s of tree2 anything goes, even a running writer.
    v.onToolUse("e2", "Write");
    tick(LIVE_REUSE_MS);
    expect((await v.liveTree(take)).tree).toBe("tree2");
  });

  it("a tree taken while a writer runs is never reused beyond 2 s (the writer may still change files)", async () => {
    const { v, take, tick } = view();
    v.onToolUse("b1", "Bash");
    await v.liveTree(take);
    tick(LIVE_REUSE_MS + 1);
    v.onToolResult("b1");
    expect((await v.liveTree(take)).tree).toBe("tree2");
  });

  it("a post-Bash snapshot becomes the live tree for free, reusable while nothing writes", async () => {
    const { v, take, tick, taken } = view();
    v.onToolUse("e1", "Edit");
    v.onToolResult("e1");
    v.onToolUse("b1", "Bash");
    v.onBashSnapshot("b1", "bashTree");
    v.onToolResult("b1");
    tick(10_000);
    expect((await v.liveTree(take)).tree).toBe("bashTree");
    expect(taken()).toBe(0);
    v.onToolUse("m1", "mcp__ide__write");
    tick(LIVE_REUSE_MS + 1);
    v.onToolResult("m1");
    expect((await v.liveTree(take)).tree).toBe("tree1");
    expect(v.latestTree?.tree).toBe("tree1");
    v.reset();
    expect(v.latestTree).toBeNull();
  });

  it("hud.turnFiles: distinct repo files with a live cause, ignore patterns and outside files left out", () => {
    const v = new LiveView(() => 0);
    const root = "/tmp/rg-live-root";
    const n = v.turnFileCount(
      [
        { path: join(root, "a.ts"), tools: ["Edit"], count: 2, toolUseIds: ["e1", "e2"] },
        { path: join(root, "b.ts"), tools: ["Edit"], count: 1, toolUseIds: [] }, // its only edit failed
        { path: join(root, ".omc/state.json"), tools: ["Write"], count: 1, toolUseIds: ["w1"] },
        { path: join(root, ".claude/settings.json"), tools: ["Write"], count: 1, toolUseIds: ["w2"] }, // mods: never hidden
        { path: "/elsewhere/plan.md", tools: ["Write"], count: 1, toolUseIds: ["w3"] },
        { path: join(root, "c.ts"), tools: ["Bash"], count: 1, toolUseIds: ["b1"] },
      ],
      root,
      [".omc/", ".claude/"],
    );
    expect(n).toBe(3);
  });
});

describe("liveFileList / liveChangesEvent (§34.6)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) removeDir(d);
  });

  it("path order, ignore patterns applied, generated set, at most 200 files; inReview from the review's paths", async () => {
    const dir = makeTempDir("rg-live");
    dirs.push(dir);
    sh(dir, "init", "-q");
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "T");
    write(dir, "src/Svc.java", "class Svc {}\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "i");
    const cp = new GitCheckpoint(dir);
    const base = await cp.snapshot();
    write(dir, "src/Svc.java", "class Svc { int a; }\n");
    write(dir, "package-lock.json", "{}\n");
    write(dir, ".omc/x.json", "{}\n");
    for (let i = 0; i < LIVE_MAX_FILES; i++) write(dir, `gen/f${String(i).padStart(3, "0")}.txt`, `${i}\n`);
    const tree = await cp.snapshot();
    const list = await liveFileList(cp, base, tree, [".omc/"]);
    expect(list.truncated).toBe(true);
    expect(list.files).toHaveLength(LIVE_MAX_FILES);
    expect(list.files[0]!.path).toBe("gen/f000.txt");
    expect(list.files.some((f) => f.path.startsWith(".omc/"))).toBe(false);
    // `all` keeps every file beyond the 200 shown (live_diff looks them up there).
    expect(list.all).toHaveLength(LIVE_MAX_FILES + 2);
    const small = await liveFileList(cp, base, tree, [".omc/", "gen/"]);
    expect({ truncated: small.truncated, files: small.files }).toEqual({
      truncated: false,
      files: [
        { path: "package-lock.json", oldPath: null, status: "A", added: 1, deleted: 0, isBinary: false, inReview: false, generated: "lockfile" },
        { path: "src/Svc.java", oldPath: null, status: "M", added: 1, deleted: 1, isBinary: false, inReview: false },
      ],
    });
    const ev = liveChangesEvent({ running: true, turn: 5, base, live: { tree, at: Date.parse("2026-10-23T01:05:00.000Z") }, list: small, reviewPaths: new Set(["src/Svc.java"]), now: 0 });
    expect(ev).toEqual({
      type: "live_changes",
      running: true,
      turn: 5,
      baseTree: base,
      liveTree: tree,
      at: "2026-10-23T01:05:00.000Z",
      files: [
        { path: "package-lock.json", oldPath: null, status: "A", added: 1, deleted: 0, isBinary: false, inReview: false, generated: "lockfile" },
        { path: "src/Svc.java", oldPath: null, status: "M", added: 1, deleted: 1, isBinary: false, inReview: true },
      ],
    });
    expect(liveChangesEvent({ running: false, turn: null, base: null, live: null, list: null, reviewPaths: new Set(), now: 0 })).toEqual({
      type: "live_changes",
      running: false,
      turn: null,
      baseTree: null,
      liveTree: null,
      at: "1970-01-01T00:00:00.000Z",
      files: [],
    });
  });
});
