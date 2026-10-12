import { chmodSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkbenchProgressEvent, WorkbenchSetup } from "../src/protocol.js";
import { fakePlatform, makeHarness, testSettings, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §36.12 (market-02) / §36.14 (market-07): workbench setup, remote bases and PR heads. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
const posix = process.platform !== "win32";

type Fixture = { dir: string; origin: string; seed: string; developTip: string; prHead: string; worktrees: string };

/**
 * A bare `origin` (main, develop, refs/pull/12/head) and a clone `acme` of it whose origin/develop is one commit behind;
 * the clone has an untracked `mvnw` and an ignored `config/local/dev-certs.yml`.
 */
function fixture(): Fixture {
  const base = tmp("rg-wbe");
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  sh(base, "init", "-q", "--bare", "-b", "main", origin);
  // MARK: wave4b w4b-check4 — CI hardening: a push may start `git gc --auto` in the background (receive.autogc), which
  // repacks / prunes origin's objects while a later clone or fetch reads them (ENOENT once on CI). No auto gc, and clones
  // through the git transport instead of hard-linking origin's object files.
  sh(origin, "config", "gc.auto", "0");
  sh(origin, "config", "receive.autogc", "false");
  sh(base, "clone", "-q", "--no-local", origin, seed);
  sh(seed, "config", "gc.auto", "0");
  sh(seed, "config", "user.email", "t@example.com");
  sh(seed, "config", "user.name", "T");
  write(seed, ".gitignore", "config/local/dev-certs.yml\n");
  write(seed, "README.md", "readme\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "init");
  sh(seed, "push", "-q", "origin", "HEAD:main");
  sh(seed, "switch", "-q", "-c", "develop");
  write(seed, "dev.txt", "dev 1\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "develop 1");
  sh(seed, "push", "-q", "origin", "develop");
  const dir = join(base, "acme");
  sh(base, "clone", "-q", "--no-local", origin, dir);
  sh(dir, "config", "gc.auto", "0");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "T");
  // origin moves on after the clone: only a fetch brings develop 2.
  write(seed, "dev.txt", "dev 2\n");
  sh(seed, "commit", "-qam", "develop 2");
  sh(seed, "push", "-q", "origin", "develop");
  const developTip = sh(seed, "rev-parse", "HEAD").trim();
  sh(seed, "switch", "-q", "-c", "pr-work", "main");
  write(seed, "pr.txt", "from the PR\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-qm", "PR head");
  sh(seed, "push", "-q", "origin", "HEAD:refs/pull/12/head");
  const prHead = sh(seed, "rev-parse", "HEAD").trim();
  write(dir, "mvnw", "#!/bin/sh\necho mvnw\n");
  chmodSync(join(dir, "mvnw"), 0o755);
  write(dir, "config/local/dev-certs.yml", "ssl: true\n");
  return { dir, origin, seed, developTip, prHead, worktrees: join(base, "managed") };
}

const SETUP: WorkbenchSetup = { copy: ["mvnw", "**/dev-certs.yml"], setupCommand: posix ? "echo setup-ran in $(basename $(pwd)) && test -x mvnw" : "echo setup-ran", location: "managed" };

async function setup(f: Fixture, workbenchSetup: WorkbenchSetup | undefined = SETUP): Promise<Harness> {
  // The setup command runs through this OS's shell (cmd.exe on Windows): the harness's fake platform says which.
  const platform = { ...fakePlatform, isWindows: !posix };
  const h = makeHarness({ platform, env: { CLAUDE_CONFIG_DIR: "/nonexistent/reviewgate-test-claude-config", SHELL: "/bin/sh", PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  harnesses.push(h);
  await h.hello({ worktreeRoot: f.worktrees, ...(workbenchSetup ? { workbenchSetup } : {}) });
  await h.open(f.dir);
  return h;
}

const progressOf = (h: Harness, path: string): WorkbenchProgressEvent[] => h.ofType("workbench_progress").filter((e) => e.path === path);

/** (step, exitCode) with consecutive repeats collapsed. */
function collapse(steps: WorkbenchProgressEvent[]): [string, number | null | undefined][] {
  const out: [string, number | null | undefined][] = [];
  for (const s of steps) {
    const last = out.at(-1);
    if (!last || last[0] !== s.step || last[1] !== s.exitCode) out.push([s.step, s.exitCode]);
  }
  return out;
}

describe("§36.12 workbench setup", () => {
  it("preview lists the files to copy; create fetches the remote base, copies, runs the setup and reports each step before its reply", async () => {
    const f = fixture();
    const h = await setup(f);
    const preview = await h.engine.request({ type: "workbench_preview", branch: "feature/acme/4790", from: "origin/develop" });
    const managed = h.engine.state.workbenches.managedRoot!;
    expect(preview.path).toBe(join(managed, "feature-acme-4790"));
    expect(preview.copy).toEqual([
      { path: "config/local/dev-certs.yml", bytes: 10 },
      { path: "mvnw", bytes: statSync(join(f.dir, "mvnw")).size },
    ]);
    expect(preview.totalBytes).toBe(preview.copy.reduce((n, c) => n + c.bytes, 0));
    expect(preview.count).toBe(2);
    expect(preview.truncated).toBeUndefined();
    const sibling = await h.engine.request({ type: "workbench_preview", branch: "feature/acme/4790", location: "sibling" });
    expect(sibling.path).toBe(join(dirname(f.dir), "acme-4790"));
    await expect(h.engine.request({ type: "workbench_preview", branch: "bad..name" })).rejects.toThrow(/invalid_branch_name/);

    await h.engine.request({ type: "workbench_create", branch: "feature/acme/4790", from: "origin/develop" });
    const path = preview.path;
    const steps = progressOf(h, path);
    // Each step starts (no exitCode); fetch / setup end with theirs; a running setup's log updates collapse here.
    expect(collapse(steps)).toEqual([["fetch", undefined], ["fetch", 0], ["create", undefined], ["copy", undefined], ["setup", undefined], ["setup", 0], ["done", 0]]);
    expect(steps.every((s) => s.branch === "feature/acme/4790")).toBe(true);
    expect(steps.find((s) => s.step === "copy" && s.logTail)?.logTail).toContain("Copied 2 of 2");
    const setupEnd = steps.find((s) => s.step === "setup" && s.exitCode !== undefined)!;
    expect(setupEnd.logTail).toContain("setup-ran");
    // The reply comes after "done".
    const doneAt = h.events.findIndex((e) => e.type === "workbench_progress" && e.step === "done" && e.path === path);
    const replyAt = h.events.findIndex((e, i) => i > doneAt && e.type === "result");
    expect(doneAt).toBeGreaterThan(-1);
    expect(replyAt).toBeGreaterThan(doneAt);
    // A fresh base (develop 2), no upstream, the local files there.
    expect(sh(path, "rev-parse", "HEAD").trim()).toBe(f.developTip);
    expect(() => sh(path, "rev-parse", "--abbrev-ref", "@{u}")).toThrow();
    expect(readFileSync(join(path, "config/local/dev-certs.yml"), "utf8")).toBe("ssl: true\n");
    if (posix) expect(statSync(join(path, "mvnw")).mode & 0o111).not.toBe(0);
    expect(h.engine.state.workbenches.list.some((w) => w.path === path && w.branch === "feature/acme/4790")).toBe(true);
    // remotes are bases, never part of the switcher's list.
    await h.engine.request({ type: "branches" });
    const remotes = h.engine.state.branches.remotes ?? [];
    expect(remotes.map((r) => r.name)).toEqual(expect.arrayContaining(["origin/develop", "origin/main"]));
    expect(remotes.every((r) => r.remote === true && !r.name.endsWith("/HEAD"))).toBe(true);
    expect(h.engine.state.branches.list.some((b) => b.name.startsWith("origin/"))).toBe(false);
  });

  it("a failed setup still creates the workbench (done repeats its exit code); setup:false copies and runs nothing; sibling folders; its own lane", async () => {
    const f = fixture();
    const h = await setup(f, { ...SETUP, setupCommand: posix ? "echo boom >&2; exit 4" : "exit 4", location: "sibling" });
    await h.engine.request({ type: "workbench_create", branch: "feature/acme/4791", from: "main" });
    const path = join(dirname(f.dir), "acme-4791");
    expect(existsSync(path)).toBe(true);
    const steps = progressOf(h, path);
    expect(steps.some((s) => s.step === "fetch")).toBe(false); // a local base is not fetched
    const end = steps.find((s) => s.step === "setup" && s.exitCode !== undefined)!;
    expect(end.exitCode).toBe(4);
    if (posix) expect(end.logTail).toContain("boom");
    expect(steps.at(-1)).toMatchObject({ step: "done", exitCode: 4 });

    await h.engine.request({ type: "workbench_create", branch: "plain", from: "main", setup: false, location: "managed" });
    const plain = join(h.engine.state.workbenches.managedRoot!, "plain");
    expect(progressOf(h, plain).map((s) => s.step)).toEqual(["create", "done"]);
    expect(progressOf(h, plain).at(-1)!.exitCode).toBeUndefined();
    expect(existsSync(join(plain, "mvnw"))).toBe(false);

    // A long setup never holds up the main lane.
    const slow = { ...SETUP, setupCommand: posix ? "sleep 3" : "ping -n 4 127.0.0.1 > nul", location: "managed" as const };
    await h.engine.handle({ type: "set_settings", settings: { ...testSettings, worktreeRoot: f.worktrees, workbenchSetup: slow } });
    let created = false;
    const pending = h.engine.request({ type: "workbench_create", branch: "slow-one", from: "main" }).then(() => (created = true));
    await new Promise((r) => setTimeout(r, 300));
    await h.engine.request({ type: "tool_output", toolUseId: "nope" });
    expect(created).toBe(false);
    await pending;
    expect(created).toBe(true);
  });

  it("a failed fetch goes on from the local remote-tracking ref when there is one, else refuses fetch_failed", async () => {
    const f = fixture();
    const h = await setup(f, { fetchBase: true });
    sh(f.dir, "remote", "set-url", "origin", join(dirname(f.dir), "gone.git"));
    await h.engine.request({ type: "workbench_create", branch: "from-stale", from: "origin/develop" });
    const path = join(h.engine.state.workbenches.managedRoot!, "from-stale");
    const fetch = progressOf(h, path).filter((s) => s.step === "fetch");
    expect(fetch.at(-1)!.exitCode).not.toBe(0);
    expect(fetch.at(-1)!.logTail).toBeTruthy();
    expect(existsSync(path)).toBe(true);
    expect(sh(path, "rev-parse", "HEAD").trim()).not.toBe(f.developTip); // the stale local develop 1
    await expect(h.engine.request({ type: "workbench_create", branch: "from-nowhere", from: "origin/nope" })).rejects.toThrow(/^fetch_failed:/);
    // The branch part of a remote base never becomes a refspec trick.
    await expect(h.engine.request({ type: "workbench_create", branch: "trick", from: "origin/main:refs/heads/victim" })).rejects.toThrow(/^invalid_branch_name:/);
    expect(existsSync(join(h.engine.state.workbenches.managedRoot!, "from-nowhere"))).toBe(false);
    // fetch:false never fetches.
    await h.engine.request({ type: "workbench_create", branch: "no-fetch", from: "origin/develop", fetch: false });
    expect(progressOf(h, join(h.engine.state.workbenches.managedRoot!, "no-fetch")).some((s) => s.step === "fetch")).toBe(false);
  });
});

describe("§36.14 workbench_create fromPr", () => {
  it("fetches refs/pull/<n>/head from the PR's remote and creates the branch from it (no upstream); a local branch is checked out as it is", async () => {
    const f = fixture();
    const h = await setup(f, { useWorktreeInclude: false });
    await h.engine.request({ type: "workbench_create", branch: "pr-12", fromPr: { number: 12, headRef: "pr-work" } });
    const path = join(h.engine.state.workbenches.managedRoot!, "pr-12");
    expect(progressOf(h, path).map((s) => s.step)).toEqual(["fetch", "fetch", "create", "done"]);
    expect(sh(path, "rev-parse", "HEAD").trim()).toBe(f.prHead);
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("pr-12");
    expect(() => sh(path, "rev-parse", "--abbrev-ref", "@{u}")).toThrow();
    expect(readFileSync(join(path, "pr.txt"), "utf8")).toBe("from the PR\n");

    // A local branch of that name: checked out as it is, nothing fetched.
    sh(f.dir, "branch", "feature/local", "main");
    const tip = sh(f.dir, "rev-parse", "feature/local").trim();
    await h.engine.request({ type: "workbench_create", branch: "feature/local", fromPr: { number: 13, headRef: "feature/local" } });
    const local = join(h.engine.state.workbenches.managedRoot!, "feature-local");
    expect(progressOf(h, local).some((s) => s.step === "fetch")).toBe(false);
    expect(sh(local, "rev-parse", "HEAD").trim()).toBe(tip);
    // Another worktree has it → branch_in_use (the client offers that workbench).
    await expect(h.engine.request({ type: "workbench_create", branch: "feature/local", fromPr: { number: 13, headRef: "feature/local" } })).rejects.toThrow(/branch_in_use:/);
    // No such PR head → fetch_failed.
    await expect(h.engine.request({ type: "workbench_create", branch: "pr-99", fromPr: { number: 99, headRef: "x" } })).rejects.toThrow(/^fetch_failed:/);
  });
});
