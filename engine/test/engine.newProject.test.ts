import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freeProjectPath, matchProjects, projectSlug, resolveProjectParent, taskRepo } from "../src/git/newProject.js";
import { makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh } from "./helpers/repo.js";

/** docs/PROTOCOL.md §69: `project_name`, `project_create` and `project_match` — starting without a folder. */

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string) => (dirs.push(d), d);
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* gone */
    }
    removeDir(d);
  }
});

function clone(parent: string, name: string, remotes: Record<string, string>): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q");
  for (const [r, url] of Object.entries(remotes)) sh(dir, "remote", "add", r, url);
  return dir;
}

describe("§69 projectSlug", () => {
  it("the first words, lower-cased, joined by -; Korean stays; new-project when nothing is left", () => {
    expect(projectSlug("Make a login page for the Admin app, please")).toBe("make-a-login-page-for");
    expect(projectSlug("로그인 페이지 만들어줘")).toBe("로그인-페이지-만들어줘");
    expect(projectSlug("  Todo   App!! ")).toBe("todo-app");
    expect(projectSlug("...!!! ")).toBe("new-project");
    expect(projectSlug("")).toBe("new-project");
    expect(projectSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(projectSlug("CON")).toBe("con-project");
    expect(projectSlug("supercalifragilisticexpialidocious-and-more words")).toBe("supercalifragilisticexpialidocious-and");
    expect(projectSlug("x".repeat(60))).toBe("x".repeat(40));
  });

  it("is idempotent, so a typed name goes through the same rule", () => {
    for (const t of ["Make a login page", "로그인 페이지 만들어줘", "todo-app", "new-project"]) expect(projectSlug(projectSlug(t))).toBe(projectSlug(t));
  });

  it("the parent: given, ~ expanded, else <home>/ReviewGate; relative is refused", () => {
    expect(resolveProjectParent(undefined, "/Users/dev")).toBe(join("/Users/dev", "ReviewGate"));
    expect(resolveProjectParent("  ", "/Users/dev")).toBe(join("/Users/dev", "ReviewGate"));
    expect(resolveProjectParent("~/code", "/Users/dev")).toBe(join("/Users/dev", "code"));
    expect(resolveProjectParent("/work/acme", "/Users/dev")).toBe("/work/acme");
    expect(resolveProjectParent("code", "/Users/dev")).toBeNull();
  });

  it("a taken name gets -2, -3", () => {
    const parent = track(realpathSync(makeTempDir("rg-newproj-free")));
    expect(freeProjectPath(parent, "app")).toBe(join(parent, "app"));
    mkdirSync(join(parent, "app"));
    mkdirSync(join(parent, "app-2"));
    expect(freeProjectPath(parent, "app")).toBe(join(parent, "app-3"));
  });
});

describe("§69 project_name / project_create", () => {
  it("names, makes the folder (a collision takes -2), git-inits it and opens it", async () => {
    const parent = track(realpathSync(makeTempDir("rg-newproj")));
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    const where = join(parent, "nested", "ReviewGate");
    expect(await h.engine.request({ type: "project_name", text: "Build a todo app", parent: where })).toMatchObject({
      type: "project_name",
      name: "build-a-todo-app",
      parent: where,
      path: join(where, "build-a-todo-app"),
    });
    mkdirSync(join(where, "build-a-todo-app"), { recursive: true });
    const reply = await h.engine.request({ type: "project_create", name: "build-a-todo-app", parent: where });
    expect(reply).toEqual(expect.objectContaining({ type: "project_created", path: join(where, "build-a-todo-app-2") }));
    expect(existsSync(join(where, "build-a-todo-app-2", ".git"))).toBe(true);
    const st = await h.waitFor((s) => s.project !== null, "project open");
    expect(realpathSync(st.project!.root)).toBe(realpathSync(join(where, "build-a-todo-app-2")));
    expect(st.gitInit).toBeNull();
  });

  it("refusals: bad_parent, parent_not_writable", async () => {
    const parent = track(realpathSync(makeTempDir("rg-newproj-ro")));
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();
    await expect(h.engine.request({ type: "project_name", text: "x", parent: "relative/dir" })).rejects.toThrow("bad_parent");
    const file = join(parent, "a-file");
    writeFileSync(file, "x");
    await expect(h.engine.request({ type: "project_create", name: "app", parent: file })).rejects.toThrow("parent_not_writable");
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(parent, 0o555);
      await expect(h.engine.request({ type: "project_create", name: "app", parent })).rejects.toThrow("parent_not_writable");
    }
    expect(h.engine.state.project).toBeNull();
  });
});

describe("§69 project_match", () => {
  it("the task's repository: an issue link, owner/repo#n, a link in a sentence; none for a key", () => {
    expect(taskRepo("https://github.com/acme/widgets/issues/42")).toEqual({ host: "github.com", owner: "acme", repo: "widgets" });
    expect(taskRepo("acme/widgets#7")).toEqual({ host: null, owner: "acme", repo: "widgets" });
    expect(taskRepo("fix this https://ghe.example.com/team/app/issues/9 today")).toEqual({ host: "ghe.example.com", owner: "team", repo: "app" });
    expect(taskRepo("ACME-123")).toBeNull();
    expect(taskRepo("42")).toBeNull();
  });

  it("matches folders whose remote is the repository (any remote, any case), the link's host first; guesses a fork or a same-named folder", async () => {
    const root = track(realpathSync(makeTempDir("rg-newproj-match")));
    const other = clone(root, "other", { origin: "git@github.com:acme/other.git" });
    const fork = clone(root, "my-fork", { origin: "git@github.com:dev/widgets.git" });
    const ghe = clone(root, "ghe-copy", { origin: "https://ghe.example.com/acme/widgets.git" });
    const up = clone(root, "upstream-clone", { origin: "git@github.com:dev/w.git", upstream: "https://github.com/ACME/Widgets" });
    const plain = join(root, "plain");
    mkdirSync(plain);
    const missing = join(root, "gone");
    const h = makeHarness();
    harnesses.push(h);
    await h.hello();

    const all = [other, ghe, plain, missing, up, fork];
    expect(await h.engine.request({ type: "project_match", ref: "https://github.com/acme/widgets/issues/42", paths: all })).toMatchObject({
      type: "project_matches",
      repo: "acme/widgets",
      matches: [up, ghe],
      guess: up,
    });
    expect(await matchProjects("https://github.com/acme/widgets/issues/42", [other, fork, plain])).toEqual({ repo: "acme/widgets", matches: [], guess: fork });
    const named = clone(root, "widgets", {});
    expect(await matchProjects("acme/widgets#1", [other, named])).toEqual({ repo: "acme/widgets", matches: [], guess: named });
    expect(await matchProjects("ACME-123", all)).toEqual({ repo: null, matches: [], guess: null });
    expect(await matchProjects("acme/widgets#1", ["relative", other])).toEqual({ repo: "acme/widgets", matches: [], guess: null });
  });
});
