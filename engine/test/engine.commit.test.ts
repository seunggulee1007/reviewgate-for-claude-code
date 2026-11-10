import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { suggestCommitMessage } from "../src/review/commitMessage.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, read, removeDir, sh, write } from "./helpers/repo.js";

/** `main` with README.md / other.txt / tomove.txt committed (resolved path: git prints /private/var on macOS). */
function makeRepo(identity = true): string {
  const dir = realpathSync(makeTempDir("rg-commit"));
  sh(dir, "init", "-q", "-b", "main");
  if (identity) {
    sh(dir, "config", "user.email", "test@example.com");
    sh(dir, "config", "user.name", "Test");
  }
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\n");
  write(dir, "other.txt", "other\n");
  write(dir, "tomove.txt", "move me\n");
  sh(dir, "add", "-A");
  sh(dir, "-c", "user.name=Init", "-c", "user.email=init@example.com", "commit", "-qm", "init");
  return dir;
}

/** A bare `origin` for `repo` (push URL = fetch URL = local path). */
function addOrigin(repo: string): string {
  const bare = track(makeTempDir("rg-commit-origin"));
  sh(bare, "init", "-q", "--bare", "-b", "main");
  sh(repo, "remote", "add", "origin", bare);
  return bare;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const savedEnv: Record<string, string | undefined> = {};
const track = (d: string): string => {
  dirs.push(d);
  return d;
};
function harness(): Harness {
  const h = makeHarness();
  harnesses.push(h);
  return h;
}
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

/** Sends `text`, ends the fake turn after `mutate()` ran, waits for the collection + refreshes. */
async function fakeTurn(h: Harness, mutate: () => void, text = "do it"): Promise<void> {
  await h.engine.handle({ type: "send", text });
  mutate();
  h.session().emitTurnEnd();
  await h.waitFor((s) => s.gate.turnEndTree !== null && s.gate.phase !== "collecting", "turn collection");
  await h.waitFor((s) => s.branches.list.length > 0 && s.workbenches.list.length > 0, "refresh after turn");
}

const lastMessage = (repo: string): string => sh(repo, "log", "-1", "--format=%B").trimEnd();
const lastFiles = (repo: string): string[] => sh(repo, "show", "--name-status", "--format=", "HEAD").trim().split("\n").filter(Boolean).map((l) => l.replace(/\t/g, " "));

describe("ReviewEngine commit / push (docs/M12-COMMIT.md)", () => {
  it("commit {push:false}: accepted files land in one commit, the pending one stays in review, A/B are re-snapshotted, a follow-up turn does not resurface them", async () => {
    const repo = track(makeRepo());
    const h = harness();
    await h.hello();
    const opened = await h.open(repo);
    expect(opened.commit).toEqual({ lastCommit: null, canCommit: false, acceptedPaths: [], suggestedMessage: "Apply accepted changes", identity: { name: "Test", email: "test@example.com" } });

    await fakeTurn(h, () => {
      write(repo, "a.txt", "a\n");
      write(repo, "b.txt", "b\n");
      write(repo, "README.md", "line1\nline2\nline3\n");
    }, "Add a and b, extend the README with a third line so that the subject line is definitely longer than seventy-two characters");
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => f.path)).toEqual(["README.md", "a.txt", "b.txt"]);
    expect(s.commit.canCommit).toBe(false); // nothing accepted yet
    await expect(h.engine.request({ type: "commit", message: "x" })).rejects.toThrow("nothing_to_commit");

    await h.engine.request({ type: "accept", paths: ["a.txt", "b.txt"] });
    s = h.engine.state;
    expect(s.commit.canCommit).toBe(true);
    expect(s.commit.acceptedPaths).toEqual(["a.txt", "b.txt"]);
    expect(s.commit.suggestedMessage).toBe("Add a and b, extend the README with a third line so that the subject li…\n\nFiles:\n- a.txt\n- b.txt");
    expect(s.commit.suggestedMessage.split("\n")[0]!.length).toBeLessThanOrEqual(72);
    // Refusals that leave the tree untouched.
    await expect(h.engine.request({ type: "commit", message: "   " })).rejects.toThrow("empty_message");
    await expect(h.engine.request({ type: "commit", message: "x", paths: [] })).rejects.toThrow("nothing_to_commit");
    await expect(h.engine.request({ type: "commit", message: "x", paths: ["a.txt", "README.md"] })).rejects.toThrow("nothing_to_commit");
    await expect(h.engine.request({ type: "push" })).rejects.toThrow("nothing_to_push");
    expect(sh(repo, "log", "--oneline").trim().split("\n")).toHaveLength(1);

    // The user edits the pending file after the turn: the re-snapshotted B must pick that up.
    const startBefore = s.gate.turnStartTree!;
    const endBefore = s.gate.turnEndTree!;
    write(repo, "README.md", "line1\nline2\nline3\nline4\n");
    const reply = await h.engine.request({ type: "commit", message: "Add a and b\n\nSecond paragraph.", push: false });
    const sha = sh(repo, "rev-parse", "HEAD").trim();
    expect(reply).toEqual({ type: "committed", id: reply.id, sha, shortSha: sha.slice(0, 7), pushed: false, branch: "main" });
    expect(lastMessage(repo)).toBe("Add a and b\n\nSecond paragraph.");
    expect(lastFiles(repo)).toEqual(["A a.txt", "A b.txt"]);
    expect(sh(repo, "log", "-1", "--format=%an <%ae>").trim()).toBe("Test <test@example.com>");
    expect(sh(repo, "status", "--porcelain").trimEnd()).toBe(" M README.md"); // the pending file is neither staged nor committed

    s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(s.gate.phase).toBe("reviewing");
    expect(s.commit.canCommit).toBe(false);
    expect(s.commit.acceptedPaths).toEqual([]);
    expect(s.commit.lastCommit).toMatchObject({ sha, shortSha: sha.slice(0, 7), message: "Add a and b\n\nSecond paragraph.", branch: "main", pushed: false, pushError: null, files: ["a.txt", "b.txt"] });
    expect(Date.parse(s.commit.lastCommit!.at)).toBeGreaterThan(0);
    expect(s.gate.turnEndTree).not.toBe(endBefore);
    expect(s.gate.turnStartTree).not.toBe(startBefore);
    // A now carries the committed files, so the remaining diff A..B is README.md only, including the late edit.
    expect(sh(repo, "cat-file", "-p", `${s.gate.turnStartTree}:a.txt`)).toBe("a\n");
    expect(sh(repo, "diff-tree", "-r", "--name-only", s.gate.turnStartTree!, s.gate.turnEndTree!).trim()).toBe("README.md");
    const diff = await h.engine.request({ type: "select_file", path: "README.md" });
    expect(diff.diff.hunks.flatMap((hk) => hk.lines).filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["line3", "line4"]);
    expect(s.gate.lastReviewSummary).toBe("[Review gate] Accepted: a.txt, b.txt."); // Claude still learns what was accepted
    expect(h.ofType("committed").map((e) => e.sha)).toEqual([sha]);
    expect(h.ofType("error")).toHaveLength(0);

    // Request changes on the pending file: the follow-up list (rebuilt from A) has no a/b in it.
    await h.engine.request({ type: "add_note", path: "README.md", line: 3, side: "new", excerpt: "line3", body: "call it line three" });
    await h.engine.request({ type: "request_changes" });
    write(repo, "README.md", "line1\nline2\nline three\nline4\n");
    h.session().emitTurnEnd();
    await h.waitFor((x) => x.gate.phase === "reviewing" && !x.gate.isRequestingChanges, "follow-up");
    s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["README.md", "pending"]]);
    expect(s.commit.suggestedMessage).toBe("Add a and b, extend the README with a third line so that the subject li…"); // no files yet; the last *user* text (not the request-changes message) makes the subject
    await h.engine.request({ type: "accept_all" });
    expect(h.engine.state.commit.suggestedMessage).toBe("Add a and b, extend the README with a third line so that the subject li…\n\nFiles:\n- README.md");
    await h.engine.request({ type: "commit", message: "README" });
    expect(lastFiles(repo)).toEqual(["M README.md"]);
    expect(sh(repo, "status", "--porcelain").trim()).toBe("");
    s = h.engine.state;
    expect(s.changedFiles).toEqual([]);
    expect(s.gate.phase).toBe("idle");
    expect(s.gate.canSend).toBe(true);
    expect(s.branches.isWorktreeDirty).toBe(false);
    expect(s.branches.switchBlocker).toBeNull(); // branches were refreshed after the commit
  });

  it("renames and deletions: both rename paths are staged, the commit shows R and D, the worktree ends clean", async () => {
    const repo = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(repo);
    await fakeTurn(h, () => {
      renameSync(join(repo, "tomove.txt"), join(repo, "moved.txt"));
      rmSync(join(repo, "other.txt"));
    });
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.oldPath, f.status])).toEqual([["moved.txt", "tomove.txt", "R"], ["other.txt", null, "D"]]);
    await h.engine.request({ type: "accept_all" });
    expect(h.engine.state.commit.acceptedPaths).toEqual(["moved.txt", "other.txt"]);
    await h.engine.request({ type: "commit", message: "Move and delete" });
    expect(lastFiles(repo).sort()).toEqual(["D other.txt", "R100 tomove.txt moved.txt"]);
    expect(sh(repo, "status", "--porcelain").trim()).toBe("");
    s = h.engine.state;
    expect(s.changedFiles).toEqual([]);
    expect(s.commit.lastCommit?.files).toEqual(["moved.txt", "other.txt"]);
    expect(sh(repo, "diff-tree", "-r", "--name-only", s.gate.turnStartTree!, s.gate.turnEndTree!).trim()).toBe("");
  });

  it("the user's own staged entries stay staged and out of the commit (git commit --only), renames and deletions included", async () => {
    const repo = track(makeRepo());
    write(repo, "notes.md", "my staged notes\n");
    write(repo, "README.md", "line1\nline2\nstaged line\n");
    sh(repo, "add", "notes.md", "README.md");
    write(repo, "README.md", "line1\nline2\nstaged line\nunstaged line\n"); // partly staged
    const stagedBefore = sh(repo, "diff", "--cached", "--name-status").trim();
    const readmeBlob = sh(repo, "rev-parse", ":README.md").trim();
    const h = harness();
    await h.hello();
    await h.open(repo);
    await fakeTurn(h, () => {
      renameSync(join(repo, "tomove.txt"), join(repo, "moved.txt"));
      rmSync(join(repo, "other.txt"));
      write(repo, "new.txt", "claude\n");
    });
    expect(h.engine.state.changedFiles.map((f) => f.path).sort()).toEqual(["moved.txt", "new.txt", "other.txt"]);
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "commit", message: "Claude's part" });
    expect(lastFiles(repo).sort()).toEqual(["A new.txt", "D other.txt", "R100 tomove.txt moved.txt"]);
    // Still staged exactly as the user left it (the partly-staged README keeps its staged blob).
    expect(sh(repo, "diff", "--cached", "--name-status").trim()).toBe(stagedBefore);
    expect(sh(repo, "rev-parse", ":README.md").trim()).toBe(readmeBlob);
    expect(read(repo, "README.md")).toBe("line1\nline2\nstaged line\nunstaged line\n");
    expect(sh(repo, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual(["A  notes.md", "MM README.md"]);
  });

  it("paths subset + commitTrailer: only the listed accepted files are committed, the trailer is appended once", async () => {
    const repo = track(makeRepo());
    const h = harness();
    await h.hello({ commitTrailer: "Co-Authored-By: Claude <noreply@anthropic.com>" });
    await h.open(repo);
    await fakeTurn(h, () => {
      write(repo, "a.txt", "a\n");
      write(repo, "b.txt", "b\n");
    });
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "commit", message: "Only a", paths: ["a.txt"] });
    expect(lastFiles(repo)).toEqual(["A a.txt"]);
    expect(lastMessage(repo)).toBe("Only a\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    expect(sh(repo, "log", "-1", "--format=%(trailers:key=Co-Authored-By,valueonly)").trim()).toBe("Claude <noreply@anthropic.com>");
    let s = h.engine.state;
    expect(s.changedFiles.map((f) => [f.path, f.state])).toEqual([["b.txt", "accepted"]]);
    expect(s.commit.canCommit).toBe(true);
    expect(s.commit.lastCommit?.message).toBe("Only a\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    // A message that already carries the trailer is not doubled.
    await h.engine.request({ type: "commit", message: "Then b\n\nCo-Authored-By: Claude <noreply@anthropic.com>" });
    expect(lastMessage(repo)).toBe("Then b\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    expect(lastFiles(repo)).toEqual(["A b.txt"]);
    s = h.engine.state;
    expect(s.changedFiles).toEqual([]);
    expect(s.gate.phase).toBe("idle");
  });

  it("refusals: no_project, session_running while a turn runs, git_identity_missing (no local/global identity)", async () => {
    const h = harness();
    await h.hello();
    await expect(h.engine.request({ type: "commit", message: "x" })).rejects.toThrow("no_project");
    await expect(h.engine.request({ type: "push" })).rejects.toThrow("no_project");

    // No repo-local identity, and git must not find a global/system one either.
    const home = track(makeTempDir("rg-commit-home"));
    setEnv("HOME", home);
    setEnv("XDG_CONFIG_HOME", join(home, ".config"));
    setEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
    setEnv("GIT_CONFIG_SYSTEM", join(home, "gitconfig-system"));
    setEnv("GIT_AUTHOR_NAME", undefined);
    setEnv("GIT_AUTHOR_EMAIL", undefined);
    setEnv("GIT_COMMITTER_NAME", undefined);
    setEnv("GIT_COMMITTER_EMAIL", undefined);
    const repo = track(makeRepo(false));
    const opened = await h.open(repo);
    expect(opened.commit.identity).toEqual({ name: null, email: null });

    await h.engine.handle({ type: "send", text: "work" });
    write(repo, "a.txt", "a\n");
    await expect(h.engine.request({ type: "commit", message: "x" })).rejects.toThrow("session_running");
    h.session().emitTurnEnd();
    await h.waitFor((s) => s.gate.phase === "reviewing", "reviewing");
    await h.engine.request({ type: "accept_all" });
    expect(h.engine.state.commit.canCommit).toBe(true);
    await expect(h.engine.request({ type: "commit", message: "x" })).rejects.toThrow("git_identity_missing:user.name and user.email not set");
    expect(sh(repo, "log", "--oneline").trim().split("\n")).toHaveLength(1);
    expect(h.engine.state.changedFiles.map((f) => f.state)).toEqual(["accepted"]); // still committable once configured

    // Setting only one of the two → the other is named.
    sh(repo, "config", "user.name", "Late");
    await expect(h.engine.request({ type: "commit", message: "x" })).rejects.toThrow("git_identity_missing:user.email not set");
    expect(h.engine.state.commit.identity).toEqual({ name: "Late", email: null }); // identity is re-read on every commit
    sh(repo, "config", "user.email", "late@example.com");
    await h.engine.request({ type: "commit", message: "x" });
    expect(sh(repo, "log", "-1", "--format=%an <%ae>").trim()).toBe("Late <late@example.com>");
    expect(h.engine.state.commit.identity).toEqual({ name: "Late", email: "late@example.com" });
  });

  it("push to a local bare origin: `-u origin <branch>` without an upstream, plain `git push` with one; commitPushByDefault", async () => {
    const repo = track(makeRepo());
    const bare = addOrigin(repo);
    const h = harness();
    await h.hello();
    await h.open(repo);
    expect(sh(repo, "for-each-ref", "--format=%(upstream)", "refs/heads/main").trim()).toBe(""); // no upstream yet

    await fakeTurn(h, () => write(repo, "a.txt", "a\n"));
    await h.engine.request({ type: "accept_all" });
    const reply = await h.engine.request({ type: "commit", message: "first", push: true });
    const sha1 = sh(repo, "rev-parse", "HEAD").trim();
    expect(reply).toMatchObject({ type: "committed", sha: sha1, pushed: true, branch: "main" });
    expect(sh(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").trim()).toBe("origin/main");
    expect(sh(bare, "rev-parse", "main").trim()).toBe(sha1);
    let s = h.engine.state;
    expect(s.commit.lastCommit).toMatchObject({ sha: sha1, pushed: true, pushError: null, files: ["a.txt"] });
    expect(s.branches.list.find((b) => b.name === "main")).toMatchObject({ upstream: "origin/main", ahead: 0, behind: 0 });

    // With the upstream set: `git push` (no -u), driven by commitPushByDefault when the command omits `push`.
    await h.engine.handle({ type: "set_settings", settings: { commitPushByDefault: true } });
    await fakeTurn(h, () => write(repo, "b.txt", "b\n"));
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "commit", message: "second" });
    const sha2 = sh(repo, "rev-parse", "HEAD").trim();
    expect(sha2).not.toBe(sha1);
    expect(sh(bare, "rev-parse", "main").trim()).toBe(sha2);
    s = h.engine.state;
    expect(s.commit.lastCommit).toMatchObject({ sha: sha2, pushed: true, pushError: null });
    expect(h.ofType("committed").map((e) => [e.shortSha, e.pushed])).toEqual([[sha1.slice(0, 7), true], [sha2.slice(0, 7), true]]);

    // An explicit push:false wins over the setting.
    await fakeTurn(h, () => write(repo, "c.txt", "c\n"));
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "commit", message: "third", push: false });
    const sha3 = sh(repo, "rev-parse", "HEAD").trim();
    expect(sh(bare, "rev-parse", "main").trim()).toBe(sha2);
    expect(h.engine.state.commit.lastCommit).toMatchObject({ sha: sha3, pushed: false, pushError: null });
    expect(h.engine.state.branches.list.find((b) => b.name === "main")?.ahead).toBe(1);
    // `push {}` catches up.
    const pushed = await h.engine.request({ type: "push" });
    expect(pushed).toMatchObject({ type: "committed", sha: sha3, pushed: true, branch: "main" });
    expect(sh(bare, "rev-parse", "main").trim()).toBe(sha3);
    expect(h.engine.state.branches.list.find((b) => b.name === "main")?.ahead).toBe(0);
  });

  it("commit {push:true} without a remote → commit stays, `no_remote`; a failed push is retried with `push {}`", async () => {
    const repo = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(repo);
    await fakeTurn(h, () => write(repo, "a.txt", "a\n"));
    await h.engine.request({ type: "accept_all" });
    await expect(h.engine.request({ type: "commit", message: "first", push: true })).rejects.toThrow("no_remote");
    const sha1 = sh(repo, "rev-parse", "HEAD").trim();
    expect(lastFiles(repo)).toEqual(["A a.txt"]);
    let s = h.engine.state;
    expect(s.changedFiles).toEqual([]); // the review was still updated
    expect(s.commit.lastCommit).toMatchObject({ sha: sha1, pushed: false, pushError: "no_remote" });
    expect(h.ofType("committed")).toHaveLength(0); // the reply was result{ok:false}
    expect(h.ofType("error")).toHaveLength(0); // a refusal, not an error event
    await expect(h.engine.request({ type: "push" })).rejects.toThrow("no_remote");

    // An origin that is not reachable: push_failed:<first stderr line>; restore it → `push {}` succeeds.
    const bare = addOrigin(repo);
    const hidden = bare + "-hidden";
    renameSync(bare, hidden);
    dirs.push(hidden);
    await expect(h.engine.request({ type: "push" })).rejects.toThrow(/^push_failed:.+/);
    s = h.engine.state;
    expect(s.commit.lastCommit?.pushed).toBe(false);
    expect(s.commit.lastCommit?.pushError).toMatch(/^push_failed:/);
    expect(s.commit.lastCommit?.pushError?.split("\n")).toHaveLength(1);
    renameSync(hidden, bare);
    const reply = await h.engine.request({ type: "push" });
    expect(reply).toMatchObject({ type: "committed", sha: sha1, pushed: true, branch: "main" });
    expect(sh(bare, "rev-parse", "main").trim()).toBe(sha1);
    expect(sh(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").trim()).toBe("origin/main");
    s = h.engine.state;
    expect(s.commit.lastCommit).toMatchObject({ sha: sha1, pushed: true, pushError: null });

    // The bare repository going read-only mid-way is also a push_failed, and the commit is untouched.
    await fakeTurn(h, () => write(repo, "b.txt", "b\n"));
    await h.engine.request({ type: "accept_all" });
    mkdirSync(join(bare, "hooks"), { recursive: true });
    write(bare, "hooks/pre-receive", "#!/bin/sh\necho 'nope from hook' >&2\nexit 1\n");
    chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
    await expect(h.engine.request({ type: "commit", message: "second", push: true })).rejects.toThrow("push_failed:");
    const sha2 = sh(repo, "rev-parse", "HEAD").trim();
    expect(h.engine.state.commit.lastCommit).toMatchObject({ sha: sha2, pushed: false });
    expect(h.engine.state.commit.lastCommit?.pushError).toContain("push_failed:");
    expect(sh(bare, "rev-parse", "main").trim()).toBe(sha1);
    rmSync(join(bare, "hooks", "pre-receive"));
    await h.engine.request({ type: "push" });
    expect(sh(bare, "rev-parse", "main").trim()).toBe(sha2);
    expect(h.engine.state.commit.lastCommit).toMatchObject({ sha: sha2, pushed: true, pushError: null });
  });

  it("close_project / open_project reset the commit slice", async () => {
    const repo = track(makeRepo());
    const h = harness();
    await h.hello();
    await h.open(repo);
    await fakeTurn(h, () => write(repo, "a.txt", "a\n"));
    await h.engine.request({ type: "accept_all" });
    await h.engine.request({ type: "commit", message: "first" });
    expect(h.engine.state.commit.lastCommit).not.toBeNull();
    await h.engine.handle({ type: "close_project" });
    await h.settle();
    expect(h.engine.state.commit).toEqual({ lastCommit: null, canCommit: false, acceptedPaths: [], suggestedMessage: "Apply accepted changes", identity: { name: null, email: null } });
    expect(existsSync(join(repo, "a.txt"))).toBe(true);
    expect(read(repo, "a.txt")).toBe("a\n");
  });

  it("suggestCommitMessage: first non-[Review gate] line, ≤ 72 chars, file list", () => {
    expect(suggestCommitMessage(null, [])).toBe("Apply accepted changes");
    expect(suggestCommitMessage("  \n\n", ["a"])).toBe("Apply accepted changes\n\nFiles:\n- a");
    expect(suggestCommitMessage("Fix the bug\nmore detail", ["src/a.ts", "b.md"])).toBe("Fix the bug\n\nFiles:\n- src/a.ts\n- b.md");
    expect(suggestCommitMessage("[Review gate] Accepted: a.txt.\n\nRename the helper", ["a"])).toBe("Rename the helper\n\nFiles:\n- a");
    expect(suggestCommitMessage("[Review gate] Accepted: a. Rejected (reverted on disk, do not redo unless asked): b.", [])).toBe("Apply accepted changes");
    const long = "x".repeat(100);
    const subject = suggestCommitMessage(long, []).split("\n")[0]!;
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("…")).toBe(true);
    expect(suggestCommitMessage("y".repeat(72), [])).toBe("y".repeat(72));
  });
});
