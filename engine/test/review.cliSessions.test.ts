import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registryHasSession, resumableCliSessions, runningCliSessions, type ListedSession } from "../src/review/cliSessions.js";
import { makeTempDir, removeDir, sh, write } from "./helpers/repo.js";

/**
 * docs/PROTOCOL.md §36.9 (audit market-03): the user's other Claude sessions of this repository — the running ones from the
 * CLI's registry (`<config>/sessions/<pid>.json` only, never the `*.key` files) and the resumable ones (SDK `listSessions`).
 */

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(makeTempDir(prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

function repoWithWorktree(): { main: string; wt: string; other: string } {
  const main = tmp("rg-cli-main");
  sh(main, "init", "-q", "-b", "main");
  sh(main, "config", "user.email", "t@e.com");
  sh(main, "config", "user.name", "T");
  write(main, "README.md", "r\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-qm", "init");
  const wt = `${main}-wt`;
  dirs.push(wt);
  sh(main, "worktree", "add", "-q", wt, "-b", "feature");
  const other = tmp("rg-cli-otherrepo");
  sh(other, "init", "-q");
  return { main, wt, other };
}

function registry(config: string, entries: Record<string, unknown>[]): void {
  mkdirSync(join(config, "sessions"), { recursive: true });
  for (const e of entries) writeFileSync(join(config, "sessions", `${String(e.pid)}.json`), JSON.stringify(e));
  // A token file next to them: never opened (its content would not even parse).
  writeFileSync(join(config, "sessions", "4242.abcdef.key"), "secret-token");
}

describe("running sessions (§36.9)", () => {
  it("live registry entries in this repository or one of its worktrees; the engine's own CLIs, dead pids, other repositories and reused pids are left out", async () => {
    const { main, wt, other } = repoWithWorktree();
    const config = tmp("rg-cli-config");
    registry(config, [
      { pid: 101, sessionId: "s-main", cwd: main, name: "acme-b4", status: "waiting", entrypoint: "cli", procStart: "Fri Oct 23 01:00:00 2026" },
      { pid: 102, sessionId: "s-wt", cwd: join(wt, "src"), name: "feature work", status: "busy", entrypoint: "cli" },
      { pid: 103, sessionId: "s-other", cwd: other, name: "x", status: "idle", entrypoint: "cli" },
      { pid: 104, sessionId: "s-dead", cwd: main, status: "idle", entrypoint: "cli" },
      { pid: 105, sessionId: "s-mine", cwd: main, status: "busy", entrypoint: "sdk-ts" }, // the engine's main CLI
      { pid: 106, sessionId: "s-side", cwd: main, status: "busy", entrypoint: "sdk-ts" }, // a side question (the engine's child)
      { pid: 107, sessionId: "s-reused", cwd: main, status: "idle", entrypoint: "cli", procStart: "Thu Oct 22 09:00:00 2026" },
      { pid: 108, sessionId: null, cwd: wt, status: "thinking", entrypoint: "claude-vscode" },
    ]);
    const alive = new Set([101, 102, 103, 105, 106, 107, 108]);
    const running = await runningCliSessions({
      configDir: config,
      worktreeRoots: [main, wt],
      currentRoot: main,
      selfPid: 9000,
      excludePids: new Set([105]),
      isAlive: (pid) => alive.has(pid),
      processInfo: async () => new Map([
        [101, { ppid: 1, lstart: "Fri Oct 23 01:00:00 2026" }],
        [106, { ppid: 9000, lstart: "x" }],
        [107, { ppid: 1, lstart: "Fri Oct 23 08:00:00 2026" }],
      ]),
    });
    expect(running).toEqual([
      { pid: 101, sessionId: "s-main", name: "acme-b4", cwd: main, status: "waiting", entrypoint: "cli", sameWorktree: true },
      { pid: 102, sessionId: "s-wt", name: "feature work", cwd: join(wt, "src"), status: "busy", entrypoint: "cli", sameWorktree: false },
      { pid: 108, sessionId: null, name: null, cwd: wt, status: "unknown", entrypoint: "claude-vscode", sameWorktree: false },
    ]);
    expect(await registryHasSession({ configDir: config, sessionId: "s-wt", isAlive: (pid) => alive.has(pid) })).toBe(true);
    expect(await registryHasSession({ configDir: config, sessionId: "s-dead", isAlive: (pid) => alive.has(pid) })).toBe(false);
    expect(await runningCliSessions({ configDir: join(config, "missing"), worktreeRoots: [main], currentRoot: main, selfPid: 1 })).toEqual([]);
  });
});

describe("resumable sessions (§36.9)", () => {
  it("newest first, at most 50, without the running ones and the chats the app has; the title is the custom title, else the summary", async () => {
    const calls: unknown[] = [];
    const listed: ListedSession[] = Array.from({ length: 60 }, (_, i) => ({ sessionId: `s${i}`, summary: `summary ${i}`, lastModified: 1_800_000_000_000 - i * 1000, cwd: "/repo" }));
    listed[0] = { ...listed[0]!, customTitle: "장바구니 합계 수정" };
    listed[3] = { sessionId: "s3", summary: "", firstPrompt: "long first prompt ".repeat(20), lastModified: listed[3]!.lastModified };
    const out = await resumableCliSessions({
      mainRoot: "/repo",
      exclude: new Set(["s1", "s2"]),
      list: async (o) => {
        calls.push(o);
        return listed;
      },
    });
    expect(calls).toEqual([{ dir: "/repo", includeWorktrees: true, includeProgrammatic: false, limit: 200 }]);
    expect(out).toHaveLength(50);
    expect(out[0]).toEqual({ sessionId: "s0", title: "장바구니 합계 수정", updatedAt: new Date(1_800_000_000_000).toISOString(), cwd: "/repo" });
    expect(out.map((s) => s.sessionId).slice(0, 3)).toEqual(["s0", "s3", "s4"]);
    expect(out[1]!.title.length).toBeLessThanOrEqual(120);
    expect(out[1]!.title.endsWith("…")).toBe(true);
    expect(out[1]!.cwd).toBeNull();
    // A listing that fails is an empty list (the running ones still show).
    expect(await resumableCliSessions({ mainRoot: "/repo", exclude: new Set(), list: async () => Promise.reject(new Error("EACCES")) })).toEqual([]);
  });
});
