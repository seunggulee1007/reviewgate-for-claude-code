// MARK: git-sync — §68 fetch and pull: temp repos with a local bare `origin` only (never a network remote).
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

function identity(dir: string): void {
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
}

/** A bare `origin` with `main` (README.md, other.txt), the repo the app opens (tracking origin/main) and a second clone ("a teammate"). */
function makeTrio(): { repo: string; bare: string; peer: string } {
  const bare = track(realpathSync(makeTempDir("rg-sync-origin")));
  sh(bare, "init", "-q", "--bare", "-b", "main");
  const seed = track(realpathSync(makeTempDir("rg-sync-seed")));
  sh(seed, "init", "-q", "-b", "main");
  identity(seed);
  write(seed, "README.md", "line1\nline2\n");
  write(seed, "other.txt", "other\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "init");
  sh(seed, "remote", "add", "origin", bare);
  sh(seed, "push", "-q", "-u", "origin", "main");
  const parent = track(realpathSync(makeTempDir("rg-sync-clones")));
  sh(parent, "clone", "-q", bare, "repo");
  sh(parent, "clone", "-q", bare, "peer");
  const repo = join(parent, "repo");
  const peer = join(parent, "peer");
  identity(repo);
  identity(peer);
  return { repo, bare, peer };
}

/** The teammate commits `files` and pushes. */
function peerPush(peer: string, files: Record<string, string>, message = "peer change"): void {
  for (const [p, c] of Object.entries(files)) write(peer, p, c);
  sh(peer, "add", "-A");
  sh(peer, "commit", "-qm", message);
  sh(peer, "push", "-q", "origin", "main");
}

function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}

async function fakeTurn(h: Harness, mutate: () => void, text = "do it"): Promise<void> {
  await h.engine.handle({ type: "send", text });
  mutate();
  h.session().emitTurnEnd();
  await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
  await h.waitFor((s) => s.branches.list.length > 0, "refresh after turn");
}

const current = (h: Harness) => h.engine.state.branches.list.find((b) => b.isCurrent)!;

describe("§68.1 git_fetch", () => {
  it("fetches the upstream's remote, refreshes ahead / behind and the sync state; no remote is refused", async () => {
    const { repo, peer } = makeTrio();
    const h = harness();
    await h.hello();
    const opened = await h.open(repo);
    expect(opened.branches.sync).toMatchObject({ fetching: false, pulling: false, lastFetchAt: null, lastFetchError: null, remotes: ["origin"], upstream: "origin/main", operation: null, pullBlocker: null, fetchBlocker: null, autoFetch: true });
    peerPush(peer, { "other.txt": "other\nmore\n" });
    expect(current(h).behind).toBe(0); // not fetched yet

    const reply = await h.engine.request({ type: "git_fetch" });
    expect(reply).toMatchObject({ type: "fetched", remotes: ["origin"], ahead: 0, behind: 1 });
    expect(reply.skipped).toBeUndefined();
    const s = h.engine.state;
    expect(current(h)).toMatchObject({ name: "main", upstream: "origin/main", ahead: 0, behind: 1 });
    expect(s.branches.sync!.lastFetchAt).not.toBeNull();
    expect(s.branches.sync!.fetching).toBe(false);
    expect(read(repo, "other.txt")).toBe("other\n"); // a fetch never touches the files

    // A local repository without a remote.
    const lone = track(realpathSync(makeTempDir("rg-sync-lone")));
    sh(lone, "init", "-q", "-b", "main");
    identity(lone);
    write(lone, "a.txt", "a\n");
    sh(lone, "add", "-A");
    sh(lone, "commit", "-qm", "init");
    const h2 = harness();
    await h2.hello();
    const st = await h2.open(lone);
    expect(st.branches.sync).toMatchObject({ remotes: [], upstream: null, fetchBlocker: { kind: "noRemote" }, pullBlocker: { kind: "noUpstream" } });
    await expect(h2.engine.request({ type: "git_fetch" })).rejects.toThrow("no_remote");
    await expect(h2.engine.request({ type: "git_pull" })).rejects.toThrow("pull_no_upstream:main");
    expect(await h2.engine.request({ type: "git_fetch", auto: true })).toMatchObject({ type: "fetched", skipped: true });
  });

  it("auto: at most every 5 minutes, never with autoFetch off; a failing fetch is refused with git's line and kept in the state", async () => {
    const { repo, bare, peer } = makeTrio();
    let clock = 1_700_000_000_000;
    const h = makeHarness({ now: () => clock });
    harnesses.push(h);
    await h.hello();
    await h.open(repo);
    peerPush(peer, { "c.txt": "c\n" });
    expect(await h.engine.request({ type: "git_fetch", auto: true })).toMatchObject({ behind: 1 });
    expect((await h.engine.request({ type: "git_fetch", auto: true })).skipped).toBe(true); // too soon
    clock += 5 * 60_000;
    expect((await h.engine.request({ type: "git_fetch", auto: true })).skipped).toBeUndefined();
    clock += 5 * 60_000;
    await h.engine.request({ type: "set_settings", settings: { autoFetch: false } });
    expect(h.engine.state.branches.sync!.autoFetch).toBe(false);
    expect((await h.engine.request({ type: "git_fetch", auto: true })).skipped).toBe(true);

    // The remote is gone: refused, the reason kept (a manual fetch ignores the throttle and the setting).
    removeDir(bare);
    await expect(h.engine.request({ type: "git_fetch" })).rejects.toThrow(/^fetch_failed:/);
    expect(h.engine.state.branches.sync!.lastFetchError).toMatch(/^fetch_failed:/);
    expect(h.engine.state.branches.sync!.fetching).toBe(false);
  });
});

describe("§68.2 git_pull", () => {
  it("fast-forwards; while a review stands the pulled files never show up as Claude's changes (a merge commit's resolution included)", async () => {
    const { repo, peer } = makeTrio();
    const h = harness();
    await h.hello();
    await h.open(repo);
    await fakeTurn(h, () => write(repo, "README.md", "line1\nline2\nclaude\n"));
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    const startBefore = h.engine.state.gate.turnStartTree!;

    // Upstream: a plain commit, then a merge whose commit itself changes a file (a conflict resolution).
    peerPush(peer, { "other.txt": "other\nfrom upstream\n", "new.txt": "new\n" });
    sh(peer, "switch", "-q", "-c", "side");
    peerPush(peer, { "side.txt": "side\n" }, "side work"); // pushes main (unchanged); side stays local
    sh(peer, "switch", "-q", "main");
    write(peer, "main-only.txt", "main\n");
    sh(peer, "add", "-A");
    sh(peer, "commit", "-qm", "main work");
    sh(peer, "merge", "-q", "--no-ff", "--no-commit", "side");
    write(peer, "other.txt", "other\nfrom upstream\nresolved in the merge\n");
    sh(peer, "add", "-A");
    sh(peer, "commit", "-qm", "merge side");
    sh(peer, "push", "-q", "origin", "main");

    const reply = await h.engine.request({ type: "git_pull" });
    expect(reply).toMatchObject({ type: "pulled", branch: "main", upstream: "origin/main", mode: "fast_forward", commits: 4 });
    expect(reply.files.sort()).toEqual(["main-only.txt", "new.txt", "other.txt", "side.txt"]);
    expect(reply.fileCount).toBe(4);
    expect(read(repo, "other.txt")).toBe("other\nfrom upstream\nresolved in the merge\n");
    expect(read(repo, "README.md")).toBe("line1\nline2\nclaude\n"); // Claude's pending change is still there

    const s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(s.gate.headMoved ?? null).toBeNull();
    expect(s.gate.turnStartTree).not.toBe(startBefore);
    expect(sh(repo, "cat-file", "-p", `${s.gate.turnStartTree}:other.txt`)).toBe("other\nfrom upstream\nresolved in the merge\n");
    expect(sh(repo, "diff-tree", "-r", "--name-only", s.gate.turnStartTree!, s.gate.turnEndTree!).trim()).toBe("README.md");
    expect(current(h)).toMatchObject({ ahead: 0, behind: 0 });
    expect(s.branches.sync).toMatchObject({ pulling: false, fetching: false });
    // The review's diff is still Claude's line only.
    const diff = await h.engine.request({ type: "select_file", path: "README.md" });
    expect(diff.diff.hunks.flatMap((hk) => hk.lines).filter((l) => l.kind === "add" || l.kind === "del").map((l) => `${l.kind}:${l.text}`)).toEqual(["add:claude"]);

    // A refresh (the user's ⌘R) keeps it that way, and so does accept + commit.
    await h.engine.request({ type: "refresh", scope: ["review"] });
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["README.md"]);
    await h.engine.request({ type: "accept", paths: ["README.md"] });
    await h.engine.request({ type: "commit", message: "readme" });
    expect(sh(repo, "show", "--name-only", "--format=", "HEAD").trim()).toBe("README.md");

    // Nothing new: up to date.
    expect(await h.engine.request({ type: "git_pull" })).toMatchObject({ mode: "up_to_date", commits: 0, files: [], fileCount: 0 });
  });

  it("a pull while idle (no review) leaves the next turn's review to Claude's changes", async () => {
    const { repo, peer } = makeTrio();
    const h = harness();
    await h.hello();
    await h.open(repo);
    peerPush(peer, { "other.txt": "pulled\n" });
    expect(await h.engine.request({ type: "git_pull" })).toMatchObject({ mode: "fast_forward", files: ["other.txt"] });
    await fakeTurn(h, () => write(repo, "a.txt", "a\n"));
    expect(h.engine.state.changedFiles.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("refuses to overwrite a changed file — a review file or the user's own — and leaves everything as it was", async () => {
    const { repo, peer } = makeTrio();
    const h = harness();
    await h.hello();
    await h.open(repo);
    write(repo, "other.txt", "my own edit\n"); // the user's, outside the review (before the turn)
    await fakeTurn(h, () => write(repo, "README.md", "claude\n"));
    peerPush(peer, { "README.md": "upstream\n", "other.txt": "upstream other\n", "fresh.txt": "upstream\n" });
    write(repo, "fresh.txt", "untracked here\n");
    const head = sh(repo, "rev-parse", "HEAD").trim();
    const err = await h.engine.request({ type: "git_pull" }).catch((e: unknown) => e as Error & { code?: string; paths?: string[] });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("pull_would_overwrite:README.md, fresh.txt, other.txt");
    expect(sh(repo, "rev-parse", "HEAD").trim()).toBe(head);
    expect(read(repo, "README.md")).toBe("claude\n");
    expect(read(repo, "other.txt")).toBe("my own edit\n");
    expect(read(repo, "fresh.txt")).toBe("untracked here\n");
    expect(sh(repo, "stash", "list").trim()).toBe(""); // never stashed
    expect(h.engine.state.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(h.engine.state.branches.sync!.pulling).toBe(false);
    expect(current(h).behind).toBe(1); // the fetch of the pull still happened
  });

  it("diverged: refused with the counts; rebase only on a clean tree without a review, and a conflicting rebase is aborted", async () => {
    const { repo, peer } = makeTrio();
    const h = harness();
    await h.hello();
    await h.open(repo);
    peerPush(peer, { "other.txt": "upstream\n" });
    write(repo, "mine.txt", "mine\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "local work");
    await expect(h.engine.request({ type: "git_pull" })).rejects.toThrow("pull_diverged:1,1");

    // A review stands: no rebase.
    await fakeTurn(h, () => write(repo, "a.txt", "a\n"));
    await expect(h.engine.request({ type: "git_pull", rebase: true })).rejects.toThrow("pull_rebase_blocked:review");
    await h.engine.request({ type: "reject", paths: ["a.txt"] });
    await h.waitFor((s) => s.changedFiles.length === 0, "review empty");
    // Uncommitted tracked change: no rebase.
    write(repo, "README.md", "dirty\n");
    await expect(h.engine.request({ type: "git_pull", rebase: true })).rejects.toThrow("pull_rebase_blocked:dirty");
    sh(repo, "checkout", "--", "README.md");

    const reply = await h.engine.request({ type: "git_pull", rebase: true });
    expect(reply).toMatchObject({ mode: "rebase", commits: 1, files: ["other.txt"] });
    expect(sh(repo, "log", "--format=%s", "-3").trim().split("\n")).toEqual(["local work", "peer change", "init"]);
    expect(current(h)).toMatchObject({ ahead: 1, behind: 0 });

    // A rebase that conflicts is aborted: the branch is where it was.
    peerPush(peer, { "mine.txt": "theirs\n" }, "conflict");
    const before = sh(repo, "rev-parse", "HEAD").trim();
    await expect(h.engine.request({ type: "git_pull", rebase: true })).rejects.toThrow(/^pull_rebase_failed:/);
    expect(sh(repo, "rev-parse", "HEAD").trim()).toBe(before);
    expect(existsSync(join(repo, ".git", "rebase-merge")) || existsSync(join(repo, ".git", "rebase-apply"))).toBe(false);
    expect(read(repo, "mine.txt")).toBe("mine\n");
  });

  it("refused during a merge in progress, while Claude works, on a detached HEAD and without an upstream", async () => {
    const { repo, peer } = makeTrio();
    const h = harness();
    await h.hello();
    await h.open(repo);
    peerPush(peer, { "other.txt": "upstream\n" });

    // Claude works.
    await h.engine.handle({ type: "send", text: "work" });
    await h.waitFor((s) => s.gate.phase === "running", "turn running");
    expect(h.engine.state.branches.sync!.pullBlocker).toEqual({ kind: "running" });
    await expect(h.engine.request({ type: "git_pull" })).rejects.toThrow("pull_blocked:running");
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase !== "running" && s.gate.phase !== "collecting", "turn end");

    // An unfinished merge.
    sh(repo, "switch", "-q", "-c", "topic");
    write(repo, "README.md", "topic\n");
    sh(repo, "commit", "-qam", "topic");
    sh(repo, "switch", "-q", "main");
    write(repo, "README.md", "main\n");
    sh(repo, "commit", "-qam", "main");
    try {
      sh(repo, "merge", "-q", "topic");
    } catch {
      // the conflict is the point
    }
    await h.engine.request({ type: "branches" });
    expect(h.engine.state.branches.sync).toMatchObject({ operation: "merge", pullBlocker: { kind: "operation", operation: "merge" } });
    await expect(h.engine.request({ type: "git_pull" })).rejects.toThrow("pull_in_progress:merge");
    sh(repo, "merge", "--abort");

    // No upstream on a new branch; a detached HEAD.
    sh(repo, "switch", "-q", "-c", "local-only");
    await h.engine.request({ type: "branches" });
    expect(h.engine.state.branches.sync!.pullBlocker).toEqual({ kind: "noUpstream" });
    await expect(h.engine.request({ type: "git_pull" })).rejects.toThrow("pull_no_upstream:local-only");
    sh(repo, "switch", "-q", "--detach", "HEAD");
    await h.engine.request({ type: "branches" });
    expect(h.engine.state.branches.sync!.pullBlocker).toEqual({ kind: "detached" });
    await expect(h.engine.request({ type: "git_pull" })).rejects.toThrow("pull_blocked:detached");
  });
});
