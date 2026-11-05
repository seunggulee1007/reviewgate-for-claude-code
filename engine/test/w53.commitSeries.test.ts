import { chmodSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { FakeSide, type SideScript } from "./helpers/fakeSide.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §53: commits in meaningful units — the accepted changes split into several commits, down to hunks. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function setup(script: SideScript = () => ({ text: "" })) {
  const sides: FakeSide[] = [];
  const h = makeHarness({ sideQueryFactory: (o) => {
    const f = new FakeSide(o, script);
    sides.push(f);
    return f;
  } });
  harnesses.push(h);
  return { h, sides };
}

/** Twenty numbered lines: an edit near the top and one near the bottom are two hunks. */
const LINES = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
const text = (lines: readonly string[]) => lines.join("\n") + "\n";
const edited = (edits: Record<number, string>) => text(LINES.map((l, i) => edits[i + 1] ?? l));

/** `main` with app.ts (20 lines), single.txt, gone.txt, tomove.txt and a binary committed. */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-series"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "app.ts", text(LINES));
  write(dir, "single.txt", "one\ntwo\n");
  write(dir, "gone.txt", "bye\n");
  write(dir, "tomove.txt", "move me\n");
  write(dir, "pic.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

/** One turn of Claude's: `mutate()` runs while it is open; resolves once the review is collected. */
async function turn(h: Harness, mutate: () => void, words = "do it"): Promise<void> {
  await h.engine.handle({ type: "send", text: words });
  h.session().emitSessionInfo();
  mutate();
  h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-1" });
  await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
  await h.settle();
}

/** app.ts edited at lines 2 and 18 (two hunks) + every other kind of change; all accepted. */
async function everyKind(h: Harness, dir: string): Promise<void> {
  await turn(h, () => {
    write(dir, "app.ts", edited({ 2: "L2", 18: "L18" }));
    write(dir, "single.txt", "one\nTWO\n");
    write(dir, "new.txt", "new\n");
    rmSync(join(dir, "gone.txt"));
    renameSync(join(dir, "tomove.txt"), join(dir, "moved.txt"));
    write(dir, "pic.bin", Buffer.from([0, 1, 2, 3, 0, 254]));
  });
  await h.engine.request({ type: "accept_all" });
}

describe("§53 commit_hunks", () => {
  it("lists the accepted files as hunks of git diff HEAD; only a modified text file with two hunks or more can be split", async () => {
    const dir = makeRepo();
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    await everyKind(h, dir);
    const reply = await h.engine.request({ type: "commit_hunks" });
    expect(reply.type).toBe("commit_hunks");
    const byPath = new Map(reply.files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(["app.ts", "gone.txt", "moved.txt", "new.txt", "pic.bin", "single.txt"]);
    expect(byPath.get("app.ts")).toEqual({
      path: "app.ts", status: "M", binary: false,
      hunks: [
        { id: 0, header: "@@ -1,5 +1,5 @@", added: 1, deleted: 1, text: " l1\n-l2\n+L2\n l3\n l4\n l5" },
        { id: 1, header: "@@ -15,6 +15,6 @@ l14", added: 1, deleted: 1, text: " l15\n l16\n l17\n-l18\n+L18\n l19\n l20" },
      ],
    });
    // Whole only: one hunk, added, deleted, renamed, binary.
    expect(byPath.get("single.txt")).toEqual({ path: "single.txt", status: "M", binary: false, hunks: [] });
    expect(byPath.get("new.txt")).toMatchObject({ status: "A", hunks: [] });
    expect(byPath.get("gone.txt")).toMatchObject({ status: "D", hunks: [] });
    expect(byPath.get("moved.txt")).toMatchObject({ status: "R", oldPath: "tomove.txt", hunks: [] });
    expect(byPath.get("pic.bin")).toMatchObject({ binary: true, hunks: [] });
    // `paths` as `commit`: a subset, else nothing_to_commit.
    const one = await h.engine.request({ type: "commit_hunks", paths: ["app.ts"] });
    expect(one.files.map((f) => f.path)).toEqual(["app.ts"]);
    await expect(h.engine.request({ type: "commit_hunks", paths: [] })).rejects.toThrow("nothing_to_commit");
    await expect(h.engine.request({ type: "commit_hunks", paths: ["app.ts", "nope.txt"] })).rejects.toThrow("nothing_to_commit");
  });

  it("hunks are HEAD → worktree (the user's own edit before the turn included); a pending file is not listed, a mode change is not split", async () => {
    const dir = makeRepo();
    write(dir, "app.ts", edited({ 10: "mine" })); // the user's uncommitted edit
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    await turn(h, () => {
      write(dir, "app.ts", edited({ 2: "L2", 10: "mine", 18: "L18" }));
      write(dir, "single.txt", "one\ntwo\nthree\n");
    });
    await h.engine.request({ type: "accept", paths: ["app.ts"] });
    const reply = await h.engine.request({ type: "commit_hunks" });
    expect(reply.files.map((f) => f.path)).toEqual(["app.ts"]);
    expect(reply.files[0]!.hunks.map((x) => x.header)).toEqual(["@@ -1,5 +1,5 @@", "@@ -7,7 +7,7 @@ l6", "@@ -15,6 +15,6 @@ l14"]);
    expect(reply.files[0]!.hunks[1]!.text).toContain("+mine");
    await expect(h.engine.request({ type: "commit_hunks", paths: ["single.txt"] })).rejects.toThrow("nothing_to_commit");
    // An executable bit on top of two hunks: whole.
    chmodSync(join(dir, "app.ts"), 0o755);
    const modeOnly = await h.engine.request({ type: "commit_hunks", paths: ["app.ts"] });
    expect(modeOnly.files[0]!.hunks).toEqual([]);
  });
});
