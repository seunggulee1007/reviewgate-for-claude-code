import { mkdirSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCheckpoint } from "../src/git/checkpoint.js";
import { DEFAULT_LARGE_FILE_MB, largeFileBytes, setLargeFileLimit } from "../src/git/largeFiles.js";
import type { ReviewHistoryEntry } from "../src/protocol.js";
import { applyCleanup, planCleanup } from "../src/review/cleanup.js";
import { saveCheckpoints, newRecord } from "../src/review/checkpoints.js";
import { REVIEW_FILE } from "../src/review/persist.js";
import { diskLevel, SaveHealth } from "../src/review/storage.js";
import type { ToolFileEntry } from "../src/session/events.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/**
 * MARK: wave4b w4b-bigturn — docs/PROTOCOL.md §39.1 (robustness-10, robustness-11): big turns and a full disk.
 * A large untracked file is a stub in every snapshot (shown, never stored / reverted / committed); a failed save is
 * `state.storage.saveFailed` until `retry_save` succeeds; `history_cleanup` deletes only the app's refs; `reject_all` of
 * many files reverts them at once with one snapshot.
 */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-big"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "readme\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
  setLargeFileLimit(largeFileBytes(DEFAULT_LARGE_FILE_MB));
});

const edit = (dir: string, rel: string, id: string): ToolFileEntry => ({ path: join(dir, rel), tools: ["Write"], count: 1, toolUseIds: [id] });

async function turn(mutate: (dir: string) => void, toolFiles: (dir: string) => ToolFileEntry[], opts: { before?: (dir: string) => void; largeFileMB?: number } = {}): Promise<{ h: Harness; dir: string }> {
  const dir = makeRepo();
  dirs.push(dir);
  opts.before?.(dir);
  const h = makeHarness();
  harnesses.push(h);
  await h.hello(opts.largeFileMB !== undefined ? { largeFileMB: opts.largeFileMB } : {});
  await h.open(dir);
  await h.engine.request({ type: "send", text: "work" });
  mutate(dir);
  h.session().emitTurnEnd({ toolFiles: toolFiles(dir) });
  await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing", 60_000);
  return { h, dir };
}

describe("large untracked files are stubs (§39.1, robustness-11 ①)", () => {
  it("an untracked file over largeFileMB is listed tooLarge + uncaptured with its size, and its content never reaches the object store", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 7, 0x61); // 2 MiB of 'a' — over a 1 MB limit
    const { h, dir } = await turn((d) => {
      writeFileSync(join(d, "heap.hprof"), big);
      write(d, "src/Small.java", "class Small {}\n");
    }, (d) => [edit(d, "src/Small.java", "w1"), edit(d, "heap.hprof", "w2")], { largeFileMB: 1 });
    const s = h.engine.state;
    const hprof = s.changedFiles.find((f) => f.path === "heap.hprof");
    expect(hprof).toMatchObject({ status: "A", tooLarge: true, uncaptured: true, largeBytes: big.length });
    expect(s.changedFiles.find((f) => f.path === "src/Small.java")?.tooLarge).toBeUndefined();
    // The real content's blob was never written: hash it without -w and look it up.
    const sha = sh(dir, "hash-object", "heap.hprof").trim();
    expect(() => sh(dir, "cat-file", "-e", sha)).toThrow();
    // Never reverted: reject_all leaves it pending (§35.2 skipped) and reverts the rest.
    const res = await h.engine.request({ type: "reject_all" });
    expect(res).toMatchObject({ ok: true, skipped: [{ path: "heap.hprof", code: "not_captured" }] });
    expect(statSync(join(dir, "heap.hprof")).size).toBe(big.length);
    expect(read(dir, "src/Small.java")).toBeNull();
  });

  it("a tracked file is captured whatever its size", async () => {
    const { h } = await turn((d) => writeFileSync(join(d, "data.bin"), Buffer.alloc(2 * 1024 * 1024, 0x62)), () => [], {
      largeFileMB: 1,
      before: (d) => {
        writeFileSync(join(d, "data.bin"), Buffer.alloc(2 * 1024 * 1024, 0x63));
        sh(d, "add", "data.bin");
        sh(d, "commit", "-qm", "data");
      },
    });
    const f = h.engine.state.changedFiles.find((x) => x.path === "data.bin");
    expect(f).toBeDefined();
    expect(f!.tooLarge).toBeUndefined();
    expect(f!.uncaptured).toBeUndefined();
  });

  it("largeFileBytes: out-of-range values fall back to 50 MB", () => {
    expect(largeFileBytes(undefined)).toBe(50 * 1024 * 1024);
    expect(largeFileBytes(0)).toBe(50 * 1024 * 1024);
    expect(largeFileBytes(200)).toBe(200 * 1024 * 1024);
    expect(largeFileBytes("x")).toBe(50 * 1024 * 1024);
  });
});

describe("failed saves are state, not only a log line (§39.1, robustness-11 ③)", () => {
  it("a review file that cannot be written shows in state.storage.saveFailed once; retry_save clears it after the cause is gone", async () => {
    const { h, dir } = await turn((d) => write(d, "a.txt", "a\n"), (d) => [edit(d, "a.txt", "w1")], {
      before: (d) => {
        // A non-empty directory where the review file goes: the atomic rename over it fails (EISDIR / ENOTEMPTY …).
        mkdirSync(join(d, ".git", REVIEW_FILE, "x"), { recursive: true });
      },
    });
    const failed = await h.waitFor((s) => (s.storage?.saveFailed?.what ?? []).includes("review"), "save failure");
    const f = failed.storage!.saveFailed!;
    expect(f.diskFull).toBe(false);
    expect(typeof f.since).toBe("string");
    const since = f.since;
    // Another failed save of the same kind keeps `since` (one banner).
    await h.engine.request({ type: "accept", paths: ["a.txt"] }).catch(() => undefined);
    await h.settle();
    expect(h.engine.state.storage?.saveFailed?.since ?? since).toBe(since);
    await expect(h.engine.request({ type: "retry_save" })).rejects.toThrow(/save_failed/);
    rmSync(join(dir, ".git", REVIEW_FILE), { recursive: true, force: true });
    await h.engine.request({ type: "retry_save" });
    expect(h.engine.state.storage?.saveFailed).toBeNull();
  });

  it("state.storage.disk carries the project volume's free space", async () => {
    const { h } = await turn((d) => write(d, "a.txt", "a\n"), (d) => [edit(d, "a.txt", "w1")]);
    const s = await h.waitFor((x) => x.storage?.disk != null, "disk reading");
    expect(s.storage!.disk!.freeBytes).toBeGreaterThan(0);
    expect(["ok", "low", "critical"]).toContain(s.storage!.disk!.level);
  });

  it("SaveHealth: one view per run of failures; a kind clears with its next good save; disk levels", () => {
    const sh = new SaveHealth();
    const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    expect(sh.fail("review", enospc, new Date("2026-10-23T10:00:00Z"))).toBe(true);
    expect(sh.fail("review", enospc, new Date("2026-10-23T10:01:00Z"))).toBe(false);
    expect(sh.fail("history", new Error("fatal: unable to write: No space left on device"), new Date("2026-10-23T10:02:00Z"))).toBe(true);
    expect(sh.view).toMatchObject({ what: ["history", "review"], code: "ENOSPC", diskFull: true, since: "2026-10-23T10:00:00.000Z" });
    expect(sh.ok("review")).toBe(true);
    expect(sh.ok("review")).toBe(false);
    expect(sh.view?.what).toEqual(["history"]);
    sh.ok("history");
    expect(sh.view).toBeNull();
    expect(diskLevel(5 * 1024 ** 3)).toBe("ok");
    expect(diskLevel(3 * 1024 ** 3)).toBe("ok");
    expect(diskLevel(1.5 * 1024 ** 3)).toBe("low");
    expect(diskLevel(0.4 * 1024 ** 3)).toBe("critical");
  });
});

describe("history_cleanup deletes only the app's refs (§39.1, robustness-11 ④)", () => {
  function entry(id: string, start: string, end: string): ReviewHistoryEntry {
    return { id, turnStartTree: start, turnEndTree: end, files: [] } as unknown as ReviewHistoryEntry;
  }

  function ageLooseObjects(dir: string): void {
    const objects = join(dir, ".git", "objects");
    const old = new Date(Date.now() - 3 * 3600_000);
    for (const sub of readdirSync(objects)) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      for (const f of readdirSync(join(objects, sub))) utimesSync(join(objects, sub, f), old, old);
    }
  }

  it("drops the rounds / checkpoint records beyond keep, their refs and their objects; branches, tags, stash and reflog stay", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    const cp = await openCheckpoint(dir);
    const gitDir = join(dir, ".git");
    // A user branch with its own commit, a tag, a stash.
    sh(dir, "switch", "-q", "-c", "feature");
    write(dir, "feature.txt", "feature only\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-qm", "feature");
    sh(dir, "tag", "v1");
    sh(dir, "switch", "-q", "main");
    write(dir, "README.md", "stashed edit\n");
    sh(dir, "stash", "push", "-q", "-m", "user stash");
    const stashBlob = sh(dir, "rev-parse", "stash@{0}:README.md").trim();
    const featureBlob = sh(dir, "rev-parse", "feature:feature.txt").trim();
    // Five rounds, each pinning a tree with a blob of its own.
    const history: ReviewHistoryEntry[] = [];
    const uniqueBlobs: string[] = [];
    for (let i = 0; i < 5; i++) {
      write(dir, `round-${i}.txt`, `round ${i} only\n`);
      const tree = await cp.snapshot();
      uniqueBlobs.push(sh(dir, "rev-parse", `${tree}:round-${i}.txt`).trim());
      rmSync(join(dir, `round-${i}.txt`));
      const id = `h${i}`;
      await cp.pinRef(`refs/reviewgate/main/history/${id}/start`, tree);
      await cp.pinRef(`refs/reviewgate/main/history/${id}/end`, tree);
      history.push(entry(id, tree, tree));
    }
    // A chat with four checkpoint records, pinned too; another namespace's ref (another worktree) stays.
    const records = [0, 1, 2, 3].map((i) => newRecord("turn", { startTree: history[i]!.turnStartTree, endTree: history[i]!.turnEndTree }));
    for (const r of records) await cp.pinRef(`refs/reviewgate/main/turns/${r.id}/start`, r.startTree!);
    saveCheckpoints(gitDir, "chat-1", { version: 1, records, pendingFork: null });
    await cp.pinRef("refs/reviewgate/wt-other/history/x/start", history[0]!.turnStartTree);
    const before = sh(dir, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags", "refs/stash").trim().split("\n").sort();
    const reflogBefore = sh(dir, "reflog", "show", "--format=%H", "HEAD").trim();

    const plan = await planCleanup({ cp, gitDir, ns: "main", history, keep: 2 });
    expect(plan.droppedHistory.map((e) => e.id)).toEqual(["h0", "h1", "h2"]);
    expect(plan.chats).toEqual([expect.objectContaining({ chatId: "chat-1", dropped: 2 })]);
    expect(plan.refs.every((r) => r.startsWith("refs/reviewgate/main/history/") || r.startsWith("refs/reviewgate/main/turns/"))).toBe(true);
    expect(plan.refs).toHaveLength(3 * 2 + 2);
    expect(plan.bytes).toBeGreaterThan(0);

    ageLooseObjects(dir);
    await applyCleanup(cp, gitDir, "main", plan);
    const left = sh(dir, "for-each-ref", "--format=%(refname)", "refs/reviewgate/").trim().split("\n").sort();
    expect(left).toEqual([
      "refs/reviewgate/main/history/h3/end",
      "refs/reviewgate/main/history/h3/start",
      "refs/reviewgate/main/history/h4/end",
      "refs/reviewgate/main/history/h4/start",
      `refs/reviewgate/main/turns/${records[2]!.id}/start`,
      `refs/reviewgate/main/turns/${records[3]!.id}/start`,
      "refs/reviewgate/wt-other/history/x/start",
    ].sort());
    // The user's refs, reflog and their objects are untouched.
    expect(sh(dir, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags", "refs/stash").trim().split("\n").sort()).toEqual(before);
    expect(sh(dir, "reflog", "show", "--format=%H", "HEAD").trim()).toBe(reflogBefore);
    expect(() => sh(dir, "cat-file", "-e", stashBlob)).not.toThrow();
    expect(() => sh(dir, "cat-file", "-e", featureBlob)).not.toThrow();
    // The dropped round h1's own blob is gone; h0's is still pinned by the other namespace, h2's by a kept checkpoint.
    expect(() => sh(dir, "cat-file", "-e", uniqueBlobs[0]!)).not.toThrow();
    expect(() => sh(dir, "cat-file", "-e", uniqueBlobs[1]!)).toThrow();
    expect(() => sh(dir, "cat-file", "-e", uniqueBlobs[2]!)).not.toThrow();
    expect(() => sh(dir, "cat-file", "-e", uniqueBlobs[3]!)).not.toThrow();
    expect(() => sh(dir, "cat-file", "-e", uniqueBlobs[4]!)).not.toThrow();
  });

  it("the engine command counts first (apply false) and keeps the review history it did not drop", async () => {
    const { h } = await turn((d) => write(d, "a.txt", "a\n"), (d) => [edit(d, "a.txt", "w1")]);
    const counted = await h.engine.request({ type: "history_cleanup" });
    expect(counted).toMatchObject({ type: "history_cleanup", applied: false, keep: 20, rounds: 0 });
    const applied = await h.engine.request({ type: "history_cleanup", keep: 5, apply: true });
    expect(applied).toMatchObject({ type: "history_cleanup", applied: true, keep: 5 });
    expect(h.engine.state.gate.phase).toBe("reviewing");
  });
});

describe("reject_all of many files reverts them at once (§39.1, robustness-10 ①)", () => {
  it("300 added + modified files: one batch, the list empties, the tree is back at A; the time is logged", async () => {
    const N = 300;
    const { h, dir } = await turn(
      (d) => {
        for (let i = 0; i < N / 2; i++) write(d, `gen/new-${i}.txt`, `new ${i}\n`);
        for (let i = 0; i < N / 2; i++) write(d, `mod/m-${i}.txt`, `changed ${i}\n`);
      },
      (d) => [...Array.from({ length: N / 2 }, (_, i) => edit(d, `gen/new-${i}.txt`, `n${i}`)), ...Array.from({ length: N / 2 }, (_, i) => edit(d, `mod/m-${i}.txt`, `m${i}`))],
      {
        before: (d) => {
          for (let i = 0; i < N / 2; i++) write(d, `mod/m-${i}.txt`, `original ${i}\n`);
          sh(d, "add", "-A");
          sh(d, "commit", "-qm", "mods");
        },
      },
    );
    expect(h.engine.state.changedFiles).toHaveLength(N);
    const t0 = Date.now();
    await h.engine.request({ type: "reject_all" });
    const ms = Date.now() - t0;
    console.log(`[bench] reject_all of ${N} files: ${ms} ms`);
    expect(h.engine.state.changedFiles).toHaveLength(0);
    expect(read(dir, "gen/new-0.txt")).toBeNull();
    expect(read(dir, `mod/m-${N / 2 - 1}.txt`)).toBe(`original ${N / 2 - 1}\n`);
    expect(sh(dir, "status", "--porcelain").trim()).toBe("");
  }, 120_000);

  it("the batch still refuses a file the user edited after the review (§35.9) — nothing is reverted", async () => {
    const N = 12;
    const { h, dir } = await turn(
      (d) => {
        for (let i = 0; i < N; i++) write(d, `m-${i}.txt`, `claude ${i}\n`);
      },
      (d) => Array.from({ length: N }, (_, i) => edit(d, `m-${i}.txt`, `e${i}`)),
      {
        before: (d) => {
          for (let i = 0; i < N; i++) write(d, `m-${i}.txt`, `original ${i}\n`);
          sh(d, "add", "-A");
          sh(d, "commit", "-qm", "base");
        },
      },
    );
    write(dir, "m-7.txt", "the user's own edit\n");
    await expect(h.engine.request({ type: "reject_all" })).rejects.toThrow(/file_changed_since_review/);
    expect(read(dir, "m-7.txt")).toBe("the user's own edit\n");
    expect(read(dir, "m-0.txt")).toBe("claude 0\n");
    expect(h.engine.state.changedFiles).toHaveLength(N);
    // A file already back at A (the user reverted it by hand) is no edit.
    write(dir, "m-7.txt", "original 7\n");
    await h.engine.request({ type: "reject_all" });
    expect(h.engine.state.changedFiles).toHaveLength(0);
    expect(read(dir, "m-0.txt")).toBe("original 0\n");
  }, 60_000);
});
