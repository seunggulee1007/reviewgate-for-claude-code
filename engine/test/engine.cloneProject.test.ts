import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyCloneError,
  cloneErrorLine,
  cloneFolderName,
  clonedAlready,
  parseCloneProgressLine,
  parseCloneSource,
  redactCredentials,
  startClone,
  type CloneProgress,
  type CloneSource,
} from "../src/git/cloneProject.js";
import { getGitPath, setGitPath } from "../src/git/exec.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §74: `project_clone_preview`, `project_clone` and `project_clone_cancel` — clone from git. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string) => (dirs.push(d), d);
const isWindows = process.platform === "win32";
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const source = (input: string) => parseCloneSource(input) as CloneSource;

/** A repository with one commit on `main` and one on `dev`, and a bare copy of it to clone from. */
function bareRepo(root: string): string {
  const work = join(root, "work");
  mkdirSync(work);
  sh(work, "init", "-q", "-b", "main");
  write(work, "README.md", "# widgets\n");
  sh(work, "add", "README.md");
  sh(work, "-c", "user.name=Dev", "-c", "user.email=dev@example.com", "commit", "-q", "-m", "first");
  sh(work, "checkout", "-q", "-b", "dev");
  write(work, "dev.txt", "dev\n");
  sh(work, "add", "dev.txt");
  sh(work, "-c", "user.name=Dev", "-c", "user.email=dev@example.com", "commit", "-q", "-m", "dev");
  sh(work, "checkout", "-q", "main");
  const bare = join(root, "widgets.git");
  sh(root, "clone", "-q", "--bare", work, bare);
  return bare;
}

/** A stand-in for git: prints a progress line, then sleeps (as a clone waiting on a slow network). */
function slowGit(root: string): string {
  const path = join(root, "slow-git");
  writeFileSync(path, "#!/bin/sh\nprintf 'Receiving objects:  10%% (1/10)\\r' >&2\nexec sleep 30\n");
  chmodSync(path, 0o755);
  return path;
}

describe("§74 parseCloneSource", () => {
  it("https, ssh, the scp form and GitHub's shorthand", () => {
    expect(parseCloneSource("https://github.com/acme/widgets.git")).toEqual({ url: "https://github.com/acme/widgets.git", repo: "acme/widgets", host: "github.com", branch: null, name: "widgets" });
    expect(parseCloneSource("git@github.com:acme/widgets.git")).toEqual({ url: "git@github.com:acme/widgets.git", repo: "acme/widgets", host: "github.com", branch: null, name: "widgets" });
    expect(parseCloneSource("acme/widgets")).toEqual({ url: "https://github.com/acme/widgets.git", repo: "acme/widgets", host: "github.com", branch: null, name: "widgets" });
    expect(parseCloneSource("acme/widgets.git")).toMatchObject({ url: "https://github.com/acme/widgets.git", name: "widgets" });
    expect(parseCloneSource("ssh://git@git.example.com:2222/team/app.git")).toMatchObject({ url: "ssh://git@git.example.com:2222/team/app.git", repo: "team/app", host: "git.example.com", name: "app" });
    expect(parseCloneSource("https://gitlab.example.com/group/sub/tool")).toMatchObject({ url: "https://gitlab.example.com/group/sub/tool", host: "gitlab.example.com", name: "tool" });
  });

  it("odd inputs: spaces around, a browser link, a link without its scheme, a pasted git clone command, a trailing slash", () => {
    expect(parseCloneSource("  https://github.com/acme/widgets/  ")).toMatchObject({ url: "https://github.com/acme/widgets.git", name: "widgets" });
    expect(parseCloneSource("https://github.com/acme/widgets/tree/feature/login")).toMatchObject({ url: "https://github.com/acme/widgets.git", branch: "feature/login" });
    expect(parseCloneSource("https://github.com/acme/widgets/issues/42")).toMatchObject({ url: "https://github.com/acme/widgets.git", branch: null });
    expect(parseCloneSource("https://www.github.com/acme/widgets?tab=readme#top")).toMatchObject({ url: "https://github.com/acme/widgets.git", host: "github.com" });
    expect(parseCloneSource("github.com/acme/widgets")).toMatchObject({ url: "https://github.com/acme/widgets.git", repo: "acme/widgets" });
    expect(parseCloneSource("git clone -b dev git@github.com:acme/widgets.git my-copy")).toMatchObject({ url: "git@github.com:acme/widgets.git", branch: "dev", name: "widgets" });
    expect(parseCloneSource("<https://github.com/acme/widgets.git>")).toMatchObject({ repo: "acme/widgets" });
    expect(parseCloneSource("https://git.example.com/team/app.git?x=1")).toMatchObject({ url: "https://git.example.com/team/app.git", name: "app" });
  });

  it("local paths and file URLs (a repository on this computer or a share)", () => {
    expect(parseCloneSource("/srv/git/widgets.git")).toEqual({ url: "/srv/git/widgets.git", repo: "widgets", host: null, branch: null, name: "widgets" });
    expect(parseCloneSource("file:///srv/git/widgets.git/")).toMatchObject({ url: "file:///srv/git/widgets.git/", host: null, name: "widgets" });
    expect(parseCloneSource("C:\\repos\\widgets")).toMatchObject({ url: "C:\\repos\\widgets", host: null, name: "widgets" });
  });

  it("refuses credentials in the URL — the user's own sign-in is used instead", () => {
    expect(parseCloneSource("https://dev:s3cret@github.com/acme/widgets.git")).toEqual({ code: "url_has_credentials", detail: "" });
    expect(parseCloneSource("https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/widgets.git")).toEqual({ code: "url_has_credentials", detail: "" });
    expect(parseCloneSource("https://x-access-token@github.com/acme/widgets.git")).toEqual({ code: "url_has_credentials", detail: "" });
    // A user name alone is a name (Azure DevOps puts the organisation there), not a credential.
    expect(parseCloneSource("https://acme@dev.azure.example.com/acme/proj/_git/widgets")).toMatchObject({ name: "widgets" });
  });

  it("refuses what is no repository: empty, spaces, an option, a transport helper, an unknown scheme, a bare word", () => {
    expect(parseCloneSource("")).toEqual({ code: "bad_url", detail: "empty" });
    expect(parseCloneSource("   ")).toEqual({ code: "bad_url", detail: "empty" });
    expect(parseCloneSource("acme widgets")).toEqual({ code: "bad_url", detail: "spaces" });
    expect(parseCloneSource("--upload-pack=touch /tmp/x")).toMatchObject({ code: "bad_url" });
    expect(parseCloneSource("-uhttps://example.com/x")).toEqual({ code: "bad_url", detail: "option" });
    expect(parseCloneSource("ext::sh -c touch% /tmp/pwned")).toMatchObject({ code: "bad_url" });
    expect(parseCloneSource("ext::ssh")).toEqual({ code: "bad_url", detail: "transport" });
    expect(parseCloneSource("ftp://example.com/acme/widgets.git")).toEqual({ code: "bad_url", detail: "scheme ftp" });
    expect(parseCloneSource("widgets")).toEqual({ code: "bad_url", detail: "not a repository" });
    expect(parseCloneSource("https://github.com/")).toEqual({ code: "bad_url", detail: "no repository" });
  });

  it("the folder name keeps the repository's case and drops what a folder cannot hold", () => {
    expect(cloneFolderName("ReviewGate")).toBe("ReviewGate");
    expect(cloneFolderName("  my repo: v2?  ")).toBe("my-repo-v2");
    expect(cloneFolderName("../../etc")).toBe("etc");
    expect(cloneFolderName("...")).toBe("repo");
    expect(cloneFolderName("nul")).toBe("nul-repo");
    expect(cloneFolderName("위젯-저장소")).toBe("위젯-저장소");
    expect(cloneFolderName("x".repeat(150))).toHaveLength(100);
  });

  it("redacts a credential anywhere in a text", () => {
    expect(redactCredentials("fatal: unable to access 'https://dev:s3cret@github.com/acme/w.git/': 403")).toBe("fatal: unable to access 'https://***@github.com/acme/w.git/': 403");
  });
});

describe("§74 progress and errors", () => {
  it("reads git's progress lines into a phase and the whole clone's percent", () => {
    expect(parseCloneProgressLine("remote: Counting objects:  50% (5/10)")).toEqual({ phase: "counting", percent: 2, phasePercent: 50, detail: null });
    expect(parseCloneProgressLine("remote: Enumerating objects: 12, done.")).toEqual({ phase: "counting", percent: 0, phasePercent: null, detail: null });
    expect(parseCloneProgressLine("Receiving objects:  45% (450/1000), 1.20 MiB | 512.00 KiB/s")).toEqual({ phase: "receiving", percent: 43, phasePercent: 45, detail: "1.20 MiB | 512.00 KiB/s" });
    expect(parseCloneProgressLine("Receiving objects: 100% (1000/1000), 2.50 MiB | 1.00 MiB/s, done.")).toMatchObject({ phase: "receiving", percent: 88, detail: "2.50 MiB | 1.00 MiB/s" });
    expect(parseCloneProgressLine("Resolving deltas: 100% (30/30), done.")).toMatchObject({ phase: "resolving", percent: 96 });
    expect(parseCloneProgressLine("Updating files:  50% (5/10)")).toMatchObject({ phase: "checkout", percent: 98 });
    expect(parseCloneProgressLine("Cloning into 'widgets'...")).toBeNull();
  });

  it("maps git's messages to §74.3's reasons", () => {
    expect(classifyCloneError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("clone_auth_failed");
    expect(classifyCloneError("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/w.git/'")).toBe("clone_auth_failed");
    expect(classifyCloneError("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe("clone_auth_failed");
    expect(classifyCloneError("ERROR: Repository not found.\nfatal: Could not read from remote repository.")).toBe("clone_not_found");
    expect(classifyCloneError("remote: Repository not found.\nfatal: repository 'https://github.com/acme/nope.git/' not found")).toBe("clone_not_found");
    expect(classifyCloneError("fatal: repository '/srv/git/nope' does not exist")).toBe("clone_not_found");
    expect(classifyCloneError("fatal: unable to access 'https://github.com/acme/w.git/': Could not resolve host: github.com")).toBe("clone_network");
    expect(classifyCloneError("ssh: connect to host github.com port 22: Network is unreachable")).toBe("clone_network");
    expect(classifyCloneError("fatal: unable to access 'https://git.example.com/a/b.git/': Failed to connect to git.example.com port 443: Connection refused")).toBe("clone_network");
    expect(classifyCloneError("warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin")).toBe("clone_branch_not_found");
    expect(classifyCloneError("fatal: destination path 'w' already exists and is not an empty directory.")).toBe("clone_folder_exists");
    expect(classifyCloneError("fatal: something else")).toBe("clone_failed");
  });

  it("the reason line skips progress and hints, and never carries a credential", () => {
    const stderr = "Cloning into 'w'...\rremote: Counting objects: 100% (3/3), done.\nhint: try again\nfatal: unable to access 'https://dev:tok@github.com/acme/w.git/': The requested URL returned error: 403\n";
    expect(cloneErrorLine(stderr)).toBe("unable to access 'https://***@github.com/acme/w.git/': The requested URL returned error: 403");
  });
});

describe("§74 startClone", () => {
  it("clones a local bare repository with progress, a branch when asked", async () => {
    const root = track(realpathSync(makeTempDir("rg-clone")));
    const bare = bareRepo(root);
    const into = join(root, "copy");
    mkdirSync(into);
    const seen: CloneProgress[] = [];
    await startClone({ git: getGitPath(), source: { url: pathToFileURL(bare).href }, branch: "dev", path: into, onProgress: (p) => seen.push(p) }).done;
    expect(existsSync(join(into, "dev.txt"))).toBe(true);
    expect(sh(into, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("dev");
    expect(seen[0]).toEqual({ phase: "connecting", percent: 0, phasePercent: null, detail: null });
    expect(seen.some((p) => p.phase === "receiving")).toBe(true);
  });

  it("each failure removes the folder: not found, a missing branch, git missing", async () => {
    const root = track(realpathSync(makeTempDir("rg-clone-fail")));
    const bare = bareRepo(root);
    const attempt = async (url: string, branch: string | null, git = getGitPath()) => {
      const into = join(root, `try-${Math.random().toString(36).slice(2)}`);
      mkdirSync(into);
      const err = await startClone({ git, source: { url }, branch, path: into, onProgress: () => undefined }).done.then(() => null, (e: Error) => e.message);
      expect(existsSync(into)).toBe(false);
      return err;
    };
    expect(await attempt(join(root, "nope.git"), null)).toMatch(/^clone_not_found:/);
    expect(await attempt(pathToFileURL(bare).href, "nope")).toMatch(/^clone_branch_not_found:/);
    expect(await attempt(pathToFileURL(bare).href, null, join(root, "no-such-git"))).toBe("git_missing");
  });

  it.skipIf(isWindows)("cancel kills git and removes the partial folder; no output for too long is a timeout", async () => {
    const root = track(realpathSync(makeTempDir("rg-clone-cancel")));
    const git = slowGit(root);
    const into = join(root, "partial");
    mkdirSync(into);
    writeFileSync(join(into, "half-written"), "x");
    const seen: CloneProgress[] = [];
    const run = startClone({ git, source: { url: "https://github.com/acme/widgets.git" }, branch: null, path: into, onProgress: (p) => seen.push(p) });
    await expect.poll(() => seen.some((p) => p.phase === "receiving")).toBe(true);
    run.cancel();
    await expect(run.done).rejects.toThrow("clone_cancelled");
    expect(existsSync(into)).toBe(false);

    const stuck = join(root, "stuck");
    mkdirSync(stuck);
    const slow = startClone({ git, source: { url: "https://github.com/acme/widgets.git" }, branch: null, path: stuck, onProgress: () => undefined, idleTimeoutMs: 300 });
    await expect(slow.done).rejects.toThrow("clone_timeout");
    expect(existsSync(stuck)).toBe(false);
  });
});

describe("§74 project_clone_preview / project_clone / project_clone_cancel", () => {
  it("a recent project that already has the repository is offered instead (same owner/repo, same host)", async () => {
    const root = track(realpathSync(makeTempDir("rg-clone-match")));
    const mine = join(root, "my-widgets");
    mkdirSync(mine);
    sh(mine, "init", "-q");
    sh(mine, "remote", "add", "origin", "git@github.com:ACME/Widgets.git");
    const ghe = join(root, "ghe-widgets");
    mkdirSync(ghe);
    sh(ghe, "init", "-q");
    sh(ghe, "remote", "add", "origin", "https://ghe.example.com/acme/widgets.git");
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    const parent = join(root, "projects");
    expect(await h.engine.request({ type: "project_clone_preview", url: "acme/widgets", parent, paths: [ghe, mine, "relative"] })).toMatchObject({
      type: "project_clone_preview",
      url: "https://github.com/acme/widgets.git",
      repo: "acme/widgets",
      host: "github.com",
      branch: null,
      name: "widgets",
      parent,
      path: join(parent, "widgets"),
      matches: [mine],
    });
    expect(await clonedAlready(source("https://ghe.example.com/acme/widgets"), [mine, ghe])).toEqual([ghe]);
    mkdirSync(join(parent, "Widgets-Copy"), { recursive: true });
    expect(await h.engine.request({ type: "project_clone_preview", url: "acme/widgets", name: "Widgets Copy", parent })).toMatchObject({ name: "Widgets-Copy", path: join(parent, "Widgets-Copy-2"), matches: [] });
    await expect(h.engine.request({ type: "project_clone_preview", url: "https://dev:pw@github.com/acme/widgets.git", parent })).rejects.toThrow("url_has_credentials");
    await expect(h.engine.request({ type: "project_clone_preview", url: "nope", parent })).rejects.toThrow("bad_url");
    await expect(h.engine.request({ type: "project_clone_preview", url: "acme/widgets", parent: "relative" })).rejects.toThrow("bad_parent");
  });

  it("clones into <parent>/<name> (a taken name gets -2) with progress, then opens it", async () => {
    const root = track(realpathSync(makeTempDir("rg-clone-engine")));
    const bare = bareRepo(root);
    const parent = join(root, "projects");
    mkdirSync(join(parent, "widgets"), { recursive: true });
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    const reply = await h.engine.request({ type: "project_clone", url: pathToFileURL(bare).href, parent });
    expect(reply).toEqual(expect.objectContaining({ type: "project_cloned", path: join(parent, "widgets-2") }));
    expect(existsSync(join(parent, "widgets-2", "README.md"))).toBe(true);
    const progress = h.ofType("project_clone_progress");
    expect(progress[0]).toMatchObject({ path: join(parent, "widgets-2"), phase: "connecting" });
    const st = await h.waitFor((s) => s.project !== null, "project open");
    expect(realpathSync(st.project!.root)).toBe(realpathSync(join(parent, "widgets-2")));
  });

  it("refusals leave nothing behind: not found, credentials, a bad branch; a cancel removes the folder", async () => {
    const root = track(realpathSync(makeTempDir("rg-clone-refuse")));
    const parent = join(root, "projects");
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await expect(h.engine.request({ type: "project_clone", url: join(root, "missing.git"), parent })).rejects.toThrow(/^clone_not_found/);
    await expect(h.engine.request({ type: "project_clone", url: "https://a:b@github.com/acme/w.git", parent })).rejects.toThrow("url_has_credentials");
    await expect(h.engine.request({ type: "project_clone", url: "acme/widgets", branch: "--upload-pack=x", parent })).rejects.toThrow("bad_branch");
    expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
    expect(h.engine.state.project).toBeNull();
    if (isWindows) return;
    const real = getGitPath();
    setGitPath(slowGit(root));
    try {
      const pending = h.engine.request({ type: "project_clone", url: "acme/widgets", parent });
      await expect.poll(() => h.ofType("project_clone_progress").some((p) => p.phase === "receiving")).toBe(true);
      expect(existsSync(join(parent, "widgets"))).toBe(true);
      await h.engine.request({ type: "project_clone_cancel" });
      await expect(pending).rejects.toThrow("clone_cancelled");
      expect(existsSync(join(parent, "widgets"))).toBe(false);
    } finally {
      setGitPath(real);
    }
  });
});
