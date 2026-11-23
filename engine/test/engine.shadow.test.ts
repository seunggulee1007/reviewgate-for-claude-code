import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setShadowLimits, SHADOW_LIMITS, shadowRepoDir } from "../src/git/shadow.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(async () => {
  setShadowLimits(null);
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** A plain folder (not a repository; real path) and an engine data folder of its own. */
function setup(): { folder: string; data: string } {
  const folder = realpathSync.native(track(makeTempDir("rg-nogit")));
  write(folder, "a.txt", "one\n");
  return { folder, data: track(makeTempDir("rg-nogit-data")) };
}

async function harness(data: string): Promise<Harness> {
  const h = makeHarness({ dataDir: data });
  harnesses.push(h);
  await h.hello();
  return h;
}

async function track_(h: Harness, confirm?: boolean): Promise<void> {
  await h.engine.request({ type: "track_without_git", ...(confirm ? { confirm } : {}) });
  await h.waitFor((s) => s.session.open && !s.session.starting, "session after track_without_git");
}

/** Shadow-repo git (the test oracle): the hidden repository with the folder as its work tree. */
const shadowGit = (data: string, folder: string, ...args: string[]): string => sh(folder, `--git-dir=${shadowRepoDir(data, folder)}`, `--work-tree=${folder}`, ...args);

describe("track without git (§59)", () => {
  it("reviews a folder that is no repository: turn → review → accept / reject; git-only commands refused; reopen goes straight back", async () => {
    const { folder, data } = setup();
    let h = await harness(data);
    let s = await h.open(folder);
    expect(s.gitInit).toMatchObject({ path: folder, looksUnsafe: false });
    expect(s.gate.blockedReason).toBe("git_init_needed");

    await track_(h);
    s = h.engine.state;
    expect(s.gitInit).toBeNull();
    expect(s.project).toMatchObject({ path: folder, root: folder, vcs: "shadow", branch: null, remoteURL: null });
    expect(s.commit.identity).toEqual({ name: null, email: null });
    expect(s.branches.list).toEqual([]);
    expect(s.workbenches.list).toEqual([]);
    expect(existsSync(join(folder, ".git"))).toBe(false);
    expect(shadowGit(data, folder, "log", "--format=%s").trim()).toBe("ReviewGate baseline");
    write(folder, "notes.md", "one more\n"); // untracked: git grep --untracked still finds it
    const found = await h.engine.request({ type: "project_search", query: "one" });
    expect(found.type === "project_search" && found.matches.map((m) => m.path).sort()).toEqual(["a.txt", "notes.md"]);
    await h.engine.request({ type: "list_files", query: "notes" });

    // A turn: Claude edits a.txt and writes b.txt.
    await h.engine.handle({ type: "send", text: "edit" });
    write(folder, "a.txt", "one\ntwo\n");
    write(folder, "b.txt", "new\n");
    h.session().emitTurnEnd();
    s = await h.waitFor((st) => st.gate.turnEndTree !== null && st.gate.phase === "reviewing", "collection");
    expect(s.changedFiles.map((f) => [f.path, f.status])).toEqual([["a.txt", "M"], ["b.txt", "A"]]);

    await h.engine.request({ type: "accept", paths: ["a.txt"] });
    expect(h.engine.state.commit.canCommit).toBe(false);
    await expect(h.engine.request({ type: "commit", message: "x" })).rejects.toThrow("not_a_git_repo");
    for (const type of ["branches", "workbench_list", "push", "pr_list", "commit_hunks"] as const) {
      await expect(h.engine.request({ type })).rejects.toThrow("not_a_git_repo");
    }
    await expect(h.engine.request({ type: "pr_comment", body: "hi" })).rejects.toThrow("not_a_git_repo:pr_comment"); // §60
    const refusal = h.ofType("result").find((r) => r.ok === false && typeof r.error === "string" && r.error.startsWith("not_a_git_repo"));
    expect(refusal).toMatchObject({ code: "not_a_git_repo" });

    await h.engine.request({ type: "reject", paths: ["b.txt"] });
    expect(read(folder, "b.txt")).toBeNull();
    expect(read(folder, "a.txt")).toBe("one\ntwo\n");
    const history = await h.engine.request({ type: "review_history" });
    expect(history.type).toBe("review_history");
    s = await h.waitFor((st) => st.changedFiles.every((f) => f.state !== "pending"), "review resolved");
    await h.engine.request({ type: "close_project" });
    await h.engine.dispose();

    // Reopen (another engine): no prompt, the hidden repository again, re-baselined to the folder as it is now.
    write(folder, "c.txt", "made while closed\n");
    h = await harness(data);
    s = await h.open(folder);
    expect(s.gitInit).toBeNull();
    expect(s.project?.vcs).toBe("shadow");
    expect(shadowGit(data, folder, "log", "--format=%s").trim().split("\n")).toEqual(["ReviewGate baseline", "ReviewGate baseline"]);
    expect(shadowGit(data, folder, "status", "--porcelain").trim()).toBe("");
    expect(s.changedFiles).toEqual([]);
    expect(existsSync(join(folder, ".git"))).toBe(false);
    expect(readdirSync(folder).sort()).toEqual(["a.txt", "c.txt", "notes.md"]);
  });

  it("a review left pending is restored on reopen and keeps its baseline (no re-baseline under it)", async () => {
    const { folder, data } = setup();
    let h = await harness(data);
    await h.open(folder);
    await track_(h);
    await h.engine.handle({ type: "send", text: "edit" });
    write(folder, "a.txt", "one\nchanged\n");
    h.session().emitTurnEnd();
    await h.waitFor((st) => st.gate.phase === "reviewing", "collection");
    await h.engine.dispose();
    write(folder, "outside.txt", "edited while closed\n");
    h = await harness(data);
    const s = await h.open(folder);
    expect(s.project?.vcs).toBe("shadow");
    expect(s.changedFiles.map((f) => [f.path, f.state])).toContainEqual(["a.txt", "pending"]);
    expect(shadowGit(data, folder, "log", "--format=%s").trim()).toBe("ReviewGate baseline");
    await h.engine.request({ type: "reject", paths: ["a.txt"] });
    expect(read(folder, "a.txt")).toBe("one\n");
  });

  it("a folder that became a real repository opens as one; the hidden repository is left alone", async () => {
    const { folder, data } = setup();
    let h = await harness(data);
    await h.open(folder);
    await track_(h);
    await h.engine.dispose();
    sh(folder, "init", "-q");
    h = await harness(data);
    const s = await h.open(folder);
    expect(s.gitInit).toBeNull();
    expect(s.project?.vcs).toBe("git");
    expect(existsSync(shadowRepoDir(data, folder))).toBe(true);
    await expect(h.engine.request({ type: "branches" })).resolves.toBeDefined();
  });

  it("refusals keep the prompt: folder_unsafe without confirm, folder_too_large over the size guard, git_init_not_needed without one", async () => {
    const { folder, data } = setup();
    const h = await harness(data);
    await expect(h.engine.request({ type: "track_without_git" })).rejects.toThrow("git_init_not_needed");
    for (let i = 0; i < 201; i++) write(folder, `f${i}.txt`, "x\n");
    let s = await h.open(folder);
    expect(s.gitInit?.looksUnsafe).toBe(true);
    await expect(h.engine.request({ type: "track_without_git" })).rejects.toThrow("folder_unsafe");
    setShadowLimits({ ...SHADOW_LIMITS, maxFiles: 100 });
    await expect(h.engine.request({ type: "track_without_git", confirm: true })).rejects.toThrow("folder_too_large:files");
    s = h.engine.state;
    expect(s.gitInit).not.toBeNull();
    expect(s.project).toBeNull();
    expect(h.ofType("result").find((r) => r.ok === false && r.code === "folder_too_large")).toBeDefined();
    // Not remembered: the next open asks again.
    s = await h.open(folder);
    expect(s.gitInit).not.toBeNull();
    setShadowLimits(null);
    await track_(h, true);
    expect(h.engine.state.project?.vcs).toBe("shadow");
  });
});
