import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TASK_TEXT } from "../src/protocol.js";
import { TASK_HANDOFF_FILE, TASK_HANDOFF_MAX_AGE_MS, takeTaskHandoff } from "../src/review/taskHandoff.js";
import { FakeClaudeSession, makeHarness, type Harness } from "./helpers/engine.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/** docs/PROTOCOL.md §49: a task started in a workbench of its own (`workbench_create {task}`). */

function makeRepo(): string {
  const dir = realpathSync(makeTempDir("rg-w49task"));
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  write(dir, "README.md", "line1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const dirs: string[] = [];
const harnesses: Harness[] = [];
const track = (d: string) => (dirs.push(d), d);
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.engine.dispose();
  for (const d of dirs.splice(0)) removeDir(d);
});

const TASK = "Do the task at https://tasks.example.com/project/42 — read it first, then fix the cart total.";

/** A project open in `h`, its managed worktrees under a scratch folder of their own. */
async function opened(): Promise<{ h: Harness; repo: string; managed: string }> {
  const repo = track(makeRepo());
  const managed = track(realpathSync(makeTempDir("rg-w49managed")));
  const h = harness();
  await h.hello({ worktreeRoot: managed });
  await h.open(repo);
  return { h, repo, managed };
}

const gitDirOf = (wt: string) => sh(wt, "rev-parse", "--absolute-git-dir").trim();

describe("§49 workbench_create {task}", () => {
  it("the task goes to the new workbench once — its window sends it in a fresh chat, in the task's mode; this chat sends nothing", async () => {
    const { h, repo } = await opened();
    await h.engine.request({ type: "workbench_create", branch: "task/42", task: { text: TASK, mode: "acceptEdits" } });
    const wt = h.engine.state.workbenches.list.find((w) => w.branch === "task/42")!.path;
    expect(h.session().sends).toHaveLength(0);
    expect(existsSync(join(gitDirOf(wt), "reviewgate", TASK_HANDOFF_FILE))).toBe(true);

    const t = harness();
    await t.hello();
    await t.open(wt);
    await t.waitFor(() => t.session().sends.length === 1, "the task's first message");
    expect(t.session().sends[0]!.text).toBe(TASK);
    expect(t.engine.state.session.permissionMode).toBe("acceptEdits");
    expect(t.session().opts.settings.permissionMode).toBe("acceptEdits");
    expect(t.ofType("task_started").at(-1)).toEqual({ type: "task_started", text: TASK, mode: "acceptEdits", from: repo, sent: true });
    expect(existsSync(join(gitDirOf(wt), "reviewgate", TASK_HANDOFF_FILE))).toBe(false);

    // Taken once: the window opened again starts as usual.
    await t.engine.dispose();
    const again = harness();
    await again.hello();
    await again.open(wt);
    expect(again.ofType("task_started")).toHaveLength(0);
  });

  it("without a mode the fresh chat starts in the worktree's default", async () => {
    const { h } = await opened();
    await h.engine.request({ type: "workbench_create", branch: "task/plain", task: { text: "Fix the typo in README" } });
    const wt = h.engine.state.workbenches.list.find((w) => w.branch === "task/plain")!.path;
    const t = harness();
    await t.hello();
    await t.open(wt);
    await t.waitFor(() => t.session().sends.length === 1, "the task's first message");
    expect(t.ofType("task_started").at(-1)).toMatchObject({ mode: "default", sent: true });
  });

  it("a session that cannot take a message yet hands the text back for the composer (sent: false)", async () => {
    const { h, repo } = await opened();
    await h.engine.request({ type: "workbench_create", branch: "task/slow", task: { text: TASK, mode: "plan" } });
    const wt = h.engine.state.workbenches.list.find((w) => w.branch === "task/slow")!.path;
    const started: FakeClaudeSession[] = [];
    const t = harness({
      sessionFactory: (o) => {   // a CLI that cannot start: the session never opens
        const s = new FakeClaudeSession(o);
        s.failStart = new Error("claude: command not found");
        started.push(s);
        return s;
      },
    });
    await t.hello();
    await t.engine.request({ type: "open_project", path: wt }).catch(() => undefined);
    await t.waitFor(() => t.ofType("task_started").length === 1, "task_started");
    expect(t.ofType("task_started")[0]).toEqual({ type: "task_started", text: TASK, mode: "plan", from: repo, sent: false });
    expect(started.flatMap((s) => s.sends)).toHaveLength(0);
  });

  it("a bad task or mode is refused before anything is created", async () => {
    const { h, managed } = await opened();
    const before = readdirSync(managed, { recursive: true }).length;
    await expect(h.engine.request({ type: "workbench_create", branch: "task/empty", task: { text: "   " } })).rejects.toThrow("invalid_task");
    await expect(h.engine.request({ type: "workbench_create", branch: "task/long", task: { text: "x".repeat(MAX_TASK_TEXT + 1) } })).rejects.toThrow("invalid_task");
    await expect(h.engine.request({ type: "workbench_create", branch: "task/mode", task: { text: TASK, mode: "bypassPermissions" as never } })).rejects.toThrow("invalid_mode");
    expect(h.engine.state.workbenches.list.map((w) => w.branch)).toEqual(["main"]);
    expect(readdirSync(managed, { recursive: true }).length).toBe(before);
  });
});

describe("§49 takeTaskHandoff", () => {
  function gitDir(): string {
    const dir = track(realpathSync(makeTempDir("rg-w49gitdir")));
    mkdirSync(join(dir, "reviewgate"), { recursive: true });
    return dir;
  }
  const put = (dir: string, v: unknown) => writeFileSync(join(dir, "reviewgate", TASK_HANDOFF_FILE), typeof v === "string" ? v : JSON.stringify(v));
  const at = new Date(1_800_000_000_000).toISOString();
  const now = 1_800_000_000_000 + 1000;

  it("reads and removes a handoff; the name defaults to the folder's", () => {
    const dir = gitDir();
    put(dir, { version: 1, from: { path: "/work/acme" }, text: TASK, mode: "auto", at });
    expect(takeTaskHandoff(dir, now)).toEqual({ version: 1, from: { path: "/work/acme", name: "acme" }, text: TASK, mode: "auto", at });
    expect(existsSync(join(dir, "reviewgate", TASK_HANDOFF_FILE))).toBe(false);
    expect(takeTaskHandoff(dir, now)).toBeNull();
  });

  it("drops a malformed, stale, empty or wrong-mode handoff (and removes it)", () => {
    const cases: unknown[] = [
      "{not json",
      { version: 2, from: { path: "/a" }, text: TASK, at },
      { version: 1, from: { path: "/a" }, text: "  ", at },
      { version: 1, from: { path: "/a" }, text: TASK, mode: "yolo", at },
      { version: 1, from: { path: "/a" }, text: TASK, at: new Date(now - TASK_HANDOFF_MAX_AGE_MS - 1).toISOString() },
      { version: 1, from: { path: "/a" }, text: TASK, at: new Date(now + TASK_HANDOFF_MAX_AGE_MS + 1).toISOString() },
    ];
    for (const v of cases) {
      const dir = gitDir();
      put(dir, v);
      expect(takeTaskHandoff(dir, now)).toBeNull();
      expect(existsSync(join(dir, "reviewgate", TASK_HANDOFF_FILE))).toBe(false);
    }
  });
});
