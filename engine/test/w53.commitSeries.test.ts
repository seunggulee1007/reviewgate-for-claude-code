import { chmodSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
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

/** `git show --name-status` of one commit, tabs as spaces, sorted. */
const namesOf = (dir: string, rev: string): string[] => sh(dir, "show", "--name-status", "--format=", rev).trim().split("\n").filter(Boolean).map((l) => l.replace(/\t/g, " ")).sort();
const headSha = (dir: string): string => sh(dir, "rev-parse", "HEAD").trim();

/** Hooks in `.git/hooks`, whatever a global `core.hooksPath` says. */
function hook(dir: string, name: string, body: string): void {
  sh(dir, "config", "core.hooksPath", join(dir, ".git", "hooks"));
  write(dir, `.git/hooks/${name}`, `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, ".git", "hooks", name), 0o755);
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

describe("§53 commit_series", () => {
  it("splits one file's two hunks into two commits with whole files, a deletion and a rename; the worktree is untouched, the index follows HEAD; one push", async () => {
    const dir = makeRepo();
    const bare = realpathSync(makeTempDir("rg-series-origin"));
    dirs.push(bare);
    sh(bare, "init", "-q", "--bare", "-b", "main");
    sh(dir, "remote", "add", "origin", bare);
    const { h } = setup();
    await h.hello({ commitTrailer: "Co-Authored-By: Acme Bot <bot@acme.test>" });
    await h.open(dir);
    await everyKind(h, dir);
    const before = sh(dir, "status", "--porcelain");
    const appBytes = readFileSync(join(dir, "app.ts"));
    const base = headSha(dir);
    const reply = await h.engine.request({
      type: "commit_series",
      push: true,
      commits: [
        { message: "feat: L2 and the new file", parts: [{ path: "app.ts", hunks: [0] }, { path: "new.txt" }] },
        { message: "fix: L18\n\nWith the rest.", parts: [{ path: "app.ts", hunks: [1] }, { path: "gone.txt" }, { path: "moved.txt" }, { path: "single.txt" }, { path: "pic.bin" }] },
      ],
    });
    const shas = sh(dir, "rev-list", "--reverse", `${base}..HEAD`).trim().split("\n");
    expect(shas).toHaveLength(2);
    expect(reply).toEqual({
      type: "committed_series", id: reply.id, branch: "main", pushed: true,
      commits: [
        { sha: shas[0], shortSha: shas[0]!.slice(0, 7), message: "feat: L2 and the new file\n\nCo-Authored-By: Acme Bot <bot@acme.test>", files: ["app.ts", "new.txt"] },
        { sha: shas[1], shortSha: shas[1]!.slice(0, 7), message: "fix: L18\n\nWith the rest.\n\nCo-Authored-By: Acme Bot <bot@acme.test>", files: ["app.ts", "gone.txt", "moved.txt", "single.txt", "pic.bin"] },
      ],
    });
    // Each commit's tree: the first has only hunk 0 of app.ts.
    expect(namesOf(dir, shas[0]!)).toEqual(["A new.txt", "M app.ts"]);
    expect(sh(dir, "show", `${shas[0]}:app.ts`)).toBe(edited({ 2: "L2" }));
    expect(namesOf(dir, shas[1]!)).toEqual(["D gone.txt", "M app.ts", "M pic.bin", "M single.txt", "R100 tomove.txt moved.txt"]);
    expect(sh(dir, "show", `${shas[1]}:app.ts`)).toBe(edited({ 2: "L2", 18: "L18" }));
    expect(sh(dir, "log", "-1", "--format=%B", shas[0]!).trimEnd()).toBe("feat: L2 and the new file\n\nCo-Authored-By: Acme Bot <bot@acme.test>");
    // The worktree is what it was; the index is HEAD (nothing staged, nothing left to commit).
    expect(readFileSync(join(dir, "app.ts")).equals(appBytes)).toBe(true);
    expect(before).not.toBe("");
    expect(sh(dir, "status", "--porcelain")).toBe("");
    expect(readdirSync(join(dir, ".git")).filter((n) => n.startsWith("rg-series-index"))).toEqual([]);
    // One push; the last commit is state.commit.lastCommit; each file left the review with its commit (§38.3).
    expect(sh(bare, "rev-parse", "main").trim()).toBe(shas[1]);
    const s = h.engine.state;
    expect(s.commit.lastCommit).toMatchObject({ sha: shas[1], files: ["app.ts", "gone.txt", "moved.txt", "single.txt", "pic.bin"], pushed: true, branch: "main" });
    expect(s.changedFiles).toEqual([]);
    const history = await h.engine.request({ type: "review_history" });
    const rows = history.entries.flatMap((e) => e.files).filter((f) => f.committed);
    expect(Object.fromEntries(rows.map((f) => [f.path, f.commit?.sha]))).toEqual({ "new.txt": shas[0], "app.ts": shas[1], "gone.txt": shas[1], "moved.txt": shas[1], "single.txt": shas[1], "pic.bin": shas[1] });
    expect(h.ofType("error")).toHaveLength(0);
  });

  it("keeps the user's other staged entries staged and out of the commits", async () => {
    const dir = makeRepo();
    write(dir, "notes.md", "my staged notes\n");
    write(dir, "single.txt", "one\ntwo\nstaged\n");
    sh(dir, "add", "notes.md", "single.txt");
    write(dir, "single.txt", "one\ntwo\nstaged\nunstaged\n");
    const staged = sh(dir, "diff", "--cached", "--name-status");
    const blob = sh(dir, "rev-parse", ":single.txt").trim();
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    await turn(h, () => {
      write(dir, "app.ts", edited({ 2: "L2", 18: "L18" }));
      write(dir, "new.txt", "new\n");
    });
    await h.engine.request({ type: "accept", paths: ["app.ts", "new.txt"] });
    await h.engine.request({ type: "commit_series", commits: [
      { message: "one", parts: [{ path: "app.ts", hunks: [1] }] },
      { message: "two", parts: [{ path: "new.txt" }] },
    ] });
    expect(namesOf(dir, "HEAD~1")).toEqual(["M app.ts"]);
    expect(namesOf(dir, "HEAD")).toEqual(["A new.txt"]);
    expect(sh(dir, "diff", "--cached", "--name-status")).toBe(staged);
    expect(sh(dir, "rev-parse", ":single.txt").trim()).toBe(blob);
    // app.ts: the index holds the commit (hunk 1); hunk 0 is an unstaged change.
    expect(sh(dir, "show", ":app.ts")).toBe(edited({ 18: "L18" }));
    expect(sh(dir, "diff", "--name-only").trim().split("\n")).toEqual(["app.ts", "single.txt"]);
  });

  it("runs the repository's hooks on each commit with the series' index; a hook that refuses the second commit leaves the first (partial)", async () => {
    const dir = makeRepo();
    hook(dir, "pre-commit", `git diff --cached --name-only >> "$(git rev-parse --git-dir)/rg-test-precommit"`);
    hook(dir, "commit-msg", `if grep -q BAD "$1"; then echo "commit-msg: BAD is not allowed" >&2; exit 1; fi\necho "Hooked-By: commit-msg" >> "$1"`);
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    await everyKind(h, dir);
    const base = headSha(dir);
    await h.engine.request({ type: "commit_series", commits: [
      { message: "first", parts: [{ path: "app.ts", hunks: [0] }] },
      { message: "second", parts: [{ path: "new.txt" }] },
    ] });
    expect(sh(dir, "log", "--format=%B", `${base}..HEAD`).replace(/\n+/g, "\n").trim()).toBe("second\nHooked-By: commit-msg\nfirst\nHooked-By: commit-msg");
    expect(readFileSync(join(dir, ".git", "rg-test-precommit"), "utf8")).toBe("app.ts\nnew.txt\n");

    // The second commit's message is refused: the first is made, the refusal says what was made.
    const mid = headSha(dir);
    const failed = h.engine.request({ type: "commit_series", commits: [
      { message: "third", parts: [{ path: "app.ts" }, { path: "single.txt" }] }, // app.ts has one hunk left: whole only
      { message: "BAD fourth", parts: [{ path: "gone.txt" }] },
    ] });
    await expect(failed).rejects.toThrow("commit_failed:commit-msg: BAD is not allowed");
    const third = headSha(dir);
    expect(sh(dir, "rev-list", `${mid}..HEAD`).trim().split("\n")).toEqual([third]);
    const result = h.events.find((e) => e.type === "result" && !e.ok && e.code === "commit_failed");
    expect(result).toMatchObject({ partial: { commits: [{ sha: third, shortSha: third.slice(0, 7), message: "third", files: ["app.ts", "single.txt"] }], branch: "main", pushed: false } });
    expect(h.ofType("committed_series")).toHaveLength(1); // only the first series' reply
    // What was committed left the review; gone.txt is still there, accepted, and staged nowhere.
    const s = h.engine.state;
    expect(s.commit.lastCommit?.sha).toBe(third);
    expect(s.changedFiles.map((f) => [f.path, f.state]).sort()).toEqual([["gone.txt", "accepted"], ["moved.txt", "accepted"], ["pic.bin", "accepted"]]);
    expect(sh(dir, "diff", "--cached", "--name-only")).toBe("");
    // The first commit refused: nothing is made, no `partial`.
    const failedFirst = h.engine.request({ type: "commit_series", commits: [{ message: "BAD", parts: [{ path: "gone.txt" }] }] });
    await expect(failedFirst).rejects.toThrow("commit_failed:commit-msg: BAD is not allowed");
    expect(headSha(dir)).toBe(third);
    const last = h.events.filter((e) => e.type === "result" && !e.ok).at(-1)!;
    expect("partial" in last).toBe(false);
  });

  it("refuses before the first commit — nothing changes", async () => {
    const dir = makeRepo();
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    await h.engine.handle({ type: "send", text: "work" });
    h.session().emitSessionInfo();
    write(dir, "app.ts", edited({ 2: "L2", 18: "L18" }));
    write(dir, "new.txt", "new\n");
    write(dir, "single.txt", "one\nTWO\n");
    const one = [{ message: "x", parts: [{ path: "app.ts" }] }];
    await expect(h.engine.request({ type: "commit_series", commits: one })).rejects.toThrow("session_running");
    h.session().emitTurnEnd({ toolFiles: [], lastUuid: "uuid-1" });
    await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");
    await expect(h.engine.request({ type: "commit_series", commits: one })).rejects.toThrow("nothing_to_commit"); // nothing accepted
    await h.engine.request({ type: "accept", paths: ["app.ts", "new.txt"] });
    const base = headSha(dir);
    const index = sh(dir, "ls-files", "-s");
    const refusals: [unknown, string][] = [
      [[], "nothing_to_commit"],
      [[{ message: "x", parts: [] }], "nothing_to_commit"],
      [[{ message: "x", parts: [{ path: "app.ts", hunks: [0] }] }, { message: "  ", parts: [{ path: "app.ts", hunks: [1] }] }], "empty_message"],
      [[{ message: "x", parts: [{ path: "single.txt" }] }], "invalid_part:single.txt"], // pending
      [[{ message: "x", parts: [{ path: "app.ts", hunks: [2] }] }], "invalid_part:app.ts"],
      [[{ message: "x", parts: [{ path: "app.ts", hunks: [] }] }], "invalid_part:app.ts"],
      [[{ message: "x", parts: [{ path: "new.txt", hunks: [0] }] }], "invalid_part:new.txt"], // whole only
      [[{ message: "x", parts: [{ path: "app.ts", hunks: [0] }] }, { message: "y", parts: [{ path: "app.ts", hunks: [1, 0] }] }], "hunk_twice:app.ts#0"],
      [[{ message: "x", parts: [{ path: "app.ts" }] }, { message: "y", parts: [{ path: "app.ts", hunks: [1] }] }], "hunk_twice:app.ts#1"],
      [[{ message: "x", parts: [{ path: "new.txt" }, { path: "new.txt" }] }], "hunk_twice:new.txt"],
    ];
    for (const [commits, why] of refusals) {
      await expect(h.engine.request({ type: "commit_series", commits } as never), why).rejects.toThrow(why);
    }
    // A merge in progress: a series cannot conclude it.
    write(dir, ".git/MERGE_HEAD", base + "\n");
    await expect(h.engine.request({ type: "commit_series", commits: one })).rejects.toThrow("merge_unresolved:");
    rmSync(join(dir, ".git", "MERGE_HEAD"));
    // No identity anywhere.
    const home = realpathSync(makeTempDir("rg-series-home"));
    dirs.push(home);
    for (const [k, v] of Object.entries({ HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_SYSTEM: join(home, "gitconfig-system") })) setEnv(k, v);
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) setEnv(k, undefined);
    sh(dir, "config", "--unset", "user.name");
    await expect(h.engine.request({ type: "commit_series", commits: one })).rejects.toThrow("git_identity_missing:user.name not set");
    expect(headSha(dir)).toBe(base);
    expect(sh(dir, "ls-files", "-s")).toBe(index);
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["app.ts", "accepted"], ["new.txt", "accepted"], ["single.txt", "pending"]]);
    expect(h.ofType("committed_series")).toHaveLength(0);
  });
});

describe("§53 the review after a series", () => {
  it("a file committed partly stays in the review, accepted, with only the rest of its hunks; A holds what was committed", async () => {
    const dir = makeRepo();
    const { h } = setup();
    await h.hello();
    await h.open(dir);
    await everyKind(h, dir);
    await h.engine.request({ type: "commit_series", commits: [{ message: "L2", parts: [{ path: "app.ts", hunks: [0] }, { path: "new.txt" }] }] });
    const s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state]).sort()).toEqual([["app.ts", "accepted"], ["gone.txt", "accepted"], ["moved.txt", "accepted"], ["pic.bin", "accepted"], ["single.txt", "accepted"]]);
    expect(s.changedFiles.find((f) => f.path === "app.ts")).toMatchObject({ status: "M", added: 1, deleted: 1 });
    expect(s.commit.acceptedPaths).toContain("app.ts");
    expect(sh(dir, "cat-file", "-p", `${s.gate.turnStartTree}:app.ts`)).toBe(edited({ 2: "L2" }));
    expect(sh(dir, "cat-file", "-p", `${s.gate.turnStartTree}:new.txt`)).toBe("new\n");
    const diff = await h.engine.request({ type: "select_file", path: "app.ts" });
    const lines = diff.diff.hunks.flatMap((x) => x.lines);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["L18"]);
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["l18"]);
    // One hunk is left: it goes whole now, and a plain commit takes it.
    expect((await h.engine.request({ type: "commit_hunks", paths: ["app.ts"] })).files[0]!.hunks).toEqual([]);
    await h.engine.request({ type: "commit", message: "L18", paths: ["app.ts"] });
    expect(sh(dir, "show", "HEAD:app.ts")).toBe(edited({ 2: "L2", 18: "L18" }));
    expect(h.engine.state.changedFiles.map((f) => f.path)).not.toContain("app.ts");
    expect(h.ofType("error")).toHaveLength(0);
  });
});
