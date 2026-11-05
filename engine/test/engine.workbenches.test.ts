import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { readLock } from "../src/review/lock.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeFakeGh } from "./helpers/fakeGh.js";
import { fileExists, makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** `main` with README.md committed; git prints the resolved toplevel (/private/var on macOS). */
function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-wb"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

/** Sends `text`, ends the fake turn after `mutate()` ran, waits for the collection. */
async function fakeTurn(h: Harness, mutate: () => void): Promise<void> {
  await h.engine.handle({ type: "send", text: "do it" });
  mutate();
  h.session().emitTurnEnd();
  await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
  await h.waitFor((s) => s.branches.list.length > 0 && s.workbenches.list.length > 0, "refresh after turn");
}

describe("ReviewEngine workbenches (docs/M10-WORKBENCHES.md)", () => {
  it("workbench_create → two engines on main + workbench run independent turns; refusals; remove/prune", async () => {
    const repo = track(makeRepo());
    const managed = track(realpathSync(makeTempDir("rg-wb-root")));
    const a = harness();
    await a.hello({ worktreeRoot: managed });
    const opened = await a.open(repo);
    expect(opened.session.open).toBe(true);
    expect(opened.lockConflict).toBeNull();
    expect(opened.workbenches.current).toBe(repo);
    expect(opened.workbenches.managedRoot.startsWith(managed + sep)).toBe(true);
    expect(opened.workbenches.list.map((w) => [w.path, w.branch, w.isMain, w.isCurrent, w.locked?.pid, w.locked?.client])).toEqual([
      [repo, "main", true, true, process.pid, "test"],
    ]);
    expect(fileExists(join(repo, ".git", "reviewgate.lock"))).toBe(true);

    // Refusals before anything is created.
    await expect(a.engine.request({ type: "workbench_create", branch: "bad..name" })).rejects.toThrow("invalid_branch_name:bad..name");
    await expect(a.engine.request({ type: "workbench_create", branch: "main" })).rejects.toThrow(`branch_in_use:${repo}`);
    mkdirSync(join(managed, "taken"));
    await expect(a.engine.request({ type: "workbench_create", branch: "x", path: join(managed, "taken") })).rejects.toThrow(`path_exists:${join(managed, "taken")}`);
    await expect(a.engine.request({ type: "workbench_remove", path: repo })).rejects.toThrow("cannot_remove_main");
    await expect(a.engine.request({ type: "workbench_remove", path: "/nowhere" })).rejects.toThrow("unknown_worktree:/nowhere");

    // Create under the managed root: <managedRoot>/<slug>.
    await a.engine.request({ type: "workbench_create", branch: "feature/x" });
    let s = a.engine.state;
    const wt = join(s.workbenches.managedRoot, "feature-x");
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    expect(s.workbenches.list.map((w) => [w.path, w.branch, w.isMain, w.isCurrent, w.locked === null, w.dirty])).toEqual([
      [repo, "main", true, true, false, false],
      [wt, "feature/x", false, false, true, null],
    ]);
    expect(s.branches.list.map((b) => b.name).sort()).toEqual(["feature/x", "main"]);
    expect(s.project?.branch).toBe("main"); // this engine stays on main
    // Creating it again: the branch is now checked out in the workbench.
    await expect(a.engine.request({ type: "workbench_create", branch: "feature/x" })).rejects.toThrow(`branch_in_use:${wt}`);
    // An existing branch that is not checked out anywhere is reused (no -b), with an explicit path.
    sh(repo, "branch", "topic");
    const explicit = join(managed, "explicit");
    await a.engine.request({ type: "workbench_create", branch: "topic", path: explicit });
    expect(sh(explicit, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("topic");
    await a.engine.request({ type: "workbench_remove", path: explicit });
    expect(existsSync(explicit)).toBe(false);

    // A second engine opens the workbench: its own lock, its own session, `current` = the worktree.
    const b = harness();
    await b.hello({ worktreeRoot: managed });
    const bOpened = await b.open(wt);
    expect(bOpened.session.open).toBe(true);
    expect(bOpened.project?.root).toBe(wt);
    expect(bOpened.project?.branch).toBe("feature/x");
    expect(bOpened.workbenches.current).toBe(wt);
    expect(bOpened.workbenches.managedRoot).toBe(s.workbenches.managedRoot); // same repository → same managed root
    expect(bOpened.workbenches.list.map((w) => [w.branch, w.isMain, w.isCurrent, w.locked?.pid])).toEqual([
      ["main", true, false, process.pid],
      ["feature/x", false, true, process.pid],
    ]);
    expect(fileExists(join(repo, ".git", "worktrees", "feature-x", "reviewgate.lock"))).toBe(true);
    expect(fileExists(join(wt, ".git", "reviewgate.lock"))).toBe(false);

    // Both run a fake turn; each engine only sees its own worktree's changes.
    await fakeTurn(a, () => write(repo, "from-main.txt", "a\n"));
    await fakeTurn(b, () => write(wt, "from-wb.txt", "b\n"));
    expect(a.engine.state.changedFiles.map((f) => f.path)).toEqual(["from-main.txt"]);
    expect(b.engine.state.changedFiles.map((f) => f.path)).toEqual(["from-wb.txt"]);
    expect(a.engine.state.gate.phase).toBe("reviewing");
    expect(b.engine.state.gate.phase).toBe("reviewing");
    // The post-turn refresh sees the other workbench as locked (in use).
    expect(a.engine.state.workbenches.list.find((w) => w.path === wt)?.locked?.pid).toBe(process.pid);

    // Removing a workbench that another session has open is refused (lock), `workbench_list` computes dirty.
    await expect(a.engine.request({ type: "workbench_remove", path: wt })).rejects.toThrow(`worktree_locked:${process.pid}`);
    await a.engine.request({ type: "workbench_list" });
    expect(a.engine.state.workbenches.list.map((w) => [w.branch, w.dirty])).toEqual([["main", true], ["feature/x", true]]);
    await b.engine.request({ type: "accept_all" });
    await b.engine.handle({ type: "close_project" });
    await b.settle();
    expect(fileExists(join(repo, ".git", "worktrees", "feature-x", "reviewgate.lock"))).toBe(false);
    expect(b.engine.state.workbenches).toEqual({ list: [], current: "", managedRoot: "" });
    // Unlocked but dirty (from-wb.txt is untracked) → still refused without force.
    await expect(a.engine.request({ type: "workbench_remove", path: wt })).rejects.toThrow("worktree_dirty");
    expect(existsSync(wt)).toBe(true);
    await a.engine.request({ type: "workbench_remove", path: wt, force: true });
    expect(existsSync(wt)).toBe(false);
    s = a.engine.state;
    expect(s.workbenches.list.map((w) => w.branch)).toEqual(["main"]);
    expect(s.branches.list.map((b) => b.name).sort()).toEqual(["feature/x", "main", "topic"]); // branches survive

    // Prune after a manual directory delete.
    await a.engine.request({ type: "workbench_create", branch: "gone" });
    const gone = join(s.workbenches.managedRoot, "gone");
    expect(a.engine.state.workbenches.list.map((w) => w.path)).toEqual([repo, gone]);
    removeDir(gone);
    await a.engine.request({ type: "workbench_prune" });
    expect(a.engine.state.workbenches.list.map((w) => w.path)).toEqual([repo]);
    expect(sh(repo, "worktree", "list", "--porcelain").includes(gone)).toBe(false);

    // Without a project every workbench command is refused.
    await a.engine.handle({ type: "close_project" });
    await a.settle();
    await expect(a.engine.request({ type: "workbench_list" })).rejects.toThrow("no_project");
    await expect(a.engine.request({ type: "workbench_prune" })).rejects.toThrow("no_project");
    expect(fileExists(join(repo, ".git", "reviewgate.lock"))).toBe(false);
  });

  it("opening the same worktree twice → lock conflict; takeover succeeds and the first engine keeps running (advisory lock)", async () => {
    const repo = track(makeRepo());
    const a = harness();
    await a.hello();
    await a.open(repo);
    const aLock = await readLock(join(repo, ".git"));
    expect(aLock?.pid).toBe(process.pid);

    const c = harness();
    await c.hello();
    await expect(c.engine.request({ type: "open_project", path: repo })).rejects.toThrow(`locked_by_other_session:${process.pid}`);
    await c.settle();
    let s = c.engine.state;
    expect(s.project).toBeNull();
    expect(s.session.open).toBe(false);
    expect(s.lockConflict).toEqual({ path: repo, pid: process.pid, since: aLock!.since, client: "test" });
    expect(s.lastError).toBeNull(); // a refusal, not an error event
    expect(c.ofType("error")).toHaveLength(0);
    expect((await readLock(join(repo, ".git")))?.token).toBe(aLock!.token); // untouched

    // Takeover: the lock is rewritten for C; A is not stopped (advisory).
    await c.engine.request({ type: "open_project", path: repo, takeover: true });
    s = await c.waitFor((x) => x.session.open && !x.session.starting, "C open");
    expect(s.lockConflict).toBeNull();
    expect(s.workbenches.list[0]?.locked?.pid).toBe(process.pid);
    const cLock = await readLock(join(repo, ".git"));
    expect(cLock?.token).not.toBe(aLock!.token);
    expect(a.engine.state.session.open).toBe(true);
    expect(a.engine.state.gate.canSend).toBe(true);
    await a.engine.handle({ type: "send", text: "still alive" });
    expect(a.session().sends).toHaveLength(1);
    a.session().emitTurnEnd();
    await a.waitFor((x) => x.gate.phase === "idle" && x.hud.turnCount === 1, "A turn");

    // A closing (or disposing) does not release C's lock — only its own.
    await a.engine.handle({ type: "close_project" });
    await a.settle();
    expect((await readLock(join(repo, ".git")))?.token).toBe(cLock!.token);
    await c.engine.dispose();
    expect(await readLock(join(repo, ".git"))).toBeNull();

    // A stale lock (dead pid) is silently overwritten.
    writeFileSync(join(repo, ".git", "reviewgate.lock"), JSON.stringify({ pid: 4_000_000_000, since: "2020-01-01T00:00:00Z", client: "mac", host: "old" }));
    const d = harness();
    await d.hello();
    const dOpened = await d.open(repo);
    expect(dOpened.session.open).toBe(true);
    expect(dOpened.lockConflict).toBeNull();
    expect((await readLock(join(repo, ".git")))?.pid).toBe(process.pid);
  });

  it("pr_create: pushes a branch without upstream, runs `gh pr create` on the remote's repo, replies pr_created", async () => {
    const repo = track(makeRepo());
    const bare = track(makeTempDir("rg-wb-origin"));
    sh(bare, "init", "-q", "--bare", "-b", "main");
    sh(repo, "remote", "add", "origin", `git@github.example.com:acme/widgets.git`);
    sh(repo, "remote", "set-url", "--push", "origin", bare); // fetch URL names the GitHub repo, pushes land in a local bare repo
    sh(repo, "switch", "-q", "-c", "feature/pr");

    const tools = track(makeTempDir("rg-wb-gh"));
    const log = join(tools, "gh.log");
    const fake = makeFakeGh(tools, log, "Creating pull request for feature/pr into main in acme/widgets\nhttps://github.example.com/acme/widgets/pull/7\n");
    onTestFinished(fake.restore);

    const h = harness();
    await h.hello({ ghPath: fake.path });
    await h.open(repo);
    await expect(h.engine.request({ type: "pr_create", base: " " })).rejects.toThrow("empty base");

    const reply = await h.engine.request({ type: "pr_create", base: "main", title: "My PR", body: "Body text", draft: true });
    expect(reply).toMatchObject({ type: "pr_created", url: "https://github.example.com/acme/widgets/pull/7", branch: "feature/pr" });
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      "pr", "create", "--repo", "github.example.com/acme/widgets", "--head", "feature/pr", "--base", "main", "--title", "My PR", "--body", "Body text", "--draft",
    ]);
    // The branch was pushed with an upstream first.
    expect(sh(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").trim()).toBe("origin/feature/pr");
    expect(sh(bare, "rev-parse", "feature/pr").trim()).toBe(sh(repo, "rev-parse", "HEAD").trim());
    await h.settle();
    expect(h.engine.state.pr.lastCreatedPR).toEqual({ url: "https://github.example.com/acme/widgets/pull/7", branch: "feature/pr" });

    // gh runs in the worktree: it reads git where it runs (elsewhere: "not a git repository").
    expect(realpathSync(readFileSync(`${log}.cwd`, "utf8"))).toBe(realpathSync(repo));

    // Without a title → the one pr_draft gives (no `--fill`: gh would read git); upstream already set → no second push.
    sh(repo, "update-ref", "refs/remotes/origin/main", "main");
    writeFileSync(join(repo, "cart.txt"), "1\n");
    sh(repo, "add", "cart.txt");
    sh(repo, "commit", "-q", "-m", "#acme/42: fix the cart total");
    await h.engine.request({ type: "pr_create", base: "main" });
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      "pr", "create", "--repo", "github.example.com/acme/widgets", "--head", "feature/pr", "--base", "main",
      "--title", "#acme/42: fix the cart total", "--body", "- #acme/42: fix the cart total",
    ]);
    // A body of the user's own stays; a base without a ref (no commits to read) → the branch is the title.
    await h.engine.request({ type: "pr_create", base: "release", body: "Mine" });
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean).slice(-4)).toEqual(["--title", "feature/pr", "--body", "Mine"]);

    // No remote → refused before anything runs.
    const bareRepo = track(makeRepo());
    await h.open(bareRepo);
    await expect(h.engine.request({ type: "pr_create", base: "main" })).rejects.toThrow("no_remote");
  });
});
